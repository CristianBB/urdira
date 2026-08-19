import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeCanonical } from "@urdira/canonical";
import { WorkspaceRegistry, type RegisteredWorkspace } from "../packages/engine/src/index.js";
import { createDurableStorage, type DurableStorage, type WorkspaceDatabase } from "../packages/storage/src/index.js";
import { DaemonClient, DaemonRuntime, type DaemonRuntimeOptions } from "../packages/daemon/src/index.js";

/**
 * Daemon-level coverage for `URDIRA_WARM_RECORDS_BUDGET_MB`
 * (`DaemonRuntimeOptions.warm_records_budget_mb`, `packages/daemon/src/runtime.ts`):
 * with a small budget override and two "ready" workspaces, warming the
 * second must evict the first's warm decoded-record cache (LRU, per that
 * option's own doc comment), while queries against the evicted workspace
 * still return byte-correct results afterward.
 *
 * This deliberately bypasses real workspace scans (no JS/TS plugin, no file
 * system fixture) -- what is under test is the daemon's LRU byte-budget
 * bookkeeping over `queryEngines`, not indexing itself, which is already
 * covered elsewhere (e.g. `tests/phase-daemon-indexing-integration.test.ts`).
 * Each workspace is registered directly (`WorkspaceRegistry.register` +
 * `beginReconciliation` + `markReady`, mirroring what
 * `packages/daemon/src/runtime.ts`'s `scheduleWorkspaceScan` does before a
 * real scan) and its own SQLite database is seeded directly with the exact
 * tables `SqliteCanonicalQuerySnapshotPort` reads from -- the same technique
 * `tests/phase-canonical-query-data-port.test.ts` uses -- with a handful of
 * large-bodied records so each workspace's `approxWarmBytes()` is large
 * enough that ONE workspace comfortably fits the test budget but TWO do not.
 */

const now = "2026-08-13T00:00:00.000Z";

function asDaemonWorkspaceRegistry(registry: WorkspaceRegistry): NonNullable<DaemonRuntimeOptions["workspace_registry"]> {
  return registry as unknown as NonNullable<DaemonRuntimeOptions["workspace_registry"]>;
}

/** Registers and immediately marks ready a workspace with no real scan -- mirrors `scheduleWorkspaceScan`'s pre-scan registration plus a synthetic "scan completed" transition. */
function registerReadyWorkspace(registry: WorkspaceRegistry, label: string): RegisteredWorkspace {
  const workspace = registry.register({
    display_root: `/warm-budget-${label}`,
    provider: { source_provider_binding_id: `binding:${label}`, source_provider: "core:directory_source_provider", source_provider_version: "1", provider_role: "primary", binding_identity: `identity:${label}`, configuration_digest: `digest:${label}` },
    description: { provider_kind: "core:directory_source_provider", immutable_binding_identity: `identity:${label}`, features: "{}", source_state_fingerprint: `fingerprint:${label}` },
  });
  registry.beginReconciliation(workspace.workspace_id);
  registry.markReady(workspace.workspace_id, `snapshot:${label}`, "ready");
  return registry.get(workspace.workspace_id)!;
}

function recordPayload(body: Readonly<Record<string, unknown>>): Uint8Array {
  return encodeCanonical({ body });
}

/**
 * Seeds the minimal `registry_snapshots`/`snapshots`/`workspace_current_state`
 * baseline `SqliteCanonicalQuerySnapshotPort.currentGeneration` needs, plus
 * `recordCount` records each carrying a `bodyBytes`-character string field --
 * large enough that `approxWarmBytes()` for this workspace alone is roughly
 * `recordCount * bodyBytes` bytes.
 */
async function seedLargeReadyWorkspace(database: WorkspaceDatabase, workspaceId: string, recordCount: number, bodyBytes: number): Promise<void> {
  const db = database.database;
  await db.exec("PRAGMA foreign_keys = OFF");
  await db.run("INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest, registry_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", [`registry:${workspaceId}`, workspaceId, "1", "core-digest", "lock-1", "registry-digest-1", new Uint8Array([1])]);
  await db.run("INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest, snapshot_payload) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [`snapshot:${workspaceId}`, workspaceId, 1, `manifest:${workspaceId}`, `registry:${workspaceId}`, "lock-1", "configuration-1", "source-digest", "[]", "records-digest", "projections-digest", "capabilities-digest", now, `snapshot-digest:${workspaceId}`, new Uint8Array([1])]);
  await db.run("INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at, current_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [workspaceId, `snapshot:${workspaceId}`, 1, `registry:${workspaceId}`, "lock-1", "configuration-1", "freshness-1", 1, now, new Uint8Array([1])]);
  await db.run("INSERT INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [`blob:${workspaceId}`, `sha256:${workspaceId}`, 0, "inline"]);
  // `artifact_versions`/`record_occurrences` both have a real FK to
  // `source_artifacts(workspace_id, artifact_id)` -- `PRAGMA foreign_keys =
  // OFF` above only suppresses enforcement AT INSERT TIME; a later, fresh
  // `openWorkspace()` call (the daemon's own, opening this already-seeded
  // file) runs `ensureWorkspaceSchemaCompatibility`'s unconditional `PRAGMA
  // foreign_key_check`, which reports these as real orphans regardless of
  // the pragma state used to write them -- so a row here is required, not
  // optional, unlike this file's single-open-handle sibling
  // (`tests/phase-canonical-query-data-port.test.ts`), which never
  // re-triggers that check.
  await db.run("INSERT INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind, artifact_payload) VALUES ('art-1', ?, ?, ?, ?, 'source_file', ?)", [workspaceId, `file:///warm-budget/${workspaceId}.ts`, `${workspaceId}.ts`, `${workspaceId}.ts`, new Uint8Array([1])]);
  // `artifact_versions.created_from_observation_id` has a real FK to
  // `source_observations(workspace_id, artifact_id, source_observation_id)`,
  // which in turn FKs to `source_observation_batches` -- both required for
  // the same "a later fresh openWorkspace() re-checks all FKs" reason as
  // `source_artifacts` above.
  await db.run("INSERT INTO source_observation_batches (observation_batch_id, workspace_id, source_provider_binding_id, source_provider, source_provider_version, ordering_domain, observation_mode, coverage_scopes, coverage_completeness, deletion_authority, started_at, completed_at, observation_count, unavailable_count, batch_digest, observation_batch_payload) VALUES (?, ?, 'binding-1', 'core:directory_source_provider', '1', 'domain-1', 'full', '[]', 'complete', 'authoritative', ?, ?, 1, 0, ?, ?)", [`batch:${workspaceId}`, workspaceId, now, now, `batch-digest:${workspaceId}`, new Uint8Array([1])]);
  await db.run("INSERT INTO source_observations (source_observation_id, observation_batch_id, workspace_id, artifact_id, source_provider_binding_id, source_provider, source_provider_version, ordering_domain, observation_mode, observed_state, observed_at, received_at, observation_payload) VALUES ('observation-1', ?, ?, 'art-1', 'binding-1', 'core:directory_source_provider', '1', 'domain-1', 'full', 'present', ?, ?, ?)", [`batch:${workspaceId}`, workspaceId, now, now, new Uint8Array([1])]);
  await db.run("INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES (?, ?, 'art-1', ?, ?, 0, 'utf-8', NULL, 'metadata-digest', 'observation-1', 0, NULL, ?)", [`artv:${workspaceId}`, workspaceId, `blob:${workspaceId}`, `sha256:${workspaceId}`, new Uint8Array([1])]);
  const filler = "x".repeat(bodyBytes);
  for (let index = 0; index < recordCount; index += 1) {
    const recordId = `rec:${workspaceId}:${String(index).padStart(4, "0")}`;
    const payload = recordPayload({ name: `record-${index}`, filler });
    await db.run(
      "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, payload_digest, payload_byte_length, payload_inline, payload_cas_digest, record_payload) VALUES (?, ?, 'entity', 'function_declaration', 'core:function', 1, 'test', '1', 'art-1', ?, NULL, NULL, NULL, NULL, NULL, 1, NULL, ?, 'payload-digest', ?, ?, NULL, ?)",
      [recordId, workspaceId, `artv:${workspaceId}`, `digest-${recordId}`, payload.byteLength, payload, payload],
    );
  }
}

/**
 * Queries just the FIRST (lowest `record_id`, matching insertion order given
 * this file's zero-padded ids) matching record and returns its
 * `record_id:name` pair. `response_budget.max_items` is deliberately tiny
 * (not the seeded record COUNT): `core:find_records`' record `body` is
 * embedded in the response verbatim regardless of `response_budget` (which
 * only bounds item count/snippet characters, not an individual record
 * body's own size) -- returning every seeded record here would multiply
 * `bodyBytes` by `recordCount` in the IPC response, overflowing the
 * daemon's 256KB default UCE frame size. One item is all this test needs to
 * prove a post-eviction reload decodes correctly.
 */
async function findFirstRecordName(client: DaemonClient, workspaceId: string): Promise<string | undefined> {
  const response = await client.call("core:query", {
    api_version: 1,
    scope: { scope_type: "single_workspace", workspace_id: workspaceId },
    expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } },
    options: {
      freshness: "current", wait_timeout_ms: 0, coverage_requirement: "accept_reported",
      evidence: { evidence: "summary", evidence_chain_depth: 1 }, diagnostics: { diagnostics: "relevant", diagnostic_detail: false },
      snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
      registry: { registry: "used", include_payload_schemas: false }, response_budget: { max_items: 1, max_characters: 10_000 },
    },
  });
  expect(response.outcome).toBe("success");
  type StreamPage = { readonly items: ReadonlyArray<{ readonly value: { readonly record_id: string; readonly body: Readonly<Record<string, unknown>> } }> };
  const payload = response.payload as { readonly streams: Readonly<Record<string, StreamPage>> };
  const first = payload.streams["records"]?.items[0];
  return first === undefined ? undefined : `${first.value.record_id}:${String(first.value.body["name"])}`;
}

describe("Daemon warm-records LRU byte budget (URDIRA_WARM_RECORDS_BUDGET_MB)", () => {
  it("warming a second workspace evicts the first once the budget is exceeded, and the evicted workspace still answers queries correctly", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-warm-budget-data-"));
    let seedStorage: DurableStorage | undefined;
    let runtime: DaemonRuntime | undefined;
    try {
      // `WorkspaceRegistry.list()` (which the startup prewarm chain iterates
      // in order) sorts by `workspace_id`, not registration order -- the
      // default `create_id` mints `workspace:${randomUUID()}`, whose sort
      // order relative to a second random id is undefined. Fixed,
      // alphabetically-ordered ids make "A registered/warmed before B"
      // deterministic instead of a coin flip across runs.
      let nextWorkspaceId = 0;
      const fixedWorkspaceIds = ["workspace:warm-budget-a", "workspace:warm-budget-b"];
      const registry = new WorkspaceRegistry({ create_id: (kind) => (kind === "workspace" ? fixedWorkspaceIds[nextWorkspaceId++]! : `codebase:${nextWorkspaceId++}`) });
      const workspaceA = registerReadyWorkspace(registry, "a");
      const workspaceB = registerReadyWorkspace(registry, "b");

      // Seed both workspaces' databases directly (no real scan) BEFORE the
      // daemon opens them, then close this seeding storage handle so the
      // daemon's own `indexingStorage` can freely reopen the same files
      // (workspace leases are per-open-handle, released on `close()`).
      seedStorage = await createDurableStorage({ rootDir: dataRoot });
      for (const workspace of [workspaceA, workspaceB]) {
        await seedStorage.catalog.registerWorkspace({ workspace_id: workspace.workspace_id, canonical_root: workspace.canonical_root, display_root: workspace.display_root, source_provider_bindings: [workspace.provider], status: "registered", registered_at: workspace.registered_at });
        const database = await seedStorage.openWorkspace(workspace.workspace_id);
        try {
          // 500 records * 4,000 chars ~= 2MB of record_payload per
          // workspace -- comfortably under a 3MB budget alone, but two
          // together (~4MB) exceed it. Deliberately many SMALL records
          // rather than few LARGE ones: `core:find_records`' response
          // embeds a matched record's `body` in full regardless of
          // `response_budget` (see `findFirstRecordName`'s own doc
          // comment), so keeping each individual record small keeps the
          // verification query's own response comfortably under the
          // daemon's 256KB default UCE frame size.
          await seedLargeReadyWorkspace(database, workspace.workspace_id, 500, 4_000);
        } finally {
          await database.close();
        }
      }
      await seedStorage.close();
      seedStorage = undefined;

      const expectedFirstNameA = `rec:${workspaceA.workspace_id}:0000:record-0`;

      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-warm-records-budget",
        workspace_registry: asDaemonWorkspaceRegistry(registry),
        // Never actually invoked: both workspaces are pre-marked "ready"
        // above, so no scan is ever scheduled for them.
        resolve_plugin_provider: async () => undefined,
        // Keep this hermetic and fast: no lexical/semantic maintenance job
        // needed to prove record-cache LRU eviction.
        lexical_index: false,
        semantic_index: false,
        warm_records_budget_mb: 3,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });

      // The startup prewarm chain (`DaemonRuntime.start`) sequentially warms
      // every "ready"/"degraded" workspace in the background; wait for that
      // chain (and any other tracked warm) to fully settle before asserting.
      await runtime.debugFlushPendingWarms();

      // Workspace A warmed first (bytes(A) alone < 3MB budget, so the
      // startup chain did not stop after it), then workspace B warmed
      // second, pushing the combined total over budget -- B is now the
      // most-recently-used workspace and is spared; A (least-recently-used)
      // was evicted.
      expect(await runtime.debugHasWarmRecords(workspaceA.workspace_id)).toBe(false);
      expect(await runtime.debugHasWarmRecords(workspaceB.workspace_id)).toBe(true);

      // The `queryEngines` entry itself (and A's open database handle) must
      // still exist -- only the decoded corpus was dropped, per
      // `evictWarmRecords()`'s own contract -- so querying A again must
      // still succeed and return byte-correct results, reloading normally
      // through the ordinary cold path.
      const firstNameA = await findFirstRecordName(new DaemonClient(runtime.endpoint), workspaceA.workspace_id);
      expect(firstNameA).toBe(expectedFirstNameA);
    } finally {
      await seedStorage?.close().catch(() => undefined);
      await runtime?.stop().catch(() => undefined);
      await rm(dataRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
