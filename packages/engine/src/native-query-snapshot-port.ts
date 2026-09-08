/**
 * v4 plan §7 / P2-5: `CanonicalQuerySnapshotPort` served from the native
 * structural segment store (`crates/urdira-structural-store`) via napi
 * (`crates/urdira-native-node/src/structural_store_napi.rs`). Structural
 * methods (records_by_ids/by_name/by_selector, container references,
 * graph adjacency, the general record-batch fallback) read the native
 * store directly; every non-structural method (catalog/artifact lookups,
 * `search_literal`, `semantic_*`, capability states, generation
 * resolution and snapshot-pin rejection) delegates to a wrapped
 * `SqliteCanonicalQuerySnapshotPort` over the SAME workspace database --
 * only the structural corpus (records, dependencies, adjacency) moves to
 * the native store; the catalog, snapshots, FTS, and vectors stay in
 * SQLite exactly as today (plan §9).
 *
 * `decodeRow` (`query-record-decode.ts`, extracted verbatim from the
 * SQLite port) is reused unchanged so both ports decode a record's body
 * identically, including the cross-port `RecordBodyInterner` sharing.
 *
 * See `docs/evidence/2026-09-02-v4-p2-5-native-port.md` for the full
 * method-mapping table, the `role`/`evidence_class`/`relation_kind`
 * synthesis conventions this port's `NativeStoreBuilder` producer picks
 * (the structural-store `RecordRow` has no dedicated fields for the
 * first two), and the test matrix comparing this port's answers against
 * `SqliteCanonicalQuerySnapshotPort` for the same seeded fixtures.
 */
import type { QueryScope, StructuralFilter } from "@urdira/contracts";
import type { SqliteDatabase } from "@urdira/storage";
import type {
  CanonicalQueryRecord,
  CanonicalQuerySnapshotPort,
  IndexedGraphEdge,
  LexicalSearchMatch,
  PendingSiteRow,
  RecordColumnSelector,
  SemanticAffectedDocumentRow,
  SemanticCoverageSummaryRow,
  SemanticDocumentStatusCounts,
  SemanticIndexStateSnapshot,
  SemanticVectorRow,
  SqliteCanonicalQuerySnapshotPort,
} from "./canonical-query-data-port.js";
import type { SnapshotCapabilityStateEntry } from "@urdira/contracts";
import {
  loadNativeStructuralStoreAddon,
  type NativeDictionaries,
  type NativeOutputRecordRow,
  type NativeStructuralStoreHandle,
} from "./native-structural-store-binding.js";
import { QueryPlanError } from "./query-plan.js";
import { decodeRow, object, type RecordRow } from "./query-record-decode.js";
import { INELIGIBLE_ENTITY_RECORD_KIND } from "./semantic-reconciler.js";
import type { RecordBodyInterner } from "./record-body-interner.js";

const VISIBLE_BATCH_SIZE = 4_096;
// Bounds `records_by_selector`'s (universal_kind x category x kind) combo
// expansion when one or more selector dimensions is omitted (meaning "any
// value") -- see that method's doc comment. Above this, pushdown declines
// (returns `undefined`) rather than issuing an unbounded number of native
// calls; the caller's documented fallback (the full in-memory scan) takes
// over, exactly as when any other optional pushdown capability is absent.
const SELECTOR_COMBO_CAP = 512;
// Frente Q-2 (2026-09-08): bounds on `records_by_ids`'s `otherIds`
// (identity_id/identity_key) resolution -- see that method's own doc
// comment for why these exist and why they cannot break the legitimate
// small-N graph-pushdown/selector-list callers that rely on this path.
const OTHER_IDS_COUNT_CAP = 1_000;
const OTHER_IDS_SCAN_ROW_BUDGET = 200_000;

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function recordIdHexOf(id: string): string | undefined {
  const prefix = "record:";
  if (!id.startsWith(prefix)) return undefined;
  const hex = id.slice(prefix.length);
  return /^[0-9a-f]{64}$/u.test(hex) ? hex : undefined;
}

function findArtifactOrdinal(dicts: NativeDictionaries, artifactId: string | undefined, artifactVersionId: string | undefined): number | undefined {
  if (artifactVersionId !== undefined) {
    const index = dicts.artifacts.findIndex((pair) => pair.artifactVersionId === artifactVersionId);
    if (index >= 0) return index;
  }
  if (artifactId !== undefined) {
    const index = dicts.artifacts.findIndex((pair) => pair.artifactId === artifactId);
    if (index >= 0) return index;
  }
  return undefined;
}

/** Served from `crates/urdira-native-node`'s `NativeStructuralStoreHandle`
 * (see module doc). Construct via `NativeCanonicalQuerySnapshotPort.open`. */
export class NativeCanonicalQuerySnapshotPort implements CanonicalQuerySnapshotPort {
  private constructor(
    private readonly database: SqliteDatabase,
    private readonly handle: NativeStructuralStoreHandle,
    private readonly sqlite: SqliteCanonicalQuerySnapshotPort,
    private readonly interner?: RecordBodyInterner,
  ) {}

  /**
   * Frente S-F (2026-09-08): `semantic_entity_scope_counts`'s own full
   * corpus walk (`scanAll`, an FFI batch call PER `VISIBLE_BATCH_SIZE` rows
   * plus a JS-side filter over every row) is O(corpus), not O(1) -- unlike
   * every other `semantic_*` method here, it cannot simply delegate to the
   * SQLite port, because `record_occurrences` (the table that method's
   * SQLite counterpart counts) is never populated when the structural
   * corpus lives in the native store (this class's own doc comment). Called
   * on EVERY `core:search_semantic`/`core:search_hybrid` -- measured live
   * at 5.0-5.4s on a 2,490-file/~40k-record real corpus (queueing every
   * OTHER concurrently-fired `semantic_*` call behind it on the same
   * connection, reproducing the exact multi-second symptom this frente's
   * own materialized-summary fix was built to eliminate for a DIFFERENT
   * cost center -- see `docs/evidence/2026-09-08-v4-semantic-latency-and-n8n-embed.md`).
   * The corpus this counts is immutable for a fixed `generation` (only a
   * NEW generation can change which entities are visible), so caching the
   * result by generation makes every call after the first, for the SAME
   * generation, an O(1) map lookup -- exactly the "warm/hot" scenario this
   * frente's own p99 target (`docs/evidence`'s "n8n completo caliente") is
   * about. Unbounded by design (one small integer per generation this port
   * instance has ever seen; a workspace's generation count over a daemon's
   * lifetime is not adversarial-sized).
   */
  private readonly entityScopeCountCache = new Map<number, number>();

  static open(database: SqliteDatabase, storeDir: string, sqlite: SqliteCanonicalQuerySnapshotPort, interner?: RecordBodyInterner): NativeCanonicalQuerySnapshotPort {
    const addon = loadNativeStructuralStoreAddon();
    const handle = addon.NativeStructuralStoreHandle.open(storeDir);
    return new NativeCanonicalQuerySnapshotPort(database, handle, sqlite, interner);
  }

  // --- generation / snapshot-pin resolution (duplicated, deliberately, from
  // `SqliteCanonicalQuerySnapshotPort.currentGeneration`/`rejectSnapshotPin`:
  // this is workspace-catalog SQL, not structural-store logic, and this
  // class is "a second, independent implementation of the query snapshot
  // port" per the task brief -- see the evidence doc for the tradeoff. ---
  private async currentGeneration(scope: QueryScope): Promise<number | undefined> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical native-store queries require one explicit workspace; comparison binds each participant separately.");
    const workspaceId = scope.workspace_id;
    if (scope.snapshot_id?.startsWith("source-snapshot:")) {
      const generation = Number(scope.snapshot_id.slice("source-snapshot:".length));
      if (!Number.isSafeInteger(generation) || generation < 1) throw new QueryPlanError("core:snapshot_not_found", `Source snapshot "${scope.snapshot_id}" is invalid.`);
      const source = await this.database.get<{ current_generation: number }>("SELECT current_generation FROM source_index_state WHERE workspace_id = ?", [workspaceId]);
      if (source === undefined || generation > source.current_generation) throw new QueryPlanError("core:snapshot_not_found", `Source snapshot "${scope.snapshot_id}" is not available for workspace "${workspaceId}".`);
      return generation;
    }
    const current = await this.database.get<{ current_generation: number; current_snapshot_id: string }>("SELECT current_generation, current_snapshot_id FROM workspace_current_state WHERE workspace_id = ?", [workspaceId]);
    if (current === undefined) return undefined;
    if (scope.snapshot_id !== undefined && scope.snapshot_id !== current.current_snapshot_id) await this.rejectSnapshotPin(workspaceId, scope.snapshot_id, current.current_snapshot_id);
    return current.current_generation;
  }

  private async rejectSnapshotPin(workspaceId: string, requestedSnapshotId: string, currentSnapshotId: string): Promise<never> {
    const historical = await this.database.get<{ generation: number }>("SELECT generation FROM snapshots WHERE workspace_id = ? AND snapshot_id = ?", [workspaceId, requestedSnapshotId]);
    if (historical !== undefined) throw new QueryPlanError("core:snapshot_expired", `scope.snapshot_id "${requestedSnapshotId}" (generation ${historical.generation}) is no longer the current snapshot of workspace "${workspaceId}" (current snapshot: "${currentSnapshotId}"). Pinned historical-snapshot queries are not supported; re-query without a snapshot_id to read the current generation.`);
    throw new QueryPlanError("core:snapshot_not_found", `scope.snapshot_id "${requestedSnapshotId}" is not a known snapshot of workspace "${workspaceId}" (current snapshot: "${currentSnapshotId}").`);
  }

  /** Resolves the workspace's current generation (honoring/rejecting a
   * pinned `scope.snapshot_id` exactly like the SQLite port), then makes
   * sure the native store itself has caught up to at least that
   * generation -- the honest failure mode plan §7 calls for when the
   * store is behind, rather than silently serving a stale answer. */
  private async ensureGeneration(scope: QueryScope): Promise<number | undefined> {
    const generation = await this.currentGeneration(scope);
    if (generation === undefined) return undefined;
    this.handle.reopenIfChanged();
    const storeGeneration = this.handle.currentGeneration();
    if (storeGeneration < generation) {
      throw new QueryPlanError("core:snapshot_expired", `Native structural store is at generation ${storeGeneration}; workspace "${(scope as { readonly workspace_id: string }).workspace_id}" is at generation ${generation}. The store has not caught up yet.`);
    }
    return generation;
  }

  private decode(row: NativeOutputRecordRow, workspaceId: string): CanonicalQueryRecord {
    const input: RecordRow = {
      record_id: row.recordId,
      workspace_id: workspaceId,
      category: row.category,
      kind: row.kind,
      universal_kind: row.universalKind,
      owner_artifact_id: row.ownerArtifactId,
      owner_artifact_version_id: row.ownerArtifactVersionId,
      facet_rows: row.facetRows,
      body_payload: row.bodyPayload,
      primary_source_span_artifact_version_id: row.primarySourceSpanArtifactVersionId ?? null,
      primary_source_span_start_byte: row.primarySourceSpanStartByte ?? null,
      primary_source_span_end_byte: row.primarySourceSpanEndByte ?? null,
      primary_source_span_start_line: row.primarySourceSpanStartLine ?? null,
      primary_source_span_end_line: row.primarySourceSpanEndLine ?? null,
      identity_id: row.identityId ?? null,
      identity_key: row.identityKey ?? null,
    };
    return decodeRow(input, this.interner);
  }

  private *scanAll(generation: number): Generator<NativeOutputRecordRow> {
    let cursor: string | undefined;
    for (;;) {
      const batch = this.handle.iterVisibleBatch(generation, VISIBLE_BATCH_SIZE, cursor);
      yield* batch.rows;
      if (batch.nextCursor === undefined) return;
      cursor = batch.nextCursor;
    }
  }

  // --- structural methods, served from the native store -------------------

  readonly has_warm_records = async (): Promise<boolean> => false;

  /**
   * See `CanonicalQuerySnapshotPort.visible_record_count`'s own doc comment.
   * `NativeStructuralStoreHandle.visibleCount` (the napi binding over
   * `StoreReader::visible_count`) is an O(1)-ish header/dictionary read, not
   * a decode -- safe to call on every reach of the generic fallback guard.
   */
  async visible_record_count(scope: QueryScope): Promise<number> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical native-store queries require one explicit workspace; comparison binds each participant separately.");
    const generation = await this.ensureGeneration(scope);
    if (generation === undefined) return 0;
    return this.handle.visibleCount(generation);
  }

  /** No in-process record cache to size or evict -- every read goes
   * straight to the native store's own mmap segments (page-cache-backed,
   * not tracked by the daemon's JS-heap `URDIRA_WARM_RECORDS_BUDGET_MB`
   * loop). Present so `packages/daemon/src/runtime.ts`'s LRU eviction
   * loop can treat every cached workspace's `snapshot_port` uniformly
   * regardless of which port implementation backs it. */
  approxWarmBytes(): number {
    return 0;
  }

  evictWarmRecords(): void {
    // Frente S-F (2026-09-08): `entityScopeCountCache`'s own doc comment --
    // tiny (one integer per generation), but cleared here too so a
    // long-lived daemon's eviction loop has one uniform "drop everything
    // this port is caching" entry point, matching the SQLite port's own
    // `evictWarmRecords()` contract.
    this.entityScopeCountCache.clear();
  }

  async records(scope: QueryScope): Promise<readonly CanonicalQueryRecord[]> {
    return this.records_for_query(scope);
  }

  async records_for_query(scope: QueryScope): Promise<readonly CanonicalQueryRecord[]> {
    const out: CanonicalQueryRecord[] = [];
    for await (const batch of this.records_for_query_batches(scope)) out.push(...batch);
    return out;
  }

  async *records_for_query_batches(scope: QueryScope, batchSize = VISIBLE_BATCH_SIZE): AsyncIterable<readonly CanonicalQueryRecord[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical native-store queries require one explicit workspace; comparison binds each participant separately.");
    const generation = await this.ensureGeneration(scope);
    if (generation === undefined) return;
    let cursor: string | undefined;
    for (;;) {
      const batch = this.handle.iterVisibleBatch(generation, batchSize, cursor);
      if (batch.rows.length === 0) return;
      yield batch.rows.map((row) => this.decode(row, scope.workspace_id));
      if (batch.nextCursor === undefined) return;
      cursor = batch.nextCursor;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async records_by_ids(scope: QueryScope, ids: readonly string[]): Promise<readonly CanonicalQueryRecord[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical native-store queries require one explicit workspace; comparison binds each participant separately.");
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const generation = await this.ensureGeneration(scope);
    if (generation === undefined) return [];
    const found = new Map<string, CanonicalQueryRecord>();
    const hexIds: string[] = [];
    const otherIds = new Set<string>();
    for (const id of unique) {
      const hex = recordIdHexOf(id);
      if (hex !== undefined) hexIds.push(hex); else otherIds.add(id);
    }
    if (hexIds.length > 0) {
      for (const row of this.handle.recordsByIds(hexIds, generation)) found.set(row.recordId, this.decode(row, scope.workspace_id));
    }
    // `identity_id`/`identity_key` forms (the other two shapes a
    // `SubjectSelector` may carry) have no dedicated native index -- see the
    // evidence doc's documented gap. Q1 (2026-09-08, `docs/evidence/2026-09-
    // 08-v4-vscode-query-latency.md`) hardened the one-scan-per-call
    // fallback with an early exit once every requested id was found.
    //
    // Q-2 (2026-09-08, `docs/evidence/2026-09-08-v4-query-gaps-vscode.md`
    // gap 1) investigated rejecting `otherIds` outright instead of scanning
    // (as gap 1's own reproduction of the `core:index_status`-in-a-pipeline
    // OOM initially suggested) -- and found, via the EXISTING regression
    // test this file's own Q1 section added, that this call is NOT a rare
    // hand-built-selector edge case: `indexedGraphRecords`'s `hydrate()`
    // (`canonical-query-data-port.ts`) calls `records_by_ids` with the
    // adjacency index's OWN edge-endpoint subject ids on every
    // `find_references`/`get_outline`/`expand_relations`/`find_paths`
    // native-pushdown call, and `structural_store_napi.rs`'s `adjacency`
    // (`subject_text_for`) returns those endpoints as their ORIGINAL
    // identity_key TEXT whenever the store's text sidecar has one (the
    // common case for a real v4 workspace) -- rejecting outright would have
    // made the native pushdown for all four operations decline (or error)
    // on ordinary use, not just on `core:index_status`'s misuse. Confirmed
    // live: rejecting broke `tests/native-query-snapshot-port.test.ts`'s
    // own `find_references` pushdown regression test.
    //
    // `core:index_status`'s ACTUAL OOM route was never this method -- it
    // was `CanonicalRecordQueryDataPort.execute`'s generic `records_for_query`
    // fallback (fixed separately, `rejectNonSubjectPipelineOperation`,
    // `canonical-query-data-port.ts`). What DOES remain a genuine residual
    // risk here, independent of that fix, is the ORIGINAL Q1 gap Q1 itself
    // only partially closed: a SINGLE id that does not exist (or is not
    // reached until near the end of key order) still forces a scan of the
    // ENTIRE visible generation before giving up, with no cap -- `§0`
    // (rendimiento sin comprometer integridad) requires bounding that
    // worst case too, without breaking the graph-pushdown's small, bounded,
    // legitimate identity_key resolutions above. Two independent bounds,
    // applied in order:
    //  1. `otherIds.size` above `OTHER_IDS_COUNT_CAP` is not a shape any
    //     legitimate caller produces (a hand-built selector list, a
    //     `build_context` seeds array, or one BFS frontier's edge endpoints
    //     are all small) -- reject immediately, typed, without scanning.
    //  2. Otherwise scan with the SAME early exit as before, but ALSO stop
    //     once `OTHER_IDS_SCAN_ROW_BUDGET` rows have been visited even if
    //     ids remain unresolved -- turning "always up to O(corpus)" into
    //     "at most `min(corpus, OTHER_IDS_SCAN_ROW_BUDGET)`". Ids still
    //     unresolved when the budget is hit are simply absent from the
    //     result, exactly like an id that turns out not to exist at all --
    //     every existing caller already tolerates `records_by_ids`
    //     returning fewer records than ids requested (`hydrate`'s
    //     `records.set` loop, `tryBuildContextPushdown`'s/`get_source`
    //     pushdown's `Map`-dedup-by-whatever-was-found), so this never
    //     regresses correctness -- it only bounds worst-case cost.
    if (otherIds.size > OTHER_IDS_COUNT_CAP) {
      throw new QueryPlanError(
        "core:selector_unresolvable",
        `Workspace "${scope.workspace_id}" received ${otherIds.size} identity_id/identity_key-shaped record selectors in one records_by_ids call, above the ${OTHER_IDS_COUNT_CAP} bound the native v4 structural store's linear identity scan accepts per call. Resolve in smaller batches, or prefer the record's own record_id (record:<hex>) -- every ResultSubject already carries one.`,
        { workspace_id: scope.workspace_id, unresolved_ids: [...otherIds].slice(0, 50) },
      );
    }
    if (otherIds.size > 0) {
      let remaining = otherIds.size;
      let scanned = 0;
      for (const row of this.scanAll(generation)) {
        scanned += 1;
        if (!found.has(row.recordId) && ((row.identityId !== undefined && otherIds.has(row.identityId)) || (row.identityKey !== undefined && otherIds.has(row.identityKey)))) {
          found.set(row.recordId, this.decode(row, scope.workspace_id));
          remaining -= 1;
          if (remaining <= 0) break;
        }
        if (scanned >= OTHER_IDS_SCAN_ROW_BUDGET) break;
      }
    }
    return [...found.values()];
  }

  async records_by_name(scope: QueryScope, name: string): Promise<readonly CanonicalQueryRecord[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical native-store queries require one explicit workspace; comparison binds each participant separately.");
    const generation = await this.ensureGeneration(scope);
    if (generation === undefined) return [];
    return this.handle.recordsByName(name, generation).map((row) => this.decode(row, scope.workspace_id));
  }

  /**
   * Decomposes a `RecordColumnSelector` (whose `categories`/`universal_kinds`/`kinds`
   * arrays are each independently optional and multi-valued) into a bounded
   * set of `(universal_kind, category[, kind])` combos the native store's
   * `by_kind` range index can answer directly. Each combo is capped at
   * `limit` (sorted by `record_id` within the combo, exactly like the
   * store's own `by_kind`); merging combos and re-sorting/re-slicing to
   * `limit` globally is still correct because a record in the true global
   * top-`limit` can never rank outside the top-`limit` of its OWN combo's
   * sorted range.
   *
   * Frente Q-3 (2026-09-08): when `selector.kinds` is omitted/empty (the
   * caller wants "any kind" -- e.g. `core:inspect_architecture`'s pushdown
   * asking for every `core:container`/`core:type` entity, regardless of the
   * producer-specific `kind` string), this used to default `kinds` to
   * `dicts.kinds` -- EVERY kind string in the WHOLE store, across every
   * category and universal_kind, not scoped to what was actually asked for
   * (the engine layer has no registry mapping a universal_kind to its own
   * kind strings; that mapping is plugin-local). That inflated `comboCount`
   * past `SELECTOR_COMBO_CAP` for realistic selectors and silently fell
   * back to the full-corpus `scanAll` branch below -- measured live on n8n
   * (2,198,601 records): 26.4-30.1s for two `inspect_architecture` calls,
   * exactly the "full scan disguised as a bounded call" this cap exists to
   * make rare. Now answered via `recordsByKindUniversal` (the native
   * `(universal_kind, category)` prefix range -- `by_kind`'s rows are
   * sorted by the full `(universal_kind_id, category, kind_id)` triple, so
   * every kind under one `(universal_kind, category)` is contiguous) --
   * one native call per `(category, universal_kind)` pair, no `kinds`
   * dimension in the combo count at all.
   *
   * This method's return type has no `undefined`/"decline" signal (unlike
   * e.g. `graph_edges_by_subject_ids`), so when the expansion would still be
   * unbounded (`SELECTOR_COMBO_CAP`) this falls back to one full
   * visible-corpus scan filtered in JS rather than ever answering
   * incorrectly -- slower, never wrong.
   */
  async records_by_selector(scope: QueryScope, selector: RecordColumnSelector, limit: number): Promise<readonly CanonicalQueryRecord[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical native-store queries require one explicit workspace; comparison binds each participant separately.");
    const generation = await this.ensureGeneration(scope);
    if (generation === undefined) return [];
    const dicts = this.handle.dictionaries();
    const categories = selector.categories !== undefined && selector.categories.length > 0 ? selector.categories : (["entity", "relation", "fact", "evidence", "diagnostic"] as const);
    const universalKinds = selector.universal_kinds !== undefined && selector.universal_kinds.length > 0 ? selector.universal_kinds : dicts.universalKinds;
    const explicitKinds = selector.kinds !== undefined && selector.kinds.length > 0 ? selector.kinds : undefined;
    const found = new Map<string, CanonicalQueryRecord>();
    if (explicitKinds === undefined) {
      const comboCount = categories.length * universalKinds.length;
      if (comboCount > 0 && comboCount <= SELECTOR_COMBO_CAP) {
        for (const category of categories) {
          for (const universalKind of universalKinds) {
            for (const row of this.handle.recordsByKindUniversal(universalKind, category, generation, limit)) found.set(row.recordId, this.decode(row, scope.workspace_id));
          }
        }
        return [...found.values()].sort((left, right) => left.record_id.localeCompare(right.record_id)).slice(0, limit);
      }
    } else {
      const comboCount = categories.length * universalKinds.length * explicitKinds.length;
      if (comboCount > 0 && comboCount <= SELECTOR_COMBO_CAP) {
        for (const category of categories) {
          for (const universalKind of universalKinds) {
            for (const kind of explicitKinds) {
              for (const row of this.handle.recordsByKindExact(universalKind, category, kind, generation, limit)) found.set(row.recordId, this.decode(row, scope.workspace_id));
            }
          }
        }
        return [...found.values()].sort((left, right) => left.record_id.localeCompare(right.record_id)).slice(0, limit);
      }
    }
    const categorySet = selector.categories !== undefined && selector.categories.length > 0 ? new Set(selector.categories) : undefined;
    const universalKindSet = selector.universal_kinds !== undefined && selector.universal_kinds.length > 0 ? new Set(selector.universal_kinds) : undefined;
    const kindSet = explicitKinds !== undefined ? new Set(explicitKinds) : undefined;
    for (const row of this.scanAll(generation)) {
      if (categorySet !== undefined && !categorySet.has(row.category)) continue;
      if (universalKindSet !== undefined && !universalKindSet.has(row.universalKind)) continue;
      if (kindSet !== undefined && !kindSet.has(row.kind)) continue;
      found.set(row.recordId, this.decode(row, scope.workspace_id));
    }
    return [...found.values()].sort((left, right) => left.record_id.localeCompare(right.record_id)).slice(0, limit);
  }

  async container_records_by_artifact_references(scope: QueryScope, references: readonly string[]): Promise<readonly CanonicalQueryRecord[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical native-store queries require one explicit workspace; comparison binds each participant separately.");
    const unique = [...new Set(references)];
    if (unique.length === 0) return [];
    const generation = await this.ensureGeneration(scope);
    if (generation === undefined) return [];
    const placeholders = unique.map(() => "?").join(", ");
    const pairs = await this.database.all<{ artifact_id: string; artifact_version_id: string }>(
      `SELECT DISTINCT version.artifact_id AS artifact_id, version.artifact_version_id AS artifact_version_id
         FROM artifact_versions AS version
         LEFT JOIN source_artifacts AS artifact ON artifact.workspace_id = version.workspace_id AND artifact.artifact_id = version.artifact_id
        WHERE version.workspace_id = ? AND version.valid_from_generation <= ? AND (version.valid_to_generation IS NULL OR version.valid_to_generation > ?)
          AND (version.artifact_version_id IN (${placeholders}) OR version.artifact_id IN (${placeholders}) OR artifact.artifact_id IN (${placeholders}) OR artifact.normalized_path IN (${placeholders}) OR artifact.normalized_uri IN (${placeholders}))`,
      [scope.workspace_id, generation, generation, ...unique, ...unique, ...unique, ...unique, ...unique],
    );
    const dicts = this.handle.dictionaries();
    const found = new Map<string, CanonicalQueryRecord>();
    for (const pair of pairs) {
      const ordinal = findArtifactOrdinal(dicts, pair.artifact_id, pair.artifact_version_id);
      if (ordinal === undefined) continue;
      for (const row of this.handle.recordsByOwnerOrdinal(ordinal, generation)) {
        if (row.universalKind !== "core:container") continue;
        found.set(row.recordId, this.decode(row, scope.workspace_id));
      }
    }
    return [...found.values()].sort((left, right) => left.record_id.localeCompare(right.record_id));
  }

  async graph_edges_by_subject_ids(scope: QueryScope, subjectIds: readonly string[], direction: "inbound" | "outbound" | "both"): Promise<readonly IndexedGraphEdge[] | undefined> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical native-store queries require one explicit workspace; comparison binds each participant separately.");
    const generation = await this.ensureGeneration(scope);
    if (generation === undefined) return [];
    const unique = [...new Set(subjectIds)];
    if (unique.length === 0) return [];
    const directions = direction === "both" ? (["outbound", "inbound"] as const) : ([direction] as const);
    const found = new Map<string, IndexedGraphEdge>();
    for (const dir of directions) {
      for (const row of this.handle.adjacency(unique, dir, generation)) {
        found.set(row.edgeId, {
          edge_id: row.edgeId,
          source_subject_id: row.sourceSubjectId,
          target_subject_id: row.targetSubjectId,
          relation_record_id: row.relationRecordId,
          relation_kind: row.relationKind,
          role: row.role,
          evidence_class: row.evidenceClass,
        });
      }
    }
    return [...found.values()].sort((left, right) => left.relation_record_id.localeCompare(right.relation_record_id) || left.edge_id.localeCompare(right.edge_id));
  }

  async relation_pairs_by_subject_ids(scope: QueryScope, leftIds: readonly string[], rightIds: readonly string[], relationSelector: unknown, direction: "inbound" | "outbound" | "both"): Promise<ReadonlySet<string> | undefined> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical native-store queries require one explicit workspace; comparison binds each participant separately.");
    if (leftIds.length === 0 || rightIds.length === 0) return new Set();
    const generation = await this.ensureGeneration(scope);
    if (generation === undefined) return new Set();
    const uniqueLeft = [...new Set(leftIds)];
    const right = new Set(rightIds);
    const selector = object(relationSelector);
    const kinds = new Set(strings(selector["universal_kinds"]));
    const output = new Set<string>();
    const directions = direction === "both" ? (["outbound", "inbound"] as const) : ([direction] as const);
    for (const dir of directions) {
      for (const row of this.handle.adjacency(uniqueLeft, dir, generation)) {
        if (kinds.size > 0 && !kinds.has(row.relationKind)) continue;
        if (dir === "outbound" && right.has(row.targetSubjectId)) output.add(`${row.sourceSubjectId} ${row.targetSubjectId}`);
        if (dir === "inbound" && right.has(row.sourceSubjectId)) output.add(`${row.targetSubjectId} ${row.sourceSubjectId}`);
      }
    }
    return output;
  }

  /**
   * `core:get_outline`'s additive `pending_sites` stream source: every
   * visible `pending.sites` row (`crates/urdira-structural-store`) owned
   * by the artifact `artifactId`/`artifactVersionId` identify. Resolves
   * the ordinal exactly like `container_records_by_artifact_references`
   * does (`findArtifactOrdinal`, same function), then calls the native
   * handle's `pendingSitesByOwner` (mirrors `depsByOwner`'s ordinal-in/
   * rows-out shape). An unresolvable artifact (never scanned, or a
   * generation the store has not caught up to) returns `[]`, not an
   * error -- `pendingSitesStreamForOutline`'s own documented convention.
   */
  async pending_sites_by_owner_artifact(scope: QueryScope, artifactId: string, artifactVersionId: string): Promise<readonly PendingSiteRow[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical native-store queries require one explicit workspace; comparison binds each participant separately.");
    const generation = await this.ensureGeneration(scope);
    if (generation === undefined) return [];
    const dicts = this.handle.dictionaries();
    const ordinal = findArtifactOrdinal(dicts, artifactId, artifactVersionId);
    if (ordinal === undefined) return [];
    return this.handle.pendingSitesByOwner(ordinal, generation).map((row) => ({
      start: row.start,
      end: row.end,
      site_kind: row.siteKind as "call" | "inherits" | "implements",
      reason: row.reason,
      ...(row.sourceId === undefined ? {} : { source_id: row.sourceId }),
    }));
  }

  // --- everything else: delegate to the wrapped SQLite port (catalog,
  // snapshots, FTS, and vectors stay in SQLite -- plan §9) ----------------

  async capability_states(scope: QueryScope): Promise<readonly SnapshotCapabilityStateEntry[]> {
    return this.sqlite.capability_states!(scope);
  }

  async artifact_text(scope: QueryScope, artifactVersionId: string): Promise<{ readonly text: string } | undefined> {
    return this.sqlite.artifact_text!(scope, artifactVersionId);
  }

  async records_by_artifact_versions(scope: QueryScope, versionIds: readonly string[]): Promise<readonly CanonicalQueryRecord[]> {
    return this.sqlite.records_by_artifact_versions!(scope, versionIds);
  }

  async artifacts_by_filter(scope: QueryScope, filter?: StructuralFilter): Promise<readonly CanonicalQueryRecord[]> {
    return this.sqlite.artifacts_by_filter!(scope, filter);
  }

  async search_literal(scope: QueryScope, pattern: string, options: { readonly case_sensitive?: boolean; readonly word_mode?: "substring" | "identifier" | "token"; readonly path_patterns?: readonly string[]; readonly include_generated?: boolean; readonly include_external?: boolean }): Promise<readonly LexicalSearchMatch[] | undefined> {
    return this.sqlite.search_literal!(scope, pattern, options);
  }

  /** Frente Q-2 (2026-09-08): the lexical sidecar lives in SQLite regardless of which store backs the structural corpus (module doc comment) -- delegates exactly like `search_literal` itself. */
  async lexical_projection_lag(scope: QueryScope): Promise<{ readonly current_generation: number; readonly completed_generation?: number } | undefined> {
    return this.sqlite.lexical_projection_lag!(scope);
  }

  async semantic_index_state(scope: QueryScope): Promise<SemanticIndexStateSnapshot | undefined> {
    return this.sqlite.semantic_index_state!(scope);
  }

  async semantic_vectors(scope: QueryScope, profileId: string, executableBindingId: string): Promise<readonly SemanticVectorRow[]> {
    return this.sqlite.semantic_vectors!(scope, profileId, executableBindingId);
  }

  async semantic_scope_counts(scope: QueryScope, maxDocumentBytes: number): Promise<{ readonly artifact_count: number; readonly oversized_count: number }> {
    return this.sqlite.semantic_scope_counts!(scope, maxDocumentBytes);
  }

  /**
   * v4 storage wiring (2026-09-07): UNLIKE every sibling `semantic_*` method
   * on this class, this one does NOT delegate to `this.sqlite` -- the
   * SQLite port's own implementation counts visible `record_occurrences`
   * rows directly, a table the v4 catalog schema does not have at all
   * (docs/evidence/2026-09-02-v4-p2-1-schema.md); delegating unconditionally
   * (this class's usual "catalog/snapshots/FTS/vectors stay in SQLite"
   * convention, module doc comment) threw "no such table: record_occurrences"
   * outright the first time `core:search_semantic`/`core:search_hybrid`
   * asked for it against a v4 workspace. Counted here instead via the SAME
   * full-corpus native scan `records_by_selector`'s own fallback uses,
   * filtered to `category === "entity"` and the same ineligible whole-
   * file/module kind `INELIGIBLE_ENTITY_RECORD_KIND` (`semantic-reconciler.ts`)
   * that `SemanticEntityRecordSource`'s v4 source (`semantic-entity-source-v4.ts`)
   * also excludes -- the exact SAME candidate-entity definition on both the
   * write side (embedding) and this read side (coverage counting).
   */
  async semantic_entity_scope_counts(scope: QueryScope): Promise<{ readonly entity_count: number }> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical native-store queries require one explicit workspace; comparison binds each participant separately.");
    const generation = await this.ensureGeneration(scope);
    if (generation === undefined) return { entity_count: 0 };
    const cached = this.entityScopeCountCache.get(generation);
    if (cached !== undefined) return { entity_count: cached };
    let entityCount = 0;
    for (const row of this.scanAll(generation)) {
      if (row.category === "entity" && row.kind !== INELIGIBLE_ENTITY_RECORD_KIND) entityCount += 1;
    }
    this.entityScopeCountCache.set(generation, entityCount);
    return { entity_count: entityCount };
  }

  async semantic_document_status_counts(scope: QueryScope, profileId: string, executableBindingId: string): Promise<SemanticDocumentStatusCounts> {
    return this.sqlite.semantic_document_status_counts!(scope, profileId, executableBindingId);
  }

  async semantic_affected_documents(scope: QueryScope, profileId: string, executableBindingId: string): Promise<readonly SemanticAffectedDocumentRow[]> {
    return this.sqlite.semantic_affected_documents!(scope, profileId, executableBindingId);
  }

  /**
   * Frente S-F (2026-09-08): delegates to the wrapped `SqliteCanonicalQuerySnapshotPort`
   * exactly like every other `semantic_*` method in this class -- this
   * table lives in SQLite regardless of whether the structural corpus was
   * moved to the native store (this class's own doc comment: "the catalog,
   * snapshots, FTS, and vectors stay in SQLite exactly as today"). Missing
   * this delegation would silently disable the fast path for every v4
   * native-storage workspace (the daemon's own default and the ONLY
   * configuration this frente's own live measurements ran against) --
   * `trySemanticSearch`'s capability check
   * (`this.snapshots.semantic_coverage_summary !== undefined`) would always
   * read `undefined` on a bare `NativeCanonicalQuerySnapshotPort` instance,
   * permanently taking the live-fallback branch and reproducing the exact
   * multi-second cost this frente's own materialization was built to
   * eliminate -- caught live via the packages/cli-scale latency
   * measurement (`docs/evidence/2026-09-08-v4-semantic-latency-and-n8n-embed.md`).
   */
  async semantic_coverage_summary(scope: QueryScope, profileId: string, executableBindingId: string): Promise<SemanticCoverageSummaryRow | undefined> {
    return this.sqlite.semantic_coverage_summary!(scope, profileId, executableBindingId);
  }
}
