import { mkdtemp, readFile, writeFile, mkdir, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { smokeNativeArchive } from "../scripts/smoke-native-archive.mjs";
import { buildReleaseMetadata, sha256 } from "../scripts/release-contract.mjs";
import { inspectProductionTree, inspectReleaseArchive, stageProductionTree, writeDeterministicArchive } from "../scripts/package-release.mjs";
import { NATIVE_NPM_PACKAGE_NAMES, PRODUCTION_PACKAGE_NAMES } from "../scripts/release-contract.mjs";

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

  it("retains native platform optional dependencies in a staged release package", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase14-native-deps-"));
    const stage = join(root, "stage");
    try {
      await writeFile(join(root, "README.md"), "fixture\n");
      await writeFile(join(root, "LICENSE"), "fixture\n");
      for (const name of PRODUCTION_PACKAGE_NAMES) {
        const directory = name === "urdira"
          ? join(root, "apps", "bootstrap")
          : name === "@urdira/runtime"
            ? join(root, "apps", "urdira")
            : join(root, "packages", name.slice("@urdira/".length));
        await mkdir(join(directory, "dist"), { recursive: true });
        await writeFile(join(directory, "dist", "index.js"), "export {};\n");
        const manifest = { name, version: "0.3.0", type: "module" };
        await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest)}\n`);
      }
      for (const name of NATIVE_NPM_PACKAGE_NAMES) {
        const directory = join(root, "node_modules", ...name.split("/"));
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "package.json"), `${JSON.stringify({ name, version: "0.3.0" })}\n`);
      }
      await stageProductionTree({
        rootDir: root,
        stageRoot: stage,
        targetId: "darwin-arm64",
        metadata: buildReleaseMetadata({ gitCommit: "fixture", lockfileDigest: sha256("lock") }),
        nativeRequired: false,
      });
      const staged = JSON.parse(await readFile(join(stage, "node_modules", "@urdira", "native", "package.json"), "utf8"));
      expect(staged.optionalDependencies).toEqual(Object.fromEntries(NATIVE_NPM_PACKAGE_NAMES.map((packageName) => [packageName, "0.3.0"])));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it.runIf(process.platform !== "win32")("smokes the complete native closure including the indexing worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "urdira-native-closure-test-"));
  const tree = join(root, "tree");
  await mkdir(join(tree, "native"), { recursive: true });
  await mkdir(join(tree, "bin"), { recursive: true });
  for (const name of ["manifest.json", "urdira-native.node", "urdira-jsts-syntax-worker", "urdira-indexing-worker"]) await writeFile(join(tree, "native", name), "fixture");
  await writeFile(join(tree, "native", "urdira-indexing-worker"), "#!/bin/sh\nexit 0\n");
  await writeFile(join(tree, "release.json"), JSON.stringify({ target: "darwin-arm64", engine_version: "0.3.3" }));
  const launcher = join(tree, "bin", "urdira");
  await writeFile(launcher, "#!/bin/sh\nprintf '0.3.3\\n'\n");
  await chmod(launcher, 0o755);
  const archive = join(root, "closure.tar.gz");
  await writeDeterministicArchive(tree, archive);
  await expect(smokeNativeArchive(archive)).resolves.toMatchObject({ native_files: expect.arrayContaining(["urdira-indexing-worker"]), version: "0.3.3" });
});
