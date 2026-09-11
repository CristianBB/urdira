import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { configureStructuralKernelPort, type PluginWorkerRequestEnvelope, type StructuralKernelPort } from "@urdira/plugin-sdk";
import { createJavascriptTypescriptWorker, type JavascriptTypescriptWorkerDescriptor, type JavascriptTypescriptWorkerTransport } from "./worker.js";
import { JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY } from "./semantic-process-transport.js";

/** JSON-framed semantic bridge owned by the Rust composition worker. The
 * ordinary semantic-process transport remains V8-framed for application/test
 * compatibility; this entrypoint exists so Rust can launch the checker and
 * receive compact canonical batches without routing rows through Node-API. */
const PROTOCOL = "urdira:jsts-rust-semantic.v1" as const;
// Full-workspace closure requests carry only immutable source metadata. The
// n8n corpus exceeds 32 MiB at ~14k owners, while grouped observations remain
// bounded independently below; keep this private transport frame bounded at
// 128 MiB so the complete generation can be prepared without a second route.
const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;
const MAX_GROUP_BYTES = 16 * 1024 * 1024;
const MAX_GROUP_RESPONSE_BYTES = 28 * 1024 * 1024;
const MAX_GROUP_OWNERS = 32;

type Message = { readonly kind: string; readonly request_id: string; readonly [key: string]: unknown };
type PackedBatch = {
  readonly sequence: number;
  readonly final_batch: boolean;
  readonly canonical_records: readonly string[];
  readonly canonical_dependencies: readonly string[];
  readonly byte_length: 0;
  readonly owner_digest: string;
  readonly fact_delta_id: string;
  readonly delta_digest: string;
  readonly diagnostic_codes: readonly string[];
};
type ResultOwner = {
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly owner_path: string;
  readonly diagnostic_proposal_keys: readonly string[];
  readonly batches: readonly PackedBatch[];
  readonly next_cursor?: number;
};

let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
let worker: JavascriptTypescriptWorkerTransport | undefined;
let shuttingDown = false;
let writeChain = Promise.resolve();
let handling = Promise.resolve();

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Rust semantic bridge envelope is invalid.");
  return value as Record<string, unknown>;
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\0\r\n]/u.test(value)) throw new Error("Rust semantic bridge identity is invalid.");
  return value;
}

function encode(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength === 0 || payload.byteLength > MAX_MESSAGE_BYTES) throw new Error("Rust semantic bridge response exceeds its message budget.");
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

function send(value: unknown): Promise<void> {
  const frame = encode(value);
  const operation = writeChain.then(() => new Promise<void>((resolve, reject) => {
    process.stdout.write(frame, (error) => error === undefined || error === null ? resolve() : reject(error));
  }));
  writeChain = operation.catch(() => undefined);
  return operation;
}

function configureAddon(path: unknown): void {
  if (path === undefined || path === null) return;
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Rust semantic bridge addon path is invalid.");
  const loaded = createRequire(import.meta.url)(path) as Partial<StructuralKernelPort> & { readonly nativeApiVersion?: () => number };
  // Must track NATIVE_API_VERSION in packages/native/src/loader.ts (and
  // crates/urdira-native-node/src/lib.rs); this process worker can't import
  // that constant across the child-process boundary, so the literal is
  // duplicated here. The literal is 18 to match the native selector-page and indexed-count API.
  if (typeof loaded.nativeApiVersion !== "function" || loaded.nativeApiVersion() !== 18
    || typeof loaded.structuralKernelBatch !== "function" || typeof loaded.structuralKernelCanonicalBatch !== "function"
    || typeof loaded.structuralObservationBatch !== "function") throw new Error("Rust semantic bridge structural kernel binding is incompatible.");
  configureStructuralKernelPort({
    structuralKernelBatch: (batch) => loaded.structuralKernelBatch!(batch),
    structuralKernelCanonicalBatch: (batch) => loaded.structuralKernelCanonicalBatch!(batch),
    structuralObservationBatch: (request) => loaded.structuralObservationBatch!(request),
  });
}

function requestOf(value: unknown): PluginWorkerRequestEnvelope {
  return objectOf(value) as unknown as PluginWorkerRequestEnvelope;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function semanticGroup(requests: readonly PluginWorkerRequestEnvelope[]): Promise<readonly ResultOwner[]> {
  if (worker === undefined) throw new Error("Rust semantic bridge is not ready.");
  if (requests.length === 0 || requests.length > MAX_GROUP_OWNERS) throw new Error("Rust semantic bridge owner group exceeds 32 owners.");
  const startedAt = performance.now();
  const observations = await worker.invokeRustSemanticObservationGroup(requests);
  if (observations.length !== requests.length) throw new Error("Rust semantic bridge returned an incomplete owner group.");
  const result: ResultOwner[] = [];
  const ownersPrefixBytes = jsonBytes({ owners: [] }) - 2;
  let completedOwnersBytes = 0;
  for (const [index, observation] of observations.entries()) {
    const request = objectOf(requests[index]);
    const payload = objectOf(request["payload"]);
    const ownerPath = nonempty(payload["owner_path"]);
    const cursorValue = payload["rust_semantic_cursor"];
    const cursor = cursorValue === undefined ? 0 : cursorValue;
    if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) throw new Error("Rust semantic bridge cursor is invalid.");
    const owners: PackedBatch[] = [];
    let ownerBatchBytes = 0;
    let nextCursor: number | undefined;
    for (const batch of observation.batches) {
      if (batch.sequence < (cursor as number)) continue;
      const packed: PackedBatch = {
        sequence: batch.sequence,
        final_batch: batch.final_batch,
        canonical_records: batch.canonical_records,
        canonical_dependencies: batch.canonical_dependencies,
        byte_length: 0,
        owner_digest: batch.owner_digest,
        fact_delta_id: batch.fact_delta_id,
        delta_digest: batch.delta_digest,
        diagnostic_codes: batch.diagnostic_codes,
      };
      // Measure each packed batch once. The response itself is serialized
      // only after all owners have been assembled; recomputing JSON bytes for
      // the same batch during the budget check and again for the accumulated
      // owner counter was measurable CPU at corpus scale.
      const packedBytes = Buffer.byteLength(JSON.stringify(packed), "utf8");
      if (packedBytes > MAX_GROUP_BYTES) throw new Error("Rust semantic bridge owner batch exceeds its message budget.");
      // Keep the response-budget calculation incremental. Stringifying the
      // complete accumulated owner array for every batch made the bridge
      // quadratic at corpus scale, despite the bounded 32-owner protocol.
      const projectedOwnerEnvelopeBytes = jsonBytes({
        owner_artifact_id: observation.owner_artifact_id,
        owner_artifact_version_id: observation.owner_artifact_version_id,
        owner_path: ownerPath,
        diagnostic_proposal_keys: observation.diagnostic_proposal_keys,
        batches: [],
        next_cursor: batch.sequence,
      }) - 2;
      const projectedBytes = ownersPrefixBytes
        + completedOwnersBytes
        + (result.length === 0 ? 0 : 1)
        + projectedOwnerEnvelopeBytes
        + 2
        + ownerBatchBytes
        + (owners.length === 0 ? 0 : 1)
        + packedBytes;
      if (projectedBytes > MAX_GROUP_RESPONSE_BYTES && owners.length > 0 && requests.length === 1) {
        // A single owner may exceed the bridge response budget. Return a
        // deterministic batch-sequence cursor so Rust can resume this owner
        // without returning the rows through the application process.
        nextCursor = batch.sequence;
        break;
      }
      owners.push(packed);
      ownerBatchBytes += (owners.length === 1 ? 0 : 1) + packedBytes;
    }
    if (owners.length === 0) throw new Error("Rust semantic bridge returned an empty owner stream page.");
    if (nextCursor === undefined && owners.at(-1)?.final_batch !== true) throw new Error("Rust semantic bridge returned an incomplete owner stream.");
    const ownerEnvelopeBytes = jsonBytes({
      owner_artifact_id: observation.owner_artifact_id,
      owner_artifact_version_id: observation.owner_artifact_version_id,
      owner_path: ownerPath,
      diagnostic_proposal_keys: observation.diagnostic_proposal_keys,
      batches: [],
      ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
    }) - 2;
    result.push({
      owner_artifact_id: observation.owner_artifact_id,
      owner_artifact_version_id: observation.owner_artifact_version_id,
      owner_path: ownerPath,
      diagnostic_proposal_keys: observation.diagnostic_proposal_keys,
      batches: owners,
      ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
    });
    // `ownerEnvelopeBytes` and `ownerBatchBytes` are already the exact JSON
    // contribution for this owner. Avoid serializing the complete owner a
    // second time merely to update the response-budget counter.
    completedOwnersBytes += (result.length === 1 ? 0 : 1) + ownerEnvelopeBytes + 2 + ownerBatchBytes;
    if (nextCursor !== undefined) break;
    if (nextCursor === undefined && ownersPrefixBytes + completedOwnersBytes + 2 > MAX_GROUP_RESPONSE_BYTES) {
      throw new Error("Rust semantic bridge group exceeds its response budget; split the owner group.");
    }
  }
  if (process.env["URDIRA_DEBUG_TIMING"] === "1") {
    process.stderr.write(`[urdira] rust semantic group owners=${requests.length} ms=${Math.round(performance.now() - startedAt)}\n`);
  }
  return result;
}

async function handle(value: unknown): Promise<void> {
  const message = objectOf(value) as Message;
  if (message["protocol_version"] !== PROTOCOL) throw new Error("Rust semantic bridge protocol version is invalid.");
  const requestId = nonempty(message.request_id);
  if (worker === undefined) {
    if (message.kind !== "handshake" || message["build_identity"] !== JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY) throw new Error("Rust semantic bridge handshake is invalid.");
    const descriptor = objectOf(message["worker_descriptor"]) as unknown as JavascriptTypescriptWorkerDescriptor;
    configureAddon(message["structural_kernel_addon_path"]);
    worker = createJavascriptTypescriptWorker(descriptor);
    await send({ protocol_version: PROTOCOL, kind: "handshake_ack", request_id: requestId, build_identity: JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY });
    return;
  }
  switch (message.kind) {
    case "invoke": {
      const result = await worker.invoke(requestOf(message["request"]));
      await send({ protocol_version: PROTOCOL, kind: "result", request_id: requestId, result });
      return;
    }
    case "analyze_group": {
      const rawRequests = message["requests"];
      if (!Array.isArray(rawRequests)) throw new Error("Rust semantic bridge group requests are invalid.");
      const owners = await semanticGroup(rawRequests.map(requestOf));
      await send({ protocol_version: PROTOCOL, kind: "group_result", request_id: requestId, owners });
      return;
    }
    case "shutdown":
      shuttingDown = true;
      await worker.terminate();
      await send({ protocol_version: PROTOCOL, kind: "shutdown_ack", request_id: requestId });
      await writeChain;
      process.exit(0);
  }
  throw new Error("Rust semantic bridge message kind is not closed.");
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\0\r\n]/gu, " ").slice(0, 2_048);
}

process.stdin.on("data", (chunk: Buffer) => {
  try {
    buffered = buffered.byteLength === 0 ? chunk : Buffer.concat([buffered, chunk]);
    while (buffered.byteLength >= 4) {
      const length = buffered.readUInt32BE(0);
      if (length === 0 || length > MAX_MESSAGE_BYTES) throw new Error("Rust semantic bridge request exceeds its message budget.");
      if (buffered.byteLength < length + 4) break;
      const payload = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
      const decoded = JSON.parse(payload.toString("utf8")) as unknown;
      handling = handling.then(() => handle(decoded)).catch(async (error) => {
        await send({ protocol_version: PROTOCOL, kind: "error", request_id: objectOf(decoded)["request_id"], error: { name: "Error", message: errorMessage(error) } });
      });
    }
    if (buffered.byteLength > MAX_MESSAGE_BYTES + 4) throw new Error("Rust semantic bridge receive buffer exceeded its budget.");
  } catch (error) {
    if (!shuttingDown) process.stderr.write(`Rust semantic bridge failure: ${errorMessage(error)}\n`);
    process.exit(1);
  }
});
process.stdin.once("end", () => { if (!shuttingDown) process.exit(1); });
