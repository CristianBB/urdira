import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RELEASE_COMPONENTS, assertReleaseBinding } from "../release/benchmarks/release-binding.mjs";
import { writeDeterministicArchive } from "../scripts/package-release.mjs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { writeUrdiraIsolatedShim } from "../release/benchmarks/urdira-isolated-shim.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("benchmark release binding", () => {
  it("creates a shim that executes the supplied verified archive launcher and worker", () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-release-shim-"));
    roots.push(root);
    const shim = join(root, "bin", "urdira");
    mkdirSync(join(root, "bin"), { recursive: true });
    const source = writeUrdiraIsolatedShim(shim, { node: "/verified/node", cli: "/verified/archive/bin/urdira.mjs", dataRoot: "/cell/data", worker: "/verified/archive/native/urdira-indexing-worker", endpoint: "/cell/data/daemon.sock" });
    expect(source).toContain("CLI='/verified/archive/bin/urdira.mjs'");
    expect(source).toContain("/verified/archive/bin/urdira.mjs");
    expect(source).toContain("/verified/archive/native/urdira-indexing-worker");
    expect(readFileSync(shim, "utf8")).toBe(source);
  });

  it("records archive and extracted component digests", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-release-binding-"));
    roots.push(root);
    const archiveRoot = join(root, "archive");
    const archivePath = join(root, "release.tar.gz");
    mkdirSync(join(archiveRoot, "bin"), { recursive: true });
    writeFileSync(join(archiveRoot, "bin", "urdira.mjs"), "launcher\n");
    await writeDeterministicArchive(archiveRoot, archivePath);
    const result = assertReleaseBinding({ archiveRoot, archivePath, components: { launcher: "bin/urdira.mjs" } });
    expect(result.status).toBe("passed");
    expect(result.archive.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.components.launcher.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(readFileSync(archivePath).byteLength).toBeGreaterThan(0);
  });

  it("fails closed for missing archive roots, archive bytes, and components", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-release-binding-"));
    roots.push(root);
    expect(() => assertReleaseBinding({ archiveRoot: join(root, "missing"), archivePath: join(root, "missing.tar.gz"), components: { launcher: "bin/urdira.mjs" } })).toThrow(/release archive root/iu);
    mkdirSync(join(root, "archive"), { recursive: true });
    await writeDeterministicArchive(join(root, "archive"), join(root, "release.tar.gz"));
    expect(() => assertReleaseBinding({ archiveRoot: join(root, "archive"), archivePath: join(root, "release.tar.gz"), components: { launcher: "bin/urdira.mjs" } })).toThrow(/missing archive component/iu);
  });

  it("rejects an extracted component tampered after archive creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-release-binding-"));
    roots.push(root);
    const archiveRoot = join(root, "archive");
    const archivePath = join(root, "release.tar.gz");
    mkdirSync(join(archiveRoot, "bin"), { recursive: true });
    writeFileSync(join(archiveRoot, "bin", "urdira.mjs"), "launcher\n");
    await writeDeterministicArchive(archiveRoot, archivePath);
    writeFileSync(join(archiveRoot, "bin", "urdira.mjs"), "tampered\n");
    expect(() => assertReleaseBinding({ archiveRoot, archivePath, components: { launcher: "bin/urdira.mjs" } })).toThrow(/do not match extracted root/iu);
  });

  it("binds the runner preflight to argv paths without invoking a model", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-release-binding-"));
    roots.push(root);
    const archiveRoot = join(root, "archive");
    const archivePath = join(root, "release.tar.gz");
    for (const [label, relativePath] of Object.entries(DEFAULT_RELEASE_COMPONENTS)) {
      const path = join(archiveRoot, relativePath);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `${label}\n`);
    }
    await writeDeterministicArchive(archiveRoot, archivePath);
    const result = spawnSync(process.execPath, [resolve("release/benchmarks/expanded-agent-benchmark-runner.mjs"), "--preflight-only", "--repository-id", "playwright", "--task-id", "affected-tests-deterministic", "--arm", "urdira-typescript", "--model", "gpt-5.6-luna", "--node", process.execPath, "--indexing-worker", "", "--release-root", archiveRoot, "--release-archive", archivePath], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).release_binding.status).toBe("passed");
    expect(result.stdout).toContain('"indexing_worker"');
    const mismatch = spawnSync(process.execPath, [resolve("release/benchmarks/expanded-agent-benchmark-runner.mjs"), "--preflight-only", "--repository-id", "playwright", "--task-id", "affected-tests-deterministic", "--arm", "urdira-typescript", "--model", "gpt-5.6-luna", "--node", process.execPath, "--indexing-worker", join(root, "missing-worker"), "--release-root", archiveRoot, "--release-archive", archivePath], { encoding: "utf8" });
    expect(mismatch.status).not.toBe(0);
    expect(`${mismatch.stdout}\n${mismatch.stderr}`).toMatch(/custom indexing worker|verified archive worker/iu);
  });

  it("rejects extracted symlinks that escape the release root", async () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-release-binding-"));
    roots.push(root);
    const archiveRoot = join(root, "archive");
    const sourceRoot = join(root, "source");
    const archivePath = join(root, "release.tar.gz");
    mkdirSync(join(archiveRoot, "bin"), { recursive: true });
    mkdirSync(join(sourceRoot, "bin"), { recursive: true });
    writeFileSync(join(root, "outside"), "outside\n");
    writeFileSync(join(sourceRoot, "bin", "urdira.mjs"), "outside\n");
    symlinkSync(join(root, "outside"), join(archiveRoot, "bin", "urdira.mjs"));
    await writeDeterministicArchive(sourceRoot, archivePath);
    expect(() => assertReleaseBinding({ archiveRoot, archivePath, components: { launcher: "bin/urdira.mjs" } })).toThrow(/missing archive component|escapes extracted root/iu);
  });
});
