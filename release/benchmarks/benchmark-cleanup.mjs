import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

export const DEFINITIVE_MINIMUM_FREE_BYTES = 53_687_091_200;

/** Parse BENCH_MIN_FREE_BYTES without silently weakening a cleanup guard. */
export function parseMinimumFreeBytes(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  if (!/^\d+$/u.test(text)) throw new Error("BENCH_MIN_FREE_BYTES must be a non-negative integer");
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error("BENCH_MIN_FREE_BYTES must be a non-negative integer");
  return parsed;
}

export function assertCleanupGateOpen(path) {
  if (!existsSync(path)) return;
  let detail = "cleanup checkpoint is blocked";
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    detail = parsed?.blockers?.join("; ") || detail;
  } catch (error) {
    detail = `cleanup checkpoint marker is unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  throw new Error(`Cleanup checkpoint blocks the next cell: ${path}; ${detail}`);
}

function measurePath(path, errors) {
  if (!existsSync(path)) return 0;
  try {
    const entry = lstatSync(path);
    if (!entry.isDirectory()) return entry.size;
    let total = 0;
    for (const child of readdirSync(path)) total += measurePath(resolve(path, child), errors);
    return total;
  } catch (error) {
    errors.push(`unable to measure ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function filesystemSnapshot(path, errors) {
  try {
    const stats = statfsSync(path);
    const df = spawnSync("df", ["-Pk", path], { encoding: "utf8" });
    const dfRaw = `${df.stdout ?? ""}${df.stderr ?? ""}`;
    if (df.status !== 0) errors.push(`df failed for ${path}: ${dfRaw}`);
    return {
      path: resolve(path),
      free_bytes: Number(stats.bavail) * Number(stats.bsize),
      total_bytes: Number(stats.blocks) * Number(stats.bsize),
      available_blocks: Number(stats.bavail),
      block_size: Number(stats.bsize),
      df_raw: dfRaw,
      df_status: df.status,
    };
  } catch (error) {
    errors.push(`unable to inspect filesystem ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return { path: resolve(path), free_bytes: null, total_bytes: null, available_blocks: null, block_size: null, df_raw: null, df_status: null };
  }
}

function snapshot(registeredPaths, filesystemPath, listOwnedProcesses) {
  const errors = [];
  const paths = Object.fromEntries(registeredPaths.map((path) => [path, { exists: existsSync(path), bytes: measurePath(path, errors) }]));
  let ownedProcesses = [];
  try {
    const listed = listOwnedProcesses();
    if (!Array.isArray(listed)) errors.push("owned process inventory is not an array");
    else ownedProcesses = listed;
  } catch (error) {
    errors.push(`unable to inspect owned processes: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { paths, filesystem: filesystemSnapshot(filesystemPath, errors), owned_processes: ownedProcesses, errors };
}

function residuePaths(after) {
  return Object.entries(after.paths).filter(([, value]) => value.exists || value.bytes !== 0).map(([path]) => path);
}

/**
 * Run the mandatory per-cell cleanup checkpoint and persist its evidence.
 * A missing inventory, residue, owned process, cleanup error, or free-space
 * violation blocks the next cell. The callback owns only registered roots.
 */
export async function runCleanupCheckpoint({
  manifestPath,
  registeredPaths,
  filesystemPath,
  minimumFreeBytes = null,
  cleanup,
  listOwnedProcesses,
  metadata = {},
}) {
  const blockers = [];
  let parsedMinimum = null;
  try { parsedMinimum = parseMinimumFreeBytes(minimumFreeBytes); }
  catch (error) { blockers.push(`invalid free-space guard: ${error instanceof Error ? error.message : String(error)}`); }
  const normalizedPaths = [...new Set(registeredPaths.map((path) => resolve(path)))];
  const before = snapshot(normalizedPaths, filesystemPath, listOwnedProcesses);
  blockers.push(...before.errors);
  let cleanupResult = null;
  try { cleanupResult = await cleanup(); }
  catch (error) { blockers.push(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
  const after = snapshot(normalizedPaths, filesystemPath, listOwnedProcesses);
  blockers.push(...after.errors);
  const residue = residuePaths(after);
  if (residue.length > 0) blockers.push(`registered residue: ${residue.join(", ")}`);
  if (after.owned_processes.length > 0) blockers.push(`owned processes remain: ${after.owned_processes.map((entry) => entry.pid ?? "unknown").join(", ")}`);
  if (parsedMinimum !== null && (after.filesystem.free_bytes === null || after.filesystem.free_bytes < parsedMinimum)) {
    blockers.push(`free space ${after.filesystem.free_bytes ?? "unknown"} is below ${parsedMinimum}`);
  }
  const result = {
    schema_version: 1,
    ...metadata,
    status: blockers.length === 0 ? "passed" : "blocked",
    blockers,
    minimum_free_bytes: parsedMinimum,
    registered_paths: normalizedPaths,
    before,
    after,
    cleanup_result: cleanupResult,
  };
  try {
    mkdirSync(dirname(resolve(manifestPath)), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    result.manifest_path = resolve(manifestPath);
    try { readFileSync(manifestPath, "utf8"); }
    catch (error) { result.status = "blocked"; result.blockers.push(`cleanup manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`); }
  } catch (error) {
    result.status = "blocked";
    result.blockers.push(`cleanup manifest could not be written: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

export { measurePath };
