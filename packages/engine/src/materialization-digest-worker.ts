// Off-thread half of `seal_ordered_digests`: computes a template set's
// ordered-set content digest -- byte-identical to `digestCanonicalArray` /
// `digestMappedCanonicalArray` (`@urdira/canonical`), i.e. sha256 over
// `encodeArrayHeader(count)` followed by each element's own
// `encodeCanonicalInto` bytes -- inside a `node:worker_threads` worker, fed
// incrementally in batches so neither heap ever holds a second full copy of
// the corpus. The parent (`materialization-digest-offload.ts`) streams each
// set's elements and seeds the returned digest into the frozen-array memo
// (`seedFrozenCanonicalArrayDigest`) against the ORIGINAL main-heap array,
// which is what publication's `verifyTemplateSetAgainstDescriptor` consults.
//
// Mapping "template" reproduces `digestTemplateArray`: each element goes
// through `packedTemplateValueForDigest` first (packed identity tuples
// unpack with a recompute of their three small digests -- the main-heap
// triple memo is unreachable here, and that fallback is the documented
// resumed-candidate path, never a byte difference).
//
// This file is a worker ENTRY POINT (loaded via `new Worker(new URL(...))`
// against compiled `dist/materialization-digest-worker.js`) -- never
// imported by other modules.
import { createHash, type Hash } from "node:crypto";
import { parentPort } from "node:worker_threads";
import { canonicalBytes, digestBytes, encodeArrayHeader, encodeCanonicalInto } from "@urdira/canonical";
import { packedTemplateValueForDigest } from "./candidate-materialization.js";

interface BeginSetMessage { readonly kind: "begin_set"; readonly set_id: string; readonly mapping: "canonical" | "template"; readonly entry_count: number }
interface ElementsMessage { readonly kind: "elements"; readonly set_id: string; readonly elements: readonly unknown[] }
interface FinishSetMessage { readonly kind: "finish_set"; readonly set_id: string }
interface RecordDigestsMessage { readonly kind: "record_digests"; readonly batch_id: string; readonly canonical_records: readonly string[] }
interface EndMessage { readonly kind: "end" }

interface AckMessage { readonly kind: "ack"; readonly set_id: string }
interface SetResultMessage { readonly kind: "set_result"; readonly set_id: string; readonly content_digest: string }
interface RecordDigestsResultMessage { readonly kind: "record_digests_result"; readonly batch_id: string; readonly digests: readonly string[] }
interface WorkerErrorMessage { readonly kind: "error"; readonly error: { readonly name: string; readonly message: string } }

const port = parentPort;
if (!port) throw new Error("The materialization digest worker entry must be run inside a node:worker_threads worker.");

const openSets = new Map<string, { readonly hash: Hash; readonly mapping: "canonical" | "template"; declared: number; seen: number }>();

port.on("message", (message: BeginSetMessage | ElementsMessage | FinishSetMessage | RecordDigestsMessage | EndMessage) => {
  try {
    if (message.kind === "record_digests") {
      // (3a) Per-record content digests, the exact `recordDigest` formula
      // for a compacted record (`candidate-materialization.ts`):
      // digestBytes(canonicalBytes(JSON.parse(canonical_record))). Order is
      // the contract -- digests[i] belongs to canonical_records[i].
      const digests = message.canonical_records.map((canonicalRecord) => digestBytes(canonicalBytes(JSON.parse(canonicalRecord))));
      port.postMessage({ kind: "record_digests_result", batch_id: message.batch_id, digests } satisfies RecordDigestsResultMessage);
      return;
    }
    if (message.kind === "begin_set") {
      const hash = createHash("sha256");
      hash.update(encodeArrayHeader(message.entry_count));
      openSets.set(message.set_id, { hash, mapping: message.mapping, declared: message.entry_count, seen: 0 });
      return;
    }
    if (message.kind === "elements") {
      const set = openSets.get(message.set_id);
      if (set === undefined) throw new Error(`elements for unknown set ${message.set_id}`);
      const sink = (chunk: Uint8Array): void => { set.hash.update(chunk); };
      for (const element of message.elements) encodeCanonicalInto(set.mapping === "template" ? packedTemplateValueForDigest(element) : element, sink);
      set.seen += message.elements.length;
      // Per-batch ack = the parent's flow control: it keeps only a small
      // window of serialized batches in the channel, so no second full copy
      // of the corpus ever accumulates in either heap.
      port.postMessage({ kind: "ack", set_id: message.set_id } satisfies AckMessage);
      return;
    }
    if (message.kind === "finish_set") {
      const set = openSets.get(message.set_id);
      if (set === undefined) throw new Error(`finish for unknown set ${message.set_id}`);
      openSets.delete(message.set_id);
      // The array header already committed `declared` to the hash; a count
      // mismatch would silently produce a digest of a DIFFERENT logical
      // array, so it must be an error, never a wrong-but-returned digest.
      if (set.seen !== set.declared) throw new Error(`set ${message.set_id} received ${set.seen} elements but declared ${set.declared}`);
      port.postMessage({ kind: "set_result", set_id: message.set_id, content_digest: `sha256:${set.hash.digest("hex")}` } satisfies SetResultMessage);
      return;
    }
    port.close();
  } catch (error) {
    port.postMessage({ kind: "error", error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } } satisfies WorkerErrorMessage);
  }
});
