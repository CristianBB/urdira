import { access, mkdir, rename } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

/**
 * v4 destructive-cutover helper (plan §9): "v4 destructivo sin migración".
 * When a workspace database is at an outdated index contract (a v3 database
 * opened by v4 code, or vice versa), there is no in-place migration -- the
 * only supported recovery is to move every file belonging to that database
 * out of the way (never delete: the operator can always recover it by hand)
 * and let the daemon schedule a full rescan against a fresh database at the
 * same path. This mirrors `v3-migration.ts`'s "never delete, sibling root"
 * pattern, but scoped to a single workspace's files rather than a whole data
 * root.
 *
 * Not wired into any open path yet -- P4 calls this from the daemon's
 * `core:index_contract_unsupported`/`storage:workspace_format_outdated`
 * handling (see docs/evidence/2026-09-02-v4-p2-1-schema.md).
 */
export interface RecreateOutdatedWorkspaceDatabaseInput {
  /** The data root the workspace's directory lives under; used only to produce a friendlier relative path in the log line. */
  readonly rootDir: string;
  readonly workspaceId: string;
  /** Absolute path to the outdated `<name>.sqlite` file. */
  readonly databasePath: string;
  /** Why the database is being moved aside, e.g. an error code or message -- included verbatim in the log line. */
  readonly reason: string;
  /** Defaults to writing one line to stderr. */
  readonly logger?: (line: string) => void;
  /** Defaults to `Date.now()`; overridable for deterministic tests. */
  readonly now?: () => number;
}

export interface RecreateOutdatedWorkspaceDatabaseResult {
  /** Absolute path to the new `<name>.v3.stale-<timestamp>` directory every moved file/directory now lives under. */
  readonly staleDirectory: string;
  /** Absolute destination paths of everything that was actually moved (present-but-absent siblings, e.g. no `-wal` file, are silently skipped). */
  readonly movedPaths: readonly string[];
}

function staleTimestamp(now: number): string {
  // Filesystem-safe: no ":" (Windows-hostile) or "." (collides with the
  // extension-stripping this module also relies on for readability).
  return new Date(now).toISOString().replace(/[:.]/gu, "-");
}

export async function recreateOutdatedWorkspaceDatabase(input: RecreateOutdatedWorkspaceDatabaseInput): Promise<RecreateOutdatedWorkspaceDatabaseResult> {
  const log = input.logger ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const directory = dirname(input.databasePath);
  const fileName = basename(input.databasePath);
  const name = fileName.endsWith(".sqlite") ? fileName.slice(0, -".sqlite".length) : fileName;
  const staleDirectory = join(directory, `${name}.v3.stale-${staleTimestamp((input.now ?? Date.now)())}`);
  await mkdir(staleDirectory, { recursive: true });

  // Every file/directory that can belong to this one workspace's on-disk
  // footprint (plan §1): the catalog database and its WAL/SHM/writer-lock
  // siblings, the native structural store directory, and the two sidecar
  // databases (with their own WAL/SHM siblings) if lexical/semantic
  // maintenance ever ran against this workspace.
  const candidates = [
    fileName,
    `${fileName}-wal`,
    `${fileName}-shm`,
    `${fileName}.urdira-writer.lock`,
    `${name}.structural`,
    `${name}.lexical.sqlite`,
    `${name}.lexical.sqlite-wal`,
    `${name}.lexical.sqlite-shm`,
    `${name}.semantic.sqlite`,
    `${name}.semantic.sqlite-wal`,
    `${name}.semantic.sqlite-shm`,
  ];

  const movedPaths: string[] = [];
  for (const candidate of candidates) {
    const source = join(directory, candidate);
    try { await access(source); } catch { continue; }
    const destination = join(staleDirectory, candidate);
    await rename(source, destination);
    movedPaths.push(destination);
  }

  const displayPath = relative(input.rootDir, input.databasePath) || input.databasePath;
  log(`[urdira] workspace ${input.workspaceId}'s database (${displayPath}) is at an outdated index contract (${input.reason}); moved ${movedPaths.length} file(s)/directory(ies) to ${staleDirectory} -- nothing was deleted. Re-register or rescan the workspace to reindex from scratch.`);

  return { staleDirectory, movedPaths };
}

const OUTDATED_WORKSPACE_ERROR_CODES = new Set(["core:index_contract_unsupported", "storage:workspace_format_outdated"]);

/** Recognizes the two error codes an outdated-schema open path raises today (schema.ts's `ensureWorkspaceSchemaCompatibility(V4)` and storage.ts's `ensureIdentityFormat`). */
export function isOutdatedWorkspaceError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && OUTDATED_WORKSPACE_ERROR_CODES.has(code);
}
