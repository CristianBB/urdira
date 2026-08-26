import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCTION_PACKAGE_NAMES } from "../scripts/release-contract.mjs";
import { cleanProductionBuildOutputs, createPublishManifest, productionPackageVersions, publicationOrder, ROOT, validatePublishManifest } from "../scripts/package-npm.mjs";

describe("public npm package graph", () => {
  it("removes stale compiler output before building release tarballs", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "urdira-package-clean-"));
    const projectRoot = join(fixtureRoot, "project");
    const staleOutput = join(projectRoot, "dist", "removed-module.js");
    try {
      await mkdir(join(projectRoot, "dist"), { recursive: true });
      await writeFile(staleOutput, "export const stale = true;\n");

      await cleanProductionBuildOutputs([projectRoot]);

      await expect(readFile(staleOutput, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("publishes only the production allowlist with exact internal versions", async () => {
    const versions = await productionPackageVersions();
    expect([...versions.keys()]).toEqual(PRODUCTION_PACKAGE_NAMES);
    expect(versions.get("urdira")).toBe("0.3.3");
    expect(versions.get("@urdira/runtime")).toBe("0.3.3");
    expect(versions.get("@urdira/cli")).toBe("0.3.3");
    expect(versions.get("@urdira/daemon")).toBe("0.3.3");
    expect(versions.get("@urdira/mcp")).toBe("0.3.3");
    expect(versions.get("@urdira/web")).toBe("0.3.3");
    expect(versions.get("@urdira/plugin-javascript-typescript")).toBe("0.4.0");
    expect(versions.has("@urdira/testkit")).toBe(false);

    const packages = [];
    for (const name of PRODUCTION_PACKAGE_NAMES) {
      const directory = name === "urdira"
        ? join(ROOT, "apps", "bootstrap")
        : name === "@urdira/runtime"
          ? join(ROOT, "apps", "urdira")
          : join(ROOT, "packages", name.slice("@urdira/".length));
      const source = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      const manifest = createPublishManifest(source, versions);
      packages.push({ name, manifest });
      expect(validatePublishManifest(manifest, versions), name).toEqual([]);
      expect(JSON.stringify(manifest), name).not.toContain("workspace:");
      expect(manifest).not.toHaveProperty("private");
      if (name === "urdira") {
        expect(manifest.dependencies).toBeUndefined();
        expect(manifest).toHaveProperty("urdiraRuntime", { package: "@urdira/runtime", version: "0.3.3" });
      }
    }
    const order = publicationOrder(packages);
    for (const entry of packages) for (const dependency of Object.keys(entry.manifest.dependencies ?? {}).filter((name) => versions.has(name))) {
      expect(order.indexOf(dependency), `${dependency} must publish before ${entry.name}`).toBeLessThan(order.indexOf(entry.name));
    }
  });
});
