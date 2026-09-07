// v4 storage wiring (2026-09-07, plan `generic-waddling-hartmanis.md` §4):
// shared by `semantic-maintenance-process.ts` (the forked child that runs
// the real, threaded maintenance pass) and `runtime.ts`'s own in-process
// fallback branch (used only when a test injects `semantic_provider`/
// `semantic_runtime_hooks` directly) -- both need the IDENTICAL "is this a
// v4 workspace, and if so, ATTACH its semantic sidecar + build a native-
// backed entity source" logic, so it lives here once rather than twice.
//
// ATTACHing the semantic sidecar directly onto the workspace's OWN catalog
// connection (`database.database`) -- not the reverse (attaching the catalog
// onto a separately-opened sidecar connection, the way `submitLexicalMaintenance`'s
// v4 branch in `runtime.ts` does it) -- means `database` itself, INCLUDING
// its already-built `database.projections` (`WorkspaceProjectionRepository`,
// which `reconcileSemanticProjection` calls directly for
// `semanticIndexState()`), needs no wrapping/duck-typing at all: every
// unqualified table reference in `reconcileSemanticProjection`'s own SQL
// (catalog tables `artifact_versions`/`source_artifacts`/`workspace_current_state`
// live in `main`; sidecar tables `vector_projection_rows`/`semantic_document_status`/
// `semantic_index_state` live only in the ATTACHed `v4_semantic` schema)
// resolves correctly with zero changes to that shared reconciler. This
// mirrors exactly what `warmWorkspaceQueryEngine` (`runtime.ts`) already
// does for the READ path.
import { existsSync } from "node:fs";
import {
  createNativeSemanticEntityRecordSource,
  NativeCanonicalQuerySnapshotPort,
  sidecarDatabasePathFor,
  SqliteCanonicalQuerySnapshotPort,
  structuralStoreDirFor,
  type SemanticEntityRecordSource,
} from "@urdira/engine";
import { readStructuralStore, type ContentAddressedStore, type WorkspaceDatabase } from "@urdira/storage";

/**
 * `undefined` for a v3 (or not-yet-bootstrapped) workspace -- callers pass
 * that straight through as `ReconcileSemanticProjectionInput.entity_record_source`,
 * which keeps the original v3 SQL path completely unmodified. For a v4
 * workspace, ATTACHes the semantic sidecar (if not already attached -- see
 * `alreadyAttached`'s own comment) and returns a real `SemanticEntityRecordSource`.
 * Throws (never caught here) if the ATTACH itself fails -- every call site
 * already wraps its whole maintenance run in a best-effort try/catch that
 * logs and retries on the next pass, the same contract a missing sidecar
 * table would hit anyway.
 */
export async function resolveV4SemanticEntitySource(database: WorkspaceDatabase, content: ContentAddressedStore, workspaceId: string): Promise<SemanticEntityRecordSource | undefined> {
  const kind = await readStructuralStore(database.database);
  if (kind !== "native") return undefined;
  const structuralStoreDir = structuralStoreDirFor(database.database.filename);
  if (!existsSync(structuralStoreDir)) return undefined;
  const sidecarPath = sidecarDatabasePathFor(database.database.filename, "semantic");
  if (existsSync(sidecarPath)) {
    // `PRAGMA database_list` names every attachment already on this
    // connection -- guards a job that reuses a connection another code path
    // already attached (not expected for this package's own one-shot child
    // process, but keeps this function idempotent/safe to call twice on the
    // SAME `WorkspaceDatabase`, e.g. from a future caller or a test helper).
    const attached = await database.database.all<{ name: string }>("PRAGMA database_list");
    if (!attached.some((row) => row.name === "v4_semantic")) {
      await database.database.exec(`ATTACH DATABASE '${sidecarPath.replace(/'/g, "''")}' AS v4_semantic`);
    }
  }
  const sqlitePort = new SqliteCanonicalQuerySnapshotPort(database.database, content);
  const nativePort = NativeCanonicalQuerySnapshotPort.open(database.database, structuralStoreDir, sqlitePort);
  return createNativeSemanticEntityRecordSource({ database: database.database, port: nativePort, workspace_id: workspaceId });
}
