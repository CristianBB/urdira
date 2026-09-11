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

export interface NativeLexicalSearchFilters {
  readonly path_patterns?: readonly string[];
  readonly language?: readonly string[];
  readonly namespace?: readonly string[];
  readonly kind?: readonly string[];
  readonly subject_type?: readonly string[];
}

export interface NativeLexicalSearchPage {
  readonly capability: "indexed" | "unsupported";
  /** `safe_regex` is an exact paged artifact/CAS source scan, not FTS. */
  readonly route: "fts" | "artifact_cas_paged";
  readonly index_used: "lexical_fts" | "artifact_versions_keyset";
  readonly matches: readonly LexicalSearchMatch[];
  readonly next_cursor?: string;
  readonly unsupported_reason?: "safe_regex" | "structural_filter";
}

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
// comment for why this exists and why it cannot break the legitimate
// small-N graph-pushdown/selector-list callers that rely on this path.
const OTHER_IDS_COUNT_CAP = 1_000;

export interface NativeIndexedRecordPage {
  readonly records: readonly CanonicalQueryRecord[];
  readonly next_cursor?: string;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function lexicalCursor(value: string | undefined): { readonly artifact_id: string; readonly artifact_version_id: string } | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded: unknown = JSON.parse(value);
    if (Array.isArray(decoded) && decoded.length === 2 && typeof decoded[0] === "string" && typeof decoded[1] === "string") return { artifact_id: decoded[0], artifact_version_id: decoded[1] };
  } catch { /* Older callers may pass a bare version id; retain that cursor shape. */ }
  return { artifact_id: "", artifact_version_id: value };
}

function encodeLexicalCursor(artifactId: string, versionId: string): string {
  return JSON.stringify([artifactId, versionId]);
}

function lexicalPathMatches(path: string | null, patterns: readonly string[] | undefined): boolean {
  if (patterns === undefined || patterns.length === 0) return true;
  if (path === null) return false;
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("**", ".*").replaceAll("*", "[^/]*").replaceAll("?", "[^/]");
    return new RegExp(`^${escaped}$`, "u").test(path);
  });
}

function lexicalMatches(text: string, pattern: string, mode: "literal" | "safe_regex", caseSensitive: boolean): readonly number[] {
  if (mode === "safe_regex") {
    let expression: RegExp;
    try { expression = new RegExp(pattern, caseSensitive ? "gu" : "giu"); }
    catch { throw new QueryPlanError("core:selector_invalid", "The safe_regex lexical pattern is invalid."); }
    const offsets: number[] = [];
    for (const match of text.matchAll(expression)) if (match.index !== undefined) offsets.push(match.index);
    return offsets;
  }
  const haystack = caseSensitive ? text : text.toLocaleLowerCase();
  const needle = caseSensitive ? pattern : pattern.toLocaleLowerCase();
  if (needle.length === 0) return [];
  const offsets: number[] = [];
  let offset = 0;
  while (offset < haystack.length) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) break;
    offsets.push(found);
    offset = found + Math.max(1, needle.length);
  }
  return offsets;
}

function lexicalLineSpans(text: string, offsets: readonly number[], patternLength: number): readonly { readonly start_line: string; readonly end_line: string }[] {
  const lineAt = (offset: number): string => String(text.slice(0, Math.max(0, offset)).split("\n").length);
  return offsets.map((offset) => ({ start_line: lineAt(offset), end_line: lineAt(offset + Math.max(0, patternLength - 1)) }));
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
  /**
   * Identity-ordered comparison batches intentionally retain the canonical
   * SQLite lane.  `identity_assignments_owner_key_idx` is the authoritative
   * existing ordering index for this projection; the native structural
   * segment has no raw identity-key ordering column.  The delegated port
   * supplies a keyset cursor `(identity_key, record_id)`, so repeated keys
   * remain adjacent and are never skipped or duplicated across pages.
   */
  readonly records_for_query_batches_order = "identity_key" as const;

  private constructor(
    private readonly database: SqliteDatabase,
    private readonly handle: NativeStructuralStoreHandle,
    private readonly sqlite: SqliteCanonicalQuerySnapshotPort,
    private readonly interner?: RecordBodyInterner,
  ) {}

  /**
   * Frente S-F (2026-09-08): `semantic_entity_scope_counts` uses the native
   * by-kind range count because `record_occurrences` (the table that the
   * SQLite counterpart counts) is not populated when the structural corpus
   * lives in the native store. The count is body-free and remains bounded by
   * the existing selector ranges, so it cannot queue other semantic calls
   * behind a full record decode.
   * The result is cached by immutable generation, making repeat calls O(1)
   * without retaining record bodies.
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
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > VISIBLE_BATCH_SIZE) throw new RangeError("Native query batch size is outside the bounded range.");
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

  /**
   * Stable identity-key batches for comparison merge consumers.  Structural
   * records are served by the native store, but identity assignment ordering
   * is still owned by SQLite's existing `identity_assignments_owner_key_idx`;
   * delegating preserves that index-backed keyset contract without building a
   * second native index or materializing the record corpus.
   */
  async *records_for_query_batches_by_identity(scope: QueryScope, batchSize = VISIBLE_BATCH_SIZE): AsyncIterable<readonly CanonicalQueryRecord[]> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical native-store queries require one explicit workspace; comparison binds each participant separately.");
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > VISIBLE_BATCH_SIZE) throw new RangeError("Native identity batch size is outside the bounded range.");
    const generation = await this.ensureGeneration(scope);
    if (generation === undefined) return;
    let cursor: { readonly identity_key: string; readonly record_id: string } | undefined;
    for (;;) {
      const page = this.handle.recordsByIdentityKeyPage(generation, batchSize, cursor?.identity_key, cursor === undefined ? undefined : recordIdHexOf(cursor.record_id));
      if (page.rows.length === 0) return;
      yield page.rows.map((row) => this.decode(row, scope.workspace_id));
      if (page.nextIdentityKey === undefined || page.nextRecordId === undefined) return;
      cursor = { identity_key: page.nextIdentityKey, record_id: `record:${page.nextRecordId}` };
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
    // Frente Q-4 (2026-09-08): `identity_id`/`identity_key` forms (the
    // other two shapes a `SubjectSelector` may carry) now each have a
    // dedicated native index -- `recordsByIdentityIds`
    // (`StoreReader::identity_id_index`, an in-memory index built once per
    // store load/reopen -- see that field's own doc comment, Rust side,
    // for why `identity_id` needs its OWN index rather than reusing the
    // on-disk `by_identity` range, which is keyed by a DIFFERENT digest of
    // the same `identity_key` text) and `recordsByIdentityKeys` (that
    // on-disk `by_identity` range, digested with the exact hash used at
    // ingestion). Before this frente, BOTH forms fell into
    // the old full linear decode of the entire visible generation, the
    // diagnosed root cause of `core:analyze_impact`/`core:
    // find_related_tests`'s multi-second per-call cost at n8n/VS Code scale
    // (`docs/evidence/2026-09-08-v4-full-pushdown-catalog.md` §5.3,
    // decision 25's Q1/Q-3 amendments).
    //
    // Deliberately NOT dispatched by a string-shape guess (e.g. "does this
    // look like `category:64-hex`?"): `identity_id`'s wire shape is a
    // native-pipeline convention (`structural_store_napi.rs`:
    // `format!("{category}:{hex}")`), but a v3-converted/sidecar-sourced
    // store's own `identity_id` column is free-form text with no enforced
    // prefix (confirmed live: `tests/native-query-snapshot-port.test.ts`'s
    // own fixture writes `"identity:" + "1".repeat(64)"` directly to
    // `identity_assignments.identity_id`) -- guessing wrong would silently
    // drop a resolvable id. Instead: try EVERY `otherId` against
    // `recordsByIdentityIds` first (a non-matching/non-hex string is a
    // cheap, harmless miss on the Rust side, never a scan); whatever is
    // STILL unresolved is then tried against `recordsByIdentityKeys` as
    // identity_key text. Both passes are O(k) indexed lookups, never a
    // corpus scan, regardless of which forms the caller's `otherIds`
    // actually turn out to be. `OTHER_IDS_COUNT_CAP` remains as a sanity
    // bound on batch size (a legitimate caller's selector list, a
    // `build_context` seeds array, or one BFS frontier's edge endpoints
    // are all small) -- now bounding `k` indexed lookups rather than
    // protecting against an unbounded scan, but kept for the exact same
    // "not a shape any legitimate caller produces" reasoning.
    if (otherIds.size > OTHER_IDS_COUNT_CAP) {
      throw new QueryPlanError(
        "core:selector_unresolvable",
        `Workspace "${scope.workspace_id}" received ${otherIds.size} identity_id/identity_key-shaped record selectors in one records_by_ids call, above the ${OTHER_IDS_COUNT_CAP} bound this port accepts per call. Resolve in smaller batches, or prefer the record's own record_id (record:<hex>) -- every ResultSubject already carries one.`,
        { workspace_id: scope.workspace_id, unresolved_ids: [...otherIds].slice(0, 50) },
      );
    }
    if (otherIds.size > 0) {
      const remaining = new Set(otherIds);
      for (const row of this.handle.recordsByIdentityIds([...remaining], generation)) {
        if (!found.has(row.recordId)) found.set(row.recordId, this.decode(row, scope.workspace_id));
        if (row.identityId !== undefined) remaining.delete(row.identityId);
      }
      if (remaining.size > 0) {
        for (const row of this.handle.recordsByIdentityKeys([...remaining], generation)) {
          if (!found.has(row.recordId)) found.set(row.recordId, this.decode(row, scope.workspace_id));
          if (row.identityKey !== undefined) remaining.delete(row.identityKey);
        }
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
   * back to a full-corpus branch below -- measured live on n8n
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
   * e.g. `graph_edges_by_subject_ids`). An expansion outside
   * `SELECTOR_COMBO_CAP`, including an omitted selector that would mean
   * "every visible record", fails explicitly with a resource-limit error.
   * The native production path never turns an optional pushdown miss into a
   * hidden full-corpus decode.
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
    const comboCount = explicitKinds === undefined
      ? categories.length * universalKinds.length
      : categories.length * universalKinds.length * explicitKinds.length;
    if (comboCount === 0 || comboCount > SELECTOR_COMBO_CAP) {
      throw new QueryPlanError(
        "core:execution_resource_limit",
        `Native structural selector requires ${comboCount} indexed combinations, outside the bounded pushdown limit of ${SELECTOR_COMBO_CAP}; refusing a full visible-corpus scan. Narrow the selector or split the request into smaller indexed selectors.`,
        { limit_kind: "native_selector_combinations", configured_limit: SELECTOR_COMBO_CAP, observed_or_required: comboCount },
      );
    }
    const page = this.handle.recordsBySelectorPage([...universalKinds], [...categories], explicitKinds === undefined ? [] : [...explicitKinds], generation, limit);
    for (const row of page.rows) found.set(row.recordId, this.decode(row, scope.workspace_id));
    return [...found.values()];
  }

  /** Exact indexed selector page for the canonical owner to connect to
   * `stream_sources`. The cursor is the last returned record id and is
   * stable across immutable native generations. */
  async records_by_selector_page(scope: QueryScope, selector: RecordColumnSelector, limit: number, after_record_id?: string): Promise<NativeIndexedRecordPage> {
    if (scope.scope_type !== "single_workspace") throw new TypeError("Canonical native-store queries require one explicit workspace; comparison binds each participant separately.");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("limit must be a positive safe integer");
    const afterKeyHex = after_record_id === undefined ? undefined : recordIdHexOf(after_record_id);
    if (after_record_id !== undefined && afterKeyHex === undefined) throw new QueryPlanError("core:cursor_invalid", "The native selector cursor must contain a record:<64-hex> identity.");
    const generation = await this.ensureGeneration(scope);
    if (generation === undefined) return { records: [] };
    const batch = this.handle.recordsBySelectorPage(
      selector.universal_kinds ?? [],
      selector.categories ?? [],
      selector.kinds ?? [],
      generation,
      limit,
      afterKeyHex,
    );
    const records = batch.rows.map((row) => this.decode(row, scope.workspace_id));
    const nextCursor = batch.nextCursor === undefined ? records.at(-1)?.record_id : `record:${batch.nextCursor}`;
    return nextCursor === undefined ? { records } : { records, next_cursor: nextCursor };
  }

  /** Exact, bounded lexical page over the existing lexical candidates. The
   * method advances through ordered candidate pages and never materializes the
   * corpus; the returned cursor resumes after the last candidate inspected. */
  async search_lexical_page(
    scope: QueryScope,
    pattern: string,
    mode: "literal" | "safe_regex",
    options: { readonly case_sensitive?: boolean; readonly word_mode?: "substring" | "identifier" | "token"; readonly filters?: NativeLexicalSearchFilters } = {},
    limit = 100,
    after_cursor?: string,
  ): Promise<NativeLexicalSearchPage> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("limit must be a positive safe integer");
    const filters = options.filters;
    if (scope.scope_type !== "single_workspace") throw new TypeError("Native lexical queries require one explicit workspace.");
    const generation = await this.ensureGeneration(scope);
    if (generation === undefined) return { capability: "indexed", route: "artifact_cas_paged", index_used: "artifact_versions_keyset", matches: [] };
    const cursor = lexicalCursor(after_cursor);
    const language = filters?.language?.filter((value) => value.length > 0) ?? [];
    const namespace = filters?.namespace?.filter((value) => value.length > 0) ?? [];
    const kinds = filters?.kind?.filter((value) => value.length > 0) ?? [];
    const subjectTypes = filters?.subject_type?.filter((value) => value.length > 0) ?? [];
    // Namespace is represented by the source path in the native snapshot;
    // fold it into the same exact glob predicate instead of inventing a new
    // index. Kind and subject_type are resolved through native kind/category
    // ranges, then applied by owner artifact version below.
    const pathPatterns = [...(filters?.path_patterns ?? []), ...namespace];
    const knownCategories = ["entity", "relation", "fact", "evidence", "diagnostic"] as const;
    const structuralCategories = subjectTypes.length > 0 ? subjectTypes.filter((value): value is typeof knownCategories[number] => knownCategories.includes(value as typeof knownCategories[number])) : [];
    if (subjectTypes.some((value) => value !== "artifact" && !knownCategories.includes(value as typeof knownCategories[number]))) return { capability: "indexed", route: "artifact_cas_paged", index_used: "artifact_versions_keyset", matches: [] };
    const dictionaries = kinds.length > 0 || structuralCategories.length > 0 ? this.handle.dictionaries() : undefined;
    const sourceOnly = scope.snapshot_id?.startsWith("source-snapshot:") === true;
    const completion = sourceOnly ? undefined : await this.database.get<{ completed_generation: number }>("SELECT completed_generation FROM lexical_index_state WHERE workspace_id = ?", [scope.workspace_id]);
    const lexicalCurrent = !sourceOnly && completion?.completed_generation === generation;
    const useFts = mode === "literal" && lexicalCurrent && pattern.length >= 3;
    const candidatePageSize = 256;
    let candidateCursor = cursor;
    const matches: LexicalSearchMatch[] = [];
    let moreCandidates = false;
    for (;;) {
      const cursorSql = candidateCursor === undefined ? "" : " AND (candidate.artifact_id > ? OR (candidate.artifact_id = ? AND candidate.artifact_version_id > ?))";
      const cursorParams = candidateCursor === undefined ? [] : [candidateCursor.artifact_id, candidateCursor.artifact_id, candidateCursor.artifact_version_id];
      const sourceTable = useFts ? `lexical_fts AS candidate JOIN lexical_documents AS document ON document.workspace_id = candidate.workspace_id AND document.artifact_id = candidate.artifact_id AND document.artifact_version_id = candidate.artifact_version_id JOIN artifact_versions AS version ON version.workspace_id = document.workspace_id AND version.artifact_version_id = document.artifact_version_id JOIN source_artifacts AS artifact ON artifact.workspace_id = document.workspace_id AND artifact.artifact_id = document.artifact_id` : `artifact_versions AS candidate JOIN source_artifacts AS artifact ON artifact.workspace_id = candidate.workspace_id AND artifact.artifact_id = candidate.artifact_id`;
      // SQLite FTS5's MATCH operand must name the virtual table itself;
      // using the `candidate` alias here is parsed as a missing column.
      const candidateWhere = useFts ? "candidate.workspace_id = ? AND lexical_fts MATCH ? AND document.valid_from_generation <= ? AND (document.valid_to_generation IS NULL OR document.valid_to_generation > ?)" : "candidate.workspace_id = ? AND candidate.valid_from_generation <= ? AND (candidate.valid_to_generation IS NULL OR candidate.valid_to_generation > ?)";
      const candidateParams = useFts ? [scope.workspace_id, `\"${pattern.replaceAll('"', '""')}\"`, generation, generation, ...cursorParams] : [scope.workspace_id, generation, generation, ...cursorParams];
      const candidates = await this.database.all<{ artifact_id: string; artifact_version_id: string; normalized_path: string | null; language_hint: string | null }>(`SELECT candidate.artifact_id, candidate.artifact_version_id, artifact.normalized_path, ${useFts ? "version.language_hint" : "candidate.language_hint"} AS language_hint FROM ${sourceTable} WHERE ${candidateWhere}${cursorSql} ORDER BY candidate.artifact_id, candidate.artifact_version_id LIMIT ${candidatePageSize}`, candidateParams);
      if (candidates.length === 0) break;
      moreCandidates = candidates.length === candidatePageSize;
      let stoppedForLimit = false;
      for (const candidate of candidates) {
        candidateCursor = { artifact_id: candidate.artifact_id, artifact_version_id: candidate.artifact_version_id };
        if (!lexicalPathMatches(candidate.normalized_path, pathPatterns) || (language.length > 0 && (candidate.language_hint === null || !language.includes(candidate.language_hint)))) continue;
        if (dictionaries !== undefined) {
          const ownerOrdinal = findArtifactOrdinal(dictionaries, candidate.artifact_id, candidate.artifact_version_id);
          const ownerRows = ownerOrdinal === undefined ? [] : this.handle.recordsByOwnerOrdinal(ownerOrdinal, generation);
          if (!ownerRows.some((row) => (kinds.length === 0 || kinds.includes(row.kind)) && (structuralCategories.length === 0 || structuralCategories.includes(row.category as typeof knownCategories[number])))) continue;
        }
        const file = await this.sqlite.artifact_text(scope, candidate.artifact_version_id);
        if (file === undefined) continue;
        const offsets = lexicalMatches(file.text, pattern, mode, options.case_sensitive === true);
        if (offsets.length === 0) continue;
        matches.push({ artifact_id: candidate.artifact_id, artifact_version_id: candidate.artifact_version_id, offsets, line_spans: lexicalLineSpans(file.text, offsets, pattern.length) });
        if (matches.length >= limit) { stoppedForLimit = true; break; }
      }
      if (stoppedForLimit || !moreCandidates) break;
    }
    const route = useFts ? "fts" : "artifact_cas_paged";
    const index_used = useFts ? "lexical_fts" : "artifact_versions_keyset";
    if (matches.length < limit && !moreCandidates) return { capability: "indexed", route, index_used, matches };
    const nextCursor = candidateCursor === undefined ? undefined : encodeLexicalCursor(candidateCursor.artifact_id, candidateCursor.artifact_version_id);
    return nextCursor === undefined ? { capability: "indexed", route, index_used, matches } : { capability: "indexed", route, index_used, matches, next_cursor: nextCursor };
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
    const dictionaries = this.handle.dictionaries();
    const universalKinds = [...dictionaries.universalKinds];
    const kinds = dictionaries.kinds.filter((kind) => kind !== INELIGIBLE_ENTITY_RECORD_KIND);
    const entityCount = this.handle.countVisibleBySelector(universalKinds, ["entity"], kinds, generation);
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
