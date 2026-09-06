import { access, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceSourceProviderBinding } from "@urdira/contracts";
import { createDurableStorage } from "../packages/storage/src/index.js";
import { WorkspaceRegistry, type WorkspaceRegistryState } from "../packages/engine/src/index.js";
import { createPersistentWorkspaceRegistry, DaemonClient, DaemonRuntime, type DaemonRuntimeOptions } from "../packages/daemon/src/index.js";
import { classifyWorkspaceDataDirEntryName, sweepWorkspaceDataDir } from "../packages/daemon/src/orphan-sweep.js";

/**
 * P4-h / plan `generic-waddling-hartmanis.md` §6 (Frente H): coverage for
 * `packages/daemon/src/orphan-sweep.ts`'s classification and sweep, plus the
 * two daemon RPCs it feeds (`core:workspace_orphans_list`/
 * `core:workspace_orphans_purge`). Template: `tests/phase-daemon-recreate-outdated.test.ts`
 * (same "seed real files under a real `<data_root>/workspaces`, then start a
 * real `DaemonRuntime` over it" shape).
 */

function asDaemonWorkspaceRegistry(registry: WorkspaceRegistry): NonNullable<DaemonRuntimeOptions["workspace_registry"]> {
  return registry as unknown as NonNullable<DaemonRuntimeOptions["workspace_registry"]>;
}

const NOW = "2026-09-06T00:00:00.000Z";

function providerBinding(bindingId: string): WorkspaceSourceProviderBinding {
  return {
    source_provider_binding_id: bindingId,
    source_provider: "core:directory_source_provider",
    source_provider_version: "1",
    provider_role: "primary",
    binding_identity: `binding-identity:${bindingId}`,
    configuration_digest: `digest:${bindingId}`,
  };
}

describe("classifyWorkspaceDataDirEntryName", () => {
  it("matches the longest footprint suffix first (lexical/semantic before a bare .sqlite-wal)", () => {
    expect(classifyWorkspaceDataDirEntryName("workspace_x.lexical.sqlite-wal")).toEqual({ safeId: "workspace_x", kind: "lexical", category: "footprint" });
    expect(classifyWorkspaceDataDirEntryName("workspace_x.semantic.sqlite-shm")).toEqual({ safeId: "workspace_x", kind: "semantic", category: "footprint" });
    expect(classifyWorkspaceDataDirEntryName("workspace_x.sqlite-wal")).toEqual({ safeId: "workspace_x", kind: "database", category: "footprint" });
    expect(classifyWorkspaceDataDirEntryName("workspace_x.sqlite")).toEqual({ safeId: "workspace_x", kind: "database", category: "footprint" });
    expect(classifyWorkspaceDataDirEntryName("workspace_x.sqlite.urdira-writer.lock")).toEqual({ safeId: "workspace_x", kind: "lock", category: "footprint" });
    expect(classifyWorkspaceDataDirEntryName("workspace_x.structural")).toEqual({ safeId: "workspace_x", kind: "structural", category: "footprint" });
    expect(classifyWorkspaceDataDirEntryName("workspace_x.sidecar")).toEqual({ safeId: "workspace_x", kind: "sidecar", category: "footprint" });
  });

  it("recognizes .v3.stale-* as retained_stale and .fork-staging-*/.import-staging-* as staging, both keyed by the original safe id", () => {
    expect(classifyWorkspaceDataDirEntryName("workspace_x.v3.stale-2026-09-02T12-00-00-000Z")).toEqual({ safeId: "workspace_x", kind: "unknown", category: "stale" });
    expect(classifyWorkspaceDataDirEntryName("workspace_x.structural.fork-staging-abc123")).toEqual({ safeId: "workspace_x", kind: "structural", category: "staging" });
    // v4 (plan §7.1, P-1, a later wave): index-pack import's staging root
    // (`<db>.import-staging-<uuid>` where `<db>` is `<safeId>.sqlite`) isn't
    // produced by any shipped code path yet, but classified here ahead of
    // time so it gets the same one-hour `in_progress` grace as fork-staging
    // instead of falling through to the generic "unrecognized suffix"
    // branch (which would flag it as an immediate orphan candidate).
    expect(classifyWorkspaceDataDirEntryName("workspace_x.sqlite.import-staging-def456")).toEqual({ safeId: "workspace_x", kind: "database", category: "staging" });
  });

  it("falls back to the whole name for anything with no recognized suffix", () => {
    expect(classifyWorkspaceDataDirEntryName("totally-unexpected-file.txt")).toEqual({ safeId: "totally-unexpected-file.txt", kind: "unknown", category: "footprint" });
  });
});

describe("sweepWorkspaceDataDir", () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("classifies (a) a known workspace's own files, (b) leftover-purge orphans, (c) retained stale, (d) fresh and stale fork-staging, and (e) a known in-grace tombstone", async () => {
    root = await mkdtemp(join(tmpdir(), "urdira-orphan-sweep-"));
    const workspacesDir = join(root, "workspaces");
    await mkdir(workspacesDir, { recursive: true });

    // (a) a currently registered workspace's own, expected file.
    await writeFile(join(workspacesDir, "workspace_live.sqlite"), "db");

    // (b) leftovers from a purge that (before this frente's fix) deleted
    // only the catalog-database files -- no registration for this id at
    // all any more.
    await writeFile(join(workspacesDir, "workspace_leftover.lexical.sqlite"), "lex");
    await mkdir(join(workspacesDir, "workspace_leftover.structural"), { recursive: true });
    await writeFile(join(workspacesDir, "workspace_leftover.structural", "MANIFEST"), "{}");

    // (c) a recreate-outdated move-aside directory -- retained, never purged.
    await mkdir(join(workspacesDir, "workspace_stale.v3.stale-2026-01-01T00-00-00-000Z"), { recursive: true });
    await writeFile(join(workspacesDir, "workspace_stale.v3.stale-2026-01-01T00-00-00-000Z", "workspace_stale.sqlite"), "old");

    // (d) fork staging: one fresh (in progress), one old (graduates to orphan).
    await mkdir(join(workspacesDir, "workspace_forking.structural.fork-staging-fresh-uuid"), { recursive: true });
    await mkdir(join(workspacesDir, "workspace_forked_ago.structural.fork-staging-old-uuid"), { recursive: true });
    const twoHoursAgo = new Date(Date.parse(NOW) - 2 * 60 * 60 * 1000);
    await utimes(join(workspacesDir, "workspace_forked_ago.structural.fork-staging-old-uuid"), twoHoursAgo, twoHoursAgo);

    // (e) a tombstoned-but-in-grace workspace's leftover sidecar -- known,
    // so excluded even though a file for it exists here.
    await writeFile(join(workspacesDir, "workspace_tombstoned.semantic.sqlite"), "sem");

    const report = await sweepWorkspaceDataDir({
      workspacesDir,
      knownSafeIds: new Set(["workspace_live", "workspace_tombstoned"]),
      now: () => Date.parse(NOW),
    });

    expect(report.orphans.map((group) => group.safe_id).sort()).toEqual(["workspace_forked_ago", "workspace_leftover"]);
    expect(report.retained_stale.map((group) => group.safe_id)).toEqual(["workspace_stale"]);
    expect(report.in_progress.map((group) => group.safe_id)).toEqual(["workspace_forking"]);

    const leftover = report.orphans.find((group) => group.safe_id === "workspace_leftover")!;
    expect(leftover.entries.map((entry) => entry.kind).sort()).toEqual(["lexical", "structural"]);
    expect(leftover.total_bytes).toBeGreaterThan(0);
  });

  it("returns an empty report for a missing workspaces directory instead of throwing", async () => {
    root = await mkdtemp(join(tmpdir(), "urdira-orphan-sweep-missing-"));
    const report = await sweepWorkspaceDataDir({ workspacesDir: join(root, "does-not-exist"), knownSafeIds: new Set() });
    expect(report).toEqual({ orphans: [], retained_stale: [], in_progress: [] });
  });
});

describe("Daemon orphan RPCs (core:workspace_orphans_list / core:workspace_orphans_purge)", () => {
  let dataRoot: string | undefined;
  let runtime: DaemonRuntime | undefined;

  afterEach(async () => {
    await runtime?.stop().catch(() => undefined);
    runtime = undefined;
    if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
    dataRoot = undefined;
  });

  it("lists real orphans/retained_stale/in_progress, purges only true orphans, leaves known and retained/in-progress entries untouched, and surfaces the count on core:status/core:index_status", async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "urdira-orphan-daemon-"));
    const workspaceIdLive = "workspace:orphan-live";
    const workspaceIdTombstoned = "workspace:orphan-tombstoned";

    const seedStorage = await createDurableStorage({ rootDir: dataRoot });
    try {
      await seedStorage.catalog.registerWorkspace({
        workspace_id: workspaceIdLive,
        canonical_root: "/orphan-test/live",
        display_root: "/orphan-test/live",
        source_provider_bindings: [providerBinding("binding:live")],
        status: "registered",
        registered_at: NOW,
      });
    } finally {
      await seedStorage.close();
    }

    const workspacesDir = join(dataRoot, "workspaces");
    // (b) a true orphan: no registration at all, under either workspace id.
    await writeFile(join(workspacesDir, "workspace_orphan-leftover.lexical.sqlite"), "lex");
    await mkdir(join(workspacesDir, "workspace_orphan-leftover.structural"), { recursive: true });
    // (d) an old fork-staging directory: also a true orphan once stale.
    const oldStaging = join(workspacesDir, "workspace_forked-away.structural.fork-staging-old-uuid");
    await mkdir(oldStaging, { recursive: true });
    await utimes(oldStaging, new Date(Date.now() - 2 * 60 * 60 * 1000), new Date(Date.now() - 2 * 60 * 60 * 1000));
    // (d) a fresh fork-staging directory: in progress, never purged.
    await mkdir(join(workspacesDir, "workspace_forking-now.structural.fork-staging-fresh-uuid"), { recursive: true });
    // (c) a retained stale move-aside directory: never purged.
    await mkdir(join(workspacesDir, "workspace_old-format.v3.stale-2026-01-01T00-00-00-000Z"), { recursive: true });
    // (e) a leftover sidecar for a tombstoned-but-in-grace workspace: known, never an orphan.
    await writeFile(join(workspacesDir, `${workspaceIdTombstoned.replace(/[^A-Za-z0-9._-]/g, "_")}.semantic.sqlite`), "sem");

    const codebaseId = "codebase:orphan-test";
    const state: WorkspaceRegistryState = {
      schema_version: 2,
      workspaces: [
        { workspace_id: workspaceIdLive, codebase_id: codebaseId, project_name: workspaceIdLive, canonical_root: "/orphan-test/live", display_root: "/orphan-test/live", provider: providerBinding("binding:live"), source_state_fingerprint: "fingerprint:live", status: "ready", registered_at: NOW, current_snapshot_id: "snapshot:live" },
        { workspace_id: workspaceIdTombstoned, codebase_id: codebaseId, project_name: workspaceIdTombstoned, canonical_root: "/orphan-test/tombstoned", display_root: "/orphan-test/tombstoned", provider: providerBinding("binding:tombstoned"), source_state_fingerprint: "fingerprint:tombstoned", status: "removed", registered_at: NOW, removed_at: NOW },
      ],
      codebases: [{ codebase_id: codebaseId, display_name: "orphan-test", created_at: NOW }],
    };
    const registry = new WorkspaceRegistry({ persistence: { load: () => state, save: () => undefined } });

    runtime = await DaemonRuntime.start({
      data_root: dataRoot,
      engine_build_id: "build-orphan-sweep-test",
      workspace_registry: asDaemonWorkspaceRegistry(registry),
      resolve_plugin_provider: async () => undefined,
      lexical_index: false,
      semantic_index: false,
      scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
    });
    const client = new DaemonClient(runtime.endpoint, { request_timeout_ms: 30_000 });

    const listed = await client.call("core:workspace_orphans_list", {});
    if (listed.outcome !== "success") throw new Error(`core:workspace_orphans_list failed: ${JSON.stringify(listed)}`);
    const listedPayload = listed.payload as { readonly orphans: ReadonlyArray<{ readonly safe_id: string }>; readonly retained_stale: ReadonlyArray<{ readonly safe_id: string }>; readonly in_progress: ReadonlyArray<{ readonly safe_id: string }> };
    expect(listedPayload.orphans.map((group) => group.safe_id).sort()).toEqual(["workspace_forked-away", "workspace_orphan-leftover"]);
    expect(listedPayload.retained_stale.map((group) => group.safe_id)).toEqual(["workspace_old-format"]);
    expect(listedPayload.in_progress.map((group) => group.safe_id)).toEqual(["workspace_forking-now"]);

    const status = await client.call("core:status", {});
    if (status.outcome !== "success") throw new Error(`core:status failed: ${JSON.stringify(status)}`);
    expect((status.payload as { readonly orphaned_workspace_data?: { readonly count: number } }).orphaned_workspace_data?.count).toBe(2);

    const indexStatus = await client.call("core:index_status", {});
    if (indexStatus.outcome !== "success") throw new Error(`core:index_status failed: ${JSON.stringify(indexStatus)}`);
    expect((indexStatus.payload as { readonly orphaned_workspace_data?: { readonly count: number } }).orphaned_workspace_data?.count).toBe(2);

    // Purge only the two true orphans -- explicitly naming the live
    // workspace's own safe id too, to prove the RPC never deletes a known
    // workspace's files even if a caller asks for it by name.
    const liveSafeId = workspaceIdLive.replace(/[^A-Za-z0-9._-]/g, "_");
    const purged = await client.call("core:workspace_orphans_purge", { args: ["workspace_orphan-leftover", "workspace_forked-away", liveSafeId], values: {} });
    if (purged.outcome !== "success") throw new Error(`core:workspace_orphans_purge failed: ${JSON.stringify(purged)}`);
    const purgedPayload = purged.payload as { readonly purged: ReadonlyArray<string>; readonly bytes_freed: number; readonly remaining: ReadonlyArray<{ readonly safe_id: string }> };
    expect([...purgedPayload.purged].sort()).toEqual(["workspace_forked-away", "workspace_orphan-leftover"]);
    expect(purgedPayload.remaining).toEqual([]);

    // Actually gone from disk.
    await expect(access(join(workspacesDir, "workspace_orphan-leftover.lexical.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(workspacesDir, "workspace_orphan-leftover.structural"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(oldStaging)).rejects.toMatchObject({ code: "ENOENT" });

    // Untouched: the live workspace's own file, the retained-stale
    // directory, the still-fresh fork-staging directory, and the
    // in-grace tombstone's leftover sidecar.
    await expect(access(join(workspacesDir, `${liveSafeId}.sqlite`))).resolves.toBeUndefined();
    await expect(access(join(workspacesDir, "workspace_old-format.v3.stale-2026-01-01T00-00-00-000Z"))).resolves.toBeUndefined();
    await expect(access(join(workspacesDir, "workspace_forking-now.structural.fork-staging-fresh-uuid"))).resolves.toBeUndefined();
    await expect(access(join(workspacesDir, `${workspaceIdTombstoned.replace(/[^A-Za-z0-9._-]/g, "_")}.semantic.sqlite`))).resolves.toBeUndefined();

    const relisted = await client.call("core:workspace_orphans_list", {});
    if (relisted.outcome !== "success") throw new Error(`re-list failed: ${JSON.stringify(relisted)}`);
    const relistedPayload = relisted.payload as { readonly orphans: ReadonlyArray<unknown>; readonly retained_stale: ReadonlyArray<unknown>; readonly in_progress: ReadonlyArray<unknown> };
    expect(relistedPayload.orphans).toEqual([]);
    expect(relistedPayload.retained_stale).toHaveLength(1);
    expect(relistedPayload.in_progress).toHaveLength(1);
  }, 60_000);

  it("rejects core:workspace_orphans_purge with neither --all nor safe_ids, and with both at once (ambiguous intent)", async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "urdira-orphan-daemon-args-"));
    const registry = createPersistentWorkspaceRegistry(dataRoot);
    runtime = await DaemonRuntime.start({
      data_root: dataRoot,
      engine_build_id: "build-orphan-sweep-args-test",
      workspace_registry: registry,
      resolve_plugin_provider: async () => undefined,
      lexical_index: false,
      semantic_index: false,
      scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
    });
    const client = new DaemonClient(runtime.endpoint, { request_timeout_ms: 30_000 });

    const neither = await client.call("core:workspace_orphans_purge", { args: [], values: {} });
    expect(neither.outcome).toBe("error");
    expect(neither.error?.code).toBe("core:ipc_request_invalid");

    const both = await client.call("core:workspace_orphans_purge", { args: ["workspace_a"], values: { all: "true" } });
    expect(both.outcome).toBe("error");
    expect(both.error?.code).toBe("core:ipc_request_invalid");
  }, 30_000);

  it("survives an already-empty workspaces directory at startup (no workspace ever added yet)", async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "urdira-orphan-daemon-empty-"));
    const registry = createPersistentWorkspaceRegistry(dataRoot);
    runtime = await DaemonRuntime.start({
      data_root: dataRoot,
      engine_build_id: "build-orphan-sweep-empty-test",
      workspace_registry: registry,
      resolve_plugin_provider: async () => undefined,
      lexical_index: false,
      semantic_index: false,
      scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
    });
    const client = new DaemonClient(runtime.endpoint, { request_timeout_ms: 30_000 });
    const listed = await client.call("core:workspace_orphans_list", {});
    if (listed.outcome !== "success") throw new Error(`core:workspace_orphans_list failed: ${JSON.stringify(listed)}`);
    expect(listed.payload).toEqual({ orphans: [], retained_stale: [], in_progress: [] });
  }, 30_000);
});
