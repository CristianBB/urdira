import { lstat, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { SecurityError } from "./errors.js";

function portable(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+/g, "/").normalize("NFC");
}

export function canonicalizePath(value: string): string {
  const absolute = resolve(portable(value));
  let canonical = absolute;
  try { canonical = realpathSync.native(absolute); } catch { /* A not-yet-created configured root still compares lexically. */ }
  const normalized = portable(canonical);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function normalizeWorkspacePath(workspaceRoot: string, candidate: string): string {
  if (candidate.includes("\0")) throw new SecurityError("security:path_invalid", "Path contains a NUL byte.");
  const raw = portable(candidate);
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) throw new SecurityError("security:path_outside_workspace", "Absolute paths are not workspace-relative.");
  const root = resolve(workspaceRoot);
  const resolved = resolve(root, raw);
  const rel = portable(relative(root, resolved));
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel) || rel.includes(":/")) throw new SecurityError("security:path_outside_workspace", "Path escapes the workspace boundary.");
  return rel === "." ? "" : rel;
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const rel = relative(rootResolved, candidateResolved);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function traversalError(error: unknown): SecurityError {
  const code = error !== null && typeof error === "object" && "code" in error ? String((error as { readonly code?: unknown }).code) : "";
  if (code === "ELOOP") return new SecurityError("security:symlink_cycle", "Symlink cycle prevents safe path resolution.");
  return new SecurityError("security:path_invalid", "Path cannot be safely resolved.");
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try { return await lstat(path); }
  catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? String((error as { readonly code?: unknown }).code) : "";
    if (code === "ENOENT") return undefined;
    throw traversalError(error);
  }
}

export async function resolveSafePath(root: string, candidate: string, allowedExternalRoots: readonly string[] = []): Promise<string> {
  const candidateAbsolute = resolve(root, portable(candidate));
  const allowed = [root, ...allowedExternalRoots].map((value) => resolve(value));
  if (!allowed.some((base) => isWithinRoot(base, candidateAbsolute))) throw new SecurityError("security:path_outside_workspace", "Path is outside configured roots.");
  let existingPath = candidateAbsolute;
  let existing = await safeLstat(existingPath);
  while (!existing && allowed.some((base) => isWithinRoot(base, existingPath))) {
    const parent = dirname(existingPath);
    if (parent === existingPath) break;
    existingPath = parent;
    existing = await safeLstat(existingPath);
  }
  if (existing) {
    let target: string;
    try { target = await realpath(existingPath); } catch (error) { throw traversalError(error); }
    if (!allowed.some((base) => isWithinRoot(base, target))) throw new SecurityError("security:path_outside_workspace", "Symlink target escapes configured roots.");
  }
  if (existing && (existing.isBlockDevice() || existing.isCharacterDevice() || existing.isFIFO() || existing.isSocket())) throw new SecurityError("security:path_invalid", "Special files are not source artifacts.");
  return candidateAbsolute;
}
