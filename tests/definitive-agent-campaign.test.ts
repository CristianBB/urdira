import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { DEFINITIVE_ARMS, DEFINITIVE_CELLS, DEFINITIVE_READINESS_PHASES, buildCellManifest, buildReadinessManifest, effectiveProcessOwner, isProcessInventoryProbe, retainableCellFailure, runCommand, runDefinitiveCells, stopOwnedProcesses } from "../release/benchmarks/run-definitive-agent-campaign.mjs";
import { blockedWarmProbe, buildReadinessQuery, executeReadinessPair, runReadinessCampaign, runReadinessPhase } from "../release/benchmarks/run-definitive-readiness-probes.mjs";
import { assembleDefinitiveAudit } from "../release/benchmarks/assemble-definitive-agent-audit.mjs";
import { buildCodexExecArgs, buildCodexMcpArgs, buildCodexResumeArgs, effectiveCodexHome, resolveCodexAuthRoute, validateCodexArgv } from "../release/benchmarks/expanded-agent-codex-argv.mjs";
import { validateInstalledUrdiraCli } from "../release/benchmarks/urdira-installed-cli-preflight.mjs";

const roots: string[] = [];
const PINNED_CODEX_BINARY = process.env["URDIRA_CODEX_BINARY"] ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
const hasPinnedCodexBinary = existsSync(PINNED_CODEX_BINARY);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("definitive direct campaign orchestrator", () => {
  it("requires a common effective CODEX_HOME auth route without reading auth contents", () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-codex-auth-route-regression-"));
    roots.push(root);
    const parentHome = join(root, "parent-codex");
    const isolatedHome = join(root, "isolated-codex");
    mkdirSync(parentHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(parentHome, "auth.json"), "synthetic-auth-metadata-only", { mode: 0o600 });
    const route = resolveCodexAuthRoute({ parentCodexHome: parentHome, isolatedCodexHome: isolatedHome });
    expect(route).toMatchObject({ ok: true, route: "symlink", parent_codex_home: parentHome, isolated_codex_home: isolatedHome });
    expect(route.source_mode).toBe(0o600);
    expect(route.source_bytes).toBeGreaterThan(0);
    expect(readlinkSync(join(isolatedHome, "auth.json"))).toBe(join(parentHome, "auth.json"));
    const missing = resolveCodexAuthRoute({ parentCodexHome: join(root, "missing-parent"), isolatedCodexHome: join(root, "missing-isolated") });
    expect(missing).toMatchObject({ ok: false, failure: "missing-auth" });
    expect(effectiveCodexHome({ env: { CODEX_HOME: parentHome }, home: join(root, "unused-home") })).toBe(parentHome);
    writeFileSync(join(parentHome, "auth.json"), "", { mode: 0o600 });
    expect(resolveCodexAuthRoute({ parentCodexHome: parentHome, isolatedCodexHome: join(root, "empty-isolated") })).toMatchObject({ ok: false, failure: "empty-auth" });
    writeFileSync(join(parentHome, "auth.json"), "synthetic-auth-metadata-only", { mode: 0o600 });
    chmodSync(join(parentHome, "auth.json"), 0o644);
    expect(resolveCodexAuthRoute({ parentCodexHome: parentHome, isolatedCodexHome: join(root, "permissive-isolated") })).toMatchObject({ ok: true, route: "symlink", source_mode: 0o644, source_bytes: expect.any(Number) });
  });

  it.skipIf(!hasPinnedCodexBinary)("validates the exact production Codex first/resume argv without starting a task", () => {
    const first = buildCodexExecArgs({ model: "gpt-5.6-luna", worktree: "/tmp", integrated: false });
    const resume = buildCodexResumeArgs({ model: "gpt-5.6-luna", worktree: "/tmp", sessionId: "session-placeholder", integrated: false });
    expect(first).toEqual(["-m", "gpt-5.6-luna", "--dangerously-bypass-approvals-and-sandbox", "exec", "--json", "--skip-git-repo-check", "-C", "/tmp", "--ignore-user-config"]);
    expect(resume).toEqual(["-m", "gpt-5.6-luna", "--dangerously-bypass-approvals-and-sandbox", "-C", "/tmp", "exec", "resume", "session-placeholder", "--json", "--ignore-user-config", "--skip-git-repo-check"]);
    expect(buildCodexMcpArgs({ arm: "codegraph", codegraph: "/bin/echo", benchmarkTimeoutMs: 900_000 })).toEqual(["-c", "mcp_servers.codegraph.command=\"/bin/echo\"", "-c", "mcp_servers.codegraph.args=[\"serve\",\"--mcp\"]", "-c", "mcp_servers.codegraph.startup_timeout_sec=120", "-c", "mcp_servers.codegraph.tool_timeout_sec=900"]);
    const diagnostic = validateCodexArgv({ codex: PINNED_CODEX_BINARY, model: "gpt-5.6-luna", worktree: "/tmp", integrated: false });
    expect(diagnostic.ok).toBe(true);
    expect(diagnostic.first.args).toEqual(first.concat("--help"));
    expect(diagnostic.resume.args).toEqual(resume.concat("--help"));
    expect(diagnostic.binary_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.skipIf(!hasPinnedCodexBinary)("uses approval and sandbox flags admitted by the pinned Codex exec/resume help", () => {
    const codex = PINNED_CODEX_BINARY;
    const approval = "--dangerously-bypass-approvals-and-sandbox";
    const execHelp = spawnSync(codex, ["-m", "gpt-5.6-luna", approval, "exec", "--json", "--skip-git-repo-check", "-C", "/tmp", "--ignore-user-config", "--help"], { encoding: "utf8" });
    const resumeHelp = spawnSync(codex, ["-m", "gpt-5.6-luna", approval, "-C", "/tmp", "exec", "resume", "session-placeholder", "--json", "--ignore-user-config", "--skip-git-repo-check", "--help"], { encoding: "utf8" });
    expect(execHelp.status).toBe(0);
    expect(resumeHelp.status).toBe(0);
    expect(execHelp.stdout).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(resumeHelp.stdout).toContain("--dangerously-bypass-approvals-and-sandbox");
    const integratedExecHelp = spawnSync(codex, ["-m", "gpt-5.6-luna", approval, "exec", "--json", "--skip-git-repo-check", "-C", "/tmp", "--dangerously-bypass-hook-trust", "-c", "mcp_servers.codegraph.command=\"/bin/echo\"", "--help"], { encoding: "utf8" });
    const integratedResumeHelp = spawnSync(codex, ["-m", "gpt-5.6-luna", approval, "-C", "/tmp", "exec", "resume", "session-placeholder", "--json", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "-c", "mcp_servers.codegraph.command=\"/bin/echo\"", "--help"], { encoding: "utf8" });
    expect(integratedExecHelp.status).toBe(0);
    expect(integratedResumeHelp.status).toBe(0);
    expect(readFileSync(resolve("release/benchmarks/expanded-agent-benchmark-runner.mjs"), "utf8")).not.toMatch(/"-a", "never"/u);
  });

  it("uses the supervisor's effective ps user for ownership verification", () => {
    const table = [
      { pid: 100, ppid: 1, pgid: 100, user: "root", command: "node supervisor" },
      { pid: 101, ppid: 100, pgid: 100, user: "root", command: "node cell" },
    ];
    expect(effectiveProcessOwner(table, 100, "Cristian")).toBe("root");
    expect(effectiveProcessOwner(table, 100, "Cristian")).not.toBe("Cristian");
  });

  it("does not classify the process inventory probe as a cell process", () => {
    expect(isProcessInventoryProbe("ps -axo pid=,ppid=,pgid=,user=,command=")).toBe(true);
    expect(isProcessInventoryProbe("node /tmp/cell-worker.mjs")).toBe(false);
  });

  it("never terminates a process without verified ownership and ancestry", async () => {
    const terminated: number[] = [];
    const entries = [
      { pid: 11, owner_verified: true, parent_chain_verified: true, owned_by_cell: true },
      { pid: 12, owner_verified: true, parent_chain_verified: false, owned_by_cell: false },
      { pid: 13, owner_verified: false, parent_chain_verified: true, owned_by_cell: false },
    ];
    const result = await stopOwnedProcesses(["/cell"], { inventory: () => entries, terminate: (pid: number) => { terminated.push(pid); }, wait: async () => {} });
    expect(terminated).toEqual([11]);
    expect(result.unverified_processes.map((entry) => entry["pid"])).toEqual([12, 13]);
  });

  it("materializes exactly 15 immutable direct-run cells for one campaign", () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-definitive-plan-"));
    roots.push(root);
    const plan = buildCellManifest({ campaign: 2, outputRoot: root, worktreeRoot: join(root, "worktrees"), dataRoot: join(root, "data"), runRoot: join(root, "runs"), repositoriesRoot: join(root, "repos") });
    expect(plan.cells).toHaveLength(15);
    expect(plan.cells.map((entry) => entry.run_id)).toHaveLength(new Set(plan.cells.map((entry) => entry.run_id)).size);
    expect(new Set(plan.cells.map((entry) => entry.arm))).toEqual(new Set(DEFINITIVE_ARMS));
    expect(new Set(plan.cells.map((entry) => `${entry.repository_id}/${entry.task_id}`))).toEqual(new Set(DEFINITIVE_CELLS.map(([repository, task]) => `${repository}/${task}`)));
    expect(plan.cells.every((entry) => entry.campaign === 2 && entry.phase === "warm")).toBe(true);
    expect(plan.cells.every((entry) => entry.worktree !== entry.data_root && entry.data_root !== entry.output_root)).toBe(true);
  });

  it("writes a plan without invoking a model", () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-definitive-plan-"));
    roots.push(root);
    const result = spawnSync(process.execPath, [resolve("release/benchmarks/run-definitive-agent-campaign.mjs"), "--campaign", "1", "--output-root", root, "--plan-only"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ cells: 15, model_invoked: false });
    const manifest = join(root, "cell-manifest.json");
    expect(existsSync(manifest)).toBe(true);
    expect(JSON.parse(readFileSync(manifest, "utf8")).cells).toHaveLength(15);
  });

  it("materializes six cold/warm readiness probes per campaign", () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-definitive-plan-"));
    roots.push(root);
    const readiness = buildReadinessManifest({ campaign: 3, outputRoot: root, dataRoot: join(root, "data"), runRoot: join(root, "runs"), repositoriesRoot: join(root, "repos") });
    expect(readiness.probes).toHaveLength(6);
    expect(new Set(readiness.probes.map((probe) => probe.phase))).toEqual(new Set(DEFINITIVE_READINESS_PHASES));
    expect(readiness.probes.every((probe) => probe.model_invoked === false && probe.passed === null)).toBe(true);
    expect(readiness.probes.every((probe) => Object.values(probe.timestamps).every((value) => value === null))).toBe(true);
  });

  it("uses one compact cold/warm pair root for readiness paths", () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-definitive-readiness-paths-"));
    roots.push(root);
    const dataRoot = join(root, "data");
    const runRoot = join(root, "runs");
    const readiness = buildReadinessManifest({ campaign: 1, outputRoot: root, dataRoot, runRoot, repositoriesRoot: join(root, "repos") });
    for (const probe of readiness.probes) {
      const pair = `${probe.repository_id}-1`;
      expect(probe["data_root"]).toBe(join(dataRoot, pair));
      expect(probe["output_root"]).toBe(join(runRoot, pair));
    }
    expect(new Set(readiness.probes.map((probe) => probe["data_root"])).size).toBe(3);
    expect(new Set(readiness.probes.map((probe) => probe["output_root"])).size).toBe(3);
  });

  it("builds an explicit scoped structural query for the no-model probe", () => {
    const request = buildReadinessQuery("workspace:probe");
    expect(request.request_type).toBe("query");
    expect(request.query.scope).toEqual({ scope_type: "single_workspace", workspace_id: "workspace:probe" });
    expect(request.query.expression).toMatchObject({ expression_type: "operation", operation: "core:search_text" });
    expect(request.query.options.freshness).toBe("current");
  });

  it("preserves a failed cold probe and blocks warm without retrying", () => {
    const warm = blockedWarmProbe({ workspace_id: "workspace:cold", failure: "structural readiness timeout" });
    expect(warm).toMatchObject({ workspace_id: "workspace:cold", passed: false, failure: expect.stringContaining("structural readiness timeout") });
    expect(Object.values(warm.timestamps).every((value) => value === null)).toBe(true);
  });

  it("assembles exactly three selected-15 audits and 18 readiness probes", () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-definitive-aggregate-"));
    roots.push(root);
    const auditPaths = [];
    const readinessPaths = [];
    for (const campaign of [1, 2, 3]) {
      const plan = buildCellManifest({ campaign, worktreeRoot: join(root, "worktrees"), dataRoot: join(root, "data"), runRoot: join(root, "runs"), repositoriesRoot: join(root, "repos") });
      const runs = plan.cells.map((cell) => {
        const transcript = join(root, `${cell.run_id}.jsonl`);
        writeFileSync(transcript, "{}\n");
        return { ...cell, manifest: { ...cell, arm: cell.arm, protocol: "definitive-selected-v1", phase: "warm", model: "gpt-5.6-luna", node: "v24.18.1", prompt_sha256: cell.prompt_sha256, model_invoked: true, release_binding: { status: "passed", archive: { sha256: "a".repeat(64) } }, transcript, exit_code: 0, grader_exit_code: 0, completed_successfully: true } };
      });
      const auditPath = join(root, `audit-${campaign}.json`);
      writeFileSync(auditPath, JSON.stringify({ definitive_protocol: "selected-15", campaign, expected_runs: 15, minimum_free_bytes: 53687091200, release_binding: { status: "passed", archive: { sha256: "a".repeat(64) } }, runs }));
      auditPaths.push(auditPath);
      const readiness = buildReadinessManifest({ campaign, dataRoot: join(root, "data"), runRoot: join(root, "runs"), repositoriesRoot: join(root, "repos") });
      readiness.release_binding = { status: "passed", archive: { sha256: "a".repeat(64) } };
      const readinessPath = join(root, `readiness-${campaign}.json`);
      writeFileSync(readinessPath, JSON.stringify(readiness));
      readinessPaths.push(readinessPath);
    }
    const output = assembleDefinitiveAudit({ campaignAuditPaths: auditPaths, readinessManifestPaths: readinessPaths, outputPath: join(root, "selected-45.json") });
    expect(output).toMatchObject({ definitive_protocol: "selected-45", expected_runs: 45, readiness_expected_probes: 18 });
    expect(output.runs).toHaveLength(45);
    expect(output.readiness_probes).toHaveLength(18);
  });

  it("rejects duplicate campaign cell identities before writing output", () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-definitive-aggregate-"));
    roots.push(root);
    const auditPaths = [1, 2, 3].map((campaign) => {
      const plan = buildCellManifest({ campaign, worktreeRoot: join(root, "worktrees"), dataRoot: join(root, "data"), runRoot: join(root, "runs"), repositoriesRoot: join(root, "repos") });
      const runs = plan.cells.map((cell) => ({ ...cell, manifest: { ...cell, protocol: "definitive-selected-v1", phase: "warm", model: "gpt-5.6-luna", node: "v24.18.1", prompt_sha256: cell.prompt_sha256, model_invoked: true, release_binding: { status: "passed", archive: { sha256: "a".repeat(64) } }, transcript: null, exit_code: 1, grader_exit_code: 1, completed_successfully: false } }));
      const path = join(root, `audit-${campaign}.json`);
      writeFileSync(path, JSON.stringify({ definitive_protocol: "selected-15", campaign, expected_runs: 15, minimum_free_bytes: 53687091200, runs, release_binding: { status: "passed", archive: { sha256: "a".repeat(64) } } }));
      return path;
    });
    const duplicateAudit = readFileSync(auditPaths[0]!, "utf8");
    const duplicateParsed = JSON.parse(duplicateAudit);
    duplicateParsed.runs[1] = duplicateParsed.runs[0];
    writeFileSync(auditPaths[0]!, JSON.stringify(duplicateParsed));
    const readinessPaths = [1, 2, 3].map((campaign) => { const path = join(root, `readiness-${campaign}.json`); const manifest = buildReadinessManifest({ campaign, dataRoot: join(root, "data"), runRoot: join(root, "runs"), repositoriesRoot: join(root, "repos") }); manifest.release_binding = { status: "passed", archive: { sha256: "a".repeat(64) } }; writeFileSync(path, JSON.stringify(manifest)); return path; });
    expect(() => assembleDefinitiveAudit({ campaignAuditPaths: auditPaths, readinessManifestPaths: readinessPaths, outputPath: join(root, "selected-45.json") })).toThrow(/duplicate definitive cell|completeness mismatch/iu);
  });

  it("terminates a hung cell command and records timeout without retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-command-timeout-"));
    roots.push(root);
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('before timeout\\n'); process.stderr.write('timeout diagnostic\\n'); setTimeout(() => {}, 60_000)"], { timeoutMs: 50, stdoutPath: join(root, "stdout.log"), stderrPath: join(root, "stderr.log") });
    expect(result.timed_out).toBe(true);
    expect(result.code).not.toBe(0);
    expect(readFileSync(join(root, "stdout.log"), "utf8")).toBe("before timeout\n");
    expect(readFileSync(join(root, "stderr.log"), "utf8")).toBe("timeout diagnostic\n");
    expect(result.stdout_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.stderr_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("retains command output when the child exits by signal", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-command-signal-"));
    roots.push(root);
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('before signal\\n'); process.stderr.write('signal diagnostic\\n'); process.kill(process.pid, 'SIGTERM')"], { timeoutMs: 1_000, stdoutPath: join(root, "stdout.log"), stderrPath: join(root, "stderr.log") });
    expect(result.signal).toBe("SIGTERM");
    expect(readFileSync(join(root, "stdout.log"), "utf8")).toBe("before signal\n");
    expect(readFileSync(join(root, "stderr.log"), "utf8")).toBe("signal diagnostic\n");
    expect(result.stdout_bytes).toBeGreaterThan(0);
    expect(result.stderr_bytes).toBeGreaterThan(0);
  });

  it("durably retains internal Codex stderr when the first invocation fails before JSONL", () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-codex-capture-regression-"));
    roots.push(root);
    const repository = join(root, "repository");
    mkdirSync(join(repository, "packages/playwright/src/transform"), { recursive: true });
    mkdirSync(join(repository, "tests"), { recursive: true });
    writeFileSync(join(repository, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    writeFileSync(join(repository, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" } } }));
    writeFileSync(join(repository, "packages/playwright/src/transform/compilationCache.ts"), "export const affectedTestFiles = (items: string[]) => [...items].sort();\n");
    writeFileSync(join(repository, "tests/focused.test.ts"), "export {};\n");
    const git = (args: string[]) => spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
    expect(git(["init", "-q"]).status).toBe(0);
    expect(git(["add", "."]).status).toBe(0);
    expect(spawnSync("git", ["-C", repository, "-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", "commit", "-qm", "fixture"], { encoding: "utf8" }).status).toBe(0);
    const commit = spawnSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const codex = join(root, "codex");
    writeFileSync(codex, "#!/bin/sh\nprintf '{not-json}\\n'\necho 'synthetic Codex stderr' >&2\nexit 0\n");
    chmodSync(codex, 0o755);
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHome, "auth.json"), "synthetic-auth", { mode: 0o600 });
    const output = join(root, "output");
    const result = spawnSync(process.execPath, [resolve("release/benchmarks/expanded-agent-benchmark-runner.mjs"), "--definitive", "--repository-id", "playwright", "--task-id", "affected-tests-deterministic", "--arm", "baseline", "--sample", "1", "--model", "gpt-5.6-luna", "--node", process.execPath, "--codex", codex, "--commit", commit, "--worktree", repository, "--output-dir", output], { encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome } });
    expect(result.status).toBe(1);
    const runId = "playwright-affected-tests-deterministic-baseline-1";
    const manifest = JSON.parse(readFileSync(join(output, `${runId}.json`), "utf8"));
    expect(manifest.model_invoked, JSON.stringify(manifest)).toBe(true);
    expect(manifest.codex_invocations[0]).toMatchObject({ label: "turn-1", code: 0 });
    expect(manifest.transcript).toMatch(/\.jsonl$/u);
    expect(readFileSync(manifest.codex_invocations[0].stderr_path, "utf8")).toContain("synthetic Codex stderr");
  });

  it("fails closed when an internal Codex spool cannot be written", () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-codex-spool-capture-regression-"));
    roots.push(root);
    const repository = join(root, "repository");
    mkdirSync(join(repository, "packages/playwright/src/transform"), { recursive: true });
    mkdirSync(join(repository, "tests"), { recursive: true });
    writeFileSync(join(repository, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    writeFileSync(join(repository, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" } } }));
    writeFileSync(join(repository, "packages/playwright/src/transform/compilationCache.ts"), "export const affectedTestFiles = (items: string[]) => [...items].sort();\n");
    writeFileSync(join(repository, "tests/focused.test.ts"), "export {};\n");
    const git = (args: string[]) => spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
    expect(git(["init", "-q"]).status).toBe(0);
    expect(git(["add", "."]).status).toBe(0);
    expect(spawnSync("git", ["-C", repository, "-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", "commit", "-qm", "fixture"], { encoding: "utf8" }).status).toBe(0);
    const commit = spawnSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const codex = join(root, "codex");
    writeFileSync(codex, "#!/bin/sh\nprintf '{\"type\":\"thread.started\",\"thread_id\":\"synthetic\"}\\n'\nexit 0\n");
    chmodSync(codex, 0o755);
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHome, "auth.json"), "synthetic-auth", { mode: 0o600 });
    const output = join(root, "output");
    mkdirSync(join(output, "playwright-affected-tests-deterministic-baseline-1.turn-1.stdout.log"), { recursive: true });
    const result = spawnSync(process.execPath, [resolve("release/benchmarks/expanded-agent-benchmark-runner.mjs"), "--definitive", "--repository-id", "playwright", "--task-id", "affected-tests-deterministic", "--arm", "baseline", "--sample", "1", "--model", "gpt-5.6-luna", "--node", process.execPath, "--codex", codex, "--commit", commit, "--worktree", repository, "--output-dir", output], { encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome } });
    expect(result.status).toBe(1);
    const runId = "playwright-affected-tests-deterministic-baseline-1";
    const manifest = JSON.parse(readFileSync(join(output, `${runId}.json`), "utf8"));
    expect(manifest.model_invoked, JSON.stringify(manifest)).toBe(true);
    expect(manifest.codex_invocations).toHaveLength(1);
    expect(manifest.codex_invocations[0].capture_error).toMatch(/EISDIR|is a directory/u);
    expect(manifest.error).toMatch(/Codex output capture failed/u);
  });

  it("validates an installed Urdira CLI parser without starting its daemon", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-cli-preflight-regression-"));
    roots.push(root);
    const releaseRoot = join(root, "release");
    const cliModule = join(releaseRoot, "node_modules/@urdira/cli/dist/index.js");
    const cliPath = join(releaseRoot, "bin/urdira.mjs");
    mkdirSync(join(releaseRoot, "node_modules/@urdira/cli/dist"), { recursive: true });
    mkdirSync(join(releaseRoot, "bin"), { recursive: true });
    writeFileSync(join(releaseRoot, "package.json"), JSON.stringify({ name: "fixture-release", version: "1.0.0", type: "module" }));
    writeFileSync(cliModule, "export const parseCliArgs = (args) => args[0] === 'status' && args[1] === '--json' ? { name: 'status', options: { json: true } } : null;\n");
    writeFileSync(cliPath, "#!/usr/bin/env node\n");
    const cliSha256 = (await import("node:crypto")).createHash("sha256").update(readFileSync(cliPath)).digest("hex");
    await expect(validateInstalledUrdiraCli({ cliPath, releaseRoot, expectedSha256: cliSha256, expectedVersion: "1.0.0" })).resolves.toMatchObject({ status: "passed", command: ["status", "--json"], model_invoked: false, daemon_started: false });
  });

  it("settles with an explicit spool error and terminates the child when capture fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-command-spool-error-"));
    roots.push(root);
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('capture failure\\n'); setTimeout(() => {}, 60_000)"], { timeoutMs: 1_000, stdoutPath: join(root, "stdout.log"), stderrPath: join(root, "stderr.log"), writeChunk: () => { throw new Error("synthetic spool failure"); } });
    expect(result.capture_error).toMatch(/synthetic spool failure/iu);
    expect(result.code).not.toBe(0);
    expect(result.stdout_path).toBe(join(root, "stdout.log"));
    expect(result.stdout_bytes).toBeGreaterThanOrEqual(0);
  });

  it("blocks infrastructure failures without an execution manifest", () => {
    expect(retainableCellFailure({ code: 1 }, null)).toBe(false);
    expect(retainableCellFailure({ code: 1 }, { release_binding: { status: "passed" }, transcript: "/missing", exit_code: 1, grader_exit_code: 1, completed_successfully: false })).toBe(false);
    expect(retainableCellFailure({ code: 0, capture_error: "spool failed" }, { release_binding: { status: "passed" }, transcript: "/missing", exit_code: 0, grader_exit_code: 0, completed_successfully: true })).toBe(false);
  });

  it("durably retains command stdout/stderr when a cell exits without a manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-definitive-command-output-"));
    roots.push(root);
    const repositoryRoot = join(root, "repo");
    mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
    const plan = buildCellManifest({ campaign: 1, outputRoot: root, worktreeRoot: join(root, "worktrees"), dataRoot: join(root, "data"), runRoot: join(root, "runs"), repositoriesRoot: root });
    const cell = { ...plan.cells[0]!, repository_root: repositoryRoot };
    const manifestPath = join(root, "cell-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(plan));
    await expect(runDefinitiveCells({ plan: { ...plan, cells: [cell], expected_runs: 1 }, outputRoot: root, worktreeRoot: join(root, "worktrees"), releaseRoot: "/release", releaseArchive: "/archive", outputManifest: manifestPath, releaseBinding: { status: "passed" }, minimumFreeBytes: 0,
      runner: async (_command: string, _args: string[], options: { phase?: string }) => options.phase === "cell"
        ? { code: 1, signal: null, stdout: "runner stdout\n", stderr: "runner stderr\n", timed_out: false }
        : { code: 0, signal: null, stdout: "", stderr: "", timed_out: false },
      prepareDependencies: async () => ({ repository_id: "playwright", prepared_roots: [], commands: [] }),
      cleanup: async () => ({ status: "passed", blockers: [] }),
    })).rejects.toThrow(/not recorded as a model\/grader result/iu);
    const audit = JSON.parse(readFileSync(join(root, "campaign-audit.json"), "utf8"));
    const result = audit.runs[0].result;
    expect(result).toMatchObject({ code: 1, signal: null, timed_out: false });
    expect(result.stdout_path).toBe(join(cell.output_root, `${cell.run_id}.stdout.log`));
    expect(result.stderr_path).toBe(join(cell.output_root, `${cell.run_id}.stderr.log`));
    expect(readFileSync(result.stdout_path, "utf8")).toBe("runner stdout\n");
    expect(readFileSync(result.stderr_path, "utf8")).toBe("runner stderr\n");
    expect(result.stdout_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.stderr_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("blocks a zero-exit cell with capture_error after retaining its audit and cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-definitive-capture-error-"));
    roots.push(root);
    const repositoryRoot = join(root, "repo");
    mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
    const plan = buildCellManifest({ campaign: 1, outputRoot: root, worktreeRoot: join(root, "worktrees"), dataRoot: join(root, "data"), runRoot: join(root, "runs"), repositoriesRoot: root });
    const cell = { ...plan.cells[0]!, repository_root: repositoryRoot };
    const manifestPath = join(root, "cell-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(plan));
    await expect(runDefinitiveCells({ plan: { ...plan, cells: [cell], expected_runs: 1 }, outputRoot: root, worktreeRoot: join(root, "worktrees"), releaseRoot: "/release", releaseArchive: "/archive", outputManifest: manifestPath, releaseBinding: { status: "passed" }, minimumFreeBytes: 0,
      runner: async (_command: string, _args: string[], options: { phase?: string }) => {
        if (options.phase !== "cell") return { code: 0, signal: null, stdout: "", stderr: "", timed_out: false };
        const transcript = join(cell.output_root, "transcript.jsonl");
        mkdirSync(cell.output_root, { recursive: true });
        writeFileSync(transcript, "");
        writeFileSync(join(cell.output_root, `${cell.run_id}.json`), JSON.stringify({ arm: cell.arm, release_binding: { status: "passed" }, transcript, exit_code: 0, grader_exit_code: 0, completed_successfully: true }));
        return { code: 0, signal: null, stdout: "", stderr: "", timed_out: false, capture_error: "synthetic spool failure" };
      },
      prepareDependencies: async () => ({ repository_id: "playwright", prepared_roots: [], commands: [] }),
      cleanup: async () => ({ status: "passed", blockers: [] }),
    })).rejects.toThrow(/not recorded as a model\/grader result/iu);
    const audit = JSON.parse(readFileSync(join(root, "campaign-audit.json"), "utf8"));
    expect(audit.runs[0]).toMatchObject({ result: { code: 0, capture_error: "synthetic spool failure" }, cleanup: { status: "passed" } });
  });

  it("retains the original cell failure when the cleanup checkpoint itself throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-definitive-cleanup-throw-"));
    roots.push(root);
    const repositoryRoot = join(root, "repo");
    mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
    const plan = buildCellManifest({ campaign: 1, outputRoot: root, worktreeRoot: join(root, "worktrees"), dataRoot: join(root, "data"), runRoot: join(root, "runs"), repositoriesRoot: root });
    const cell = { ...plan.cells[0]!, repository_root: repositoryRoot };
    const manifestPath = join(root, "cell-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(plan));
    await expect(runDefinitiveCells({ plan: { ...plan, cells: [cell], expected_runs: 1 }, outputRoot: root, worktreeRoot: join(root, "worktrees"), releaseRoot: "/release", releaseArchive: "/archive", outputManifest: manifestPath, releaseBinding: { status: "passed" }, minimumFreeBytes: 0,
      runner: async (_command: string, _args: string[], options: { phase?: string }) => options.phase === "cell" ? { code: 1, signal: null, stdout: "original stdout\n", stderr: "original stderr\n", timed_out: false } : { code: 0, signal: null, stdout: "", stderr: "", timed_out: false },
      prepareDependencies: async () => ({ repository_id: "playwright", prepared_roots: [], commands: [] }),
      cleanup: async () => { throw new Error("cleanup exploded"); },
    })).rejects.toThrow(/not recorded as a model\/grader result/iu);
    const audit = JSON.parse(readFileSync(join(root, "campaign-audit.json"), "utf8"));
    expect(audit.runs[0]).toMatchObject({ error: expect.stringContaining("not recorded as a model/grader result"), cleanup_error: "cleanup exploded" });
    expect(audit.runs[0].result).toMatchObject({ code: 1, stdout_bytes: 16, stderr_bytes: 16 });
    expect(JSON.parse(readFileSync(join(root, "cleanup-block.json"), "utf8"))).toMatchObject({ status: "blocked", error: "cleanup exploded" });
  });

  it("runs a successful injected cold readiness phase and stops its runtime", async () => {
    let stopped = false;
    const runtime = { stop: async () => { stopped = true; } };
    const client = { call: async (operation: string) => operation === "core:workspace_add"
      ? { outcome: "success", payload: { workspace_id: "workspace:test" } }
      : { outcome: "success", payload: { pages: [{ items: [{ id: "record" }] }], completeness: { complete: true } } } };
    const result = await runReadinessPhase({ phase: "cold", releaseRoot: "/release", dataRoot: "/tmp", worktree: "/checkout", verifiedWorker: "/worker", adapters: {
      startDaemon: async () => ({ runtime, client }),
      waitForReadiness: async (_client: unknown, _workspace: string, timestamps: Record<string, number | null>) => { timestamps["source_ready"] = 2; timestamps["structural_ready"] = 3; return { current_snapshot_id: "snapshot:1", source_freshness: "current", structural_freshness: "current", freshness_status: "current" }; },
      semanticSidecarCreated: () => [],
      storageMeasurement: () => ({ path: "/tmp", bytes: 0, errors: [] }),
      processMeasurement: () => ({ rss_bytes: 1, heap_used_bytes: 1, external_bytes: 0 }),
    } });
    expect(result).toMatchObject({ workspace_id: "workspace:test", passed: true, snapshot_identity: "snapshot:1", page_completeness: { complete: true }, semantic_sidecar_created: false });
    expect(stopped).toBe(true);
  });

  it("records injected readiness failures and preserves warm snapshot validation", async () => {
    const runtime = { stop: async () => undefined };
    const failedRegistration = await runReadinessPhase({ phase: "cold", releaseRoot: "/release", dataRoot: "/tmp", worktree: "/checkout", verifiedWorker: "/worker", adapters: {
      startDaemon: async () => ({ runtime, client: { call: async () => ({ outcome: "error", message: "registration unavailable" }) } }),
      storageMeasurement: () => ({ path: "/tmp", bytes: 0, errors: [] }),
      processMeasurement: () => ({ rss_bytes: 1, heap_used_bytes: 1, external_bytes: 0 }),
    } });
    expect(failedRegistration).toMatchObject({ passed: false, failure: expect.stringContaining("workspace registration failed") });
    const mismatch = await runReadinessPhase({ phase: "warm", previousWorkspaceId: "workspace:test", expectedSnapshotId: "snapshot:old", releaseRoot: "/release", dataRoot: "/tmp", worktree: "/checkout", verifiedWorker: "/worker", adapters: {
      startDaemon: async () => ({ runtime, client: { call: async () => ({ outcome: "success", payload: { pages: [] } }) } }),
      waitForReadiness: async () => ({ current_snapshot_id: "snapshot:new" }),
      storageMeasurement: () => ({ path: "/tmp", bytes: 0, errors: [] }),
      processMeasurement: () => ({ rss_bytes: 1, heap_used_bytes: 1, external_bytes: 0 }),
    } });
    expect(mismatch).toMatchObject({ passed: false, failure: expect.stringContaining("snapshot changed") });
  });

  it("retains a model failure after clean cleanup and proceeds to the next frozen cell", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-definitive-cells-"));
    roots.push(root);
    const repositoryRoot = join(root, "repo");
    mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
    const plan = buildCellManifest({ campaign: 1, outputRoot: root, worktreeRoot: join(root, "worktrees"), dataRoot: join(root, "data"), runRoot: join(root, "runs"), repositoriesRoot: root });
    const cells = plan.cells.slice(0, 2).map((cell) => ({ ...cell, repository_root: repositoryRoot }));
    const manifestPath = join(root, "cell-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(plan));
    let cellRuns = 0;
    const order: string[] = [];
    const audit = await runDefinitiveCells({ plan: { ...plan, cells, expected_runs: cells.length }, outputRoot: root, worktreeRoot: join(root, "worktrees"), releaseRoot: "/release", releaseArchive: "/archive", outputManifest: manifestPath, releaseBinding: { status: "passed" }, minimumFreeBytes: 0,
      runner: async (_command: string, args: string[], options: { phase?: string }) => {
        order.push(options.phase ?? "unknown");
        if (options.phase !== "cell") return { code: 0, signal: null, stdout: "", stderr: "" };
        const cell = cells[cellRuns++]!;
        mkdirSync(cell.output_root, { recursive: true });
        const transcript = join(cell.output_root, "transcript.jsonl");
        writeFileSync(transcript, "retained failure\n");
        writeFileSync(join(cell.output_root, `${cell.run_id}.json`), JSON.stringify({ arm: cell.arm, release_binding: { status: "passed" }, transcript, exit_code: cellRuns === 1 ? 1 : 0, grader_exit_code: cellRuns === 1 ? 1 : 0, completed_successfully: cellRuns !== 1 }));
        return { code: cellRuns === 1 ? 1 : 0, signal: null, stdout: "", stderr: "" };
      },
      prepareDependencies: async () => { order.push("dependency-setup"); return { repository_id: "playwright", prepared_roots: [], commands: [] }; },
      cleanup: async () => ({ status: "passed", blockers: [] }),
    });
    expect(audit.runs).toHaveLength(2);
    expect(audit.runs[0]?.["result"]).toMatchObject({ code: 1 });
    expect(audit.runs[1]?.["result"]).toMatchObject({ code: 0 });
    expect(order.slice(0, 3)).toEqual(["worktree", "dependency-setup", "cell"]);
  });

  it("blocks the next cell when injected cleanup fails and records the marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-definitive-cells-"));
    roots.push(root);
    const repositoryRoot = join(root, "repo");
    mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
    const plan = buildCellManifest({ campaign: 1, outputRoot: root, worktreeRoot: join(root, "worktrees"), dataRoot: join(root, "data"), runRoot: join(root, "runs"), repositoriesRoot: root });
    const cell = { ...plan.cells[0]!, repository_root: repositoryRoot };
    const manifestPath = join(root, "cell-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(plan));
    await expect(runDefinitiveCells({ plan: { ...plan, cells: [cell], expected_runs: 1 }, outputRoot: root, worktreeRoot: join(root, "worktrees"), releaseRoot: "/release", releaseArchive: "/archive", outputManifest: manifestPath, releaseBinding: { status: "passed" }, minimumFreeBytes: 0, runner: async (_command: string, _args: string[], options: { phase?: string }) => options.phase === "cell" ? { code: 0, signal: null, stdout: "", stderr: "" } : { code: 0, signal: null, stdout: "", stderr: "" }, prepareDependencies: async () => ({ repository_id: "playwright", prepared_roots: [], commands: [] }), cleanup: async () => ({ status: "blocked", blockers: ["residue"] }) })).rejects.toThrow(/cleanup checkpoint blocked/iu);
    expect(existsSync(join(root, "cleanup-block.json"))).toBe(true);
  });

  it("retains dependency setup failure before runner invocation with model_invoked false", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-definitive-dependency-failure-"));
    roots.push(root);
    const repositoryRoot = join(root, "repo");
    mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
    const plan = buildCellManifest({ campaign: 1, outputRoot: root, worktreeRoot: join(root, "worktrees"), dataRoot: join(root, "data"), runRoot: join(root, "runs"), repositoriesRoot: root });
    const cell = { ...plan.cells[0]!, repository_root: repositoryRoot };
    const manifestPath = join(root, "cell-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(plan));
    await expect(runDefinitiveCells({ plan: { ...plan, cells: [cell], expected_runs: 1 }, outputRoot: root, worktreeRoot: join(root, "worktrees"), releaseRoot: "/release", releaseArchive: "/archive", outputManifest: manifestPath, releaseBinding: { status: "passed" }, minimumFreeBytes: 0,
      runner: async (_command: string, _args: string[], options: { phase?: string }) => { if (options.phase === "cell") throw new Error("runner must not be invoked"); return { code: 0, signal: null, stdout: "", stderr: "" }; },
      prepareDependencies: async () => { throw new Error("frozen lockfile unavailable"); },
      cleanup: async () => ({ status: "passed", blockers: [] }),
    })).rejects.toThrow(/frozen lockfile unavailable/iu);
    const audit = JSON.parse(readFileSync(join(root, "campaign-audit.json"), "utf8"));
    expect(audit.runs[0]).toMatchObject({ model_invoked: false, error: expect.stringContaining("frozen lockfile unavailable") });
    expect(existsSync(audit.runs[0].preflight_failure.path)).toBe(true);
  });

  it("fails the cell before worktree creation when the production Codex argv preflight is invalid", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-definitive-codex-preflight-"));
    roots.push(root);
    const repositoryRoot = join(root, "repo");
    mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
    const plan = buildCellManifest({ campaign: 1, outputRoot: root, worktreeRoot: join(root, "worktrees"), dataRoot: join(root, "data"), runRoot: join(root, "runs"), repositoriesRoot: root });
    const cell = { ...plan.cells[0]!, repository_root: repositoryRoot };
    const manifestPath = join(root, "cell-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(plan));
    const phases: string[] = [];
    await expect(runDefinitiveCells({ plan: { ...plan, cells: [cell], expected_runs: 1 }, outputRoot: root, worktreeRoot: join(root, "worktrees"), releaseRoot: "/release", releaseArchive: "/archive", outputManifest: manifestPath, releaseBinding: { status: "passed" }, minimumFreeBytes: 0,
      validateCodex: async () => ({ ok: false, binary_path: "/pinned/codex", binary_sha256: "a".repeat(64), first: { args: ["exec", "--help"], status: 2, stdout: "", stderr: "unexpected argument", }, resume: { args: ["resume", "--help"], status: 2, stdout: "", stderr: "unexpected argument" } }),
      runner: async (_command: string, _args: string[], options: { phase?: string }) => { phases.push(options.phase ?? "unknown"); return { code: 0, signal: null, stdout: "", stderr: "", timed_out: false }; },
      prepareDependencies: async () => ({ repository_id: "playwright", prepared_roots: [], commands: [] }),
      cleanup: async () => ({ status: "passed", blockers: [] }),
    })).rejects.toThrow(/Codex argv preflight failed/iu);
    expect(phases).toEqual([]);
    const audit = JSON.parse(readFileSync(join(root, "campaign-audit.json"), "utf8"));
    expect(audit.runs[0]).toMatchObject({ model_invoked: false, preflight_failure: { stage: "codex-argv" }, codex_preflight: { ok: false } });
    expect(readFileSync(audit.runs[0].preflight_failure.path, "utf8")).toMatch(/unexpected argument/iu);
  });

  it("uses the cell supervisor timeout for both argv preflight and the production runner", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-definitive-timeout-source-"));
    roots.push(root);
    const repositoryRoot = join(root, "repo");
    mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
    const plan = buildCellManifest({ campaign: 1, outputRoot: root, worktreeRoot: join(root, "worktrees"), dataRoot: join(root, "data"), runRoot: join(root, "runs"), repositoriesRoot: root, codegraph: "/bin/echo" });
    const sourceCell = plan.cells.find((entry) => entry.arm === "codegraph")!;
    const cell = { ...sourceCell, repository_root: repositoryRoot, supervisor_timeout_ms: 120_000 };
    const manifestPath = join(root, "cell-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(plan));
    let preflightArgs: string[] | undefined;
    let runnerTimeout: string | undefined;
    await runDefinitiveCells({ plan: { ...plan, cells: [cell], expected_runs: 1 }, outputRoot: root, worktreeRoot: join(root, "worktrees"), releaseRoot: "/release", releaseArchive: "/archive", outputManifest: manifestPath, releaseBinding: { status: "passed" }, minimumFreeBytes: 0,
      validateCodex: async (options: { mcpArgs: string[] }) => { preflightArgs = options.mcpArgs; return { ok: true, first: { stderr: "" }, resume: { stderr: "" } }; },
      runner: async (_command: string, _args: string[], options: { phase?: string; env?: Record<string, string> }) => { if (options.phase === "cell") runnerTimeout = options.env?.["URDIRA_BENCHMARK_TIMEOUT_MS"]; return { code: 0, signal: null, stdout: "", stderr: "", timed_out: false }; },
      prepareDependencies: async () => ({ repository_id: "playwright", prepared_roots: [], commands: [] }),
      cleanup: async () => ({ status: "passed", blockers: [] }),
    });
    expect(preflightArgs).toContain("mcp_servers.codegraph.tool_timeout_sec=300");
    expect(runnerTimeout).toBe("120000");
  });

  it("retains a runner runtime preflight failure before its manifest exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-runner-preflight-failure-"));
    roots.push(root);
    const result = spawnSync(process.execPath, [resolve("release/benchmarks/expanded-agent-benchmark-runner.mjs"), "--preflight-only", "--repository-id", "playwright", "--task-id", "affected-tests-deterministic", "--arm", "baseline", "--sample", "1", "--model", "gpt-5.6-luna", "--node", join(root, "missing-node"), "--output-dir", root], { encoding: "utf8" });
    expect(result.status).toBe(1);
    const files = readdirSync(root);
    const failureName = files.find((name) => name.endsWith(".preflight-failure.json"));
    expect(failureName).toBeDefined();
    const failure = JSON.parse(readFileSync(join(root, failureName!), "utf8"));
    expect(failure).toMatchObject({ model_invoked: false, failure_stage: "runtime" });
    expect(failure.error).toMatch(/unable to execute/iu);
    expect(failure.preflight_invocation).toMatchObject({ command: join(root, "missing-node"), args: ["--version"] });
  });

  it("retains the outer orchestrator runtime preflight failure before a cell manifest exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-driver-preflight-failure-"));
    roots.push(root);
    const missingNode = join(root, "missing-node");
    const result = spawnSync(process.execPath, [resolve("release/benchmarks/run-definitive-agent-campaign.mjs"), "--campaign", "1", "--output-root", root, "--node", missingNode], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    const failurePath = join(root, "campaign-preflight-failure.json");
    expect(existsSync(failurePath)).toBe(true);
    const failure = JSON.parse(readFileSync(failurePath, "utf8"));
    expect(failure).toMatchObject({ model_invoked: false, failure_stage: "runtime" });
    expect(failure.command_output.stdout_path).toContain("node.stdout.log");
    expect(failure.command_output.stderr_path).toContain("node.stderr.log");
    expect(failure.command_output.stdout_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("retains an outer release binding failure after plan creation and before a cell", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-driver-binding-failure-"));
    roots.push(root);
    const result = spawnSync(process.execPath, [resolve("release/benchmarks/run-definitive-agent-campaign.mjs"), "--campaign", "1", "--output-root", root, "--release-root", join(root, "missing-release"), "--release-archive", join(root, "missing-release.tar.gz")], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    const failure = JSON.parse(readFileSync(join(root, "campaign-preflight-failure.json"), "utf8"));
    expect(failure).toMatchObject({ model_invoked: false, failure_stage: "release-binding" });
    expect(failure.error).toMatch(/release|archive|binding/iu);
  });

  it("retains readiness runtime preflight failure before its manifest exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-readiness-preflight-failure-"));
    roots.push(root);
    const outputRoot = join(root, "output");
    const missingNode = join(root, "missing-node");
    await expect(runReadinessCampaign({ campaign: 1, releaseRoot: "/release", releaseArchive: "/archive", repositoriesRoot: join(root, "repos"), outputRoot, dataRoot: join(root, "data"), nodeBin: missingNode, minimumFreeBytes: 0 })).rejects.toThrow(/unable to execute|Node mismatch/iu);
    const failure = JSON.parse(readFileSync(join(outputRoot, "readiness-preflight-failure.json"), "utf8"));
    expect(failure).toMatchObject({ model_invoked: false, failure_stage: "runtime" });
    expect(failure.command_output.stdout_path).toContain("node.stdout.log");
    expect(failure.command_output.stdout_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("retains driver freeze and timeout validation failures before creating a cell", () => {
    const cases = [
      { name: "model", args: ["--model", "wrong-model"], env: {}, stage: "frozen-model" },
      { name: "free-space", args: [], env: { BENCH_MIN_FREE_BYTES: "1" }, stage: "freeze" },
      { name: "timeout", args: [], env: { BENCH_CELL_TIMEOUT_MS: "invalid" }, stage: "timeout" },
    ];
    for (const entry of cases) {
      const root = mkdtempSync(join(tmpdir(), `urdira-driver-${entry.name}-failure-`));
      roots.push(root);
      const result = spawnSync(process.execPath, [resolve("release/benchmarks/run-definitive-agent-campaign.mjs"), "--campaign", "1", "--output-root", root, ...entry.args], { encoding: "utf8", env: { ...process.env, BENCH_MIN_FREE_BYTES: "53687091200", BENCH_CELL_TIMEOUT_MS: "900000", ...entry.env } });
      expect(result.status).not.toBe(0);
      const failure = JSON.parse(readFileSync(join(root, "campaign-preflight-failure.json"), "utf8"));
      expect(failure).toMatchObject({ model_invoked: false, failure_stage: entry.stage });
    }
  });

  it("keeps the cold failure, blocks warm, and always checkpoints the readiness pair", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-readiness-pair-"));
    roots.push(root);
    const rows: Record<string, unknown>[] = [];
    let checkpointed = false;
    const cleanup = await executeReadinessPair({ probeRows: rows, releaseRoot: "/release", repositoryRoot: join(root, "repo"), repositoryId: "playwright", campaign: 1, outputRoot: join(root, "output"), dataRoot: join(root, "data"), minimumFreeBytes: 0, verifiedWorker: "/worker", nodeVersion: "v24.18.1", prepareDependencies: async () => ({ repository_id: "playwright", prepared_roots: [], commands: [] }), adapters: {
      addWorktree: async () => ({ status: 0, stdout: "", stderr: "" }),
      validateDependencies: async () => ({ ready: true, missing_dependencies: [], missing_runtime_artifacts: [] }),
      runPhase: async ({ phase }: { phase: string }) => phase === "cold" ? { workspace_id: "workspace:cold", passed: false, failure: "synthetic cold failure" } : { passed: true, snapshot_identity: "unexpected" },
      runCleanupCheckpoint: async (options: { cleanup: () => Promise<unknown> }) => { checkpointed = true; await options.cleanup(); return { status: "passed", blockers: [] }; },
      terminateOwnedProcesses: async () => ({ stopped_processes: [], unverified_processes: [] }),
      removeWorktree: async () => ({ status: 0, stdout: "", stderr: "" }),
      listOwnedProcesses: () => [],
    } });
    expect(cleanup).toMatchObject({ status: "passed" });
    expect(checkpointed).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.["passed"]).toBe(false);
    expect(rows[1]?.["failure"]).toMatch(/warm probe blocked/iu);
  });

  it("retains cold and warm rows when readiness dependency setup fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-readiness-dependency-failure-"));
    roots.push(root);
    const rows: Record<string, unknown>[] = [];
    await expect(executeReadinessPair({ probeRows: rows, releaseRoot: "/release", repositoryRoot: join(root, "repo"), repositoryId: "playwright", campaign: 1, outputRoot: join(root, "output"), dataRoot: join(root, "data"), minimumFreeBytes: 0, verifiedWorker: "/worker", nodeVersion: "v24.18.1", prepareDependencies: async () => { throw new Error("frozen dependency setup failed"); }, adapters: {
      addWorktree: async () => ({ status: 0, stdout: "", stderr: "" }),
      runCleanupCheckpoint: async (options: { cleanup: () => Promise<unknown> }) => { await options.cleanup(); return { status: "passed", blockers: [] }; },
      terminateOwnedProcesses: async () => ({ stopped_processes: [], unverified_processes: [] }),
      removeWorktree: async () => ({ status: 0, stdout: "", stderr: "" }),
      listOwnedProcesses: () => [],
    } })).rejects.toThrow(/frozen dependency setup failed/iu);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row["phase"])).toEqual(["cold", "warm"]);
    expect(rows.every((row) => row["model_invoked"] === false && row["passed"] === false)).toBe(true);
    expect(rows.every((row) => row["setup_elapsed_ms"] === null && row["structural_readiness_ms"] === null && row["time_to_first_query_ms"] === null)).toBe(true);
    expect(rows[1]?.["failure"]).toMatch(/warm probe blocked by cold failure/iu);
  });

  it("retains blocked cold and warm rows when readiness worktree creation fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-readiness-worktree-failure-"));
    roots.push(root);
    const rows: Record<string, unknown>[] = [];
    await expect(executeReadinessPair({ probeRows: rows, releaseRoot: "/release", repositoryRoot: join(root, "repo"), repositoryId: "playwright", campaign: 1, outputRoot: join(root, "output"), dataRoot: join(root, "data"), minimumFreeBytes: 0, verifiedWorker: "/worker", nodeVersion: "v24.18.1", prepareDependencies: async () => ({ repository_id: "playwright", prepared_roots: [], commands: [] }), adapters: {
      addWorktree: async () => ({ status: 1, stdout: "", stderr: "worktree unavailable" }),
      runCleanupCheckpoint: async (options: { cleanup: () => Promise<unknown> }) => { await options.cleanup(); return { status: "passed", blockers: [] }; },
      terminateOwnedProcesses: async () => ({ stopped_processes: [], unverified_processes: [] }),
      removeWorktree: async () => ({ status: 0, stdout: "", stderr: "" }),
      listOwnedProcesses: () => [],
    } })).rejects.toThrow(/worktree unavailable/iu);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row["phase"])).toEqual(["cold", "warm"]);
    expect(rows.every((row) => row["model_invoked"] === false && row["passed"] === false)).toBe(true);
    expect(rows[0]?.["failure"]).toMatch(/worktree unavailable/iu);
    expect(rows[1]?.["failure"]).toMatch(/warm probe blocked by cold failure/iu);
  });

  it("blocks readiness progression when its cleanup checkpoint is blocked", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-readiness-cleanup-block-"));
    roots.push(root);
    const rows: Record<string, unknown>[] = [];
    await expect(executeReadinessPair({ probeRows: rows, releaseRoot: "/release", repositoryRoot: join(root, "repo"), repositoryId: "playwright", campaign: 1, outputRoot: join(root, "output"), dataRoot: join(root, "data"), minimumFreeBytes: 0, verifiedWorker: "/worker", nodeVersion: "v24.18.1", prepareDependencies: async () => ({ repository_id: "playwright", prepared_roots: [], commands: [] }), adapters: {
      addWorktree: async () => ({ status: 0, stdout: "", stderr: "" }),
      validateDependencies: async () => ({ ready: true, missing_dependencies: [], missing_runtime_artifacts: [] }),
      runPhase: async ({ phase }: { phase: string }) => ({ workspace_id: `workspace:${phase}`, passed: true, snapshot_identity: "snapshot:1" }),
      runCleanupCheckpoint: async (options: { cleanup: () => Promise<unknown> }) => { await options.cleanup(); return { status: "blocked", blockers: ["residue"] }; },
      terminateOwnedProcesses: async () => ({ stopped_processes: [], unverified_processes: [] }),
      removeWorktree: async () => ({ status: 0, stdout: "", stderr: "" }),
      listOwnedProcesses: () => [],
    } })).rejects.toThrow(/cleanup checkpoint blocked/iu);
    expect(existsSync(join(root, "output", "cleanup-block.json"))).toBe(true);
  });
});
