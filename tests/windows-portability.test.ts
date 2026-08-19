import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FileStagingStore, stagingFileEntryName, stagingOperationEntryName } from "../packages/security/src/staging.js";
import { casHashFromStorageRelativePath, storageFilesystemEntryName } from "../packages/storage/src/lifecycle.js";
import { normalizeLocalIpcEndpoint } from "../packages/daemon/src/protocol.js";
import { semanticProcessEntryPath } from "../packages/daemon/src/semantic-process.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const WINDOWS_FORBIDDEN_ENTRY_CHARACTERS = /[<>:"/\\|?*]/u;

describe("Windows portability preflight", () => {
  it("maps logical IDs to deterministic portable filesystem entries", () => {
    const logicalId = `model-pack:sha256:${"a".repeat(64)}:1`;
    const stagingEntry = stagingOperationEntryName(logicalId);
    const stagedFileEntry = stagingFileEntryName(`models/sha256:${"c".repeat(64)}`);
    const migrationEntry = storageFilesystemEntryName("migration", "migration:1:2:identifier");

    expect(stagingEntry).toMatch(/^operation-[0-9a-f]{64}$/u);
    expect(stagedFileEntry).toMatch(/^file-[0-9a-f]{64}$/u);
    expect(migrationEntry).toMatch(/^migration-[0-9a-f]{64}$/u);
    expect(WINDOWS_FORBIDDEN_ENTRY_CHARACTERS.test(stagingEntry)).toBe(false);
    expect(WINDOWS_FORBIDDEN_ENTRY_CHARACTERS.test(stagedFileEntry)).toBe(false);
    expect(WINDOWS_FORBIDDEN_ENTRY_CHARACTERS.test(migrationEntry)).toBe(false);
  });

  it("round-trips reserved logical staged paths through portable physical entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-windows-portability-"));
    const operationId = `model-pack:sha256:${"a".repeat(64)}:1`;
    const logicalPath = `models/sha256:${"c".repeat(64)}`;
    const bytes = new Uint8Array([1, 2, 3]);
    try {
      const store = new FileStagingStore(root, { platform: "win32" });
      await store.stage(operationId, [{ path: logicalPath, bytes }]);
      await expect(readdir(join(root, "staging", stagingOperationEntryName(operationId)))).resolves.toEqual([stagingFileEntryName(logicalPath)]);
      await store.commit(operationId);
      await expect(store.readPublishedFile(operationId, logicalPath)).resolves.toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("decodes CAS paths with POSIX or Windows separators", () => {
    const hex = "b".repeat(64);
    expect(casHashFromStorageRelativePath(`${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4)}`)).toBe(`sha256:${hex}`);
    expect(casHashFromStorageRelativePath(`${hex.slice(0, 2)}\\${hex.slice(2, 4)}\\${hex.slice(4)}`)).toBe(`sha256:${hex}`);
  });

  it("normalizes local IPC and child-process paths through platform adapters", () => {
    const endpoint = "D:\\a\\urdira\\data\\daemon.sock";
    expect(normalizeLocalIpcEndpoint(endpoint, "win32")).toMatch(/^\\\\\.\\pipe\\urdira-[0-9a-f]{64}$/u);

    const packageUrl = "file:///D:/a/urdira/packages/daemon/dist/index.js";
    expect(semanticProcessEntryPath("semantic-maintenance-process.js", packageUrl)).toBe(fileURLToPath(new URL("semantic-maintenance-process.js", packageUrl)));
  });

  it("pins public checkout text and synthetic worktrees to deterministic line endings", async () => {
    await expect(readFile(join(repositoryRoot, ".gitattributes"), "utf8")).resolves.toContain("* text=auto eol=lf");
    await expect(readFile(join(repositoryRoot, "tests", "phase-workspace-fork.test.ts"), "utf8")).resolves.toContain('git_(root, "config", "core.autocrlf", "false")');
  });

  it("uses generic local-path hygiene without embedding a developer home directory", async () => {
    const checker = await readFile(join(repositoryRoot, "scripts", "check-publication.mjs"), "utf8");
    expect(checker).toContain("localProjectPathPatterns");
    expect(checker).toContain("[^/\\s]+");
    expect(checker).not.toMatch(/\/Users\/[A-Za-z0-9._-]+\//u);
  });
});
