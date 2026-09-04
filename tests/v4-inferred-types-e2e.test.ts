import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WorkspaceRegistry, type WorkspaceScanPluginProvider } from "../packages/engine/src/index.js";
import { createIndexingCoreProcessTransport, type IndexingCoreProcessTransport } from "../packages/plugin-javascript-typescript/src/indexing-core-process-transport.js";
import { DaemonClient, DaemonRuntime, type DaemonRuntimeOptions } from "../packages/daemon/src/index.js";
import { hostNativeTarget, nativeArtifactNames } from "../scripts/native-release.mjs";

/**
 * End-to-end query-visibility coverage for decision 28's "inferred types +
 * compiler diagnostics" task (the residual tsgo pass's `jsts:entity_
 * inferred_type` / `jsts:relation_type_of` / `jsts:diagnostic` output) --
 * task deliverable 5 ("Query visibility"). Bootstrap copied from `tests/
 * v4-daemon-e2e.test.ts`'s own "the residual pass upgrades a possible
 * `implements` heritage edge..." test (real daemon, real `urdira-indexing-
 * worker` binary, real native structural-store addon, `URDIRA_V4_RESIDUAL=1`)
 * -- that file is NOT edited by this task (owned by a concurrent effort);
 * this is a NEW, separate file with its OWN tiny inline fixture (an exported
 * function, an exported class with a method, a deliberate `TS2322` type
 * error, and a `[1, 2].map(...)` call -- the same "guaranteed pending call
 * site" shape `crates/urdira-tsgo-client/tests/residual_pass.rs` and this
 * task's own Rust-level test use, needed so the residual pass has at least
 * one pending call/heritage site to run at all; see `crates/urdira-indexing-
 * worker/src/v4/residual.rs`'s own early-return doc comment).
 *
 * Verifies, after the residual pass upgrade:
 * - `core:find_records` with `kind_selector: { kinds: ["jsts:entity_inferred_
 *   type"] }` returns rows.
 * - `core:expand_relations` outbound from the exported class's own entity,
 *   with `relations: { universal_kinds: ["core:type_of"] }`, reaches its
 *   inferred-type entity (`relations.relation_kinds` accepts the request but
 *   does not actually restrict the traversal for this operation as tested
 *   live -- `universal_kinds` is the field that works, matching every other
 *   passing `core:expand_relations` test in this repo, which all use
 *   `universal_kinds` too).
 * - `core:find_records` with `record_categories: ["diagnostic"]` returns the
 *   deliberate `TS2322` compiler diagnostic.
 *
 * Gated on the release artifacts existing, same pattern as `tests/v4-daemon-
 * e2e.test.ts`.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const hostTarget = hostNativeTarget();
const workerPath = process.env["URDIRA_INDEXING_CORE_WORKER_PATH"]
  ?? (hostTarget === undefined ? undefined : resolve(repoRoot, "release/native", hostTarget, nativeArtifactNames(hostTarget).indexing_core_worker));
const nativeAddonPath = process.env["URDIRA_NATIVE_ADDON_PATH"]
  ?? (hostTarget === undefined ? undefined : resolve(repoRoot, "release/native", hostTarget, nativeArtifactNames(hostTarget).addon));
const hasReleaseArtifacts = workerPath !== undefined && existsSync(workerPath) && nativeAddonPath !== undefined && existsSync(nativeAddonPath);

if (nativeAddonPath !== undefined) process.env["URDIRA_NATIVE_ADDON_PATH"] ??= nativeAddonPath;

function asDaemonWorkspaceRegistry(registry: WorkspaceRegistry): NonNullable<DaemonRuntimeOptions["workspace_registry"]> {
  return registry as unknown as NonNullable<DaemonRuntimeOptions["workspace_registry"]>;
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

async function queryOneStream(client: DaemonClient, workspaceId: string, operation: string, args: Record<string, unknown>, streamName: string): Promise<ReadonlyArray<Record<string, unknown>>> {
  const streams = await queryStreams(client, workspaceId, operation, args);
  return (streams[streamName]?.items ?? []).map((item) => item.value as Record<string, unknown>);
}

async function pollUntilStructuralReady(client: DaemonClient, workspaceId: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const response = await client.call("core:index_status", { workspace_ids: [workspaceId] });
    if (response.outcome === "success") {
      const payload = response.payload as { readonly workspaces: ReadonlyArray<Record<string, unknown>> };
      last = payload.workspaces[0];
      if (last?.["structural_ready"] === true) return last;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Workspace ${workspaceId} did not reach structural_ready within ${timeoutMs}ms (last observed: ${JSON.stringify(last)}).`);
}

const FIXTURE_TEXT = `export function add(a: number, b: number): number {
  return a + b;
}

export class Widget {
  count = 0;
  describe(): string {
    return \`widget \${this.count}\`;
  }
}

const bad: number = "nope";

[1, 2].map((n) => n);
`;

async function seedFixtureWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-v4-inferred-types-e2e-workspace-"));
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "a.ts"), FIXTURE_TEXT, "utf8");
  return workspaceRoot;
}

const describeIfBuilt = hasReleaseArtifacts ? describe : describe.skip;

it.skipIf(hasReleaseArtifacts)("v4 inferred-types e2e is skipped: build the release artifacts first", () => {
  console.warn(
    `[urdira] tests/v4-inferred-types-e2e.test.ts skipped -- missing worker (${workerPath ?? "no host target"}) or native addon (${nativeAddonPath ?? "no host target"}). ` +
    "Build them with: node scripts/build-native.mjs",
  );
});

describeIfBuilt("v4 inferred types + compiler diagnostics e2e (real urdira-indexing-worker + native structural store)", () => {
  it("after the residual pass, find_records/expand_relations surface inferred types and a compiler diagnostic", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-v4-inferred-types-e2e-data-"));
    const workspaceRoot = await seedFixtureWorkspace();
    const originalV4Flag = process.env["URDIRA_V4"];
    const originalResidualFlag = process.env["URDIRA_V4_RESIDUAL"];
    let runtime: DaemonRuntime | undefined;
    const sessions = new Map<string, IndexingCoreProcessTransport>();
    try {
      process.env["URDIRA_V4"] = "1";
      process.env["URDIRA_V4_RESIDUAL"] = "1";
      runtime = await DaemonRuntime.start({
        data_root: dataRoot,
        engine_build_id: "build-v4-inferred-types-e2e",
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
        semantic_index: false,
        reconciliation_sweep_interval_ms: 0,
        scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
      });
      const client = new DaemonClient(runtime.endpoint, { request_timeout_ms: 120_000 });
      const added = await client.call("core:workspace_add", { args: [workspaceRoot], confirmed: true });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      await pollUntilStructuralReady(client, workspaceId);

      // --- Wait for the residual pass (background, outside the critical
      // path -- structural readiness above already settled without it). ---
      const upgradeDeadline = Date.now() + 60_000;
      let status: Record<string, unknown> | undefined;
      while (Date.now() < upgradeDeadline) {
        const response = await client.call("core:index_status", { workspace_ids: [workspaceId] });
        if (response.outcome === "success") {
          const payload = response.payload as { readonly workspaces: ReadonlyArray<Record<string, unknown>> };
          status = payload.workspaces[0];
          if (status?.["calls_upgraded"] === true) break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
      }
      expect(status?.["calls_upgraded"]).toBe(true);
      const semanticUpgrade = status?.["semantic_upgrade"] as { readonly completed_generation?: number; readonly running: boolean } | undefined;
      expect(semanticUpgrade?.completed_generation).toBeGreaterThan(1);
      expect(semanticUpgrade?.running).toBe(false);

      // --- `core:find_records` with a concrete `kind_selector.kinds` finds
      // the residual pass's own `jsts:entity_inferred_type` rows. ---
      const inferredTypeRecords = await queryOneStream(client, workspaceId, "core:find_records", { selector: { record_categories: ["entity"], kind_selector: { kinds: ["jsts:entity_inferred_type"] } } }, "records");
      expect(inferredTypeRecords.length).toBeGreaterThan(0);
      for (const record of inferredTypeRecords) {
        expect(record["kind"]).toBe("jsts:entity_inferred_type");
        const body = record["body"] as Record<string, unknown>;
        expect(body["kind"]).toBe("inferred_type");
        expect(typeof body["type"]).toBe("string");
        expect(typeof body["name"]).toBe("string");
      }

      // --- `core:expand_relations` outbound from the exported class
      // `Widget`, restricted to `jsts:relation_type_of`, reaches its own
      // inferred-type entity. ---
      const widgetDeclarations = await queryOneStream(client, workspaceId, "core:resolve_symbol", { reference: "Widget", resolution_scope: "exports" }, "declarations");
      expect(widgetDeclarations.length).toBeGreaterThan(0);
      const widgetEntityId = widgetDeclarations[0]!["entity_id"];
      expect(typeof widgetEntityId).toBe("string");

      // `relations: { relation_kinds: [...] }` is a FILTER on which edges the
      // traversal follows -- the "subjects" stream it returns already
      // consists only of entities reached via a `jsts:relation_type_of`
      // edge, each one THE inferred-type entity itself (`body.kind ===
      // "inferred_type"`, the same shape `core:find_records` above already
      // asserted).
      const expanded = await queryOneStream(client, workspaceId, "core:expand_relations", {
        subjects: [{ subject_type: "entity", entity_id: widgetEntityId }],
        direction: "outbound",
        relations: { universal_kinds: ["core:type_of"] },
      }, "subjects");
      expect(expanded.length).toBeGreaterThan(0);
      for (const reached of expanded) {
        expect(reached["kind"]).toBe("jsts:entity_inferred_type");
        const body = reached["body"] as Record<string, unknown>;
        expect(body["kind"]).toBe("inferred_type");
      }

      // --- `core:find_records` with `record_categories: ["diagnostic"]`
      // returns the fixture's deliberate `const bad: number = "nope"` TS2322
      // compiler diagnostic. ---
      const diagnosticRecords = await queryOneStream(client, workspaceId, "core:find_records", { selector: { record_categories: ["diagnostic"] } }, "records");
      expect(diagnosticRecords.length).toBeGreaterThan(0);
      const compilerDiagnostics = diagnosticRecords.filter((record) => record["kind"] === "jsts:diagnostic");
      expect(compilerDiagnostics.length).toBeGreaterThan(0);
      const ts2322 = compilerDiagnostics.filter((record) => (record["body"] as Record<string, unknown> | undefined)?.["compiler_code"] === 2322);
      expect(ts2322.length).toBeGreaterThan(0);
      for (const record of ts2322) {
        const body = record["body"] as Record<string, unknown>;
        expect(body["code"]).toBe("jsts:compiler_diagnostic");
        expect(typeof body["message"]).toBe("string");
      }
    } finally {
      if (originalV4Flag === undefined) delete process.env["URDIRA_V4"]; else process.env["URDIRA_V4"] = originalV4Flag;
      if (originalResidualFlag === undefined) delete process.env["URDIRA_V4_RESIDUAL"]; else process.env["URDIRA_V4_RESIDUAL"] = originalResidualFlag;
      await runtime?.stop().catch(() => undefined);
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
