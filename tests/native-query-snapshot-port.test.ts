// v4 plan P2-5: parity tests between `NativeCanonicalQuerySnapshotPort`
// (crates/urdira-structural-store + crates/urdira-native-node, via napi)
// and `SqliteCanonicalQuerySnapshotPort` (the existing production port),
// both reading the SAME v3-seeded workspace fixture -- the native side
// through `convertV3WorkspaceToNativeStore`. Local fixture helpers mirror
// `tests/phase-canonical-query-data-port.test.ts`'s (not imported: those
// are module-private there) rather than duplicating that file's own test
// cases.
//
// Skips entirely (not a failure) when the native addon has not been built
// yet -- see `native-structural-store-binding.ts`'s doc comment for how to
// build it (`node scripts/build-native.mjs`, or for faster local
// iteration, `cargo build -p urdira-native-node --release` and copy the
// produced dylib to `release/native/<target>/urdira-native.node`).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestBytes, encodeCanonical } from "@urdira/canonical";
import type { QueryScope } from "@urdira/contracts";
import { createDurableStorage } from "../packages/storage/src/index.js";
import {
  CanonicalRecordQueryDataPort,
  NativeCanonicalQuerySnapshotPort,
  SqliteCanonicalQuerySnapshotPort,
  convertV3WorkspaceToNativeStore,
  loadNativeStructuralStoreAddon,
  type CanonicalQueryRecord,
} from "../packages/engine/src/index.js";

let addonAvailable = true;
try {
  loadNativeStructuralStoreAddon();
} catch {
  addonAvailable = false;
}
const maybeDescribe = addonAvailable ? describe : describe.skip;
if (!addonAvailable) {
  console.warn("[native-query-snapshot-port.test] native addon not built; skipping native-port parity tests. Run: node scripts/build-native.mjs");
}

const now = "2026-09-02T00:00:00.000Z";
const workspace = {
  workspace_id: "ws-native-query-port",
  canonical_root: "/native-query-port",
  display_root: "/native-query-port",
  source_provider_bindings: [],
  status: "registered",
  registered_at: now,
};
const scope: QueryScope = { scope_type: "single_workspace", workspace_id: workspace.workspace_id };

type Opened = Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>;

async function withWorkspace(test: (opened: Opened, storeDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "urdira-native-query-port-"));
  const storage = await createDurableStorage({ rootDir: root });
  try {
    await storage.catalog.registerWorkspace(workspace);
    const opened = await storage.openWorkspace(workspace.workspace_id);
    try {
      await test(opened, join(root, "native-store"));
    } finally {
      await opened.close();
    }
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function seedBaseline(opened: Opened, generation = 1): Promise<void> {
  const db = opened.database;
  await db.exec("PRAGMA foreign_keys = OFF");
  await db.run("INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest) VALUES (?, ?, ?, ?, ?, ?)", ["registry-1", workspace.workspace_id, "1", "core-digest", "lock-1", "registry-digest-1"]);
  await db.run("INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["snapshot-1", workspace.workspace_id, generation, "manifest-1", "registry-1", "lock-1", "configuration-1", "source-digest", "[]", "records-digest", "projections-digest", "capabilities-digest", now, "snapshot-digest-1"]);
  await db.run("INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [workspace.workspace_id, "snapshot-1", generation, "registry-1", "lock-1", "configuration-1", "freshness-1", 1, now]);
}

async function insertArtifactVersion(opened: Opened, artifactVersionId: string, artifactId: string, normalizedPath: string): Promise<void> {
  await opened.database.run("INSERT OR IGNORE INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind) VALUES (?, ?, ?, ?, ?, 'source_file')", [artifactId, workspace.workspace_id, `file:///native-query-port/${normalizedPath}`, normalizedPath, normalizedPath]);
  await opened.database.run("INSERT INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [`blob-${artifactVersionId}`, `sha256:${artifactVersionId}`, 0, "inline"]);
  await opened.database.run("INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation) VALUES (?, ?, ?, ?, ?, 0, 'utf-8', 'typescript', 'metadata-digest', 'observation-1', 0, NULL)", [artifactVersionId, workspace.workspace_id, artifactId, `blob-${artifactVersionId}`, `sha256:${artifactVersionId}`]);
}

interface InsertRecordOptions {
  readonly recordId: string;
  readonly category: "entity" | "relation" | "fact" | "evidence" | "diagnostic";
  readonly kind: string;
  readonly universalKind: string;
  readonly ownerArtifactVersionId: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly span?: { readonly artifactVersionId: string; readonly startByte: number; readonly endByte: number; readonly startLine?: number; readonly endLine?: number };
  readonly validFromGeneration?: number;
}

async function insertRecordOccurrence(opened: Opened, options: InsertRecordOptions): Promise<void> {
  const payload = encodeCanonical(options.body);
  await opened.database.run(
    `INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id,
       primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line,
       valid_from_generation, valid_to_generation, record_digest, body_digest, body_byte_length, body_payload, analysis_digest, analysis_configuration_digest, artifact_dependency_digest)
     VALUES (?, ?, ?, ?, ?, 1, 'test', '1', 'art-1', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'analysis', 'configuration', 'dependencies')`,
    [
      options.recordId, workspace.workspace_id, options.category, options.kind, options.universalKind, options.ownerArtifactVersionId,
      // Span byte/line columns are TEXT (matches the real publication
      // writer, which always binds pre-stringified values) -- binding a
      // raw JS number here would let the driver coerce it through
      // SQLite's REAL storage class, round-tripping as e.g. "20.0" rather
      // than "20" and creating a span-format mismatch that has nothing to
      // do with either query port.
      options.span?.artifactVersionId ?? null, options.span !== undefined ? String(options.span.startByte) : null, options.span !== undefined ? String(options.span.endByte) : null, options.span?.startLine !== undefined ? String(options.span.startLine) : null, options.span?.endLine !== undefined ? String(options.span.endLine) : null,
      options.validFromGeneration ?? 1, `digest-${options.recordId}`, digestBytes(payload), payload.byteLength, payload,
    ],
  );
}

async function insertIdentityAssignment(opened: Opened, recordId: string, identityId: string, identityKey: string, ownerArtifactVersionId: string, validFromGeneration = 1): Promise<void> {
  await opened.database.run(
    "INSERT INTO identity_assignments (identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, previous_record_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation) VALUES (?, ?, 'entity', ?, 'created', ?, ?, ?, NULL, 'art-1', ?, ?, NULL)",
    [`ia-${recordId}`, workspace.workspace_id, identityId, identityKey, `digest-${identityKey}`, recordId, ownerArtifactVersionId, validFromGeneration],
  );
}

async function insertRecordFacet(opened: Opened, recordId: string, facet: string, ordinal: number, validFromGeneration = 1): Promise<void> {
  await opened.database.run("INSERT INTO record_facets (workspace_id, record_id, valid_from_generation, facet_ordinal, facet) VALUES (?, ?, ?, ?, ?)", [workspace.workspace_id, recordId, validFromGeneration, ordinal, facet]);
}

async function insertArtifactDependency(opened: Opened, recordId: string, ownerArtifactVersionId: string, depArtifactId: string, depArtifactVersionId: string, role: string, validFromGeneration = 1): Promise<void> {
  await opened.database.run(
    "INSERT INTO artifact_dependencies (dependency_entry_id, workspace_id, record_id, owner_artifact_id, owner_artifact_version_id, dependency_artifact_id, dependency_artifact_version_id, dependency_role, producer_id, producer_version, valid_from_generation, valid_to_generation, content_digest) VALUES (?, ?, ?, 'art-1', ?, ?, ?, ?, 'test', '1', ?, NULL, ?)",
    [`dep-${recordId}-${depArtifactVersionId}`, workspace.workspace_id, recordId, ownerArtifactVersionId, depArtifactId, depArtifactVersionId, role, validFromGeneration, `digest-dep-${recordId}`],
  );
}

async function seedFixture(opened: Opened): Promise<void> {
  await seedBaseline(opened);
  await insertArtifactVersion(opened, "artv-1", "art-1", "src/index.ts");
  await insertArtifactVersion(opened, "artv-2", "art-2", "src/other.ts");

  // A container/module record for `container_records_by_artifact_references`.
  await insertRecordOccurrence(opened, { recordId: "record:" + "0".repeat(63) + "1", category: "entity", kind: "module", universalKind: "core:container", ownerArtifactVersionId: "artv-1", body: { path: "src/index.ts" } });

  // Two function entities (one per file), each with an identity + a facet.
  await insertRecordOccurrence(opened, { recordId: "record:" + "a".repeat(64), category: "entity", kind: "function_declaration", universalKind: "core:function", ownerArtifactVersionId: "artv-1", body: { name: "myFunc" }, span: { artifactVersionId: "artv-1", startByte: 10, endByte: 20, startLine: 1, endLine: 1 } });
  await insertIdentityAssignment(opened, "record:" + "a".repeat(64), "identity:" + "1".repeat(64), "jsts:function:src/index.ts:10:myFunc", "artv-1");
  await insertRecordFacet(opened, "record:" + "a".repeat(64), "core:exported", 0);

  await insertRecordOccurrence(opened, { recordId: "record:" + "b".repeat(64), category: "entity", kind: "function_declaration", universalKind: "core:function", ownerArtifactVersionId: "artv-2", body: { name: "otherFunc" }, span: { artifactVersionId: "artv-2", startByte: 5, endByte: 15, startLine: 2, endLine: 2 } });
  await insertIdentityAssignment(opened, "record:" + "b".repeat(64), "identity:" + "2".repeat(64), "jsts:function:src/other.ts:5:otherFunc", "artv-2");

  // A relation record (a call from myFunc to otherFunc).
  await insertRecordOccurrence(opened, {
    recordId: "record:" + "c".repeat(64), category: "relation", kind: "jsts:call", universalKind: "core:call", ownerArtifactVersionId: "artv-1",
    body: { source_id: "jsts:function:src/index.ts:10:myFunc", target_id: "jsts:function:src/other.ts:5:otherFunc", classification: "confirmed" },
  });

  await insertArtifactDependency(opened, "record:" + "c".repeat(64), "artv-1", "art-2", "artv-2", "jsts:resolution_input");
}

function sortById(records: readonly CanonicalQueryRecord[]): CanonicalQueryRecord[] {
  return [...records].sort((left, right) => left.record_id.localeCompare(right.record_id));
}

/** Body/facets/span/identity-level equality -- `workspace_id` is
 * necessarily identical (same scope) so this is a byte-for-byte content
 * comparison of what each port decoded. */
function expectSameRecords(nativeRecords: readonly CanonicalQueryRecord[], sqliteRecords: readonly CanonicalQueryRecord[]): void {
  expect(sortById(nativeRecords)).toEqual(sortById(sqliteRecords));
}

maybeDescribe("NativeStoreBuilder / NativeStructuralStoreHandle round trip", () => {
  it("writes a base segment and serves every implemented read op", async () => {
    const addon = loadNativeStructuralStoreAddon();
    const root = await mkdtemp(join(tmpdir(), "urdira-native-store-roundtrip-"));
    try {
      const dir = join(root, "store");
      const builder = new addon.NativeStoreBuilder();
      builder.create(dir, 1);
      builder.addRecords([
        {
          recordIdHex: "a".repeat(64), ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFrom: 1, validTo: 0,
          category: "entity", kind: "function_declaration", universalKind: "core:function", facets: ["core:exported"],
          spanArtifactId: "art-1", spanArtifactVersionId: "artv-1", spanStartByte: 10, spanEndByte: 20, spanStartLine: 1, spanEndLine: 1,
          identityId: `identity:${"b".repeat(64)}`, identityKey: "jsts:function:src/index.ts:10:myFunc",
          bodyPayload: encodeCanonical({ name: "myFunc" }),
        },
        {
          recordIdHex: "c".repeat(64), ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFrom: 1, validTo: 0,
          category: "relation", kind: "jsts:call", universalKind: "core:call", facets: [],
          relationKind: "core:call", sourceSubject: "jsts:function:src/index.ts:10:myFunc", targetSubject: "jsts:function:src/other.ts:5:otherFunc",
          bodyPayload: encodeCanonical({ source_id: "jsts:function:src/index.ts:10:myFunc", target_id: "jsts:function:src/other.ts:5:otherFunc", classification: "confirmed" }),
        },
      ]);
      builder.addDependencies([{ recordIdHex: "c".repeat(64), ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", depArtifactId: "art-2", depArtifactVersionId: "artv-2", role: "jsts:resolution_input", validFrom: 1, validTo: 0 }]);
      const summary = builder.finish();
      expect(summary.rowCount).toBe(2);
      expect(summary.dependencyCount).toBe(1);
      expect(summary.recordsRoot).toMatch(/^sha256:/);

      const handle = addon.NativeStructuralStoreHandle.open(dir);
      expect(handle.currentGeneration()).toBe(1);
      expect(handle.reopenIfChanged()).toBe(false);
      expect(handle.visibleCount(1)).toBe(2);

      const byId = handle.recordsByIds(["a".repeat(64)], 1);
      expect(byId).toHaveLength(1);
      expect(byId[0]?.recordId).toBe(`record:${"a".repeat(64)}`);
      expect(byId[0]?.facetRows).toEqual(["core:exported"]);
      expect(byId[0]?.identityKey).toBe("jsts:function:src/index.ts:10:myFunc");

      expect(handle.recordsByName("myFunc", 1)).toHaveLength(1);
      expect(handle.recordsByKindExact("core:function", "entity", "function_declaration", 1, 10)).toHaveLength(1);

      const edges = handle.adjacency(["jsts:function:src/index.ts:10:myFunc"], "outbound", 1);
      expect(edges).toHaveLength(1);
      expect(edges[0]?.targetSubjectId).toBe("jsts:function:src/other.ts:5:otherFunc");
      expect(edges[0]?.evidenceClass).toBe("confirmed");

      // Pagination contract matches `SqliteCanonicalQuerySnapshotPort.records_for_query_batches`'s
      // own: a full (== batchSize) page always carries a cursor, even when
      // it happens to be the last page; exhaustion is only known once a
      // fetch returns FEWER rows than requested (here: zero).
      const batch = handle.iterVisibleBatch(1, 1);
      expect(batch.rows).toHaveLength(1);
      expect(batch.nextCursor).toBeDefined();
      const secondBatch = handle.iterVisibleBatch(1, 1, batch.nextCursor);
      expect(secondBatch.rows).toHaveLength(1);
      const thirdBatch = handle.iterVisibleBatch(1, 1, secondBatch.nextCursor);
      expect(thirdBatch.rows).toHaveLength(0);

      const dicts = handle.dictionaries();
      const ownerOrdinal = dicts.artifacts.findIndex((pair) => pair.artifactVersionId === "artv-1");
      expect(ownerOrdinal).toBeGreaterThanOrEqual(0);
      expect(handle.recordsByOwnerOrdinal(ownerOrdinal, 1)).toHaveLength(2);

      const depOrdinal = dicts.artifacts.findIndex((pair) => pair.artifactVersionId === "artv-2");
      expect(handle.depsReverse(depOrdinal, 1)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Additive (task: raw digest-iterator follow-up to P2-4): `iterVisibleDigests`/
  // `iterVisibleGraphDigests`/`iterVisibleDependencyDigests` are the leaf
  // export `packages/engine/src/v4-verify.ts` streams into
  // `BucketedMerkleSet.fromSortedBatches` for a genuine from-scratch
  // records/dependency/graph root recompute. This test exercises them
  // directly against the raw napi handle (no verify/SQL involved): sorted
  // key order, no duplicates/drops, cursor/batching correctness at a
  // batch size smaller than the corpus, and (for records) that every
  // returned digest matches the SAME record's `recordDigest` as returned
  // by `recordsByIds`.
  it("iterVisibleDigests/iterVisibleGraphDigests/iterVisibleDependencyDigests return sorted, gap-free, cursor-paginated leaves", async () => {
    const addon = loadNativeStructuralStoreAddon();
    const root = await mkdtemp(join(tmpdir(), "urdira-native-store-digests-"));
    try {
      const dir = join(root, "store");
      const builder = new addon.NativeStoreBuilder();
      builder.create(dir, 1);
      const entityIds = ["a", "b", "c"].map((c) => c.repeat(64));
      const relationIds = ["d", "e"].map((c) => c.repeat(64));
      builder.addRecords([
        ...entityIds.map((id, i) => ({
          recordIdHex: id, ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFrom: 1, validTo: 0,
          category: "entity" as const, kind: "function_declaration", universalKind: "core:function", facets: [],
          bodyPayload: encodeCanonical({ name: `fn${i}` }),
        })),
        ...relationIds.map((id, i) => ({
          recordIdHex: id, ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFrom: 1, validTo: 0,
          category: "relation" as const, kind: "jsts:call", universalKind: "core:call", facets: [],
          relationKind: "core:call", sourceSubject: `subj-src-${i}`, targetSubject: `subj-dst-${i}`,
          bodyPayload: encodeCanonical({ i }),
        })),
      ]);
      builder.addDependencies([
        { recordIdHex: relationIds[0]!, ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", depArtifactId: "art-2", depArtifactVersionId: "artv-2", role: "jsts:resolution_input", validFrom: 1, validTo: 0 },
        { recordIdHex: relationIds[1]!, ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", depArtifactId: "art-3", depArtifactVersionId: "artv-3", role: "jsts:resolution_input", validFrom: 1, validTo: 0 },
      ]);
      builder.finish();

      const handle = addon.NativeStructuralStoreHandle.open(dir);
      expect(handle.visibleCount(1)).toBe(5);

      function collect(fetch: (cursor: string | undefined) => { keys: Uint8Array; digests: Uint8Array; nextCursor?: string }, batchSize: number): { readonly keys: readonly string[]; readonly digests: readonly string[] } {
        const keys: string[] = [];
        const digests: string[] = [];
        let cursor: string | undefined;
        let sawShortBatch = false;
        for (;;) {
          const batch = fetch(cursor);
          const count = batch.keys.byteLength / 32;
          expect(batch.digests.byteLength).toBe(batch.keys.byteLength);
          if (count < batchSize) sawShortBatch = true;
          else expect(sawShortBatch).toBe(false); // a full page never follows a short one.
          for (let i = 0; i < count; i += 1) {
            keys.push(Buffer.from(batch.keys.buffer, batch.keys.byteOffset + i * 32, 32).toString("hex"));
            digests.push(Buffer.from(batch.digests.buffer, batch.digests.byteOffset + i * 32, 32).toString("hex"));
          }
          if (batch.nextCursor === undefined) return { keys, digests };
          cursor = batch.nextCursor;
        }
      }

      // records: all 5, ascending, no duplicates, batch size 2 (< corpus,
      // so multiple pages are exercised).
      const records = collect((cursor) => handle.iterVisibleDigests(1, 2, cursor), 2);
      expect(records.keys).toHaveLength(5);
      expect(new Set(records.keys).size).toBe(5);
      expect(records.keys).toEqual([...records.keys].sort());
      const byId = handle.recordsByIds([...entityIds, ...relationIds], 1);
      const recordDigestByHex = new Map(byId.map((row) => [row.recordId.slice("record:".length), row.recordDigest.slice("sha256:".length)]));
      for (const [index, key] of records.keys.entries()) expect(records.digests[index]).toBe(recordDigestByHex.get(key));

      // graph: only the two relation records, still ascending, batch size 1.
      const graph = collect((cursor) => handle.iterVisibleGraphDigests(1, 1, cursor), 1);
      expect(graph.keys).toEqual([...relationIds].sort());

      // dependency: both dependency rows, ascending, batch size 1, no
      // duplicates -- exercises the sort-then-page path (`iter_visible_deps`
      // is not itself globally key-sorted; the napi method sorts before
      // paging, see its Rust doc comment).
      const deps = collect((cursor) => handle.iterVisibleDependencyDigests(1, 1, cursor), 1);
      expect(deps.keys).toHaveLength(2);
      expect(new Set(deps.keys).size).toBe(2);
      expect(deps.keys).toEqual([...deps.keys].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

maybeDescribe("NativeCanonicalQuerySnapshotPort vs SqliteCanonicalQuerySnapshotPort", () => {
  it("records_by_ids returns identical records for record_id, identity_id, and identity_key forms", async () => {
    await withWorkspace(async (opened, storeDir) => {
      await seedFixture(opened);
      await convertV3WorkspaceToNativeStore(opened.database, workspace.workspace_id, 1, storeDir);
      const sqlite = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const native = NativeCanonicalQuerySnapshotPort.open(opened.database, storeDir, sqlite);

      for (const id of ["record:" + "a".repeat(64), "identity:" + "2".repeat(64), "jsts:function:src/index.ts:10:myFunc"]) {
        const sqliteResult = await sqlite.records_by_ids!(scope, [id]);
        const nativeResult = await native.records_by_ids(scope, [id]);
        expectSameRecords(nativeResult, sqliteResult);
        expect(nativeResult.length).toBeGreaterThan(0);
      }
    });
  });

  it("records_by_name matches, MODULO a discovered pre-existing SQLite-port gap (see evidence doc): SqliteCanonicalQuerySnapshotPort.records_by_name's own SQL never selects the primary_source_span_* columns (unlike records_by_ids/records()/records_by_selector, which all do), so it always omits primary_source_span regardless of the underlying data. The native port has no such gap -- every one of its methods returns the full row, span included -- so this is flagged as a real, pre-existing SQLite-port bug, not hidden by loosening the native side.", async () => {
    await withWorkspace(async (opened, storeDir) => {
      await seedFixture(opened);
      await convertV3WorkspaceToNativeStore(opened.database, workspace.workspace_id, 1, storeDir);
      const sqlite = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const native = NativeCanonicalQuerySnapshotPort.open(opened.database, storeDir, sqlite);
      const sqliteResult = await sqlite.records_by_name!(scope, "otherFunc");
      const nativeResult = (await native.records_by_name(scope, "otherFunc")).map((record) => {
        const { primary_source_span: _dropped, ...rest } = record;
        return rest as CanonicalQueryRecord;
      });
      expectSameRecords(nativeResult, sqliteResult);
      expect(nativeResult).toHaveLength(1);
    });
  });

  it("records_by_selector matches for a fully-specified and a partially-specified selector", async () => {
    await withWorkspace(async (opened, storeDir) => {
      await seedFixture(opened);
      await convertV3WorkspaceToNativeStore(opened.database, workspace.workspace_id, 1, storeDir);
      const sqlite = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const native = NativeCanonicalQuerySnapshotPort.open(opened.database, storeDir, sqlite);
      for (const selector of [{ categories: ["entity"], universal_kinds: ["core:function"], kinds: ["function_declaration"] }, { categories: ["entity"] }]) {
        const sqliteResult = await sqlite.records_by_selector!(scope, selector, 100);
        const nativeResult = await native.records_by_selector(scope, selector, 100);
        expectSameRecords(nativeResult, sqliteResult);
      }
    });
  });

  it("container_records_by_artifact_references matches", async () => {
    await withWorkspace(async (opened, storeDir) => {
      await seedFixture(opened);
      await convertV3WorkspaceToNativeStore(opened.database, workspace.workspace_id, 1, storeDir);
      const sqlite = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const native = NativeCanonicalQuerySnapshotPort.open(opened.database, storeDir, sqlite);
      const sqliteResult = await sqlite.container_records_by_artifact_references!(scope, ["src/index.ts"]);
      const nativeResult = await native.container_records_by_artifact_references(scope, ["src/index.ts"]);
      expectSameRecords(nativeResult, sqliteResult);
      expect(nativeResult).toHaveLength(1);
    });
  });

  it("graph_edges_by_subject_ids and relation_pairs_by_subject_ids: native answers authoritatively (SQLite side has no graph_edges producer today)", async () => {
    // NOTE (evidence doc): this repo's current v3 production pipeline does
    // not populate `graph_edges` at all (verified: no INSERT INTO
    // graph_edges producer outside test fixtures) -- the SQLite port's
    // `graph_edges_by_subject_ids`/`relation_pairs_by_subject_ids` are
    // therefore normally `undefined` (no projection) in production. This
    // test seeds `graph_edges` manually with the SAME role/evidence_class
    // convention `NativeStoreBuilder`'s converter path picks (relation_kind
    // = universal_kind, role = relation_kind, evidence_class = "confirmed")
    // so the comparison is meaningful, not vacuous.
    await withWorkspace(async (opened, storeDir) => {
      await seedFixture(opened);
      await opened.database.run(
        "INSERT INTO graph_edges (edge_id, workspace_id, source_subject_id, target_subject_id, relation_record_id, relation_kind, role, evidence_class, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation, content_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
        [`edge:${"c".repeat(64)}`, workspace.workspace_id, "jsts:function:src/index.ts:10:myFunc", "jsts:function:src/other.ts:5:otherFunc", `record:${"c".repeat(64)}`, "core:call", "core:call", "confirmed", "art-1", "artv-1", 1, "digest-edge-c"],
      );
      await convertV3WorkspaceToNativeStore(opened.database, workspace.workspace_id, 1, storeDir);
      const sqlite = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const native = NativeCanonicalQuerySnapshotPort.open(opened.database, storeDir, sqlite);

      const sqliteEdges = await sqlite.graph_edges_by_subject_ids!(scope, ["jsts:function:src/index.ts:10:myFunc"], "outbound");
      const nativeEdges = await native.graph_edges_by_subject_ids(scope, ["jsts:function:src/index.ts:10:myFunc"], "outbound");
      expect(nativeEdges).toBeDefined();
      expect(sqliteEdges).toBeDefined();
      expect(nativeEdges?.map((e) => ({ ...e, edge_id: undefined }))).toEqual(sqliteEdges?.map((e) => ({ ...e, edge_id: undefined })));

      const sqlitePairs = await sqlite.relation_pairs_by_subject_ids!(scope, ["jsts:function:src/index.ts:10:myFunc"], ["jsts:function:src/other.ts:5:otherFunc"], { universal_kinds: ["core:call"] }, "outbound");
      const nativePairs = await native.relation_pairs_by_subject_ids(scope, ["jsts:function:src/index.ts:10:myFunc"], ["jsts:function:src/other.ts:5:otherFunc"], { universal_kinds: ["core:call"] }, "outbound");
      expect([...(nativePairs ?? [])]).toEqual([...(sqlitePairs ?? [])]);
      expect(nativePairs?.size).toBe(1);
    });
  });

  it("records()/records_for_query_batches() over the full corpus match", async () => {
    await withWorkspace(async (opened, storeDir) => {
      await seedFixture(opened);
      await convertV3WorkspaceToNativeStore(opened.database, workspace.workspace_id, 1, storeDir);
      const sqlite = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const native = NativeCanonicalQuerySnapshotPort.open(opened.database, storeDir, sqlite);
      const sqliteAll = await sqlite.records(scope);
      const nativeAll = await native.records(scope);
      expectSameRecords(nativeAll, sqliteAll);
      expect(nativeAll.length).toBeGreaterThanOrEqual(4);

      const nativeBatches: CanonicalQueryRecord[] = [];
      for await (const batch of native.records_for_query_batches!(scope, 1)) nativeBatches.push(...batch);
      expectSameRecords(nativeBatches, sqliteAll);
    });
  });

  it("rejects a query when the native store has not caught up to the workspace's current generation", async () => {
    await withWorkspace(async (opened, storeDir) => {
      await seedFixture(opened);
      await convertV3WorkspaceToNativeStore(opened.database, workspace.workspace_id, 1, storeDir);
      await opened.database.run("UPDATE workspace_current_state SET current_generation = 2 WHERE workspace_id = ?", [workspace.workspace_id]);
      const sqlite = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const native = NativeCanonicalQuerySnapshotPort.open(opened.database, storeDir, sqlite);
      await expect(native.records(scope)).rejects.toThrow(/has not caught up/);
    });
  });

  it("delegates non-structural methods to the wrapped SQLite port", async () => {
    await withWorkspace(async (opened, storeDir) => {
      await seedFixture(opened);
      await convertV3WorkspaceToNativeStore(opened.database, workspace.workspace_id, 1, storeDir);
      const sqlite = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const native = NativeCanonicalQuerySnapshotPort.open(opened.database, storeDir, sqlite);
      const sqliteArtifacts = await sqlite.artifacts_by_filter!(scope);
      const nativeArtifacts = await native.artifacts_by_filter!(scope);
      expect(nativeArtifacts).toEqual(sqliteArtifacts);
      expect(await native.has_warm_records!()).toBe(false);
    });
  });

  it("core:get_source and core:find_records resolve identically through CanonicalRecordQueryDataPort/QueryEngine on both ports", async () => {
    await withWorkspace(async (opened, storeDir) => {
      await seedFixture(opened);
      await convertV3WorkspaceToNativeStore(opened.database, workspace.workspace_id, 1, storeDir);
      const sqlite = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const native = NativeCanonicalQuerySnapshotPort.open(opened.database, storeDir, sqlite);
      const sqlitePort = new CanonicalRecordQueryDataPort(sqlite);
      const nativePort = new CanonicalRecordQueryDataPort(native);

      const getSource = { operation_id: "core:get_source" as const, operation_version: 1, result_streams: ["source"], arguments: { entities: [{ type: "record_id" as const, value: "record:" + "a".repeat(64) }] }, scope };
      const sqliteSource = await sqlitePort.execute(getSource);
      const nativeSource = await nativePort.execute(getSource);
      expect(nativeSource.streams["source"]).toEqual(sqliteSource.streams["source"]);

      const findRecords = { operation_id: "core:find_records" as const, operation_version: 1, result_streams: ["records"], arguments: { selector: { category: "entity", universal_kind: "core:function" } }, scope };
      const sqliteFound = await sqlitePort.execute(findRecords);
      const nativeFound = await nativePort.execute(findRecords);
      expect(nativeFound.streams["records"]).toEqual(sqliteFound.streams["records"]);
    });
  });
});
