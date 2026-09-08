/**
 * Raw loader for the `NativeStoreBuilder`/`NativeStructuralStoreHandle`
 * napi classes (`crates/urdira-native-node/src/structural_store_napi.rs`,
 * v4 plan P2-5). Deliberately separate from `@urdira/native`'s
 * `loadNativeBinding`/`getNativeBinding` (`packages/native/src/loader.ts`):
 * that loader validates a FROZEN, versioned `NativeBinding` function
 * surface against a signed release manifest (build id, per-file sha256,
 * exact target platform package) -- appropriate for the shipped addon,
 * not for this task's "test the port against real fixtures TODAY" scope,
 * where the addon is a fresh local `cargo build` a developer or CI job
 * just produced. This loader does a plain `require()` of the built
 * addon file, with no manifest/checksum ceremony.
 *
 * Resolution order for the addon path:
 * 1. `URDIRA_NATIVE_ADDON_PATH` env var, if set (test/CI override).
 * 2. `<repoRoot>/release/native/<hostTarget>/urdira-native.node`, the same
 *    path `scripts/build-native.mjs` populates.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export interface NativeArtifactPair {
  readonly artifactId: string;
  readonly artifactVersionId: string;
}

export interface NativeDictionaries {
  readonly kinds: readonly string[];
  readonly universalKinds: readonly string[];
  readonly relationKinds: readonly string[];
  readonly names: readonly string[];
  readonly artifacts: readonly NativeArtifactPair[];
  readonly facets: readonly string[];
  readonly subjects: readonly string[];
}

export interface NativeInputRecordRow {
  readonly recordIdHex: string;
  readonly ownerArtifactId: string;
  readonly ownerArtifactVersionId: string;
  readonly validFrom: number;
  readonly validTo: number;
  readonly category: "entity" | "relation" | "fact" | "evidence" | "diagnostic";
  readonly kind: string;
  readonly universalKind: string;
  readonly facets: readonly string[];
  readonly spanArtifactId?: string;
  readonly spanArtifactVersionId?: string;
  readonly spanStartByte?: number;
  readonly spanEndByte?: number;
  readonly spanStartLine?: number;
  readonly spanEndLine?: number;
  readonly identityId?: string;
  readonly identityKey?: string;
  readonly relationKind?: string;
  readonly sourceSubject?: string;
  readonly targetSubject?: string;
  readonly bodyPayload: Uint8Array;
}

export interface NativeInputDependencyRow {
  readonly dependencyIdHex?: string;
  readonly recordIdHex?: string;
  readonly ownerArtifactId: string;
  readonly ownerArtifactVersionId: string;
  readonly depArtifactId: string;
  readonly depArtifactVersionId: string;
  readonly role: string;
  readonly validFrom: number;
  readonly validTo: number;
}

export interface NativeOutputRecordRow {
  readonly recordId: string;
  readonly category: string;
  readonly kind: string;
  readonly universalKind: string;
  readonly ownerArtifactId: string;
  readonly ownerArtifactVersionId: string;
  readonly bodyPayload: Uint8Array;
  readonly primarySourceSpanArtifactVersionId?: string;
  readonly primarySourceSpanStartByte?: string;
  readonly primarySourceSpanEndByte?: string;
  readonly primarySourceSpanStartLine?: string;
  readonly primarySourceSpanEndLine?: string;
  readonly identityId?: string;
  readonly identityKey?: string;
  readonly facetRows: readonly string[];
  /** `"sha256:<hex>"` -- see `NativeOutputRecordRow.record_digest`'s doc
   * comment (Rust side, `structural_store_napi.rs`) for why this is
   * additive/unused by `decodeRow`. */
  readonly recordDigest: string;
}

export interface NativeOutputEdgeRow {
  readonly edgeId: string;
  readonly sourceSubjectId: string;
  readonly targetSubjectId: string;
  readonly relationRecordId: string;
  readonly relationKind: string;
  readonly role: string;
  readonly evidenceClass: string;
}

export interface NativeOutputDependencyRow {
  readonly recordId?: string;
  readonly ownerArtifactId: string;
  readonly ownerArtifactVersionId: string;
  readonly dependencyArtifactId: string;
  readonly dependencyArtifactVersionId: string;
  readonly dependencyRole: string;
}

/**
 * One `pending.sites` row (`crates/urdira-structural-store`), shaped for
 * `core:get_outline`'s additive `pending_sites` stream
 * (`packages/engine/src/canonical-query-data-port.ts`,
 * `docs/evidence/2026-09-04-v4-pending-sites-fold-and-member-entities.md`
 * §8). Deliberately omits `ownerArtifactId`/`ownerArtifactVersionId`:
 * every row one `pendingSitesByOwner` call returns shares the SAME owner
 * the caller already resolved to an ordinal.
 */
export interface NativeOutputPendingSiteRow {
  readonly start: number;
  readonly end: number;
  /** `"call" | "inherits" | "implements"` (`structural_store_napi.rs`'s `pending_site_kind_text`). */
  readonly siteKind: string;
  /** The `PendingReasonCode` name (`structural_store_napi.rs`'s `pending_reason_text`; source of truth: `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`'s `PendingReasonCode`). */
  readonly reason: string;
  /** The enclosing entity's `identity_key` text, or `undefined` when the site's `source_subject` is absent or does not resolve at this generation. */
  readonly sourceId?: string;
}

export interface NativeVisibleBatch {
  readonly rows: readonly NativeOutputRecordRow[];
  readonly nextCursor?: string;
}

/**
 * Raw `(key, logical_digest)` leaf batch -- `keys`/`digests` are
 * contiguous `N*32`-byte buffers, member `i`'s bytes at `[i*32, i*32+32)`
 * in each. See `structural_store_napi.rs`'s `NativeDigestBatch` doc
 * comment for why this is bytes rather than decoded objects, and
 * `iterVisibleDigests`/`iterVisibleDependencyDigests`/
 * `iterVisibleGraphDigests` for which (key, logical) pair each set uses.
 * Consumed by `packages/engine/src/v4-verify.ts`.
 */
export interface NativeDigestBatch {
  readonly keys: Uint8Array;
  readonly digests: Uint8Array;
  readonly nextCursor?: string;
}

export interface NativeChangedEntry {
  readonly recordId: string;
  readonly opened: boolean;
  readonly row?: NativeOutputRecordRow;
  readonly validTo: number;
}

export interface NativeStoreBuilderSummary {
  readonly rowCount: number;
  readonly dependencyCount: number;
  readonly generation: number;
  readonly recordsRoot: string;
  readonly dependencyRoot: string;
}

export declare class NativeStoreBuilder {
  constructor();
  create(dir: string, generation: number): void;
  addRecords(rows: readonly NativeInputRecordRow[]): void;
  addDependencies(rows: readonly NativeInputDependencyRow[]): void;
  finish(): NativeStoreBuilderSummary;
}

export declare class NativeStructuralStoreHandle {
  static open(dir: string): NativeStructuralStoreHandle;
  reopenIfChanged(): boolean;
  currentGeneration(): number;
  dictionaries(): NativeDictionaries;
  /** P2-2e: the facet name table, indexed by bit position (see
   * `Dictionaries::facet_names`'s doc comment, Rust side) -- prefers a real
   * v4 scan's own store dictionary and falls back to the v3-conversion
   * text sidecar. Same list `dictionaries().facets` already returns; a
   * separate method purely to match this task's own contract naming. */
  facetNames(): readonly string[];
  /** P2-2e: one subject ordinal's human-readable text (`"record:<hex>"` on
   * every real v4/converted store) -- see `subject_text_for`'s doc comment
   * (Rust side) for the three-source fallback. Empty string for an
   * out-of-range ordinal. */
  subjectText(ordinal: number): string;
  recordsByIds(keysHex: readonly string[], generation: number): readonly NativeOutputRecordRow[];
  /** Frente Q-4 (2026-09-08): indexed `identity_key` (raw text) lookup --
   * digests each value with the same hash used at ingestion
   * (`identity_key_digest`) and reads the on-disk `by_identity` range
   * index (`StoreReader::by_identity_key`), visibility-filtered by
   * `generation`. See `NativeCanonicalQuerySnapshotPort.records_by_ids`
   * for why this retires that method's `otherIds`/`scanAll` fallback for
   * this identity form. */
  recordsByIdentityKeys(identityKeys: readonly string[], generation: number): readonly NativeOutputRecordRow[];
  /** Frente Q-4 (2026-09-08): indexed `identity_id` lookup (TS
   * `entity_id`/`relation_id`/`diagnostic_id`, shaped
   * `"{entity|relation|diagnostic}:<64-hex>"`) via the in-memory
   * `StoreReader::identity_id_index` (`StoreReader::by_identity_id`) --
   * NOT the same digest as `identity_key`'s, so this is a separate index,
   * not a derivation of `recordsByIdentityKeys`. */
  recordsByIdentityIds(identityIds: readonly string[], generation: number): readonly NativeOutputRecordRow[];
  recordsByName(name: string, generation: number): readonly NativeOutputRecordRow[];
  recordsByKindExact(universalKind: string, category: string, kind: string, generation: number, limit: number, afterKeyHex?: string): readonly NativeOutputRecordRow[];
  /** Frente Q-3 (2026-09-08): every `kind` under one `(universal_kind,
   * category)` -- see `by_kind_universal_range`'s doc comment (`crates/
   * urdira-structural-store/src/segment_io.rs`) for why this exists
   * alongside `recordsByKindExact`: the engine layer has no registry
   * mapping a universal_kind to its own producer-specific `kind` strings
   * to enumerate, and enumerating via the full kind dictionary blew
   * `records_by_selector`'s own combo cap and fell back to a full-corpus
   * scan for `core:inspect_architecture`'s pushdown. */
  recordsByKindUniversal(universalKind: string, category: string, generation: number, limit: number): readonly NativeOutputRecordRow[];
  recordsByOwnerOrdinal(ownerArtifactOrdinal: number, generation: number): readonly NativeOutputRecordRow[];
  adjacency(subjectIds: readonly string[], direction: "outbound" | "inbound", generation: number): readonly NativeOutputEdgeRow[];
  changedBetween(g1: number, g2: number): readonly NativeChangedEntry[];
  visibleCount(generation: number): number;
  iterVisibleBatch(generation: number, batchSize: number, afterKeyHex?: string): NativeVisibleBatch;
  /** `(record_id, record_digest)` leaves, ascending key order -- the
   * `records` set's own members. */
  iterVisibleDigests(generation: number, batchSize: number, afterKeyHex?: string): NativeDigestBatch;
  /** `(record_id, record_digest)` leaves restricted to category-`relation`
   * records, ascending key order -- the `graph` set's own members. */
  iterVisibleGraphDigests(generation: number, batchSize: number, afterKeyHex?: string): NativeDigestBatch;
  /** `(dependency_id, dependency_logical)` leaves, ascending key order --
   * the `dependency` set's own members. */
  iterVisibleDependencyDigests(generation: number, batchSize: number, afterKeyHex?: string): NativeDigestBatch;
  depsByOwner(ownerArtifactOrdinal: number, generation: number): readonly NativeOutputDependencyRow[];
  depsReverse(depArtifactOrdinal: number, generation: number): readonly NativeOutputDependencyRow[];
  /** Every visible `pending.sites` row owned by `ownerArtifactOrdinal` at `generation` -- see `NativeOutputPendingSiteRow`'s doc comment. */
  pendingSitesByOwner(ownerArtifactOrdinal: number, generation: number): readonly NativeOutputPendingSiteRow[];
}

export interface NativeStructuralStoreAddon {
  readonly NativeStoreBuilder: typeof NativeStoreBuilder;
  readonly NativeStructuralStoreHandle: typeof NativeStructuralStoreHandle;
}

function hostTargetDirectoryName(): string | undefined {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform === "linux") return `linux-${process.arch}-gnu`;
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64";
  return undefined;
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function defaultAddonPath(): string {
  const target = hostTargetDirectoryName();
  if (target === undefined) throw new Error(`Unsupported native structural store host platform/arch: ${process.platform}/${process.arch}.`);
  return join(repoRoot, "release", "native", target, "urdira-native.node");
}

let cached: NativeStructuralStoreAddon | undefined;

/** Loads (and caches) the raw addon. Throws with a clear message if the
 * addon has not been built yet -- run `node scripts/build-native.mjs` (or,
 * faster during P2-5 development, `cargo build -p urdira-native-node
 * --release` and copy the produced dylib to the expected path) first. */
export function loadNativeStructuralStoreAddon(): NativeStructuralStoreAddon {
  if (cached !== undefined) return cached;
  const path = process.env["URDIRA_NATIVE_ADDON_PATH"] ?? defaultAddonPath();
  if (!existsSync(path)) throw new Error(`Native structural store addon not found at ${path}. Build it first (node scripts/build-native.mjs, or cargo build -p urdira-native-node --release).`);
  const loaded = require(path) as Partial<NativeStructuralStoreAddon>;
  if (typeof loaded.NativeStoreBuilder !== "function" || typeof loaded.NativeStructuralStoreHandle !== "function") throw new Error(`Native addon at ${path} does not export NativeStoreBuilder/NativeStructuralStoreHandle.`);
  cached = loaded as NativeStructuralStoreAddon;
  return cached;
}

/** Test-only seam: forces the next `loadNativeStructuralStoreAddon()` call to reload. */
export function resetNativeStructuralStoreAddonCacheForTests(): void {
  cached = undefined;
}
