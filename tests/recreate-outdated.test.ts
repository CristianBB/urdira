import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isOutdatedWorkspaceError, recreateOutdatedWorkspaceDatabase } from "../packages/storage/src/recreate-outdated.js";
import { StorageError } from "../packages/storage/src/errors.js";

describe("recreateOutdatedWorkspaceDatabase", () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("moves every present sibling into a new stale directory and never deletes", async () => {
    root = await mkdtemp(join(tmpdir(), "urdira-recreate-outdated-"));
    const workspacesDir = join(root, "workspaces");
    await mkdir(workspacesDir, { recursive: true });
    const databasePath = join(workspacesDir, "workspace_abc.sqlite");
    await writeFile(databasePath, "db");
    await writeFile(`${databasePath}-wal`, "wal");
    await writeFile(`${databasePath}-shm`, "shm");
    await writeFile(`${databasePath}-journal`, "journal");
    await writeFile(`${databasePath}.urdira-writer.lock`, "lock");
    await mkdir(join(workspacesDir, "workspace_abc.structural"), { recursive: true });
    await writeFile(join(workspacesDir, "workspace_abc.structural", "MANIFEST"), "{}");
    await writeFile(join(workspacesDir, "workspace_abc.lexical.sqlite"), "lex");
    await writeFile(join(workspacesDir, "workspace_abc.semantic.sqlite"), "sem");
    // v4 (plan §6, Frente H): the Rust scan sidecar directory -- previously
    // missing entirely from this function's own candidate list, the actual
    // gap `workspace-footprint.ts`'s shared list fixes.
    await mkdir(join(workspacesDir, "workspace_abc.sidecar"), { recursive: true });
    await writeFile(join(workspacesDir, "workspace_abc.sidecar", "scan-state"), "{}");
    // Not created: workspace_abc.lexical.sqlite-wal/-shm, semantic -wal/-shm --
    // absence of an optional sidecar sibling must not fail the move.

    const lines: string[] = [];
    const result = await recreateOutdatedWorkspaceDatabase({
      rootDir: root,
      workspaceId: "workspace:abc",
      databasePath,
      reason: "core:index_contract_unsupported",
      logger: (line) => lines.push(line),
      now: () => Date.UTC(2026, 8, 2, 12, 0, 0),
    });

    expect(result.staleDirectory).toBe(join(workspacesDir, "workspace_abc.v3.stale-2026-09-02T12-00-00-000Z"));
    expect([...result.movedPaths].sort()).toEqual([
      join(result.staleDirectory, "workspace_abc.lexical.sqlite"),
      join(result.staleDirectory, "workspace_abc.semantic.sqlite"),
      join(result.staleDirectory, "workspace_abc.sidecar"),
      join(result.staleDirectory, "workspace_abc.sqlite"),
      join(result.staleDirectory, "workspace_abc.sqlite-journal"),
      join(result.staleDirectory, "workspace_abc.sqlite-shm"),
      join(result.staleDirectory, "workspace_abc.sqlite-wal"),
      join(result.staleDirectory, "workspace_abc.sqlite.urdira-writer.lock"),
      join(result.staleDirectory, "workspace_abc.structural"),
    ].sort());

    // Nothing left at the original location.
    await expect(stat(databasePath)).rejects.toThrow();
    await expect(stat(`${databasePath}-wal`)).rejects.toThrow();
    await expect(stat(`${databasePath}-journal`)).rejects.toThrow();
    await expect(stat(join(workspacesDir, "workspace_abc.sidecar"))).rejects.toThrow();

    // Everything survives, unmodified, under the stale directory.
    expect(await readFile(join(result.staleDirectory, "workspace_abc.sqlite"), "utf8")).toBe("db");
    expect(await readFile(join(result.staleDirectory, "workspace_abc.lexical.sqlite"), "utf8")).toBe("lex");
    expect(await readFile(join(result.staleDirectory, "workspace_abc.structural", "MANIFEST"), "utf8")).toBe("{}");
    expect(await readFile(join(result.staleDirectory, "workspace_abc.sidecar", "scan-state"), "utf8")).toBe("{}");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("workspace:abc");
    expect(lines[0]).toContain("core:index_contract_unsupported");
    expect(lines[0]).toContain(result.staleDirectory);
  });

  it("tolerates a bare database file with no siblings at all", async () => {
    root = await mkdtemp(join(tmpdir(), "urdira-recreate-outdated-bare-"));
    const databasePath = join(root, "workspace_solo.sqlite");
    await writeFile(databasePath, "db");
    const result = await recreateOutdatedWorkspaceDatabase({ rootDir: root, workspaceId: "workspace:solo", databasePath, reason: "storage:workspace_format_outdated" });
    expect(result.movedPaths).toEqual([join(result.staleDirectory, "workspace_solo.sqlite")]);
  });
});

describe("isOutdatedWorkspaceError", () => {
  it("recognizes both outdated-schema error codes", () => {
    expect(isOutdatedWorkspaceError(new StorageError("core:index_contract_unsupported", "x"))).toBe(true);
    expect(isOutdatedWorkspaceError(new StorageError("storage:workspace_format_outdated", "x"))).toBe(true);
  });

  it("rejects unrelated errors and non-error values", () => {
    expect(isOutdatedWorkspaceError(new StorageError("storage:workspace_not_found", "x"))).toBe(false);
    expect(isOutdatedWorkspaceError(new Error("plain"))).toBe(false);
    expect(isOutdatedWorkspaceError(undefined)).toBe(false);
    expect(isOutdatedWorkspaceError("core:index_contract_unsupported")).toBe(false);
  });
});
