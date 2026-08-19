import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_VERSION,
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

describe("dependency-free runtime bootstrap", () => {
  it("binds one bootstrap release to one exact runtime and reviewed script closure", () => {
    expect(BOOTSTRAP_VERSION).toBe("0.2.0");
    expect(RUNTIME_PACKAGE_NAME).toBe("@urdira/runtime");
    expect(RUNTIME_VERSION).toBe("0.2.0");
    expect(RUNTIME_INSTALL_SCRIPT_APPROVALS).toEqual({
      "onnxruntime-node@1.24.3": true,
      "sharp@0.35.3": true,
      "@parcel/watcher@2.6.0": true,
      "protobufjs@7.6.5": true,
    });

    const plan = createRuntimePreparationPlan("/var/lib/urdira");
    expect(plan).toMatchObject({
      package_name: "@urdira/runtime",
      package_version: "0.2.0",
      minimum_npm_version: "11.16.0",
      registry: "https://registry.npmjs.org/",
      known_upstream_notices: ["boolean@3.2.0 is deprecated through @huggingface/transformers@4.2.0 -> onnxruntime-node@1.24.3 -> global-agent@3.0.0."],
    });
    expect(plan.install_scripts).toEqual(Object.keys(RUNTIME_INSTALL_SCRIPT_APPROVALS));
  });

  it("discloses the npm version required by the strict install-script policy", () => {
    expect(createRuntimePreparationPlan("/var/lib/urdira").minimum_npm_version).toBe("11.16.0");
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

  it("atomically activates a validated runtime after explicit confirmation", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-bootstrap-success-"));
    const result = await prepareRuntime({
      data_root: dataRoot,
      confirm: true,
      install: async ({ staging_root }) => {
        const privateManifest = JSON.parse(await readFile(join(staging_root, "package.json"), "utf8"));
        expect(privateManifest).toMatchObject({
          dependencies: { "@urdira/runtime": "0.2.0" },
          overrides: { "adm-zip": "0.6.0", sharp: "0.35.3" },
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
      interactive: true,
      resolve_entrypoint: async () => undefined,
      prompt: async (message) => {
        expect(message).toContain("onnxruntime-node@1.24.3");
        expect(message).toContain("boolean@3.2.0");
        return true;
      },
      prepare_runtime: async (options) => {
        expect(options.confirm).toBe(true);
        return { status: "prepared", plan: createRuntimePreparationPlan(options.data_root), entrypoint };
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
