import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NATIVE_NPM_PACKAGE_NAMES, NATIVE_NPM_PACKAGES, NPM_PUBLIC_PACKAGE_NAMES, PRODUCTION_PACKAGE_NAMES, SUPPORTED_TARGETS } from "../scripts/release-contract.mjs";
import { cleanProductionBuildOutputs, createNativePlatformPublishManifest, createPublishManifest, productionPackageVersions, publicationOrder, ROOT, validatePublishManifest } from "../scripts/package-npm.mjs";

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
    expect([...versions.keys()]).toEqual(NPM_PUBLIC_PACKAGE_NAMES);
    expect(versions.get("urdira")).toBe("0.3.3");
    expect(versions.get("@urdira/runtime")).toBe("0.3.3");
    expect(versions.get("@urdira/cli")).toBe("0.3.3");
    expect(versions.get("@urdira/daemon")).toBe("0.3.3");
    expect(versions.get("@urdira/mcp")).toBe("0.3.3");
    expect(versions.get("@urdira/web")).toBe("0.3.3");
    expect(versions.get("@urdira/plugin-javascript-typescript")).toBe("0.6.0");
    for (const name of NATIVE_NPM_PACKAGE_NAMES) expect(versions.get(name), name).toBe(versions.get("@urdira/native"));
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
      if (name === "@urdira/native") {
        expect(manifest["files"]).not.toContain("prebuilds");
        expect(manifest.optionalDependencies).toEqual(Object.fromEntries(NATIVE_NPM_PACKAGE_NAMES.map((packageName: string) => [packageName, versions.get("@urdira/native")])));
      }
    }
    for (const target of SUPPORTED_TARGETS) {
      const manifest = createNativePlatformPublishManifest({
        target,
        version: versions.get("@urdira/native")!,
        addonDigest: `sha256:${"a".repeat(64)}`,
        workerDigest: `sha256:${"b".repeat(64)}`,
      });
      packages.push({ name: manifest.name, manifest });
      expect(manifest.name).toBe(NATIVE_NPM_PACKAGES[target]);
      expect(validatePublishManifest(manifest, versions), manifest.name).toEqual([]);
      expect(manifest).not.toHaveProperty("private");
      expect(manifest).not.toHaveProperty("scripts");
      expect(JSON.stringify(manifest)).not.toContain("workspace:");
      expect(manifest["files"]).toEqual(["native", "README.md", "LICENSE"]);
      expect(manifest["urdiraNative"]).toMatchObject({ worker_protocol: "urdira.ipc.v2", binding_api: 16, node_api: 10 });
    }
    const order = publicationOrder(packages);
    for (const entry of packages) for (const dependency of Object.keys({ ...(entry.manifest.dependencies ?? {}), ...(entry.manifest.optionalDependencies ?? {}) }).filter((name) => versions.has(name))) {
      expect(order.indexOf(dependency), `${dependency} must publish before ${entry.name}`).toBeLessThan(order.indexOf(entry.name));
    }
    for (const name of NATIVE_NPM_PACKAGE_NAMES) expect(order.indexOf(name)).toBeLessThan(order.indexOf("@urdira/native"));
  });
});
