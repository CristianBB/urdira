import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseMetadata, sha256 } from "../scripts/release-contract.mjs";
import { inspectProductionTree, inspectReleaseArchive, writeDeterministicArchive } from "../scripts/package-release.mjs";

describe("Phase 14 deterministic package builder", () => {
  it("creates byte-identical archives from the same production tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase14-archive-"));
    const first = join(root, "first");
    const second = join(root, "second");
    const archiveOne = join(root, "one.tar.gz");
    const archiveTwo = join(root, "two.tar.gz");
    await (await import("node:fs/promises")).mkdir(join(first, "dist"), { recursive: true });
    await (await import("node:fs/promises")).writeFile(join(first, "dist/index.js"), "export const stable = true;\n");
    await (await import("node:fs/promises")).writeFile(join(first, "release.json"), "{}\n");
    await (await import("node:fs/promises")).mkdir(second, { recursive: true });
    await (await import("node:fs/promises")).cp(first, second, { recursive: true });
    const one = await writeDeterministicArchive(first, archiveOne);
    const two = await writeDeterministicArchive(second, archiveTwo);
    expect(one.digest).toBe(two.digest);
    expect(await readFile(archiveOne)).toEqual(await readFile(archiveTwo));
  });

  it("reports clean production membership and preserves release identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase14-inspect-"));
    const metadata = buildReleaseMetadata({ gitCommit: "abc", lockfileDigest: sha256("lock") });
    await (await import("node:fs/promises")).mkdir(join(root, "node_modules", "@urdira", "engine", "dist"), { recursive: true });
    await (await import("node:fs/promises")).writeFile(join(root, "node_modules", "@urdira", "engine", "dist", "index.js"), "export {};\n");
    await (await import("node:fs/promises")).writeFile(join(root, "release.json"), `${JSON.stringify(metadata)}\n`);
    const inspection = await inspectProductionTree(root);
    expect(inspection.forbidden).toHaveLength(0);
    expect(inspection.symlinks).toHaveLength(0);
    expect(inspection.files).toContain("node_modules/@urdira/engine/dist/index.js");
    expect(metadata).toMatchObject({ semantic_model: { model_id: "Xenova/all-MiniLM-L6-v2", bundled_assets: false } });
  });

  it("inspects the emitted archive bytes and verifies embedded checksums", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase14-archive-inspect-"));
    const payload = join(root, "payload.txt");
    const archive = join(root, "release.tar.gz");
    await mkdir(root, { recursive: true });
    await writeFile(payload, "payload\n");
    await writeFile(join(root, "checksums.sha256"), `${sha256(await readFile(payload))}  payload.txt\n`);
    await writeDeterministicArchive(root, archive);
    const inspection = await inspectReleaseArchive(archive);
    expect(inspection.errors).toEqual([]);
    expect(inspection.checksum_failures).toEqual([]);
    expect(inspection.forbidden).toEqual([]);
    expect(inspection.symlinks).toEqual([]);
  });
});
