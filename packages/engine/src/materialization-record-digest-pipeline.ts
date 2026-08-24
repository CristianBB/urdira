import type { MaterializationAcceptedFactDelta } from "./fact-delta.js";
import { MaterializationDigestOffload } from "./materialization-digest-offload.js";

const DEFAULT_BATCH_RECORDS = 2_000;

export interface RecordDigestService {
  digestRecords(canonicalRecords: readonly string[]): Promise<readonly string[]>;
  close(): void;
}

export interface PipelinedRecordDigests {
  readonly delta: MaterializationAcceptedFactDelta;
  readonly digests: readonly string[];
}

interface PendingDelta {
  readonly delta: MaterializationAcceptedFactDelta;
  readonly canonicalRecords: readonly string[];
}

/**
 * Overlaps compact-record hashing with plugin analysis without making worker
 * availability part of candidate correctness. Successful batches are returned
 * to the accumulator; skipped or failed batches remain on its synchronous path.
 */
export class MaterializationRecordDigestPipeline {
  readonly #service: RecordDigestService;
  readonly #batchRecordLimit: number;
  readonly #completed: PipelinedRecordDigests[] = [];
  readonly #inflight: Promise<void>[] = [];
  #pending: PendingDelta[] = [];
  #pendingRecordCount = 0;
  #failed = false;

  static create(): MaterializationRecordDigestPipeline | undefined {
    const service = MaterializationDigestOffload.create({ workers: 1, max_old_generation_size_mb: 128 });
    return service === undefined ? undefined : new MaterializationRecordDigestPipeline(service);
  }

  constructor(service: RecordDigestService, batchRecordLimit = DEFAULT_BATCH_RECORDS) {
    if (!Number.isSafeInteger(batchRecordLimit) || batchRecordLimit < 1) throw new RangeError("batchRecordLimit must be a positive safe integer");
    this.#service = service;
    this.#batchRecordLimit = batchRecordLimit;
  }

  get completedFactDeltaIds(): ReadonlySet<string> {
    return new Set(this.#completed.map((entry) => entry.delta.delta.fact_delta_id));
  }

  accept(delta: MaterializationAcceptedFactDelta): void {
    if (this.#failed) return;
    const canonicalRecords: string[] = [];
    for (const replacementSet of delta.replacement_sets) {
      for (const record of replacementSet.records) {
        if (!("canonical_record" in (record as object))) return;
        canonicalRecords.push((record as { readonly canonical_record: string }).canonical_record);
      }
    }
    this.#pending.push({ delta, canonicalRecords });
    this.#pendingRecordCount += canonicalRecords.length;
    if (this.#pendingRecordCount >= this.#batchRecordLimit) this.#flush();
  }

  async drain(): Promise<readonly PipelinedRecordDigests[]> {
    this.#flush();
    await Promise.all(this.#inflight);
    return this.#completed;
  }

  close(): void {
    this.#service.close();
  }

  #flush(): void {
    if (this.#pending.length === 0) return;
    const batch = this.#pending;
    this.#pending = [];
    this.#pendingRecordCount = 0;
    const request = batch.flatMap((entry) => entry.canonicalRecords);
    this.#inflight.push(this.#service.digestRecords(request).then((digests) => {
      let offset = 0;
      for (const entry of batch) {
        const nextOffset = offset + entry.canonicalRecords.length;
        this.#completed.push({ delta: entry.delta, digests: digests.slice(offset, nextOffset) });
        offset = nextOffset;
      }
    }).catch(() => { this.#failed = true; }));
  }
}
