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

/**
 * Frente S-E (2026-09-07): the minimal `CanonicalQuerySnapshotPort` surface
 * this source needs. `records_for_query_batches` (NOT the one-shot
 * `records_for_query`) is REQUIRED -- see `entityCandidates`'s own doc
 * comment for why: this is the fix for a real, confirmed OOM (a semantic
 * maintenance child crashing with `FATAL ERROR: ... JavaScript heap out of
 * memory` at n8n scale, `docs/evidence/2026-09-07-v4-semantic-embed-performance-and-latency.md`
 * §0.2). Both `NativeCanonicalQuerySnapshotPort` and
 * `SqliteCanonicalQuerySnapshotPort` (`canonical-query-data-port.ts`)
 * already implement this shape with non-optional methods.
 */
export interface EntityScanPort {
  records_for_query_batches(scope: QueryScope, batch_size?: number): AsyncIterable<readonly CanonicalQueryRecord[]>;
  records_by_ids(scope: QueryScope, ids: readonly string[]): Promise<readonly CanonicalQueryRecord[]>;
}

/** Bounds each `artifact_versions`/`source_artifacts` lookup's `IN (...)` list and each `records_by_ids` batch -- same rationale/magnitude as `canonical-query-data-port.ts`'s own `DELTA_ID_CHUNK_SIZE`. */
const ID_CHUNK_SIZE = 200;

/**
 * Frente S-E (2026-09-07): the page size `entityCandidates` requests from
 * `records_for_query_batches`. Bounds this source's own peak memory to
 * O(page) -- one page of raw records, plus that page's own owner-metadata
 * map (at most `page` distinct owners) -- REGARDLESS of corpus size, fixing
 * the O(corpus) `entityCandidates()` used to cost (see this file's own
 * git-blame doc comment on the prior, materialize-everything shape). 2,000
 * is comfortably under `canonical-query-data-port.ts`'s own
 * `ROW_FETCH_BATCH_SIZE` ceiling and small enough that one page's worth of
 * decoded bodies never approaches a default Node heap's old-space limit
 * even for a verbose body shape.
 */
const ENTITY_CANDIDATE_PAGE_SIZE = 2_000;

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
 *  - `entityCandidates()` streams the workspace's visible corpus in bounded
 *    pages (`port.records_for_query_batches`, itself internally
 *    keyset-paginated -- see `NativeCanonicalQuerySnapshotPort.records_for_query_batches`),
 *    filtered to `category === "entity"` client-side per page: the native
 *    store's selector pushdown (`records_by_selector`) bounds its own combo
 *    expansion and is not guaranteed to return every match unbounded, so the
 *    always-correct full (paged) scan is used here instead, exactly like
 *    every OTHER "no bounded pushdown available" fallback already in this
 *    codebase.
 *
 * Frente S-E (2026-09-07, adversarial review): `entityCandidates()` USED TO
 * return `Promise<readonly SemanticEntityCandidateRow[]>` -- ONE array
 * holding EVERY visible entity-category record, decoded, at once. At n8n
 * scale (326,817 entity-category candidates measured live,
 * `docs/evidence/2026-09-07-v4-n8n-parity-and-semantic-segments.md` §B.2)
 * this reliably OOMs a default-heap Node child (confirmed live, `FATAL
 * ERROR: ... JavaScript heap out of memory`) -- the ONLY prior mitigation
 * (`SEMANTIC_CHILD_MAX_OLD_SPACE_MB`, `packages/daemon/src/semantic-process.ts`)
 * raises the heap ceiling rather than fixing the eager materialization
 * itself. This function now takes a page CALLBACK instead of returning one
 * array: it streams `ENTITY_CANDIDATE_PAGE_SIZE`-row pages from
 * `records_for_query_batches`, resolving each page's OWN owner metadata
 * (never a corpus-wide owner-id set) before invoking `onPage`, so this
 * source's own peak memory is O(page), never O(corpus) -- see
 * `ENTITY_CANDIDATE_PAGE_SIZE`'s own doc comment. Every caller
 * (`semantic-reconciler.ts`'s container backfill and entity missing-insert
 * steps) now consumes pages incrementally instead of awaiting one array;
 * see that file's own doc comments on why each of its two consumers calls
 * this method separately (a streaming source cannot be "replayed" the way a
 * cached array could, so this trades one extra full corpus pass for bounded
 * memory -- a fair trade against an unconditional OOM). Order is NOT
 * globally sorted anymore (pages arrive in whatever order the underlying
 * store's own keyset pagination yields, likely NOT grouped by owner) --
 * callers that benefit from owner-version grouping for CAS text-read
 * locality (the entity missing-insert loop) must cache across page
 * boundaries themselves (a small bounded LRU, not a full sort).
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
    async entityCandidates(onPage: (page: readonly SemanticEntityCandidateRow[]) => Promise<void>): Promise<void> {
      for await (const rawBatch of input.port.records_for_query_batches(scope, ENTITY_CANDIDATE_PAGE_SIZE)) {
        const records = rawBatch.filter((record) => record.category === "entity");
        if (records.length === 0) continue;
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
        const page: SemanticEntityCandidateRow[] = [];
        for (const record of records) {
          // `record_kind` never legitimately points at a `jsts:entity_container`
          // whose owner is unknown/binary in practice, but this guard means a
          // dangling/unresolvable owner (should not happen for a real scan)
          // is silently dropped, matching the v3 query's own `JOIN` semantics
          // (an entity row with no matching `artifact_versions` row is simply
          // absent from its result set too).
          const meta = ownerMeta.get(record.owner_artifact_version_id);
          if (meta === undefined || meta.encoding === "binary") continue;
          page.push({
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
        if (page.length > 0) await onPage(page);
      }
    },
  };
}
