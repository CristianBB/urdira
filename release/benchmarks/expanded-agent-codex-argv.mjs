/* Shared, side-effect-free Codex argv construction and parser preflight. */
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const approvalArgs = ["--dangerously-bypass-approvals-and-sandbox"];

export function effectiveCodexHome({ env = process.env, home = homedir() } = {}) {
  const configured = typeof env?.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  return resolve(configured.length > 0 ? configured : join(home, ".codex"));
}

/**
 * Route one isolated Codex home to the effective parent auth file without
 * reading or copying credentials. Every arm uses this same metadata-only
 * route before its first Codex invocation.
 */
export function resolveCodexAuthRoute({ parentCodexHome, isolatedCodexHome }) {
  if (typeof parentCodexHome !== "string" || parentCodexHome.trim().length === 0) return { ok: false, failure: "missing-parent-codex-home" };
  if (typeof isolatedCodexHome !== "string" || isolatedCodexHome.trim().length === 0) return { ok: false, failure: "missing-isolated-codex-home" };
  const parent = resolve(parentCodexHome);
  const isolated = resolve(isolatedCodexHome);
  const source = join(parent, "auth.json");
  const target = join(isolated, "auth.json");
  try {
    const sourceInfo = statSync(source);
    if (!sourceInfo.isFile()) return { ok: false, failure: "auth-not-regular-file", source_auth_path: source, isolated_auth_path: target };
    if (sourceInfo.size === 0) return { ok: false, failure: "empty-auth", source_auth_path: source, isolated_auth_path: target, source_bytes: 0, source_mode: sourceInfo.mode & 0o777 };
    accessSync(source, constants.R_OK);
    mkdirSync(isolated, { recursive: true, mode: 0o700 });
    if (existsSync(target)) {
      const targetInfo = lstatSync(target);
      if (!targetInfo.isSymbolicLink() || resolve(dirname(target), readlinkSync(target)) !== source) return { ok: false, failure: "isolated-auth-route-mismatch", source_auth_path: source, isolated_auth_path: target };
    } else symlinkSync(source, target);
    return { ok: true, route: "symlink", parent_codex_home: parent, isolated_codex_home: isolated, source_auth_path: source, isolated_auth_path: target, source_bytes: sourceInfo.size, source_mode: sourceInfo.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, failure: "missing-auth", source_auth_path: source, isolated_auth_path: target };
    return { ok: false, failure: "auth-route-error", source_auth_path: source, isolated_auth_path: target, error: error instanceof Error ? error.message : String(error) };
  }
}

export function buildCodexMcpArgs({ arm, codebaseMemory, codegraph, benchmarkTimeoutMs }) {
  const timeoutSeconds = Math.max(300, Math.ceil(benchmarkTimeoutMs / 1_000));
  if (arm === "codebase-memory") return ["-c", `mcp_servers.codebase-memory.command=${JSON.stringify(codebaseMemory)}`, "-c", "mcp_servers.codebase-memory.startup_timeout_sec=120", "-c", `mcp_servers.codebase-memory.tool_timeout_sec=${timeoutSeconds}`];
  if (arm === "codegraph") return ["-c", `mcp_servers.codegraph.command=${JSON.stringify(codegraph)}`, "-c", "mcp_servers.codegraph.args=[\"serve\",\"--mcp\"]", "-c", "mcp_servers.codegraph.startup_timeout_sec=120", "-c", `mcp_servers.codegraph.tool_timeout_sec=${timeoutSeconds}`];
  return [];
}

export function buildCodexExecArgs({ model, worktree, integrated = false, mcpArgs = [] }) {
  return ["-m", model, ...approvalArgs, "exec", "--json", "--skip-git-repo-check", "-C", worktree, ...(integrated ? ["--dangerously-bypass-hook-trust"] : ["--ignore-user-config"]), ...mcpArgs];
}

export function buildCodexResumeArgs({ model, worktree, sessionId, integrated = false, mcpArgs = [] }) {
  return ["-m", model, ...approvalArgs, "-C", worktree, "exec", "resume", sessionId, "--json", ...(integrated ? ["--dangerously-bypass-hook-trust"] : ["--ignore-user-config"]), "--skip-git-repo-check", ...mcpArgs];
}

function output(value) {
  return value === undefined || value === null ? "" : Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

function runHelp(codex, args) {
  const result = spawnSync(codex, [...args, "--help"], { encoding: "utf8", timeout: 30_000 });
  return { args: [...args, "--help"], status: result.status, signal: result.signal ?? null, stdout: output(result.stdout), stderr: output(result.stderr), error: result.error?.message ?? null };
}

export function validateCodexArgv({ codex, model, worktree, sessionId = "session-placeholder", integrated = false, mcpArgs = [] }) {
  const version = spawnSync(codex, ["--version"], { encoding: "utf8", timeout: 30_000 });
  const firstArgs = buildCodexExecArgs({ model, worktree, integrated, mcpArgs });
  const resumeArgs = buildCodexResumeArgs({ model, worktree, sessionId, integrated, mcpArgs });
  const first = runHelp(codex, firstArgs);
  const resume = runHelp(codex, resumeArgs);
  let binarySha256 = null;
  try { if (existsSync(codex)) binarySha256 = createHash("sha256").update(readFileSync(codex)).digest("hex"); } catch { /* diagnostic retains null when unreadable */ }
  const versionStatus = version.status;
  const versionOutput = output(version.stdout).trim();
  const versionError = output(version.stderr);
  return {
    ok: versionStatus === 0 && first.status === 0 && resume.status === 0,
    binary_path: codex,
    binary_version: versionOutput || null,
    binary_version_status: versionStatus,
    binary_version_stderr: versionError || null,
    binary_sha256: binarySha256,
    first,
    resume,
  };
}
