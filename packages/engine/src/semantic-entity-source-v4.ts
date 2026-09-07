// v4 storage wiring (2026-09-07, plan `generic-waddling-hartmanis.md` §4):
// builds a `SemanticEntityRecordSource` (`semantic-reconciler.ts`) on top of
// the native structural store's `CanonicalQuerySnapshotPort`, so
// `reconcileSemanticProjection`'s entity-grain lane (steps 4/5 plus the two
// entity-shaped `syncDocumentStatusBulk` statements) can run against a v4
// workspace, whose catalog schema drops `record_occurrences`/
// `record_value_nodes` entirely (docs/evidence/2026-09-02-v4-p2-1-schema.md).
//
// `artifact_versions`/`source_artifacts` -- the owning-file CAS metadata a
// candidate entity's text render needs -- ARE kept byte-identical between v3
// and v4, so this reads them with the exact plain SQL any v3-serving code
// already uses (`input.database`, the SAME connection `reconcileSemanticProjection`
// itself runs against, with the v4 semantic sidecar already ATTACHed by the
// caller -- see `packages/daemon/src/semantic-maintenance-process.ts`).
//
// This file deliberately does NOT import `NativeCanonicalQuerySnapshotPort`
// (or anything from `native-structural-store-binding.ts`) directly: the
// caller already has a constructed port (real native port in production,
// any fake satisfying `EntityScanPort` in a test) and hands it in, keeping
// this module -- and its own test coverage -- decoupled from the native
// addon loader.
import type { QueryScope } from "@urdira/contracts";
import type { SqliteDatabase } from "@urdira/storage";
import type { CanonicalQueryRecord } from "./canonical-query-data-port.js";
import type { SemanticEntityCandidateRow, SemanticEntityRecordSource } from "./semantic-reconciler.js";

/** The minimal `CanonicalQuerySnapshotPort` surface this source needs -- both `NativeCanonicalQuerySnapshotPort` and `SqliteCanonicalQuerySnapshotPort` (`canonical-query-data-port.ts`) already implement this shape with non-optional methods. */
export interface EntityScanPort {
  records_for_query(scope: QueryScope): Promise<readonly CanonicalQueryRecord[]>;
  records_by_ids(scope: QueryScope, ids: readonly string[]): Promise<readonly CanonicalQueryRecord[]>;
}

/** Bounds each `artifact_versions`/`source_artifacts` lookup's `IN (...)` list and each `records_by_ids` batch -- same rationale/magnitude as `canonical-query-data-port.ts`'s own `DELTA_ID_CHUNK_SIZE`. */
const ID_CHUNK_SIZE = 200;

function chunk<T>(values: readonly T[], size: number): readonly T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

interface OwnerFileMeta {
  readonly content_hash: string;
  readonly byte_length: number;
  readonly display_path: string | null;
  readonly encoding: string;
}

/**
 * Real v4-storage `SemanticEntityRecordSource`. Two documented
 * simplifications versus the v3 default source (both decided in
 * implementation, plan §0's "correctness over historical exactness" -- see
 * `SemanticEntityRecordSource.visibleRecordIds`'s own doc comment for the
 * second one):
 *  - `entityCandidates()` is a FULL scan of the workspace's visible corpus
 *    (`port.records_for_query`, itself internally paginated/yielding -- see
 *    `NativeCanonicalQuerySnapshotPort.records_for_query_batches`), filtered
 *    to `category === "entity"` client-side: the native store's selector
 *    pushdown (`records_by_selector`) bounds its own combo expansion and is
 *    not guaranteed to return every match unbounded, so the always-correct
 *    full scan is used here instead, exactly like every OTHER "no bounded
 *    pushdown available" fallback already in this codebase.
 */
export function createNativeSemanticEntityRecordSource(input: {
  readonly database: SqliteDatabase;
  readonly port: EntityScanPort;
  readonly workspace_id: string;
}): SemanticEntityRecordSource {
  const scope: QueryScope = { scope_type: "single_workspace", workspace_id: input.workspace_id };
  return {
    async visibleRecordIds(ids: readonly string[]): Promise<ReadonlySet<string>> {
      if (ids.length === 0) return new Set();
      const found = new Set<string>();
      for (const idsChunk of chunk(ids, ID_CHUNK_SIZE)) {
        const rows = await input.port.records_by_ids(scope, idsChunk);
        for (const row of rows) found.add(row.record_id);
      }
      return found;
    },
    async entityCandidates(): Promise<readonly SemanticEntityCandidateRow[]> {
      const records = (await input.port.records_for_query(scope)).filter((record) => record.category === "entity");
      if (records.length === 0) return [];
      const ownerVersionIds = [...new Set(records.map((record) => record.owner_artifact_version_id))];
      const ownerMeta = new Map<string, OwnerFileMeta>();
      for (const idsChunk of chunk(ownerVersionIds, ID_CHUNK_SIZE)) {
        const placeholders = idsChunk.map(() => "?").join(", ");
        const rows = await input.database.all<{ artifact_version_id: string; content_hash: string; byte_length: number; encoding: string; display_path: string | null }>(
          `SELECT version.artifact_version_id AS artifact_version_id, version.content_hash AS content_hash, version.byte_length AS byte_length, version.encoding AS encoding, source_artifacts.display_path AS display_path
             FROM artifact_versions AS version
             LEFT JOIN source_artifacts ON source_artifacts.workspace_id = version.workspace_id AND source_artifacts.artifact_id = version.artifact_id
            WHERE version.workspace_id = ? AND version.artifact_version_id IN (${placeholders})`,
          [input.workspace_id, ...idsChunk],
        );
        for (const row of rows) ownerMeta.set(row.artifact_version_id, row);
      }
      const out: SemanticEntityCandidateRow[] = [];
      for (const record of records) {
        // `record_kind` never legitimately points at a `jsts:entity_container`
        // whose owner is unknown/binary in practice, but this guard means a
        // dangling/unresolvable owner (should not happen for a real scan)
        // is silently dropped, matching the v3 query's own `JOIN` semantics
        // (an entity row with no matching `artifact_versions` row is simply
        // absent from its result set too).
        const meta = ownerMeta.get(record.owner_artifact_version_id);
        if (meta === undefined || meta.encoding === "binary") continue;
        out.push({
          record_id: record.record_id,
          record_kind: record.kind,
          owner_artifact_id: record.owner_artifact_id,
          owner_artifact_version_id: record.owner_artifact_version_id,
          content_hash: meta.content_hash,
          byte_length: meta.byte_length,
          display_path: meta.display_path,
          body: record.body,
        });
      }
      out.sort((left, right) => left.owner_artifact_version_id.localeCompare(right.owner_artifact_version_id) || left.record_id.localeCompare(right.record_id));
      return out;
    },
  };
}
