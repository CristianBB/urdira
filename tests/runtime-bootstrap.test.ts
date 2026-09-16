import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_VERSION,
  MINIMUM_NODE_VERSION,
  RUNTIME_INSTALL_SCRIPT_APPROVALS,
  RUNTIME_PACKAGE_NAME,
  RUNTIME_VERSION,
  classifyNpmWarnings,
  createRuntimePreparationPlan,
  prepareRuntime,
  runBootstrap,
  runtimePaths,
} from "../apps/bootstrap/src/runtime-bootstrap.js";

const knownDeprecation = "npm warn deprecated boolean@3.2.0: Package no longer supported. Contact Support at https://www.npmjs.com/support for more info.";

async function installFakeRuntime(stagingRoot: string) {
  const packageRoot = join(stagingRoot, "node_modules", "@urdira", "runtime");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: RUNTIME_PACKAGE_NAME, version: RUNTIME_VERSION }));
  await writeFile(join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\n");
  await writeFile(join(stagingRoot, "package-lock.json"), "{}\n");
  return { stdout: "added packages", stderr: `${knownDeprecation}\n`, npm_version: "11.16.0" };
}

function writeCatalog(dataRoot: string, contract?: number): void {
  const database = new DatabaseSync(join(dataRoot, "catalog.sqlite"));
  try {
    database.exec("CREATE TABLE storage_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL) STRICT");
    if (contract !== undefined) database.prepare("INSERT INTO storage_meta(key, value) VALUES ('index_contract', ?)").run(Uint8Array.of(contract));
  } finally {
    database.close();
  }
}

describe("dependency-free runtime bootstrap", () => {
  it("binds one bootstrap release to one exact runtime and reviewed script closure", () => {
    expect(BOOTSTRAP_VERSION).toBe("0.4.0");
    expect(RUNTIME_PACKAGE_NAME).toBe("@urdira/runtime");
    expect(RUNTIME_VERSION).toBe("0.4.0");
    expect(MINIMUM_NODE_VERSION).toBe("24.18.1");
    expect(RUNTIME_INSTALL_SCRIPT_APPROVALS).toEqual({
      "onnxruntime-node@1.24.3": true,
      "sharp@0.35.3": true,
      "@parcel/watcher@2.6.0": true,
      "protobufjs@7.6.5": true,
    });

    const plan = createRuntimePreparationPlan("/var/lib/urdira");
    expect(plan).toMatchObject({
      package_name: "@urdira/runtime",
      package_version: "0.4.0",
      minimum_node_version: "24.18.1",
      minimum_npm_version: "11.16.0",
      registry: "https://registry.npmjs.org/",
      known_upstream_notices: ["boolean@3.2.0 is deprecated through @huggingface/transformers@4.2.0 -> onnxruntime-node@1.24.3 -> global-agent@3.0.0."],
    });
    expect(plan.install_scripts).toEqual(Object.keys(RUNTIME_INSTALL_SCRIPT_APPROVALS));
  });

  it("discloses the npm version required by the strict install-script policy", () => {
    expect(createRuntimePreparationPlan("/var/lib/urdira").minimum_npm_version).toBe("11.16.0");
  });

  it("refuses an unsupported Node runtime before executing the prepared application", async () => {
    let executed = false;
    const result = await runBootstrap(["daemon", "start"], {
      node_version: "24.14.0",
      resolve_entrypoint: async () => "/private/runtime/cli.js",
      execute_runtime: async () => { executed = true; return 0; },
    });
    expect(result).toMatchObject({ exit_code: 2, stdout: "" });
    expect(result.stderr).toContain("requires Node >=24.18.1; found 24.14.0");
    expect(executed).toBe(false);
  });

  it("classifies only the disclosed upstream warning as acknowledged", () => {
    expect(classifyNpmWarnings(`${knownDeprecation}\n`)).toEqual({ acknowledged: [knownDeprecation], unknown: [] });
    expect(classifyNpmWarnings(`${knownDeprecation}\nnpm warn deprecated surprise@1.0.0: unexpected\n`)).toEqual({
      acknowledged: [knownDeprecation],
      unknown: ["npm warn deprecated surprise@1.0.0: unexpected"],
    });
  });

  it("returns a dry-run without creating runtime state", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-bootstrap-dry-run-"));
    const result = await prepareRuntime({ data_root: dataRoot, confirm: false });
    expect(result.status).toBe("preview");
    await expect(readFile(runtimePaths(dataRoot).manifest, "utf8")).rejects.toThrow();
  });

  it("discloses and applies the destructive reset required by a pre-v3 data root", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-bootstrap-pre-v3-"));
    await prepareRuntime({
      data_root: dataRoot,
      confirm: true,
      install: async ({ staging_root }) => installFakeRuntime(staging_root),
    });
    const legacySentinel = join(dataRoot, "legacy-index.bin");
    await writeFile(legacySentinel, "legacy");
    writeCatalog(dataRoot);

    const preview = await runBootstrap(["runtime", "prepare", "--dry-run"], { data_root: dataRoot });
    expect(preview.exit_code).toBe(0);
    expect(preview.stdout).toContain("Data root state: pre-v3");
    expect(preview.stdout).toContain(`Destructive reset: permanently remove ${dataRoot}`);
    await expect(readFile(legacySentinel, "utf8")).resolves.toBe("legacy");

    let replacementInstalls = 0;
    const prepared = await prepareRuntime({
      data_root: dataRoot,
      confirm: true,
      install: async ({ staging_root }) => {
        replacementInstalls += 1;
        return installFakeRuntime(staging_root);
      },
    });
    expect(prepared).toMatchObject({ status: "prepared", data_root_reset: true });
    expect(replacementInstalls).toBe(1);
    await expect(readFile(legacySentinel, "utf8")).rejects.toThrow();
    await expect(readFile(runtimePaths(dataRoot).manifest, "utf8")).resolves.toContain(`"runtime_version": "${RUNTIME_VERSION}"`);
  });

  it("preserves a valid v3 data root during runtime preparation", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-bootstrap-v3-"));
    const currentSentinel = join(dataRoot, "current-index.bin");
    await writeFile(currentSentinel, "current");
    writeCatalog(dataRoot, 0x33);

    const prepared = await prepareRuntime({
      data_root: dataRoot,
      confirm: true,
      install: async ({ staging_root }) => installFakeRuntime(staging_root),
    });
    expect(prepared).toMatchObject({ status: "prepared", data_root_reset: false });
    await expect(readFile(currentSentinel, "utf8")).resolves.toBe("current");
  });

  it("does not reuse a runtime prepared by an older bootstrap authority", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-bootstrap-compatible-"));
    writeCatalog(dataRoot, 0x33);
    await prepareRuntime({
      data_root: dataRoot,
      confirm: true,
      install: async ({ staging_root }) => installFakeRuntime(staging_root),
    });
    const paths = runtimePaths(dataRoot);
    const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
    await writeFile(paths.manifest, `${JSON.stringify({ ...manifest, bootstrap_version: "0.3.2" }, null, 2)}\n`);
    await expect(prepareRuntime({
      data_root: dataRoot,
      confirm: true,
      install: async () => { throw new Error("an invalid active runtime must not be overwritten"); },
    })).rejects.toThrow("Runtime target already exists but is invalid");
  });

  it("refuses destructive reset while a daemon process still owns the legacy root", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-bootstrap-live-legacy-"));
    const legacySentinel = join(dataRoot, "legacy-index.bin");
    await writeFile(legacySentinel, "legacy");
    await writeFile(join(dataRoot, "daemon.lock"), JSON.stringify({ pid: process.pid }));
    writeCatalog(dataRoot);

    await expect(prepareRuntime({
      data_root: dataRoot,
      confirm: true,
      install: async ({ staging_root }) => installFakeRuntime(staging_root),
    })).rejects.toThrow("Stop the running Urdira daemon before confirming the destructive v3 reset");
    await expect(readFile(legacySentinel, "utf8")).resolves.toBe("legacy");
  });

  it("refuses destructive reset through a symbolic-link data root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "urdira-bootstrap-symlink-"));
    const target = join(parent, "legacy-target");
    const dataRoot = join(parent, "configured-root");
    await mkdir(target);
    await writeFile(join(target, "legacy-index.bin"), "legacy");
    writeCatalog(target);
    await symlink(target, dataRoot, "dir");

    await expect(prepareRuntime({
      data_root: dataRoot,
      confirm: true,
      install: async ({ staging_root }) => installFakeRuntime(staging_root),
    })).rejects.toThrow("symbolic-link data root");
    await expect(readFile(join(target, "legacy-index.bin"), "utf8")).resolves.toBe("legacy");
  });

  it("preserves the complete legacy root when replacement installation fails", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-bootstrap-install-failure-"));
    const legacySentinel = join(dataRoot, "legacy-index.bin");
    await writeFile(legacySentinel, "legacy");
    writeCatalog(dataRoot);

    await expect(prepareRuntime({
      data_root: dataRoot,
      confirm: true,
      install: async () => { throw new Error("simulated replacement failure"); },
    })).rejects.toThrow("simulated replacement failure");
    await expect(readFile(legacySentinel, "utf8")).resolves.toBe("legacy");
    await expect(readFile(join(dataRoot, "catalog.sqlite"))).resolves.toBeInstanceOf(Buffer);
  });

  it("cancels deletion when the catalog contract changes during staging", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-bootstrap-contract-race-"));
    const legacySentinel = join(dataRoot, "legacy-index.bin");
    await writeFile(legacySentinel, "legacy");
    writeCatalog(dataRoot);

    await expect(prepareRuntime({
      data_root: dataRoot,
      confirm: true,
      install: async ({ staging_root }) => {
        const database = new DatabaseSync(join(dataRoot, "catalog.sqlite"));
        try { database.prepare("INSERT INTO storage_meta(key, value) VALUES ('index_contract', ?)").run(Uint8Array.of(0x33)); }
        finally { database.close(); }
        return installFakeRuntime(staging_root);
      },
    })).rejects.toThrow("Data-root state changed during runtime preparation (v3)");
    await expect(readFile(legacySentinel, "utf8")).resolves.toBe("legacy");
  });

  it("atomically activates a validated runtime after explicit confirmation", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-bootstrap-success-"));
    const result = await prepareRuntime({
      data_root: dataRoot,
      confirm: true,
      install: async ({ staging_root }) => {
        const privateManifest = JSON.parse(await readFile(join(staging_root, "package.json"), "utf8"));
        expect(privateManifest).toMatchObject({
          dependencies: { "@urdira/runtime": "0.4.0" },
          overrides: { "adm-zip": "0.6.0", sharp: "0.35.3", protobufjs: "7.6.5" },
          allowScripts: RUNTIME_INSTALL_SCRIPT_APPROVALS,
        });
        const packageRoot = join(staging_root, "node_modules", "@urdira", "runtime");
        await mkdir(join(packageRoot, "dist"), { recursive: true });
        await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: RUNTIME_PACKAGE_NAME, version: RUNTIME_VERSION }));
        await writeFile(join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\n");
        await writeFile(join(staging_root, "package-lock.json"), "{}\n");
        return { stdout: "added packages", stderr: `${knownDeprecation}\n`, npm_version: "11.16.0" };
      },
    });

    expect(result.status).toBe("prepared");
    const paths = runtimePaths(dataRoot);
    expect(JSON.parse(await readFile(paths.manifest, "utf8"))).toMatchObject({
      bootstrap_version: BOOTSTRAP_VERSION,
      runtime_package: RUNTIME_PACKAGE_NAME,
      runtime_version: RUNTIME_VERSION,
      acknowledged_npm_warnings: [knownDeprecation],
    });
    await expect(readFile(paths.entrypoint, "utf8")).resolves.toContain("node");
  });

  it("does not activate a runtime when npm reports any undisclosed warning", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-bootstrap-warning-"));
    await expect(prepareRuntime({
      data_root: dataRoot,
      confirm: true,
      install: async () => ({ stdout: "", stderr: "npm warn deprecated surprise@1.0.0: unexpected\n", npm_version: "11.16.0" }),
    })).rejects.toThrow(/undisclosed npm warning/i);
    await expect(readFile(runtimePaths(dataRoot).manifest, "utf8")).rejects.toThrow();
  });

  it("refuses implicit preparation for non-interactive commands", async () => {
    let prepared = false;
    const result = await runBootstrap(["status"], {
      data_root: "/tmp/urdira-not-prepared",
      node_version: "24.18.1",
      interactive: false,
      resolve_entrypoint: async () => undefined,
      prepare_runtime: async () => {
        prepared = true;
        throw new Error("must not run");
      },
    });
    expect(result).toMatchObject({ exit_code: 2, stdout: "" });
    expect(result.stderr).toContain("urdira runtime prepare --dry-run");
    expect(prepared).toBe(false);
  });

  it("prepares after an interactive explanation and then delegates the original command", async () => {
    const calls: string[] = [];
    const entrypoint = "/private/runtime/cli.js";
    const result = await runBootstrap(["status", "--json"], {
      data_root: "/tmp/urdira-interactive",
      node_version: "24.18.1",
      interactive: true,
      resolve_entrypoint: async () => undefined,
      prompt: async (message) => {
        expect(message).toContain("onnxruntime-node@1.24.3");
        expect(message).toContain("boolean@3.2.0");
        return true;
      },
      prepare_runtime: async (options) => {
        expect(options.confirm).toBe(true);
        return { status: "prepared", plan: createRuntimePreparationPlan(options.data_root), entrypoint, data_root_reset: false };
      },
      execute_runtime: async (target, argv) => {
        calls.push(target, ...argv);
        return 0;
      },
    });
    expect(result.exit_code).toBe(0);
    expect(calls).toEqual([entrypoint, "status", "--json"]);
  });
});
