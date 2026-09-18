import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { measureWorkspaceFootprint } from "../packages/storage/src/index.js";

describe("workspace footprint measurement", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("accounts for every workspace-owned layer and separates structural base, deltas, Merkle data, and reader markers", async () => {
    root = await mkdtemp(join(tmpdir(), "urdira-workspace-footprint-"));
    const safeId = "workspace_fixture";
    const structural = join(root, `${safeId}.structural`);
    await mkdir(join(structural, "base-1"), { recursive: true });
    await mkdir(join(structural, "merkle"), { recursive: true });
    await mkdir(join(structural, ".readers"), { recursive: true });
    await mkdir(join(root, `${safeId}.sidecar`, "scratch"), { recursive: true });

    await Promise.all([
      writeFile(join(root, `${safeId}.sqlite`), Buffer.alloc(10)),
      writeFile(join(root, `${safeId}.sqlite-wal`), Buffer.alloc(3)),
      writeFile(join(root, `${safeId}.sqlite.urdira-writer.lock`), Buffer.alloc(5)),
      writeFile(join(root, `${safeId}.lexical.sqlite`), Buffer.alloc(7)),
      writeFile(join(root, `${safeId}.lexical.sqlite-wal`), Buffer.alloc(11)),
      writeFile(join(root, `${safeId}.semantic.sqlite`), Buffer.alloc(13)),
      writeFile(join(structural, "MANIFEST"), Buffer.alloc(17)),
      writeFile(join(structural, "base-1", "records.keys"), Buffer.alloc(19)),
      writeFile(join(structural, "delta-2.seg"), Buffer.alloc(23)),
      writeFile(join(structural, "merkle", "records.tree"), Buffer.alloc(29)),
      writeFile(join(structural, ".readers", "reader.json"), Buffer.alloc(31)),
      writeFile(join(root, `${safeId}.sidecar`, "scratch", "scan.tmp"), Buffer.alloc(37)),
    ]);

    const footprint = await measureWorkspaceFootprint(root, safeId);

    expect(footprint.total.logical_bytes).toBe(205);
    expect(footprint.layers.catalog.logical_bytes).toBe(13);
    expect(footprint.layers.lexical.logical_bytes).toBe(18);
    expect(footprint.layers.semantic.logical_bytes).toBe(13);
    expect(footprint.layers.locks.logical_bytes).toBe(5);
    expect(footprint.layers.scan_sidecar.logical_bytes).toBe(37);
    expect(footprint.layers.structural.logical_bytes).toBe(119);
    expect(footprint.structural).toMatchObject({
      base: { logical_bytes: 19 },
      deltas: { logical_bytes: 23 },
      merkle: { logical_bytes: 29 },
      readers: { logical_bytes: 31 },
      manifests: { logical_bytes: 17 },
      other: { logical_bytes: 0 },
    });
    expect(footprint.entries.filter((entry) => entry.present).map((entry) => entry.name)).not.toContain(expect.stringContaining(root));
    expect(footprint.total.file_count).toBe(12);
    expect(footprint.total.allocated_bytes === null || footprint.total.allocated_bytes >= 0).toBe(true);
  });

  it("reports absent optional layers as zero without creating them", async () => {
    root = await mkdtemp(join(tmpdir(), "urdira-workspace-footprint-empty-"));
    const footprint = await measureWorkspaceFootprint(root, "missing");
    expect(footprint.total).toEqual({ logical_bytes: 0, allocated_bytes: 0, file_count: 0, directory_count: 0 });
    expect(footprint.entries.every((entry) => entry.present === false)).toBe(true);
  });
});
