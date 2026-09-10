import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { encodeCanonical } from "@urdira/canonical";
import {
  ensureSemanticSidecarSchemaCompatibilityV4,
  openSqliteDatabase,
  V4_IDENTITY_FORMAT,
  WORKSPACE_V4_INDEX_CONTRACT,
  WORKSPACE_V4_LEXICAL_SCHEMA,
  WORKSPACE_V4_SCHEMA,
  WORKSPACE_V4_SEMANTIC_SCHEMA,
  writeStructuralStore,
  type DurableStorage,
} from "@urdira/storage";

/**
 * v4 daemon wiring (plan `resilient-knitting-twilight.md` §1/§9, task
 * P2-7). Creates (idempotently) the on-disk layout a brand-new v4 workspace
 * needs BEFORE `DurableStorage.registerWorkspace`/`openWorkspace` ever touch
 * it: the catalog SQLite file itself (schema `WORKSPACE_V4_SCHEMA`, stamped
 * with `index_contract=0x34`/`identity_format=3`/`structural_store=native`
 * -- the same three `workspace_meta` facts `scripts/v4-scan.mjs`'s harness
 * stamps by hand), plus the sibling `<db>.structural/` and `<db>.sidecar/`
 * directories the Rust `WorkspaceScan` command writes into.
 *
 * Doing this BEFORE registration matters: `DurableStorage.registerWorkspace`/
 * `openWorkspace` (`packages/storage/src/storage.ts`) both now read back the
 * `index_contract` byte of whatever file is already on disk at the
 * workspace's default path to decide whether to run v3 or v4
 * schema/compatibility checks (see `readIndexContractByte`, added for this
 * task) -- a file that does not exist yet is ALWAYS treated as a fresh v3
 * workspace (there is nothing to detect). So the only way a workspace ends
 * up on the v4 path is for this function to have created its file, with the
 * v4 marker already stamped, first.
 *
 * `cas_root` is deliberately NOT a private per-workspace directory (unlike
 * `scripts/v4-scan.mjs`'s CLI harness, which is a standalone tool with no
 * shared installation): it is `storage.cas.rootDir`, the SAME
 * installation-wide CAS every v3 workspace already shares (`DurableStorage.cas`,
 * `<data_root>/cas`) and the same root `SqliteCanonicalQuerySnapshotPort`
 * reads from for `core:get_source`/`artifact_text` (`packages/daemon/src/runtime.ts`'s
 * `acquireWorkspaceQueryEngine`, which always constructs that port with
 * `storage.cas` regardless of whether the native or SQLite structural port
 * ends up serving structural reads). If the Rust `WorkspaceScan` pipeline
 * wrote source bytes into a workspace-private CAS instead, `get_source`
 * would look for them in the wrong place and fail closed.
 *
 * Idempotent: a second call for the same workspace id, once the file
 * already exists (v4-stamped or not), only recomputes and returns the same
 * paths -- it never re-execs the schema or re-stamps meta rows. Callers
 * (`packages/daemon/src/runtime.ts`) rely on this to call it unconditionally
 * on every scan of a `URDIRA_V4=1`-selected workspace, not just the first.
 *
 * Not fully race-proof: unlike `registerWorkspaceSerialized`/`openWorkspace`,
 * this does not take the `<db>.urdira-writer.lock` mutation lock before
 * creating the file (that lock is private to `storage.ts`). Two concurrent
 * first-ever calls for the same brand-new workspace id could both reach the
 * `!existsSync` branch and both `exec` the (idempotent, `CREATE TABLE IF NOT
 * EXISTS`) schema and `INSERT ... ON CONFLICT DO NOTHING` the same meta rows
 * against the same SQLite file; SQLite's own file locking (`busy_timeout`)
 * serializes the two connections' writes, so this races the outcome, not
 * correctness. `scheduleWorkspaceScan`'s own `scanInFlight` gating makes
 * this vanishingly unlikely in the daemon's real call pattern (documented,
 * not hardened further, given this task's scope).
 */
export interface EnsureV4WorkspaceInput {
  readonly storage: DurableStorage;
  readonly workspace_id: string;
  /** Skip even the empty semantic sidecar schema when semantic indexing is disabled. */
  readonly create_semantic_sidecar?: boolean;
}

export interface V4WorkspacePaths {
  readonly database_path: string;
  readonly structural_root: string;
  readonly cas_root: string;
  readonly sidecar_root: string;
}

/**
 * `<db>.structural/`: sibling of the workspace catalog file, using the same
 * "strip `.sqlite`, append a suffix" convention `WorkspaceDatabase.openSidecar`
 * (`packages/storage/src/storage.ts`) uses for `<db>.lexical.sqlite`/
 * `<db>.semantic.sqlite` (plan §2.1's directory layout,
 * docs/evidence/2026-09-02-v4-p2-1-schema.md §5). This is the single source
 * of truth for that path -- `packages/daemon/src/runtime.ts` imports this
 * function rather than keeping its own copy.
 */
export function structuralStoreDirFor(databasePath: string): string {
  return resolve(dirname(databasePath), `${stripSqliteSuffix(databasePath)}.structural`);
}

/**
 * `<db>.sidecar/`: the directory threaded through as `WorkspaceScanRequest.sidecar_root`
 * (the Rust-side parameter -- see `crates/urdira-worker-protocol`). Distinct
 * from, and unrelated to, the TypeScript lexical/semantic sidecar FILES
 * (`<db>.lexical.sqlite`/`<db>.semantic.sqlite`) `WorkspaceDatabase.openSidecar`
 * creates: per docs/evidence/2026-09-02-v4-p2-2b-cold-pipeline.md §8, nothing
 * writes into the Rust-side `sidecar_root` yet (P2-6 stub) -- this directory
 * only needs to exist so `validateWorkspaceScanRequest`'s absolute-path
 * check has somewhere real to point at.
 */
export function sidecarScanDirFor(databasePath: string): string {
  return resolve(dirname(databasePath), `${stripSqliteSuffix(databasePath)}.sidecar`);
}

function stripSqliteSuffix(databasePath: string): string {
  const fileName = basename(databasePath);
  return fileName.endsWith(".sqlite") ? fileName.slice(0, -".sqlite".length) : fileName;
}

/**
 * `<db>.lexical.sqlite` / `<db>.semantic.sqlite`: the SAME sibling-file path
 * `WorkspaceDatabase.openSidecar` (`packages/storage/src/storage.ts`)
 * computes internally (that computation is private to that module) --
 * duplicated here, deliberately, as the one other place P2-7 needs it: the
 * query-time ATTACH in `packages/daemon/src/runtime.ts`'s
 * `acquireWorkspaceQueryEngine` must agree on the exact same path
 * `ensureV4Workspace` below pre-creates the file at, and `openSidecar`
 * itself is instance-scoped (needs a live `WorkspaceDatabase`) so a pure
 * function is more useful at both call sites than importing it would be.
 */
export function sidecarDatabasePathFor(databasePath: string, kind: "lexical" | "semantic"): string {
  return resolve(dirname(databasePath), `${stripSqliteSuffix(databasePath)}.${kind}.sqlite`);
}

export async function ensureV4Workspace(input: EnsureV4WorkspaceInput): Promise<V4WorkspacePaths> {
  const { storage, workspace_id: workspaceId } = input;
  const databasePath = resolve(storage.defaultWorkspaceDatabasePath(workspaceId));
  const structuralRoot = structuralStoreDirFor(databasePath);
  const sidecarRoot = sidecarScanDirFor(databasePath);
  const casRoot = storage.cas.rootDir;
  await mkdir(dirname(databasePath), { recursive: true });
  await mkdir(structuralRoot, { recursive: true });
  await mkdir(sidecarRoot, { recursive: true });
  await mkdir(casRoot, { recursive: true });
  if (!existsSync(databasePath)) {
    const database = await openSqliteDatabase({ filename: databasePath });
    try {
      await database.exec(WORKSPACE_V4_SCHEMA);
      const insertMeta = "INSERT INTO workspace_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING";
      await database.run(insertMeta, ["index_contract", Uint8Array.of(WORKSPACE_V4_INDEX_CONTRACT)]);
      await database.run(insertMeta, ["identity_format", encodeCanonical(V4_IDENTITY_FORMAT)]);
      // Not `bindWorkspaceIdentity`'s `workspace_id` key: exactly like v3
      // (`registerWorkspaceSerialized` never stamps it either), that binding
      // is left to the first `DurableStorage.openWorkspace` call.
      await writeStructuralStore(database, "native");
    } finally {
      await database.close();
    }
  }
  // Pre-create and schema enabled sidecar files up front, at workspace creation
  // time -- not lazily on the first lexical/semantic maintenance pass --
  // so the query-time ATTACH in `acquireWorkspaceQueryEngine` can rely on
  // every enabled file existing (with its schema already applied) from the
  // workspace's very first query onward. A disabled semantic sidecar remains
  // absent until a later enabled bootstrap creates it. A read-only connection
  // cannot create a missing file when it ATTACHes one, and `core:search_text`
  // must not hard-fail with "no such table: lexical_index_state" just
  // because the first lexical pass has not completed yet -- it is meant to
  // serve partial (corpus-scan) results in that window instead
  // (`SqliteCanonicalQuerySnapshotPort.search_literal`'s own contract).
  const sidecarKinds = input.create_semantic_sidecar === false ? ["lexical"] as const : ["lexical", "semantic"] as const;
  for (const kind of sidecarKinds) {
    const sidecarPath = sidecarDatabasePathFor(databasePath, kind);
    // Frente S-B (R22): the semantic sidecar's own additive column migration
    // (`ensureSemanticSidecarSchemaCompatibilityV4`) must run even when the
    // file ALREADY exists -- a workspace bootstrapped before
    // `segment_index`/`segment_start`/`segment_end` existed would otherwise
    // never receive them. The lexical sidecar has no such migration yet, so
    // its own early-`continue` (skip entirely once the file exists) is
    // unchanged.
    if (existsSync(sidecarPath)) {
      if (kind === "semantic") {
        const sidecarDatabase = await openSqliteDatabase({ filename: sidecarPath });
        try {
          await ensureSemanticSidecarSchemaCompatibilityV4(sidecarDatabase);
        } finally {
          await sidecarDatabase.close();
        }
      }
      continue;
    }
    const sidecarDatabase = await openSqliteDatabase({ filename: sidecarPath });
    try {
      await sidecarDatabase.exec(kind === "lexical" ? WORKSPACE_V4_LEXICAL_SCHEMA : WORKSPACE_V4_SEMANTIC_SCHEMA);
      if (kind === "semantic") await ensureSemanticSidecarSchemaCompatibilityV4(sidecarDatabase);
    } finally {
      await sidecarDatabase.close();
    }
  }
  return { database_path: databasePath, structural_root: structuralRoot, cas_root: casRoot, sidecar_root: sidecarRoot };
}
