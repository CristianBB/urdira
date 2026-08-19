#!/usr/bin/env node
/* global URL, setTimeout, clearTimeout, setInterval */
/*
 * Reproducible matched coding-agent benchmark for a frozen Excalidraw checkout.
 *
 * The runner intentionally keeps the agent protocol visible: two instructions
 * are sent to the same Codex session, and the second arrives only after the
 * first instruction has produced edits. Urdira cold runs start observation
 * immediately before the first instruction; warm runs wait for a published
 * snapshot before sending it.
 */
import { appendFileSync, createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
};
const has = (name) => argv.includes(name);
const arm = value("--arm");
const phase = value("--phase");
const sample = value("--sample", "1");
const worktree = value("--worktree", join(tmpdir(), `exca-bench-${arm}`));
const dataRoot = value("--data-root", join(tmpdir(), `urdira-matched-${arm}-${phase}-${sample}`));
const outputDir = value("--output-dir", join(root, "release/benchmarks/results"));
const commit = value("--commit", "c5a50d2");
const model = value("--model", "gpt-5.6-luna");
const debugTiming = has("--debug-timing");
const codex = value("--codex", "/Applications/ChatGPT.app/Contents/Resources/codex");
const nodeBin = value("--node", process.execPath);
const mcpEntry = value("--mcp-entry", join(root, "release/benchmarks/mcp-entry.mjs"));
// Progressive structural readiness is a sequence of three immutable
// publications. The 979-artifact matched fixture now completes in about
// 202 seconds on the acceptance runtime; keep a bounded 6-minute default so
// the gate measures completion rather than failing during the final stage.
const benchmarkTimeoutMs = Number(process.env.URDIRA_BENCHMARK_TIMEOUT_MS ?? "360000");
if (!Number.isSafeInteger(benchmarkTimeoutMs) || benchmarkTimeoutMs < 1_000) throw new Error("URDIRA_BENCHMARK_TIMEOUT_MS must be an integer of at least 1000ms.");
const urdiraArm = arm === "source-only" || arm === "structural";
if (!["baseline", "source-only", "structural"].includes(arm) || !["cold", "warm"].includes(phase)) {
  throw new Error("Usage: --arm baseline|source-only|structural --phase cold|warm [--sample N]");
}

mkdirSync(outputDir, { recursive: true });
const runId = `excalidraw-${arm}-${phase}-${sample}`;
const transcript = join(outputDir, `${runId}.jsonl`);
const manifestPath = join(outputDir, `${runId}.json`);
const hostLog = join(outputDir, `${runId}.host.log`);

if (has("--host")) {
  await hostMain();
}

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  if (options.input !== undefined) child.stdin.end(options.input); else child.stdin.end();
  child.on("error", reject);
  child.on("close", (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
});

const git = async (...args) => {
  const result = await run("git", args, { cwd: worktree });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
};

const resetFixture = async () => {
  await git("reset", "--hard", commit);
  await git("clean", "-fd");
};

const campaignInitialInstruction = `You are working in a frozen Excalidraw monorepo checkout at ${commit}. Complete the first phase of this coding task.

Add a small fixture at packages/excalidraw/tests/fixtures/agentRestoreMetadata.json for the restore-data tests. It must be a valid JSON object with kind "restore-metadata" and version 1, plus a non-empty source field equal to "import" or "local". Keep this first phase limited to the fixture; do not add the follow-up "draft" mode yet. Work only in the checkout. Do not install dependencies or run builds, typechecks, or tests. Keep the diff focused.

Repository discovery policy for this benchmark: ${urdiraArm ? `use Urdira MCP for discovery (${arm === "source-only" ? "source-only" : "structural"} arm). Call urdira_benchmark_discover exactly once with the explicit workspace root and path packages/excalidraw/tests/fixtures/agentRestoreMetadata.json. It returns the index status and uses the source snapshot for this source-safe artifact lookup whenever source_ready is true, including after structural publication; it falls back to the structural snapshot only for retained pre-source-first workspaces without a source snapshot. If it reports a retryable indexing error, do not poll or retry; record that result and continue with the exact path in this instruction. Treat the returned path/status as the discovery evidence: do not run grep, rg, find, file listing, or shell reads for this fixture; edit the known target directly.` : "use only baseline text tools: grep/rg, file listing, and bounded file reads. Do not use Urdira or any symbol service."}

When this phase is complete, summarize the edits briefly; do not make the follow-up changes until I send the next instruction.`;

const campaignFollowUp = `Follow-up instruction after your first-phase edits: the checkout has now changed, so verify that your repository-reading method sees the modified files rather than relying on pre-edit context. ${urdiraArm ? "Call urdira_benchmark_discover exactly once with the explicit workspace root and path packages/excalidraw/tests/fixtures/agentRestoreMetadata.json. If it reports a retryable indexing error, do not poll or retry; record that result and use the returned status/path as the freshness evidence; do not run shell discovery or read the fixture." : "Use rg/grep on the changed file and a bounded read to re-discover the relevant content."}

Now complete the remaining task: update the fixture so source "draft" is accepted and add a mode field equal to "follow-up", while preserving valid JSON and the existing kind/version contract. Do not install dependencies or run builds, typechecks, or tests. Leave the working tree uncommitted and print every changed file with a one-line summary.`;
const setupStartMs = Date.now();
await resetFixture();

let host;
if (urdiraArm) {
  const hostScript = fileURLToPath(import.meta.url);
  host = spawn(nodeBin, [hostScript, "--host", "--arm", arm, "--phase", phase, "--worktree", worktree, "--data-root", dataRoot], {
    cwd: root,
    // Keep the analysis-worker pool enabled. Cold startup still measures the
    // first worker build, while the follow-up instruction can reuse the
    // worker's per-file TypeScript session and exercise true edit freshness.
    env: { ...process.env, URDIRA_DATA_ROOT: dataRoot, URDIRA_SEMANTIC_INDEX: "0", ...(debugTiming ? { URDIRA_DEBUG_TIMING: "1", URDIRA_STORAGE_DEBUG_TIMING: "1" } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const hostReady = new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for Urdira benchmark host after ${benchmarkTimeoutMs}ms.`)), benchmarkTimeoutMs);
    host.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes("BENCH_HOST_READY")) { clearTimeout(timer); resolve(); }
    });
    host.on("error", reject);
    host.on("close", (code) => {
      if (code !== 0) { clearTimeout(timer); reject(new Error(`Urdira benchmark host exited before readiness (${code}). See ${hostLog}`)); }
    });
  });
  host.stderr.pipe(createWriteStream(hostLog));
  await hostReady;
}

const codexArgs = ["-m", model, "-s", "danger-full-access", "-a", "never", "exec", "--json", "--ignore-user-config", "--skip-git-repo-check", "-C", worktree];
const appendCodexMcpConfig = (args) => {
  if (urdiraArm) args.push(
    "-c", `mcp_servers.urdira.command=${JSON.stringify(nodeBin)}`,
    "-c", `mcp_servers.urdira.args=[${JSON.stringify(mcpEntry)}]`,
    "-c", `mcp_servers.urdira.env.URDIRA_DATA_ROOT=${JSON.stringify(dataRoot)}`,
    "-c", "mcp_servers.urdira.startup_timeout_sec=120",
    "-c", "mcp_servers.urdira.tool_timeout_sec=180",
  );
};
appendCodexMcpConfig(codexArgs);

const stopHost = async () => {
  if (!host) return;
  const currentHost = host;
  host = undefined;
  const closed = new Promise((resolve) => currentHost.once("close", resolve));
  currentHost.kill("SIGTERM");
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  // Indexing is deliberately allowed to outlive the agent only until the
  // bounded teardown window. Do not make benchmark elapsed time depend on a
  // daemon shutdown that is unrelated to the agent's completed response.
  if (currentHost.exitCode === null && currentHost.signalCode === null) {
    currentHost.kill("SIGKILL");
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
};

const firstInstructionMs = Date.now();
const first = await run(codex, [...codexArgs, "-"], { cwd: worktree, input: campaignInitialInstruction });
writeFileSync(transcript, first.stdout, "utf8");
if (first.code !== 0) {
  await stopHost();
  throw new Error(`Initial Codex phase failed (${first.code}): ${first.stderr}`);
}
const firstEvents = first.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const sessionId = firstEvents.find((event) => event.type === "thread.started")?.thread_id;
if (!sessionId) {
  await stopHost();
  throw new Error("Codex transcript did not expose a resumable session id.");
}

// Resume must receive the same model, working directory, and MCP settings as
// the initial exec. Without these global/config arguments Codex can select a
// different model and the resumed session loses the Urdira server entirely,
// making the second, freshness-sensitive instruction an invalid comparison.
const resumeArgs = ["-m", model, "-s", "danger-full-access", "-a", "never", "-C", worktree];
appendCodexMcpConfig(resumeArgs);
resumeArgs.push("exec", "resume", sessionId, "--json", "--ignore-user-config", "--skip-git-repo-check");
let agentFinishedMs;
try {
  const second = await run(codex, [...resumeArgs, "-"], { cwd: worktree, input: campaignFollowUp });
  appendFileSync(transcript, second.stdout, "utf8");
  if (second.code !== 0) throw new Error(`Follow-up Codex phase failed (${second.code}): ${second.stderr}`);
  agentFinishedMs = Date.now();
} finally {
  await stopHost();
}
const endMs = agentFinishedMs ?? Date.now();
const changedFiles = [...new Set([
  ...(await gitList("diff", "--name-only")).filter(Boolean),
  ...(await gitList("status", "--short", "--untracked-files=all")).filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean),
])].sort();
let finalFixture;
try { finalFixture = JSON.parse(readFileSync(join(worktree, "packages/excalidraw/tests/fixtures/agentRestoreMetadata.json"), "utf8")); } catch { finalFixture = undefined; }
const correctness = finalFixture?.kind === "restore-metadata" && finalFixture?.version === 1 && finalFixture?.source === "draft" && finalFixture?.mode === "follow-up" && changedFiles.length === 1 && changedFiles[0] === "packages/excalidraw/tests/fixtures/agentRestoreMetadata.json";
if (!correctness) throw new Error(`Benchmark fixture validation failed: ${JSON.stringify({ changed_files: changedFiles, fixture: finalFixture })}`);
const manifest = { run_id: runId, arm, phase, sample: Number(sample), model, commit, worktree, data_root: urdiraArm ? dataRoot : undefined, transcript, host_log: urdiraArm ? hostLog : undefined, setup_started_at: new Date(setupStartMs).toISOString(), first_instruction_sent_at: new Date(firstInstructionMs).toISOString(), finished_at: new Date(endMs).toISOString(), setup_elapsed_ms: firstInstructionMs - setupStartMs, elapsed_ms_from_first_instruction: endMs - firstInstructionMs, first_instruction_protocol: "codex_exec", follow_up_protocol: "codex_exec_resume", exit_code: 0, correctness: { final_json: true, expected_discovery_policy: arm, freshness_evidence_required: urdiraArm } };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest));

async function gitList(...args) {
  const result = await run("git", args, { cwd: worktree });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim().split("\n");
}

async function hostMain() {
  // Keep direct `--host` invocations and the parent runner on the same
  // storage root. The parent supplies this through the environment, while a
  // direct host command only has the CLI flag available.
  process.env.URDIRA_DATA_ROOT = dataRoot;
  const { defaultDaemonOptions } = await import("../../apps/urdira/dist/index.js");
  const { DaemonRuntime, DaemonClient } = await import("../../packages/daemon/dist/index.js");
  // This campaign isolates structural readiness and edit reconciliation. The
  // public product keeps semantic indexing optional, so disabling it here
  // avoids charging a model-pack download/inference lane to the cold-start
  // comparison.
  const runtimeOptions = { ...(await defaultDaemonOptions()), semantic_index: false, semantic_descriptor: undefined };
  const runtime = await DaemonRuntime.start(runtimeOptions);
  const client = new DaemonClient(runtime.endpoint, { request_timeout_ms: benchmarkTimeoutMs });
  const registration = await client.call("core:workspace_add", { args: [worktree], confirmed: true, selected_technology_ids: arm === "structural" ? ["javascript", "next", "react", "typescript"] : [], selected_plugin_ids: arm === "structural" ? ["urdira:javascript_typescript"] : [] });
  if (registration.outcome !== "success") throw new Error(`workspace registration failed: ${JSON.stringify(registration)}`);
  if (phase === "warm") {
    const deadline = Date.now() + benchmarkTimeoutMs;
    let current = false;
    while (Date.now() < deadline) {
      const status = await client.call("core:index_status", { api_version: 3, workspace_ids: [] });
      const workspace = status.payload?.workspaces?.find((entry) => entry.display_root === worktree.split("/").at(-1));
      const ready = arm === "source-only" ? workspace?.source_ready === true : workspace?.structural_ready === true;
      const freshnessReady = arm === "source-only"
        ? workspace?.freshness_status === "current" || workspace?.freshness_status === "equivalent" || workspace?.freshness_status === "indexing"
        : workspace?.freshness_status === "current" || workspace?.freshness_status === "equivalent";
      if (ready && freshnessReady) { current = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!current) throw new Error("Timed out waiting for a current warm Urdira index.");
  }
  process.stdout.write(`BENCH_HOST_READY ${JSON.stringify({ phase, workspace: worktree })}\n`);
  const stop = async () => { await runtime.stop({ force: false }); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}
