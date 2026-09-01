import { decodeCanonical, encodeCanonical, MerkleRadixSet, digestLogicalValue } from "@urdira/canonical";
import { openSqliteDatabase, type SqliteDatabase } from "@urdira/storage";
import type { QueryStreamItem } from "./query-operators.js";
import { stageSetHandle, stageSetHandleMetadata, type StageSetHandle } from "./stage-set-handle.js";

/** Execution-local materialisation boundary for pipeline stages.
 *
 * A spool is deliberately not part of the wire contract.  It gives the
 * executor a bounded relational place to keep intermediate rows while the
 * final response is being built, and makes cleanup/cancellation explicit.
 */
export interface StageSpool {
  put(executionId: string, stageId: string, output: string, values: readonly QueryStreamItem[]): Promise<StageSetHandle>;
  /** Seal a lazy stage output without first materialising it as an array. */
  putIterable(executionId: string, stageId: string, output: string, values: AsyncIterable<QueryStreamItem>): Promise<StageSetHandle>;
  cleanup(executionId: string): Promise<void>;
  close(): Promise<void>;
  readonly bytes: number;
}

export interface StageSpoolLimits {
  /** Spill is allowed up to this size before the hard limit is considered. */
  readonly spill_bytes?: number;
  /** No query may retain more intermediate bytes than this value. */
  readonly hard_bytes?: number;
}

const DEFAULT_SPILL_BYTES = 256 * 1024 * 1024;
const DEFAULT_HARD_BYTES = 1024 * 1024 * 1024;

function checkedLimits(limits?: StageSpoolLimits): Required<StageSpoolLimits> {
  const spill = limits?.spill_bytes ?? DEFAULT_SPILL_BYTES;
  const hard = limits?.hard_bytes ?? DEFAULT_HARD_BYTES;
  const effectiveSpill = limits?.spill_bytes === undefined && hard < spill ? hard : spill;
  if (!Number.isSafeInteger(effectiveSpill) || effectiveSpill <= 0 || !Number.isSafeInteger(hard) || hard < effectiveSpill) throw new RangeError("Invalid pipeline spool limits.");
  return { spill_bytes: effectiveSpill, hard_bytes: hard };
}

function itemBytes(item: QueryStreamItem): number {
  return encodeCanonical(item).byteLength;
}

/** Small deterministic implementation used by unit tests and as a fallback. */
export class MemoryStageSpool implements StageSpool {
  private readonly rows = new Map<string, QueryStreamItem[]>();
  private readonly limits: Required<StageSpoolLimits>;
  private used = 0;
  constructor(limits?: StageSpoolLimits) { this.limits = checkedLimits(limits); }
  get bytes(): number { return this.used; }
  async put(executionId: string, stageId: string, output: string, values: readonly QueryStreamItem[]): Promise<StageSetHandle> {
    return this.putIterable(executionId, stageId, output, (async function* (): AsyncIterable<QueryStreamItem> { for (const value of values) yield value; })());
  }
  async putIterable(executionId: string, stageId: string, output: string, values: AsyncIterable<QueryStreamItem>): Promise<StageSetHandle> {
    const key = `${executionId}\u0000${stageId}\u0000${output}`;
    const copy: QueryStreamItem[] = [];
    let bytes = 0;
    for await (const value of values) {
      const nextBytes = itemBytes(value);
      if (this.used + bytes + nextBytes > this.limits.hard_bytes) throw new Error(`Pipeline spool hard limit exceeded (${this.limits.hard_bytes} bytes).`);
      copy.push(value);
      bytes += nextBytes;
    }
    this.rows.set(key, copy);
    this.used += bytes;
    const handle = stageSetHandle(executionId, stageId, output, copy);
    return { ...handle, iterate: async function* (): AsyncIterable<QueryStreamItem> { for (const value of copy) yield value; } };
  }
  async cleanup(executionId: string): Promise<void> {
    for (const [key, values] of this.rows) if (key.startsWith(`${executionId}\u0000`)) {
      this.used -= values.reduce((total, value) => total + itemBytes(value), 0);
      this.rows.delete(key);
    }
  }
  async close(): Promise<void> { this.rows.clear(); this.used = 0; }
}

/** SQLite-backed spool.  The database may be a temporary file or `:memory:`. */
export class SqliteStageSpool implements StageSpool {
  private readonly limits: Required<StageSpoolLimits>;
  private used = 0;
  private ready: Promise<void>;
  constructor(private readonly database: SqliteDatabase, limits?: StageSpoolLimits) {
    this.limits = checkedLimits(limits);
    this.ready = database.exec(`CREATE TABLE IF NOT EXISTS pipeline_stage_rows (
      execution_id TEXT NOT NULL, stage_id TEXT NOT NULL, output TEXT NOT NULL,
      ordinal INTEGER NOT NULL, stable_sort_key TEXT NOT NULL, payload BLOB NOT NULL,
      PRIMARY KEY (execution_id, stage_id, output, ordinal)
    ) WITHOUT ROWID;`);
  }
  static async memory(limits?: StageSpoolLimits): Promise<SqliteStageSpool> {
    return new SqliteStageSpool(await openSqliteDatabase({ filename: ":memory:" }), limits);
  }
  get bytes(): number { return this.used; }
  async put(executionId: string, stageId: string, output: string, values: readonly QueryStreamItem[]): Promise<StageSetHandle> {
    return this.putIterable(executionId, stageId, output, (async function* (): AsyncIterable<QueryStreamItem> { for (const value of values) yield value; })());
  }
  async putIterable(executionId: string, stageId: string, output: string, values: AsyncIterable<QueryStreamItem>): Promise<StageSetHandle> {
    await this.ready;
    let ordinal = 0;
    let bytes = 0;
    const tree = new MerkleRadixSet();
    const hardLimit = this.limits.hard_bytes;
    const usedBefore = this.used;
    const commands = (async function* (): AsyncIterable<{ readonly kind: "run"; readonly sql: string; readonly params: readonly (string | number | Uint8Array)[] }> {
      for await (const item of values) {
        const payload = encodeCanonical(item);
        bytes += payload.byteLength;
        if (bytes > hardLimit - usedBefore) throw new Error(`Pipeline spool hard limit exceeded (${hardLimit} bytes).`);
        tree.set(digestLogicalValue(item.stable_sort_key, "urdira:pipeline-stage-key:v3"), digestLogicalValue({ stable_sort_key: item.stable_sort_key, value: item.value }, "urdira:pipeline-stage-member:v3"));
        yield { kind: "run", sql: "INSERT INTO pipeline_stage_rows (execution_id, stage_id, output, ordinal, stable_sort_key, payload) VALUES (?, ?, ?, ?, ?, ?)", params: [executionId, stageId, output, ordinal++, item.stable_sort_key, payload] };
      }
    })();
    try {
      await this.database.transactionChunked(commands, 256, { transfer_params: true, discard_results: true });
    } catch (error) {
      // transactionChunked may already have committed an earlier bounded
      // group. Remove this incomplete stage before exposing any handle.
      try { await this.database.run("DELETE FROM pipeline_stage_rows WHERE execution_id = ? AND stage_id = ? AND output = ?", [executionId, stageId, output]); } catch { /* Preserve the original failure; execution cleanup retries by id. */ }
      throw error;
    }
    this.used += bytes;
    const database = this.database;
    const rowCount = ordinal;
    const iterate = async function* (): AsyncIterable<QueryStreamItem> {
      // Page the spool so a downstream stage never receives a full SQL result
      // array. The worker still owns each bounded page only for one turn.
      const pageSize = 512;
      let afterOrdinal = -1;
      for (;;) {
        const rows = await database.all<{ ordinal: number; payload: Uint8Array }>("SELECT ordinal, payload FROM pipeline_stage_rows WHERE execution_id = ? AND stage_id = ? AND output = ? AND ordinal > ? ORDER BY ordinal LIMIT ?", [executionId, stageId, output, afterOrdinal, pageSize]);
        if (rows.length === 0) break;
        for (const row of rows) { afterOrdinal = row.ordinal; yield decodeCanonical(row.payload) as QueryStreamItem; }
        if (rows.length < pageSize) break;
      }
    };
    const iterateReverse = async function* (): AsyncIterable<QueryStreamItem> {
      const pageSize = 512;
      let beforeOrdinal = Number.MAX_SAFE_INTEGER;
      for (;;) {
        const rows = await database.all<{ ordinal: number; payload: Uint8Array }>("SELECT ordinal, payload FROM pipeline_stage_rows WHERE execution_id = ? AND stage_id = ? AND output = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT ?", [executionId, stageId, output, beforeOrdinal, pageSize]);
        if (rows.length === 0) break;
        for (const row of rows) { beforeOrdinal = row.ordinal; yield decodeCanonical(row.payload) as QueryStreamItem; }
        if (rows.length < pageSize) break;
      }
    };
    return stageSetHandleMetadata(executionId, stageId, output, rowCount, tree.root(), "declared", iterate, iterateReverse);
  }
  async cleanup(executionId: string): Promise<void> {
    await this.ready;
    await this.database.run("DELETE FROM pipeline_stage_rows WHERE execution_id = ?", [executionId]);
    this.used = 0;
  }
  async close(): Promise<void> { await this.ready; await this.database.close(); this.used = 0; }
}

export { DEFAULT_HARD_BYTES, DEFAULT_SPILL_BYTES };
