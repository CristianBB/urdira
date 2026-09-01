import { access, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalBytes, decodeCanonical, digestBytes, encodeCanonical } from "@urdira/canonical";
import type { ModelPackInstallation, Workspace, WorkspaceCurrentState, Snapshot, IndexCandidate, RegistrySnapshot, PluginResolutionLock, WorkspaceConfigurationRevision, WorkspaceFreshnessCheckpoint } from "@urdira/contracts";
import { BlobStore, CAS_LAYOUT_MARKER_FILENAME, CAS_LAYOUT_VERSION, ContentAddressedStore, writeCasLayoutMarker, type BlobReference } from "./cas.js";
import { record, resetTimings, snapshotTimings, timed, timedSync, timingEnabled } from "./debug-timing.js";
import { StorageError } from "./errors.js";
import { CATALOG_SCHEMA, ensureCatalogSchemaCompatibility, ensureWorkspaceSchemaCompatibility, initializeSchema } from "./schema.js";
import { WORKSPACE_V3_SCHEMA } from "./workspace-v3-sql.js";
import { createWorkspaceRepositories, type WorkspaceRepositories } from "./repositories.js";
import { openSqliteDatabase, type SqliteCommand, type SqliteDatabase, type SqliteValue } from "./sqlite.js";
import { noFaults, type FaultBoundary, type FaultInjector } from "./faults.js";
import { WorkspaceProjectionRepository } from "./projections.js";
import { StorageMaintenance, WorkspaceLifecycleRepository } from "./lifecycle.js";
import { WorkspaceSourceIndexRepository, type SourceIndexCommitInput, type SourceIndexContentInput, type SourceIndexContentStreamInput } from "./source-index.js";
import { WorkspaceCandidateRepository, frozenCandidateBaseTupleDigest, normalizeObservationBatchIds, sameFrozenCandidateBaseTuple, type CandidatePublicationInput, type CandidatePublicationResult } from "./candidates.js";
import { buildCandidatePublicationPlan, buildCompatibilityPublicationPlan, buildPublicationTransactionCommands, publicationTransactionCommands, type ProjectionSetDigestCorpusEntry, type RecordSetDigestCorpusEntry } from "./publication-authority.js";
import { WorkspaceProjectionOccurrenceRepository } from "./projection-occurrences.js";
import { ByteBoundaryTelemetry } from "./byte-telemetry.js";

export interface DurableStorageOptions {
  readonly rootDir: string;
  readonly inlineThresholdBytes?: number;
  /** Maximum concurrent CAS blob writes (default 16). */
  readonly cas_put_concurrency?: number;
  readonly busyTimeoutMs?: number;
  readonly fault_injector?: FaultInjector;
  /**
   * Skips the full-installation startup recovery sweep `open` otherwise
   * always runs: `catalog.recoverRelocations`/`catalog.recoverGcBarriers`,
   * then `recoverMigrations`/`recoverWorkspaceGcEpochs` -- both of which open
   * and close EVERY registered workspace's database sequentially, purely to
   * check for (rare) crash leftovers. That sweep is safe to skip ONLY when
   * the caller is a short-lived, single-workspace `DurableStorage` opened
   * from inside a worker thread spawned by an already-running, long-lived
   * daemon process (see `packages/daemon/src/lexical-worker-thread.ts`):
   * that parent process already ran this exact sweep once at its own
   * `DurableStorage.open`, and stays alive -- with its own already-recovered
   * catalog/workspace state -- for this worker's entire lifetime, so nothing
   * this sweep would find is ever new by the time a worker spins up. Any
   * other caller (in particular, anything that might be the FIRST
   * `DurableStorage` opened after a real process restart) MUST leave this
   * unset (the default, `false`) or crash-recovery invariants silently stop
   * being enforced.
   */
  readonly skip_startup_recovery?: boolean;
}

export interface RegisteredWorkspace extends Workspace {
  readonly database_path: string;
}

export interface SqliteCapabilities {
  readonly node_sqlite: boolean;
  readonly wal: boolean;
  readonly full_synchronous: boolean;
  readonly foreign_keys: boolean;
  readonly strict_tables: boolean;
  readonly defensive_mode: boolean;
  readonly trusted_schema_disabled: boolean;
  readonly worker_thread: boolean;
  readonly serialized_writers: boolean;
}

export const sqliteCapabilities: SqliteCapabilities = {
  node_sqlite: true,
  wal: true,
  full_synchronous: true,
  foreign_keys: true,
  strict_tables: true,
  defensive_mode: true,
  trusted_schema_disabled: true,
  worker_thread: true,
  serialized_writers: true,
};

export class SerializedWriter {
  private readonly foreground: Array<{ readonly operation: () => Promise<unknown>; readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }> = [];
  private readonly background: Array<{ readonly operation: () => Promise<unknown>; readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }> = [];
  private running = false;

  constructor(private readonly lockPath?: string) {}

  /**
   * Serializes writes while giving foreground publication/manifest work strict
   * admission priority over background projections. A background transaction
   * already in progress is allowed to finish atomically; the next queued
   * operation is always selected from the foreground lane first.
   */
  run<T>(operation: () => Promise<T>, lane: "foreground" | "background" = "foreground"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry = {
        operation: (async () => {
          // Background reclamation is already ordered behind foreground
          // publication by this writer; it must not add a filesystem-lock
          // round-trip per cleanup batch or delay the caller's post-commit
          // staging reclamation.
          const lock = this.lockPath === undefined || lane === "background" ? undefined : await acquireWorkspaceMutationLock(this.lockPath);
          try {
            return await operation();
          } finally {
            if (lock !== undefined) await lock.release();
          }
        }) as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      (lane === "background" ? this.background : this.foreground).push(entry);
      this.pump();
    });
  }

  private pump(): void {
    if (this.running) return;
    const entry = this.foreground.shift() ?? this.background.shift();
    if (entry === undefined) return;
    this.running = true;
    Promise.resolve().then(entry.operation).then(entry.resolve, entry.reject).finally(() => {
      this.running = false;
      this.pump();
    });
  }
}

interface WorkspaceMutationLock {
  release(): Promise<void>;
}

// How long a foreground SQLite mutation waits for the cross-process writer
// lock before giving up. Detached Rust lexical maintenance
// (`reconcile_lexical`, `crates/urdira-indexing-core/src/lib.rs`) now
// releases and reacquires this same lease between bounded ~512-document
// chunks instead of holding it for one multi-minute transaction (see that
// function's doc comment), so the lock is never held longer than one
// chunk's read+hash+FTS-insert work -- empirically a few seconds even for a
// 14k-document cold corpus, not minutes. 20s keeps a wide safety margin over
// that per-chunk hold time while still failing fast into a typed, retryable
// error (`WORKSPACE_WRITER_BUSY_CODE` below) instead of hanging on the raw
// filesystem `EEXIST`; `packages/daemon/src/runtime.ts` retries that error a
// bounded number of times with a short delay (see its `WORKSPACE_WRITER_BUSY`
// handling next to the `core:source_changed` retry).
const WORKSPACE_WRITER_LOCK_WAIT_MS = 20_000;

/**
 * Stable error code for a foreground SQLite mutation that could not acquire
 * the cross-process writer lock within `WORKSPACE_WRITER_LOCK_WAIT_MS`. This
 * is deliberately NOT registered in `docs/protocol/core-operation-error-codes.md`:
 * that registry is the closed, externally documented contract for the public
 * query API's `OperationErrorCodeDefinition` values (see its "Registry
 * contract" section), while this code never reaches a query client -- it is
 * an internal daemon scan-scheduling signal consumed only by
 * `scanFailureErrorCode`/the scan retry path in `packages/daemon/src/runtime.ts`.
 * The `storage:` prefix and shape otherwise match every other internal code
 * this module throws (e.g. `storage:schema_migration_failed` above).
 */
export const WORKSPACE_WRITER_BUSY_CODE = "storage:workspace_writer_busy";

/**
 * Cross-process companion to the Rust indexing-core writer lease. The lock is
 * deliberately acquired only when a queued SQLite mutation starts, so reads
 * and queue wait do not pay for filesystem coordination. Rust releases the
 * same marker while the application persists candidate metadata and reacquires
 * it for final structural publication.
 */
async function acquireWorkspaceMutationLock(lockPath: string): Promise<WorkspaceMutationLock> {
  const deadline = Date.now() + WORKSPACE_WRITER_LOCK_WAIT_MS;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (handle === undefined) {
    try {
      handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        await rm(lockPath, { force: true });
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        // The lease is still held by another writer (most commonly detached
        // lexical maintenance mid-chunk, see the constant doc comment
        // above). This is a normal, expected race -- not corruption or a
        // stuck process -- so surface a typed, retryable code instead of the
        // raw `EEXIST`, and let the caller decide whether/how to retry
        // rather than throwing an opaque filesystem error up the stack.
        throw new StorageError(WORKSPACE_WRITER_BUSY_CODE, `Workspace writer lock at ${lockPath} is still held after ${WORKSPACE_WRITER_LOCK_WAIT_MS}ms; the current writer is expected to release it shortly.`, { lock_path: lockPath, waited_ms: Date.now() - (deadline - WORKSPACE_WRITER_LOCK_WAIT_MS) });
      }
      // A crashed Rust/Node worker can leave the marker behind. Recover only
      // when its recorded owner PID is definitely gone; an empty or malformed
      // marker is treated as live to avoid deleting a lock during creation.
      const ownerAlive = await workspaceMutationOwnerAlive(lockPath);
      if (ownerAlive === false) {
        await rm(lockPath, { force: true });
        continue;
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  return {
    release: async () => {
      await handle?.close();
      await rm(lockPath, { force: true });
    },
  };
}

/** Acquire more than one workspace pathname in a stable order for moves. */
async function acquireWorkspaceMutationLocks(lockPaths: readonly string[]): Promise<WorkspaceMutationLock> {
  const locks: WorkspaceMutationLock[] = [];
  let released = false;
  try {
    for (const lockPath of [...new Set(lockPaths.map((path) => resolve(path)))].sort()) locks.push(await acquireWorkspaceMutationLock(lockPath));
  } catch (error) {
    for (const lock of locks.reverse()) await lock.release().catch(() => undefined);
    throw error;
  }
  return {
    release: async () => {
      if (released) return;
      released = true;
      for (const lock of [...locks].reverse()) await lock.release();
    },
  };
}

async function workspaceMutationOwnerAlive(lockPath: string): Promise<boolean | undefined> {
  const ownerText = await readFile(lockPath, "utf8").catch(() => "");
  const ownerPid = Number.parseInt(ownerText.trim(), 10);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return undefined;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : true;
  }
}

const workspaceWriters = new Map<string, SerializedWriter>();
const workspaceHandleCounts = new Map<string, number>();
// Warm digest corpora (`RecordSetDigestCorpusEntry`, `publication-authority.ts`),
// keyed by resolved database filename EXACTLY like `workspaceWriters` above and
// with the same process lifetime, because handle lifetime is the wrong scope:
// the daemon opens a fresh `WorkspaceDatabase` handle per scan
// (`DurableStorage.openWorkspace` constructs a new instance every call), so a
// handle-private corpus would die between the publish that built it and the
// next publish that wants it -- observed live as zero corpus hits across an
// entire edit-rescan bench. Sharing per filename is safe because every entry
// is `(workspaceId, generation)`-keyed and `computeSnapshotDigestFields` only
// trusts an entry whose generation equals the publish's own `oldGeneration`;
// any out-of-band generation advance (another process, another storage
// instance, a fork) simply misses and falls back to the SQL read. RAM is
// bounded by "one sorted (record_id, record_digest) array per workspace ever
// opened by this process" -- the same order as the per-workspace state
// `workspaceWriters` itself already retains.
const workspaceDigestCorpora = new Map<string, RecordSetDigestCorpusEntry>();
// Warm projection-set digest corpora (`ProjectionSetDigestCorpusEntry`,
// `publication-authority.ts`) -- same per-database-filename, process-lifetime
// scope as `workspaceDigestCorpora` above, and for the identical reason
// (`DurableStorage.openWorkspace` hands out a fresh `WorkspaceDatabase` per
// scan, so a handle-private map would never survive from the publish that
// built it to the next publish that wants it). A separate map, not folded
// into `workspaceDigestCorpora`'s entry shape, because the two corpora have
// independent staleness keys in principle (both happen to key off the same
// `(workspaceId, generation)` today, but nothing requires that to stay true)
// and independent kill-switch-free failure modes: either map missing an
// entry, or holding one for the wrong generation, only ever costs that one
// corpus's SQL read, never the other's.
const workspaceProjectionDigestCorpora = new Map<string, ProjectionSetDigestCorpusEntry>();

function workspaceWriter(filename: string): SerializedWriter {
  const key = resolve(filename);
  let writer = workspaceWriters.get(key);
  if (!writer) {
    writer = new SerializedWriter(`${resolve(filename)}.urdira-writer.lock`);
    workspaceWriters.set(key, writer);
  }
  return writer;
}

function incrementWorkspaceHandle(filename: string): void {
  const key = resolve(filename);
  workspaceHandleCounts.set(key, (workspaceHandleCounts.get(key) ?? 0) + 1);
}

function decrementWorkspaceHandle(filename: string): void {
  const key = resolve(filename);
  const count = (workspaceHandleCounts.get(key) ?? 1) - 1;
  if (count <= 0) workspaceHandleCounts.delete(key);
  else workspaceHandleCounts.set(key, count);
}

function workspaceHasOpenHandles(filename: string): boolean {
  return (workspaceHandleCounts.get(resolve(filename)) ?? 0) > 0;
}

function forgetWorkspaceDatabase(filename: string): void {
  const key = resolve(filename);
  if (workspaceHasOpenHandles(key)) return;
  workspaceWriters.delete(key);
  workspaceDigestCorpora.delete(key);
  workspaceProjectionDigestCorpora.delete(key);
}

async function removeWorkspaceDatabaseFiles(filename: string): Promise<void> {
  // SQLite may leave WAL/SHM or rollback-journal sidecars behind even after
  // the last connection closes.  Remove only the exact catalogued database
  // and its exact SQLite sidecars; never recurse over the workspace root.
  for (const suffix of ["", "-wal", "-shm", "-journal"] as const) await rm(`${filename}${suffix}`, { force: true });
}

interface WorkspaceRegistrationRow extends Record<string, unknown> {
  readonly workspace_id: string;
  readonly canonical_root: string;
  readonly display_root: string;
  readonly status: "registered" | "removed";
  readonly source_provider_bindings: string;
  readonly database_path: string;
  readonly registered_at: string;
  readonly removed_at: string | null;
}

export class SerializedSqliteDatabase implements SqliteDatabase {
  readonly filename: string;
  private closed = false;

  constructor(private readonly inner: SqliteDatabase, private readonly writer: SerializedWriter = new SerializedWriter()) {
    this.filename = inner.filename;
  }

  private laneForSql(sql: string): "foreground" | "background" {
    return /\b(?:vector_projection_rows|vector_shards|semantic_index_state)\b/iu.test(sql) ? "background" : "foreground";
  }
  async exec(sql: string): Promise<void> { await this.writer.run(() => this.inner.exec(sql), this.laneForSql(sql)); }
  async run(sql: string, params?: readonly SqliteValue[]): Promise<Awaited<ReturnType<SqliteDatabase["run"]>>> { return await this.writer.run(() => this.inner.run(sql, params), this.laneForSql(sql)); }
  async get<T extends Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]): Promise<T | undefined> { return await this.inner.get<T>(sql, params); }
  async all<T extends Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]): Promise<readonly T[]> { return await this.inner.all<T>(sql, params); }
  async transaction(commands: Parameters<SqliteDatabase["transaction"]>[0]): Promise<readonly unknown[]> {
    const lane = commands.some((command) => "sql" in command && this.laneForSql(command.sql) === "background") ? "background" : "foreground";
    return await this.writer.run(() => this.inner.transaction(commands), lane);
  }
  async transactionChunked(commands: Parameters<SqliteDatabase["transactionChunked"]>[0], chunkSize?: number, options?: Parameters<SqliteDatabase["transactionChunked"]>[2]): Promise<readonly unknown[]> { return await this.writer.run(() => this.inner.transactionChunked(commands, chunkSize, options)); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Closing a handle is not a database mutation and must not wait for a
    // Rust writer marker held by a sibling worker thread during its final
    // acknowledgement.
    await this.writer.run(() => this.inner.close(), "background");
  }
}

// Rows per batched existence-check / multi-row INSERT statement in
// `InstallationCatalog.recordCasObjectsBatch`: comfortably under SQLite's
// bound-parameter cap at up to 6 params/row, and large enough that one scan's
// whole new-blob set typically needs a single batch.
const CAS_METADATA_BATCH_ROWS = 500;

export class InstallationCatalog {
  readonly database: SqliteDatabase;
  private readonly rootDir: string;
  private readonly busyTimeoutMs: number;
  private readonly writer: SerializedWriter;

  constructor(database: SqliteDatabase, rootDir: string, busyTimeoutMs: number) {
    this.database = database;
    this.rootDir = rootDir;
    this.busyTimeoutMs = busyTimeoutMs;
    this.writer = workspaceWriter(database.filename);
  }

  async registerWorkspace(workspace: Workspace, databasePath = this.defaultWorkspacePath(workspace.workspace_id)): Promise<RegisteredWorkspace> {
    return await this.writer.run(() => this.registerWorkspaceSerialized(workspace, databasePath));
  }

  async markWorkspaceRemoved(workspace: Workspace): Promise<boolean> {
    return await this.writer.run(async () => {
      const existing = await this.getWorkspaceRegistration(workspace.workspace_id);
      if (!existing) return false;
      if (existing.removed_at !== null) return true;
      if (existing.canonical_root !== workspace.canonical_root || existing.registered_at !== workspace.registered_at) {
        throw new StorageError("storage:immutable_workspace", `Workspace ${workspace.workspace_id} has immutable identity fields that conflict.`);
      }
      const removedAt = workspace.removed_at ?? new Date().toISOString();
      const closed = await this.database.run(
        "UPDATE installation_workspaces SET removed_at = ?, status = 'removed' WHERE workspace_id = ? AND removed_at IS NULL AND canonical_root = ? AND registered_at = ?",
        [removedAt, workspace.workspace_id, existing.canonical_root, existing.registered_at],
      );
      if (closed.changes !== 1) {
        const raced = await this.getWorkspaceRegistration(workspace.workspace_id);
        if (!raced || raced.removed_at === null) throw new StorageError("storage:workspace_registration_conflict", `Workspace ${workspace.workspace_id} changed while its removal transition was being applied.`);
      }
      return true;
    });
  }

  private async registerWorkspaceSerialized(workspace: Workspace, databasePath: string): Promise<RegisteredWorkspace> {
    const absolutePath = resolve(databasePath);
    const existing = await this.getWorkspaceRegistration(workspace.workspace_id);
    if (existing) return await this.resolveWorkspaceRegistration(workspace, absolutePath, existing);
    await mkdir(dirname(absolutePath), { recursive: true });
    // Registration stamps and mutates the workspace database before the
    // catalog row exists. Use the same marker as the Rust writer so a new
    // composition generation cannot race schema/identity initialization.
    const mutationLock = await acquireWorkspaceMutationLock(`${absolutePath}.urdira-writer.lock`);
    let workspaceDatabase: SqliteDatabase | undefined;
    try {
      workspaceDatabase = await openSqliteDatabase({ filename: absolutePath, busy_timeout_ms: this.busyTimeoutMs });
      await initializeSchema(workspaceDatabase, WORKSPACE_V3_SCHEMA);
      await ensureWorkspaceSchemaCompatibility(workspaceDatabase);
      await stampIdentityFormat(workspaceDatabase);
    } finally {
      try { await workspaceDatabase?.close(); } finally { await mutationLock.release(); }
    }
    const inserted = await this.database.run(
      `INSERT INTO installation_workspaces (workspace_id, canonical_root, display_root, status, source_provider_bindings, database_path, registered_at, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO NOTHING`,
      [workspace.workspace_id, workspace.canonical_root, workspace.display_root, workspace.status, JSON.stringify(workspace.source_provider_bindings), absolutePath, workspace.registered_at, workspace.removed_at ?? null],
    );
    if (inserted.changes !== 1) {
      const raced = await this.getWorkspaceRegistration(workspace.workspace_id);
      if (!raced) throw new StorageError("storage:workspace_registration_conflict", `Workspace ${workspace.workspace_id} lost an atomic registration race.`);
      return await this.resolveWorkspaceRegistration(workspace, absolutePath, raced);
    }
    return { ...workspace, database_path: absolutePath };
  }

  private async getWorkspaceRegistration(workspaceId: string): Promise<WorkspaceRegistrationRow | undefined> {
    return await this.database.get<WorkspaceRegistrationRow>("SELECT workspace_id, canonical_root, display_root, status, source_provider_bindings, database_path, registered_at, removed_at FROM installation_workspaces WHERE workspace_id = ?", [workspaceId]);
  }

  private async resolveWorkspaceRegistration(workspace: Workspace, absolutePath: string, existing: WorkspaceRegistrationRow): Promise<RegisteredWorkspace> {
    if (existing.database_path !== absolutePath) throw new StorageError("storage:immutable_workspace", `Workspace ${workspace.workspace_id} database path is immutable; use relocation.`);
    if (existing.removed_at !== null) throw new StorageError("storage:workspace_lifecycle", `Workspace ${workspace.workspace_id} is removed and cannot be reopened.`);
    if (!isAbsolute(existing.display_root)
      && workspace.canonical_root === existing.canonical_root
      && workspace.display_root === workspace.canonical_root) {
      const upgraded = await this.database.run(
        `UPDATE installation_workspaces SET display_root = ?
         WHERE workspace_id = ? AND canonical_root = ? AND display_root = ? AND database_path = ?
           AND registered_at = ? AND removed_at IS NULL`,
        [workspace.display_root, workspace.workspace_id, existing.canonical_root, existing.display_root, existing.database_path, existing.registered_at],
      );
      if (upgraded.changes === 1) existing = { ...existing, display_root: workspace.display_root };
      else {
        const raced = await this.getWorkspaceRegistration(workspace.workspace_id);
        if (!raced) throw new StorageError("storage:workspace_registration_conflict", `Workspace ${workspace.workspace_id} changed while its legacy display root was being upgraded.`);
        existing = raced;
      }
    }
    if (existing.canonical_root !== workspace.canonical_root || existing.display_root !== workspace.display_root
      || existing.registered_at !== workspace.registered_at || existing.source_provider_bindings !== JSON.stringify(workspace.source_provider_bindings)) {
      throw new StorageError("storage:immutable_workspace", `Workspace ${workspace.workspace_id} has immutable identity fields that conflict.`);
    }
    if (workspace.status === "registered" && workspace.removed_at === undefined) return { ...workspace, database_path: absolutePath };
    if (workspace.removed_at === undefined || workspace.status !== "removed") throw new StorageError("storage:immutable_workspace", `Workspace ${workspace.workspace_id} can only change through its one-way removal transition.`);
    const closed = await this.database.run(
      `UPDATE installation_workspaces SET removed_at = ?, status = 'removed'
       WHERE workspace_id = ? AND canonical_root = ? AND display_root = ? AND database_path = ?
         AND registered_at = ? AND removed_at IS NULL AND status = 'registered'`,
      [workspace.removed_at, workspace.workspace_id, existing.canonical_root, existing.display_root, existing.database_path, existing.registered_at],
    );
    if (closed.changes === 1) return { ...workspace, database_path: absolutePath };
    const raced = await this.getWorkspaceRegistration(workspace.workspace_id);
    if (raced && raced.removed_at !== null && raced.status === "removed") return { ...workspace, database_path: absolutePath };
    throw new StorageError("storage:workspace_registration_conflict", `Workspace ${workspace.workspace_id} changed while its lifecycle transition was being applied.`);
  }

  async getWorkspace(workspaceId: string): Promise<RegisteredWorkspace | undefined> {
    const row = await this.database.get<WorkspaceRegistrationRow>("SELECT workspace_id, canonical_root, display_root, status, source_provider_bindings, database_path, registered_at, removed_at FROM installation_workspaces WHERE workspace_id = ? AND removed_at IS NULL", [workspaceId]);
    if (!row) return undefined;
    return { workspace_id: row.workspace_id, canonical_root: row.canonical_root, display_root: row.display_root, status: row.status, source_provider_bindings: JSON.parse(row.source_provider_bindings), registered_at: row.registered_at, ...(row.removed_at === null ? {} : { removed_at: row.removed_at }), database_path: row.database_path } as RegisteredWorkspace;
  }

  async listWorkspaces(): Promise<readonly RegisteredWorkspace[]> {
    const rows = await this.database.all<WorkspaceRegistrationRow>("SELECT workspace_id, canonical_root, display_root, status, source_provider_bindings, database_path, registered_at, removed_at FROM installation_workspaces WHERE removed_at IS NULL ORDER BY workspace_id");
    return rows.map((row) => ({ workspace_id: row.workspace_id, canonical_root: row.canonical_root, display_root: row.display_root, status: row.status, source_provider_bindings: JSON.parse(row.source_provider_bindings), registered_at: row.registered_at, ...(row.removed_at === null ? {} : { removed_at: row.removed_at }), database_path: row.database_path } as RegisteredWorkspace));
  }

  /**
   * A purge is a relational deletion as well as a filesystem deletion.  Keep
   * the CAS collector's global reachability model intact by refusing to remove
   * a workspace database while any durable reference can still need rows from
   * it.  `force` therefore bypasses only the recovery grace period; it never
   * bypasses these reference checks.
   */
  private async workspacePurgeReferences(registration: WorkspaceRegistrationRow, now: string): Promise<readonly string[]> {
    const reasons: string[] = [];
    const snapshotIds = new Set<string>();
    if (await pathExists(registration.database_path)) {
      const workspaceDatabase = await openSqliteDatabase({ filename: registration.database_path, read_only: true });
      try {
        for (const row of await workspaceDatabase.all<{ snapshot_id: string }>("SELECT snapshot_id FROM snapshots WHERE workspace_id = ?", [registration.workspace_id])) snapshotIds.add(row.snapshot_id);
        if (await workspaceDatabase.get("SELECT retention_lease_id FROM retention_leases WHERE workspace_id = ? AND released_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ? LIMIT 1", [registration.workspace_id, now, now])) reasons.push("retention_lease");
        if (await workspaceDatabase.get("SELECT retention_pin_id FROM retention_pins WHERE workspace_id = ? AND released_at IS NULL AND expires_at > ? LIMIT 1", [registration.workspace_id, now])) reasons.push("retention_pin");
        if (await workspaceDatabase.get("SELECT query_execution_id FROM query_executions WHERE workspace_id = ? AND execution_status = 'ready' AND expires_at > ? LIMIT 1", [registration.workspace_id, now])) reasons.push("query_execution");
        if (await workspaceDatabase.get("SELECT backup_id FROM backup_barriers WHERE workspace_id = ? AND state = 'active' LIMIT 1", [registration.workspace_id])) reasons.push("backup_barrier");
        if (await workspaceDatabase.get("SELECT garbage_collection_epoch_id FROM garbage_collection_epochs WHERE workspace_id = ? AND state IN ('marking', 'sweeping') LIMIT 1", [registration.workspace_id])) reasons.push("workspace_gc");
        if (await workspaceDatabase.get("SELECT migration_id FROM storage_migrations WHERE workspace_id = ? AND state NOT IN ('completed', 'failed', 'recovered', 'cancelled') LIMIT 1", [registration.workspace_id])) reasons.push("storage_migration");
        if (await workspaceDatabase.get("SELECT retention_lease_id FROM candidate_retention_leases WHERE workspace_id = ? AND released_at IS NULL LIMIT 1", [registration.workspace_id])) reasons.push("candidate_retention_lease");
        if (await workspaceDatabase.get("SELECT root_id FROM candidate_roots WHERE workspace_id = ? LIMIT 1", [registration.workspace_id])) reasons.push("candidate_root");
        if (await workspaceDatabase.get("SELECT candidate_generation_id FROM candidate_cleanup_markers WHERE candidate_generation_id IN (SELECT candidate_generation_id FROM candidate_state WHERE workspace_id = ?) AND state NOT IN ('completed', 'released', 'deleted', 'cleaned', 'done') LIMIT 1", [registration.workspace_id])) reasons.push("candidate_cleanup");
        if (await workspaceDatabase.get("SELECT candidate_generation_id FROM candidate_state WHERE workspace_id = ? AND state IN ('queued', 'planning', 'analyzing', 'validating', 'projecting', 'ready', 'publishing') LIMIT 1", [registration.workspace_id])) reasons.push("candidate_recovery");
        if (await workspaceDatabase.get("SELECT candidate_generation_id FROM candidate_publication_journal WHERE workspace_id = ? AND status NOT IN ('published', 'completed') LIMIT 1", [registration.workspace_id])) reasons.push("publication_recovery");
      } finally {
        await workspaceDatabase.close();
      }
    }

    // Cross-workspace comparisons bind snapshot ids in the participant
    // workspaces.  The normal path also holds a lease in each participant,
    // but checking the bindings makes purge safe even after a crash or a
    // partially-written comparison record.
    if (snapshotIds.size > 0) {
      const otherWorkspaces = await this.database.all<{ workspace_id: string; database_path: string }>("SELECT workspace_id, database_path FROM installation_workspaces WHERE workspace_id <> ?", [registration.workspace_id]);
      for (const other of otherWorkspaces) {
        if (!(await pathExists(other.database_path))) continue;
        const otherDatabase = await openSqliteDatabase({ filename: other.database_path, read_only: true });
        try {
          const executions = await otherDatabase.all<{ workspace_snapshot_ids: string; execution_status: string; expires_at: string }>("SELECT workspace_snapshot_ids, execution_status, expires_at FROM query_executions WHERE execution_status = 'ready' AND expires_at > ?", [now]);
          for (const execution of executions) {
            let bound: unknown;
            try { bound = JSON.parse(execution.workspace_snapshot_ids); } catch { bound = undefined; }
            if (Array.isArray(bound) && bound.some((value): value is string => typeof value === "string" && snapshotIds.has(value))) { reasons.push("cross_workspace_query_execution"); break; }
          }
          if (reasons.includes("cross_workspace_query_execution")) break;
          const leases = await otherDatabase.all<{ snapshot_id: string }>("SELECT snapshot_id FROM retention_leases WHERE released_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ?", [now, now]);
          if (leases.some((lease) => snapshotIds.has(lease.snapshot_id))) reasons.push("cross_workspace_retention_lease");
          if (reasons.includes("cross_workspace_retention_lease")) break;
          const candidates = await otherDatabase.all<{ base_snapshot_id: string | null; state: string }>("SELECT base_snapshot_id, state FROM candidate_state WHERE state IN ('queued', 'planning', 'analyzing', 'validating', 'projecting', 'ready', 'publishing')");
          if (candidates.some((candidate) => candidate.base_snapshot_id !== null && snapshotIds.has(candidate.base_snapshot_id))) reasons.push("cross_workspace_candidate");
          if (reasons.includes("cross_workspace_candidate")) break;
        } finally {
          await otherDatabase.close();
        }
      }
    }
    return [...new Set(reasons)];
  }

  /**
   * Permanently removes a logically removed workspace after the recovery
   * grace period. The database is deleted before its catalog tombstone so a
   * crash can leave only a retryable tombstone, never an untracked database.
   * Shared CAS objects are intentionally left to the installation-wide GC.
   */
  async purgeWorkspace(workspaceId: string, now = new Date().toISOString(), force = false): Promise<{ readonly workspace_id: string; readonly purged: true; readonly database_path: string }> {
    return await this.writer.run(async () => {
      const registration = await this.getWorkspaceRegistration(workspaceId);
      if (!registration) throw new StorageError("storage:workspace_not_found", `Workspace ${workspaceId} is not registered.`);
      // Purging removes the workspace database and sidecars. Serialize that
      // destructive mutation with Rust publication/reconciliation.
      const mutationLock = await acquireWorkspaceMutationLock(`${resolve(registration.database_path)}.urdira-writer.lock`);
      try {
      if (registration.removed_at === null) throw new StorageError("storage:workspace_lifecycle", `Workspace ${workspaceId} must be removed before it can be purged.`);
      const nowMs = Date.parse(now);
      const removedMs = Date.parse(registration.removed_at);
      if (!Number.isFinite(nowMs) || !Number.isFinite(removedMs)) throw new StorageError("storage:workspace_purge_invalid", `Workspace ${workspaceId} has an invalid removal timestamp.`);
      const graceMs = 24 * 60 * 60 * 1000;
      if (!force && nowMs < removedMs + graceMs) throw new StorageError("storage:workspace_purge_grace", `Workspace ${workspaceId} remains recoverable until ${new Date(removedMs + graceMs).toISOString()}.`);
      await this.pruneWorkspaceLeases(workspaceId);
      if (workspaceHasOpenHandles(registration.database_path) || await this.database.get("SELECT workspace_id FROM installation_workspace_leases WHERE workspace_id = ? LIMIT 1", [workspaceId])) {
        throw new StorageError("storage:workspace_in_use", `Workspace ${workspaceId} has active handles and cannot be purged.`);
      }
      const references = await this.workspacePurgeReferences(registration, now);
      if (references.length > 0) throw new StorageError("storage:workspace_references_active", `Workspace ${workspaceId} still has active durable references: ${references.join(", ")}.`, { references: references.join(",") });
      await removeWorkspaceDatabaseFiles(registration.database_path);
      await this.database.transaction([
        { kind: "run", sql: "DELETE FROM installation_workspace_relocations WHERE workspace_id = ?", params: [workspaceId] },
        { kind: "run", sql: "DELETE FROM installation_workspace_leases WHERE workspace_id = ?", params: [workspaceId] },
        { kind: "run", sql: "DELETE FROM installation_workspaces WHERE workspace_id = ? AND removed_at IS NOT NULL", params: [workspaceId] },
      ]);
      forgetWorkspaceDatabase(registration.database_path);
      return { workspace_id: workspaceId, purged: true as const, database_path: registration.database_path };
      } finally {
        await mutationLock.release();
      }
    });
  }

  async recoverRelocations(): Promise<void> {
    await this.writer.run(async () => {
      const rows = await this.database.all<{
        workspace_id: string;
        owner_pid: number;
        from_path: string;
        to_path: string;
      }>("SELECT workspace_id, owner_pid, from_path, to_path FROM installation_workspace_relocations ORDER BY workspace_id");
      for (const relocation of rows) {
        if (isProcessAlive(relocation.owner_pid)) continue;
        await this.pruneWorkspaceLeases(relocation.workspace_id);
        const registration = await this.getWorkspaceRegistration(relocation.workspace_id);
        if (!registration) throw new StorageError("storage:relocation_recovery_required", `Workspace ${relocation.workspace_id} relocation has no catalog registration.`);
        // Recover against the currently catalogued path while holding the
        // same marker used by Rust. This prevents a restart sweep from
        // renaming or deleting a database during structural publication.
        const mutationLock = await acquireWorkspaceMutationLocks([
          `${resolve(relocation.from_path)}.urdira-writer.lock`,
          `${resolve(relocation.to_path)}.urdira-writer.lock`,
        ]);
        try {
        const fromExists = await pathExists(relocation.from_path);
        const toExists = await pathExists(relocation.to_path);
        if (registration.database_path === relocation.to_path && toExists) {
          await this.database.run("DELETE FROM installation_workspace_relocations WHERE workspace_id = ?", [relocation.workspace_id]);
          continue;
        }
        if (registration.database_path === relocation.from_path && !fromExists && toExists) {
          const updated = await this.database.run("UPDATE installation_workspaces SET database_path = ? WHERE workspace_id = ? AND database_path = ?", [relocation.to_path, relocation.workspace_id, relocation.from_path]);
          if (updated.changes !== 1) throw new StorageError("storage:relocation_recovery_required", `Workspace ${relocation.workspace_id} relocation catalog recovery conflicted.`);
          await this.database.run("DELETE FROM installation_workspace_relocations WHERE workspace_id = ?", [relocation.workspace_id]);
          continue;
        }
        if (registration.database_path === relocation.from_path && fromExists && !toExists) {
          await this.database.run("DELETE FROM installation_workspace_relocations WHERE workspace_id = ?", [relocation.workspace_id]);
          continue;
        }
        if (registration.database_path === relocation.to_path && !toExists && fromExists) {
          const restored = await this.database.run("UPDATE installation_workspaces SET database_path = ? WHERE workspace_id = ? AND database_path = ?", [relocation.from_path, relocation.workspace_id, relocation.to_path]);
          if (restored.changes !== 1) throw new StorageError("storage:relocation_recovery_required", `Workspace ${relocation.workspace_id} relocation restoration conflicted.`);
          await this.database.run("DELETE FROM installation_workspace_relocations WHERE workspace_id = ?", [relocation.workspace_id]);
          continue;
        }
        throw new StorageError("storage:relocation_recovery_required", `Workspace ${relocation.workspace_id} relocation requires administrator recovery.`);
        } finally {
          await mutationLock.release();
        }
      }
    });
  }

  async recoverGcBarriers(): Promise<void> {
    await this.writer.run(async () => {
      await this.database.run("UPDATE installation_gc_barriers SET state = 'completed', completed_at = COALESCE(completed_at, ?) WHERE state IN ('marking', 'sweeping')", [new Date().toISOString()]);
    });
  }

  async acquireWorkspaceLease(workspaceId: string, ownerId: string, ownerPid: number): Promise<void> {
    await this.writer.run(async () => {
      await this.pruneWorkspaceLeases(workspaceId);
      const result = await this.database.run(
        `INSERT INTO installation_workspace_leases (workspace_id, owner_id, owner_pid, lease_kind, handle_count, acquired_at, heartbeat_at)
         SELECT ?, ?, ?, 'handle', 1, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM installation_workspace_leases WHERE workspace_id = ? AND lease_kind = 'relocation')
         ON CONFLICT(workspace_id, owner_id) DO UPDATE SET handle_count = handle_count + 1, heartbeat_at = excluded.heartbeat_at
         WHERE installation_workspace_leases.lease_kind IS 'handle' AND installation_workspace_leases.owner_pid IS excluded.owner_pid`,
        [workspaceId, ownerId, ownerPid, new Date().toISOString(), new Date().toISOString(), workspaceId],
      );
      if (result.changes !== 1) throw new StorageError("storage:workspace_in_use", `Workspace ${workspaceId} is being relocated and cannot be opened.`);
    });
  }

  async releaseWorkspaceLease(workspaceId: string, ownerId: string): Promise<void> {
    await this.writer.run(async () => {
      const deleted = await this.database.run("DELETE FROM installation_workspace_leases WHERE workspace_id = ? AND owner_id = ? AND lease_kind = 'handle' AND handle_count = 1", [workspaceId, ownerId]);
      if (deleted.changes === 0) await this.database.run("UPDATE installation_workspace_leases SET handle_count = handle_count - 1, heartbeat_at = ? WHERE workspace_id = ? AND owner_id = ? AND lease_kind = 'handle' AND handle_count > 1", [new Date().toISOString(), workspaceId, ownerId]);
    });
  }

  private async beginWorkspaceRelocation(workspaceId: string, ownerId: string, ownerPid: number): Promise<void> {
    await this.pruneWorkspaceLeases(workspaceId);
    const timestamp = new Date().toISOString();
    const result = await this.database.run(
      `INSERT INTO installation_workspace_leases (workspace_id, owner_id, owner_pid, lease_kind, handle_count, acquired_at, heartbeat_at)
       SELECT ?, ?, ?, 'relocation', 1, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM installation_workspace_leases WHERE workspace_id = ?)
       ON CONFLICT(workspace_id, owner_id) DO NOTHING`,
      [workspaceId, ownerId, ownerPid, timestamp, timestamp, workspaceId],
    );
    if (result.changes !== 1) throw new StorageError("storage:workspace_in_use", `Workspace ${workspaceId} has active handles or another relocation and cannot be relocated.`);
  }

  private async endWorkspaceRelocation(workspaceId: string, ownerId: string): Promise<void> {
    await this.database.run("DELETE FROM installation_workspace_leases WHERE workspace_id = ? AND owner_id = ? AND lease_kind = 'relocation'", [workspaceId, ownerId]);
  }

  private async pruneWorkspaceLeases(workspaceId: string): Promise<void> {
    const rows = await this.database.all<{ owner_id: string; owner_pid: number }>("SELECT owner_id, owner_pid FROM installation_workspace_leases WHERE workspace_id = ?", [workspaceId]);
    for (const row of rows) if (!isProcessAlive(row.owner_pid)) await this.database.run("DELETE FROM installation_workspace_leases WHERE workspace_id = ? AND owner_id = ?", [workspaceId, row.owner_id]);
  }

  async relocateWorkspace(workspaceId: string, databasePath: string): Promise<void> {
    await this.writer.run(() => this.relocateWorkspaceSerialized(workspaceId, databasePath));
  }

  private async relocateWorkspaceSerialized(workspaceId: string, databasePath: string): Promise<void> {
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace) throw new StorageError("storage:workspace_not_found", `Workspace ${workspaceId} is not registered.`);
    // Relocation changes the workspace database pathname and moves its
    // SQLite files. Hold the shared writer marker for the old path for the
    // entire move so Rust cannot publish while the file is being renamed.
    const destination = resolve(databasePath);
    await mkdir(dirname(destination), { recursive: true });
    const mutationLock = await acquireWorkspaceMutationLocks([
      `${resolve(workspace.database_path)}.urdira-writer.lock`,
      `${destination}.urdira-writer.lock`,
    ]);
    try {
    if (workspaceHasOpenHandles(workspace.database_path)) throw new StorageError("storage:workspace_in_use", `Workspace ${workspaceId} has active database handles and cannot be relocated.`);
    const relocationOwnerId = `relocation:${randomUUID()}`;
    await this.beginWorkspaceRelocation(workspaceId, relocationOwnerId, process.pid);
    try {
      if (destination === resolve(workspace.database_path)) return;
      try {
        await access(destination);
        throw new StorageError("storage:relocation_target_exists", `Workspace relocation target ${destination} already exists.`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const timestamp = new Date().toISOString();
      await this.database.run(
        `INSERT INTO installation_workspace_relocations (workspace_id, owner_id, owner_pid, from_path, to_path, phase, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'planned', ?, ?)`,
        [workspaceId, relocationOwnerId, process.pid, workspace.database_path, destination, timestamp, timestamp],
      );
      await rename(workspace.database_path, destination);
      try {
        await this.database.run("UPDATE installation_workspace_relocations SET phase = 'renamed', updated_at = ? WHERE workspace_id = ? AND owner_id = ?", [new Date().toISOString(), workspaceId, relocationOwnerId]);
        const updated = await this.database.run("UPDATE installation_workspaces SET database_path = ? WHERE workspace_id = ? AND database_path = ?", [destination, workspaceId, workspace.database_path]);
        if (updated.changes !== 1) throw new StorageError("storage:relocation_conflict", `Workspace ${workspaceId} catalog row changed during relocation.`);
        await this.database.run("UPDATE installation_workspace_relocations SET phase = 'catalog_updated', updated_at = ? WHERE workspace_id = ? AND owner_id = ?", [new Date().toISOString(), workspaceId, relocationOwnerId]);
        await this.database.run("DELETE FROM installation_workspace_relocations WHERE workspace_id = ? AND owner_id = ?", [workspaceId, relocationOwnerId]);
      } catch (error) {
        try { await rename(destination, workspace.database_path); } catch (rollbackError) {
          throw new StorageError("storage:relocation_rollback_failed", `Workspace relocation failed and rollback failed.`, { cause: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) });
        }
        await this.database.run("DELETE FROM installation_workspace_relocations WHERE workspace_id = ? AND owner_id = ?", [workspaceId, relocationOwnerId]);
        if (error instanceof StorageError && error.code === "storage:relocation_conflict") throw error;
        throw new StorageError("storage:relocation_failed", `Workspace relocation catalog update failed; filesystem state was rolled back.`, { cause: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      await this.endWorkspaceRelocation(workspaceId, relocationOwnerId);
    }
    } finally {
      await mutationLock.release();
    }
  }

  async putModelPackInstallation(value: ModelPackInstallation): Promise<void> {
    await this.writer.run(() => this.putModelPackInstallationSerialized(value));
  }

  private async putModelPackInstallationSerialized(value: ModelPackInstallation): Promise<void> {
    const existing = await this.database.get<{
      schema_version: number;
      model_pack_id: string;
      model_pack_version: string;
      manifest_digest: string;
      installed_at: string;
      removed_at: string | null;
      removal_reason_code: string | null;
    }>("SELECT schema_version, model_pack_id, model_pack_version, manifest_digest, installed_at, removed_at, removal_reason_code FROM installation_model_pack_installations WHERE model_pack_installation_id = ?", [value.model_pack_installation_id]);
    if (existing) {
      if (existing.removed_at !== null && value.removed_at === undefined) throw new StorageError("storage:model_pack_lifecycle", `Model-pack installation ${value.model_pack_installation_id} is removed and cannot be reopened.`);
      if (existing.schema_version !== value.schema_version || existing.model_pack_id !== value.model_pack_id
        || existing.model_pack_version !== value.model_pack_version || existing.manifest_digest !== value.manifest_digest
        || existing.installed_at !== value.installed_at) {
        throw new StorageError("storage:immutable_model_pack_installation", `Model-pack installation ${value.model_pack_installation_id} has immutable identity fields that conflict.`);
      }
      if (existing.removed_at === null && value.removed_at !== undefined) {
        const closed = await this.database.run(
          `UPDATE installation_model_pack_installations SET removed_at = ?, removal_reason_code = ?
           WHERE model_pack_installation_id = ? AND schema_version = ? AND model_pack_id = ? AND model_pack_version = ?
             AND manifest_digest = ? AND installed_at = ? AND removed_at IS NULL`,
          [value.removed_at, value.removal_reason_code ?? null, value.model_pack_installation_id, existing.schema_version, existing.model_pack_id, existing.model_pack_version, existing.manifest_digest, existing.installed_at],
        );
        if (closed.changes === 1) return;
        const raced = await this.database.get<{ removed_at: string | null }>("SELECT removed_at FROM installation_model_pack_installations WHERE model_pack_installation_id = ?", [value.model_pack_installation_id]);
        if (raced?.removed_at !== null && raced !== undefined) return;
        throw new StorageError("storage:model_pack_installation_conflict", `Model-pack installation ${value.model_pack_installation_id} changed during its lifecycle transition.`);
      }
      throw new StorageError("storage:immutable_model_pack_installation", `Model-pack installation ${value.model_pack_installation_id} is immutable.`);
    }
    const inserted = await this.database.run(
      `INSERT INTO installation_model_pack_installations (model_pack_installation_id, schema_version, model_pack_id, model_pack_version,
       manifest_digest, installed_at, removed_at, removal_reason_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model_pack_installation_id) DO NOTHING`,
      [value.model_pack_installation_id, value.schema_version, value.model_pack_id, value.model_pack_version, value.manifest_digest, value.installed_at, value.removed_at ?? null, value.removal_reason_code ?? null],
    );
    if (inserted.changes !== 1) {
      const raced = await this.database.get<{ model_pack_installation_id: string }>("SELECT model_pack_installation_id FROM installation_model_pack_installations WHERE model_pack_installation_id = ?", [value.model_pack_installation_id]);
      if (raced) return;
      throw new StorageError("storage:model_pack_installation_conflict", `Model-pack installation ${value.model_pack_installation_id} lost an atomic registration race.`);
    }
  }

  async getModelPackInstallation(installationId: string): Promise<ModelPackInstallation | undefined> {
    return await this.database.get<ModelPackInstallation & Record<string, unknown>>("SELECT model_pack_installation_id, schema_version, model_pack_id, model_pack_version, manifest_digest, installed_at, removed_at, removal_reason_code FROM installation_model_pack_installations WHERE model_pack_installation_id = ?", [installationId]);
  }

  async recordCasObject(content: { content_blob_id: string; content_hash: string; byte_length: number; storage_reference: string }, mediaType?: string): Promise<void> {
    await this.writer.run(() => this.recordCasObjectSerialized(content, mediaType));
  }

  private async recordCasObjectSerialized(content: { content_blob_id: string; content_hash: string; byte_length: number; storage_reference: string }, mediaType?: string): Promise<void> {
    await timed("catalog_cas_metadata", () => this.recordCasObjectSerializedTimed(content, mediaType));
  }

  private async recordCasObjectSerializedTimed(content: { content_blob_id: string; content_hash: string; byte_length: number; storage_reference: string }, mediaType?: string): Promise<void> {
    const existing = await this.database.get<{ byte_length: number; media_type: string | null; storage_reference: string }>("SELECT byte_length, media_type, storage_reference FROM installation_cas_objects WHERE content_hash = ?", [content.content_hash]);
    if (existing) {
      if (existing.byte_length !== content.byte_length || existing.storage_reference !== content.storage_reference
        || (mediaType !== undefined && existing.media_type !== mediaType)) {
        throw new StorageError("storage:cas_metadata_conflict", `CAS metadata for ${content.content_hash} is immutable and conflicts with the existing record.`);
      }
      return;
    }
    const inserted = await this.database.run(
      `INSERT INTO installation_cas_objects (content_hash, byte_length, media_type, storage_reference, created_at, last_verified_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(content_hash) DO NOTHING`,
      [content.content_hash, content.byte_length, mediaType ?? null, content.storage_reference, new Date().toISOString(), new Date().toISOString()],
    );
    if (inserted.changes !== 1) {
      const raced = await this.database.get<{ byte_length: number; media_type: string | null; storage_reference: string }>("SELECT byte_length, media_type, storage_reference FROM installation_cas_objects WHERE content_hash = ?", [content.content_hash]);
      if (raced && raced.byte_length === content.byte_length && raced.storage_reference === content.storage_reference && (mediaType === undefined || raced.media_type === mediaType)) return;
      throw new StorageError("storage:cas_metadata_conflict", `CAS metadata for ${content.content_hash} is immutable and conflicts with the existing record.`);
    }
  }

  /**
   * Batched counterpart to `recordCasObject`: `ContentAddressedStore.putMany`
   * (`packages/storage/src/cas.ts`) calls this once per scan-sized batch of
   * newly written blobs instead of once per blob. The single-item version's
   * existence check and insert were each their own autocommit SQLite
   * statement (this catalog's writer never wraps a lone `.get`/`.run` call in
   * an explicit transaction), so on a fresh install every blob paid one
   * `synchronous = FULL` WAL commit fsync for its metadata row alone, on top
   * of its own CAS file/directory fsyncs; this collapses that to one batched
   * existence check plus one multi-row insert (so one commit fsync) for the
   * whole batch. The per-entry immutability semantics are unchanged: an
   * already-recorded hash with different length/reference/media type is
   * still a hard conflict, just detected from a batched read instead of N
   * individual ones.
   */
  async recordCasObjectsBatch(entries: readonly { readonly content: { readonly content_blob_id: string; readonly content_hash: string; readonly byte_length: number; readonly storage_reference: string }; readonly media_type?: string }[]): Promise<void> {
    await this.writer.run(() => this.recordCasObjectsBatchSerialized(entries));
  }

  private async recordCasObjectsBatchSerialized(entries: readonly { readonly content: { readonly content_blob_id: string; readonly content_hash: string; readonly byte_length: number; readonly storage_reference: string }; readonly media_type?: string }[]): Promise<void> {
    if (entries.length === 0) return;
    // Duplicate content within one batch (e.g. two identical files scanned
    // together) shares one content_hash; keep the first occurrence, matching
    // `recordCasObjectSerialized`'s existing-row success path for repeats.
    const byHash = new Map<string, (typeof entries)[number]>();
    for (const entry of entries) if (!byHash.has(entry.content.content_hash)) byHash.set(entry.content.content_hash, entry);
    const hashes = [...byHash.keys()];
    const existingByHash = new Map<string, { byte_length: number; media_type: string | null; storage_reference: string }>();
    for (let start = 0; start < hashes.length; start += CAS_METADATA_BATCH_ROWS) {
      const chunk = hashes.slice(start, start + CAS_METADATA_BATCH_ROWS);
      const rows = await this.database.all<{ content_hash: string; byte_length: number; media_type: string | null; storage_reference: string }>(
        `SELECT content_hash, byte_length, media_type, storage_reference FROM installation_cas_objects WHERE content_hash IN (${chunk.map(() => "?").join(",")})`,
        chunk,
      );
      for (const row of rows) existingByHash.set(row.content_hash, row);
    }
    const toInsert: (typeof entries)[number][] = [];
    for (const [hash, entry] of byHash) {
      const existing = existingByHash.get(hash);
      if (existing) {
        if (existing.byte_length !== entry.content.byte_length || existing.storage_reference !== entry.content.storage_reference
          || (entry.media_type !== undefined && existing.media_type !== entry.media_type)) {
          throw new StorageError("storage:cas_metadata_conflict", `CAS metadata for ${hash} is immutable and conflicts with the existing record.`);
        }
        continue;
      }
      toInsert.push(entry);
    }
    if (toInsert.length === 0) return;
    const now = new Date().toISOString();
    for (let start = 0; start < toInsert.length; start += CAS_METADATA_BATCH_ROWS) {
      const chunk = toInsert.slice(start, start + CAS_METADATA_BATCH_ROWS);
      const params: SqliteValue[] = [];
      for (const entry of chunk) params.push(entry.content.content_hash, entry.content.byte_length, entry.media_type ?? null, entry.content.storage_reference, now, now);
      const inserted = await this.database.run(
        `INSERT INTO installation_cas_objects (content_hash, byte_length, media_type, storage_reference, created_at, last_verified_at)
         VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
         ON CONFLICT(content_hash) DO NOTHING`,
        params,
      );
      // A partial insert (some hashes raced in between the read above and
      // this insert) is vanishingly unlikely under this catalog's one
      // serialized writer, but if it happens, fall back to the same
      // per-row verification the single-item path uses for exactly the
      // rows that did not insert cleanly.
      if (inserted.changes !== chunk.length) for (const entry of chunk) await this.recordCasObjectSerializedTimed(entry.content, entry.media_type);
    }
  }

  async close(): Promise<void> { await this.writer.run(() => this.database.close()); }

  private defaultWorkspacePath(workspaceId: string): string {
    const safeId = workspaceId.replace(/[^A-Za-z0-9._-]/g, "_");
    return join(this.rootDir, "workspaces", `${safeId}.sqlite`);
  }
}

export interface PublicationInput {
  readonly snapshot: Omit<Snapshot, "parent_snapshot_id"> & { readonly parent_snapshot_id?: string };
  readonly current_state: WorkspaceCurrentState;
  readonly expected_current_state?: WorkspaceCurrentState;
}

export interface SourceIndexPublicationInput {
  readonly source_index: SourceIndexCommitInput;
}

export class WorkspaceDatabase {
  readonly repositories: WorkspaceRepositories;
  readonly projections: WorkspaceProjectionRepository;
  readonly lifecycle: WorkspaceLifecycleRepository;
  readonly maintenance: StorageMaintenance;
  readonly sourceIndex: WorkspaceSourceIndexRepository;
  readonly candidates: WorkspaceCandidateRepository;
  readonly projectionOccurrences: WorkspaceProjectionOccurrenceRepository;
  readonly database: SqliteDatabase;
  readonly workspaceId: string;
  /** Absolute CAS root used by native analyzer workers to re-read immutable source bytes. */
  readonly casRoot: string;
  /** CAS writer used by the Rust-owned source-ingestion bridge. */
  readonly blobs: BlobStore;
  private readonly rawDatabase: SqliteDatabase;
  private readonly writer: SerializedWriter;
  private closed = false;
  private readonly stagingCleanups = new Set<Promise<void>>();
  // Warm digest corpus (`RecordSetDigestCorpusEntry`,
  // `publication-authority.ts`): `computeSnapshotDigestFields`'s own
  // `sortedVisible` output for the generation most recently committed
  // against this workspace's database FILE, so the next
  // `publishCandidateSerialized` call can skip its `record_occurrences`
  // re-read. Backed by the module-level `workspaceDigestCorpora` (see its
  // comment for why per-handle storage is the wrong scope: the daemon opens
  // a fresh handle per scan), accessed through this pair so every read/write
  // site stays keyed consistently. Empty until the first successful
  // candidate publish in this process (daemon restart, first publish, and
  // fork all start cold and fall back to the SQL read -- see
  // `computeSnapshotDigestFields`); never persisted.
  private get recordSetDigestCorpus(): RecordSetDigestCorpusEntry | undefined {
    return workspaceDigestCorpora.get(resolve(this.rawDatabase.filename));
  }
  private set recordSetDigestCorpus(entry: RecordSetDigestCorpusEntry | undefined) {
    if (entry === undefined) workspaceDigestCorpora.delete(resolve(this.rawDatabase.filename));
    else workspaceDigestCorpora.set(resolve(this.rawDatabase.filename), entry);
  }
  // Warm projection-set digest corpus (`ProjectionSetDigestCorpusEntry`,
  // `publication-authority.ts`): the graph/dependency/metric row sets
  // `computeSnapshotDigestFields`'s own `sortedProjectionsByKind` output
  // produced for the generation most recently committed against this
  // workspace's database FILE, backed by the module-level
  // `workspaceProjectionDigestCorpora` for the same reason
  // `recordSetDigestCorpus` above is backed by `workspaceDigestCorpora`.
  private get projectionSetDigestCorpus(): ProjectionSetDigestCorpusEntry | undefined {
    return workspaceProjectionDigestCorpora.get(resolve(this.rawDatabase.filename));
  }
  private set projectionSetDigestCorpus(entry: ProjectionSetDigestCorpusEntry | undefined) {
    if (entry === undefined) workspaceProjectionDigestCorpora.delete(resolve(this.rawDatabase.filename));
    else workspaceProjectionDigestCorpora.set(resolve(this.rawDatabase.filename), entry);
  }

  constructor(workspaceId: string, database: SqliteDatabase, blobs: BlobStore, releaseLease: () => Promise<void>);
  constructor(workspaceId: string, database: SqliteDatabase, blobs: BlobStore, rootDir: string, releaseLease: () => Promise<void>, faults?: FaultInjector);
  constructor(workspaceId: string, database: SqliteDatabase, blobs: BlobStore, rootDirOrReleaseLease: string | (() => Promise<void>), releaseLeaseMaybe?: () => Promise<void>, faults: FaultInjector = noFaults) {
    const rootDir = typeof rootDirOrReleaseLease === "string" ? rootDirOrReleaseLease : dirname(database.filename);
    const releaseLease = typeof rootDirOrReleaseLease === "function" ? rootDirOrReleaseLease : releaseLeaseMaybe ?? (async () => undefined);
    this.workspaceId = workspaceId;
    this.casRoot = join(rootDir, "cas");
    this.blobs = blobs;
    this.rawDatabase = database;
    this.writer = workspaceWriter(database.filename);
    const serializedDatabase = new SerializedSqliteDatabase(database, this.writer);
    this.database = serializedDatabase;
    this.repositories = createWorkspaceRepositories(serializedDatabase, blobs, workspaceId);
    this.projections = new WorkspaceProjectionRepository(serializedDatabase, blobs, workspaceId);
    this.lifecycle = new WorkspaceLifecycleRepository(serializedDatabase, workspaceId, faults, blobs, rootDir);
    this.maintenance = new StorageMaintenance(serializedDatabase, blobs.cas, blobs, rootDir, workspaceId, faults);
    this.sourceIndex = new WorkspaceSourceIndexRepository(serializedDatabase, blobs, workspaceId, faults);
    this.candidates = new WorkspaceCandidateRepository(serializedDatabase, workspaceId, blobs);
    this.projectionOccurrences = new WorkspaceProjectionOccurrenceRepository(serializedDatabase, workspaceId);
    this.releaseLease = releaseLease;
    this.faults = faults;
    incrementWorkspaceHandle(database.filename);
  }

  private readonly releaseLease: () => Promise<void>;
  private readonly faults: FaultInjector;

  /**
   * Capture source bytes into CAS without touching workspace SQLite. The
   * resulting logical content ids are preserved so the Rust publication
   * transaction can insert the source rows atomically with structural data.
   */
  async prepareSourceIndexContent(input: {
    readonly contents: readonly SourceIndexContentInput[];
    readonly content_streams: readonly SourceIndexContentStreamInput[];
  }): Promise<readonly import("@urdira/contracts").ContentBlob[]> {
    const references: import("@urdira/contracts").ContentBlob[] = [];
    if (input.contents.length > 0) {
      const written = await this.blobs.cas.putMany(input.contents.map((content) => ({ bytes: content.bytes, options: { media_type: content.media_type } })));
      for (let index = 0; index < input.contents.length; index += 1) {
        const requested = input.contents[index] as SourceIndexContentInput;
        const actual = written[index] as import("@urdira/contracts").ContentBlob;
        references.push({ content_blob_id: requested.content_blob_id, content_hash: actual.content_hash, byte_length: actual.byte_length, storage_reference: actual.storage_reference });
      }
    }
    if (input.content_streams.length > 0) {
      const written = await this.blobs.cas.putStreamsMany(input.content_streams.map((content) => ({
        chunks: content.stream,
        options: {
          content_hash: content.content_hash,
          byte_length: content.byte_length,
          media_type: content.media_type,
          ...(content.after_read === undefined ? {} : { after_read: content.after_read }),
        },
      })));
      for (let index = 0; index < input.content_streams.length; index += 1) {
        const requested = input.content_streams[index] as SourceIndexContentStreamInput;
        const actual = written[index] as import("@urdira/contracts").ContentBlob;
        references.push({ content_blob_id: requested.content_blob_id, content_hash: actual.content_hash, byte_length: actual.byte_length, storage_reference: actual.storage_reference });
      }
    }
    return references;
  }

  async publish(input: PublicationInput): Promise<void> {
    await this.executeSerializedPublicationBuilder(async () => await this.publishCompatibility(input));
  }

  private async publishCompatibility(input: PublicationInput): Promise<void> {
    if (this.closed) throw new StorageError("storage:workspace_closed", "The workspace database is closed.");
    await this.faults.hit("publication.before_snapshot_insert");
    const plan = buildCompatibilityPublicationPlan({ workspaceId: this.workspaceId, input });
    await this.faults.hit("publication.after_snapshot_insert");
    await this.faults.hit("publication.before_current_update");
    try {
      await this.commitPublicationTransaction(buildPublicationTransactionCommands(plan));
    } catch (error) {
      if (error instanceof StorageError && error.code === "storage:transaction_assertion_failed") {
        const registry = await this.repositories.registries.getSnapshot(input.snapshot.registry_snapshot_id);
        if (!tupleAgrees(this.workspaceId, input.snapshot, input.current_state) || !registry || registry.resolution_lock_id !== input.snapshot.resolution_lock_id || !(await publicationControlsExist(this.database, this.workspaceId, input.snapshot, input.current_state))) {
          throw new StorageError("storage:publication_invalid", "Publication objects do not agree with the workspace identity tuple.");
        }
        throw new StorageError("storage:publication_conflict", "The workspace current tuple changed or the publication generation is not the next gapless generation.");
      }
      if (error instanceof StorageError && error.code === "ERR_SQLITE_ERROR" && /UNIQUE|constraint/i.test(error.message)) {
        throw new StorageError("storage:publication_conflict", "An immutable publication uniqueness collision was detected.");
      }
      throw error;
    }
    await this.faults.hit("publication.after_current_update");
    await this.faults.hit("publication.after_commit");
  }

  async publishCandidate(input: SourceIndexPublicationInput): Promise<void>;
  async publishCandidate(input: CandidatePublicationInput): Promise<CandidatePublicationResult>;
  async publishCandidate(input: CandidatePublicationInput | SourceIndexPublicationInput): Promise<CandidatePublicationResult | void> {
    if ("source_index" in input) {
      await this.sourceIndex.commitFromCandidate(input.source_index);
      return;
    }
    // `enqueuedAt` marks the moment this publish asks the workspace's
    // `SerializedWriter` to run it; the writer may already be busy with
    // another foreground/background operation, so the builder itself can
    // start running an arbitrary amount of wall time later. `resetTimings`
    // moves here (the first statement the queued operation actually runs)
    // rather than staying inside `publishCandidateSerialized` so the queue
    // wait itself -- recorded immediately after the reset, before anything
    // else -- survives into the same bucket snapshot as every span below it,
    // instead of being wiped by a later reset.
    const enqueuedAt = timingEnabled() ? performance.now() : 0;
    return await this.executeSerializedPublicationBuilder(async () => {
      if (timingEnabled()) {
        resetTimings();
        record("publish_writer_queue_wait", performance.now() - enqueuedAt);
      }
      return await this.publishCandidateSerialized(input);
    });
  }

  private async publishCandidateSerialized(input: CandidatePublicationInput): Promise<CandidatePublicationResult> {
    if (this.closed) throw new StorageError("storage:workspace_closed", "The workspace database is closed.");
    const candidateId = input.candidate.candidate_generation_id;
    const priorPublication = await this.candidates.getPublication(candidateId);
    const storedCandidate = await this.candidates.get(candidateId);
    if (!storedCandidate) throw new StorageError("storage:candidate_not_found", `Candidate ${candidateId} does not exist in workspace ${this.workspaceId}.`);
    const persistedFrozenBase = await this.candidates.getFrozenBase(candidateId);
    if (!persistedFrozenBase || !sameFrozenCandidateBaseTuple(persistedFrozenBase, input.frozen_base)) throw new StorageError("storage:publication_conflict", "The supplied frozen candidate base differs from the sealed candidate base.");
    if (input.candidate.workspace_id !== this.workspaceId || input.frozen_base.source_state_digest.length === 0) throw new StorageError("storage:publication_invalid", "Candidate publication identity is incomplete.");
    if (!sameCandidateImmutablePayload(storedCandidate, input.candidate)) throw new StorageError("storage:candidate_digest_conflict", `Candidate ${candidateId} immutable identity differs from the sealed candidate.`);
    if (input.candidate.state !== "ready" && input.candidate.state !== "publishing") throw new StorageError("storage:candidate_state_conflict", `Candidate ${candidateId} input state is not publishable.`);
    const expected = input.frozen_base;
    if (expected.tuple_digest !== frozenCandidateBaseTupleDigest(expected)) throw new StorageError("storage:publication_conflict", "The frozen candidate base tuple digest is inconsistent.");
    if (!candidateAgreesWithFrozenBase(input.candidate, expected)) throw new StorageError("storage:publication_conflict", "Candidate identity does not agree with its frozen base tuple.");
    // Rust may have completed the authoritative publication transaction
    // before the application reaches this acknowledgement boundary. Handle
    // that path before the ordinary `ready`/`publishing` state check: Rust
    // atomically moves candidate_state to `published`, so asking the legacy
    // TypeScript writer to validate or replay it would reject a valid commit.
    if (input.rust_publication_completed === true) {
      const journal = await this.database.get<{ snapshot_id: string; generation_manifest_id: string; generation: number; published_at: string }>(
        "SELECT snapshot_id, generation_manifest_id, generation, published_at FROM candidate_publication_journal WHERE workspace_id = ? AND candidate_generation_id = ? AND status = 'published'",
        [this.workspaceId, candidateId],
      );
      if (journal === undefined) throw new StorageError("storage:publication_invalid", "Rust reported publication completion without a durable publication journal.");
      const currentAfterRust = await this.database.get<{ current_snapshot_id: string; current_generation: number }>("SELECT current_snapshot_id, current_generation FROM workspace_current_state WHERE workspace_id = ?", [this.workspaceId]);
      if (currentAfterRust?.current_snapshot_id !== journal.snapshot_id || currentAfterRust.current_generation !== journal.generation) throw new StorageError("storage:publication_conflict", "Rust publication journal is not the visible workspace current state.");
      this.scheduleCandidateStagingCleanup(candidateId);
      return { candidate_generation_id: candidateId, snapshot_id: journal.snapshot_id, generation_manifest_id: journal.generation_manifest_id, generation: journal.generation, published_at: journal.published_at, status: "published" };
    }
    // Rust may have completed the authoritative publication transaction before
    // the application reaches this acknowledgement boundary. Do not compare
    // its durable journal against the TypeScript placeholder payload here:
    // the Rust-owned branch below validates the visible current tuple and
    // returns the journal as the single publication result.
    if (priorPublication) {
      await assertExistingPublicationJournal(this.database, this.workspaceId, input, priorPublication);
      return { ...priorPublication, status: "already_published" };
    }
    if (storedCandidate.state !== "ready" && storedCandidate.state !== "publishing") throw new StorageError("storage:candidate_state_conflict", `Candidate ${candidateId} is terminal or not ready for publication.`);
    await this.faults.hit("candidate_publication.before_begin");

    // `publish_frozen_base_checks`: the workspace's live current-tuple/
    // snapshot reads and the `baseAgrees` comparison they feed -- the last
    // storage-side verification that this candidate's frozen base still
    // matches reality before any publication planning work begins.
    const { current, baseAgrees } = await timed("publish_frozen_base_checks", async () => {
      const currentRow = await this.database.get<{
        current_snapshot_id: string;
        current_generation: number;
        current_registry_snapshot_id: string;
        current_resolution_lock_id: string;
        current_configuration_revision_id: string;
        current_freshness_checkpoint_id: string;
        state_revision: number;
      }>("SELECT current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision FROM workspace_current_state WHERE workspace_id = ?", [this.workspaceId]);
      const currentSnapshot = currentRow ? await this.database.get<{ source_state_digest: string; source_observation_watermarks: string }>("SELECT source_state_digest, source_observation_watermarks FROM snapshots WHERE workspace_id = ? AND snapshot_id = ?", [this.workspaceId, currentRow.current_snapshot_id]) : undefined;
      const currentBatchIds = currentSnapshot === undefined ? [] : snapshotObservationBatchIds(currentSnapshot.source_observation_watermarks);
      const normalizedExpectedObservations = normalizeObservationBatchIds(expected.source_observation_batch_ids);
      const agrees = currentRow === undefined
        ? expected.snapshot_id === undefined && expected.generation === undefined && expected.registry_snapshot_id === undefined && expected.resolution_lock_id === undefined && expected.configuration_revision_id === undefined
        : expected.snapshot_id === currentRow.current_snapshot_id
          && expected.generation === currentRow.current_generation
          && expected.registry_snapshot_id === currentRow.current_registry_snapshot_id
          && expected.resolution_lock_id === currentRow.current_resolution_lock_id
          && expected.configuration_revision_id === currentRow.current_configuration_revision_id
          && JSON.stringify(normalizedExpectedObservations) === JSON.stringify(normalizeObservationBatchIds(currentBatchIds))
          && currentSnapshot?.source_state_digest === expected.source_state_digest;
      return { current: currentRow, baseAgrees: agrees };
    });
    if (!baseAgrees) throw new StorageError("storage:publication_conflict", "The frozen candidate base tuple is stale.");
    await this.faults.hit("candidate_publication.after_validate_base");

    // Ordinarily `(current?.current_generation ?? 0) + 1` and stage-1 source
    // cataloging's OWN generation stamp (`GenericSourceIndexer.applyBatch`'s
    // `generation`, `packages/engine/src/source-indexer.ts` -- durably
    // committed through `source_index_state.current_generation`, in ITS OWN
    // transaction, BEFORE this candidate's plan/publish ever runs) agree:
    // stage-1 stamps new `artifact_versions`/`artifact_tombstones` rows one
    // past whatever `workspace_current_state` held at scan start, this
    // candidate's plan carries those SAME stamped rows forward
    // ("target_artifact_version_without_generation" templates,
    // deliberately generation-less until publish fills it in), and this
    // publish then independently recomputes the identical value from the
    // SAME `current_generation` column. That agreement silently breaks when
    // an EARLIER scan's stage-1 commit landed (durable, its own transaction)
    // but that scan's OWN candidate publish never did -- a crash between
    // seal and publish, or any other publish failure: stage-1's counter is
    // now durably one generation ahead of `workspace_current_state`, and
    // stays there (source-indexer.ts's stage-1 stamp already accounts for
    // its own prior counter so a LATER scan's ingest keeps advancing from
    // it, correctly, rather than colliding with it or silently overwriting
    // it). Recomputing `generation` here from `current_generation` ALONE
    // then targets a generation stage-1 ALREADY used for different content,
    // and the immutable-row check in `publication-authority.ts` correctly
    // rejects the mismatch (`storage:publication_conflict`, `mismatched_fields:
    // 'valid_from_generation,artifact_version_payload'`) -- on every
    // subsequent scan, forever, since nothing ever closes the gap: the
    // "crashed candidate wedge" (see `packages/engine/src/candidate-indexer.ts`'s
    // `recover()` and `tests/phase-workspace-indexing-session.test.ts`'s
    // regression test for the full repro). Deferring to whichever counter is
    // further ahead closes that gap: on the common path the two already
    // agree (this is a no-op), and after a crash this candidate's publish
    // catches up to exactly the generation stage-1 already committed its
    // content under, instead of re-demanding a generation that is already
    // spoken for.
    const sourceIndexState = await this.sourceIndex.getState();
    const generation = Math.max((current?.current_generation ?? 0) + 1, sourceIndexState?.current_generation ?? 0);
    const publishedAt = new Date().toISOString();
    const plan = await timed("publish_plan_build", () => buildCandidatePublicationPlan({
      input,
      storedCandidate,
      ...(current === undefined ? {} : { current }),
      workspaceId: this.workspaceId,
      database: this.database,
      stagingDatabase: this.rawDatabase,
      faults: this.faults,
      generation,
      publishedAt,
      ...(this.recordSetDigestCorpus === undefined ? {} : { recordSetDigestCorpus: this.recordSetDigestCorpus }),
      ...(this.projectionSetDigestCorpus === undefined ? {} : { projectionSetDigestCorpus: this.projectionSetDigestCorpus }),
    }));
    // `publish_pre_transaction`: bookkeeping between the plan being fully
    // built and the transaction actually starting -- today just the counted
    // command generator's declaration, but kept as its own span so a future
    // regression here (rather than inside the plan build or the transaction
    // itself) shows up distinctly instead of silently inflating one of them.
    let publicationCommandCount = 0;
    let publicationRunCount = 0;
    const countedPublicationCommands = timedSync("publish_pre_transaction", () => {
      // A candidate publication's command set can be large (one full workspace
      // scan's canonical records, projections, and journal entries); stream it
      // to the worker in bounded chunks instead of materializing the full
      // concatenated array (`buildPublicationTransactionCommands`) and
      // structured-cloning it in a single `postMessage`. `transfer_params`
      // is safe here because `plan` (and every command/param inside it) was
      // just built fresh, above, by `buildCandidatePublicationPlan` for this
      // one publish attempt only -- nothing else holds a reference to any of
      // its `Uint8Array` params, and a retried/replanned publish (e.g. after
      // a `storage:publication_conflict`) always calls
      // `buildCandidatePublicationPlan` again from scratch rather than
      // reusing `plan`, so there is no path that reads a transferred (and
      // therefore detached) buffer again.
      // `publicationTransactionCommands` yields only `run`/
      // `transaction_checkpoint`/`assert_transaction_changes`/`fault`
      // commands (verified against `DISCARD_ALLOWED_KINDS` in
      // packages/storage/src/sqlite.ts -- no `get`/`all` command ever
      // appears in a publication's write set), so it also qualifies for
      // `discard_results`, which composes with `transfer_params`; this call
      // has never read the return value.
      function* generate(): Generator<SqliteCommand> {
        for (const command of publicationTransactionCommands(plan)) {
          publicationCommandCount += 1;
          if (command.kind === "run") publicationRunCount += 1;
          yield command;
        }
      }
      return generate;
    });
    const checkpointInitialPublicationWal = async (afterTransaction: boolean): Promise<void> => {
      try {
        await this.rawDatabase.get("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (checkpointError) {
        // Checkpointing is maintenance, not part of the authoritative commit.
        // A lexical reader may pin the WAL, and a post-commit checkpoint must
        // never turn an already-visible publication into a reported failure.
        if (afterTransaction) return;
        if (checkpointError instanceof StorageError && /locked|busy/iu.test(checkpointError.message)) return;
        throw checkpointError;
      }
    };
    try {
      if (current === undefined) await checkpointInitialPublicationWal(false);
      await timed("publish_sql_transaction", () => this.rawDatabase.transactionChunked(countedPublicationCommands(), undefined, { transfer_params: true, discard_results: true }));
    } catch (error) {
      if (error instanceof StorageError && error.code === "storage:transaction_assertion_failed") throw new StorageError("storage:publication_conflict", "The workspace current tuple changed or the publication generation is not gapless.");
      if (error instanceof StorageError && error.code === "ERR_SQLITE_ERROR" && /UNIQUE|constraint/i.test(error.message)) throw new StorageError("storage:publication_conflict", `An immutable publication uniqueness collision was detected: ${error.message}`);
      throw error;
    } finally {
      if (current === undefined) await checkpointInitialPublicationWal(true);
    }
    // `publish_post_commit`: everything after the transaction resolves --
    // commit-hook placement for the warm digest corpora
    // (`RecordSetDigestCorpusEntry`/`ProjectionSetDigestCorpusEntry`), only
    // reachable once `transactionChunked` above has resolved without
    // throwing, i.e. after the publication transaction actually committed --
    // a fault or conflict anywhere above (including inside the transaction
    // itself, e.g. `candidate_publication.before_commit`) throws out of the
    // `try` block above and skips this assignment entirely, leaving whatever
    // corpus this handle already had (still valid for its own generation) in
    // place instead of poisoning it with this failed attempt's never-
    // committed candidate. Large publications deliberately omit the warm
    // corpus rather than retain a project-sized record array in the daemon;
    // assigning `undefined` also clears a prior generation so it cannot be
    // reused against this newer snapshot. Same reasoning applies to the
    // projection-set digest corpus below it, plus the (fire-and-forget)
    // staging cleanup schedule and the trailing fault hit.
    await timed("publish_post_commit", async () => {
      this.recordSetDigestCorpus = plan.recordSetDigestCorpusCandidate;
      if (plan.projectionSetDigestCorpusCandidate) this.projectionSetDigestCorpus = plan.projectionSetDigestCorpusCandidate;
      this.scheduleCandidateStagingCleanup(candidateId);
      await this.faults.hit("candidate_publication.after_commit_ack");
    });
    if (timingEnabled()) {
      const timingSnapshot = snapshotTimings() as Record<string, unknown>;
      timingSnapshot["publication_commands"] = { command_count: publicationCommandCount, run_count: publicationRunCount };
      console.error(`[urdira] storage timings publish workspace:${this.workspaceId} generation:${generation} ms=${JSON.stringify(timingSnapshot)}`);
    }
    return { candidate_generation_id: candidateId, snapshot_id: `snapshot:${candidateId}`, generation_manifest_id: `generation-manifest:${candidateId}`, generation, published_at: publishedAt, status: "published" };
  }

  private async executeSerializedPublicationBuilder<T>(builder: () => Promise<T>): Promise<T> {
    return await this.writer.run(builder);
  }

  private async commitPublicationTransaction(commands: readonly TransactionCommand[]): Promise<void> {
    await this.rawDatabase.transaction(commands);
  }

  /**
   * Published FactDelta rows are recovery-only data. Reclaim them after the
   * visible commit in small, low-priority transactions: deleting a
   * million-row staging corpus inside publication rewrote the entire corpus
   * into the WAL and delayed readiness by minutes. Each batch yields back to
   * the foreground writer lane, so queries and subsequent publications are
   * never queued behind the full cleanup.
   */
  private scheduleCandidateStagingCleanup(candidateId: string): void {
    const cleanup = (async () => {
      let publicationStagingCleaned = false;
      while (true) {
        const removed = await this.writer.run(async () => {
          if (!publicationStagingCleaned) {
            await this.rawDatabase.transaction([
              ...[
                "candidate_publication_record_facets",
                "candidate_publication_record_closures",
                "candidate_publication_identity_assignments",
                "candidate_publication_record_occurrences",
                "candidate_publication_descriptors",
                "candidate_publication_projection_value_nodes",
                "candidate_publication_projection_dependencies",
                "candidate_publication_projection_occurrences",
                "candidate_publication_projection_descriptors",
              ].map((table) => ({ kind: "run" as const, sql: `DELETE FROM ${table} WHERE candidate_generation_id = ?`, params: [candidateId] })),
            ]);
            publicationStagingCleaned = true;
            return true;
          }
          const batches = await this.rawDatabase.all<{ fact_delta_id: string }>(
            "SELECT fact_delta_id FROM candidate_fact_delta_batches WHERE workspace_id = ? AND candidate_generation_id = ? ORDER BY sequence, fact_delta_id LIMIT 64",
            [this.workspaceId, candidateId],
          );
          if (batches.length === 0) {
            await this.rawDatabase.run("DELETE FROM candidate_fact_delta_namespaces WHERE workspace_id = ? AND candidate_generation_id = ?", [this.workspaceId, candidateId]);
            const before = await this.rawDatabase.get<{ freelist_count: number }>("PRAGMA freelist_count");
            if ((before?.freelist_count ?? 0) === 0) return false;
            // Keep each reclaim slice small enough that a foreground
            // FactDelta batch never waits behind a multi-second vacuum.
            await this.rawDatabase.exec("PRAGMA incremental_vacuum(512)");
            const after = await this.rawDatabase.get<{ freelist_count: number }>("PRAGMA freelist_count");
            return (after?.freelist_count ?? 0) < (before?.freelist_count ?? 0);
          }
          const ids = batches.map((batch) => batch.fact_delta_id);
          const placeholders = ids.map(() => "?").join(", ");
          const params: readonly SqliteValue[] = [this.workspaceId, candidateId, ...ids];
          await this.rawDatabase.transaction([
            ...["candidate_staged_records", "candidate_staged_graph_edges", "candidate_staged_identities", "candidate_staged_dependencies"].map((table) => ({ kind: "run" as const, sql: `DELETE FROM ${table} WHERE fact_delta_key IN (SELECT fact_delta_key FROM candidate_fact_delta_namespaces WHERE workspace_id = ? AND candidate_generation_id = ? AND fact_delta_id IN (${placeholders}))`, params })),
            { kind: "run", sql: `DELETE FROM candidate_fact_delta_batches WHERE workspace_id = ? AND candidate_generation_id = ? AND fact_delta_id IN (${placeholders})`, params },
            { kind: "run", sql: `DELETE FROM candidate_fact_delta_namespaces WHERE workspace_id = ? AND candidate_generation_id = ? AND fact_delta_id IN (${placeholders})`, params },
          ]);
          return true;
        }, "background");
        if (!removed) return;
        await new Promise<void>((resolveCleanupYield) => setTimeout(resolveCleanupYield, 0));
      }
    })();
    this.stagingCleanups.add(cleanup);
    void cleanup.catch((error: unknown) => {
      if (timingEnabled()) console.error(`[urdira] background staging cleanup failed workspace:${this.workspaceId} candidate:${candidateId}: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => this.stagingCleanups.delete(cleanup));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Deliberately does NOT clear `recordSetDigestCorpus`/
    // `projectionSetDigestCorpus`: surviving handle close is the whole point
    // of the module-level stores (the daemon publishes through a fresh
    // handle per scan), and each entry's own generation key makes a stale
    // survivor harmless -- see `workspaceDigestCorpora`'s comment.
    try {
      await Promise.allSettled([...this.stagingCleanups]);
      await this.writer.run(() => this.rawDatabase.close(), "background");
    } finally {
      decrementWorkspaceHandle(this.rawDatabase.filename);
      await this.releaseLease();
    }
  }
}

export class DurableStorage {
  readonly catalog: InstallationCatalog;
  readonly cas: ContentAddressedStore;
  readonly blobs: BlobStore;
  readonly sqliteCapabilities = sqliteCapabilities;
  readonly byteTelemetry: ByteBoundaryTelemetry;
  private readonly rootDir: string;
  private readonly busyTimeoutMs: number;
  private readonly openedWorkspaces = new Set<WorkspaceDatabase>();
  private readonly ownerId: string;
  private readonly ownerPid: number;
  private readonly faults: FaultInjector;

  private constructor(rootDir: string, busyTimeoutMs: number, catalog: InstallationCatalog, cas: ContentAddressedStore, blobs: BlobStore, faults: FaultInjector, byteTelemetry: ByteBoundaryTelemetry) {
    this.rootDir = rootDir;
    this.busyTimeoutMs = busyTimeoutMs;
    this.catalog = catalog;
    this.cas = cas;
    this.blobs = blobs;
    this.faults = faults;
    this.byteTelemetry = byteTelemetry;
    this.ownerId = `handle-owner:${randomUUID()}`;
    this.ownerPid = process.pid;
  }

  static async open(options: DurableStorageOptions): Promise<DurableStorage> {
    const rootDir = resolve(options.rootDir);
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    await mkdir(rootDir, { recursive: true });
    await mkdir(join(rootDir, "cas"), { recursive: true });
    await enforceCasLayoutMarker(join(rootDir, "cas"));
    const catalogDatabase = await openSqliteDatabase({ filename: join(rootDir, "catalog.sqlite"), busy_timeout_ms: busyTimeoutMs });
    await initializeSchema(catalogDatabase, CATALOG_SCHEMA);
    await ensureCatalogSchemaCompatibility(catalogDatabase);
    const catalog = new InstallationCatalog(catalogDatabase, rootDir, busyTimeoutMs);
    if (!options.skip_startup_recovery) {
      await catalog.recoverRelocations();
      await catalog.recoverGcBarriers();
    }
    const byteTelemetry = new ByteBoundaryTelemetry();
    const cas = new ContentAddressedStore(
      join(rootDir, "cas"),
      (blob, mediaType) => catalog.recordCasObject(blob, mediaType),
      { telemetry: byteTelemetry, ...(options.cas_put_concurrency === undefined ? {} : { put_concurrency: options.cas_put_concurrency }) },
      (entries) => catalog.recordCasObjectsBatch(entries.map((entry) => (entry.media_type === undefined ? { content: entry.blob } : { content: entry.blob, media_type: entry.media_type }))),
    );
    const blobs = new BlobStore(cas, options.inlineThresholdBytes ?? 16 * 1024);
    const storage = new DurableStorage(rootDir, busyTimeoutMs, catalog, cas, blobs, options.fault_injector ?? noFaults, byteTelemetry);
    if (!options.skip_startup_recovery) {
      await storage.recoverMigrations();
      await storage.recoverWorkspaceGcEpochs();
    }
    return storage;
  }

  private async recoverMigrations(): Promise<void> {
    const workspaces = await this.catalog.database.all<{ workspace_id: string; database_path: string }>("SELECT workspace_id, database_path FROM installation_workspaces ORDER BY workspace_id");
    for (const workspace of workspaces) {
      try { await access(workspace.database_path); } catch { continue; }
      const mutationLock = await acquireWorkspaceMutationLock(`${resolve(workspace.database_path)}.urdira-writer.lock`);
      let database: SqliteDatabase | undefined;
      try {
        database = await openSqliteDatabase({ filename: workspace.database_path, busy_timeout_ms: this.busyTimeoutMs });
        await initializeSchema(database, WORKSPACE_V3_SCHEMA);
        await ensureWorkspaceSchemaCompatibility(database, this.faults);
        const maintenance = new StorageMaintenance(database, this.cas, this.blobs, this.rootDir, workspace.workspace_id);
        const migrations = await database.all<{ migration_id: string }>("SELECT migration_id FROM storage_migrations WHERE workspace_id = ? AND state = 'running' ORDER BY started_at", [workspace.workspace_id]);
        for (const migration of migrations) await maintenance.reconcileMigration(migration.migration_id);
      } finally {
        try { await database?.close(); } finally { await mutationLock.release(); }
      }
    }
  }

  private async recoverWorkspaceGcEpochs(): Promise<void> {
    const workspaces = await this.catalog.database.all<{ workspace_id: string; database_path: string }>("SELECT workspace_id, database_path FROM installation_workspaces ORDER BY workspace_id");
    const recoveredAt = new Date().toISOString();
    for (const workspace of workspaces) {
      try { await access(workspace.database_path); } catch { continue; }
      const mutationLock = await acquireWorkspaceMutationLock(`${resolve(workspace.database_path)}.urdira-writer.lock`);
      let database: SqliteDatabase | undefined;
      try {
        database = await openSqliteDatabase({ filename: workspace.database_path, busy_timeout_ms: this.busyTimeoutMs });
        await initializeSchema(database, WORKSPACE_V3_SCHEMA);
        await ensureWorkspaceSchemaCompatibility(database);
        await database.run("UPDATE garbage_collection_epochs SET state = 'recovered', completed_at = COALESCE(completed_at, ?), failure_code = 'storage:gc_recovered_after_restart' WHERE workspace_id = ? AND state IN ('marking', 'sweeping')", [recoveredAt, workspace.workspace_id]);
      } finally {
        try { await database?.close(); } finally { await mutationLock.release(); }
      }
    }
  }

  async openWorkspace(workspaceId: string): Promise<WorkspaceDatabase> {
    const workspace = await this.catalog.getWorkspace(workspaceId);
    if (!workspace) throw new StorageError("storage:workspace_not_found", `Workspace ${workspaceId} is not registered.`);
    // Schema stamping, identity binding and the catalog lease all mutate the
    // workspace before a SerializedWriter exists for the returned handle.
    // Acquire the same marker used by Rust's IndexingCore before opening the
    // connection so a legacy/compatibility TypeScript mutation can never race
    // a Rust structural or lexical transaction during this bootstrap window.
    const mutationLock = await acquireWorkspaceMutationLock(`${resolve(workspace.database_path)}.urdira-writer.lock`);
    let database: SqliteDatabase | undefined;
    try {
      database = await openSqliteDatabase({ filename: workspace.database_path, busy_timeout_ms: this.busyTimeoutMs });
      await initializeSchema(database, WORKSPACE_V3_SCHEMA);
      await ensureWorkspaceSchemaCompatibility(database, this.faults);
      await bindWorkspaceIdentity(database, workspaceId);
      await ensureIdentityFormat(database, workspaceId);
      await this.catalog.acquireWorkspaceLease(workspaceId, this.ownerId, this.ownerPid);
      const opened = new WorkspaceDatabase(workspaceId, database, this.blobs, this.rootDir, () => this.catalog.releaseWorkspaceLease(workspaceId, this.ownerId), this.faults);
      this.openedWorkspaces.add(opened);
      return opened;
    } catch (error) {
      try { await this.catalog.releaseWorkspaceLease(workspaceId, this.ownerId); } catch { /* lease was not acquired */ }
      await database?.close();
      throw error;
    } finally {
      await mutationLock.release();
    }
  }

  /**
   * Write-free counterpart to `openWorkspace`, for hot poll paths (the
   * daemon's readiness poll) that must not contend with a workspace's own
   * long-running write transactions. `openWorkspace` performs writes on
   * EVERY call -- `initializeSchema`/`ensureWorkspaceSchemaCompatibility`
   * (schema bookkeeping), `bindWorkspaceIdentity`/`ensureIdentityFormat`
   * (identity verification, which upserts on first touch), and catalog
   * lease acquire/release -- and a busy long-running publish transaction on
   * this same database file makes those writes queue behind it and eat the
   * SQLite busy timeout. This opens the connection read-only instead (see
   * `sqlite.ts`'s worker `openDatabase`: `readOnly` skips the `WAL`/
   * `synchronous` pragmas the writer already set once at creation and never
   * needs re-set). A WAL reader snapshots the last committed state and
   * never blocks behind -- or gets blocked by -- an in-progress writer, so
   * this never hits SQLITE_BUSY against a held write transaction.
   *
   * Every write `openWorkspace` performs is either already-applied (schema
   * compatibility, identity binding: both are one-time-on-creation facts
   * stamped by `registerWorkspaceSerialized`/whichever writer handle opened
   * this database first -- see `stampIdentityFormat`) or inapplicable to a
   * read-only poll (the catalog lease models a durable "handle" the
   * relocation/purge machinery waits out; a sub-poll-interval read-only
   * open is not that, so its release hook is a no-op). All of them are
   * skipped outright here rather than run in a "read-only check" mode: a
   * read-only SQLite connection cannot execute the ALTER/INSERT statements
   * they're built from even if asked to.
   *
   * Returns a normal `WorkspaceDatabase`; any write attempted through it
   * fails at the SQLite layer (`readOnly: true`), which is the intended
   * backstop against a caller reusing this handle for anything but reads.
   */
  async openWorkspaceReadOnly(workspaceId: string): Promise<WorkspaceDatabase> {
    const workspace = await this.catalog.getWorkspace(workspaceId);
    if (!workspace) throw new StorageError("storage:workspace_not_found", `Workspace ${workspaceId} is not registered.`);
    // Schema/identity are stamped into the database file BEFORE the catalog
    // row that makes `getWorkspace` above return non-undefined (see
    // `registerWorkspaceSerialized`), so a catalog hit normally implies the
    // file already exists and is fully initialized. This guards only the
    // crash-mid-registration edge (file removed or never durably written)
    // -- surfacing the same `workspace_not_found` an unregistered workspace
    // gets, instead of a raw SQLite "unable to open database file" error a
    // read-only connection cannot recover from the way `openWorkspace`'s
    // schema-init would.
    if (!(await pathExists(workspace.database_path))) throw new StorageError("storage:workspace_not_found", `Workspace ${workspaceId} is not registered.`);
    const database = await openSqliteDatabase({ filename: workspace.database_path, busy_timeout_ms: this.busyTimeoutMs, read_only: true });
    const opened = new WorkspaceDatabase(workspaceId, database, this.blobs, this.rootDir, async () => undefined, this.faults);
    this.openedWorkspaces.add(opened);
    return opened;
  }

  async close(): Promise<void> {
    for (const workspace of this.openedWorkspaces) await workspace.close();
    this.openedWorkspaces.clear();
    await this.catalog.close();
  }
}

export const createDurableStorage = DurableStorage.open;

function canonicalSha256(value: unknown): string { return digestBytes(canonicalBytes(value)); }
function sqliteValue(value: unknown): SqliteValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
  return encodeCanonical(value);
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new StorageError("storage:invalid_blob", "SQLite returned a non-binary payload.");
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enforces the CAS shard-layout marker (docs/decisions/22: destructive-only
 * migration, no in-place upgrade). A `cas/` directory without the marker but
 * with existing `sha256/` entries predates the single-level shard flattening
 * and must never be reinterpreted under the new layout -- reject it exactly
 * like `ensureWorkspaceSchemaCompatibility`/`ensureCatalogSchemaCompatibility`
 * reject other pre-v3 contract mismatches (`schema.ts`). A fresh or genuinely
 * empty `cas/` directory gets the marker stamped so this check is O(1) (a
 * single file read) on every subsequent open.
 */
async function enforceCasLayoutMarker(casDir: string): Promise<void> {
  const markerPath = join(casDir, CAS_LAYOUT_MARKER_FILENAME);
  let markerContent: string | undefined;
  try { markerContent = await readFile(markerPath, "utf8"); }
  catch (error) { if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error; }
  if (markerContent === CAS_LAYOUT_VERSION) return;
  if (markerContent !== undefined) {
    throw new StorageError("core:index_contract_unsupported", "The workspace data root's CAS layout marker is not recognized by this Urdira v3 runtime; create a fresh v3 data root and reindex.", { contract_kind: "cas_layout", data_format_version: 3 });
  }
  let shardEntries: readonly string[] = [];
  try { shardEntries = await readdir(join(casDir, "sha256")); } catch (error) { if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error; }
  if (shardEntries.length > 0) {
    throw new StorageError("core:index_contract_unsupported", "The CAS layout predates this runtime's single-level shard directories; create a fresh v3 data root and reindex.", { contract_kind: "cas_layout", data_format_version: 3 });
  }
  await writeCasLayoutMarker(casDir);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

async function assertExistingPublicationJournal(database: SqliteDatabase, workspaceId: string, input: CandidatePublicationInput, priorPublication: CandidatePublicationResult): Promise<void> {
  const payload = encodeCanonical({ candidate: input.candidate, frozen_base: input.frozen_base });
  const row = await database.get<Record<string, unknown>>("SELECT * FROM candidate_publication_journal WHERE workspace_id = ? AND candidate_generation_id = ?", [workspaceId, input.candidate.candidate_generation_id]);
  if (!row || !rowMatches(row, {
    candidate_generation_id: input.candidate.candidate_generation_id,
    workspace_id: workspaceId,
    status: "published",
    snapshot_id: priorPublication.snapshot_id,
    generation_manifest_id: priorPublication.generation_manifest_id,
    generation: priorPublication.generation,
    published_at: priorPublication.published_at,
    publication_digest: canonicalSha256(payload),
  })) throw new StorageError("storage:publication_conflict", `Candidate publication journal ${input.candidate.candidate_generation_id} differs from the sealed publication payload.`);
}

function rowMatches(row: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const actual = row[key];
    if (value instanceof Uint8Array) return actual instanceof Uint8Array && sameBytes(actual, value);
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") return actual === value;
    return sameBytes(toBytes(actual), encodeCanonical(value));
  });
}

function sameCanonicalExcept(left: unknown, right: unknown, fields: readonly string[]): boolean {
  if (!left || typeof left !== "object" || Array.isArray(left) || !right || typeof right !== "object" || Array.isArray(right)) {
    return sameBytes(encodeCanonical(left), encodeCanonical(right));
  }
  const leftCopy = { ...(left as Record<string, unknown>) };
  const rightCopy = { ...(right as Record<string, unknown>) };
  for (const field of fields) {
    delete leftCopy[field];
    delete rightCopy[field];
  }
  return sameBytes(encodeCanonical(leftCopy), encodeCanonical(rightCopy));
}

async function publicationControlsExist(database: SqliteDatabase, workspaceId: string, snapshot: Omit<Snapshot, "parent_snapshot_id"> & { readonly parent_snapshot_id?: string }, currentState: WorkspaceCurrentState): Promise<boolean> {
  const keys = [
    `plugin_resolution_lock:${snapshot.resolution_lock_id}`,
    `workspace_configuration_revision:${snapshot.configuration_revision_id}`,
    `workspace_freshness_checkpoint:${currentState.current_freshness_checkpoint_id}`,
  ];
  const rows = await database.all<{ state_key: string; state_kind: string; reference_workspace_id: string | null; reference_snapshot_id: string | null; reference_source_state_digest: string | null }>("SELECT state_key, state_kind, reference_workspace_id, reference_snapshot_id, reference_source_state_digest FROM control_plane_state WHERE workspace_id = ? AND state_key IN (?, ?, ?)", [workspaceId, ...keys]);
  return rows.some((row) => row.state_key === keys[0] && row.state_kind === "plugin_resolution_lock")
    && rows.some((row) => row.state_key === keys[1] && row.state_kind === "workspace_configuration_revision")
    && rows.some((row) => row.state_key === keys[2] && row.state_kind === "workspace_freshness_checkpoint" && row.reference_workspace_id === workspaceId && row.reference_snapshot_id === currentState.current_snapshot_id && row.reference_source_state_digest === snapshot.source_state_digest);
}

// Bumped when the canonical layer's id/digest derivation changes in a way
// that makes a previously-indexed workspace database unsafe to keep using
// as-is (decision 11: record/identity/projection ids became content-derived
// instead of workspace-salted). There is no data migration for this: a
// database at an older format must be re-indexed from scratch, because its
// existing rows were minted under a derivation this code no longer computes.
const CURRENT_IDENTITY_FORMAT = 2;

/** Written once, only when a workspace database is first created (`registerWorkspaceSerialized`) -- never on later opens, so an existing pre-format-2 database is never silently "healed" into looking current. */
async function stampIdentityFormat(database: SqliteDatabase): Promise<void> {
  await database.run("INSERT INTO workspace_meta (key, value) VALUES ('identity_format', ?) ON CONFLICT(key) DO NOTHING", [encodeCanonical(CURRENT_IDENTITY_FORMAT)]);
}

// A plain rescan/reindex reopens this same database and re-runs this same
// gate, so it can never clear a `storage:workspace_format_outdated` error --
// there is no in-place migration for a pre-format-2 database (see
// `CURRENT_IDENTITY_FORMAT` above). The only ways out are to stop using this
// database file: remove the workspace and re-add it (which registers a fresh
// workspace_id and database file, see `registerWorkspaceSerialized` /
// `stampIdentityFormat`), or delete the workspace's database directory so
// the next open creates a fresh one and does a full re-index.
const IDENTITY_FORMAT_REMEDIATION = "run `urdira workspace remove` followed by `urdira workspace add <workspace-root>`, or delete the workspace's database directory, so it is re-created and fully re-indexed from scratch -- re-running a scan or reindex against this same database cannot clear this error.";

/** Absence of the `identity_format` key means the database predates decision 11's content-derived ids: it must be rejected, not silently mixed with the new derivation. */
async function ensureIdentityFormat(database: SqliteDatabase, workspaceId: string): Promise<void> {
  const row = await database.get<{ value: unknown }>("SELECT value FROM workspace_meta WHERE key = 'identity_format'");
  if (!row) throw new StorageError("storage:workspace_format_outdated", `Workspace ${workspaceId} predates content-derived record identity; ${IDENTITY_FORMAT_REMEDIATION}`, { remediation: IDENTITY_FORMAT_REMEDIATION });
  let storedFormat: unknown;
  try { storedFormat = decodeCanonical(toBytes(row.value)); } catch (error) {
    throw new StorageError("storage:workspace_format_outdated", `Workspace ${workspaceId} identity-format marker is unreadable; ${IDENTITY_FORMAT_REMEDIATION}`, { cause: error instanceof Error ? error.message : String(error), remediation: IDENTITY_FORMAT_REMEDIATION });
  }
  if (storedFormat !== CURRENT_IDENTITY_FORMAT) throw new StorageError("storage:workspace_format_outdated", `Workspace ${workspaceId} is at identity format ${String(storedFormat)}, not ${CURRENT_IDENTITY_FORMAT}; ${IDENTITY_FORMAT_REMEDIATION}`, { remediation: IDENTITY_FORMAT_REMEDIATION });
}

async function bindWorkspaceIdentity(database: SqliteDatabase, workspaceId: string): Promise<void> {
  const encoded = encodeCanonical(workspaceId);
  await database.run(
    "INSERT INTO workspace_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
    ["workspace_id", encoded],
  );
  const row = await database.get<{ value: unknown }>("SELECT value FROM workspace_meta WHERE key = ?", ["workspace_id"]);
  let storedWorkspaceId: unknown;
  try {
    storedWorkspaceId = row ? decodeCanonical(toBytes(row.value)) : undefined;
  } catch (error) {
    throw new StorageError("storage:workspace_binding_mismatch", "Workspace database identity is not valid canonical data.", { cause: error instanceof Error ? error.message : String(error) });
  }
  if (storedWorkspaceId !== workspaceId) throw new StorageError("storage:workspace_binding_mismatch", `Workspace database is bound to ${String(storedWorkspaceId)}, not ${workspaceId}.`);
}

function tupleAgrees(workspaceId: string, snapshot: Omit<Snapshot, "parent_snapshot_id"> & { readonly parent_snapshot_id?: string }, currentState: WorkspaceCurrentState): boolean {
  return snapshot.workspace_id === workspaceId
    && currentState.workspace_id === workspaceId
    && snapshot.generation === currentState.current_generation
    && currentState.current_snapshot_id === snapshot.snapshot_id
    && currentState.current_registry_snapshot_id === snapshot.registry_snapshot_id
    && currentState.current_resolution_lock_id === snapshot.resolution_lock_id
    && currentState.current_configuration_revision_id === snapshot.configuration_revision_id;
}

type TransactionCommand = Parameters<SqliteDatabase["transaction"]>[0][number];

function snapshotObservationBatchIds(value: string): readonly string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>)["source_observation_batch_ids"])) return [];
    return (parsed as { source_observation_batch_ids: unknown[] }).source_observation_batch_ids.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function candidateAgreesWithFrozenBase(candidate: IndexCandidate, base: CandidatePublicationInput["frozen_base"]): boolean {
  return candidate.base_snapshot_id === base.snapshot_id
    && candidate.base_generation === base.generation
    && candidate.base_registry_snapshot_id === base.registry_snapshot_id
    && candidate.base_configuration_revision_id === base.configuration_revision_id
    && JSON.stringify(normalizeObservationBatchIds(candidate.source_observation_batch_ids)) === JSON.stringify(normalizeObservationBatchIds(base.source_observation_batch_ids));
}

function sameCandidateImmutablePayload(left: IndexCandidate, right: IndexCandidate): boolean {
  const immutable = (candidate: IndexCandidate): unknown => Object.fromEntries(Object.entries({
    candidate_generation_id: candidate.candidate_generation_id,
    workspace_id: candidate.workspace_id,
    base_snapshot_id: candidate.base_snapshot_id,
    base_generation: candidate.base_generation,
    base_registry_snapshot_id: candidate.base_registry_snapshot_id,
    target_registry_snapshot_id: candidate.target_registry_snapshot_id,
    base_configuration_revision_id: candidate.base_configuration_revision_id,
    target_configuration_revision_id: candidate.target_configuration_revision_id,
    trigger_kind: candidate.trigger_kind,
    source_observation_batch_ids: normalizeObservationBatchIds(candidate.source_observation_batch_ids),
    created_at: candidate.created_at,
  }).filter(([, value]) => value !== undefined));
  return sameCandidateBytes(encodeCanonical(immutable(left)), encodeCanonical(immutable(right)));
}

function sameCandidateBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
