import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { analyzeUrdiraPipelineContract } from "../release/benchmarks/expanded-agent-transcript-metrics.mjs";
import { writeUrdiraIsolatedShim } from "../release/benchmarks/urdira-isolated-shim.mjs";

const corpus = JSON.parse(readFileSync(resolve("release/benchmarks/expanded-typescript-agent-benchmark.json"), "utf8")) as {
  repositories: { id: string; tasks: { id: string }[] }[];
};
const rowsFor = (ids: string[]) => corpus.repositories.filter((repo) => ids.includes(repo.id)).flatMap((repo) => repo.tasks.map((task) => ({
  repository: repo.id, task: task.id, arm: "urdira-typescript", exit_code: 0,
  manifest: { completed_successfully: true },
})));
function probe(ids: string[], rows: ReturnType<typeof rowsFor>, failedRuns = 0) {
  const dir = mkdtempSync(join(tmpdir(), "expanded-smoke-test-"));
  try {
    const audit = join(dir, "audit.json");
    writeFileSync(audit, JSON.stringify({ runs: rows, failed_runs: failedRuns }));
    const result = spawnSync(process.execPath, [resolve("release/benchmarks/run-expanded-agent-benchmark.mjs"),
      "--samples", "3", "--arms", "urdira-typescript", "--repositories", ids.join(","),
      "--smoke-audit", audit, "--codex", process.execPath,
      "--repositories-root", join(dir, "missing-repositories"), "--output-dir", join(dir, "output"),
    ], { encoding: "utf8" });
    // Missing clones stop execution immediately after admission: no agent, indexing or benchmark is launched.
    expect(result.status).not.toBe(0);
    return result.stderr;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("expanded campaign smoke scope", () => {
  it("initializes host metrics before startup failures can be recorded", () => {
    const runner = readFileSync(resolve("release/benchmarks/expanded-agent-benchmark-runner.mjs"), "utf8");
    const hostMetricsDeclaration = runner.indexOf("let hostMetrics;");
    const hostEntry = runner.indexOf('if (argv.includes("--host")) await hostMain();');
    expect(hostMetricsDeclaration).toBeGreaterThanOrEqual(0);
    expect(hostEntry).toBeGreaterThanOrEqual(0);
    expect(hostMetricsDeclaration).toBeLessThan(hostEntry);
  });

  it("runs version without a daemon and fails runtime hooks closed without the cell socket", () => {
    const dir = mkdtempSync(join(tmpdir(), "expanded-shim-test-"));
    try {
      const shim = join(dir, "urdira");
      writeUrdiraIsolatedShim(shim, {
        node: process.execPath,
        cli: resolve("apps/urdira/dist/cli.js"),
        dataRoot: join(dir, "data"),
        worker: join(dir, "worker"),
        endpoint: join(dir, "data", "daemon.sock"),
      });
      const version = spawnSync(shim, ["--version"], { encoding: "utf8" });
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toBe("0.4.0");
      const hook = spawnSync(shim, ["agent", "hook", "--client", "codex", "--payload", "{}"], { encoding: "utf8" });
      expect(hook.status).toBe(78);
      expect(hook.stderr).toContain("daemon endpoint is unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const pipelineCall = (pattern: string) => ({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "urdira",
      tool: "urdira_query",
      status: "completed",
      arguments: {
        request: {
          query: {
            expression: {
              expression_type: "pipeline",
              stages: [
                { stage_id: "search", stage_type: "operation", operation: "core:search_text", arguments: { pattern } },
                { stage_id: "source", stage_type: "operation", operation: "core:get_source", arguments: {}, bindings: { subjects: { stage_id: "search", output: "subjects" } } },
              ],
            },
          },
        },
      },
    },
  });

  it("records data-dependent composition before and after edits", () => {
    const audited = analyzeUrdiraPipelineContract([
      pipelineCall("before"),
      { type: "item.completed", item: { type: "command_execution", command: "apply_patch" } },
      pipelineCall("after"),
    ]);
    expect(audited).toMatchObject({
      composition_shape_valid: true,
      composition_before_first_edit: true,
      pipeline_calls: 2,
      valid_dependency_calls: 2,
      valid_discovery_source_calls: 2,
    });
    expect(audited.composition_after_edit_calls).toBe(1);
  });

  it("records direct operations and context without treating them as composition", () => {
    const audited = analyzeUrdiraPipelineContract([
      { type: "item.completed", item: { type: "mcp_tool_call", server: "urdira", tool: "urdira_context", status: "completed", arguments: {} } },
      { type: "item.completed", item: { type: "mcp_tool_call", server: "urdira", tool: "urdira_query", status: "completed", arguments: { request: { query: { expression: { expression_type: "operation", operation: "core:search_text" } } } } } },
      { type: "item.completed", item: { type: "command_execution", command: "apply_patch" } },
    ]);
    expect(audited.composition_shape_valid).toBeNull();
    expect(audited.direct_operation_calls).toBe(1);
    expect(audited.pipeline_calls).toBe(0);
    expect(audited.recipe_calls).toBe(0);
  });

  it("records a malformed pipeline with independent discovery and source stages", () => {
    const call = pipelineCall("independent");
    const expression = call.item.arguments.request.query.expression;
    const sourceStage = expression.stages.at(1);
    if (sourceStage === undefined) throw new Error("pipeline fixture is missing its source stage");
    Reflect.deleteProperty(sourceStage, "bindings");
    const audited = analyzeUrdiraPipelineContract([call]);
    expect(audited.composition_shape_valid).toBe(false);
    expect(audited.valid_composition_calls).toBe(0);
    expect(audited.malformed_composition_calls).toBe(1);
    expect(audited.malformed_reasons).toContain("no_data_dependency");
    expect(audited.calls[0]?.reason).toBe("no_data_dependency");
  });

  it("keeps a bounded reconciliation sweep enabled and reports its cost", () => {
    const runner = readFileSync(resolve("release/benchmarks/expanded-agent-benchmark-runner.mjs"), "utf8");
    expect(runner).toMatch(/RECONCILIATION_SWEEP_INTERVAL_MS\s*=\s*0/u);
    expect(runner).toMatch(/reconciliation_sweep_interval_ms:\s*RECONCILIATION_SWEEP_INTERVAL_MS/u);
    expect(runner).toMatch(/core:reindex", \{ args: \[gateWorkspaceId\], values: \{ scope: "reconcile" \} \}/u);
    expect(runner).toMatch(/inter_turn_reconcile_requests/u);
  });

  it("keeps Urdira workspace isolation in the runner, without injecting a tool policy", () => {
    const runner = readFileSync(resolve("release/benchmarks/expanded-agent-benchmark-runner.mjs"), "utf8");
    expect(runner).toMatch(/gateWorkspaceId/u);
    expect(runner).toMatch(/scope: "reconcile"/u);
    expect(runner).not.toMatch(/assignedPolicy|benchmarkUrdiraGuardrail|generatedUrdiraInstructions/u);
  });

  it("inherits the production Urdira MCP server presentation", () => {
    const entry = readFileSync(resolve("release/benchmarks/expanded-urdira-mcp-entry.mjs"), "utf8");
    expect(entry).toMatch(/runUrdiraMcp\(\{\s*data_root: process\.env\.URDIRA_DATA_ROOT,\s*endpoint: process\.env\.URDIRA_ENDPOINT,\s*\}\)/u);
    expect(entry).not.toMatch(/tool_names|compact|instructions|MCP_BENCHMARK_INSTRUCTIONS/u);
    const mcp = readFileSync(resolve("packages/mcp/src/index.ts"), "utf8");
    for (const tool of ["urdira_query", "urdira_context", "urdira_index_status"]) {
      expect(mcp).toContain(`"${tool}"`);
    }
    expect(mcp).not.toMatch(/^\s*"urdira_(?:analyze_change|build_context)",$/mu);
  });

  it("uses the production Codex hook-first installer without a duplicate MCP catalog", () => {
    const runner = readFileSync(resolve("release/benchmarks/expanded-agent-benchmark-runner.mjs"), "utf8");
    expect(runner).toContain('const { installAgent } = await import("../../packages/cli/dist/agent-integration.js");');
    expect(runner).toContain('installAgent("codex", { dry_run: false, confirm: true, home: codexIntegrationHome, launcher: [urdiraShimPath] })');
    expect(runner).toContain('mkdtempSync(join("/tmp", "urdira-expanded-codex-home-"))');
    expect(runner).toContain('CODEX_HOME: join(codexIntegrationHome, ".codex")');
    expect(runner).toContain('const parentCodexHome = effectiveCodexHome()');
    expect(runner).toContain('resolveCodexAuthRoute({ parentCodexHome');
    expect(runner).toContain('auth_route: codexAuthRoute');
    expect(runner.indexOf("let codexIntegrationHome;")).toBeLessThan(runner.indexOf("const recordFailure"));
    expect(runner.indexOf("const cleanupCodexIntegration")).toBeLessThan(runner.indexOf("const recordFailure"));
    expect(runner).toContain('mcp: "hook-first-cli-continuations"');
    expect(runner).not.toContain('mcp_servers.urdira.env.URDIRA_ENDPOINT=${JSON.stringify(codexIntegration.endpoint)}');
    expect(runner).toContain('ignore_user_config: false');
    expect(runner).toContain('hook_trust: "dangerously-bypass-hook-trust"');
    const codexArgv = readFileSync(resolve("release/benchmarks/expanded-agent-codex-argv.mjs"), "utf8");
    expect(codexArgv).toContain('"--dangerously-bypass-hook-trust"');
    expect(runner).toContain('const urdiraShimPath = join(urdiraBinDir, "urdira")');
    expect(runner).toContain('writeUrdiraIsolatedShim(urdiraShimPath');
    const shim = readFileSync(resolve("release/benchmarks/urdira-isolated-shim.mjs"), "utf8");
    expect(shim).toContain('exec "$NODE" "$CLI" "$@"');
    expect(shim).toContain('if [ "\\${1:-}" = "--version" ]');
    expect(runner).toContain("validateInstalledUrdiraCli");
    expect(runner).toContain('cli_sha256: cliFingerprint');
    expect(runner).toContain('const urdiraEndpoint = join(effectiveDataRoot, "daemon.sock")');
    expect(runner).toContain('endpoint: urdiraEndpoint');
    expect(runner).toContain('PATH: `${codexIntegration.path_prepend}:${process.env.PATH ?? ""}`');
    expect(runner).toContain('const shellRuntimeProfile = join(codexIntegrationHome, ".zprofile")');
    expect(runner).toContain('export PATH=${JSON.stringify(urdiraBinDir)}:${JSON.stringify(dirname(nodeBin))}:$PATH');
    expect(runner).toContain('writeFileSync(shellRuntimeProfile');
    expect(runner).toContain('ZDOTDIR: codexIntegrationHome');
    expect(runner).toContain('shell_runtime_profile: shellRuntimeProfile');
    expect(runner).toContain('const isolatedShellRuntime = spawnSync("/bin/zsh", ["-lc", "node --version"]');
    expect(runner).toContain('isolated shell resolved');
    expect(runner).toContain('URDIRA_ENDPOINT: codexIntegration.endpoint');
    expect(shim).toContain('[ -S "$ENDPOINT" ]');
    expect(shim).toContain('export URDIRA_ENDPOINT="$ENDPOINT"');
    expect(runner).toContain('buildCodexExecArgs({ model, worktree');
    expect(runner).toContain('buildCodexResumeArgs({ model, worktree');
    expect(codexArgv).toContain('"--dangerously-bypass-approvals-and-sandbox"');
    expect(runner).toContain("cleanupCodexIntegration();");
    const promptSource = runner.slice(runner.indexOf("const initialInstruction"), runner.indexOf("let host;"));
    expect(promptSource).not.toMatch(/Use Urdira MCP|urdira_context|urdira_query|call urdira_index_status/u);
  });

  it("captures Codex timing in a sidecar without changing the transcript", () => {
    const runner = readFileSync(resolve("release/benchmarks/expanded-agent-benchmark-runner.mjs"), "utf8");
    expect(runner).toContain('import { createTimingCapture, summarizeTimingCaptures } from "./expanded-agent-timing.mjs";');
    expect(runner).toContain('invokeCodex("turn-1", codexArgs, initialInstruction)');
    expect(runner).toContain('invokeCodex("turn-2", resume, followUpInstruction)');
    expect(runner).toContain('invokeCodex("turn-3", resume, finalInstruction)');
    expect(runner).toContain("timingCapture?.ingest(chunk)");
    expect(runner).toContain("writeFileSync(transcript, first.stdout");
    expect(runner).toContain("appendFileSync(transcript, second.stdout");
    expect(runner).toMatch(/timing_sidecar: timingSidecar/u);
    const driver = readFileSync(resolve("release/benchmarks/run-expanded-agent-benchmark.mjs"), "utf8");
    expect(driver).toMatch(/expanded_agent_timing/u);
    expect(driver).toMatch(/indexing_worker:/u);
    expect(driver).toMatch(/native_addon:/u);
    expect(driver).toMatch(/plugin_dist:/u);
  });

  it("records composition and natural tool choice without a strategy gate", () => {
    const runner = readFileSync(resolve("release/benchmarks/expanded-agent-benchmark-runner.mjs"), "utf8");
    const promptSource = runner.slice(runner.indexOf("const initialInstruction"), runner.indexOf("let host;"));
    expect(promptSource).toMatch(/Use the repository tools and any configured integrations/u);
    expect(promptSource).not.toMatch(/Urdira|pipeline|assigned method/iu);
    expect(runner).not.toMatch(/Use only ordinary shell\/editor tools|Use codebase-memory MCP for discovery|Use CodeGraph MCP directly|pre-built tgrep index for repository discovery|assigned method/u);
    const grader = readFileSync(resolve("release/benchmarks/expanded-agent-benchmark-grader.mjs"), "utf8");
    expect(grader).toMatch(/compositionMetrics/u);
    expect(grader).toMatch(/const discoveryPass = !Object\.values\(unexpectedErrors\)\.some\(Boolean\)/u);
    expect(grader).not.toMatch(/const discoveryPass = transcriptMetrics\.assigned_discovery_before_edit/u);
    expect(grader).toMatch(/value\("--hook-audit"\)/u);
    expect(grader).toMatch(/analyzeExpandedTranscript\(transcript, arm, task, \{ hook_audit: hookAudit \}\)/u);
    expect(runner).toMatch(/"--hook-audit", hookAuditPath/u);
  });

  it("gates each selected arm with its own completed smoke audit", () => {
    const driver = readFileSync(resolve("release/benchmarks/run-expanded-agent-benchmark.mjs"), "utf8");
    expect(driver).toMatch(/--smoke-audits/u);
    expect(driver).toMatch(/smokeAudits\.get\(arm\)/u);
    expect(driver).toMatch(/entry\.arm \?\? entry\.manifest\?\.arm\) === arm/u);
  });

  it("keeps the runbook aligned with the five-arm matrix and per-arm smoke gate", () => {
    const runbook = readFileSync(resolve("docs/benchmarks/expanded-agent-campaign.md"), "utf8");
    expect(runbook).toMatch(/baseline.*urdira-typescript.*codebase-memory.*codegraph.*tgrep/su);
    expect(runbook).toMatch(/40 cells/u);
    expect(runbook).toMatch(/120 executions/u);
    expect(runbook).toMatch(/BENCH_TGREP/u);
    expect(runbook).toMatch(/--tgrep/u);
    expect(runbook).toMatch(/--smoke-audits/u);
    expect(runbook).toMatch(/each selected arm's smoke/u);
  });

  it("links the definitive selected benchmark handoff and preserves its execution contract", () => {
    const runbook = readFileSync(resolve("docs/benchmarks/expanded-agent-campaign.md"), "utf8");
    const handoff = readFileSync(resolve("docs/benchmarks/definitive-agent-benchmark-handoff.md"), "utf8");
    expect(runbook).toContain("definitive-agent-benchmark-handoff.md");
    expect(handoff).toContain("45 sequential runs");
    expect(handoff).toContain("three independent campaigns");
    expect(handoff).toContain("gpt-5.6-luna");
    expect(handoff).toContain("URDIRA_SEMANTIC_INDEX=0");
    expect(handoff).toContain("counts as Urdira");
    expect(handoff).toContain("Do not retry");
    expect(handoff).toContain("null");
    expect(handoff).toContain("Cold structural readiness");
    expect(handoff).toContain("Warm readiness");
    expect(handoff).toContain("release:acceptance");
    expect(handoff).toContain("Node `24.18.1` exactly");
    expect(handoff).toContain("18 readiness-only probes");
    expect(handoff).toContain("input USD 2/M");
    expect(handoff).toContain("cached input USD 2/M");
    expect(handoff).toContain("The top-level campaign driver cannot select one task");
    expect(handoff).toContain("expanded-agent-benchmark-runner.mjs");
    expect(handoff).toContain("affected-tests-deterministic");
    expect(handoff).toContain("wire-name-validation");
    expect(handoff).toContain("language-provider-registration-idempotence");
    expect(handoff).toContain("cleanup checkpoint");
    expect(handoff).toContain("one active checkout/index/data root");
    expect(handoff).toContain("finally");
    expect(handoff).toContain("df");
    expect(handoff).toContain("space-free threshold");
    expect(handoff).toContain("cleanup manifest");
    expect(handoff).toContain("block the next execution");
    expect(handoff).toContain("after each complete cell or before transfer to another worker");
    expect(handoff).toContain("three internal turns");
    expect(handoff).toContain("Phase 0");
    expect(handoff).toContain("only records cleanup booleans");
    expect(handoff).toContain("release archive binding");
    expect(handoff).toContain("must not start a model");
    expect(handoff).toContain("Final reporting and publication");
    expect(handoff).toContain("analyze-agent-matched.mjs");
    expect(handoff).toContain("render-expanded-agent-report.mjs");
    expect(handoff).toContain("repo/task/arm");
    expect(handoff).toContain("input/output/reasoning/cached");
    expect(handoff).toContain("TTFQ");
    expect(handoff).toContain("full context");
    expect(handoff).toContain("continuations");
    expect(handoff).toContain("null, never 0");
    expect(handoff).toContain("equal correction and coverage");
    expect(handoff).toContain("campaign is not complete");
    expect(handoff).toContain("definitive-agent-benchmark-results-2026-09-15.md");
    expect(handoff).toContain("git status --short");
    expect(handoff).toContain("empty");
  });

  it.each(["playwright", "prisma", "vscode"])("accepts the two-task smoke for %s", (id) => {
    expect(probe([id], rowsFor([id]))).toContain("Repository checkout is unavailable");
  });
  it("accepts selected repositories and a broader successful smoke", () => {
    expect(probe(["prisma", "vscode"], rowsFor(["prisma", "vscode"]))).toContain("Repository checkout is unavailable");
    expect(probe(["prisma"], rowsFor(corpus.repositories.map((repo) => repo.id)))).toContain("Repository checkout is unavailable");
  });
  it("rejects missing tasks, duplicate successes, and unrelated tasks", () => {
    const rows = rowsFor(["prisma"]);
    for (const invalid of [rows.slice(0, 1), [rows[0]!, rows[0]!], rowsFor(["playwright"])]) {
      expect(probe(["prisma"], invalid)).toContain("No selected arm has passed its smoke gate");
    }
  });
  it("rejects failed audits and failed selected executions", () => {
    expect(probe(["prisma"], rowsFor(["prisma"]), 1)).toContain("No selected arm has passed its smoke gate");
    const rows = rowsFor(["prisma"]);
    rows[0]!.exit_code = 1;
    expect(probe(["prisma"], rows)).toContain("No selected arm has passed its smoke gate");
  });
  it("still requires all tasks for the full corpus", () => {
    const ids = corpus.repositories.map((repo) => repo.id);
    expect(probe(ids, rowsFor(["prisma"]))).toContain("No selected arm has passed its smoke gate");
    expect(probe(ids, rowsFor(ids))).toContain("Repository checkout is unavailable");
  });
});
