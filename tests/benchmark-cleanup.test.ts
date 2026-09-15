import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertCleanupGateOpen, runCleanupCheckpoint, parseMinimumFreeBytes } from "../release/benchmarks/benchmark-cleanup.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("benchmark cleanup checkpoint", () => {
  it("records bytes and filesystem space after registered roots are removed", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-cleanup-test-"));
    roots.push(root);
    const disposable = join(root, "disposable");
    const manifest = join(root, "cleanup.json");
    const payload = join(disposable, "payload.bin");
    mkdirSync(disposable, { recursive: true });
    writeFileSync(payload, Buffer.alloc(31));

    const result = await runCleanupCheckpoint({
      manifestPath: manifest,
      registeredPaths: [disposable],
      filesystemPath: root,
      cleanup: async () => rmSync(disposable, { recursive: true, force: true }),
      listOwnedProcesses: () => [],
    });

    expect(result.status).toBe("passed");
    expect(result.before.paths[disposable]?.bytes).toBe(31);
    expect(result.after.paths[disposable]?.bytes).toBe(0);
    expect(result.before.filesystem.free_bytes).toEqual(expect.any(Number));
    expect(result.before.filesystem.df_raw).toMatch(/Filesystem|\/dev\//u);
    expect(readFileSync(manifest, "utf8")).toContain('"status": "passed"');
  });

  it("fails closed for cleanup errors, owned processes, residue, and low free space", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-cleanup-test-"));
    roots.push(root);
    const disposable = join(root, "disposable");
    mkdirSync(disposable, { recursive: true });
    writeFileSync(join(disposable, "payload"), "residue");

    const result = await runCleanupCheckpoint({
      manifestPath: join(root, "cleanup.json"),
      registeredPaths: [disposable],
      filesystemPath: root,
      minimumFreeBytes: Number.MAX_SAFE_INTEGER,
      cleanup: async () => { throw new Error("interrupted"); },
      listOwnedProcesses: () => [{ pid: 42, command: "owned benchmark process" }],
    });

    expect(result.status).toBe("blocked");
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/cleanup failed: interrupted/iu),
      expect.stringMatching(/registered residue/iu),
      expect.stringMatching(/owned processes/iu),
      expect.stringMatching(/free space/iu),
    ]));
  });

  it("rejects invalid minimum free space values instead of treating them as zero", () => {
    expect(() => parseMinimumFreeBytes("-1")).toThrow(/non-negative integer/iu);
    expect(() => parseMinimumFreeBytes("not-a-number")).toThrow(/non-negative integer/iu);
    expect(parseMinimumFreeBytes(undefined)).toBeNull();
    expect(parseMinimumFreeBytes("0")).toBe(0);
  });

  it("blocks the next cell when a prior checkpoint marker exists", () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-cleanup-test-"));
    roots.push(root);
    const marker = join(root, "cleanup-block.json");
    writeFileSync(marker, JSON.stringify({ blockers: ["registered residue"] }));
    expect(() => assertCleanupGateOpen(marker)).toThrow(/blocks the next cell.*registered residue/iu);
    rmSync(marker);
    expect(() => assertCleanupGateOpen(marker)).not.toThrow();
  });
});
