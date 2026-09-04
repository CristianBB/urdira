/**
 * v3 -> native structural store converter (v4 plan P2-5): materializes the
 * rows of a v3 workspace SQLite database, as visible at one generation,
 * into a native structural-store `base-<generation>` directory via
 * `NativeStoreBuilder`. Exists so `NativeCanonicalQuerySnapshotPort` can be
 * tested against real indexed fixtures TODAY, before the v4 Rust cold
 * pipeline (P2-2) exists.
 *
 * Row mapping mirrors the measured v3->v4 mapping in the P0-S1 spike
 * (`crates/urdira-v4-spike/src/load.rs`, `scripts/v4-spike-extract-relations.mjs`):
 * relation records decode `source_id`/`target_id` out of their own
 * canonical body via `decodeCanonical`, artifact_dependencies map straight
 * across, and `record_facets` group into one array per record.
 *
 * Scope: a COLD, single-generation snapshot -- every converted row is
 * written with `valid_from = 1` (open) at the target store's own
 * generation `1` (independent of whatever the v3 workspace's generation
 * number was), since this converter's only job is "make one v3 snapshot
 * queryable through the native port for testing", not incremental
 * replay. See the evidence doc for why `owner_artifact`/`owner_version`
 * intentionally reference the SAME interned `(artifact_id,
 * artifact_version_id)` pair ordinal (correct for a single-generation
 * snapshot; a future incremental producer needs an artifact_id-only
 * ordinal space for `by_owner` to aggregate a file across versions).
 */
import { decodeCanonical } from "@urdira/canonical";
import type { SqliteDatabase } from "@urdira/storage";
import { writeStructuralStore } from "@urdira/storage";
import { loadNativeStructuralStoreAddon, type NativeInputDependencyRow, type NativeInputRecordRow } from "./native-structural-store-binding.js";

const RECORD_BATCH_SIZE = 2_000;

type RecordSourceRow = {
  readonly record_id: string;
  readonly category: string;
  readonly kind: string;
  readonly universal_kind: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly primary_source_span_artifact_version_id: string | null;
  readonly primary_source_span_start_byte: string | number | null;
  readonly primary_source_span_end_byte: string | number | null;
  readonly primary_source_span_start_line: string | number | null;
  readonly primary_source_span_end_line: string | number | null;
  readonly body_payload: Uint8Array | ArrayBuffer | null;
  readonly identity_id: string | null;
  readonly identity_key: string | null;
};

function bytes(value: Uint8Array | ArrayBuffer | null): Uint8Array {
  if (value === null) return new Uint8Array(0);
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function toU32(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function relationSubjects(row: RecordSourceRow): { readonly sourceSubject?: string; readonly targetSubject?: string } {
  if (row.category !== "relation" || row.body_payload === null) return {};
  try {
    const decoded = decodeCanonical(bytes(row.body_payload)) as Record<string, unknown>;
    const sourceId = decoded["source_id"];
    const targetId = decoded["target_id"];
    return {
      ...(typeof sourceId === "string" ? { sourceSubject: sourceId } : {}),
      ...(typeof targetId === "string" ? { targetSubject: targetId } : {}),
    };
  } catch {
    return {};
  }
}

export interface ConvertV3WorkspaceToNativeStoreOptions {
  /** When true, sets `workspace_meta.structural_store = "native"` on
   * `database` after a successful conversion (default: false -- callers
   * that only want a store to test against, without flipping the
   * workspace's own port selection, get that by omitting this). */
  readonly setStructuralStoreMeta?: boolean;
}

export interface ConvertV3WorkspaceToNativeStoreResult {
  readonly recordCount: number;
  readonly dependencyCount: number;
  readonly generation: number;
  readonly recordsRoot: string;
  readonly dependencyRoot: string;
}

/** Converts every row of `database` (a v3 `workspace.sqlite` connection)
 * visible at `generation`, for `workspaceId`, into a native structural
 * store written to `dir`. */
export async function convertV3WorkspaceToNativeStore(
  database: SqliteDatabase,
  workspaceId: string,
  generation: number,
  dir: string,
  options: ConvertV3WorkspaceToNativeStoreOptions = {},
): Promise<ConvertV3WorkspaceToNativeStoreResult> {
  const addon = loadNativeStructuralStoreAddon();

  const versionToArtifact = new Map<string, string>();
  for (const row of await database.all<{ artifact_version_id: string; artifact_id: string }>(
    "SELECT artifact_version_id, artifact_id FROM artifact_versions WHERE workspace_id = ?",
    [workspaceId],
  )) versionToArtifact.set(row.artifact_version_id, row.artifact_id);

  const builder = new addon.NativeStoreBuilder();
  builder.create(dir, generation);

  let cursor: string | undefined;
  let recordCount = 0;
  for (;;) {
    const cursorCondition = cursor === undefined ? "" : " AND ro.record_id > ?";
    const cursorParams = cursor === undefined ? [] : [cursor];
    const rows = await database.all<RecordSourceRow>(
      `SELECT ro.record_id, ro.category, ro.kind, ro.universal_kind, ro.owner_artifact_id, ro.owner_artifact_version_id,
              ro.primary_source_span_artifact_version_id, ro.primary_source_span_start_byte, ro.primary_source_span_end_byte,
              ro.primary_source_span_start_line, ro.primary_source_span_end_line, ro.body_payload,
              identities.identity_id, identities.identity_key
         FROM record_occurrences AS ro
         LEFT JOIN identity_assignments AS identities
           ON identities.workspace_id = ro.workspace_id AND identities.record_id = ro.record_id
          AND identities.valid_from_generation <= ? AND (identities.valid_to_generation IS NULL OR identities.valid_to_generation > ?)
        WHERE ro.workspace_id = ? AND ro.valid_from_generation <= ? AND (ro.valid_to_generation IS NULL OR ro.valid_to_generation > ?)${cursorCondition}
        ORDER BY ro.record_id
        LIMIT ?`,
      [generation, generation, workspaceId, generation, generation, ...cursorParams, RECORD_BATCH_SIZE],
    );
    if (rows.length === 0) break;

    const ids = rows.map((row) => row.record_id);
    const placeholders = ids.map(() => "?").join(", ");
    const facetRows = await database.all<{ record_id: string; facet: string }>(
      `SELECT record_id, facet FROM record_facets WHERE workspace_id = ? AND record_id IN (${placeholders}) ORDER BY record_id, facet_ordinal`,
      [workspaceId, ...ids],
    );
    const facetsByRecord = new Map<string, string[]>();
    for (const facet of facetRows) {
      const list = facetsByRecord.get(facet.record_id) ?? [];
      list.push(facet.facet);
      facetsByRecord.set(facet.record_id, list);
    }

    const batch: NativeInputRecordRow[] = rows.map((row) => {
      const recordIdHex = row.record_id.startsWith("record:") ? row.record_id.slice("record:".length) : row.record_id;
      const spanVersionId = row.primary_source_span_artifact_version_id;
      const spanArtifactId = spanVersionId === null ? undefined : versionToArtifact.get(spanVersionId);
      const spanStartByte = toU32(row.primary_source_span_start_byte);
      const spanEndByte = toU32(row.primary_source_span_end_byte);
      const spanStartLine = toU32(row.primary_source_span_start_line);
      const spanEndLine = toU32(row.primary_source_span_end_line);
      const { sourceSubject, targetSubject } = relationSubjects(row);
      return {
        recordIdHex,
        ownerArtifactId: row.owner_artifact_id,
        ownerArtifactVersionId: row.owner_artifact_version_id,
        validFrom: 1,
        validTo: 0,
        category: row.category as NativeInputRecordRow["category"],
        kind: row.kind,
        universalKind: row.universal_kind,
        facets: facetsByRecord.get(row.record_id) ?? [],
        ...(spanVersionId !== null && spanArtifactId !== undefined ? { spanArtifactId, spanArtifactVersionId: spanVersionId } : {}),
        ...(spanStartByte !== undefined ? { spanStartByte } : {}),
        ...(spanEndByte !== undefined ? { spanEndByte } : {}),
        ...(spanStartLine !== undefined ? { spanStartLine } : {}),
        ...(spanEndLine !== undefined ? { spanEndLine } : {}),
        ...(row.identity_id !== null ? { identityId: row.identity_id } : {}),
        ...(row.identity_key !== null ? { identityKey: row.identity_key } : {}),
        // `relationKind` becomes the native store's `IndexedGraphEdge.relation_kind`
        // (see `native-query-snapshot-port.ts`'s `adjacency`/`relation_pairs_by_subject_ids`
        // mapping) -- set to `universal_kind`, not the language-specific
        // `kind`, because `SqliteCanonicalQuerySnapshotPort.relation_pairs_by_subject_ids`
        // is the one real (if effectively dead-in-production -- see the
        // evidence doc) consumer of a relation's "kind" for filtering, and
        // it filters `graph_edges.relation_kind` against a selector's
        // `universal_kinds` dimension.
        ...(row.category === "relation" ? { relationKind: row.universal_kind } : {}),
        ...(sourceSubject !== undefined ? { sourceSubject } : {}),
        ...(targetSubject !== undefined ? { targetSubject } : {}),
        bodyPayload: bytes(row.body_payload),
      };
    });
    builder.addRecords(batch);
    recordCount += batch.length;
    cursor = ids[ids.length - 1];
    if (rows.length < RECORD_BATCH_SIZE) break;
  }

  const depRows = await database.all<{
    record_id: string;
    owner_artifact_id: string;
    owner_artifact_version_id: string;
    dependency_artifact_id: string;
    dependency_artifact_version_id: string;
    dependency_role: string;
  }>(
    `SELECT record_id, owner_artifact_id, owner_artifact_version_id, dependency_artifact_id, dependency_artifact_version_id, dependency_role
       FROM artifact_dependencies
      WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)
      ORDER BY dependency_entry_id`,
    [workspaceId, generation, generation],
  );
  const depBatch: NativeInputDependencyRow[] = depRows.map((row) => ({
    recordIdHex: row.record_id.startsWith("record:") ? row.record_id.slice("record:".length) : row.record_id,
    ownerArtifactId: row.owner_artifact_id,
    ownerArtifactVersionId: row.owner_artifact_version_id,
    depArtifactId: row.dependency_artifact_id,
    depArtifactVersionId: row.dependency_artifact_version_id,
    role: row.dependency_role,
    validFrom: 1,
    validTo: 0,
  }));
  if (depBatch.length > 0) builder.addDependencies(depBatch);

  const summary = builder.finish();

  if (options.setStructuralStoreMeta === true) await writeStructuralStore(database, "native");

  return {
    recordCount,
    dependencyCount: depBatch.length,
    generation: summary.generation,
    recordsRoot: summary.recordsRoot,
    dependencyRoot: summary.dependencyRoot,
  };
}
