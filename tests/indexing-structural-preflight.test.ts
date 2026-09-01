import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { directoryBytes } from "../scripts/directory-bytes.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("structural preflight disk accounting", () => {
  it("ignores only files that disappear between enumeration and stat", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-preflight-disk-accounting-"));
    roots.push(root);
    const stable = join(root, "stable.db");
    const transient = join(root, "transient.tmp");
    await writeFile(stable, Buffer.alloc(17));
    await writeFile(transient, Buffer.alloc(29));

    const paths = ["stable.db", "transient.tmp"];
    expect(await directoryBytes(root, paths, async (path) => {
      if (path === transient) throw Object.assign(new Error("disappeared"), { code: "ENOENT" });
      return { size: 17 };
    })).toBe(17);
    await expect(directoryBytes(root, paths, async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    })).rejects.toThrow(/permission denied/iu);
  });
});
