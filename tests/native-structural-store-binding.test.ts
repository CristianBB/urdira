import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureNativeStructuralStoreAddonPath, loadNativeStructuralStoreAddon } from "../packages/engine/src/native-structural-store-binding.js";

afterEach(() => { configureNativeStructuralStoreAddonPath(undefined); vi.unstubAllEnvs(); });

it("uses the composition-pinned addon instead of a checkout or ambient override and invalidates its cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "urdira-pinned-addon-"));
  try {
    const paths = [join(root, "first.cjs"), join(root, "second.cjs")];
    for (const [index, path] of paths.entries()) await writeFile(path, `exports.NativeStoreBuilder=class Builder${index} {}; exports.NativeStructuralStoreHandle=class Handle${index} {};`);
    vi.stubEnv("URDIRA_NATIVE_ADDON_PATH", join(root, "missing.node"));
    configureNativeStructuralStoreAddonPath(paths[0]);
    const first = loadNativeStructuralStoreAddon();
    expect(first.NativeStoreBuilder.name).toBe("Builder0");
    expect(loadNativeStructuralStoreAddon()).toBe(first);
    configureNativeStructuralStoreAddonPath(paths[1]);
    expect(loadNativeStructuralStoreAddon().NativeStoreBuilder.name).toBe("Builder1");
    configureNativeStructuralStoreAddonPath(undefined);
    expect(() => loadNativeStructuralStoreAddon()).toThrow("missing.node");
  } finally { await rm(root, { recursive: true, force: true }); }
});
