/**
 * v4 (`index_contract 0x34`) `lifecycle.verify` (plan §8.3/§9, P2-4). A v4
 * workspace's structural corpus (records/dependencies/graph) lives in the
 * native segment store (`crates/urdira-structural-store`, `structural/`
 * directory) rather than SQLite, so `packages/storage/src/lifecycle.ts`'s
 * `StorageMaintenance.verify()` cannot recompute `canonical_record_set_digest`/
 * `projection_set_digests` the v3 way (a SQL scan of `record_occurrences`) --
 * `@urdira/storage` (layer 2, `architecture/manifest.json`) does not and must
 * not depend on `@urdira/engine` (layer 3), so this from-scratch v4 check
 * lives here instead, as the task brief's documented fallback ("implement
 * the v4 verify in engine ... and have the daemon's verify RPC route
 * there"). That daemon-side routing is out of this task's reach (owned by
 * the concurrent P3-1 agent editing `packages/daemon/src/runtime.ts`'s v4
 * routing) -- `verifyV4Workspace` below is the ready-to-call primitive.
 *
 * **Leaf-level verification (follow-up to P2-4, closes the gap this
 * module's doc comment used to document as unfixable):**
 * `crates/urdira-native-node/src/structural_store_napi.rs` now exposes
 * `iterVisibleDigests`/`iterVisibleGraphDigests`/`iterVisibleDependencyDigests`
 * -- raw, cursor-paginated `(key, logical_digest)` leaf exports over
 * `NativeStructuralStoreHandle`, mirroring exactly the entries
 * `crates/urdira-structural-store/src/merkle.rs` (`records`/`dependency`)
 * and `crates/urdira-indexing-worker/src/v4/publish.rs` (`graph`, a
 * category-`relation` subset of `records`) already feed
 * `BucketedMerkleSet::from_sorted` with at publish time. `verifyV4Workspace`
 * below streams each set's leaves through those iterators (`leafRootFor`)
 * into {@link BucketedMerkleSet.fromSortedBatches} and compares the
 * FROM-SCRATCH root/count against the persisted `.tree` file, the
 * `merkle_roots` SQL row, and (records/dependency only) `MANIFEST.roots` --
 * a genuine leaf-level corpus integrity check, not merely internal-node
 * self-consistency: a record whose stored `record_digest` was simply wrong
 * from the moment it was written, with every tree level above it computed
 * consistently from that wrong value, IS now caught (the freshly-streamed
 * leaf digest disagrees with whatever the persisted tree/SQL root implies).
 * Opening the native handle itself re-verifies each base segment's own
 * `records.keys`/`records.meta`/`records.digests` xxh3 checksums
 * (`StoreInner::load`'s "sample-verify... per open"); a failure there
 * (e.g. a directly-corrupted `records.digests` file) is reported as
 * `storage:canonical_set_digest_corrupt` too, rather than silently treated
 * as "native addon unavailable" (see the `openNativeHandle` try/catch
 * below) -- an unreadable structural store IS a canonical-set integrity
 * failure.
 *
 * Still gated on the native addon being built in-process: without it, the
 * checks below fall back to the tree-file/SQL/MANIFEST cross-checks only
 * (unchanged from before this follow-up), which remain real but weaker
 * (internal-node self-consistency, not leaf-level).
 *
 * `source_state_digest`, by contrast, IS fully from-scratch checkable with
 * zero native/Rust dependency: its present/absent entries come straight
 * from `source_artifacts`/`artifact_versions`/`artifact_tombstones`, tables
 * that live in the SAME SQLite catalog this module already reads
 * (`crates/urdira-source-frontier/src/frontier.rs`'s `Frontier::load` query,
 * mirrored exactly by `presentAndAbsentEntries` below).
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  BucketedMerkleSet,
  computeDigest,
  projectionSetDigest,
  recordSetDigest,
  rootFromBucketDigests,
  sourceStateDigest,
} from "@urdira/canonical";
import type { SqliteDatabase, VerificationFailure, VerificationReport } from "@urdira/storage";
import { loadNativeStructuralStoreAddon, type NativeDigestBatch, type NativeStructuralStoreHandle } from "./native-structural-store-binding.js";

const HEADER_LEN = 64;
const NODE_LEVEL_LEN = [1, 16, 256, 4096, 65536] as const;
const BUCKET_LEVEL_LEN = 1_048_576;
const BUCKET_LEVEL_BYTE_OFFSET = HEADER_LEN + NODE_LEVEL_LEN.reduce((sum, len) => sum + len * 32, 0);
const SET_KIND_NAMES: Readonly<Record<number, string>> = { 1: "records", 2: "graph", 3: "dependency", 4: "metric", 5: "source_state" };
const ZERO_ROOT = `sha256:${"0".repeat(64)}`;
const ZERO_SLOT = Buffer.alloc(32);

export interface V4MerkleTreeFile {
  readonly setKind: string;
  readonly generation: number;
  /** From the file's own header -- an independently-recomputed count is
   * not derivable from persisted digests alone (the format persists
   * digests, not leaves; see `docs/evidence/2026-09-02-v4-p0-s3-merkle-bucket.md`'s
   * "Known caveat"). */
  readonly count: number;
  readonly headerRoot: string;
  /** Recomputed bottom-up from the file's own bucket-level (level 5) slots
   * via {@link rootFromBucketDigests} -- independent of `headerRoot`. */
  readonly recomputedRoot: string;
}

/**
 * Reads one `structural/merkle/<set>.tree` file (format documented in
 * `docs/evidence/2026-09-02-v4-p0-s3-merkle-bucket.md`'s "Persistence
 * format" section and implemented in
 * `crates/urdira-indexing-core/src/merkle_bucket.rs`'s `encode_header`/
 * `write_to`): 64-byte header (magic `URDM`, format u16, set_kind u16,
 * generation u64, count u64, root 32B, 8B reserved) followed by node
 * levels 0..4 (BFS, `16^d` slots each) then the bucket level (`16^5`
 * slots), 32 bytes per slot. Returns `undefined` if the file does not
 * exist yet (a workspace that has not been cold-scanned, or a kind this
 * generation never wrote).
 */
export async function readTreeFile(path: string): Promise<V4MerkleTreeFile | undefined> {
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const expectedLength = BUCKET_LEVEL_BYTE_OFFSET + BUCKET_LEVEL_LEN * 32;
  if (buffer.length !== expectedLength) throw new Error(`v4 merkle tree file ${path} has unexpected length ${buffer.length} (want ${expectedLength}).`);
  if (buffer.toString("latin1", 0, 4) !== "URDM") throw new Error(`v4 merkle tree file ${path} has an unrecognized magic header.`);
  const format = buffer.readUInt16LE(4);
  if (format !== 1) throw new Error(`v4 merkle tree file ${path} has unsupported format ${format}.`);
  const setKindCode = buffer.readUInt16LE(6);
  const setKind = SET_KIND_NAMES[setKindCode];
  if (setKind === undefined) throw new Error(`v4 merkle tree file ${path} has unknown set_kind ${setKindCode}.`);
  const generation = Number(buffer.readBigUInt64LE(8));
  const count = Number(buffer.readBigUInt64LE(16));
  const rootBytes = buffer.subarray(24, 56);
  const headerRoot = `sha256:${rootBytes.toString("hex")}`;

  const buckets = new Map<string, string>();
  for (let index = 0; index < BUCKET_LEVEL_LEN; index += 1) {
    const offset = BUCKET_LEVEL_BYTE_OFFSET + index * 32;
    const slot = buffer.subarray(offset, offset + 32);
    if (!slot.equals(ZERO_SLOT)) buckets.set(index.toString(16).padStart(5, "0"), `sha256:${slot.toString("hex")}`);
  }
  const recomputedRoot = count === 0 ? ZERO_ROOT : rootFromBucketDigests(buckets);
  return { setKind, generation, count, headerRoot, recomputedRoot };
}

export interface V4Manifest {
  readonly generation: number;
  readonly roots: Readonly<Record<string, string>>;
}

async function readManifest(structuralRoot: string): Promise<V4Manifest | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(structuralRoot, "MANIFEST"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as { readonly generation?: unknown; readonly roots?: unknown };
  const generation = typeof parsed.generation === "number" ? parsed.generation : Number(parsed.generation);
  const roots = parsed.roots && typeof parsed.roots === "object" ? (parsed.roots as Record<string, string>) : {};
  return { generation, roots };
}

function sha256Hex(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * Mirrors `crates/urdira-source-frontier/src/frontier.rs`'s `Frontier::load`
 * query exactly (same tables, same `valid_to_generation IS NULL` visibility
 * filter, same `key = sha256(normalized_uri)` / `logical` construction),
 * so this module's `source_state_digest` recompute is byte-for-byte the
 * same recipe the Rust catalog uses -- no native/Rust dependency at all,
 * since `source_artifacts`/`artifact_versions`/`artifact_tombstones` are
 * plain SQLite tables in the same catalog database this module already has
 * a handle to.
 */
async function presentAndAbsentEntries(database: SqliteDatabase, workspaceId: string): Promise<{ readonly present: readonly { readonly member_digest: string; readonly logical_digest: string }[]; readonly absent: readonly { readonly member_digest: string; readonly logical_digest: string }[] }> {
  const presentRows = await database.all<{ normalized_uri: string; content_hash: string }>(
    "SELECT sa.normalized_uri AS normalized_uri, av.content_hash AS content_hash FROM artifact_versions av JOIN source_artifacts sa ON sa.workspace_id = av.workspace_id AND sa.artifact_id = av.artifact_id WHERE av.workspace_id = ? AND av.valid_to_generation IS NULL",
    [workspaceId],
  );
  const absentRows = await database.all<{ normalized_uri: string; artifact_tombstone_id: string }>(
    "SELECT sa.normalized_uri AS normalized_uri, t.artifact_tombstone_id AS artifact_tombstone_id FROM artifact_tombstones t JOIN source_artifacts sa ON sa.workspace_id = t.workspace_id AND sa.artifact_id = t.artifact_id WHERE t.workspace_id = ? AND t.valid_to_generation IS NULL",
    [workspaceId],
  );
  return {
    present: presentRows.map((row) => ({ member_digest: sha256Hex(row.normalized_uri), logical_digest: row.content_hash })),
    absent: absentRows.map((row) => ({ member_digest: sha256Hex(row.normalized_uri), logical_digest: sha256Hex(row.artifact_tombstone_id) })),
  };
}

function blobDigest(value: Uint8Array | null | undefined): string | undefined {
  if (!value || value.byteLength !== 32) return undefined;
  return `sha256:${Buffer.from(value).toString("hex")}`;
}

interface ProjectionSetDigestEntryLike {
  readonly projection_kind: string;
  readonly generator?: string;
  readonly generator_version?: string;
  readonly generator_configuration_digest?: string;
  readonly projection_set_digest: string;
}

const DIGEST_BATCH_SIZE = 8_192;

/** Decodes one `NativeDigestBatch`'s contiguous `keys`/`digests` buffers
 * into `{member_digest, logical_digest}` entries, lazily (a generator, not
 * an array) -- see `BucketedMerkleSet.fromSortedBatches`'s doc comment for
 * why this matters at corpus scale. */
function* decodeDigestBatch(batch: NativeDigestBatch): Generator<{ readonly member_digest: string; readonly logical_digest: string }> {
  const count = batch.keys.byteLength / 32;
  for (let index = 0; index < count; index += 1) {
    const keyHex = Buffer.from(batch.keys.buffer, batch.keys.byteOffset + index * 32, 32).toString("hex");
    const digestHex = Buffer.from(batch.digests.buffer, batch.digests.byteOffset + index * 32, 32).toString("hex");
    yield { member_digest: `sha256:${keyHex}`, logical_digest: `sha256:${digestHex}` };
  }
}

/** Pages through a `handle.iterVisible*Digests`-shaped cursor method,
 * yielding each raw batch's decoded entries lazily. Mirrors
 * `NativeCanonicalQuerySnapshotPort`'s own `scanAll`/`iterVisibleBatch`
 * cursor loop (`native-query-snapshot-port.ts`): a full (== batchSize)
 * page always carries a cursor (even as the last page); exhaustion is
 * only known once a fetch returns fewer rows than requested. */
function* iterateNativeDigestBatches(fetchBatch: (cursor: string | undefined) => NativeDigestBatch): Generator<Iterable<{ readonly member_digest: string; readonly logical_digest: string }>> {
  let cursor: string | undefined;
  for (;;) {
    const batch = fetchBatch(cursor);
    yield decodeDigestBatch(batch);
    if (batch.nextCursor === undefined) return;
    cursor = batch.nextCursor;
  }
}

type LeafKind = "records" | "dependency" | "graph";

const LEAF_FETCHER_BY_KIND: Readonly<Record<LeafKind, (handle: NativeStructuralStoreHandle, generation: number, batchSize: number, cursor: string | undefined) => NativeDigestBatch>> = {
  records: (handle, generation, batchSize, cursor) => handle.iterVisibleDigests(generation, batchSize, cursor),
  graph: (handle, generation, batchSize, cursor) => handle.iterVisibleGraphDigests(generation, batchSize, cursor),
  dependency: (handle, generation, batchSize, cursor) => handle.iterVisibleDependencyDigests(generation, batchSize, cursor),
};

/** Streams `kind`'s leaves straight from the native handle into a fresh
 * {@link BucketedMerkleSet}, via {@link BucketedMerkleSet.fromSortedBatches}
 * -- the genuine from-scratch recompute (see module doc). */
function leafTreeFor(handle: NativeStructuralStoreHandle, kind: LeafKind, generation: number): BucketedMerkleSet {
  const fetcher = LEAF_FETCHER_BY_KIND[kind];
  return BucketedMerkleSet.fromSortedBatches(iterateNativeDigestBatches((cursor) => fetcher(handle, generation, DIGEST_BATCH_SIZE, cursor)));
}

/**
 * From-scratch v4 `lifecycle.verify` (see module doc for exactly what "from
 * scratch" does and does not cover here). Reports the same three v3 error
 * codes named by the task brief (`storage:canonical_record_set_digest` ->
 * `storage:canonical_set_digest_corrupt`, projection sets ->
 * `storage:projection_set_digest_corrupt`, the envelope ->
 * `storage:snapshot_digest_corrupt`), plus one new, consistently-styled
 * code (`storage:source_state_digest_corrupt`) for the genuinely-new
 * from-scratch check this module can do that v3's `verify()` never
 * attempted (v3 trusts `source_state_digest` as an input to the envelope
 * check rather than independently recomputing it against a frontier).
 */
export async function verifyV4Workspace(database: SqliteDatabase, structuralRoot: string, workspaceId: string): Promise<VerificationReport> {
  const failures: VerificationFailure[] = [];

  const current = await database.get<{ current_generation: number; current_snapshot_id: string }>("SELECT current_generation, current_snapshot_id FROM workspace_current_state WHERE workspace_id = ?", [workspaceId]);
  if (current === undefined) return { ok: true, failures: [] }; // never scanned yet: nothing to verify.
  const snapshot = await database.get<{
    snapshot_id: string; workspace_id: string; generation: number; parent_snapshot_id: string | null; generation_manifest_id: string;
    registry_snapshot_id: string; resolution_lock_id: string; configuration_revision_id: string; source_state_digest: string;
    source_observation_watermarks: string; canonical_record_set_digest: string; projection_set_digests: string;
    capability_state_digest: string; published_at: string; snapshot_digest: string;
  }>(
    "SELECT snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest FROM snapshots WHERE workspace_id = ? AND snapshot_id = ?",
    [workspaceId, current.current_snapshot_id],
  );
  if (snapshot === undefined) {
    failures.push({ component_kind: "current_tuple", component_id: workspaceId, error_code: "storage:current_tuple_corrupt" });
    return { ok: false, failures };
  }
  const generation = snapshot.generation;

  // -- source_state_digest: fully from-scratch, no native store needed. --
  const { present, absent } = await presentAndAbsentEntries(database, workspaceId);
  const presentTree = BucketedMerkleSet.fromSorted(present);
  const absentTree = BucketedMerkleSet.fromSorted(absent);
  const expectedSourceStateDigest = sourceStateDigest(presentTree.root(), presentTree.size(), absentTree.root(), absentTree.size());
  if (snapshot.source_state_digest !== expectedSourceStateDigest) {
    failures.push({ component_kind: "snapshot", component_id: snapshot.snapshot_id, error_code: "storage:source_state_digest_corrupt" });
  }

  // -- merkle_roots (the durable authority, per that table's own schema
  // comment) vs. each set's persisted .tree file, MANIFEST, and the native
  // handle's own counters. --
  const merkleRootsRows = await database.all<{ set_kind: string; generation: number; root: Uint8Array; member_count: number }>(
    "SELECT set_kind, generation, root, member_count FROM merkle_roots WHERE generation = ?",
    [generation],
  );
  const merkleRootsByKind = new Map(merkleRootsRows.map((row) => [row.set_kind, row]));
  const manifest = await readManifest(structuralRoot);

  let addonAvailable = true;
  try {
    loadNativeStructuralStoreAddon();
  } catch {
    addonAvailable = false;
    // Native addon not built in this process -- the tree-file/SQL/MANIFEST
    // cross-checks below still run; every native-handle-backed check
    // (including leaf-level verification) is skipped entirely.
  }

  let nativeGeneration: number | undefined;
  let nativeVisibleCount: number | undefined;
  let handle: NativeStructuralStoreHandle | undefined;
  if (addonAvailable) {
    try {
      const addon = loadNativeStructuralStoreAddon();
      handle = addon.NativeStructuralStoreHandle.open(structuralRoot);
      handle.reopenIfChanged();
      nativeGeneration = handle.currentGeneration();
      nativeVisibleCount = handle.visibleCount(generation);
    } catch {
      // Unlike the addon-load failure above, this IS reportable
      // corruption: `NativeStructuralStoreHandle.open` re-verifies each
      // base segment's `records.keys`/`records.meta`/`records.digests`
      // xxh3 checksums on open (`StoreInner::load`'s "sample-verify... per
      // open"), so a failure here means the on-disk structural store
      // itself is unreadable/corrupt -- exactly the class of failure this
      // check exists to catch, not something to silently swallow the way
      // "addon not built" is. `handle` stays `undefined`, so the
      // leaf-level loop below skips (nothing more to check without a
      // working handle), but this failure alone already makes the report
      // non-ok.
      failures.push({ component_kind: "canonical", component_id: `records@${generation}`, error_code: "storage:canonical_set_digest_corrupt" });
    }
  }

  const canonicalKinds = ["records", "dependency", "graph", "metric"] as const;
  const treeRoots = new Map<string, V4MerkleTreeFile>();
  for (const kind of canonicalKinds) {
    const file = await readTreeFile(join(structuralRoot, "merkle", `${kind}.tree`));
    if (file !== undefined) treeRoots.set(kind, file);
  }

  for (const kind of canonicalKinds) {
    const file = treeRoots.get(kind);
    const roots = merkleRootsByKind.get(kind);
    const errorCode = kind === "records" ? "storage:canonical_set_digest_corrupt" : "storage:projection_set_digest_corrupt";
    if (file !== undefined && file.recomputedRoot !== file.headerRoot) {
      failures.push({ component_kind: kind === "records" ? "canonical" : kind, component_id: `${kind}@${generation}`, error_code: errorCode });
      continue; // the file's own node levels are already inconsistent; skip the downstream cross-checks below for this kind.
    }
    const fileRoot = file?.headerRoot;
    const sqlRoot = roots ? blobDigest(roots.root) : undefined;
    if (fileRoot !== undefined && sqlRoot !== undefined && fileRoot !== sqlRoot) {
      failures.push({ component_kind: kind === "records" ? "canonical" : kind, component_id: `${kind}@${generation}`, error_code: errorCode });
    }
    if (roots !== undefined && file !== undefined && roots.member_count !== file.count) {
      failures.push({ component_kind: kind === "records" ? "canonical" : kind, component_id: `${kind}@${generation}`, error_code: errorCode });
    }
    if ((kind === "records" || kind === "dependency") && manifest !== undefined) {
      const manifestRoot = manifest.roots[kind];
      if (typeof manifestRoot === "string" && fileRoot !== undefined && manifestRoot !== fileRoot) {
        failures.push({ component_kind: kind === "records" ? "canonical" : kind, component_id: `${kind}@${generation}`, error_code: errorCode });
      }
    }

    // -- Leaf-level, from-scratch recompute (see module doc): stream this
    // set's actual member data through the native handle's raw digest
    // iterators and compare against whatever authority is available
    // (persisted .tree file's own header root, or -- when no file has
    // been written yet -- the merkle_roots SQL row directly). `metric` has
    // no native leaf source (it is an always-empty placeholder projection,
    // no producer emits `metric_projections`-equivalent rows today), so
    // it stays covered only by the file/SQL/MANIFEST cross-checks above.
    if (handle !== undefined && kind !== "metric") {
      const leafTree = leafTreeFor(handle, kind, generation);
      const leafRoot = leafTree.root();
      const expectedRoot = fileRoot ?? sqlRoot;
      if (expectedRoot !== undefined && leafRoot !== expectedRoot) {
        failures.push({ component_kind: kind === "records" ? "canonical" : kind, component_id: `${kind}@${generation}`, error_code: errorCode });
      }
      const expectedCount = file?.count ?? roots?.member_count;
      if (expectedCount !== undefined && leafTree.size() !== expectedCount) {
        failures.push({ component_kind: kind === "records" ? "canonical" : kind, component_id: `${kind}@${generation}`, error_code: errorCode });
      }
    }
  }
  if (nativeVisibleCount !== undefined && nativeGeneration !== undefined && nativeGeneration >= generation) {
    const recordsRoots = merkleRootsByKind.get("records");
    if (recordsRoots !== undefined && recordsRoots.member_count !== nativeVisibleCount) {
      failures.push({ component_kind: "canonical", component_id: `records@${generation}`, error_code: "storage:canonical_set_digest_corrupt" });
    }
  }

  // -- Snapshot.canonical_record_set_digest / .projection_set_digests
  // against the (now cross-checked) merkle_roots authority. --
  const recordsRoots = merkleRootsByKind.get("records");
  if (recordsRoots !== undefined) {
    const expected = recordSetDigest(blobDigest(recordsRoots.root) ?? ZERO_ROOT, recordsRoots.member_count);
    if (snapshot.canonical_record_set_digest !== expected) {
      failures.push({ component_kind: "canonical", component_id: snapshot.snapshot_id, error_code: "storage:canonical_set_digest_corrupt" });
    }
  }
  try {
    const declared = JSON.parse(snapshot.projection_set_digests) as readonly ProjectionSetDigestEntryLike[];
    if (Array.isArray(declared)) {
      for (const entry of declared) {
        const roots = merkleRootsByKind.get(entry.projection_kind);
        if (roots === undefined) continue;
        const expected = projectionSetDigest(entry.projection_kind, blobDigest(roots.root) ?? ZERO_ROOT, roots.member_count);
        if (entry.projection_set_digest !== expected) {
          failures.push({ component_kind: entry.projection_kind, component_id: `${snapshot.snapshot_id}/${entry.projection_kind}`, error_code: "storage:projection_set_digest_corrupt" });
        }
      }
    }
  } catch {
    failures.push({ component_kind: "canonical", component_id: snapshot.snapshot_id, error_code: "storage:projection_set_digest_corrupt" });
  }

  // -- snapshot_digest: the same envelope recipe as v3
  // (`packages/storage/src/lifecycle.ts`'s snapshot loop), over the SAME
  // 20-column `snapshots` row shape a v4 cold scan writes (verified
  // directly against `crates/urdira-indexing-worker/src/v4/publish.rs`'s
  // INSERT statement). --
  const positive: Record<string, unknown> = {
    snapshot_id: snapshot.snapshot_id,
    workspace_id: snapshot.workspace_id,
    generation: snapshot.generation,
    ...(snapshot.parent_snapshot_id === null ? {} : { parent_snapshot_id: snapshot.parent_snapshot_id }),
    generation_manifest_id: snapshot.generation_manifest_id,
    registry_snapshot_id: snapshot.registry_snapshot_id,
    resolution_lock_id: snapshot.resolution_lock_id,
    configuration_revision_id: snapshot.configuration_revision_id,
    source_state_digest: snapshot.source_state_digest,
    source_observation_watermarks: snapshot.source_observation_watermarks,
    canonical_record_set_digest: snapshot.canonical_record_set_digest,
    projection_set_digests: snapshot.projection_set_digests,
    capability_state_digest: snapshot.capability_state_digest,
    published_at: snapshot.published_at,
  };
  const expectedSnapshotDigest = computeDigest("core:snapshot", "core:snapshot_digest", 1, "core:SnapshotDigestPayload", 1, positive);
  if (snapshot.snapshot_digest !== expectedSnapshotDigest) {
    failures.push({ component_kind: "snapshot", component_id: snapshot.snapshot_id, error_code: "storage:snapshot_digest_corrupt" });
  }

  return { ok: failures.length === 0, failures };
}
