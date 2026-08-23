import { Worker } from "node:worker_threads";
import type { FactDeltaBatch } from "@urdira/contracts";
import { timedSync } from "./debug-timing.js";
import { StorageError } from "./errors.js";

export type SqliteValue = string | number | bigint | Uint8Array | null;

export interface SqliteRunResult {
  readonly changes: number;
  readonly last_insert_rowid: number | string;
}

export type SqliteCommand =
  | { readonly kind: "exec"; readonly sql: string }
  | { readonly kind: "backup"; readonly destination: string }
  | { readonly kind: "replace_database"; readonly destination: string; readonly recovery: string }
  | { readonly kind: "run"; readonly sql: string; readonly params?: readonly SqliteValue[] }
  // One prepared statement (via the worker's existing `prepareCached`) run
  // `rows` times. `params_flat` is a flat array, not `rows` sub-arrays: each
  // row's params are the next `params_flat.length / rows` values sliced
  // sequentially -- this avoids allocating `rows` short-lived param arrays
  // (and their `postMessage` structured-clone/transfer overhead) just to
  // shuttle them across the worker boundary. `params_flat.length` MUST be an
  // exact multiple of `rows`; the worker validates this and throws before
  // running any row if it isn't (see `runBatchCore` in `SQLITE_WORKER_SOURCE`).
  | { readonly kind: "run_batch"; readonly sql: string; readonly rows: number; readonly params_flat: readonly SqliteValue[] }
  | { readonly kind: "get"; readonly sql: string; readonly params?: readonly SqliteValue[] }
  | { readonly kind: "all"; readonly sql: string; readonly params?: readonly SqliteValue[] }
  | { readonly kind: "staged_fact_delta_batch"; readonly workspace_id: string; readonly candidate_generation_id: string; readonly fact_delta_id: string; readonly accepted_at: string; readonly batch: FactDeltaBatch }
  | { readonly kind: "transaction_checkpoint" }
  | { readonly kind: "fault"; readonly boundary: string }
  | { readonly kind: "assert_transaction_changes"; readonly expected: number; readonly context?: string };

export interface TransactionChunkedOptions {
  /**
   * When true, each `batch_chunk` message transfers its chunk's `Uint8Array`
   * command-param buffers to the worker via `postMessage`'s transfer list
   * instead of structured-cloning (copying) them -- turning an O(bytes) copy
   * into an O(1) ownership handoff. Only eligible params are transferred: a
   * `Uint8Array` whose `buffer` is a plain (non-shared) `ArrayBuffer` fully
   * covered by that one view (`byteOffset === 0 && byteLength ===
   * buffer.byteLength`); anything else (partial views, `SharedArrayBuffer`
   * views) is still structured-cloned exactly as before -- transfer is
   * strictly a same-content optimization, never required for correctness.
   *
   * CONSUMES its commands: every transferred `Uint8Array`'s underlying
   * `ArrayBuffer` is detached on the sender side the moment its chunk is
   * sent (`ArrayBuffer.prototype.transfer` semantics), so neither that
   * command nor any other reference to the same buffer may be read again
   * after calling `transactionChunked` with this option -- including by a
   * caller-level retry that reuses the same command objects/arrays instead
   * of rebuilding them from scratch. Defaults to false. Verify at each call
   * site that the command params are genuinely single-use before opting in.
   */
  readonly transfer_params?: boolean;
  /**
   * When true, no caller-visible per-command result is built at all: the
   * worker's chunk loop runs each command WITHOUT allocating the
   * `{changes, last_insert_rowid}` object a plain `run` normally returns
   * (`run` still reads its own `changes` count internally, to keep feeding
   * `assert_transaction_changes`'s accumulator -- only the object nobody
   * reads is skipped), and replies to each `batch_chunk` with a plain
   * command count (`{result: n}`, a number -- nothing to structured-clone)
   * instead of an array of per-command results. `transactionChunked` itself
   * then resolves with `[]` rather than the usual per-command result array.
   *
   * Every one of this package's current `transactionChunked` call sites
   * discards the return value already, so for those this is a pure cost
   * cut: it removes both the per-command object allocation on the worker
   * side and the `postMessage` structured-clone of a ~2000-entry result
   * array per chunk, on top of whatever `transfer_params` already saves on
   * the params side -- the two options compose freely.
   *
   * ONLY valid for command streams containing exclusively `run`, `run_batch`,
   * `exec`, `transaction_checkpoint`, `assert_transaction_changes`, and
   * `fault` commands: a `get`/`all` command is meaningless to discard (its whole
   * point is the row(s) it returns), so `transactionChunked` throws a
   * `TypeError` synchronously -- before that command's chunk is ever sent
   * to the worker -- if `discard_results` is set and it encounters one.
   * Defaults to false; absent (or false), behavior is byte-identical to
   * before this option existed.
   */
  readonly discard_results?: boolean;
}

export interface SqliteDatabase {
  readonly filename: string;
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqliteValue[]): Promise<SqliteRunResult>;
  get<T extends Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]): Promise<T | undefined>;
  all<T extends Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]): Promise<readonly T[]>;
  transaction(commands: readonly SqliteCommand[]): Promise<readonly unknown[]>;
  /**
   * Drives the chunked `batch_open`/`batch_chunk`/`batch_commit`/`batch_rollback`
   * worker protocol so a large write set (source cataloging, publication) never
   * has to be materialized as one command array and structured-cloned to the
   * worker in a single `postMessage`. Semantically equivalent to `transaction`
   * (one atomic `BEGIN IMMEDIATE` ... `COMMIT`, with `transaction_checkpoint`/
   * `assert_transaction_changes` working across chunk boundaries): any error in
   * any chunk rolls back everything, including chunks already committed to the
   * worker's in-progress transaction.
   *
   * `options.transfer_params` (default false) opts a call into transferring
   * (not copying) its `Uint8Array` command params to the worker -- see
   * {@link TransactionChunkedOptions} for the single-use contract that comes
   * with it. Implementations that cannot transfer (e.g. an in-process,
   * non-worker `SqliteDatabase`) accept and ignore the option.
   *
   * `options.discard_results` (default false) opts a call into skipping
   * per-command result construction/shipping entirely (only `run`/`run_batch`/
   * `exec`/`transaction_checkpoint`/`assert_transaction_changes`/`fault`
   * command streams may use it -- see {@link TransactionChunkedOptions}), in which
   * case this resolves with `[]` instead of the usual per-command result
   * array. Implementations that cannot skip it accept and ignore the option
   * (still returning the full result array).
   */
  transactionChunked(commands: Iterable<SqliteCommand> | AsyncIterable<SqliteCommand>, chunkSize?: number, options?: TransactionChunkedOptions): Promise<readonly unknown[]>;
  close(): Promise<void>;
}

export interface OpenSqliteOptions {
  readonly filename: string;
  readonly read_only?: boolean;
  readonly busy_timeout_ms?: number;
}

interface WorkerMessage {
  readonly id: number;
  readonly kind: string;
  readonly result?: unknown;
  readonly error?: { readonly code?: string; readonly message: string; readonly name?: string; readonly details?: Record<string, string | number | boolean | undefined> };
}

const SQLITE_WORKER_SOURCE = String.raw`
  import { parentPort, workerData } from "node:worker_threads";
  import { DatabaseSync } from "node:sqlite";
  import { copyFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";

  const port = parentPort;
  if (!port) throw new Error("SQLite worker requires parentPort");
  const busyTimeout = Number(workerData.busyTimeoutMs);
  // Opt-in wall-clock attribution across every stage of the chunked
  // publish-transaction pipeline, gated the same way as
  // \`packages/storage/src/debug-timing.ts\`
  // (\`URDIRA_STORAGE_DEBUG_TIMING=1\`, threaded through explicitly via
  // \`workerData\` since a worker thread's \`process.env\` is a snapshot taken
  // at worker creation, not a live view of the parent's environment).
  // \`console.error\` in a worker thread is piped to the parent process's
  // stderr by default (no \`stderr: true\` needed), matching this codebase's
  // existing \`[urdira] ...\` stderr-diagnostic convention.
  //
  // Buckets, all accumulated per committed transaction and reset when that
  // transaction's summary line is logged:
  //  - prepare_ms / prepare_count: \`DatabaseSync.prepare\` calls that missed
  //    \`statementCache\` (see \`prepareCached\`).
  //  - param_ms / param_count: normalizing a command's \`params\` into the
  //    argument list handed to the prepared statement (\`command.params ??
  //    []\`), measured separately from the native call so a real param-side
  //    cost (e.g. Uint8Array handling) wouldn't be hidden inside exec_ms.
  //  - exec_ms / exec_count: the native \`DatabaseSync\` statement call itself
  //    (\`.run\`/\`.get\`/\`.all\`) -- nothing else.
  //  - result_ms / result_count: building the \`{changes, last_insert_rowid}\`
  //    object a non-discard \`run\` command returns (skipped entirely when
  //    \`discard\` is set -- see \`runStatement\`/\`runStatementTimed\`).
  //  - chunk_idle_ms / chunk_idle_count: time the worker sat idle between
  //    finishing one \`batch_chunk\`'s last command and starting the next
  //    \`batch_chunk\`'s first -- i.e. waiting on the main thread's next
  //    \`postMessage\` to arrive. A transport-starvation signal: high values
  //    here mean the fix is pipelining/host-side, not SQL.
  //  - txn_wall_ms: total wall time from \`batch_open\` to \`batch_commit\`
  //    completing (not accumulated across transactions -- one value per
  //    logged line).
  const DEBUG_TIMING = Boolean(workerData.debugTiming);
  let prepareMs = 0;
  let prepareCount = 0;
  let paramMs = 0;
  let paramCount = 0;
  let execMs = 0;
  let execCount = 0;
  let resultMs = 0;
  let resultCount = 0;
  let chunkIdleMs = 0;
  let chunkIdleCount = 0;
  // Timestamp (performance.now()) the previous \`batch_chunk\` finished
  // processing its last command, or \`null\` when there is no "previous
  // chunk" yet to measure idle time against (right after \`batch_open\`, or
  // when DEBUG_TIMING is off). Reset at every \`batch_open\`.
  let lastChunkEndAt = null;
  // Timestamp \`batch_open\` started its transaction; only meaningful while
  // DEBUG_TIMING is on.
  let txnStartAt = 0;
  function openDatabase(filename) {
    const opened = new DatabaseSync(filename, { readOnly: Boolean(workerData.readOnly), timeout: busyTimeout });
    opened.enableDefensive(true);
    opened.exec("PRAGMA busy_timeout = " + busyTimeout + ";");
    opened.exec("PRAGMA foreign_keys = ON;");
    opened.exec("PRAGMA trusted_schema = OFF;");
    if (!workerData.readOnly) { opened.exec("PRAGMA journal_mode = WAL;"); opened.exec("PRAGMA synchronous = FULL;"); }
    return opened;
  }

  let database = openDatabase(workerData.filename);
  // Prepared-statement cache, keyed by exact SQL text: every command builder
  // in this package (source cataloging, candidate publication) reuses a
  // small, fixed set of static SQL templates across a huge number of rows
  // (one parameterized INSERT/UPDATE per record/dependency/projection, or a
  // handful of distinct multi-row VALUES shapes for lexical postings), so
  // DatabaseSync.prepare -- which re-parses and re-plans the statement every
  // call, with no caching of its own -- was being invoked once per row for
  // identical SQL text. Caching by SQL text turns that into "prepare once
  // per distinct template, reuse thereafter" without changing what SQL runs
  // or its parameter binding. Cleared (and old statements discarded)
  // whenever "database" itself is replaced, below.
  let statementCache = new Map();
  function prepareCached(sql) {
    let statement = statementCache.get(sql);
    if (statement) return statement;
    const startedAt = DEBUG_TIMING ? performance.now() : 0;
    statement = database.prepare(sql);
    if (DEBUG_TIMING) { prepareMs += performance.now() - startedAt; prepareCount += 1; }
    statementCache.set(sql, statement);
    return statement;
  }
  // Chunked-transaction state: at most one \`batch_open\` .. \`batch_commit\`/
  // \`batch_rollback\` sequence can be in flight at a time (one SQLite writer
  // connection). \`changes\` mirrors the \`batch\` handler's checkpoint counter,
  // but must survive across chunk messages instead of resetting per chunk.
  let activeTransaction = null;

  function errorDetails(error) {
    return {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      code: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined,
    };
  }

  function logDebugTimingsIfEnabled(label, txnWallMs) {
    if (!DEBUG_TIMING) return;
    console.error(
      "[urdira] storage timings sqlite_worker " + label +
      " prepare_ms=" + Math.round(prepareMs) + " prepare_count=" + prepareCount +
      " param_ms=" + Math.round(paramMs) + " param_count=" + paramCount +
      " exec_ms=" + Math.round(execMs) + " exec_count=" + execCount +
      " result_ms=" + Math.round(resultMs) + " result_count=" + resultCount +
      " chunk_idle_ms=" + Math.round(chunkIdleMs) + " chunk_idle_count=" + chunkIdleCount +
      " txn_wall_ms=" + Math.round(txnWallMs || 0) +
      " cache_size=" + statementCache.size
    );
    prepareMs = 0; prepareCount = 0;
    paramMs = 0; paramCount = 0;
    execMs = 0; execCount = 0;
    resultMs = 0; resultCount = 0;
    chunkIdleMs = 0; chunkIdleCount = 0;
  }

  // Chunked \`batch_chunk\` messages carry a per-message \`sqls\` dedup table
  // (\`command.s\` indexes into it) instead of a copy of the SQL string on
  // every command -- this package's command builders reuse a small, fixed
  // set of SQL templates across a huge number of rows (measured: ~49k
  // commands, 17 distinct SQL strings on a full-workspace publish), so
  // shipping each command's own copy of its (often ~2.5KB) SQL text was
  // itself a meaningful share of \`postMessage\` deserialization cost, on top
  // of what \`prepareCached\` already amortizes for statement preparation.
  // \`sqls\` is undefined for every other message shape (\`batch\`, and single
  // \`run\`/\`get\`/\`all\`/\`exec\` dispatch, both always old-shape with an inline
  // \`command.sql\`), and a command's own \`sql\` field -- if present -- always
  // wins over \`sqls[command.s]\` (backward-compatible fallback for any
  // caller still sending the pre-dedup shape).
  function resolveSql(command, sqls) {
    return command.sql !== undefined ? command.sql : sqls[command.s];
  }

  // Split out of \`execute\` so the DEBUG_TIMING-off path (the common case,
  // including every \`discard\` chunk) can call it directly instead of going
  // through a \`try/finally\` wrapper it has no timing to record into --
  // measured a genuine reduction in per-command overhead at the row counts
  // \`discard\` chunks push through (\`try/finally\` blocks V8's inliner even
  // when nothing inside throws). Behaves identically to before either way;
  // this is a structural split, not a semantic one.
  //
  // \`discard\`: \`run\` still returns a value (its statement's raw \`changes\`
  // count, a plain number -- \`runChunkCommand\` needs it to keep feeding
  // \`assert_transaction_changes\`'s accumulator) but skips allocating the
  // \`{changes, last_insert_rowid}\` object no discard-mode caller ever reads.
  // \`get\`/\`all\` under \`discard\` return \`null\` without even running the
  // statement -- unreachable in practice (the adapter rejects \`get\`/\`all\`
  // client-side before a discard-mode chunk is ever sent, see
  // \`SqliteWorkerAdapter.transactionChunked\`), kept here only as a
  // symmetrical, cheap backstop.
  function buildRunResult(result) {
    return {
      changes: Number(result.changes),
      last_insert_rowid: typeof result.lastInsertRowid === "bigint" ? result.lastInsertRowid.toString() : Number(result.lastInsertRowid),
    };
  }
  function runStatement(command, statement, params, discard) {
    if (command.kind === "run") {
      const result = statement.run(...params);
      if (discard) return Number(result.changes);
      return buildRunResult(result);
    }
    if (command.kind === "get") return discard ? null : (statement.get(...params) ?? null);
    return discard ? null : statement.all(...params);
  }
  // DEBUG_TIMING twin of \`runStatement\` above: same dispatch, but times the
  // native \`DatabaseSync\` call (\`exec_ms\`/\`exec_count\`) separately from
  // building a non-discard \`run\`'s result object (\`result_ms\`/
  // \`result_count\`), so neither bucket silently absorbs the other's cost.
  // Only ever invoked when \`DEBUG_TIMING\` is true (see \`execute\`), so the
  // \`performance.now()\` calls here never run on the hot off-path.
  function runStatementTimed(command, statement, params, discard) {
    if (command.kind === "run") {
      const execStartedAt = performance.now();
      const result = statement.run(...params);
      execMs += performance.now() - execStartedAt; execCount += 1;
      if (discard) return Number(result.changes);
      const resultStartedAt = performance.now();
      const built = buildRunResult(result);
      resultMs += performance.now() - resultStartedAt; resultCount += 1;
      return built;
    }
    const execStartedAt = performance.now();
    const value = command.kind === "get"
      ? (discard ? null : (statement.get(...params) ?? null))
      : (discard ? null : statement.all(...params));
    execMs += performance.now() - execStartedAt; execCount += 1;
    return value;
  }

  // \`run_batch\`: one prepared statement executed \`command.rows\` times, params
  // sliced sequentially out of \`command.params_flat\` (arity = params_flat.length
  // / rows -- validated below, not carried on the wire). A single reused
  // \`scratch\` array is sliced into per row instead of allocating a fresh
  // params array per row, mirroring the flat-transport contract itself:
  // this command kind exists specifically to avoid per-row allocation, on
  // both sides of the worker boundary.
  //
  // A row that throws (typically a UNIQUE/constraint violation) is rewrapped
  // so the message SUBSTRING-includes the original error's message (the
  // \`ERR_SQLITE_ERROR\`/\`UNIQUE\`/\`constraint\` text \`storage.ts\`'s publish
  // path regex-matches against is preserved verbatim, just with a "row N of
  // rows (sql: ...)" prefix) while keeping \`.code\`/\`.name\` byte-identical to
  // the original -- classification in storage.ts (publication_conflict) reads
  // \`.code\`, and its regex scans the whole message, so both keep working
  // unchanged.
  // \`discard\`: mirrors \`runStatement\`'s discard branch -- \`totalChanges\` is
  // still accumulated (state.changes' accumulator needs it either way), but
  // no per-row \`{changes, last_insert_rowid}\` object is built and the
  // returned \`rows\` array is omitted entirely, matching \`run\`'s "compute the
  // count, skip the object nobody reads" contract at row scale.
  function runBatchCore(sql, rows, paramsFlat, discard, timed) {
    if (!Number.isInteger(rows) || rows < 0) {
      const error = new Error("run_batch rows must be a non-negative integer, got " + rows + ".");
      error.code = "storage:run_batch_invalid";
      throw error;
    }
    if (rows === 0) {
      if (paramsFlat.length !== 0) {
        const error = new Error("run_batch with rows=0 must have an empty params_flat, got length " + paramsFlat.length + ".");
        error.code = "storage:run_batch_invalid";
        throw error;
      }
      return discard ? 0 : { changes: 0, rows: [] };
    }
    if (paramsFlat.length % rows !== 0) {
      const error = new Error("run_batch params_flat.length (" + paramsFlat.length + ") is not evenly divisible by rows (" + rows + ").");
      error.code = "storage:run_batch_invalid";
      throw error;
    }
    const arity = paramsFlat.length / rows;
    const statement = prepareCached(sql);
    const scratch = new Array(arity);
    let totalChanges = 0;
    const perRow = discard ? null : new Array(rows);
    for (let row = 0; row < rows; row += 1) {
      const base = row * arity;
      for (let column = 0; column < arity; column += 1) scratch[column] = paramsFlat[base + column];
      let result;
      if (timed) {
        const execStartedAt = performance.now();
        try { result = statement.run(...scratch); } catch (error) { throw wrapRunBatchRowError(error, row, rows, sql); }
        execMs += performance.now() - execStartedAt; execCount += 1;
        if (discard) { totalChanges += Number(result.changes); continue; }
        const resultStartedAt = performance.now();
        perRow[row] = buildRunResult(result);
        resultMs += performance.now() - resultStartedAt; resultCount += 1;
      } else {
        try { result = statement.run(...scratch); } catch (error) { throw wrapRunBatchRowError(error, row, rows, sql); }
        if (discard) { totalChanges += Number(result.changes); continue; }
        perRow[row] = buildRunResult(result);
      }
      totalChanges += Number(result.changes);
    }
    return discard ? totalChanges : { changes: totalChanges, rows: perRow };
  }
  function wrapRunBatchRowError(error, row, rows, sql) {
    const wrapped = new Error("run_batch row " + row + " of " + rows + " failed (sql: " + sql + "): " + (error instanceof Error ? error.message : String(error)));
    if (error && typeof error === "object" && "code" in error) wrapped.code = error.code;
    wrapped.name = error instanceof Error ? error.name : "Error";
    return wrapped;
  }

  const FACT_DELTA_SECTIONS = ["records", "graph_edges", "identities", "dependencies"];
  // The bundled SQLite build may expose either the historical 999-variable
  // limit or a newer compile-time limit.  Use the conservative value for
  // generated multi-row statements; single-row statements can still use the
  // full typed-column shape without risking the SQLite variable error.
  const SQLITE_SAFE_VARIABLE_LIMIT = 999;
  const FACT_DELTA_UTF8 = new TextDecoder("utf-8", { fatal: true });
  // A section may contain several scalar values per logical row (for example
  // five record strings), so the row budget is not a sufficient namespace
  // stride. The byte budget bounds every arena index well below this value.
  const FACT_DELTA_ROW_STRIDE = 4 * 1024 * 1024;
  // Receipt insertion and staging rows share the same SQLite transaction. A
  // committed receipt makes a retry a no-op; a failed transaction rolls back
  // every row. One relational row now represents one logical batch row. The
  // typed columns are promoted from the Schema IR shape instead of storing a
  // generic value-slot row for every scalar.
  const STAGED_TYPED_COLUMNS = [
    "fact_delta_key", "row_ordinal",
    "text_0", "text_1", "text_2", "text_3", "text_4", "text_5", "text_6", "text_7",
    "real_0", "real_1", "real_2", "real_3",
    "integer_0", "integer_1", "integer_2", "integer_3",
    "enum_0", "enum_1", "enum_2", "enum_3",
    "presence_0", "presence_1", "presence_2", "presence_3", "presence_4", "presence_5", "presence_6", "presence_7",
  ];
  const STAGED_TYPED_TABLES = { records: "candidate_staged_records", graph_edges: "candidate_staged_graph_edges", identities: "candidate_staged_identities", dependencies: "candidate_staged_dependencies" };
  const FACT_DELTA_RECEIPT_SQL = "SELECT byte_length, is_final FROM candidate_fact_delta_batches WHERE workspace_id = ? AND candidate_generation_id = ? AND fact_delta_id = ? AND sequence = ?";
  const FACT_DELTA_LATEST_SQL = "SELECT MAX(sequence) AS sequence, MAX(is_final) AS is_final FROM candidate_fact_delta_batches WHERE workspace_id = ? AND candidate_generation_id = ? AND fact_delta_id = ?";
  const FACT_DELTA_INSERT_SQL = "INSERT INTO candidate_fact_delta_batches (workspace_id, candidate_generation_id, fact_delta_id, sequence, byte_length, is_final, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)";
  const FACT_DELTA_NAMESPACE_INSERT_SQL = "INSERT INTO candidate_fact_delta_namespaces (workspace_id, candidate_generation_id, fact_delta_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING";
  const FACT_DELTA_KEY_SQL = "SELECT fact_delta_key FROM candidate_fact_delta_namespaces WHERE workspace_id = ? AND candidate_generation_id = ? AND fact_delta_id = ?";

  // This is deliberately executed inside the SQLite worker. The parent only
  // validates ownership and transfers the seven arenas per section; it does
  // not decode UTF-8 or build one SQL command per value on the hot path.
  function executeStagedFactDeltaBatch(command) {
    const batch = command.batch;
    const receipt = prepareCached(FACT_DELTA_RECEIPT_SQL).get(command.workspace_id, command.candidate_generation_id, command.fact_delta_id, batch.sequence);
    if (receipt !== undefined) {
      if (Number(receipt.byte_length) !== Number(batch.byte_length) || Number(receipt.is_final) !== (batch.final ? 1 : 0)) {
        const conflict = new Error("FactDelta batch receipt conflicts with the transferred batch.");
        conflict.code = "storage:fact_delta_batch_conflict";
        throw conflict;
      }
      return { status: "already_accepted" };
    }
    const latest = prepareCached(FACT_DELTA_LATEST_SQL).get(command.workspace_id, command.candidate_generation_id, command.fact_delta_id);
    const latestSequence = latest?.sequence === null || latest?.sequence === undefined ? undefined : Number(latest.sequence);
    if ((latestSequence === undefined && batch.sequence !== 0) || (latestSequence !== undefined && batch.sequence !== latestSequence + 1)) {
      const sequenceError = new Error("FactDelta batches must be accepted in sequence order.");
      sequenceError.code = "storage:fact_delta_sequence_invalid";
      throw sequenceError;
    }
    if (latest?.is_final !== null && latest?.is_final !== undefined && Number(latest.is_final) === 1) {
      const finalError = new Error("A final FactDelta batch cannot be followed by another batch.");
      finalError.code = "storage:fact_delta_sequence_invalid";
      throw finalError;
    }
    prepareCached(FACT_DELTA_NAMESPACE_INSERT_SQL).run(command.workspace_id, command.candidate_generation_id, command.fact_delta_id);
    const parentDelta = prepareCached(FACT_DELTA_KEY_SQL).get(command.workspace_id, command.candidate_generation_id, command.fact_delta_id);
    if (parentDelta === undefined) {
      const parentError = new Error("A staged FactDelta batch could not allocate its compact namespace.");
      parentError.code = "storage:fact_delta_batch_invalid";
      throw parentError;
    }
    const factDeltaKey = Number(parentDelta.fact_delta_key);
    for (const sectionName of FACT_DELTA_SECTIONS) {
      const section = batch[sectionName];
      const typedTable = STAGED_TYPED_TABLES[sectionName];
      const insertPrefix = "INSERT INTO " + typedTable + " (" + STAGED_TYPED_COLUMNS.join(", ") + ") VALUES ";
      const columnCount = STAGED_TYPED_COLUMNS.length;
      // Amortise the native SQLite statement boundary. The old loop called
      // sqlite3_step once per scalar (millions of calls for a large TS
      // workspace); bounded multi-row INSERTs retain relational storage while
      // keeping the parameter vector comfortably below SQLite's variable cap.
      const pending = [];
      const flush = () => {
        if (pending.length === 0) return;
        const placeholders = pending.map(() => "(" + candidateStagedRowPlaceholders(columnCount) + ")").join(",");
        prepareCached(insertPrefix + placeholders).run(...pending.flat());
        pending.length = 0;
      };
      const queue = (rowOrdinal, values) => {
        pending.push([factDeltaKey, rowOrdinal, ...values]);
        const rowsPerStatement = Math.max(1, Math.floor(SQLITE_SAFE_VARIABLE_LIMIT / columnCount));
        if (pending.length >= rowsPerStatement) flush();
      };
      for (let row = 0; row < section.row_count; row += 1) {
        const values = new Array(28).fill(null);
        const textStart = Number(section.strings.row_offsets[row]);
        const textEnd = Number(section.strings.row_offsets[row + 1]);
        if (textEnd - textStart > 8) throw new Error("FactDelta row contains more than eight text values.");
        for (let value = textStart; value < textEnd; value += 1) {
          const start = Number(section.strings.offsets[value]);
          const length = Number(section.strings.lengths[value]);
          values[value - textStart] = FACT_DELTA_UTF8.decode(section.strings.bytes.subarray(start, start + length));
        }
        appendTypedValues(values, section.numbers, section.number_row_offsets, row, 8, 4);
        appendTypedValues(values, section.ordinals, section.ordinal_row_offsets, row, 12, 4);
        appendTypedValues(values, section.enums, section.enum_row_offsets, row, 16, 4);
        appendTypedValues(values, section.presence, section.presence_row_offsets, row, 20, 8);
        queue(batch.sequence * FACT_DELTA_ROW_STRIDE + row, values);
      }
      flush();
    }
    prepareCached(FACT_DELTA_INSERT_SQL).run(command.workspace_id, command.candidate_generation_id, command.fact_delta_id, batch.sequence, batch.byte_length, batch.final ? 1 : 0, command.accepted_at);
    return { status: "inserted" };
  }

  function candidateStagedRowPlaceholders(columnCount = STAGED_TYPED_COLUMNS.length) {
    return new Array(columnCount).fill("?").join(",");
  }

  function appendTypedValues(target, source, offsets, row, targetOffset, maxValues) {
    const start = Number(offsets[row]);
    const end = Number(offsets[row + 1]);
    if (end - start > maxValues) throw new Error("FactDelta row exceeds its promoted typed-column budget.");
    for (let index = start; index < end; index += 1) target[targetOffset + index - start] = source[index];
  }

  function execute(command, sqls, discard) {
    if (command.kind === "staged_fact_delta_batch") return discard ? null : executeStagedFactDeltaBatch(command);
    if (command.kind === "exec") {
      database.exec(resolveSql(command, sqls));
      return null;
    }
    if (command.kind === "backup") {
      const destination = String(command.destination).replaceAll("'", "''");
      database.exec("PRAGMA wal_checkpoint(FULL);");
      database.exec("VACUUM INTO '" + destination + "';");
      return null;
    }
    if (command.kind === "replace_database") {
      database.exec("PRAGMA wal_checkpoint(FULL);");
      database.close();
      mkdirSync(command.recovery.split("/").slice(0, -1).join("/") || ".", { recursive: true });
      copyFileSync(workerData.filename, command.recovery);
      try { unlinkSync(workerData.filename + "-wal"); } catch {}
      try { unlinkSync(workerData.filename + "-shm"); } catch {}
      try {
        renameSync(command.destination, workerData.filename);
      } catch (error) {
        try { renameSync(command.recovery, workerData.filename); } catch {}
        throw error;
      }
      database = openDatabase(workerData.filename);
      statementCache = new Map();
      return null;
    }
    if (command.kind === "run_batch") return runBatchCore(resolveSql(command, sqls), command.rows, command.params_flat, discard, DEBUG_TIMING);
    const statement = prepareCached(resolveSql(command, sqls));
    if (!DEBUG_TIMING) {
      const params = command.params ?? [];
      return runStatement(command, statement, params, discard);
    }
    // Timed separately from \`exec_ms\`: this is whatever normalization runs
    // per command before the native call (currently just resolving
    // \`command.params\`'s default) -- kept as its own bucket so a future,
    // heavier per-param transformation (e.g. Uint8Array handling) shows up
    // here instead of being invisibly folded into \`exec_ms\`.
    const paramStartedAt = performance.now();
    const params = command.params ?? [];
    paramMs += performance.now() - paramStartedAt; paramCount += 1;
    return runStatementTimed(command, statement, params, discard);
  }

  // \`discard\`: same command dispatch as the non-discard path, but \`run\`'s
  // \`state.changes\` accumulation reads \`execute\`'s raw number return
  // (instead of a \`.changes\` property on an object) and this always returns
  // \`undefined\` -- the caller (the \`batch_chunk\` handler's discard branch)
  // never collects per-command return values into a results array at all.
  function runChunkCommand(command, state, sqls, discard) {
    if (command.kind === "transaction_checkpoint") {
      state.changes = 0;
      return null;
    }
    if (command.kind === "fault") {
      const fault = new Error("Fault injected at " + command.boundary + ".");
      fault.code = "storage:fault_injected";
      throw fault;
    }
    if (command.kind === "assert_transaction_changes") {
      if (state.changes !== command.expected) {
        const assertionError = new Error("Expected " + command.expected + " changes after transaction checkpoint, got " + state.changes + "." + (command.context ? " (" + command.context + ")" : ""));
        assertionError.code = "storage:transaction_assertion_failed";
        throw assertionError;
      }
      return null;
    }
    const result = execute(command, sqls, discard);
    if (command.kind === "run") state.changes += discard ? result : Number(result.changes);
    // \`run_batch\`'s \`execute\` return is already the row-summed total (a
    // plain number under \`discard\`, \`.changes\` otherwise) -- same shape
    // \`run\`'s branch above reads, just pre-summed across every row instead
    // of one.
    if (command.kind === "run_batch") state.changes += discard ? result : result.changes;
    return discard ? undefined : result;
  }

  port.on("message", (message) => {
    try {
      if (message.kind === "close") {
        if (activeTransaction) {
          try { database.exec("ROLLBACK;"); } catch {}
          activeTransaction = null;
        }
        database.close();
        port.postMessage({ id: message.id, kind: "result", result: null });
        return;
      }
      if (message.kind === "batch_open") {
        if (activeTransaction) {
          const error = new Error("A SQLite chunked transaction is already open.");
          error.code = "storage:transaction_already_open";
          throw error;
        }
        database.exec("BEGIN IMMEDIATE;");
        activeTransaction = { txn: message.txn, changes: 0 };
        if (DEBUG_TIMING) { lastChunkEndAt = null; txnStartAt = performance.now(); }
        port.postMessage({ id: message.id, kind: "result", result: null });
        return;
      }
      if (message.kind === "batch_chunk") {
        // Ownership is checked against \`txn\` (the tag shared by every message
        // of one open/chunk*/commit sequence), not \`message.id\`: chunks are
        // pipelined by the adapter (several \`batch_chunk\` messages in flight
        // at once, each with its own \`id\` for reply routing), so \`id\` alone
        // can no longer identify "this transaction".
        if (!activeTransaction || activeTransaction.txn !== message.txn) {
          const error = new Error("No open SQLite chunked transaction for this id.");
          error.code = "storage:transaction_not_open";
          throw error;
        }
        // \`chunk_idle_ms\`: time since the previous \`batch_chunk\` finished its
        // last command (\`lastChunkEndAt\`, set below), i.e. how long this
        // worker sat idle waiting for the current \`batch_chunk\` message to
        // arrive. \`null\` right after \`batch_open\` (no previous chunk to
        // measure against) and whenever DEBUG_TIMING is off.
        if (DEBUG_TIMING && lastChunkEndAt !== null) {
          chunkIdleMs += performance.now() - lastChunkEndAt;
          chunkIdleCount += 1;
        }
        try {
          // \`message.discard\` (see \`TransactionChunkedOptions.discard_results\`):
          // a plain \`for\` loop instead of \`.map\` -- there is no per-command
          // return value worth collecting into an array (\`runChunkCommand\`
          // always returns \`undefined\` in this mode) -- and the reply carries
          // just the command count, a number, so there is nothing for
          // \`postMessage\` to structured-clone beyond one scalar.
      if (message.discard) {
            for (const command of message.commands) runChunkCommand(command, activeTransaction, message.sqls, true);
            if (DEBUG_TIMING) lastChunkEndAt = performance.now();
            port.postMessage({ id: message.id, kind: "result", result: message.commands.length });
          } else {
            const results = message.commands.map((command) => runChunkCommand(command, activeTransaction, message.sqls));
            if (DEBUG_TIMING) lastChunkEndAt = performance.now();
            port.postMessage({ id: message.id, kind: "result", result: results });
          }
        } catch (error) {
          try { database.exec("ROLLBACK;"); } catch {}
          activeTransaction = null;
          throw error;
        }
        return;
      }
      if (message.kind === "batch_commit") {
        if (!activeTransaction || activeTransaction.txn !== message.txn) {
          const error = new Error("No open SQLite chunked transaction for this id.");
          error.code = "storage:transaction_not_open";
          throw error;
        }
        try {
          database.exec("COMMIT;");
        } catch (error) {
          try { database.exec("ROLLBACK;"); } catch {}
          activeTransaction = null;
          throw error;
        }
        activeTransaction = null;
        logDebugTimingsIfEnabled("batch_commit", DEBUG_TIMING ? performance.now() - txnStartAt : 0);
        port.postMessage({ id: message.id, kind: "result", result: null });
        return;
      }
      if (message.kind === "batch_rollback") {
        if (activeTransaction && activeTransaction.txn === message.txn) {
          try { database.exec("ROLLBACK;"); } catch {}
          activeTransaction = null;
        }
        port.postMessage({ id: message.id, kind: "result", result: null });
        return;
      }
      if (message.kind === "batch") {
        if (message.commands.length === 1 && (message.commands[0].kind === "backup" || message.commands[0].kind === "replace_database")) {
          const result = execute(message.commands[0]);
          port.postMessage({ id: message.id, kind: "result", result: [result] });
          return;
        }
        const batchStartedAt = DEBUG_TIMING ? performance.now() : 0;
        database.exec("BEGIN IMMEDIATE;");
        try {
          let checkpointChanges = 0;
          const results = message.commands.map((command) => {
            if (command.kind === "transaction_checkpoint") {
              checkpointChanges = 0;
              return null;
            }
            if (command.kind === "fault") {
              const fault = new Error("Fault injected at " + command.boundary + ".");
              fault.code = "storage:fault_injected";
              throw fault;
            }
            if (command.kind === "assert_transaction_changes") {
              if (checkpointChanges !== command.expected) {
                const assertionError = new Error("Expected " + command.expected + " changes after transaction checkpoint, got " + checkpointChanges + "." + (command.context ? " (" + command.context + ")" : ""));
                assertionError.code = "storage:transaction_assertion_failed";
                throw assertionError;
              }
              return null;
            }
            const result = execute(command);
            if (command.kind === "run") checkpointChanges += Number(result.changes);
            if (command.kind === "run_batch") checkpointChanges += result.changes;
            return result;
          });
          database.exec("COMMIT;");
          logDebugTimingsIfEnabled("batch", DEBUG_TIMING ? performance.now() - batchStartedAt : 0);
          port.postMessage({ id: message.id, kind: "result", result: results });
        } catch (error) {
          try { database.exec("ROLLBACK;"); } catch {}
          throw error;
        }
        return;
      }
      port.postMessage({ id: message.id, kind: "result", result: execute(message) });
    } catch (error) {
      port.postMessage({ id: message.id, kind: "error", error: errorDetails(error) });
    }
  });
`;

/**
 * Collects the distinct `ArrayBuffer`s backing command params and native
 * FactDelta arenas that are safe to hand to `postMessage`'s transfer list -- see
 * `TransactionChunkedOptions.transfer_params`'s doc comment for the exact
 * eligibility rule (plain `ArrayBuffer`, not shared; the view covers the
 * whole buffer) and why ineligible params are simply left out (they are
 * still sent, just structured-cloned instead of transferred). Dedupes by
 * buffer identity with a `Set` -- `postMessage` throws `DataCloneError` if
 * the same `Transferable` appears twice in one transfer list, which two
 * different `Uint8Array` params over the same underlying buffer (or the same
 * param object referenced by two different commands) would otherwise cause.
 */
function collectTransferableBuffers(commands: readonly SqliteCommand[]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const visit = (value: unknown): void => {
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView;
      if (view.buffer instanceof ArrayBuffer && view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) buffers.add(view.buffer);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value && typeof value === "object") for (const item of Object.values(value)) visit(item);
  };
  for (const command of commands) {
    visit(command);
  }
  return [...buffers];
}

/**
 * Rewrites `commands`' `run`/`get`/`all`/`exec` commands -- the only kinds
 * that carry a `sql` string -- to reference a per-chunk `sqls` dedup table
 * by index (`s`) instead of embedding a full copy of the SQL text on every
 * command. This package's command builders reuse a small, fixed set of SQL
 * templates across a huge number of rows (measured on a full-workspace
 * publish: ~49,000 commands over just 17 distinct SQL strings, confirmed by
 * the worker's `prepareCached` cache size), so every command shipping its
 * own ~2.5KB copy of that SQL text was a meaningful share of the
 * `batch_chunk` message's `postMessage` structured-clone/deserialization
 * cost. `transaction_checkpoint`, `fault`, `assert_transaction_changes`,
 * `backup`, and `replace_database` never carry `sql` and pass through
 * unchanged. Semantics-preserving (dedup is purely a wire-format change:
 * the worker resolves `s` back to the exact same SQL text via `sqls[s]`
 * before executing, see `SQLITE_WORKER_SOURCE`'s `resolveSql`), so this
 * applies unconditionally to every `transactionChunked` call, no opt-in.
 */
/**
 * The only `SqliteCommand` kinds `TransactionChunkedOptions.discard_results`
 * may be used with -- see that option's doc comment for why: every other
 * kind either returns rows a discard-mode caller has, by construction,
 * asked to throw away without ever seeing (`get`/`all`), or isn't a
 * `transactionChunked`-shaped command to begin with (`backup`,
 * `replace_database`, which never appear inside a chunked transaction).
 * `run_batch` is included alongside `run`: it is exactly `run` repeated
 * `rows` times against one prepared statement, so the same discard contract
 * (compute the row-summed change count, skip the per-row result object)
 * applies at row granularity.
 */
const DISCARD_ALLOWED_KINDS: ReadonlySet<SqliteCommand["kind"]> = new Set(["run", "run_batch", "exec", "staged_fact_delta_batch", "transaction_checkpoint", "fault", "assert_transaction_changes"]);

function dedupCommandSqls(commands: readonly SqliteCommand[]): { readonly sqls: readonly string[]; readonly commands: readonly unknown[] } {
  const sqls: string[] = [];
  const indexBySql = new Map<string, number>();
  const rewritten = commands.map((command) => {
    if (command.kind !== "run" && command.kind !== "get" && command.kind !== "all" && command.kind !== "exec" && command.kind !== "run_batch") return command;
    let index = indexBySql.get(command.sql);
    if (index === undefined) {
      index = sqls.length;
      sqls.push(command.sql);
      indexBySql.set(command.sql, index);
    }
    if (command.kind === "exec") return { kind: command.kind, s: index };
    if (command.kind === "run_batch") return { kind: command.kind, s: index, rows: command.rows, params_flat: command.params_flat };
    return { kind: command.kind, s: index, params: command.params };
  });
  return { sqls, commands: rewritten };
}

export class SqliteWorkerAdapter implements SqliteDatabase {
  readonly filename: string;
  private readonly worker: Worker;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(filename: string, worker: Worker) {
    this.filename = filename;
    this.worker = worker;
    worker.on("message", (message: WorkerMessage) => this.handleMessage(message));
    worker.on("error", (error) => this.rejectPending(new StorageError("storage:sqlite_worker_failed", error.message)));
    worker.on("exit", (code) => {
      if (code !== 0) this.rejectPending(new StorageError("storage:sqlite_worker_failed", `SQLite worker exited with code ${code}`));
    });
  }

  static async open(options: OpenSqliteOptions): Promise<SqliteWorkerAdapter> {
    if (!Number.isSafeInteger(options.busy_timeout_ms ?? 5_000) || (options.busy_timeout_ms ?? 5_000) < 0) {
      throw new StorageError("storage:invalid_busy_timeout", "SQLite busy timeout must be a non-negative safe integer.");
    }
    const workerOptions = {
      eval: true,
      type: "module",
      workerData: {
        filename: options.filename,
        readOnly: options.read_only ?? false,
        busyTimeoutMs: options.busy_timeout_ms ?? 5_000,
        debugTiming: process.env["URDIRA_STORAGE_DEBUG_TIMING"] === "1",
      },
    } as unknown as ConstructorParameters<typeof Worker>[1];
    const worker = new Worker(SQLITE_WORKER_SOURCE, workerOptions);
    const adapter = new SqliteWorkerAdapter(options.filename, worker);
    await adapter.get("SELECT 1 AS ready");
    return adapter;
  }

  async exec(sql: string): Promise<void> {
    await this.request({ kind: "exec", sql });
  }

  async run(sql: string, params: readonly SqliteValue[] = []): Promise<SqliteRunResult> {
    return await this.request<SqliteRunResult>({ kind: "run", sql, params });
  }

  async get<T extends Record<string, unknown>>(sql: string, params: readonly SqliteValue[] = []): Promise<T | undefined> {
    const value = await this.request<T | null>({ kind: "get", sql, params });
    return value ?? undefined;
  }

  async all<T extends Record<string, unknown>>(sql: string, params: readonly SqliteValue[] = []): Promise<readonly T[]> {
    return await this.request<readonly T[]>({ kind: "all", sql, params });
  }

  async transaction(commands: readonly SqliteCommand[]): Promise<readonly unknown[]> {
    return await this.request<readonly unknown[]>({ kind: "batch", commands });
  }

  // See the flush-condition comment inside `transactionChunked`: bounds a
  // chunk's total bound-parameter count so multi-row publication INSERTs
  // (~8000 params per command) keep per-message payloads at the same scale
  // command-count chunking alone used to guarantee.
  private static readonly PARAMS_PER_CHUNK = 30_000;

  // Caps how many `batch_chunk` sends can be outstanding (posted, reply not
  // yet awaited) at once. This is what lets the main thread build/dedup/
  // serialize chunk N+1 while the worker is still executing chunk N instead
  // of idling on the round trip -- the whole point of pipelining -- while
  // still bounding memory to at most this many chunks' serialized command
  // payloads (and their eventual results) queued between the two threads at
  // a time. 2 is enough to fully hide worker exec time behind main-thread
  // build time whenever the two are comparable (the common case here); a
  // larger cap buys nothing further once the pipeline is full and only
  // holds more payloads in memory simultaneously.
  private static readonly IN_FLIGHT_CHUNK_CAP = 2;

  async transactionChunked(commands: Iterable<SqliteCommand> | AsyncIterable<SqliteCommand>, chunkSize = 2_000, options: TransactionChunkedOptions = {}): Promise<readonly unknown[]> {
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      throw new StorageError("storage:invalid_chunk_size", "SQLite chunked transaction size must be a positive safe integer.");
    }
    const transferParams = options.transfer_params ?? false;
    const discardResults = options.discard_results ?? false;
    // `txn` tags every message of this open/chunk*/commit sequence for the
    // worker's ownership check (it holds a single writer connection, so only
    // one such sequence is ever active) -- see SQLITE_WORKER_SOURCE's
    // `activeTransaction.txn`. It is deliberately NOT used for reply routing:
    // chunks are pipelined below (several `batch_chunk` sends outstanding at
    // once), so each individual message gets its own `id` from `nextId`,
    // keeping the `pending` map's id -> resolver entries one-to-one no matter
    // how many chunks of this transaction are in flight simultaneously.
    const txn = this.nextId++;
    const results: unknown[] = [];
    let buffer: SqliteCommand[] = [];
    let bufferedParams = 0;

    // In-flight chunk-reply promises, oldest first. The worker processes its
    // message queue serially (the `port.on("message", ...)` handler never
    // awaits), so replies land in the same order chunks were sent in --
    // draining this array from the front therefore matches each reply to the
    // right chunk without depending on which promise settles first. Under
    // `discardResults` each reply is a plain command count (a number,
    // `SQLITE_WORKER_SOURCE`'s `batch_chunk` discard branch), not a result
    // array -- `drainOldest` below only spreads it into `results` when it
    // isn't.
    const inFlight: Promise<readonly unknown[] | number>[] = [];
    // First (in send order) chunk failure, and whether one has happened yet.
    // Once the worker sees an error in any chunk it rolls back and clears
    // `activeTransaction` (SQLITE_WORKER_SOURCE's `batch_chunk` handler), so
    // every chunk already pipelined behind the failing one also fails, with
    // `storage:transaction_not_open` -- a consequence of the first failure,
    // not an independent one. Only the first is surfaced to the caller;
    // later ones are absorbed here.
    let hasError = false;
    let firstError: unknown;

    const send = (chunkCommands: readonly SqliteCommand[]): void => {
      // See `TransactionChunkedOptions.transfer_params`'s doc comment: only
      // collected (and the transfer actually attempted) when the caller
      // opted in, so an un-opted call's structured-clone behavior is
      // completely unchanged.
      const transferList = transferParams ? collectTransferableBuffers(chunkCommands) : undefined;
      // See `dedupCommandSqls`'s doc comment: applied unconditionally (not
      // gated by an option) since it's a pure wire-format change.
      const { sqls, commands: dedupedCommands } = dedupCommandSqls(chunkCommands);
      // `discard: true` is only ever included, never sent as `false` --
      // matches every other optional wire flag in this protocol (e.g.
      // `sqls` above) and keeps a non-discard call's message shape exactly
      // what it always was.
      const message: Record<string, unknown> = { kind: "batch_chunk", txn, sqls, commands: dedupedCommands };
      if (discardResults) message["discard"] = true;
      const reply = this.requestWithId<readonly unknown[] | number>(this.nextId++, message, transferList);
      // Attach a rejection handler synchronously, before control returns to
      // any `await` elsewhere: an absorbed later-chunk failure (below, in
      // `drainOldest`) must never surface as an unhandled promise rejection
      // while it sits behind earlier chunks in `inFlight`.
      reply.catch(() => {});
      inFlight.push(reply);
    };

    // Awaits and consumes the oldest in-flight chunk. Keeps `results` in
    // send order (chunks are pushed to `inFlight` in send order and this
    // always pops index 0), and records only the first error seen -- see
    // `firstError` above.
    const drainOldest = async (): Promise<void> => {
      const reply = inFlight.shift();
      if (!reply) return;
      try {
        const chunkResults = await reply;
        // Under `discardResults` every reply is a command count (a number,
        // not a result array -- see `inFlight`'s doc comment above): nothing
        // to push into `results`, which is why `transactionChunked` resolves
        // with `[]` in that mode.
        if (!hasError && !discardResults) results.push(...(chunkResults as readonly unknown[]));
      } catch (error) {
        if (!hasError) { hasError = true; firstError = error; }
      }
    };

    const flush = async (): Promise<void> => {
      if (buffer.length === 0) return;
      if (inFlight.length >= SqliteWorkerAdapter.IN_FLIGHT_CHUNK_CAP) await drainOldest();
      // Once a failure is known, sending further chunks would only add more
      // guaranteed-`transaction_not_open` replies to absorb -- skip it, but
      // still reset the buffer below so the caller's iteration (which stops
      // at its next `hasError` check) doesn't re-flush the same commands.
      if (!hasError) send(buffer);
      buffer = [];
      bufferedParams = 0;
    };

    await this.request({ kind: "batch_open", txn });
    let committed = false;
    try {
      for await (const command of commands) {
        if (hasError) break;
        // Reject BEFORE this (or any later) command's chunk is ever sent to
        // the worker: a `get`/`all` command under `discard_results` would
        // silently drop the exact rows the caller asked for -- see
        // `TransactionChunkedOptions.discard_results`'s doc comment. Checked
        // per command, not once over a materialized array, so a streaming
        // (`AsyncIterable`) command source fails fast on the offending
        // command instead of after consuming the whole stream.
        if (discardResults && !DISCARD_ALLOWED_KINDS.has(command.kind)) {
          throw new TypeError(`transactionChunked({ discard_results: true }) does not support "${command.kind}" commands (only run/run_batch/exec/transaction_checkpoint/assert_transaction_changes/fault may be discarded).`);
        }
        buffer.push(command);
        // `run_batch`'s weight is its flat params array, not a per-command
        // constant of 1 -- a single `run_batch` can carry as many params as
        // hundreds of individual `run` commands, so it must count the same
        // toward this budget as those `run` commands would have.
        bufferedParams += "params" in command && Array.isArray(command.params) ? command.params.length
          : "params_flat" in command && Array.isArray(command.params_flat) ? command.params_flat.length : 0;
        // Flush on COMMAND count or accumulated PARAM count, whichever trips
        // first. Command count alone is the wrong weight once multi-row
        // publication INSERTs exist (publication-authority.ts's
        // PUBLICATION_INSERT_BATCH_ROWS): one such command carries ~8000
        // params, so 2000-command chunks ballooned to hundreds of thousands
        // of params each -- measured 46s of postMessage stalls (vs 0.8s) on
        // the 981-file bench, dominated by structured-clone/transfer-list
        // work scaling superlinearly with per-message size. The param bound
        // restores the pre-batching per-chunk data volume (~2000 commands x
        // ~14 params) regardless of how heavy individual commands are.
        if (buffer.length >= chunkSize || bufferedParams >= SqliteWorkerAdapter.PARAMS_PER_CHUNK) await flush();
      }
      if (!hasError) await flush();
      while (inFlight.length > 0) await drainOldest();
      if (hasError) throw firstError;
      await this.request({ kind: "batch_commit", txn });
      committed = true;
    } finally {
      if (!committed) {
        try { await this.request({ kind: "batch_rollback", txn }); } catch { /* Best-effort: the worker already rolled back on the originating error. */ }
      }
    }
    return results;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.request({ kind: "close" });
    await this.worker.terminate();
  }

  private request<T>(message: Record<string, unknown>): Promise<T> {
    return this.requestWithId<T>(this.nextId++, message);
  }

  private requestWithId<T>(id: number, message: Record<string, unknown>, transferList?: readonly ArrayBuffer[]): Promise<T> {
    if (this.closed && message["kind"] !== "close") return Promise.reject(new StorageError("storage:sqlite_closed", "The SQLite database is closed."));
    // The synchronous `postMessage` call below is where the structured-clone
    // serialization of the message happens; bucketing it (batch_chunk only)
    // separates main-thread clone cost from worker-side execution wait.
    if (message["kind"] === "batch_chunk") return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      timedSync("sql_chunk_post_message", () => this.worker.postMessage({ ...message, id }, transferList as ArrayBuffer[] | undefined));
    });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      if (transferList && transferList.length > 0) this.worker.postMessage({ ...message, id }, transferList as ArrayBuffer[]);
      else this.worker.postMessage({ ...message, id });
    });
  }

  private handleMessage(message: WorkerMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.kind === "error" && message.error) {
      pending.reject(new StorageError(message.error.code ?? "storage:sqlite_error", message.error.message, message.error.details));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectPending(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

export const openSqliteDatabase = SqliteWorkerAdapter.open;
