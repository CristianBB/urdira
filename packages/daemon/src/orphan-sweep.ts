import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_FOOTPRINT_SUFFIXES, type WorkspaceFootprintEntryKind } from "@urdira/storage";

/**
 * v4 (plan `generic-waddling-hartmanis.md` §6, Frente H, R15): finds
 * on-disk leftovers under `<data_root>/workspaces` that no registered (or
 * removed-but-in-grace) workspace owns any more -- the actual root cause a
 * pre-this-frente `purgeWorkspace` left behind (it deleted only the four
 * catalog-database files, never `.structural/`, the sidecar databases, or
 * `.sidecar/` -- see `storage.ts`'s `purgeWorkspace` doc comment), plus
 * anything a crashed process left mid-operation (a `.v3.stale-*` move-aside
 * directory, a `.fork-staging-*` copy-then-rename staging directory).
 *
 * Grouping: every top-level directory entry under `workspacesDir` is
 * classified by the LONGEST footprint suffix it ends with (so
 * `<id>.lexical.sqlite-wal` groups under `<id>`, never under the
 * nonexistent `<id>.lexical.sqlite-wa`-minus-suffix id a shorter, wrong
 * suffix match would yield) -- see `classifyWorkspaceDataDirEntryName`.
 * Three outcomes per entry, per R15:
 *  - `retained_stale`: a `<id>.v3.stale-<timestamp>` directory
 *    (`recreateOutdatedWorkspaceDatabase`'s own output). NEVER a purge
 *    candidate, unconditionally, regardless of whether `<id>` is known --
 *    it is deliberately preserved recovery evidence.
 *  - `in_progress`: a `<id>....fork-staging-<uuid>` directory
 *    (`forkV4StructuralStore`'s copy-then-rename staging root,
 *    `@urdira/engine`'s `workspace-fork.ts`) less than one hour old. A
 *    normal, momentary artifact of a fork in flight; never a purge
 *    candidate while young, REGARDLESS of whether its derived id is
 *    "known" (the target workspace usually IS already registered while its
 *    fork is running -- that is exactly why age, not the known-id check,
 *    gates this category).
 *  - everything else groups by its derived footprint id: skipped when that
 *    id is in `knownSafeIds` (a currently registered or removed-but-in-
 *    grace workspace's own, expected files); otherwise an orphan --
 *    including a `.fork-staging-*` directory older than one hour, which
 *    graduates from `in_progress` to `orphans` regardless of `knownSafeIds`
 *    (stale fork staging is never anyone's expected footprint).
 */

export type { WorkspaceFootprintEntryKind };

export interface OrphanEntry {
  readonly path: string;
  readonly bytes: number;
  readonly kind: WorkspaceFootprintEntryKind;
}

export interface OrphanGroup {
  readonly safe_id: string;
  readonly entries: readonly OrphanEntry[];
  readonly total_bytes: number;
  readonly first_seen_mtime: number;
}

export interface OrphanReport {
  readonly orphans: readonly OrphanGroup[];
  readonly retained_stale: readonly OrphanGroup[];
  readonly in_progress: readonly OrphanGroup[];
}

export interface SweepWorkspaceDataDirOptions {
  readonly workspacesDir: string;
  readonly knownSafeIds: ReadonlySet<string>;
  /** Defaults to `Date.now`; overridable for deterministic tests. */
  readonly now?: () => number;
}

const FORK_STAGING_IN_PROGRESS_MS = 60 * 60 * 1000;

interface ClassifiedEntryName {
  readonly safeId: string;
  readonly kind: WorkspaceFootprintEntryKind;
  readonly category: "footprint" | "stale" | "staging";
}

const STALE_SUFFIX_PATTERN = /^(.*)\.v3\.stale-[^/]+$/u;
// `forkV4StructuralStore` appends `.fork-staging-<uuid>` directly onto its
// `targetStructuralRoot`, which itself already ends in `.structural` -- so
// the on-disk name is `<safeId>.structural.fork-staging-<uuid>`. The
// `(?:\.structural)?` keeps this pattern correct even if a future staging
// root is created directly off some other footprint suffix.
const FORK_STAGING_SUFFIX_PATTERN = /^(.*?)(?:\.structural)?\.fork-staging-[^/]+$/u;

/** Exported for direct unit coverage (`tests/phase-daemon-orphan-sweep.test.ts`) independent of the filesystem walk below. */
export function classifyWorkspaceDataDirEntryName(name: string): ClassifiedEntryName {
  const staleMatch = STALE_SUFFIX_PATTERN.exec(name);
  if (staleMatch) return { safeId: staleMatch[1]!, kind: "unknown", category: "stale" };

  const stagingMatch = FORK_STAGING_SUFFIX_PATTERN.exec(name);
  if (stagingMatch) return { safeId: stagingMatch[1]!, kind: "structural", category: "staging" };

  for (const { suffix, kind } of WORKSPACE_FOOTPRINT_SUFFIXES) {
    if (name.length > suffix.length && name.endsWith(suffix)) return { safeId: name.slice(0, -suffix.length), kind, category: "footprint" };
  }
  // No recognized footprint suffix at all: still surfaced (as its own,
  // whole-name "id") rather than silently ignored -- an operator reviewing
  // `urdira workspace orphans` should see genuinely unexpected files too,
  // never a directory this sweep quietly skipped.
  return { safeId: name, kind: "unknown", category: "footprint" };
}

async function directorySizeBytes(directoryPath: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const fullPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) { total += await directorySizeBytes(fullPath); continue; }
    try { total += (await stat(fullPath)).size; } catch { /* vanished mid-walk: best-effort size, never fatal. */ }
  }
  return total;
}

interface WorkingEntry { readonly path: string; readonly bytes: number; readonly kind: WorkspaceFootprintEntryKind; readonly mtimeMs: number; }
interface WorkingGroup { readonly safeId: string; readonly category: ClassifiedEntryName["category"]; readonly entries: WorkingEntry[]; }

function finishGroup(group: WorkingGroup): OrphanGroup {
  const totalBytes = group.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const firstSeenMtime = Math.min(...group.entries.map((entry) => entry.mtimeMs));
  return {
    safe_id: group.safeId,
    entries: group.entries.map(({ path, bytes, kind }) => ({ path, bytes, kind })),
    total_bytes: totalBytes,
    first_seen_mtime: firstSeenMtime,
  };
}

/**
 * The orphan sweep itself: `readdir` + one `stat` (recursive for a
 * directory) per top-level entry under `workspacesDir`, well under the
 * "< 50 ms" cost this frente's plan calls for at typical fleet sizes.
 * Never throws: an absent `workspacesDir` (a fresh installation with no
 * workspace added yet) yields an empty report rather than an error, and any
 * OTHER `readdir` failure is the one case this function does propagate --
 * the daemon's own call site (`DaemonRuntime.start`) is responsible for
 * catching and logging that so a sweep failure never fails startup (R15's
 * "the sweep must never fail startup" invariant lives there, not here, so
 * the RPC handlers that also call this function still see real errors
 * instead of a silently-empty report).
 */
export async function sweepWorkspaceDataDir(options: SweepWorkspaceDataDirOptions): Promise<OrphanReport> {
  const now = (options.now ?? Date.now)();
  let dirents;
  try {
    dirents = await readdir(options.workspacesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { orphans: [], retained_stale: [], in_progress: [] };
    throw error;
  }

  const groups = new Map<string, WorkingGroup>();
  for (const dirent of dirents) {
    const classified = classifyWorkspaceDataDirEntryName(dirent.name);
    const fullPath = join(options.workspacesDir, dirent.name);
    let mtimeMs = now;
    let bytes = 0;
    try {
      const stats = await stat(fullPath);
      mtimeMs = stats.mtimeMs;
      bytes = stats.isDirectory() ? await directorySizeBytes(fullPath) : stats.size;
    } catch {
      continue; // Vanished between readdir and stat: another sweep/purge already handled it.
    }
    const key = `${classified.category}:${classified.safeId}`;
    const group = groups.get(key) ?? { safeId: classified.safeId, category: classified.category, entries: [] };
    group.entries.push({ path: fullPath, bytes, kind: classified.kind, mtimeMs });
    groups.set(key, group);
  }

  const orphans: OrphanGroup[] = [];
  const retainedStale: OrphanGroup[] = [];
  const inProgress: OrphanGroup[] = [];

  for (const group of groups.values()) {
    if (group.category === "stale") { retainedStale.push(finishGroup(group)); continue; }
    if (group.category === "staging") {
      const finished = finishGroup(group);
      if (now - finished.first_seen_mtime < FORK_STAGING_IN_PROGRESS_MS) inProgress.push(finished);
      else orphans.push(finished);
      continue;
    }
    if (options.knownSafeIds.has(group.safeId)) continue;
    orphans.push(finishGroup(group));
  }

  return { orphans, retained_stale: retainedStale, in_progress: inProgress };
}
