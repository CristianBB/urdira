import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { analyzeUrdiraPipelineContract } from "../release/benchmarks/expanded-agent-transcript-metrics.mjs";

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
    expect(entry).toMatch(/runUrdiraMcp\(\{\s*data_root: process\.env\.URDIRA_DATA_ROOT,\s*\}\)/u);
    expect(entry).not.toMatch(/tool_names|compact|instructions|MCP_BENCHMARK_INSTRUCTIONS/u);
    const mcp = readFileSync(resolve("packages/mcp/src/index.ts"), "utf8");
    for (const tool of ["urdira_query", "urdira_context", "urdira_analyze_change", "urdira_build_context", "urdira_index_status"]) {
      expect(mcp).toContain(`"${tool}"`);
    }
  });

  it("captures Codex timing in a sidecar without changing the transcript", () => {
    const runner = readFileSync(resolve("release/benchmarks/expanded-agent-benchmark-runner.mjs"), "utf8");
    expect(runner).toContain('import { createTimingCapture, summarizeTimingCaptures } from "./expanded-agent-timing.mjs";');
    for (const turn of ["turn-1", "turn-2", "turn-3"]) expect(runner).toContain(`timing_label: "${turn}"`);
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
