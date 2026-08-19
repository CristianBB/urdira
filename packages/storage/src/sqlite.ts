import { Worker } from "node:worker_threads";
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
  | { readonly kind: "get"; readonly sql: string; readonly params?: readonly SqliteValue[] }
  | { readonly kind: "all"; readonly sql: string; readonly params?: readonly SqliteValue[] }
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
   * ONLY valid for command streams containing exclusively `run`, `exec`,
   * `transaction_checkpoint`, `assert_transaction_changes`, and `fault`
   * commands: a `get`/`all` command is meaningless to discard (its whole
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
   * per-command result construction/shipping entirely (only `run`/`exec`/
   * `transaction_checkpoint`/`assert_transaction_changes`/`fault` command
   * streams may use it -- see {@link TransactionChunkedOptions}), in which
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
  // Opt-in wall-clock split between statement preparation and statement
  // execution, gated the same way as \`packages/storage/src/debug-timing.ts\`
  // (\`URDIRA_STORAGE_DEBUG_TIMING=1\`, threaded through explicitly via
  // \`workerData\` since a worker thread's \`process.env\` is a snapshot taken
  // at worker creation, not a live view of the parent's environment).
  // \`console.error\` in a worker thread is piped to the parent process's
  // stderr by default (no \`stderr: true\` needed), matching this codebase's
  // existing \`[urdira] ...\` stderr-diagnostic convention.
  const DEBUG_TIMING = Boolean(workerData.debugTiming);
  let prepareMs = 0;
  let prepareCount = 0;
  let execMs = 0;
  let execCount = 0;
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

  function logDebugTimingsIfEnabled(label) {
    if (!DEBUG_TIMING) return;
    console.error("[urdira] storage timings sqlite_worker " + label + " prepare_ms=" + Math.round(prepareMs) + " prepare_count=" + prepareCount + " exec_ms=" + Math.round(execMs) + " exec_count=" + execCount + " cache_size=" + statementCache.size);
    prepareMs = 0; prepareCount = 0; execMs = 0; execCount = 0;
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
  function runStatement(command, statement, params, discard) {
    if (command.kind === "run") {
      const result = statement.run(...params);
      if (discard) return Number(result.changes);
      return {
        changes: Number(result.changes),
        last_insert_rowid: typeof result.lastInsertRowid === "bigint" ? result.lastInsertRowid.toString() : Number(result.lastInsertRowid),
      };
    }
    if (command.kind === "get") return discard ? null : (statement.get(...params) ?? null);
    return discard ? null : statement.all(...params);
  }

  function execute(command, sqls, discard) {
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
    const statement = prepareCached(resolveSql(command, sqls));
    const params = command.params ?? [];
    if (!DEBUG_TIMING) return runStatement(command, statement, params, discard);
    const startedAt = performance.now();
    try {
      return runStatement(command, statement, params, discard);
    } finally {
      execMs += performance.now() - startedAt; execCount += 1;
    }
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
        try {
          // \`message.discard\` (see \`TransactionChunkedOptions.discard_results\`):
          // a plain \`for\` loop instead of \`.map\` -- there is no per-command
          // return value worth collecting into an array (\`runChunkCommand\`
          // always returns \`undefined\` in this mode) -- and the reply carries
          // just the command count, a number, so there is nothing for
          // \`postMessage\` to structured-clone beyond one scalar.
          if (message.discard) {
            for (const command of message.commands) runChunkCommand(command, activeTransaction, message.sqls, true);
            port.postMessage({ id: message.id, kind: "result", result: message.commands.length });
          } else {
            const results = message.commands.map((command) => runChunkCommand(command, activeTransaction, message.sqls));
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
        logDebugTimingsIfEnabled("batch_commit");
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
            return result;
          });
          database.exec("COMMIT;");
          logDebugTimingsIfEnabled("batch");
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
 * Collects the distinct `ArrayBuffer`s backing `commands`' `Uint8Array`
 * params that are safe to hand to `postMessage`'s transfer list -- see
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
  for (const command of commands) {
    const params = (command as { readonly params?: readonly SqliteValue[] }).params;
    if (!params) continue;
    for (const param of params) {
      if (!(param instanceof Uint8Array)) continue;
      const buffer = param.buffer;
      if (!(buffer instanceof ArrayBuffer)) continue; // Excludes SharedArrayBuffer views.
      if (param.byteOffset !== 0 || param.byteLength !== buffer.byteLength) continue;
      buffers.add(buffer);
    }
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
 */
const DISCARD_ALLOWED_KINDS: ReadonlySet<SqliteCommand["kind"]> = new Set(["run", "exec", "transaction_checkpoint", "fault", "assert_transaction_changes"]);

function dedupCommandSqls(commands: readonly SqliteCommand[]): { readonly sqls: readonly string[]; readonly commands: readonly unknown[] } {
  const sqls: string[] = [];
  const indexBySql = new Map<string, number>();
  const rewritten = commands.map((command) => {
    if (command.kind !== "run" && command.kind !== "get" && command.kind !== "all" && command.kind !== "exec") return command;
    let index = indexBySql.get(command.sql);
    if (index === undefined) {
      index = sqls.length;
      sqls.push(command.sql);
      indexBySql.set(command.sql, index);
    }
    return command.kind === "exec" ? { kind: command.kind, s: index } : { kind: command.kind, s: index, params: command.params };
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
          throw new TypeError(`transactionChunked({ discard_results: true }) does not support "${command.kind}" commands (only run/exec/transaction_checkpoint/assert_transaction_changes/fault may be discarded).`);
        }
        buffer.push(command);
        bufferedParams += "params" in command && Array.isArray(command.params) ? command.params.length : 0;
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
