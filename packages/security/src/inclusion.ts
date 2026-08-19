import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { canonicalizePath, isWithinRoot, normalizeWorkspacePath } from "./paths.js";
import { SecurityError } from "./errors.js";

export interface InclusionObservation {
  readonly normalized_path: string;
  readonly is_symlink: boolean;
  readonly is_directory: boolean;
  readonly byte_length: number;
  readonly media_type: string;
  readonly outside_allowed_root?: boolean;
  readonly symlink_cycle?: boolean;
  readonly is_special?: boolean;
}
export interface InclusionRules { readonly include: readonly string[]; readonly exclude: readonly string[]; readonly allow_external_root: boolean; readonly follow_symlinks?: boolean; readonly allowed_external_roots?: readonly string[]; readonly ordered_rules?: readonly { readonly kind: "include" | "exclude"; readonly pattern: string }[]; }
export interface GitIgnoreRules { readonly enabled: boolean; readonly patterns: readonly string[]; }
export interface InclusionResult { readonly included: boolean; readonly reason_code: string; readonly matched_rule?: string; }

function glob(pattern: string, value: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.!\//, "");
  const target = normalized.includes("/") ? value : value.split("/").at(-1) ?? value;
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") { expression += "(?:.*/)?"; index += 2; }
      else { expression += ".*"; index += 1; }
    }
    else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char === "/" ? "/" : char?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`).test(target);
}

function matches(patterns: readonly string[], path: string): string | undefined {
  return [...patterns].reverse().find((pattern) => glob(pattern, path));
}

function gitIgnoreMatch(patterns: readonly string[], path: string): { readonly ignored: boolean; readonly rule: string } | undefined {
  let decision: { readonly ignored: boolean; readonly rule: string } | undefined;
  for (const pattern of patterns) {
    if (!pattern || pattern.startsWith("#")) continue;
    const negated = pattern.startsWith("!");
    const candidate = negated ? pattern.slice(1) : pattern;
    if (glob(candidate, path)) decision = { ignored: !negated, rule: pattern };
  }
  return decision;
}

export function evaluateInclusion(observation: InclusionObservation, rules: InclusionRules, gitignore: GitIgnoreRules): InclusionResult {
  if (observation.outside_allowed_root) return { included: false, reason_code: "security:external_root_forbidden" };
  if (observation.symlink_cycle) return { included: false, reason_code: "security:symlink_cycle" };
  if (observation.is_special) return { included: false, reason_code: "security:path_invalid" };
  if (observation.is_symlink && rules.follow_symlinks !== true) return { included: false, reason_code: "security:symlink_forbidden" };
  const path = observation.normalized_path.replaceAll("\\", "/");
  if (path.startsWith("/") || path.split("/").includes("..") || /^[A-Za-z]:\//u.test(path)) return { included: false, reason_code: "security:path_outside_workspace" };
  if (path === ".git" || path.startsWith(".git/") || path === ".urdira" || path.startsWith(".urdira/")) return { included: false, reason_code: "security:mandatory_exclusion" };
  if (observation.is_directory) return { included: false, reason_code: "security:directory_not_artifact" };
  if (observation.byte_length > 10 * 1024 * 1024) return { included: false, reason_code: "security:size_exclusion" };
  if (observation.media_type.startsWith("application/octet-stream") || /(?:^|\/)(?:node_modules|dist|coverage|\.git)\//.test(path)) {
    const explicit = matches(rules.include, path);
    if (!explicit) return { included: false, reason_code: "security:generated_or_binary_default" };
  }
  const explicitRules = rules.ordered_rules ?? [...rules.exclude.map((pattern) => ({ kind: "exclude" as const, pattern })), ...rules.include.map((pattern) => ({ kind: "include" as const, pattern }))];
  let explicitDecision: { readonly kind: "include" | "exclude"; readonly pattern: string } | undefined;
  for (const rule of explicitRules) if (glob(rule.pattern, path)) explicitDecision = rule;
  if (explicitDecision?.kind === "exclude") return { included: false, reason_code: "security:workspace_exclusion", matched_rule: explicitDecision.pattern };
  if (explicitDecision?.kind === "include") return { included: true, reason_code: "security:explicit_include", matched_rule: explicitDecision.pattern };
  const ignored = gitignore.enabled ? gitIgnoreMatch(gitignore.patterns, path) : undefined;
  if (ignored?.ignored) return { included: false, reason_code: "security:gitignore", matched_rule: ignored.rule };
  return { included: true, reason_code: "security:eligible_default" };
}

const binaryExtensions = new Set([".7z", ".avi", ".bin", ".bmp", ".class", ".dll", ".dylib", ".eot", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4", ".o", ".pdf", ".png", ".so", ".tar", ".wasm", ".webp", ".woff", ".woff2", ".zip"]);

async function regularFileMediaType(path: string, byteLength: number): Promise<string> {
  if (binaryExtensions.has(extname(path).toLowerCase()) || byteLength > 10 * 1024 * 1024) return "application/octet-stream";
  try {
    const bytes = await readFile(path);
    if (bytes.some((byte) => byte === 0)) return "application/octet-stream";
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "text/plain";
  } catch {
    return "application/octet-stream";
  }
}

function isSpecialFile(value: { isBlockDevice(): boolean; isCharacterDevice(): boolean; isFIFO(): boolean; isSocket(): boolean }): boolean {
  return value.isBlockDevice() || value.isCharacterDevice() || value.isFIFO() || value.isSocket();
}

export async function inspectInclusionPath(root: string, candidate: string, rules: InclusionRules, gitignore: GitIgnoreRules): Promise<InclusionResult> {
  const normalizedPath = normalizeWorkspacePath(root, candidate);
  const absolute = resolve(root, candidate);
  const link = await lstat(absolute);
  if (link.isSymbolicLink()) {
    if (rules.follow_symlinks !== true) return { included: false, reason_code: "security:symlink_forbidden" };
    let target: string;
    try { target = await realpath(absolute); } catch { return evaluateInclusion({ normalized_path: normalizedPath, is_symlink: true, symlink_cycle: true, is_directory: false, byte_length: 0, media_type: "application/octet-stream" }, rules, gitignore); }
    const canonicalTarget = canonicalizePath(target);
    const canonicalWorkspaceRoot = canonicalizePath(root);
    const registeredExternalRoots = (rules.allowed_external_roots ?? []).map((allowedRoot) => canonicalizePath(allowedRoot));
    const outsideWorkspace = !isWithinRoot(canonicalWorkspaceRoot, canonicalTarget);
    const registeredExternal = registeredExternalRoots.some((allowedRoot) => isWithinRoot(allowedRoot, canonicalTarget));
    if (outsideWorkspace && (rules.allow_external_root !== true || !registeredExternal)) return { included: false, reason_code: "security:external_root_forbidden" };
    const targetStat = await stat(absolute);
    if (isSpecialFile(targetStat)) return { included: false, reason_code: "security:path_invalid" };
    return evaluateInclusion({ normalized_path: normalizedPath, is_symlink: true, outside_allowed_root: false, is_directory: targetStat.isDirectory(), byte_length: targetStat.size, media_type: targetStat.isDirectory() ? "application/octet-stream" : await regularFileMediaType(target, targetStat.size) }, rules, gitignore);
  }
  if (isSpecialFile(link)) return { included: false, reason_code: "security:path_invalid" };
  return evaluateInclusion({ normalized_path: normalizedPath, is_symlink: false, is_directory: link.isDirectory(), byte_length: link.size, media_type: link.isDirectory() ? "application/octet-stream" : await regularFileMediaType(absolute, link.size) }, rules, gitignore);
}

export function assertAllowedExternalRoot(root: string, installationRoots: readonly string[]): void {
  const observed = canonicalizePath(root);
  if (!installationRoots.some((registered) => canonicalizePath(registered) === observed)) throw new SecurityError("security:external_root_forbidden", `External root ${root} is not administrator-approved.`);
}
