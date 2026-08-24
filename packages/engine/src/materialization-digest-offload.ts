// Parent-side host for `materialization-digest-worker.ts`: hands each big
// template set to its own worker thread (two sets dominate a from-zero
// seal's `seal_ordered_digests` -- record opens and identity assignments --
// so two workers digest them in parallel while the main thread computes the
// rest of the seal), streaming elements in bounded acked batches so neither
// heap ever holds a serialized second copy of the corpus. The returned
// digest is byte-identical to the in-process `digestCanonicalArray` /
// `digestTemplateArray` result (same encode code, same package, run in the
// worker); the CALLER is responsible for seeding it into the frozen-array
// memo (`seedFrozenCanonicalArrayDigest`) against the original array.
//
// Never throws out of `create()`; a failed spawn returns undefined and the
// caller keeps the synchronous seal path. `digestSet` DOES reject on worker
// trouble -- `sealAsync` catches that and falls back to the sync digests,
// so worker infrastructure can never change a seal's result, only its cost.
// Kill switch: URDIRA_SEAL_DIGEST_WORKERS=0.
import { Worker } from "node:worker_threads";
import type { DigestText } from "@urdira/canonical";

const DIGEST_OFFLOAD_WORKERS = 2;
const DIGEST_OFFLOAD_BATCH_ELEMENTS = 4096;
const DIGEST_OFFLOAD_WINDOW_BATCHES = 4;

interface WorkerSlot {
  readonly worker: Worker;
  inflightBatches: number;
  waiters: (() => void)[];
  failure: string | undefined;
  readonly pendingSets: Map<string, { readonly resolve: (digest: DigestText) => void; readonly reject: (error: Error) => void }>;
}

export class MaterializationDigestOffload {
  readonly #slots: WorkerSlot[] = [];
  #nextSlot = 0;
  #nextSetId = 0;

  static create(): MaterializationDigestOffload | undefined {
    if (process.env["URDIRA_SEAL_DIGEST_WORKERS"] === "0") return undefined;
    try {
      const offload = new MaterializationDigestOffload();
      const workerEntry = new URL("materialization-digest-worker.js", import.meta.resolve("@urdira/engine"));
      for (let index = 0; index < DIGEST_OFFLOAD_WORKERS; index += 1) {
        const worker = new Worker(workerEntry);
        const slot: WorkerSlot = { worker, inflightBatches: 0, waiters: [], failure: undefined, pendingSets: new Map() };
        const failSlot = (message: string): void => {
          slot.failure = slot.failure ?? message;
          slot.inflightBatches = 0;
          for (const waiter of slot.waiters.splice(0)) waiter();
          for (const [setId, pending] of [...slot.pendingSets]) { slot.pendingSets.delete(setId); pending.reject(new Error(message)); }
        };
        worker.on("message", (message: { readonly kind: string; readonly set_id?: string; readonly content_digest?: string; readonly error?: { readonly message: string } }) => {
          if (message.kind === "ack") {
            slot.inflightBatches = Math.max(0, slot.inflightBatches - 1);
            const waiter = slot.waiters.shift();
            waiter?.();
          } else if (message.kind === "set_result" && message.set_id !== undefined && message.content_digest !== undefined) {
            const pending = slot.pendingSets.get(message.set_id);
            slot.pendingSets.delete(message.set_id);
            pending?.resolve(message.content_digest as DigestText);
          } else {
            failSlot(message.error?.message ?? "materialization digest worker returned an unrecognized message");
          }
        });
        worker.on("error", (error) => failSlot(error instanceof Error ? error.message : String(error)));
        worker.on("exit", () => failSlot("materialization digest worker exited before its sets finished"));
        offload.#slots.push(slot);
      }
      return offload;
    } catch {
      return undefined;
    }
  }

  async digestSet(mapping: "canonical" | "template", elements: readonly unknown[]): Promise<DigestText> {
    if (this.#slots.length === 0) throw new Error("materialization digest offload has no workers");
    const slot = this.#slots[this.#nextSlot % this.#slots.length]!;
    this.#nextSlot += 1;
    const setId = `set-${this.#nextSetId}`;
    this.#nextSetId += 1;
    const result = new Promise<DigestText>((resolve, reject) => { slot.pendingSets.set(setId, { resolve, reject }); });
    // Attach a no-op catch immediately: if a batch send below fails first,
    // the rejection must not surface as unhandled before the caller awaits.
    void result.catch(() => undefined);
    const post = (message: unknown): void => {
      if (slot.failure !== undefined) throw new Error(slot.failure);
      slot.worker.postMessage(message);
    };
    try {
      post({ kind: "begin_set", set_id: setId, mapping, entry_count: elements.length });
      for (let offset = 0; offset < elements.length; offset += DIGEST_OFFLOAD_BATCH_ELEMENTS) {
        while (slot.inflightBatches >= DIGEST_OFFLOAD_WINDOW_BATCHES && slot.failure === undefined) {
          await new Promise<void>((resolve) => { slot.waiters.push(resolve); });
        }
        slot.inflightBatches += 1;
        post({ kind: "elements", set_id: setId, elements: elements.slice(offset, offset + DIGEST_OFFLOAD_BATCH_ELEMENTS) });
      }
      post({ kind: "finish_set", set_id: setId });
    } catch (error) {
      slot.pendingSets.delete(setId);
      throw error instanceof Error ? error : new Error(String(error));
    }
    return result;
  }

  close(): void {
    for (const slot of this.#slots) void slot.worker.terminate();
  }
}
