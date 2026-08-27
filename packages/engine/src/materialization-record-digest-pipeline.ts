import type { MaterializationAcceptedFactDelta } from "./fact-delta.js";
import { MaterializationDigestOffload } from "./materialization-digest-offload.js";

const DEFAULT_BATCH_RECORDS = 2_000;
// A single digest worker processes requests serially. Keeping two requests
// live preserves overlap with plugin analysis while preventing the parent
// thread's message queue from retaining an unbounded number of structured
// clones of canonical records.
const DEFAULT_MAX_IN_FLIGHT_BATCHES = 2;
const MAX_IN_FLIGHT_BATCHES_ENV = "URDIRA_RECORD_DIGEST_MAX_IN_FLIGHT_BATCHES";

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
  readonly #maxInFlightBatches: number;
  readonly #completed: PipelinedRecordDigests[] = [];
  readonly #inflight: Promise<void>[] = [];
  #pending: PendingDelta[] = [];
  #pendingRecordCount = 0;
  #failed = false;
  // The production provider can have multiple analysis lanes. Serialize
  // accepts so concurrent callbacks cannot enqueue past the memory bound.
  #acceptTail: Promise<void> = Promise.resolve();

  static create(): MaterializationRecordDigestPipeline | undefined {
    const service = MaterializationDigestOffload.create({ workers: 1, max_old_generation_size_mb: 128 });
    return service === undefined ? undefined : new MaterializationRecordDigestPipeline(service, DEFAULT_BATCH_RECORDS, configuredMaxInFlightBatches());
  }

  constructor(service: RecordDigestService, batchRecordLimit = DEFAULT_BATCH_RECORDS, maxInFlightBatches = DEFAULT_MAX_IN_FLIGHT_BATCHES) {
    if (!Number.isSafeInteger(batchRecordLimit) || batchRecordLimit < 1) throw new RangeError("batchRecordLimit must be a positive safe integer");
    if (!Number.isSafeInteger(maxInFlightBatches) || maxInFlightBatches < 1) throw new RangeError("maxInFlightBatches must be a positive safe integer");
    this.#service = service;
    this.#batchRecordLimit = batchRecordLimit;
    this.#maxInFlightBatches = maxInFlightBatches;
  }

  get completedFactDeltaIds(): ReadonlySet<string> {
    return new Set(this.#completed.map((entry) => entry.delta.delta.fact_delta_id));
  }

  accept(delta: MaterializationAcceptedFactDelta): Promise<void> {
    const operation = this.#acceptTail.then(() => this.#acceptOne(delta));
    // Keep the serialization chain alive after a failed optimization step;
    // the caller still observes the rejection and can fall back to sync work.
    this.#acceptTail = operation.catch(() => undefined);
    return operation;
  }

  async #acceptOne(delta: MaterializationAcceptedFactDelta): Promise<void> {
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
    if (this.#pendingRecordCount >= this.#batchRecordLimit) {
      // Wait BEFORE posting the next request. Posting first and trimming the
      // promise list afterward would still leave an extra structured clone in
      // the worker's message queue, which is exactly the memory spike this
      // pipeline is meant to prevent.
      await this.#waitForCapacity();
      this.#flush();
    }
  }

  async drain(): Promise<readonly PipelinedRecordDigests[]> {
    await this.#acceptTail;
    if (this.#pending.length > 0) {
      await this.#waitForCapacity();
      this.#flush();
    }
    await Promise.all(this.#inflight);
    return this.#completed;
  }

  close(): void {
    this.#service.close();
  }

  async #waitForCapacity(): Promise<void> {
    while (this.#inflight.length >= this.#maxInFlightBatches) {
      const oldest = this.#inflight.shift();
      if (oldest !== undefined) await oldest;
    }
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

function configuredMaxInFlightBatches(): number {
  const raw = process.env[MAX_IN_FLIGHT_BATCHES_ENV];
  if (raw === undefined) return DEFAULT_MAX_IN_FLIGHT_BATCHES;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : DEFAULT_MAX_IN_FLIGHT_BATCHES;
}
