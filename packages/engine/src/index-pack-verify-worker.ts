// One shard of `verifyCopiedRecordIntegrity`'s untrusted per-record
// recompute (`index-pack.ts`), run inside a real `node:worker_threads`
// worker over its own READ-ONLY `node:sqlite` connection to the target
// workspace database. The check is record-local (decode the copied
// `body_payload`, recompute its digest, check record_id/record_digest
// self-consistency), so contiguous `record_id` keyset ranges shard it with
// no cross-shard state; the parent (`shardedVerifyCopiedRecordIntegrity`)
// picks the boundaries and concatenates the failure lists. Read-only
// second connections against a WAL workspace database are this repo's
// established pattern (lexical/semantic worker threads,
// `openWorkspaceReadOnly`).
//
// This file is a worker ENTRY POINT (loaded via `new Worker(new URL(...))`
// against compiled `dist/index-pack-verify-worker.js`, resolved the same
// self-reference way as `packages/daemon/src/lexical-thread.ts`) -- it is
// never imported by other modules.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { decodeCanonical } from "@urdira/canonical";
import { digestRelationalValue } from "@urdira/storage";

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

interface WorkerResultMessage { readonly kind: "result"; readonly failures: readonly string[] }
interface WorkerErrorMessage { readonly kind: "error"; readonly error: { readonly name: string; readonly message: string } }

const RECORD_ID_PATTERN = /^record:[0-9a-f]{64}$/u;

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("Expected a binary row payload.");
}

const port = parentPort;
if (!port) throw new Error("The index pack verify worker entry must be run inside a node:worker_threads worker.");
const job = workerData as VerifyShardJob;

try {
  const startedAt = Date.now();
  let rowCount = 0;
  const database = new DatabaseSync(job.filename, { readOnly: true });
  try {
    const failures: string[] = [];
    let cursor = job.cursor_start;
    const rangeSql = job.cursor_end === null ? "" : " AND record_id <= ?";
    for (;;) {
      const params: (string | number)[] = [job.workspace_id, job.generation, cursor];
      if (job.cursor_end !== null) params.push(job.cursor_end);
      params.push(job.page_rows);
      const rows = database.prepare(
        `SELECT record_id, record_digest, body_digest, body_payload FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation = ? AND valid_to_generation IS NULL AND record_id > ?${rangeSql} ORDER BY record_id LIMIT ?`,
      ).all(...(params as never[])) as { record_id: string; record_digest: string; body_digest: string; body_payload: unknown }[];
      if (rows.length === 0) break;
      rowCount += rows.length;
      for (const row of rows) {
        if (!RECORD_ID_PATTERN.test(row.record_id)) { failures.push(`record ${row.record_id} does not use the plain first-open id form (chain-salted or malformed ids are rejected)`); continue; }
        if (row.record_id !== `record:${row.record_digest.slice("sha256:".length)}`) { failures.push(`record ${row.record_id} id is not self-consistent with its own record_digest`); continue; }
        if (row.body_payload !== null && row.body_payload !== undefined) {
          try {
            const recomputed = digestRelationalValue(decodeCanonical(toBytes(row.body_payload)));
            if (recomputed.digest !== row.body_digest) failures.push(`record ${row.record_id} body_digest does not match its recomputed body_payload content`);
          } catch { failures.push(`record ${row.record_id} body_payload is not a valid canonical payload`); }
        }
      }
      cursor = rows[rows.length - 1]!.record_id;
      if (failures.length > 0) break;
    }
    if (process.env["URDIRA_STORAGE_DEBUG_TIMING"] === "1") console.error(`[urdira] index pack verify shard done rows=${rowCount} ms=${Date.now() - startedAt} range=(${job.cursor_start.slice(0, 24)}..${job.cursor_end === null ? "end" : job.cursor_end.slice(0, 24)}]`);
    port.postMessage({ kind: "result", failures } satisfies WorkerResultMessage);
  } finally {
    try { database.close(); } catch { /* already closed */ }
  }
} catch (error) {
  port.postMessage({ kind: "error", error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } } satisfies WorkerErrorMessage);
}
