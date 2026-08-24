// One shard of `verifyCopiedRecordIntegrity`'s untrusted per-record
// recompute (`index-pack.ts`), run inside a real `node:worker_threads`
// worker. Two modes, selected by `workerData`:
//
// - Range mode (default): its own READ-ONLY `node:sqlite` connection to the
//   target workspace database over one contiguous `record_id` keyset range.
//   The check is record-local, so ranges shard it with no cross-shard state;
//   the parent (`shardedVerifyCopiedRecordIntegrity`) picks the boundaries
//   and concatenates the failure lists. Read-only second connections against
//   a WAL workspace database are this repo's established pattern
//   (lexical/semantic worker threads, `openWorkspaceReadOnly`).
//
// - Batch mode (`workerData.mode === "batch"`): message-driven stream-time
//   verify for the import path -- the parent posts the pack's own `records`
//   rows (hex bodies included) as it builds the scratch database, this
//   worker decodes+digests each and replies per batch, so the whole
//   recompute overlaps the source-layer commit instead of running as its
//   own post-publish pass. No database connection at all in this mode.
//
// This file is a worker ENTRY POINT (loaded via `new Worker(new URL(...))`
// against compiled `dist/index-pack-verify-worker.js`, resolved the same
// self-reference way as `packages/daemon/src/lexical-thread.ts`) -- it is
// never imported by other modules.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { recordIntegrityFailure } from "./index-pack-verify-core.js";

interface VerifyShardJob {
  readonly filename: string;
  readonly workspace_id: string;
  readonly generation: number;
  /** Exclusive lower bound (`record_id > cursor_start`); "" for the first shard. */
  readonly cursor_start: string;
  /** Inclusive upper bound, or null for the last shard. */
  readonly cursor_end: string | null;
  readonly page_rows: number;
}

interface VerifyBatchJob { readonly mode: "batch" }

interface StreamVerifyRow { readonly record_id: string; readonly record_digest: string; readonly body_digest: string; readonly body_payload_hex?: string }
interface StreamVerifyBatchMessage { readonly kind: "batch"; readonly rows: readonly StreamVerifyRow[] }
interface StreamVerifyEndMessage { readonly kind: "end" }

interface WorkerResultMessage { readonly kind: "result"; readonly failures: readonly string[] }
interface WorkerBatchResultMessage { readonly kind: "batch_result"; readonly failures: readonly string[] }
interface WorkerErrorMessage { readonly kind: "error"; readonly error: { readonly name: string; readonly message: string } }

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("Expected a binary row payload.");
}

const port = parentPort;
if (!port) throw new Error("The index pack verify worker entry must be run inside a node:worker_threads worker.");
const job = workerData as VerifyShardJob | VerifyBatchJob;

if ("mode" in job && job.mode === "batch") {
  let rowCount = 0;
  const startedAt = Date.now();
  port.on("message", (message: StreamVerifyBatchMessage | StreamVerifyEndMessage) => {
    try {
      if (message.kind === "end") {
        if (process.env["URDIRA_STORAGE_DEBUG_TIMING"] === "1") console.error(`[urdira] index pack stream-verify worker done rows=${rowCount} ms=${Date.now() - startedAt}`);
        port.postMessage({ kind: "result", failures: [] } satisfies WorkerResultMessage);
        port.close();
        return;
      }
      const failures: string[] = [];
      for (const row of message.rows) {
        rowCount += 1;
        const body = row.body_payload_hex === undefined ? null : new Uint8Array(Buffer.from(row.body_payload_hex, "hex"));
        const failure = recordIntegrityFailure(row.record_id, row.record_digest, row.body_digest, body);
        if (failure !== undefined) failures.push(failure);
      }
      port.postMessage({ kind: "batch_result", failures } satisfies WorkerBatchResultMessage);
    } catch (error) {
      port.postMessage({ kind: "error", error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } } satisfies WorkerErrorMessage);
    }
  });
} else {
  const shardJob = job as VerifyShardJob;
  try {
    const startedAt = Date.now();
    let rowCount = 0;
    const database = new DatabaseSync(shardJob.filename, { readOnly: true });
    try {
      const failures: string[] = [];
      let cursor = shardJob.cursor_start;
      const rangeSql = shardJob.cursor_end === null ? "" : " AND record_id <= ?";
      for (;;) {
        const params: (string | number)[] = [shardJob.workspace_id, shardJob.generation, cursor];
        if (shardJob.cursor_end !== null) params.push(shardJob.cursor_end);
        params.push(shardJob.page_rows);
        const rows = database.prepare(
          `SELECT record_id, record_digest, body_digest, body_payload FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation = ? AND valid_to_generation IS NULL AND record_id > ?${rangeSql} ORDER BY record_id LIMIT ?`,
        ).all(...(params as never[])) as { record_id: string; record_digest: string; body_digest: string; body_payload: unknown }[];
        if (rows.length === 0) break;
        rowCount += rows.length;
        for (const row of rows) {
          const failure = recordIntegrityFailure(row.record_id, row.record_digest, row.body_digest, row.body_payload === null || row.body_payload === undefined ? null : toBytes(row.body_payload));
          if (failure !== undefined) failures.push(failure);
        }
        cursor = rows[rows.length - 1]!.record_id;
        if (failures.length > 0) break;
      }
      if (process.env["URDIRA_STORAGE_DEBUG_TIMING"] === "1") console.error(`[urdira] index pack verify shard done rows=${rowCount} ms=${Date.now() - startedAt} range=(${shardJob.cursor_start.slice(0, 24)}..${shardJob.cursor_end === null ? "end" : shardJob.cursor_end.slice(0, 24)}]`);
      port.postMessage({ kind: "result", failures } satisfies WorkerResultMessage);
    } finally {
      try { database.close(); } catch { /* already closed */ }
    }
  } catch (error) {
    port.postMessage({ kind: "error", error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } } satisfies WorkerErrorMessage);
  }
}
