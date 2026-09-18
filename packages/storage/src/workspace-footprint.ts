import { lstat, readdir, rm } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

/**
 * v4 (plan `generic-waddling-hartmanis.md` §6, Frente H): the single
 * canonical list of every file/directory that can belong to one workspace's
 * on-disk footprint under a `workspaces/`-style directory, keyed by its
 * `safeId` (the sanitized basename `InstallationCatalog.defaultWorkspacePath`
 * -- `storage.ts` -- derives from a workspace id, or equivalently the
 * `<name>` a database path's own basename yields once its `.sqlite` suffix
 * is stripped, for a workspace whose database was relocated away from the
 * default path).
 *
 * This is the ONE place that lists the shape of a workspace's footprint --
 * `recreate-outdated.ts`'s move-aside step, `purgeWorkspace`'s destructive
 * delete, and the daemon's orphan sweep (`packages/daemon/src/orphan-sweep.ts`)
 * all build their candidate paths from this function instead of maintaining
 * their own copies of the suffix list, so a newly introduced sidecar file
 * only ever needs to be added here.
 */
export type WorkspaceFootprintEntryKind = "database" | "lock" | "structural" | "lexical" | "semantic" | "sidecar" | "unknown";

export interface WorkspaceFootprintEntry {
  readonly path: string;
  readonly kind: WorkspaceFootprintEntryKind;
  readonly is_directory: boolean;
}

export interface DiskUsage {
  readonly logical_bytes: number;
  readonly allocated_bytes: number | null;
  readonly file_count: number;
  readonly directory_count: number;
}

export interface MeasuredWorkspaceFootprintEntry extends DiskUsage {
  readonly name: string;
  readonly kind: WorkspaceFootprintEntryKind;
  readonly present: boolean;
}

export interface WorkspaceFootprintMeasurement {
  readonly total: DiskUsage;
  readonly layers: Readonly<Record<"catalog" | "structural" | "lexical" | "semantic" | "scan_sidecar" | "locks", DiskUsage>>;
  readonly structural: Readonly<Record<"base" | "deltas" | "merkle" | "readers" | "manifests" | "other", DiskUsage>>;
  readonly entries: readonly MeasuredWorkspaceFootprintEntry[];
}

const emptyUsage = (): DiskUsage => ({ logical_bytes: 0, allocated_bytes: 0, file_count: 0, directory_count: 0 });

function addUsage(left: DiskUsage, right: DiskUsage): DiskUsage {
  return {
    logical_bytes: left.logical_bytes + right.logical_bytes,
    allocated_bytes: left.allocated_bytes === null || right.allocated_bytes === null ? null : left.allocated_bytes + right.allocated_bytes,
    file_count: left.file_count + right.file_count,
    directory_count: left.directory_count + right.directory_count,
  };
}

function allocatedBytes(blocks: unknown): number | null {
  return typeof blocks === "number" && Number.isSafeInteger(blocks) && blocks >= 0 ? blocks * 512 : null;
}

/**
 * Measures one file tree without following symbolic links. Logical bytes are
 * regular-file/symlink lengths; allocated bytes use POSIX stat blocks when
 * available and are `null` on platforms that do not expose them.
 */
export async function measureDiskUsage(path: string): Promise<DiskUsage & { readonly present: boolean }> {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...emptyUsage(), present: false };
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    return { logical_bytes: metadata.size, allocated_bytes: allocatedBytes(metadata.blocks), file_count: 1, directory_count: 0, present: true };
  }
  let usage: DiskUsage = { logical_bytes: 0, allocated_bytes: allocatedBytes(metadata.blocks), file_count: 0, directory_count: 1 };
  for (const child of await readdir(path)) {
    const measured = await measureDiskUsage(join(path, child));
    usage = addUsage(usage, measured);
  }
  return { ...usage, present: true };
}

function structuralSection(structuralRoot: string, path: string): keyof WorkspaceFootprintMeasurement["structural"] {
  const components = relative(structuralRoot, path).split(sep);
  const first = components[0] ?? "";
  if (first.startsWith("base-")) return "base";
  if (first.startsWith("delta-")) return "deltas";
  if (first === "merkle") return "merkle";
  if (first === ".readers") return "readers";
  if (first === "MANIFEST" || first.startsWith("MANIFEST.")) return "manifests";
  return "other";
}

async function measureStructuralSections(structuralRoot: string): Promise<WorkspaceFootprintMeasurement["structural"]> {
  const sections: Record<keyof WorkspaceFootprintMeasurement["structural"], DiskUsage> = {
    base: emptyUsage(), deltas: emptyUsage(), merkle: emptyUsage(), readers: emptyUsage(), manifests: emptyUsage(), other: emptyUsage(),
  };
  let children: string[];
  try { children = await readdir(structuralRoot); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return sections;
    throw error;
  }
  for (const child of children) {
    const path = join(structuralRoot, child);
    const section = structuralSection(structuralRoot, path);
    sections[section] = addUsage(sections[section], await measureDiskUsage(path));
  }
  return sections;
}

/** Read-only, live/best-effort accounting of one workspace-owned footprint. */
export async function measureWorkspaceFootprint(directory: string, safeId: string): Promise<WorkspaceFootprintMeasurement> {
  const canonicalEntries = workspaceFootprintEntries(directory, safeId);
  const entries: MeasuredWorkspaceFootprintEntry[] = [];
  for (const entry of canonicalEntries) {
    const measured = await measureDiskUsage(entry.path);
    entries.push({ name: basename(entry.path), kind: entry.kind, ...measured });
  }
  const byKinds = (...kinds: readonly WorkspaceFootprintEntryKind[]): DiskUsage => entries.filter((entry) => kinds.includes(entry.kind)).reduce<DiskUsage>(addUsage, emptyUsage());
  const total = entries.reduce<DiskUsage>(addUsage, emptyUsage());
  return {
    total,
    layers: {
      catalog: byKinds("database"),
      structural: byKinds("structural"),
      lexical: byKinds("lexical"),
      semantic: byKinds("semantic"),
      scan_sidecar: byKinds("sidecar"),
      locks: byKinds("lock"),
    },
    structural: await measureStructuralSections(join(directory, `${safeId}.structural`)),
    entries,
  };
}

/**
 * Ordered longest-suffix-first so a caller classifying an arbitrary on-disk
 * name (the daemon's orphan sweep) never mismatches `<id>.lexical.sqlite-wal`
 * as a bare `<id>....sqlite-wal` (`database`) sibling of a DIFFERENT,
 * truncated id -- see `classifyWorkspaceFootprintEntryName` below, the only
 * other consumer of this table.
 */
// Hand-ordered longest-suffix-first (verified by this module's own
// `WORKSPACE_FOOTPRINT_SUFFIXES` unit test, `tests/phase-daemon-orphan-sweep.test.ts`):
// 27, 21, 21, 20, 20, 17, 16, 15, 11, 11, 11, 8, 7 characters. Written out
// (rather than `.sort()`ed at module load) so the array literal stays a
// `readonly`, precisely-typed tuple list without a widening cast.
export const WORKSPACE_FOOTPRINT_SUFFIXES: readonly { readonly suffix: string; readonly kind: WorkspaceFootprintEntryKind; readonly is_directory: boolean }[] = [
  { suffix: ".sqlite.urdira-writer.lock", kind: "lock", is_directory: false },
  { suffix: ".semantic.sqlite-wal", kind: "semantic", is_directory: false },
  { suffix: ".semantic.sqlite-shm", kind: "semantic", is_directory: false },
  { suffix: ".lexical.sqlite-wal", kind: "lexical", is_directory: false },
  { suffix: ".lexical.sqlite-shm", kind: "lexical", is_directory: false },
  { suffix: ".semantic.sqlite", kind: "semantic", is_directory: false },
  { suffix: ".lexical.sqlite", kind: "lexical", is_directory: false },
  { suffix: ".sqlite-journal", kind: "database", is_directory: false },
  { suffix: ".sqlite-wal", kind: "database", is_directory: false },
  { suffix: ".sqlite-shm", kind: "database", is_directory: false },
  { suffix: ".structural", kind: "structural", is_directory: true },
  { suffix: ".sidecar", kind: "sidecar", is_directory: true },
  { suffix: ".sqlite", kind: "database", is_directory: false },
];

/**
 * The canonical footprint for one workspace's `safeId` under `directory`
 * (normally `<data_root>/workspaces`, but `recreate-outdated.ts` reuses this
 * against a database's own containing directory, which is only ever the
 * same thing under a different name for a relocated database): the catalog
 * database and its WAL/SHM/rollback-journal siblings, its writer-lock
 * marker, the native structural store directory, the two TypeScript sidecar
 * databases (lexical/semantic) with their own WAL/SHM siblings, and the
 * Rust-side scan sidecar directory (`sidecarScanDirFor`, `@urdira/engine`'s
 * `workspace-v4-bootstrap.ts`).
 */
export function workspaceFootprintEntries(directory: string, safeId: string): readonly WorkspaceFootprintEntry[] {
  return WORKSPACE_FOOTPRINT_SUFFIXES.map(({ suffix, kind, is_directory }) => ({ path: join(directory, `${safeId}${suffix}`), kind, is_directory }));
}

/**
 * Removes a set of footprint entries. `keep_database` (R16,
 * `docs/decisions` amendment for workspace purge ordering) skips every
 * `"database"`-kind entry -- the catalogued `.sqlite`/`-wal`/`-shm`/
 * `-journal` files -- so `purgeWorkspace` can delete every sidecar first and
 * the database itself only afterward: a crash between the two calls then
 * always leaves a database with no still-registered tombstone alongside it
 * (this function's own last step, deleting the database, still runs before
 * `purgeWorkspace` deletes the catalog row), never the reverse -- an
 * orphaned, already-tombstoned database with live sidecars an operator has
 * no way to discover other than this same sweep.
 *
 * `fs.rm`'s own `recursive` option is a no-op for a plain file, so this
 * always passes `recursive: true` regardless of `is_directory` rather than
 * branching on it; `force: true` makes an already-absent entry (the common
 * case -- most workspaces never ran lexical/semantic maintenance) silently
 * succeed exactly like `recreateOutdatedWorkspaceDatabase`'s own
 * access-then-skip loop.
 */
export async function removeWorkspaceFootprint(entries: readonly WorkspaceFootprintEntry[], options: { readonly keep_database: boolean }): Promise<{ readonly removed: readonly string[] }> {
  const removed: string[] = [];
  for (const entry of entries) {
    if (options.keep_database && entry.kind === "database") continue;
    await rm(entry.path, { recursive: true, force: true });
    removed.push(entry.path);
  }
  return { removed };
}
