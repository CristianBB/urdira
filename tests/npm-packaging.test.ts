import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCTION_PACKAGE_NAMES } from "../scripts/release-contract.mjs";
import { createPublishManifest, productionPackageVersions, publicationOrder, ROOT, validatePublishManifest } from "../scripts/package-npm.mjs";

describe("public npm package graph", () => {
  it("publishes only the production allowlist with exact internal versions", async () => {
    const versions = await productionPackageVersions();
    expect([...versions.keys()]).toEqual(PRODUCTION_PACKAGE_NAMES);
    expect(versions.get("urdira")).toBe("0.1.1");
    expect(versions.get("@urdira/runtime")).toBe("0.1.1");
    expect(versions.get("@urdira/plugin-javascript-typescript")).toBe("0.3.1");
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
        expect(manifest).toHaveProperty("urdiraRuntime", { package: "@urdira/runtime", version: "0.1.1" });
      }
    }
    const order = publicationOrder(packages);
    for (const entry of packages) for (const dependency of Object.keys(entry.manifest.dependencies ?? {}).filter((name) => versions.has(name))) {
      expect(order.indexOf(dependency), `${dependency} must publish before ${entry.name}`).toBeLessThan(order.indexOf(entry.name));
    }
  });
});
