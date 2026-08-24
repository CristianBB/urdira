import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { canonicalBytes, digestBytes, sortCanonicalValues } from "@urdira/canonical";
// `@urdira/engine`/`@urdira/plugin-javascript-typescript` are not root-level
// devDependencies, so (matching every tests/*.test.ts that touches them)
// this file imports them from src by relative path. The plugin-registry/
// workspace-registration harness itself is shared with
// tests/phase-workspace-fork.test.ts via tests/helpers/fork-harness.ts (see
// that module's header comment for why it is a plain helper module, not a
// re-import of the other .test.ts file).
import {
  attemptIndexPackImport,
  attemptWorkspaceFork,
  exportIndexPack,
  runFullWorkspaceScan,
  WorkspaceRegistry,
  type RegisteredWorkspace,
  type WorkspaceScanPluginProvider,
} from "../packages/engine/src/index.js";
import { createDurableStorage, type DurableStorage, type WorkspaceDatabase } from "../packages/storage/src/index.js";
import {
  FORK_INCLUSION_RULES as INDEX_PACK_INCLUSION_RULES,
  asDurableStorage,
  asStorageDatabase,
  buildPluginProvider,
  now,
  openEngineWorkspace,
  prepareRegistry,
  registerEngineWorkspace,
  seedFixtureFiles,
  type BuildPluginProviderOptions,
} from "./helpers/fork-harness.js";

/** `buildPluginProvider` takes a registry snapshot id, configuration revision id, and an `analyzedWorkspaceIds` tracker this file has no use for -- this supplies them consistently, mirroring `tests/phase-workspace-fork.test.ts`'s own `buildPluginProviderResolver`'s derivation of the same two ids. */
function providerFor(prepared: Awaited<ReturnType<typeof prepareRegistry>>, workspaceId: string, options?: BuildPluginProviderOptions): WorkspaceScanPluginProvider {
  return buildPluginProvider(prepared, workspaceId, prepared.registry.registry_snapshot_id, `configuration:${workspaceId}`, new Set(), options);
}

/** Reads an index pack's decompressed NDJSON lines as parsed JSON values. Test-only: production code never re-parses its own output this way. */
function readRawPackLines(bytes: Buffer): unknown[] {
  const text = gunzipSync(bytes).toString("utf8");
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as unknown);
}

function writeRawPackLines(lines: readonly unknown[]): Buffer {
  return gzipSync(Buffer.from(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8"));
}

function manifestDigestOf(manifest: Record<string, unknown>): string {
  const { manifest_digest: _digest, ...rest } = manifest;
  return digestBytes(canonicalBytes(rest));
}

interface Fixture {
  readonly dataRoot: string;
  readonly donorRoot: string;
  readonly storage: DurableStorage;
  readonly registry: WorkspaceRegistry;
  readonly donorWorkspace: RegisteredWorkspace;
  readonly donorDatabase: WorkspaceDatabase;
  readonly donorPlugin: WorkspaceScanPluginProvider;
  readonly packPath: string;
}

async function buildReadyDonorAndExport(label: string, providerOptions?: BuildPluginProviderOptions): Promise<Fixture> {
  const dataRoot = await mkdtemp(join(tmpdir(), `urdira-index-pack-${label}-data-`));
  const donorRoot = await mkdtemp(join(tmpdir(), `urdira-index-pack-${label}-donor-`));
  await seedFixtureFiles(donorRoot);
  const storage = await createDurableStorage({ rootDir: dataRoot });
  const registry = new WorkspaceRegistry();
  const donorWorkspace = await registerEngineWorkspace(registry, donorRoot, "donor");
  const donorDatabase = await openEngineWorkspace(storage, donorWorkspace);
  const prepared = await prepareRegistry(donorWorkspace.workspace_id);
  const donorPlugin = providerFor(prepared, donorWorkspace.workspace_id, providerOptions);
  const donorResult = await runFullWorkspaceScan({ root: donorRoot, database: asStorageDatabase(donorDatabase), workspace_id: donorWorkspace.workspace_id, plugin: donorPlugin, inclusion_rules: INDEX_PACK_INCLUSION_RULES });
  expect(donorResult.status).toBe("published");
  registry.markReady(donorWorkspace.workspace_id, donorResult.snapshot_id, "ready");

  const packPath = join(dataRoot, "donor.index-pack.gz");
  await exportIndexPack({ database: asStorageDatabase(donorDatabase), workspace_id: donorWorkspace.workspace_id, out_path: packPath, now: () => now });
  return { dataRoot, donorRoot, storage, registry, donorWorkspace, donorDatabase, donorPlugin, packPath };
}

async function teardown(fixture: Fixture): Promise<void> {
  await fixture.donorDatabase.close().catch(() => undefined);
  await fixture.storage.close();
  await rm(fixture.dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(fixture.donorRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

describe("Index pack (docs/decisions/23-index-pack.md)", () => {
  it("(a) round-trips a ready workspace's index into a second, unrelated data root with byte-identical content", async () => {
    const fixture = await buildReadyDonorAndExport("roundtrip");
    const targetRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-roundtrip-target-"));
    let targetStorage: DurableStorage | undefined;
    let targetDatabase: WorkspaceDatabase | undefined;
    try {
      await seedFixtureFiles(targetRoot);
      // A separate data root entirely, simulating a fresh machine with no
      // local donor -- `fixture.dataRoot` (the donor's own data root) is
      // never referenced here.
      const targetDataRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-roundtrip-target-data-"));
      targetStorage = await createDurableStorage({ rootDir: targetDataRoot });
      const targetRegistry = new WorkspaceRegistry();
      const targetWorkspace = await registerEngineWorkspace(targetRegistry, targetRoot, "target");
      targetDatabase = await openEngineWorkspace(targetStorage, targetWorkspace);
      const preparedTarget = await prepareRegistry(targetWorkspace.workspace_id);
      const targetPlugin = providerFor(preparedTarget, targetWorkspace.workspace_id);

      const outcome = await attemptIndexPackImport({
        workspace: targetWorkspace,
        database: asStorageDatabase(targetDatabase),
        storage: asDurableStorage(targetStorage),
        registry: targetRegistry,
        plugin: targetPlugin,
        pack_path: fixture.packPath,
        inclusion_rules: INDEX_PACK_INCLUSION_RULES,
        verify_mode: "full",
      });
      expect(outcome.status).toBe("imported");
      if (outcome.status !== "imported") return;
      expect(outcome.generation).toBe(1);
      targetRegistry.markReady(targetWorkspace.workspace_id, outcome.snapshot_id, "ready");

      const donorCurrent = await fixture.donorDatabase.repositories.snapshots.getCurrent();
      const donorSnapshot = await fixture.donorDatabase.repositories.snapshots.get(donorCurrent!.current_snapshot_id);
      const importedSnapshot = await targetDatabase.repositories.snapshots.get(outcome.snapshot_id);
      expect(importedSnapshot?.canonical_record_set_digest).toBe(donorSnapshot?.canonical_record_set_digest);

      const donorRecordIds = (await fixture.donorDatabase.database.all<{ record_id: string }>("SELECT record_id FROM record_occurrences WHERE workspace_id = ? AND valid_to_generation IS NULL ORDER BY record_id", [fixture.donorWorkspace.workspace_id])).map((row) => row.record_id);
      const importedRecordIds = (await targetDatabase.database.all<{ record_id: string }>("SELECT record_id FROM record_occurrences WHERE workspace_id = ? AND valid_to_generation IS NULL ORDER BY record_id", [targetWorkspace.workspace_id])).map((row) => row.record_id);
      expect(importedRecordIds).toEqual(donorRecordIds);
      expect(importedRecordIds.length).toBeGreaterThan(0);
    } finally {
      if (targetDatabase) await targetDatabase.close().catch(() => undefined);
      if (targetStorage) await targetStorage.close();
      await rm(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await teardown(fixture);
    }
  }, 120_000);

  it("(a2) capability-state digest is order-independent: a donor emitting entries in non-canonical order still imports AND forks under the default fast verify", async () => {
    // Regression for the 2026-08-24 live VS Code import failure
    // ("capability-state digest differs from the pack's declared donor
    // anchor"): the donor digested its entries in plugin emission order while
    // every read-back (`visibleCapabilityStateEntries`) yields ORDER BY
    // state_key (per-entry hash) order. The digest contract is
    // `ordered_set(SnapshotCapabilityStateEntry, core:capability_state_order@1)`
    // (docs/serialization/core-digest-field-contracts.md), so the digest must
    // not depend on either order. A single-entry fixture can never catch
    // this; this donor emits three entries deliberately arranged in
    // reverse-canonical order.
    const CAPABILITY_STATE_ORDER = { comparator_id: "core:capability_state_order", comparator_version: 1, sort_keys: [{ value_path: "", comparison_mode: "uce_bytes", direction: "ascending", absent_order: "forbidden" }] } as const;
    const fixture = await buildReadyDonorAndExport("capability-order", {
      capability_state_entries: (base) => {
        const entries = [base[0]!, { ...base[0]!, capability: "core:type_information" }, { ...base[0]!, capability: "core:syntax_structure" }];
        const emitted = [...sortCanonicalValues(entries, CAPABILITY_STATE_ORDER)].reverse();
        expect(emitted).not.toEqual(sortCanonicalValues(entries, CAPABILITY_STATE_ORDER));
        return emitted;
      },
    });
    const targetRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-capability-order-target-"));
    const forkRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-capability-order-fork-"));
    let targetStorage: DurableStorage | undefined;
    let targetDatabase: WorkspaceDatabase | undefined;
    let forkDatabase: WorkspaceDatabase | undefined;
    try {
      // The manifest's declared anchor must follow the documented ordered_set
      // recipe over the pack's own rows -- pinning the recipe itself, not
      // just import/donor self-consistency (both sides sharing the same
      // wrong recipe would pass a pure round-trip).
      const lines = readRawPackLines(await readFile(fixture.packPath));
      const manifest = (lines[0] as { manifest: { donor_snapshot_anchor: { capability_state_digest: string } } }).manifest;
      const packEntries = lines.filter((line): line is { kind: string; rows: unknown[] } => (line as { kind?: string }).kind === "capability_state").flatMap((line) => line.rows);
      expect(packEntries).toHaveLength(3);
      expect(manifest.donor_snapshot_anchor.capability_state_digest).toBe(digestBytes(canonicalBytes(sortCanonicalValues(packEntries, CAPABILITY_STATE_ORDER))));

      // Import into an unrelated data root with the DEFAULT verify mode --
      // "fast" is the mode that runs `fastPackVerify`'s anchor cross-check,
      // which is where the live failure surfaced (test (a) uses "full").
      await seedFixtureFiles(targetRoot);
      const targetDataRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-capability-order-target-data-"));
      targetStorage = await createDurableStorage({ rootDir: targetDataRoot });
      const targetRegistry = new WorkspaceRegistry();
      const targetWorkspace = await registerEngineWorkspace(targetRegistry, targetRoot, "target");
      targetDatabase = await openEngineWorkspace(targetStorage, targetWorkspace);
      const preparedTarget = await prepareRegistry(targetWorkspace.workspace_id);
      const importOutcome = await attemptIndexPackImport({
        workspace: targetWorkspace,
        database: asStorageDatabase(targetDatabase),
        storage: asDurableStorage(targetStorage),
        registry: targetRegistry,
        plugin: providerFor(preparedTarget, targetWorkspace.workspace_id),
        pack_path: fixture.packPath,
        inclusion_rules: INDEX_PACK_INCLUSION_RULES,
      });
      expect(importOutcome.status).toBe("imported");

      // Twin latent bug: `fastForkVerify` compares the same digests, so a
      // local fork from this donor must also survive its default fast verify.
      await seedFixtureFiles(forkRoot);
      const forkWorkspace = await registerEngineWorkspace(fixture.registry, forkRoot, "fork-target");
      forkDatabase = await openEngineWorkspace(fixture.storage, forkWorkspace);
      const preparedFork = await prepareRegistry(forkWorkspace.workspace_id);
      const forkOutcome = await attemptWorkspaceFork({
        workspace: forkWorkspace,
        database: asStorageDatabase(forkDatabase),
        storage: asDurableStorage(fixture.storage),
        registry: fixture.registry,
        plugin: providerFor(preparedFork, forkWorkspace.workspace_id),
      });
      expect(forkOutcome.status).toBe("forked");
    } finally {
      if (forkDatabase) await forkDatabase.close().catch(() => undefined);
      if (targetDatabase) await targetDatabase.close().catch(() => undefined);
      if (targetStorage) await targetStorage.close();
      await rm(forkRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await teardown(fixture);
    }
  }, 120_000);

  it("(b) a mutated body_payload byte is rejected and rolled back, leaving the workspace scannable by a normal fallback full scan", async () => {
    const fixture = await buildReadyDonorAndExport("tamper-body");
    const targetRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-tamper-body-target-"));
    let targetStorage: DurableStorage | undefined;
    let targetDatabase: WorkspaceDatabase | undefined;
    try {
      await seedFixtureFiles(targetRoot);
      const rawBytes = await readFile(fixture.packPath);
      const lines = readRawPackLines(rawBytes);
      const recordsLineIndex = lines.findIndex((line) => (line as { kind?: string }).kind === "records");
      expect(recordsLineIndex).toBeGreaterThanOrEqual(0);
      const recordsLine = lines[recordsLineIndex] as { rows: { body_payload_hex?: string }[] };
      const target = recordsLine.rows.find((row) => typeof row.body_payload_hex === "string" && row.body_payload_hex.length > 4);
      expect(target).toBeDefined();
      const original = Buffer.from(target!.body_payload_hex!, "hex");
      const mutated = Buffer.from(original);
      mutated[0] = (mutated[0]! + 1) % 256;
      target!.body_payload_hex = mutated.toString("hex");
      const tamperedPath = join(fixture.dataRoot, "tampered-body.index-pack.gz");
      await writeFile(tamperedPath, writeRawPackLines(lines));

      const targetDataRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-tamper-body-target-data-"));
      targetStorage = await createDurableStorage({ rootDir: targetDataRoot });
      const targetRegistry = new WorkspaceRegistry();
      const targetWorkspace = await registerEngineWorkspace(targetRegistry, targetRoot, "target");
      targetDatabase = await openEngineWorkspace(targetStorage, targetWorkspace);
      const preparedTarget = await prepareRegistry(targetWorkspace.workspace_id);
      const targetPlugin = providerFor(preparedTarget, targetWorkspace.workspace_id);

      const outcome = await attemptIndexPackImport({ workspace: targetWorkspace, database: asStorageDatabase(targetDatabase), storage: asDurableStorage(targetStorage), registry: targetRegistry, plugin: targetPlugin, pack_path: tamperedPath, inclusion_rules: INDEX_PACK_INCLUSION_RULES });
      expect(outcome.status).toBe("skipped");

      // Rollback must have left the workspace scannable, not wedged (mirrors
      // workspace-fork's own bug-2 regression test).
      const fallback = await runFullWorkspaceScan({ root: targetRoot, database: asStorageDatabase(targetDatabase), workspace_id: targetWorkspace.workspace_id, plugin: targetPlugin, inclusion_rules: INDEX_PACK_INCLUSION_RULES });
      expect(fallback.status).toBe("published");
      expect(() => targetRegistry.markReady(targetWorkspace.workspace_id, fallback.snapshot_id, "ready")).not.toThrow();
    } finally {
      if (targetDatabase) await targetDatabase.close().catch(() => undefined);
      if (targetStorage) await targetStorage.close();
      await rm(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await teardown(fixture);
    }
  }, 120_000);

  it("(c) a forged record_id is rejected and rolled back", async () => {
    const fixture = await buildReadyDonorAndExport("tamper-id");
    const targetRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-tamper-id-target-"));
    let targetStorage: DurableStorage | undefined;
    let targetDatabase: WorkspaceDatabase | undefined;
    try {
      await seedFixtureFiles(targetRoot);
      const lines = readRawPackLines(await readFile(fixture.packPath));
      const recordsLineIndex = lines.findIndex((line) => (line as { kind?: string }).kind === "records");
      const recordsLine = lines[recordsLineIndex] as { rows: { record_id: string }[] };
      recordsLine.rows[0]!.record_id = "record:0000000000000000000000000000000000000000000000000000000000000000";
      const tamperedPath = join(fixture.dataRoot, "tampered-id.index-pack.gz");
      await writeFile(tamperedPath, writeRawPackLines(lines));

      const targetDataRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-tamper-id-target-data-"));
      targetStorage = await createDurableStorage({ rootDir: targetDataRoot });
      const targetRegistry = new WorkspaceRegistry();
      const targetWorkspace = await registerEngineWorkspace(targetRegistry, targetRoot, "target");
      targetDatabase = await openEngineWorkspace(targetStorage, targetWorkspace);
      const preparedTarget = await prepareRegistry(targetWorkspace.workspace_id);
      const targetPlugin = providerFor(preparedTarget, targetWorkspace.workspace_id);

      const outcome = await attemptIndexPackImport({ workspace: targetWorkspace, database: asStorageDatabase(targetDatabase), storage: asDurableStorage(targetStorage), registry: targetRegistry, plugin: targetPlugin, pack_path: tamperedPath, inclusion_rules: INDEX_PACK_INCLUSION_RULES });
      expect(outcome.status).toBe("skipped");

      const fallback = await runFullWorkspaceScan({ root: targetRoot, database: asStorageDatabase(targetDatabase), workspace_id: targetWorkspace.workspace_id, plugin: targetPlugin, inclusion_rules: INDEX_PACK_INCLUSION_RULES });
      expect(fallback.status).toBe("published");
    } finally {
      if (targetDatabase) await targetDatabase.close().catch(() => undefined);
      if (targetStorage) await targetStorage.close();
      await rm(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await teardown(fixture);
    }
  }, 120_000);

  it("(d) removing one multiset entry is skipped with a bounded diff naming the uri, and a mismatched-content-hash entry is also caught", async () => {
    const fixture = await buildReadyDonorAndExport("tamper-multiset");
    const targetRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-tamper-multiset-target-"));
    let targetStorage: DurableStorage | undefined;
    let targetDatabase: WorkspaceDatabase | undefined;
    try {
      await seedFixtureFiles(targetRoot);
      const lines = readRawPackLines(await readFile(fixture.packPath)) as Record<string, unknown>[];
      const manifestLineIndex = lines.findIndex((line) => line["kind"] === "manifest");
      const multisetLineIndex = lines.findIndex((line) => line["kind"] === "multiset");
      const manifestLine = lines[manifestLineIndex] as { manifest: Record<string, unknown> };
      const multisetLine = lines[multisetLineIndex] as { rows: (readonly [string, string])[] };
      expect(multisetLine.rows.length).toBeGreaterThan(1);
      const removed = multisetLine.rows.pop()!;
      const manifest = manifestLine.manifest;
      const rowCounts = manifest["row_counts"] as Record<string, number>;
      const newManifest = { ...manifest, row_counts: { ...rowCounts, multiset: multisetLine.rows.length }, multiset_digest: digestBytes(new TextEncoder().encode(JSON.stringify([...multisetLine.rows].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))))) };
      const finalManifest = { ...newManifest, manifest_digest: manifestDigestOf(newManifest) };
      manifestLine.manifest = finalManifest;
      const tamperedPath = join(fixture.dataRoot, "tampered-multiset.index-pack.gz");
      await writeFile(tamperedPath, writeRawPackLines(lines));

      const targetDataRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-tamper-multiset-target-data-"));
      targetStorage = await createDurableStorage({ rootDir: targetDataRoot });
      const targetRegistry = new WorkspaceRegistry();
      const targetWorkspace = await registerEngineWorkspace(targetRegistry, targetRoot, "target");
      targetDatabase = await openEngineWorkspace(targetStorage, targetWorkspace);
      const preparedTarget = await prepareRegistry(targetWorkspace.workspace_id);
      const targetPlugin = providerFor(preparedTarget, targetWorkspace.workspace_id);

      const outcome = await attemptIndexPackImport({ workspace: targetWorkspace, database: asStorageDatabase(targetDatabase), storage: asDurableStorage(targetStorage), registry: targetRegistry, plugin: targetPlugin, pack_path: tamperedPath, inclusion_rules: INDEX_PACK_INCLUSION_RULES });
      expect(outcome.status).toBe("skipped");
      if (outcome.status === "skipped") expect(outcome.reason).toContain(removed[0]);
    } finally {
      if (targetDatabase) await targetDatabase.close().catch(() => undefined);
      if (targetStorage) await targetStorage.close();
      await rm(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await teardown(fixture);
    }
  }, 120_000);

  it("(e) an incompatible plugin_version axis is skipped before any durable write, and the workspace remains scannable", async () => {
    const fixture = await buildReadyDonorAndExport("tamper-plugin");
    const targetRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-tamper-plugin-target-"));
    let targetStorage: DurableStorage | undefined;
    let targetDatabase: WorkspaceDatabase | undefined;
    try {
      await seedFixtureFiles(targetRoot);
      const lines = readRawPackLines(await readFile(fixture.packPath)) as Record<string, unknown>[];
      const manifestLineIndex = lines.findIndex((line) => line["kind"] === "manifest");
      const manifestLine = lines[manifestLineIndex] as { manifest: Record<string, unknown> };
      const manifest = manifestLine.manifest;
      const compatibility = manifest["compatibility"] as Record<string, unknown>;
      const newManifest = { ...manifest, compatibility: { ...compatibility, resolved_plugins_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" } };
      manifestLine.manifest = { ...newManifest, manifest_digest: manifestDigestOf(newManifest) };
      const tamperedPath = join(fixture.dataRoot, "tampered-plugin.index-pack.gz");
      await writeFile(tamperedPath, writeRawPackLines(lines));

      const targetDataRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-tamper-plugin-target-data-"));
      targetStorage = await createDurableStorage({ rootDir: targetDataRoot });
      const targetRegistry = new WorkspaceRegistry();
      const targetWorkspace = await registerEngineWorkspace(targetRegistry, targetRoot, "target");
      targetDatabase = await openEngineWorkspace(targetStorage, targetWorkspace);
      const preparedTarget = await prepareRegistry(targetWorkspace.workspace_id);
      const targetPlugin = providerFor(preparedTarget, targetWorkspace.workspace_id);

      const outcome = await attemptIndexPackImport({ workspace: targetWorkspace, database: asStorageDatabase(targetDatabase), storage: asDurableStorage(targetStorage), registry: targetRegistry, plugin: targetPlugin, pack_path: tamperedPath, inclusion_rules: INDEX_PACK_INCLUSION_RULES });
      expect(outcome.status).toBe("skipped");
      if (outcome.status === "skipped") expect(outcome.reason).toContain("plugin_version");

      // No durable write happened (the gate fires before `commitForkSourceLayer`), so a normal scan proceeds without any prior rollback needed.
      const fallback = await runFullWorkspaceScan({ root: targetRoot, database: asStorageDatabase(targetDatabase), workspace_id: targetWorkspace.workspace_id, plugin: targetPlugin, inclusion_rules: INDEX_PACK_INCLUSION_RULES });
      expect(fallback.status).toBe("published");
    } finally {
      if (targetDatabase) await targetDatabase.close().catch(() => undefined);
      if (targetStorage) await targetStorage.close();
      await rm(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await teardown(fixture);
    }
  }, 120_000);

  it("(f) content mismatch between the pack and the newly added root falls back to a normal full scan", async () => {
    const fixture = await buildReadyDonorAndExport("mismatch");
    const targetRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-mismatch-target-"));
    let targetStorage: DurableStorage | undefined;
    let targetDatabase: WorkspaceDatabase | undefined;
    try {
      await seedFixtureFiles(targetRoot);
      await writeFile(join(targetRoot, "extra.ts"), "export const extra = 1;\n", "utf8");

      const targetDataRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-mismatch-target-data-"));
      targetStorage = await createDurableStorage({ rootDir: targetDataRoot });
      const targetRegistry = new WorkspaceRegistry();
      const targetWorkspace = await registerEngineWorkspace(targetRegistry, targetRoot, "target");
      targetDatabase = await openEngineWorkspace(targetStorage, targetWorkspace);
      const preparedTarget = await prepareRegistry(targetWorkspace.workspace_id);
      const targetPlugin = providerFor(preparedTarget, targetWorkspace.workspace_id);

      const outcome = await attemptIndexPackImport({ workspace: targetWorkspace, database: asStorageDatabase(targetDatabase), storage: asDurableStorage(targetStorage), registry: targetRegistry, plugin: targetPlugin, pack_path: fixture.packPath, inclusion_rules: INDEX_PACK_INCLUSION_RULES });
      expect(outcome.status).toBe("skipped");
      if (outcome.status === "skipped") expect(outcome.reason).toContain("extra.ts");

      const fallback = await runFullWorkspaceScan({ root: targetRoot, database: asStorageDatabase(targetDatabase), workspace_id: targetWorkspace.workspace_id, plugin: targetPlugin, inclusion_rules: INDEX_PACK_INCLUSION_RULES });
      expect(fallback.status).toBe("published");
      expect(() => targetRegistry.markReady(targetWorkspace.workspace_id, fallback.snapshot_id, "ready")).not.toThrow();
    } finally {
      if (targetDatabase) await targetDatabase.close().catch(() => undefined);
      if (targetStorage) await targetStorage.close();
      await rm(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await teardown(fixture);
    }
  }, 120_000);

  it("(g) export and import stay near-linear at scale -- a quadratic (OFFSET-pagination) regression cannot slip back in silently", async () => {
    // exportIndexPack originally paginated its non-record_occurrences
    // export tables (record_value_nodes/record_facets/identity_assignments/
    // artifact_dependencies/projection_occurrences) with SQL `LIMIT ...
    // OFFSET`, which SQLite implements by re-stepping (and discarding)
    // every already-returned row on each page -- O(n^2) work in the
    // table's row count. At real-VS-Code-workspace scale (tens of
    // thousands of files) this made a single export run past a 20-minute
    // client deadline. identity_assignments is the table that actually
    // reaches that scale in production (one row per record_occurrences
    // row); this test pads it directly via a single bulk `INSERT ...
    // SELECT` over a recursive CTE (fast, no per-row JS round trip) rather
    // than generating a million real files through the analysis pipeline,
    // isolating the export/import path's own pagination behavior from
    // unrelated analysis cost. Manually timing the pre-fix OFFSET code on
    // this exact fixture: export took 87.8s for 1,000,000 padded
    // identity_assignments rows (vs 4.1s below) -- a ~21x regression this
    // test's bound would have caught.
    const N_SYNTHETIC_IDENTITIES = 1_000_000;
    const PERF_BOUND_MS = 30_000;

    const fixture = await buildReadyDonorAndExport("perf-scale");
    const targetRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-perf-scale-target-"));
    let targetStorage: DurableStorage | undefined;
    let targetDatabase: WorkspaceDatabase | undefined;
    try {
      // Every synthetic row's record_id reuses ONE already-real, already-
      // published record_id from this donor (rather than a fabricated one)
      // so `bulkCopyRecordsAndIdentities`'s donor-side `JOIN
      // fork_donor_db.record_occurrences` (workspace-fork.ts) actually lets
      // these rows through on import -- a fabricated record_id would just
      // get silently filtered out by that join, defeating the point of
      // padding at import-scale too. Reusing one id for a million distinct
      // identity_assignment_id/identity_id rows is schema-legal:
      // identity_assignments' only uniqueness constraint is its
      // (workspace_id, identity_assignment_id, valid_from_generation)
      // PRIMARY KEY, not one scoped to record_id. Leaving `record_occurrences`
      // itself untouched also keeps `canonical_record_set_digest` (over the
      // multiset of records) unchanged, so this padding doesn't have to
      // fight the pack's own tamper-detection digests.
      const anchorRecord = await fixture.donorDatabase.database.get<{ record_id: string }>(
        "SELECT record_id FROM record_occurrences WHERE workspace_id = ? AND valid_to_generation IS NULL LIMIT 1",
        [fixture.donorWorkspace.workspace_id],
      );
      expect(anchorRecord?.record_id).toBeDefined();
      await fixture.donorDatabase.database.run(
        `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
         INSERT INTO identity_assignments (identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, valid_from_generation, valid_to_generation)
         SELECT 'synthetic-identity:' || n, ?, 'core:synthetic', 'synthetic:' || n, 'created', 'key:' || n, 'digest:' || n, ?, 1, NULL FROM seq`,
        [N_SYNTHETIC_IDENTITIES, fixture.donorWorkspace.workspace_id, anchorRecord!.record_id],
      );
      const paddedCount = await fixture.donorDatabase.database.get<{ c: number }>("SELECT COUNT(*) AS c FROM identity_assignments WHERE workspace_id = ?", [fixture.donorWorkspace.workspace_id]);
      expect(paddedCount?.c ?? 0).toBeGreaterThanOrEqual(N_SYNTHETIC_IDENTITIES);

      // Re-export: the manifest declares fresh COUNT(*)-derived row counts
      // (see exportIndexPack's comment on `declaredRowCounts`), so the
      // padded identity_assignments rows are picked up automatically --
      // no fixture-specific manifest surgery needed.
      const scalePackPath = join(fixture.dataRoot, "perf-scale.index-pack.gz");
      const exportStart = Date.now();
      await exportIndexPack({ database: asStorageDatabase(fixture.donorDatabase), workspace_id: fixture.donorWorkspace.workspace_id, out_path: scalePackPath, now: () => now });
      const exportMs = Date.now() - exportStart;
      // eslint-disable-next-line no-console -- deliberate perf-gate signal, matches this repo's other timing assertions
      console.log(`[index-pack perf gate] export of ${paddedCount?.c ?? 0} identity_assignments rows took ${exportMs}ms`);
      expect(exportMs).toBeLessThan(PERF_BOUND_MS);

      await seedFixtureFiles(targetRoot);
      const targetDataRoot = await mkdtemp(join(tmpdir(), "urdira-index-pack-perf-scale-target-data-"));
      targetStorage = await createDurableStorage({ rootDir: targetDataRoot });
      const targetRegistry = new WorkspaceRegistry();
      const targetWorkspace = await registerEngineWorkspace(targetRegistry, targetRoot, "target");
      targetDatabase = await openEngineWorkspace(targetStorage, targetWorkspace);
      const preparedTarget = await prepareRegistry(targetWorkspace.workspace_id);
      const targetPlugin = providerFor(preparedTarget, targetWorkspace.workspace_id);

      const importStart = Date.now();
      const outcome = await attemptIndexPackImport({
        workspace: targetWorkspace,
        database: asStorageDatabase(targetDatabase),
        storage: asDurableStorage(targetStorage),
        registry: targetRegistry,
        plugin: targetPlugin,
        pack_path: scalePackPath,
        inclusion_rules: INDEX_PACK_INCLUSION_RULES,
        verify_mode: "fast",
      });
      const importMs = Date.now() - importStart;
      // eslint-disable-next-line no-console -- deliberate perf-gate signal, matches this repo's other timing assertions
      console.log(`[index-pack perf gate] import of the same pack took ${importMs}ms`);
      expect(outcome.status).toBe("imported");
      expect(importMs).toBeLessThan(PERF_BOUND_MS);

      const importedCount = outcome.status === "imported"
        ? (await targetDatabase.database.get<{ c: number }>("SELECT COUNT(*) AS c FROM identity_assignments WHERE workspace_id = ? AND valid_from_generation = ? AND valid_to_generation IS NULL", [targetWorkspace.workspace_id, outcome.generation]))?.c ?? 0
        : 0;
      expect(importedCount).toBeGreaterThanOrEqual(N_SYNTHETIC_IDENTITIES);
    } finally {
      if (targetDatabase) await targetDatabase.close().catch(() => undefined);
      if (targetStorage) await targetStorage.close();
      await rm(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await teardown(fixture);
    }
  }, 180_000);
});
