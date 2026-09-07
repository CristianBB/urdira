import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WorkspaceRegistry, type WorkspaceScanPluginProvider } from "../packages/engine/src/index.js";
import { createIndexingCoreProcessTransport, type IndexingCoreProcessTransport } from "../packages/plugin-javascript-typescript/src/indexing-core-process-transport.js";
import { DaemonClient, DaemonRuntime, type DaemonRuntimeOptions } from "../packages/daemon/src/index.js";
import { hostNativeTarget, nativeArtifactNames } from "../scripts/native-release.mjs";

/**
 * v4 storage wiring (2026-09-07, plan `generic-waddling-hartmanis.md` §4):
 * end-to-end coverage that `submitSemanticMaintenance` genuinely runs for a
 * v4-storage workspace (not just the v3-storage path every OTHER semantic
 * e2e test in this repo exercises), using the REAL `urdira-indexing-worker`
 * binary and the REAL native structural-store addon (mirrors
 * `tests/v4-daemon-e2e.test.ts`'s own harness), with the bundled hash
 * provider (`semantic_descriptor: {kind: "hash"}`) so this stays fully
 * hermetic -- no model download, no ONNX runtime.
 *
 * Before this task, a v4 workspace reached `structural_ready: true` but
 * `semantic_availability` stayed `"unavailable"` forever
 * (docs/evidence/2026-09-07-v4-n8n-parity-and-semantic-segments.md §B.0) --
 * `runV4WorkspaceScan` never submitted semantic maintenance at all, and even
 * if it had, `reconcileSemanticProjection`'s entity pass would have thrown
 * outright on `record_occurrences`, a table the v4 catalog schema does not
 * have. This file proves the fix: `core:index_status` reports a real
 * `semantic.completed_generation`, `core:search_semantic` answers a real
 * candidate with `matched_segment` populated, and a `reconcile` no-op does
 * not re-embed.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const hostTarget = hostNativeTarget();
const workerPath = process.env["URDIRA_INDEXING_CORE_WORKER_PATH"]
  ?? (hostTarget === undefined ? undefined : resolve(repoRoot, "release/native", hostTarget, nativeArtifactNames(hostTarget).indexing_core_worker));
const nativeAddonPath = process.env["URDIRA_NATIVE_ADDON_PATH"]
  ?? (hostTarget === undefined ? undefined : resolve(repoRoot, "release/native", hostTarget, nativeArtifactNames(hostTarget).addon));
const hasReleaseArtifacts = workerPath !== undefined && existsSync(workerPath) && nativeAddonPath !== undefined && existsSync(nativeAddonPath);
if (nativeAddonPath !== undefined) process.env["URDIRA_NATIVE_ADDON_PATH"] ??= nativeAddonPath;

const fixtureRoot = resolve(repoRoot, "tests/fixtures/codebases/typescript/task-planner/src/domain");

function asDaemonWorkspaceRegistry(registry: WorkspaceRegistry): NonNullable<DaemonRuntimeOptions["workspace_registry"]> {
  return registry as unknown as NonNullable<DaemonRuntimeOptions["workspace_registry"]>;
}

interface IndexStatusView {
  readonly workspace_status: string;
  readonly structural_ready?: boolean;
  readonly semantic?: { readonly completed_generation?: number; readonly current?: boolean; readonly profile_id?: string };
  readonly structural?: { readonly durable_generation?: number };
}

async function fetchIndexStatus(client: DaemonClient, workspaceId: string): Promise<IndexStatusView> {
  const response = await client.call("core:index_status", { workspace_ids: [workspaceId] });
  if (response.outcome !== "success") throw new Error(`core:index_status did not succeed: ${JSON.stringify(response)}`);
  const payload = response.payload as { readonly workspaces: readonly IndexStatusView[] };
  const workspace = payload.workspaces[0];
  if (workspace === undefined) throw new Error(`core:index_status reported no workspace for ${workspaceId}.`);
  return workspace;
}

async function pollUntilStructuralReady(client: DaemonClient, workspaceId: string, timeoutMs = 30_000): Promise<void> {
  let last: IndexStatusView | undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    last = await fetchIndexStatus(client, workspaceId);
    if (last.structural_ready === true) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Workspace ${workspaceId} did not reach structural_ready within ${timeoutMs}ms (last observed: ${JSON.stringify(last)}).`);
}

async function pollUntilSemanticCurrent(client: DaemonClient, workspaceId: string, timeoutMs = 30_000): Promise<IndexStatusView> {
  let last: IndexStatusView | undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    last = await fetchIndexStatus(client, workspaceId);
    if (last.semantic?.current === true) return last;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Workspace ${workspaceId} did not reach semantic.current within ${timeoutMs}ms (last observed: ${JSON.stringify(last)}).`);
}

// Decision 17's entity-grain eligibility policy (`evaluateEntityEligibility`,
// `semantic-reconciler.ts`) excludes every `core:container` record (classes,
// interfaces, enums -- `errors.ts`'s two classes) and requires a >=120
// character span -- `task.ts`'s type/interface declarations are all
// container/too-short. Neither fixture file has a SINGLE entity-grain-
// eligible declaration on its own, so this test adds one real top-level
// function to exercise the entity-grain lane for real, not just the
// artifact-grain one.
//
// P0 discovered live by this task, reported for the owner's queue and NOT
// fixed here (out of Frente S-C's scope -- a structural-producer span
// concern, not a semantic-wiring one): `crates/urdira-jsts-syntax-worker`'s
// `push_entity_with_type_surface` publishes `start`/`end` as the IDENTIFIER
// NAME's own span (`identifier.span.start`/`.end`), not the whole
// declaration's span -- unlike v3's TS analyzer (`analyzer.ts`'s
// `entityForDeclaration`), which explicitly separates `identityStart`
// (name-anchored, for the id only) from the PUBLISHED `start`/`end`
// (`node.getStart(file)`/`node.getEnd()`, the full declaration). Verified
// live: a v4 workspace's every real function/variable entity record came
// back `status: "excluded", reason_codes: ["below_min_length"]` even for a
// multi-line function body comfortably over 120 characters, because only
// its ~50-character NAME was ever measured. The identifier name below is
// deliberately >=120 characters long so this test's own span clears the
// threshold under the CURRENT (buggy) producer behavior -- once that
// producer bug is fixed, this test keeps passing unchanged (a longer real
// declaration span only makes eligibility MORE certain, never less).
const ELIGIBLE_ENTITY_NAME = "summarizeTaskTransitionHistoryForAuditReportingAcrossAllWorkspaceMembersAndTeamsWithFullNotificationFanOutSupportEnabledNow";
const ELIGIBLE_ENTITY_SOURCE = `export function ${ELIGIBLE_ENTITY_NAME}(taskId: string, transitions: readonly string[]): string {
  return \`\${taskId}: \${transitions.join(" -> ")}\`;
}
`;

async function seedFixtureWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-v4-semantic-e2e-"));
  await mkdir(workspaceRoot, { recursive: true });
  for (const file of ["task.ts", "errors.ts"]) {
    await writeFile(join(workspaceRoot, file), await readFile(join(fixtureRoot, file), "utf8"), "utf8");
  }
  await writeFile(join(workspaceRoot, "history.ts"), ELIGIBLE_ENTITY_SOURCE, "utf8");
  return workspaceRoot;
}

type StreamPage = { readonly items: ReadonlyArray<{ readonly value: unknown }>; readonly next_cursor?: string; readonly has_next: boolean };

async function queryStreams(client: DaemonClient, workspaceId: string, operation: string, args: Record<string, unknown>): Promise<Readonly<Record<string, StreamPage>>> {
  const queryOptions = {
    freshness: "current",
    wait_timeout_ms: 0,
    coverage_requirement: "accept_reported",
    evidence: { evidence: "summary", evidence_chain_depth: 1 },
    diagnostics: { diagnostics: "relevant", diagnostic_detail: true },
    snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
    registry: { registry: "used", include_payload_schemas: false },
    response_budget: { max_items: 1_000, max_characters: 4_000_000 },
  };
  const response = await client.call("core:query", {
    api_version: 3,
    scope: { scope_type: "single_workspace", workspace_id: workspaceId },
    expression: { expression_type: "operation", operation, arguments: args },
    options: queryOptions,
  });
  if (response.outcome !== "success") throw new Error(`core:query (${operation}) did not succeed: ${JSON.stringify(response)}`);
  const payload = response.payload as { readonly streams: Readonly<Record<string, StreamPage>> };
  return payload.streams;
}

const DAEMON_CLIENT_OPTIONS = { request_timeout_ms: 120_000 };

const describeIfBuilt = hasReleaseArtifacts ? describe : describe.skip;

it.skipIf(hasReleaseArtifacts)("v4 daemon semantic e2e is skipped: build the release artifacts first", () => {
  console.warn(`[urdira] tests/phase-daemon-v4-semantic.test.ts skipped -- missing worker (${workerPath ?? "no host target"}) or native addon (${nativeAddonPath ?? "no host target"}). Build them with: node scripts/build-native.mjs`);
});

describeIfBuilt("v4 daemon semantic maintenance end-to-end (real urdira-indexing-worker + native structural store + hash provider)", () => {
  it("reaches semantic.current, answers core:search_semantic with matched_segment on an entity candidate, returns a real semantic_coverage affected page, and a reconcile no-op does not re-embed", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-semantic-e2e-data-"));
    const workspaceRoot = await seedFixtureWorkspace();
    let runtime: DaemonRuntime | undefined;
    const sessions = new Map<string, IndexingCoreProcessTransport>();
    try {
      process.env["URDIRA_V4"] = "1";
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-v4-daemon-semantic-e2e",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        resolve_plugin_provider: async (): Promise<WorkspaceScanPluginProvider> => { throw new Error("resolve_plugin_provider must not be called for a v4 workspace."); },
        resolve_workspace_scan_transport: async (workspace) => {
          let transport = sessions.get(workspace.workspace_id);
          if (transport === undefined) {
            transport = createIndexingCoreProcessTransport({ command: workerPath!, request_timeout_ms: 120_000 });
            sessions.set(workspace.workspace_id, transport);
          }
          return transport;
        },
        semantic_descriptor: { kind: "hash" },
        reconciliation_sweep_interval_ms: 0,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);
      const added = await client.call("core:workspace_add", { args: [workspaceRoot], confirmed: true });
      expect(added.outcome, JSON.stringify(added)).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      await pollUntilStructuralReady(client, workspaceId);

      // Before this task's fix, this poll would never resolve: `semantic.current`
      // stayed permanently `false` for a v4 workspace (`v4StatusFields`'s own
      // `isV4 ? false : ...` override, and `submitSemanticMaintenance` was
      // never even called from `runV4WorkspaceScan`'s success path).
      const readyStatus = await pollUntilSemanticCurrent(client, workspaceId, 60_000);
      expect(readyStatus.semantic?.completed_generation).toBeGreaterThan(0);
      expect(readyStatus.semantic?.profile_id).toBeDefined();
      const firstCompletedGeneration = readyStatus.semantic?.completed_generation;

      const semanticStreams = await queryStreams(client, workspaceId, "core:search_semantic", { query_text: ELIGIBLE_ENTITY_NAME, query_class: "identifier" });
      const candidates = semanticStreams["candidates"]?.items ?? [];
      expect(candidates.length).toBeGreaterThan(0);
      const entityCandidate = candidates.find((entry) => {
        const value = entry.value as Record<string, unknown>;
        const evidence = value["semantic_evidence"] as Record<string, unknown> | undefined;
        return evidence?.["matched_segment"] !== undefined;
      });
      expect(entityCandidate, JSON.stringify(candidates)).toBeDefined();
      const evidence = (entityCandidate!.value as Record<string, unknown>)["semantic_evidence"] as Record<string, unknown>;
      const matchedSegment = evidence["matched_segment"] as Record<string, unknown>;
      expect(typeof matchedSegment["index"]).toBe("number");
      expect(typeof matchedSegment["start_char"]).toBe("number");
      expect(typeof matchedSegment["end_char"]).toBe("number");

      const coverageItems = semanticStreams["semantic_coverage"]?.items ?? [];
      expect(coverageItems.length).toBe(1);
      const coverage = coverageItems[0]!.value as { readonly materialization_state: string; readonly affected_artifact_page?: { readonly items: readonly unknown[] } };
      expect(coverage.materialization_state).toBe("complete");
      expect(coverage.affected_artifact_page).toBeDefined();

      // Reconcile no-op: a rescan of the SAME, unchanged workspace must not
      // re-embed anything -- `reconcileSemanticProjection`'s already-complete
      // fast path holds, so `semantic.completed_generation` stays exactly
      // where it was (never advances to a NEW generation just because a scan
      // ran again with nothing to publish).
      const reindexed = await client.call("core:reindex", { args: [workspaceId] });
      expect(reindexed.outcome, JSON.stringify(reindexed)).toBe("success");
      await pollUntilStructuralReady(client, workspaceId);
      // A genuine no-op settles near-instantly (two point lookups, per
      // `reconcileSemanticProjection`'s own fast-path doc comment) -- a short
      // timeout here is itself part of the assertion: a real re-embed would
      // not complete this fast.
      const noopStatus = await pollUntilSemanticCurrent(client, workspaceId, 10_000);
      expect(noopStatus.semantic?.completed_generation).toBe(firstCompletedGeneration);
    } finally {
      if (runtime) await runtime.stop();
      for (const transport of sessions.values()) {
        await transport.shutdown().catch(() => undefined);
        await transport.terminate().catch(() => undefined);
      }
      delete process.env["URDIRA_V4"];
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 180_000);

  // Frente S-D (2026-09-07, Lever 2): the SAME v4 e2e flow above, but with
  // `semantic_shard_count: 2` -- `submitSemanticMaintenance` now runs
  // `runSemanticReconcileSharded` with 2 concurrent child processes instead
  // of `runSemanticReconcileInProcess`'s single one. Proves the daemon-level
  // orchestration end-to-end (real child process spawns, a real finalize
  // call, real `core:index_status` polling) reaches the exact same
  // observable outcome as the unsharded path: `semantic.current` true with a
  // real `completed_generation`, a real entity candidate with
  // `matched_segment`, and a `core:reindex` no-op that settles fast (proving
  // the finalize call's own fast path holds, not a re-embed).
  it("reaches semantic.current with semantic_shard_count: 2 (parallel reconciler), and a reconcile no-op stays fast", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-semantic-e2e-sharded-data-"));
    const workspaceRoot = await seedFixtureWorkspace();
    let runtime: DaemonRuntime | undefined;
    const sessions = new Map<string, IndexingCoreProcessTransport>();
    try {
      process.env["URDIRA_V4"] = "1";
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-v4-daemon-semantic-e2e-sharded",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        resolve_plugin_provider: async (): Promise<WorkspaceScanPluginProvider> => { throw new Error("resolve_plugin_provider must not be called for a v4 workspace."); },
        resolve_workspace_scan_transport: async (workspace) => {
          let transport = sessions.get(workspace.workspace_id);
          if (transport === undefined) {
            transport = createIndexingCoreProcessTransport({ command: workerPath!, request_timeout_ms: 120_000 });
            sessions.set(workspace.workspace_id, transport);
          }
          return transport;
        },
        semantic_descriptor: { kind: "hash" },
        semantic_shard_count: 2,
        reconciliation_sweep_interval_ms: 0,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);
      const added = await client.call("core:workspace_add", { args: [workspaceRoot], confirmed: true });
      expect(added.outcome, JSON.stringify(added)).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      await pollUntilStructuralReady(client, workspaceId);

      const readyStatus = await pollUntilSemanticCurrent(client, workspaceId, 60_000);
      expect(readyStatus.semantic?.completed_generation).toBeGreaterThan(0);
      expect(readyStatus.semantic?.profile_id).toBeDefined();
      const firstCompletedGeneration = readyStatus.semantic?.completed_generation;

      const semanticStreams = await queryStreams(client, workspaceId, "core:search_semantic", { query_text: ELIGIBLE_ENTITY_NAME, query_class: "identifier" });
      const candidates = semanticStreams["candidates"]?.items ?? [];
      expect(candidates.length).toBeGreaterThan(0);
      const entityCandidate = candidates.find((entry) => {
        const value = entry.value as Record<string, unknown>;
        const evidence = value["semantic_evidence"] as Record<string, unknown> | undefined;
        return evidence?.["matched_segment"] !== undefined;
      });
      expect(entityCandidate, JSON.stringify(candidates)).toBeDefined();

      const reindexed = await client.call("core:reindex", { args: [workspaceId] });
      expect(reindexed.outcome, JSON.stringify(reindexed)).toBe("success");
      await pollUntilStructuralReady(client, workspaceId);
      const noopStatus = await pollUntilSemanticCurrent(client, workspaceId, 10_000);
      expect(noopStatus.semantic?.completed_generation).toBe(firstCompletedGeneration);
    } finally {
      if (runtime) await runtime.stop();
      for (const transport of sessions.values()) {
        await transport.shutdown().catch(() => undefined);
        await transport.terminate().catch(() => undefined);
      }
      delete process.env["URDIRA_V4"];
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 180_000);

  // Frente S-E (2026-09-07): reproduces and fixes the `core:coverage_incomplete`
  // regression found live on a real 2,492-file v4 workspace, whose
  // `core:index_status` reported EVERY capability complete at the SAME
  // moment `core:search_semantic` still threw `core:coverage_incomplete`
  // with `blocking_stage: "3"` and `capabilities` listing nearly every
  // STRUCTURAL capability (`core:type_information`, `core:control_flow`,
  // ...) -- none of which `core:search_semantic`/`core:search_hybrid`/
  // `core:semantic_affected_page` ever depend on (their whole answer comes
  // from `semantic_document_status`/`vector_projection_rows`, the pinned
  // spec's own "must never pay corpus-load cost" framing). Root cause:
  // `packages/contracts/src/registries.ts`'s `operationFrontiers` pinned
  // `required_stage: 3` for these three operations -- the SAME bar as
  // `core:compare`/`core:build_context`, which genuinely need full
  // structural completeness -- so the daemon's OWN admission gate
  // (`packages/daemon/src/runtime.ts`'s `requiredStructuralStage` check, run
  // BEFORE the engine's own semantic fast path) blocked on structural stage
  // 3 for an operation that only ever needed the SEPARATE, already-correct
  // `semantic` frontier gate. Fixed to `required_stage: 0` (matching
  // `core:search_text`/`core:get_source`'s own source-frontier-only
  // admission).
  //
  // This test races `core:search_semantic` against a workspace whose
  // structural scan has not yet settled (called immediately after
  // `core:workspace_add` resolves, before `pollUntilStructuralReady`) --
  // deterministically NOT structural-ready yet on a real multi-file scan.
  // Before the fix, this reliably threw with a `details.capabilities` array
  // naming structural capabilities and `details.blocking_stage: "3"` (the
  // BUGGY gate). After the fix, if the query is not yet answerable it must
  // fail (or succeed) through the SEMANTIC frontier gate alone --
  // `details.required_frontier: "semantic"`, no `capabilities` field at all
  // (that field is only ever populated by the structural-stage gate this
  // fix bypasses for these three operations) -- and once semantic
  // materialization genuinely completes, the SAME query succeeds with a
  // real answer, proving the operation was never permanently blocked, only
  // correctly gated on the frontier it actually needs.
  it("core:search_semantic never blocks on structural completeness -- races a real scan and asserts any coverage_incomplete names the semantic frontier, never a structural capability list", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-sem-admission-"));
    const workspaceRoot = await seedFixtureWorkspace();
    let runtime: DaemonRuntime | undefined;
    const sessions = new Map<string, IndexingCoreProcessTransport>();
    try {
      process.env["URDIRA_V4"] = "1";
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-v4-daemon-semantic-e2e-admission",
        workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
        resolve_plugin_provider: async (): Promise<WorkspaceScanPluginProvider> => { throw new Error("resolve_plugin_provider must not be called for a v4 workspace."); },
        resolve_workspace_scan_transport: async (workspace) => {
          let transport = sessions.get(workspace.workspace_id);
          if (transport === undefined) {
            transport = createIndexingCoreProcessTransport({ command: workerPath!, request_timeout_ms: 120_000 });
            sessions.set(workspace.workspace_id, transport);
          }
          return transport;
        },
        semantic_descriptor: { kind: "hash" },
        reconciliation_sweep_interval_ms: 0,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS);
      const added = await client.call("core:workspace_add", { args: [workspaceRoot], confirmed: true });
      expect(added.outcome, JSON.stringify(added)).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;

      // Raced immediately -- may observe a still-blocked answer (structural
      // not ready yet) or, on a very fast machine, an already-complete one.
      // Either outcome is acceptable; only a STRUCTURAL-shaped block is a
      // regression.
      const searchOptions = {
        freshness: "current", wait_timeout_ms: 0, coverage_requirement: "accept_reported",
        evidence: { evidence: "summary", evidence_chain_depth: 1 }, diagnostics: { diagnostics: "relevant", diagnostic_detail: true },
        snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
        registry: { registry: "used", include_payload_schemas: false }, response_budget: { max_items: 1_000, max_characters: 4_000_000 },
      };
      const raced = await client.call("core:query", {
        api_version: 3, scope: { scope_type: "single_workspace", workspace_id: workspaceId },
        expression: { expression_type: "operation", operation: "core:search_semantic", arguments: { query_text: ELIGIBLE_ENTITY_NAME, query_class: "identifier" } },
        options: searchOptions,
      });
      if (raced.outcome === "error" && raced.error?.code === "core:coverage_incomplete") {
        const details = raced.error.details as { readonly capabilities?: readonly string[]; readonly required_frontier?: string; readonly blocking_stage?: string } | undefined;
        expect(details?.capabilities, `regression: core:search_semantic blocked on a structural capability list: ${JSON.stringify(details)}`).toBeUndefined();
        expect(details?.required_frontier).toBe("semantic");
      } else {
        // Not blocked at all (structural/semantic already settled, or a
        // different, unrelated outcome) -- also acceptable; the assertion
        // above only fires on the specific regression shape.
        expect(["success", "error"]).toContain(raced.outcome);
      }

      // The SAME query must genuinely succeed once semantic materialization
      // actually completes -- proves this is a real gate, not a permanently
      // broken one.
      await pollUntilStructuralReady(client, workspaceId);
      await pollUntilSemanticCurrent(client, workspaceId, 60_000);
      const settled = await queryStreams(client, workspaceId, "core:search_semantic", { query_text: ELIGIBLE_ENTITY_NAME, query_class: "identifier" });
      expect((settled["candidates"]?.items ?? []).length).toBeGreaterThan(0);
    } finally {
      if (runtime) await runtime.stop();
      for (const transport of sessions.values()) {
        await transport.shutdown().catch(() => undefined);
        await transport.terminate().catch(() => undefined);
      }
      delete process.env["URDIRA_V4"];
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
