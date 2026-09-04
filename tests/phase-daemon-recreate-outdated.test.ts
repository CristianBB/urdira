import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeCanonical } from "@urdira/canonical";
import type { WorkspaceSourceProviderBinding } from "@urdira/contracts";
import { createDurableStorage, openSqliteDatabase } from "../packages/storage/src/index.js";
import { ensureV4Workspace, WorkspaceRegistry, type RegisteredWorkspace, type WorkspaceRegistryState } from "../packages/engine/src/index.js";
import { createPersistentWorkspaceRegistry, DaemonClient, DaemonRuntime, type DaemonRuntimeOptions } from "../packages/daemon/src/index.js";

/**
 * P4-a: end-to-end gate for `packages/storage/src/recreate-outdated.ts`'s
 * wiring into `packages/daemon/src/runtime.ts`'s `scheduleWorkspaceScan`
 * catch block. Reuses `tests/phase-daemon-indexing-integration.test.ts`'s
 * `asDaemonWorkspaceRegistry` cast (the same `@urdira/engine` `dist`-vs-`src`
 * private-field-branding situation documented there) and
 * `tests/recreate-outdated.test.ts`'s direct-file assertions (stale
 * directory naming, "never deletes").
 *
 * Deliberately does NOT pre-register any of the three workspaces in the
 * daemon's OWN durable catalog before startup: `DurableStorage.open`'s
 * unconditional startup recovery (`recoverMigrations`/`recoverWorkspaceGcEpochs`,
 * `packages/storage/src/storage.ts`) applies the v3 schema-compatibility
 * check to EVERY already-catalogued workspace regardless of its actual
 * format (it does not consult `readIndexContractByte` the way
 * `openWorkspace`/`registerWorkspaceSerialized` do), so a v4 -- or already
 * outdated -- workspace already in the catalog at construction time would
 * reject `createDurableStorage` entirely before the daemon ever starts
 * (a real, pre-existing gap this task's brief does not ask to close: it
 * scopes the wiring to `scheduleWorkspaceScan`'s own `openWorkspace`/
 * `registerWorkspace` call sites). Instead, each workspace's `.sqlite` file
 * is stamped directly on disk at its default path (the same one
 * `DurableStorage.defaultWorkspacePath` computes, deterministic in
 * `(rootDir, workspaceId)` alone) and registered ONLY in the in-memory
 * `WorkspaceRegistry` (the daemon's own `workspaces.json`-equivalent) at
 * status `"indexing"` -- mirroring exactly the "crash recovery" scenario
 * `runtime.ts`'s own top-of-`start()` comment describes ("a workspace left
 * `indexing` by a prior process life... retried once storage and the scan
 * scheduler are ready"), which is the actual "at startup" trigger for
 * `scheduleWorkspaceScan`.
 */

function asDaemonWorkspaceRegistry(registry: WorkspaceRegistry): NonNullable<DaemonRuntimeOptions["workspace_registry"]> {
  return registry as unknown as NonNullable<DaemonRuntimeOptions["workspace_registry"]>;
}

// `ensureV4Workspace` (`../packages/engine/src/index.js`) types its `storage`
// parameter against `@urdira/storage`'s published (dist) `DurableStorage`
// declaration -- its real workspace dependency -- which is nominally
// distinct from this file's `src` import of the same class within
// `tsconfig.tests.json`'s combined program, per the identical
// dist-vs-src-identity situation `tests/phase-workspace-indexing-session.test.ts`
// documents for `WorkspaceDatabase`. Per-package builds never hit this.
function asEngineDurableStorage(storage: Awaited<ReturnType<typeof createDurableStorage>>): Parameters<typeof ensureV4Workspace>[0]["storage"] {
  return storage as unknown as Parameters<typeof ensureV4Workspace>[0]["storage"];
}

const NOW = "2026-09-03T00:00:00.000Z";

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

function catalogRegistration(workspaceId: string, canonicalRoot: string, bindingId: string) {
  return {
    workspace_id: workspaceId,
    canonical_root: canonicalRoot,
    display_root: canonicalRoot,
    source_provider_bindings: [providerBinding(bindingId)],
    status: "registered",
    registered_at: NOW,
  };
}

function registryWorkspace(workspaceId: string, canonicalRoot: string, bindingId: string, status: "indexing" | "ready", codebaseId: string): RegisteredWorkspace {
  return {
    workspace_id: workspaceId,
    codebase_id: codebaseId,
    project_name: workspaceId,
    canonical_root: canonicalRoot,
    display_root: canonicalRoot,
    provider: providerBinding(bindingId),
    source_state_fingerprint: `fingerprint:${workspaceId}`,
    status,
    registered_at: NOW,
    ...(status === "ready" ? { current_snapshot_id: `snapshot:${workspaceId}` } : {}),
  };
}

async function findStaleDirectory(workspacesDir: string, name: string): Promise<string | undefined> {
  const entries = await readdir(workspacesDir).catch(() => []);
  return entries.find((entry) => entry.startsWith(`${name}.v3.stale-`));
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number, describe_: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${describe_}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

describe("Daemon recreate-outdated wiring (P4-a)", () => {
  let dataRoot: string | undefined;
  let rootA: string | undefined;
  let rootB: string | undefined;
  let rootC: string | undefined;
  let rootD: string | undefined;
  let runtime: DaemonRuntime | undefined;

  afterEach(async () => {
    await runtime?.stop().catch(() => undefined);
    runtime = undefined;
    if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
    if (rootA) await rm(rootA, { recursive: true, force: true });
    if (rootB) await rm(rootB, { recursive: true, force: true });
    if (rootC) await rm(rootC, { recursive: true, force: true });
    if (rootD) await rm(rootD, { recursive: true, force: true });
    dataRoot = undefined;
    rootA = undefined;
    rootB = undefined;
    rootC = undefined;
    rootD = undefined;
  });

  it("moves a v2-style (missing index_contract, with data) and a stale-identity-format v3 database aside, re-bootstraps them, and schedules a fresh Full scan -- while leaving a current v4 database completely untouched", async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "urdira-recreate-outdated-daemon-"));
    rootA = await mkdtemp(join(tmpdir(), "urdira-recreate-outdated-root-a-"));
    rootB = await mkdtemp(join(tmpdir(), "urdira-recreate-outdated-root-b-"));

    const workspaceIdA = "workspace:recreate-a";
    const workspaceIdB = "workspace:recreate-b";
    const workspaceIdC = "workspace:recreate-c";

    const seedStorage = await createDurableStorage({ rootDir: dataRoot });
    let databasePathA: string;
    let databasePathB: string;
    let databasePathC: string;
    try {
      // (a) v2-style: a valid, freshly-stamped v3 file whose `index_contract`
      // row is then removed while data already exists -- schema.ts's exact
      // "missing index_contract, with data" branch
      // (`core:index_contract_unsupported`), not the "wrong byte value" one.
      const registeredA = await seedStorage.catalog.registerWorkspace(catalogRegistration(workspaceIdA, rootA, "binding:a"));
      databasePathA = registeredA.database_path;
      const rawA = await openSqliteDatabase({ filename: databasePathA });
      await rawA.run("DELETE FROM workspace_meta WHERE key = 'index_contract'");
      await rawA.run("INSERT INTO source_artifacts (artifact_id, workspace_id, normalized_uri, artifact_kind) VALUES (?, ?, ?, ?)", ["artifact:seed-a", workspaceIdA, "file:///seed-a.ts", "file"]);
      await rawA.close();

      // (b) a normal v3 file whose `identity_format` marker is downgraded to
      // 1 (`CURRENT_IDENTITY_FORMAT` is 2) -- `storage:workspace_format_outdated`.
      const registeredB = await seedStorage.catalog.registerWorkspace(catalogRegistration(workspaceIdB, rootB, "binding:b"));
      databasePathB = registeredB.database_path;
      const rawB = await openSqliteDatabase({ filename: databasePathB });
      await rawB.run("UPDATE workspace_meta SET value = ? WHERE key = 'identity_format'", [encodeCanonical(1)]);
      await rawB.close();

      // (c) a genuine, current v4 database -- stamped directly (never
      // through `registerWorkspace`, which only ever stamps v3) and never
      // registered in the catalog at all, exactly like (a)/(b) above (see
      // this file's top doc comment for why).
      const pathsC = await ensureV4Workspace({ storage: asEngineDurableStorage(seedStorage), workspace_id: workspaceIdC });
      databasePathC = pathsC.database_path;

      // Neither (a) nor (b) is left registered in THIS process's catalog --
      // `DurableStorage.open`'s startup recovery below would otherwise
      // reject construction outright on either row (see this file's top
      // doc comment). Only the on-disk files, at their deterministic
      // default paths, matter to the daemon that starts next.
      await seedStorage.catalog.database.run("DELETE FROM installation_workspaces WHERE workspace_id IN (?, ?)", [workspaceIdA, workspaceIdB]);
    } finally {
      await seedStorage.close();
    }

    const statBeforeC = await stat(databasePathC);

    const codebaseId = "codebase:recreate-outdated-test";
    const state: WorkspaceRegistryState = {
      schema_version: 2,
      workspaces: [
        registryWorkspace(workspaceIdA, rootA, "binding:a", "indexing", codebaseId),
        registryWorkspace(workspaceIdB, rootB, "binding:b", "indexing", codebaseId),
        registryWorkspace(workspaceIdC, "/nonexistent/urdira-recreate-outdated-c", "binding:c", "ready", codebaseId),
      ],
      codebases: [{ codebase_id: codebaseId, display_name: "recreate-outdated-test", created_at: NOW }],
    };
    const registry = new WorkspaceRegistry({ persistence: { load: () => state, save: () => undefined } });

    runtime = await DaemonRuntime.start({
      data_root: dataRoot,
      engine_build_id: "build-recreate-outdated-test",
      workspace_registry: asDaemonWorkspaceRegistry(registry),
      resolve_plugin_provider: async () => undefined,
      lexical_index: false,
      semantic_index: false,
      scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
    });

    const workspacesDir = join(dataRoot, "workspaces");
    await waitUntil(async () => (await findStaleDirectory(workspacesDir, "workspace_recreate-a")) !== undefined, 30_000, "workspace A's outdated database to be moved into a stale directory");
    await waitUntil(async () => (await findStaleDirectory(workspacesDir, "workspace_recreate-b")) !== undefined, 30_000, "workspace B's outdated database to be moved into a stale directory");

    // (a)/(b): moved aside, never deleted -- the stale copies still carry
    // the exact corruption this test seeded (proving they are really the
    // OLD files, not some new artifact). Checked now, right after the move
    // itself, since nothing further ever touches a stale directory once
    // written.
    const staleA = await findStaleDirectory(workspacesDir, "workspace_recreate-a");
    expect(staleA).toBeDefined();
    const staleDatabasePathA = join(workspacesDir, staleA!, "workspace_recreate-a.sqlite");
    const staleRawA = await openSqliteDatabase({ filename: staleDatabasePathA, read_only: true });
    try {
      expect(await staleRawA.get("SELECT value FROM workspace_meta WHERE key = 'index_contract'")).toBeUndefined();
      expect((await staleRawA.get<{ count: number }>("SELECT COUNT(*) AS count FROM source_artifacts"))?.count).toBe(1);
    } finally {
      await staleRawA.close();
    }
    const staleB = await findStaleDirectory(workspacesDir, "workspace_recreate-b");
    expect(staleB).toBeDefined();
    const staleDatabasePathB = join(workspacesDir, staleB!, "workspace_recreate-b.sqlite");
    const staleRawB = await openSqliteDatabase({ filename: staleDatabasePathB, read_only: true });
    try {
      const identity = await staleRawB.get<{ value: Uint8Array }>("SELECT value FROM workspace_meta WHERE key = 'identity_format'");
      expect(new Uint8Array(identity!.value)).toEqual(encodeCanonical(1));
    } finally {
      await staleRawB.close();
    }

    // A fresh Full scan really was scheduled (not merely the recreate step
    // alone): each workspace's `last_scan_error` must SETTLE on some OTHER,
    // later failure (this test's fixture roots are empty directories, so
    // the rescheduled scan's own `resolve_plugin_provider: async () =>
    // undefined` routes it into `runSourceOnlyWorkspaceScan`, which rejects
    // an empty root as `engine:workspace_scan_empty`) rather than staying
    // on -- or never advancing past -- undefined/the outdated-format code
    // that triggered recovery. `last_scan_error` starts `undefined` (no
    // scan has failed yet at all), so a predicate that only excludes the
    // outdated code would resolve immediately on that initial `undefined`
    // and prove nothing; requiring it to be SET first is what actually
    // waits out the rescheduled attempt.
    await waitUntil(async () => {
      const workspace = registry.get(workspaceIdA);
      return workspace?.last_scan_error !== undefined && workspace.last_scan_error !== "core:index_contract_unsupported";
    }, 30_000, "workspace A's rescheduled scan to move past the outdated-format error");
    await waitUntil(async () => {
      const workspace = registry.get(workspaceIdB);
      return workspace?.last_scan_error !== undefined && workspace.last_scan_error !== "storage:workspace_format_outdated";
    }, 30_000, "workspace B's rescheduled scan to move past the outdated-format error");

    // Only now -- after each rescheduled scan has actually settled -- is a
    // brand-new, valid file guaranteed to be at the original path: the
    // re-stamp itself happens inside that RETRY's own `registerWorkspace`/
    // `openWorkspace` call, not synchronously as part of the recreate step
    // above (which only moves the old file aside and returns).
    const freshRawA = await openSqliteDatabase({ filename: databasePathA, read_only: true });
    try {
      const contract = await freshRawA.get<{ value: Uint8Array }>("SELECT value FROM workspace_meta WHERE key = 'index_contract'");
      expect(contract).toBeDefined();
      expect(new Uint8Array(contract!.value)[0]).toBe(0x33);
    } finally {
      await freshRawA.close();
    }
    const freshRawB = await openSqliteDatabase({ filename: databasePathB, read_only: true });
    try {
      const identity = await freshRawB.get<{ value: Uint8Array }>("SELECT value FROM workspace_meta WHERE key = 'identity_format'");
      expect(identity).toBeDefined();
      expect(new Uint8Array(identity!.value)).toEqual(encodeCanonical(2));
    } finally {
      await freshRawB.close();
    }

    // (c): completely untouched -- no stale directory ever appears next to
    // it, and the file itself is byte-for-byte and mtime-identical to
    // before the daemon ever started.
    expect(await findStaleDirectory(workspacesDir, "workspace_recreate-c")).toBeUndefined();
    const statAfterC = await stat(databasePathC);
    expect(statAfterC.mtimeMs).toBe(statBeforeC.mtimeMs);
    expect(statAfterC.size).toBe(statBeforeC.size);
    expect(registry.get(workspaceIdC)?.status).toBe("ready");
  }, 120_000);

  /**
   * P4-b-prep (plan §9): `DurableStorage.open`'s startup recovery sweep
   * (`recoverMigrations`/`recoverWorkspaceGcEpochs`) used to apply the v3
   * schema-compatibility check unconditionally to EVERY catalogued
   * workspace, crashing `createDurableStorage` -- and so `DaemonRuntime.start`
   * entirely -- the moment ANY one of them was at an outdated or v4 index
   * contract, before the daemon ever served a single RPC for even a
   * perfectly healthy workspace. Unlike the test above (which deliberately
   * keeps the outdated workspaces OUT of the catalog and pre-seeds their
   * `WorkspaceRegistry` status as `"indexing"`, exactly BECAUSE this gap
   * existed -- see this file's top doc comment), this test exercises the
   * fix directly: all four workspaces are registered in the real catalog
   * (`installation_workspaces`), and the two outdated ones start at registry
   * status `"ready"` (simulating a workspace fully indexed by a PRIOR urdira
   * version, whose on-disk format only became unsupported after an
   * upgrade) -- proving `DaemonRuntime.start` itself (not just this test's
   * own fixture setup) discovers them and reschedules a scan, not merely
   * that an already-`"indexing"` workspace's pre-existing crash-recovery
   * loop happens to retry it.
   *
   * Also a genuine two-life daemon restart (`runtime.stop()` then a second
   * `DaemonRuntime.start()` over the same `data_root`), using the real
   * `workspaces.json`-backed `createPersistentWorkspaceRegistry` (not an
   * in-memory stub) both times, so the SECOND life's `WorkspaceRegistry`
   * reflects exactly what the first life durably persisted.
   */
  it("survives a daemon restart over a data root containing v2-style and stale-identity-format v3 workspaces already registered (and 'ready') in the catalog, recreating and rescanning only those two while current v3 and v4 workspaces keep serving core:index_status throughout", async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "urdira-restart-data-"));
    rootA = await mkdtemp(join(tmpdir(), "urdira-restart-a-"));
    rootB = await mkdtemp(join(tmpdir(), "urdira-restart-b-"));
    rootC = await mkdtemp(join(tmpdir(), "urdira-restart-c-"));
    rootD = await mkdtemp(join(tmpdir(), "urdira-restart-d-"));

    const workspaceIdA = "workspace:restart-a";
    const workspaceIdB = "workspace:restart-b";
    const workspaceIdC = "workspace:restart-c";
    const workspaceIdD = "workspace:restart-d";
    const DAEMON_CLIENT_OPTIONS = { request_timeout_ms: 60_000 };

    const seedStorage = await createDurableStorage({ rootDir: dataRoot });
    let databasePathA: string;
    let databasePathB: string;
    let databasePathC: string;
    let databasePathD: string;
    try {
      // (a) v2-style: registered normally, then corrupted (missing
      // `index_contract`, with data already present) -- and, unlike the
      // test above, left registered in the catalog.
      const registeredA = await seedStorage.catalog.registerWorkspace(catalogRegistration(workspaceIdA, rootA, "binding:restart-a"));
      databasePathA = registeredA.database_path;
      const rawA = await openSqliteDatabase({ filename: databasePathA });
      await rawA.run("DELETE FROM workspace_meta WHERE key = 'index_contract'");
      await rawA.run("INSERT INTO source_artifacts (artifact_id, workspace_id, normalized_uri, artifact_kind) VALUES (?, ?, ?, ?)", ["artifact:seed-restart-a", workspaceIdA, "file:///seed-restart-a.ts", "file"]);
      await rawA.close();

      // (b) v3-stale-identity: registered normally, then downgraded to
      // `identity_format` 1 (`CURRENT_IDENTITY_FORMAT` is 2).
      const registeredB = await seedStorage.catalog.registerWorkspace(catalogRegistration(workspaceIdB, rootB, "binding:restart-b"));
      databasePathB = registeredB.database_path;
      const rawB = await openSqliteDatabase({ filename: databasePathB });
      await rawB.run("UPDATE workspace_meta SET value = ? WHERE key = 'identity_format'", [encodeCanonical(1)]);
      await rawB.close();

      // (c) v4-current: stamped v4 BEFORE the catalog registration touches
      // the same default path, so `registerWorkspaceSerialized` takes the
      // v4 branch instead of initializing v3 on top of it -- then genuinely
      // registered in the catalog (unlike the test above), so the startup
      // recovery sweep actually opens it and must take the v4 path too.
      const pathsC = await ensureV4Workspace({ storage: asEngineDurableStorage(seedStorage), workspace_id: workspaceIdC });
      const registeredC = await seedStorage.catalog.registerWorkspace(catalogRegistration(workspaceIdC, rootC, "binding:restart-c"));
      expect(registeredC.database_path).toBe(pathsC.database_path);
      databasePathC = registeredC.database_path;

      // (d) v3-current: a plain, healthy, unmodified v3 registration.
      const registeredD = await seedStorage.catalog.registerWorkspace(catalogRegistration(workspaceIdD, rootD, "binding:restart-d"));
      databasePathD = registeredD.database_path;
    } finally {
      await seedStorage.close();
    }

    const codebaseId = "codebase:recreate-outdated-restart-test";
    const initialState: WorkspaceRegistryState = {
      schema_version: 2,
      workspaces: [
        // (a) and (b) start at "ready" -- as if a prior urdira version fully
        // indexed them before an upgrade made their on-disk format
        // unsupported. This is the exact case the pre-existing
        // `recoverMigrations`/`recoverWorkspaceGcEpochs` crash blocked from
        // EVER being discovered: nothing in the old "crash recovery" loop
        // (which only retries workspaces already left `"indexing"`) would
        // have found them, because `createDurableStorage` itself never
        // returned.
        registryWorkspace(workspaceIdA, rootA, "binding:restart-a", "ready", codebaseId),
        registryWorkspace(workspaceIdB, rootB, "binding:restart-b", "ready", codebaseId),
        registryWorkspace(workspaceIdC, rootC, "binding:restart-c", "ready", codebaseId),
        registryWorkspace(workspaceIdD, rootD, "binding:restart-d", "ready", codebaseId),
      ],
      codebases: [{ codebase_id: codebaseId, display_name: "recreate-outdated-restart-test", created_at: NOW }],
    };
    // Real, file-backed persistence (`<data_root>/workspaces.json`) both
    // daemon lives below load from and save to -- not an in-memory stub --
    // so the second life's registry genuinely reflects what the first life
    // durably persisted, the way a real process restart would.
    await writeFile(join(dataRoot, "workspaces.json"), `${JSON.stringify(initialState)}\n`, "utf8");

    // `createPersistentWorkspaceRegistry` (`../packages/daemon/src/index.js`)
    // already returns a value typed against the SAME `@urdira/engine`
    // resolution `DaemonRuntimeOptions["workspace_registry"]` uses (both
    // resolved from within the daemon package's own program) -- unlike the
    // test above's manually-`new WorkspaceRegistry(...)`'d instance (typed
    // against this file's OWN top-level engine-`src` import), this one
    // needs no `asDaemonWorkspaceRegistry` cast.
    const daemonOptions = (registry: NonNullable<DaemonRuntimeOptions["workspace_registry"]>): DaemonRuntimeOptions => ({
      data_root: dataRoot!,
      engine_build_id: "build-recreate-outdated-restart-test",
      workspace_registry: registry,
      resolve_plugin_provider: async () => undefined,
      lexical_index: false,
      semantic_index: false,
      scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
    });

    // ---- First daemon life ----
    // `registry` is the SAME live `WorkspaceRegistry` instance the daemon
    // itself mutates (not a fresh read of the persisted file each time) --
    // its in-process `Map` reflects every write the daemon makes for the
    // rest of this life, exactly like `WorkspaceRegistry#get` is used by the
    // test above. Reaching this line at all (rather than `DaemonRuntime.start`
    // rejecting) is itself the headline assertion: startup must succeed even
    // though TWO of the four catalogued workspaces are at an outdated/
    // unsupported index contract.
    const registry = createPersistentWorkspaceRegistry(dataRoot);
    runtime = await DaemonRuntime.start(daemonOptions(registry));

    // (a)/(b): discovered and flipped to "indexing" with the outdated error
    // code recorded, synchronously as part of THIS `start()` call -- proving
    // `DaemonRuntime.start` itself (not a pre-seeded fixture) performed the
    // discovery.
    expect(registry.get(workspaceIdA)?.status).toBe("indexing");
    expect(registry.get(workspaceIdA)?.last_scan_error).toBe("core:index_contract_unsupported");
    expect(registry.get(workspaceIdB)?.status).toBe("indexing");
    expect(registry.get(workspaceIdB)?.last_scan_error).toBe("storage:workspace_format_outdated");

    // (c)/(d): untouched by the sweep, immediately queryable.
    const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);
    for (const [workspaceId, expectedSnapshot] of [[workspaceIdC, `snapshot:${workspaceIdC}`], [workspaceIdD, `snapshot:${workspaceIdD}`]] as const) {
      const detail = await client.call("core:index_status", { workspace_ids: [workspaceId] });
      if (detail.outcome !== "success") throw new Error(`core:index_status did not succeed for ${workspaceId}: ${JSON.stringify(detail)}`);
      const payload = detail.payload as { readonly workspaces: ReadonlyArray<{ readonly workspace_status: string; readonly current_snapshot_id?: string }> };
      const workspace = payload.workspaces[0];
      expect(workspace?.workspace_status).toBe("ready");
      expect(workspace?.current_snapshot_id).toBe(expectedSnapshot);
    }

    const workspacesDir = join(dataRoot, "workspaces");
    await waitUntil(async () => (await findStaleDirectory(workspacesDir, "workspace_restart-a")) !== undefined, 30_000, "workspace A's outdated database to be moved into a stale directory");
    await waitUntil(async () => (await findStaleDirectory(workspacesDir, "workspace_restart-b")) !== undefined, 30_000, "workspace B's outdated database to be moved into a stale directory");
    await waitUntil(async () => {
      const workspace = registry.get(workspaceIdA);
      return workspace?.last_scan_error !== undefined && workspace.last_scan_error !== "core:index_contract_unsupported";
    }, 30_000, "workspace A's rescheduled scan to move past the outdated-format error");
    await waitUntil(async () => {
      const workspace = registry.get(workspaceIdB);
      return workspace?.last_scan_error !== undefined && workspace.last_scan_error !== "storage:workspace_format_outdated";
    }, 30_000, "workspace B's rescheduled scan to move past the outdated-format error");

    const freshRawA = await openSqliteDatabase({ filename: databasePathA, read_only: true });
    try {
      const contract = await freshRawA.get<{ value: Uint8Array }>("SELECT value FROM workspace_meta WHERE key = 'index_contract'");
      expect(contract).toBeDefined();
      expect(new Uint8Array(contract!.value)[0]).toBe(0x33);
    } finally {
      await freshRawA.close();
    }
    const freshRawB = await openSqliteDatabase({ filename: databasePathB, read_only: true });
    try {
      const identity = await freshRawB.get<{ value: Uint8Array }>("SELECT value FROM workspace_meta WHERE key = 'identity_format'");
      expect(identity).toBeDefined();
      expect(new Uint8Array(identity!.value)).toEqual(encodeCanonical(2));
    } finally {
      await freshRawB.close();
    }

    await runtime.stop();
    runtime = undefined;

    // ---- Restart: a second daemon life over the SAME data root ----
    // A fresh `WorkspaceRegistry` instance, loaded from the file the first
    // life saved -- a genuine restart, not a reused in-memory object.
    const registry2 = createPersistentWorkspaceRegistry(dataRoot);
    runtime = await DaemonRuntime.start(daemonOptions(registry2));

    // Startup succeeds again; (c) and (d) keep serving core:index_status
    // exactly as before, completely unaffected by the restart.
    const client2 = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);
    for (const [workspaceId, expectedSnapshot] of [[workspaceIdC, `snapshot:${workspaceIdC}`], [workspaceIdD, `snapshot:${workspaceIdD}`]] as const) {
      const detail = await client2.call("core:index_status", { workspace_ids: [workspaceId] });
      if (detail.outcome !== "success") throw new Error(`core:index_status did not succeed for ${workspaceId} after restart: ${JSON.stringify(detail)}`);
      const payload = detail.payload as { readonly workspaces: ReadonlyArray<{ readonly workspace_status: string; readonly current_snapshot_id?: string }> };
      const workspace = payload.workspaces[0];
      expect(workspace?.workspace_status).toBe("ready");
      expect(workspace?.current_snapshot_id).toBe(expectedSnapshot);
    }

    // (a)/(b) were already recreated during the first life -- their files
    // are fresh, current-format v3 databases now. The second life's
    // startup sweep must NOT rediscover them as outdated a second time: no
    // additional stale directory appears, and `last_scan_error` does not
    // regress back to the original outdated-format code.
    const staleEntriesA = (await readdir(workspacesDir)).filter((entry) => entry.startsWith("workspace_restart-a.v3.stale-"));
    const staleEntriesB = (await readdir(workspacesDir)).filter((entry) => entry.startsWith("workspace_restart-b.v3.stale-"));
    expect(staleEntriesA).toHaveLength(1);
    expect(staleEntriesB).toHaveLength(1);
    expect(registry2.get(workspaceIdA)?.last_scan_error).not.toBe("core:index_contract_unsupported");
    expect(registry2.get(workspaceIdB)?.last_scan_error).not.toBe("storage:workspace_format_outdated");

    // (c)/(d): no stale directory ever appears next to either, across
    // either daemon life -- both stayed genuinely untouched throughout.
    expect(await findStaleDirectory(workspacesDir, "workspace_restart-c")).toBeUndefined();
    expect(await findStaleDirectory(workspacesDir, "workspace_restart-d")).toBeUndefined();
    const rawC = await openSqliteDatabase({ filename: databasePathC, read_only: true });
    try {
      const contract = await rawC.get<{ value: Uint8Array }>("SELECT value FROM workspace_meta WHERE key = 'index_contract'");
      expect(new Uint8Array(contract!.value)[0]).toBe(0x34);
    } finally {
      await rawC.close();
    }
    const rawD = await openSqliteDatabase({ filename: databasePathD, read_only: true });
    try {
      const contract = await rawD.get<{ value: Uint8Array }>("SELECT value FROM workspace_meta WHERE key = 'index_contract'");
      expect(new Uint8Array(contract!.value)[0]).toBe(0x33);
    } finally {
      await rawD.close();
    }
  }, 180_000);
});
