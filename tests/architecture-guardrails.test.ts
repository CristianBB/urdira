import { readFile } from "node:fs/promises";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkArchitecture,
  loadArchitectureManifest,
  normalizeArchitecturePath,
} from "../scripts/check-architecture.mjs";

const repositoryRoot = join(import.meta.dirname, "..");

describe("architecture guardrails", { timeout: 15_000 }, () => {
  it("normalizes Windows package paths to the manifest path format", () => {
    expect(normalizeArchitecturePath("packages\\contracts")).toBe("packages/contracts");
    expect(normalizeArchitecturePath("apps/urdira")).toBe("apps/urdira");
  });

  it("covers every declared package and application entry point", async () => {
    const manifest = await loadArchitectureManifest(repositoryRoot);
    const result = await checkArchitecture(repositoryRoot, manifest);

    expect(result.errors).toEqual([]);
    expect(result.checkedPackages).toContain("@urdira/contracts");
    expect(result.checkedPackages).toContain("@urdira/security");
    expect(result.checkedPackages).toContain("urdira");
  });

  it("rejects a package that is missing from the architecture manifest", async () => {
    const root = await makeFixture({
      manifest: {
        version: 1,
        packages: [],
      },
      packageFiles: {
        "packages/rogue/package.json": JSON.stringify({
          name: "@urdira/rogue",
          version: "0.1.0",
        }),
      },
    });

    const manifest = await loadArchitectureManifest(root);
    const result = await checkArchitecture(root, manifest);

    expect(result.errors).toContain(
      "Package @urdira/rogue is not covered by the architecture manifest",
    );
  });

  it("rejects a declared dependency outside the package boundary", async () => {
    const root = await makeFixture({
      manifest: {
        version: 1,
        packages: [
          {
            name: "@urdira/contracts",
            path: "packages/contracts",
            layer: 0,
            dependencies: [],
          },
          {
            name: "@urdira/query",
            path: "packages/query",
            layer: 1,
            dependencies: ["@urdira/contracts"],
          },
        ],
      },
      packageFiles: {
        "packages/contracts/package.json": JSON.stringify({
          name: "@urdira/contracts",
          version: "0.1.0",
        }),
        "packages/query/package.json": JSON.stringify({
          name: "@urdira/query",
          version: "0.1.0",
          dependencies: { "@urdira/rogue": "workspace:*" },
        }),
      },
    });

    const manifest = await loadArchitectureManifest(root);
    const result = await checkArchitecture(root, manifest);

    expect(result.errors).toContain(
      "@urdira/query declares dependency @urdira/rogue outside its architecture boundary",
    );
  });

  it("rejects a source import that crosses a package boundary", async () => {
    const root = await makeFixture({
      manifest: {
        version: 1,
        packages: [
          {
            name: "@urdira/contracts",
            path: "packages/contracts",
            layer: 0,
            dependencies: [],
          },
          {
            name: "@urdira/query",
            path: "packages/query",
            layer: 1,
            dependencies: ["@urdira/contracts"],
          },
        ],
      },
      packageFiles: {
        "packages/contracts/package.json": JSON.stringify({
          name: "@urdira/contracts",
          version: "0.1.0",
        }),
        "packages/query/package.json": JSON.stringify({
          name: "@urdira/query",
          version: "0.1.0",
        }),
        "packages/query/src/index.ts":
          'import { rogue } from "@urdira/contracts-private";\nexport { rogue };\n',
      },
    });

    const manifest = await loadArchitectureManifest(root);
    const result = await checkArchitecture(root, manifest);

    expect(result.errors).toContain(
      "packages/query/src/index.ts imports @urdira/contracts-private, which is not an allowed dependency",
    );
  });

  it("rejects command-execution imports from production source providers", async () => {
    const root = await makeFixture({
      manifest: {
        version: 1,
        packages: [{ name: "@urdira/engine", path: "packages/engine", layer: 0, dependencies: [] }],
      },
      packageFiles: {
        "packages/engine/package.json": JSON.stringify({ name: "@urdira/engine", version: "0.1.0" }),
        "packages/engine/src/git-providers.ts": 'import { execFile } from "node:child_process";\nexport const provider = execFile;\n',
      },
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "packages/engine/src/git-providers.ts source providers cannot import command-execution module node:child_process",
    );
  });

  it("rejects command ports from production source providers", async () => {
    const root = await makeFixture({
      manifest: {
        version: 1,
        packages: [{ name: "@urdira/engine", path: "packages/engine", layer: 0, dependencies: [] }],
      },
      packageFiles: {
        "packages/engine/package.json": JSON.stringify({ name: "@urdira/engine", version: "0.1.0" }),
        "packages/engine/src/directory-provider.ts": "export interface Options { readonly command_port: { run(command: string): Promise<void> } }\n",
      },
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "packages/engine/src/directory-provider.ts source providers cannot declare or use command execution port command_port",
    );
  });

  it("rejects known scoped, bare application, and relative cross-package imports", async () => {
    const root = await makeFixture({
      manifest: {
        version: 1,
        packages: [
          {
            name: "@urdira/contracts",
            path: "packages/contracts",
            layer: 0,
            dependencies: [],
          },
          {
            name: "@urdira/storage",
            path: "packages/storage",
            layer: 1,
            dependencies: [],
          },
          {
            name: "urdira",
            path: "apps/urdira",
            layer: 2,
            dependencies: [],
          },
        ],
      },
      packageFiles: {
        "packages/contracts/package.json": JSON.stringify({
          name: "@urdira/contracts",
          version: "0.1.0",
        }),
        "packages/storage/package.json": JSON.stringify({
          name: "@urdira/storage",
          version: "0.1.0",
        }),
        "packages/storage/src/index.ts": [
          'import "@urdira/contracts";',
          'import "urdira";',
          'import "../../contracts/src/index.js";',
        ].join("\n"),
        "apps/urdira/package.json": JSON.stringify({
          name: "urdira",
          version: "0.1.0",
        }),
      },
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "packages/storage/src/index.ts imports @urdira/contracts, which is not an allowed dependency",
        "packages/storage/src/index.ts imports urdira, which is not an allowed dependency",
      ]),
    );
    expect(
      result.errors.some(
        (error) =>
          error.includes("packages/storage/src/index.ts") &&
          error.includes("relative import") &&
          error.includes("@urdira/contracts"),
      ),
    ).toBe(true);
  });

  it("rejects an allowed source import that is missing from package.json", async () => {
    const root = await makeFixture({
      manifest: {
        version: 1,
        packages: [
          {
            name: "@urdira/contracts",
            path: "packages/contracts",
            layer: 0,
            dependencies: [],
          },
          {
            name: "@urdira/storage",
            path: "packages/storage",
            layer: 1,
            dependencies: ["@urdira/contracts"],
          },
        ],
      },
      packageFiles: {
        "packages/contracts/package.json": JSON.stringify({
          name: "@urdira/contracts",
          version: "0.1.0",
        }),
        "packages/storage/package.json": JSON.stringify({
          name: "@urdira/storage",
          version: "0.1.0",
        }),
        "packages/storage/src/index.ts": 'import "@urdira/contracts";\n',
      },
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "packages/storage/src/index.ts imports @urdira/contracts without declaring the workspace dependency",
    );
  });

  it("returns validation errors for malformed manifests instead of throwing", async () => {
    const root = await makeFixture({
      manifest: {
        version: 1,
        packages: [],
      },
      packageFiles: {},
    });

    const result = await checkArchitecture(root, {
      version: 1,
      packages: [
        {},
        {
          name: "@urdira/contracts",
          path: "packages/missing",
          layer: 0,
          dependencies: ["@urdira/unknown"],
        },
      ],
      coverage: [
        { area: "duplicate", owner: "@urdira/contracts" },
        { area: "duplicate", owner: "@urdira/contracts" },
        { area: "unknown-owner", owner: "@urdira/missing" },
        { area: 42, owner: "@urdira/contracts" },
      ],
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "Architecture manifest contains an invalid package entry",
        "Manifest package @urdira/contracts is missing packages/missing/package.json",
        "@urdira/contracts allows dependency @urdira/unknown, which is not in the manifest",
        "Architecture coverage contains duplicate area duplicate",
        "Architecture area unknown-owner is owned by missing package @urdira/missing",
        "Architecture coverage contains an invalid area entry",
      ]),
    );
  });

  it("reports duplicate manifest package entries", async () => {
    const root = await makeFixture({
      manifest: {
        version: 1,
        packages: [
          {
            name: "@urdira/contracts",
            path: "packages/contracts",
            layer: 0,
            dependencies: [],
          },
          {
            name: "@urdira/contracts",
            path: "packages/contracts",
            layer: 0,
            dependencies: [],
          },
        ],
      },
      packageFiles: {
        "packages/contracts/package.json": JSON.stringify({
          name: "@urdira/contracts",
          version: "0.1.0",
        }),
      },
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "Architecture manifest contains duplicate package @urdira/contracts",
    );
  });

  it("reports duplicate manifest package paths", async () => {
    const root = await makeFixture({
      manifest: {
        version: 1,
        packages: [
          {
            name: "@urdira/contracts",
            path: "packages/contracts",
            layer: 0,
            dependencies: [],
          },
          {
            name: "@urdira/storage",
            path: "packages/contracts",
            layer: 1,
            dependencies: [],
          },
        ],
      },
      packageFiles: {
        "packages/contracts/package.json": JSON.stringify({
          name: "@urdira/contracts",
          version: "0.1.0",
        }),
      },
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "Architecture manifest contains duplicate path packages/contracts",
    );
  });

  it("reports malformed manifest dependency arrays", async () => {
    const root = await makeFixture({
      manifest: {
        version: 1,
        packages: [
          {
            name: "@urdira/contracts",
            path: "packages/contracts",
            layer: 0,
            dependencies: ["@urdira/storage", 42],
          },
        ],
      },
      packageFiles: {
        "packages/contracts/package.json": JSON.stringify({
          name: "@urdira/contracts",
          version: "0.1.0",
        }),
      },
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain("Architecture manifest contains an invalid package entry");
  });

  it("returns a validation error for a non-object manifest", async () => {
    const result = await checkArchitecture("/tmp/urdira-no-workspace", null);

    expect(result.errors).toContain("Architecture manifest must be an object");
  });

  it("returns a validation error when the manifest file is invalid JSON", async () => {
    const root = await makeFixture({
      manifest: {
        version: 1,
        packages: [],
      },
      packageFiles: {},
    });
    await writeFile(join(root, "architecture/manifest.json"), "{invalid");

    const manifest = await loadArchitectureManifest(root);
    const result = await checkArchitecture(root, manifest);

    expect(result.errors).toContain("Architecture manifest is not valid JSON");
  });

  it("rejects invalid dependency layers and coverage ownership", async () => {
    const root = await makeFixture({
      manifest: {
        version: 1,
        packages: [
          {
            name: "@urdira/contracts",
            path: "packages/contracts",
            layer: 1,
            dependencies: [],
          },
          {
            name: "@urdira/storage",
            path: "packages/storage",
            layer: 0,
            dependencies: ["@urdira/contracts"],
          },
        ],
        coverage: [{ area: "storage", owner: "@urdira/missing" }],
      },
      packageFiles: {
        "packages/contracts/package.json": JSON.stringify({
          name: "@urdira/contracts",
          version: "0.1.0",
        }),
        "packages/storage/package.json": JSON.stringify({
          name: "@urdira/storage",
          version: "0.1.0",
        }),
      },
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "@urdira/storage depends on @urdira/contracts without moving toward a lower architecture layer",
        "Architecture area storage is owned by missing package @urdira/missing",
      ]),
    );
  });

  it("uses the approved public package topology", async () => {
    const manifest = await loadArchitectureManifest(repositoryRoot);
    const packageNames = manifest.packages.map((entry) => entry.name);

    expect(packageNames).toContain("@urdira/canonical");
    expect(packageNames).toContain("@urdira/plugin-sdk");
    expect(packageNames).not.toContain("@urdira/encoding");
    expect(packageNames).not.toContain("@urdira/plugin-runtime");
    await expect(
      readFile(join(repositoryRoot, "packages/canonical/package.json"), "utf8"),
    ).resolves.toContain('"name": "@urdira/canonical"');
    await expect(
      readFile(join(repositoryRoot, "packages/plugin-runtime/package.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("requires CI to run the canonical verification, audit, and npm package smoke gates", async () => {
    const workflow = await readFile(
      join(repositoryRoot, ".github/workflows/ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("pnpm verify");
    expect(workflow).toContain("pnpm audit --prod");
    expect(workflow).toContain("pnpm package:npm:smoke");
    expect(workflow).toContain("ubuntu-latest, macos-latest, windows-latest");
  });

  it("builds every workspace package imported by application tests in a clean checkout", async () => {
    const rootManifest = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    for (const scriptName of ["test", "test:coverage"]) {
      expect(rootManifest.scripts[scriptName]).toContain("pnpm --filter @urdira/cli build");
      expect(rootManifest.scripts[scriptName]).toContain("pnpm --filter @urdira/mcp build");
    }
  });

  it("pins the supported runtime and provides strict package skeletons", async () => {
    await expect(readFile(join(repositoryRoot, ".nvmrc"), "utf8")).resolves.toBe("24.18.1\n");

    const tsconfig = JSON.parse(await readFile(join(repositoryRoot, "tsconfig.json"), "utf8")) as {
      compilerOptions: { strict?: boolean; noUncheckedIndexedAccess?: boolean };
    };
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.noUncheckedIndexedAccess).toBe(true);

    const manifest = await loadArchitectureManifest(repositoryRoot);
    for (const entry of manifest.packages) {
      await expect(readFile(join(repositoryRoot, entry.path, "package.json"), "utf8")).resolves.toBeTruthy();
      await expect(readFile(join(repositoryRoot, entry.path, "src/index.ts"), "utf8")).resolves.toContain(
        "export",
      );
    }
  });

  it("includes TypeScript sources and tests in lint and typecheck", async () => {
    const rootTsconfig = JSON.parse(await readFile(join(repositoryRoot, "tsconfig.json"), "utf8")) as {
      references: Array<{ path: string }>;
    };
    const testTsconfig = JSON.parse(
      await readFile(join(repositoryRoot, "tsconfig.tests.json"), "utf8"),
    ) as { include: string[] };
    const eslintConfig = await readFile(join(repositoryRoot, "eslint.config.mjs"), "utf8");

    expect(rootTsconfig.references.map((reference) => reference.path)).toContain("tsconfig.tests.json");
    expect(testTsconfig.include).toContain("tests/**/*.ts");
    expect(eslintConfig).toContain('files: ["**/*.ts", "**/*.tsx"]');
    expect(eslintConfig).not.toContain('ignores: ["**/*.ts"');
  });

  it("rejects language-shaped worker fixtures from production packages", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/typescript-worker.ts": [
        "export function createTypeScriptShapedWorker(): void {}",
        "const rustFixture = (): void => {};",
        "export { rustFixture as createRustShapedWorker };",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "packages/plugin-sdk/src/typescript-worker.ts production packages cannot export language-shaped worker createTypeScriptShapedWorker",
    );
    expect(result.errors).toContain(
      "packages/plugin-sdk/src/typescript-worker.ts production packages cannot export language-shaped worker createRustShapedWorker",
    );
  });

  it("rejects later-phase query and publication operations from the plugin SDK public surface", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/later-phase.ts": [
        "export function executeQuery(): void {}",
        "export function publishSnapshot(): void {}",
        "const later = (): void => {};",
        "export { later as commitGeneration };",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual(expect.arrayContaining([
      "packages/plugin-sdk/src/later-phase.ts plugin SDK cannot export later-phase operation executeQuery",
      "packages/plugin-sdk/src/later-phase.ts plugin SDK cannot export later-phase operation publishSnapshot",
      "packages/plugin-sdk/src/later-phase.ts plugin SDK cannot export later-phase operation commitGeneration",
    ]));
  });

  it("rejects arbitrary command and source-write authority from plugin sandbox ports", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/sandbox.ts": [
        "export interface CommandRunner { run(command: string): Promise<void> }",
        "export interface SourceWriter { writeSource(path: string, contents: string): Promise<void> }",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual(expect.arrayContaining([
      "packages/plugin-sdk/src/sandbox.ts plugin sandbox cannot expose arbitrary command port CommandRunner",
      "packages/plugin-sdk/src/sandbox.ts plugin sandbox cannot expose source-write authority writeSource",
    ]));
  });

  it("accepts the restricted typed Node launch port", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/sandbox.ts": [
        "export interface RestrictedNodeProcessSpec { readonly runtime: 'node'; readonly shell: false }",
        "export interface RestrictedNodeProcessPort { launch(specification: RestrictedNodeProcessSpec): Promise<void> }",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual([]);
  });

  it("rejects default, aliased, and namespace-reexported language workers", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/typescript-worker.ts":
        "export default function createTypeScriptShapedWorker(): void {}\n",
      "packages/plugin-sdk/src/rust-worker.ts":
        "export function fixture(): void {}\n",
      "packages/plugin-sdk/src/aliased-worker.ts": [
        "const createTypeScriptAnalyzerWorker = (): void => {};",
        "export { createTypeScriptAnalyzerWorker as createAnalyzer };",
      ].join("\n"),
      "packages/plugin-sdk/src/index.ts": [
        "export { fixture as createRustShapedWorker } from './rust-worker.js';",
        "export * as TypeScriptWorker from './typescript-worker.js';",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual(expect.arrayContaining([
      "packages/plugin-sdk/src/typescript-worker.ts production packages cannot export language-shaped worker createTypeScriptShapedWorker",
      "packages/plugin-sdk/src/index.ts production packages cannot export language-shaped worker createRustShapedWorker",
      "packages/plugin-sdk/src/index.ts production packages cannot export language-shaped worker TypeScriptWorker",
      "packages/plugin-sdk/src/aliased-worker.ts production packages cannot export language-shaped worker createTypeScriptAnalyzerWorker",
    ]));
  });

  it("rejects a QueryEngine and arbitrary launcher or source writer regardless of source filename", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/runtime.ts": [
        "export class QueryEngine {}",
        "export interface ArbitraryLauncher { launch(command: string): Promise<void> }",
        "export interface MutationPort { writeSource(path: string, contents: string): Promise<void> }",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual(expect.arrayContaining([
      "packages/plugin-sdk/src/runtime.ts plugin SDK cannot export later-phase operation QueryEngine",
      "packages/plugin-sdk/src/runtime.ts plugin sandbox cannot expose arbitrary command port ArbitraryLauncher",
      "packages/plugin-sdk/src/runtime.ts plugin sandbox cannot accept an arbitrary command string",
      "packages/plugin-sdk/src/runtime.ts plugin sandbox cannot expose source-write authority writeSource",
    ]));
  });

  it("does not treat comments and string literals as exported plugin authority", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/documentation.ts": [
        "// export class QueryEngine {}",
        "/* export interface CommandRunner { run(command: string): void } */",
        "export const documentation = 'writeSource(path) and createRustShapedWorker';",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual([]);
  });

  it("does not treat a private implementation helper as exported plugin authority", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/internal-helper.ts": [
        "export function validateProjection(): boolean {",
        "  function executeQuery(): boolean { return true; }",
        "  return executeQuery();",
        "}",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual([]);
  });

  it("does not treat nested private source-write helpers as exported plugin authority", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/internal-source-helper.ts": [
        "export function validateProjection(): boolean {",
        "  function writeSource(): boolean { return true; }",
        "  const mutateSource = (): boolean => writeSource();",
        "  return mutateSource();",
        "}",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual([]);
  });

  it("rejects forbidden authority hidden behind exported factory return types and aliases", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/factories.ts": [
        "interface HiddenCommandAuthority { run(command: string): Promise<void> }",
        "interface HiddenSourceAuthority { writeSource(path: string, contents: string): Promise<void> }",
        "class QueryEngine {}",
        "type Wrapped<T> = { readonly authority: T };",
        "type FactoryAuthority = Wrapped<HiddenCommandAuthority & HiddenSourceAuthority & QueryEngine>;",
        "export function createAuthority(): FactoryAuthority { throw new Error('fixture'); }",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual(expect.arrayContaining([
      "packages/plugin-sdk/src/factories.ts plugin SDK cannot export later-phase operation QueryEngine",
      "packages/plugin-sdk/src/factories.ts plugin sandbox cannot accept an arbitrary command string",
      "packages/plugin-sdk/src/factories.ts plugin sandbox cannot expose source-write authority writeSource",
    ]));
  });

  it("rejects hidden authority re-exported through a local type alias", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/hidden.ts": [
        "interface HiddenCommandAuthority { launch(executable: string): Promise<void> }",
        "type HiddenAlias = HiddenCommandAuthority;",
        "export type { HiddenAlias as PublicAuthority };",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "packages/plugin-sdk/src/hidden.ts plugin sandbox cannot accept an arbitrary command string",
    );
  });

  it("rejects later-phase methods on an innocuously named reachable authority", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/operations.ts": [
        "interface HiddenOperations {",
        "  publishSnapshot(): Promise<void>;",
        "  executeQuery(): Promise<void>;",
        "}",
        "export function createOperations(): HiddenOperations { throw new Error('fixture'); }",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual(expect.arrayContaining([
      "packages/plugin-sdk/src/operations.ts plugin SDK cannot export later-phase operation publishSnapshot",
      "packages/plugin-sdk/src/operations.ts plugin SDK cannot export later-phase operation executeQuery",
    ]));
  });

  it("rejects arbitrary command strings hidden behind local aliases and generic wrappers", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/generic-command.ts": [
        "type CommandText = string;",
        "type Identity<T> = T;",
        "type Nested<T> = Identity<T>;",
        "interface HiddenOperations { run(command: Nested<CommandText>): Promise<void> }",
        "export function createOperations(): HiddenOperations { throw new Error('fixture'); }",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "packages/plugin-sdk/src/generic-command.ts plugin sandbox cannot accept an arbitrary command string",
    );
  });

  it("rejects arbitrary command authority instantiated through a generic interface", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/generic-interface.ts": [
        "interface GenericPort<T> {",
        "  readonly next?: GenericPort<T>;",
        "  execute(command: T): Promise<void>;",
        "}",
        "export type PublicGenericPort = GenericPort<string>;",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "packages/plugin-sdk/src/generic-interface.ts plugin sandbox cannot accept an arbitrary command string",
    );
  });

  it("rejects callable authority declared through function-valued properties and selected re-exports", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/property-authority.ts": [
        "export interface PropertyAuthority {",
        "  readonly executeQuery: () => Promise<void>;",
        "  readonly publishSnapshot: () => Promise<void>;",
        "  readonly writeSource: (path: string, contents: string) => Promise<void>;",
        "  readonly mutateSource: (path: string, contents: string) => Promise<void>;",
        "  readonly updateSource: (path: string, contents: string) => Promise<void>;",
        "  readonly execute: (command: string) => Promise<void>;",
        "}",
      ].join("\n"),
      "packages/plugin-sdk/src/index.ts":
        "export type { PropertyAuthority as PublicAuthority } from './property-authority.js';\n",
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    for (const sourcePath of [
      "packages/plugin-sdk/src/property-authority.ts",
      "packages/plugin-sdk/src/index.ts",
    ]) {
      expect(result.errors).toEqual(expect.arrayContaining([
        `${sourcePath} plugin SDK cannot export later-phase operation executeQuery`,
        `${sourcePath} plugin SDK cannot export later-phase operation publishSnapshot`,
        `${sourcePath} plugin sandbox cannot accept an arbitrary command string`,
        `${sourcePath} plugin sandbox cannot expose source-write authority writeSource`,
        `${sourcePath} plugin sandbox cannot expose source-write authority mutateSource`,
        `${sourcePath} plugin sandbox cannot expose source-write authority updateSource`,
      ]));
    }
  });

  it("accepts safe function-valued properties", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/callbacks.ts": [
        "export interface SafeCallbacks {",
        "  readonly transform: (value: string) => string;",
        "  readonly execute: (specification: { readonly runtime: 'node'; readonly shell: false }) => Promise<void>;",
        "}",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual([]);
  });

  it("rejects unbound generic command authority through string defaults and constraints", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/default-command.ts": [
        "interface GenericPort<T = string> { execute(command: T): Promise<void> }",
        "export type PublicDefaultPort = GenericPort;",
      ].join("\n"),
      "packages/plugin-sdk/src/constrained-command.ts": [
        "interface GenericPort<T extends string> { execute(command: T): Promise<void> }",
        "export type PublicConstrainedPort = GenericPort;",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual(expect.arrayContaining([
      "packages/plugin-sdk/src/default-command.ts plugin sandbox cannot accept an arbitrary command string",
      "packages/plugin-sdk/src/constrained-command.ts plugin sandbox cannot accept an arbitrary command string",
    ]));
  });

  it("accepts unbound generic command shapes with restricted defaults and constraints", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/restricted-unbound-generics.ts": [
        "interface RestrictedSpec { readonly runtime: 'node'; readonly shell: false }",
        "interface DefaultPort<T = RestrictedSpec> { execute(command: T): Promise<void> }",
        "interface ConstrainedPort<T extends RestrictedSpec> { execute(command: T): Promise<void> }",
        "export type PublicDefaultPort = DefaultPort;",
        "export type PublicConstrainedPort = ConstrainedPort;",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual([]);
  });

  it("accepts a generic command-shaped port instantiated with a restricted specification", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/restricted-generic.ts": [
        "interface RestrictedNodeProcessSpec { readonly runtime: 'node'; readonly shell: false }",
        "interface GenericPort<T> { execute(command: T): Promise<void> }",
        "export type RestrictedNodeProcessPort = GenericPort<RestrictedNodeProcessSpec>;",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual([]);
  });

  it("terminates conservatively for F-bounded and mutually cyclic generic constraints", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/f-bound.ts": [
        "interface Cyclic<T extends { readonly next: T }> { execute(command: T): Promise<void> }",
        "export type PublicCyclicPort = Cyclic;",
      ].join("\n"),
      "packages/plugin-sdk/src/mutual-bound.ts": [
        "interface Mutual<T extends U, U extends T> { execute(command: T): Promise<void> }",
        "export type PublicMutualPort = Mutual;",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual([]);
  });

  it("rejects imported generic string instantiations without blaming the safe leaf", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/generic-port.ts":
        "export interface GenericPort<T> { execute(command: T): Promise<void> }\n",
      "packages/plugin-sdk/src/default-generic-port.ts":
        "export default interface DefaultGenericPort<T> { execute(command: T): Promise<void> }\n",
      "packages/plugin-sdk/src/named-import.ts": [
        "import type { GenericPort as NamedPort } from './generic-port.js';",
        "export type PublicNamedPort = NamedPort<string>;",
      ].join("\n"),
      "packages/plugin-sdk/src/default-import.ts": [
        "import type DefaultPort from './default-generic-port.js';",
        "export type PublicDefaultPort = DefaultPort<string>;",
      ].join("\n"),
      "packages/plugin-sdk/src/namespace-import.ts": [
        "import type * as Ports from './generic-port.js';",
        "export type PublicNamespacePort = Ports.GenericPort<string>;",
      ].join("\n"),
      "packages/plugin-sdk/src/type-alias-import.ts": [
        "import type { GenericPort } from './generic-port.js';",
        "type PortAlias<T> = GenericPort<T>;",
        "export type PublicAliasPort = PortAlias<string>;",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    for (const sourcePath of [
      "packages/plugin-sdk/src/named-import.ts",
      "packages/plugin-sdk/src/default-import.ts",
      "packages/plugin-sdk/src/namespace-import.ts",
      "packages/plugin-sdk/src/type-alias-import.ts",
    ]) {
      expect(result.errors).toContain(
        `${sourcePath} plugin sandbox cannot accept an arbitrary command string`,
      );
    }
    expect(result.errors).not.toContain(
      "packages/plugin-sdk/src/generic-port.ts plugin sandbox cannot accept an arbitrary command string",
    );
    expect(result.errors).not.toContain(
      "packages/plugin-sdk/src/default-generic-port.ts plugin sandbox cannot accept an arbitrary command string",
    );
  });

  it("preserves generic substitutions through renamed local export aliases", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/renamed-generic-port.ts":
        "export interface GenericPort<T> { execute(command: T): Promise<void> }\n",
      "packages/plugin-sdk/src/renamed-alias.ts": [
        "import type { GenericPort as GP } from './renamed-generic-port.js';",
        "type Alias<T> = GP<T>;",
        "export { Alias as ExposedAlias };",
      ].join("\n"),
      "packages/plugin-sdk/src/renamed-consumer.ts": [
        "import type { ExposedAlias } from './renamed-alias.js';",
        "export type PublicPort = ExposedAlias<string>;",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "packages/plugin-sdk/src/renamed-consumer.ts plugin sandbox cannot accept an arbitrary command string",
    );
    expect(result.errors).not.toContain(
      "packages/plugin-sdk/src/renamed-alias.ts plugin sandbox cannot accept an arbitrary command string",
    );
    expect(result.errors).not.toContain(
      "packages/plugin-sdk/src/renamed-generic-port.ts plugin sandbox cannot accept an arbitrary command string",
    );
  });

  it("preserves imported generic bindings through source-less export aliases", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/import-chain-generic.ts":
        "export interface GenericPort<T> { execute(command: T): Promise<void> }\n",
      "packages/plugin-sdk/src/import-chain-alias-a.ts": [
        "import type { GenericPort as GP } from './import-chain-generic.js';",
        "export type { GP as LayerOne };",
      ].join("\n"),
      "packages/plugin-sdk/src/import-chain-alias-b.ts":
        "export type { LayerOne as LayerTwo } from './import-chain-alias-a.js';\n",
      "packages/plugin-sdk/src/import-chain-alias-c.ts":
        "export * from './import-chain-alias-b.js';\n",
      "packages/plugin-sdk/src/import-chain-consumer.ts": [
        "import type { LayerTwo as Port } from './import-chain-alias-c.js';",
        "export type PublicPort = Port<string>;",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "packages/plugin-sdk/src/import-chain-consumer.ts plugin sandbox cannot accept an arbitrary command string",
    );
    for (const sourcePath of [
      "packages/plugin-sdk/src/import-chain-generic.ts",
      "packages/plugin-sdk/src/import-chain-alias-a.ts",
      "packages/plugin-sdk/src/import-chain-alias-b.ts",
      "packages/plugin-sdk/src/import-chain-alias-c.ts",
    ]) {
      expect(result.errors).not.toContain(
        `${sourcePath} plugin sandbox cannot accept an arbitrary command string`,
      );
    }
  });

  it("rejects authority reached through relative named, default, namespace, and type re-exports", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/named-authority.ts": [
        "export interface ExternalAuthority { run(command: string): Promise<void> }",
        "export * from './index.js';",
      ].join("\n"),
      "packages/plugin-sdk/src/default-authority.ts": [
        "export default class ProjectionAuthority {",
        "  publishSnapshot(): Promise<void> { throw new Error('fixture'); }",
        "}",
      ].join("\n"),
      "packages/plugin-sdk/src/namespace-authority.ts":
        "export interface MutationAuthority { writeSource(path: string, contents: string): Promise<void> }\n",
      "packages/plugin-sdk/src/index.ts": [
        "export type { ExternalAuthority as PublicPort } from './named-authority.js';",
        "export { default as PublicDefaultPort } from './default-authority.js';",
        "export * as PublicNamespace from './namespace-authority.js';",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual(expect.arrayContaining([
      "packages/plugin-sdk/src/index.ts plugin SDK cannot export later-phase operation publishSnapshot",
      "packages/plugin-sdk/src/index.ts plugin sandbox cannot accept an arbitrary command string",
      "packages/plugin-sdk/src/index.ts plugin sandbox cannot expose source-write authority writeSource",
    ]));
  });

  it("does not attribute an unselected external export to a named re-export", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/external-ports.ts": [
        "export interface RestrictedSpec { readonly runtime: 'node'; readonly shell: false }",
        "export interface SafePort { launch(specification: RestrictedSpec): Promise<void> }",
        "export interface UnselectedAuthority { run(command: string): Promise<void> }",
      ].join("\n"),
      "packages/plugin-sdk/src/index.ts":
        "export type { SafePort as PublicSafePort } from './external-ports.js';\n",
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).not.toContain(
      "packages/plugin-sdk/src/index.ts plugin sandbox cannot accept an arbitrary command string",
    );
  });

  it("lets an explicit safe export shadow a dangerous star export while rejecting the leaf", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/star-authority.ts":
        "export interface SharedPort { execute(command: string): Promise<void> }\n",
      "packages/plugin-sdk/src/index.ts": [
        "export interface SharedPort { readonly label: string }",
        "export * from './star-authority.js';",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "packages/plugin-sdk/src/star-authority.ts plugin sandbox cannot accept an arbitrary command string",
    );
    expect(result.errors).not.toContain(
      "packages/plugin-sdk/src/index.ts plugin sandbox cannot accept an arbitrary command string",
    );
  });

  it("does not attribute an ambiguous name from multiple star exports while rejecting the dangerous leaf", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/dangerous-star.ts":
        "export interface SharedPort { execute(command: string): Promise<void> }\n",
      "packages/plugin-sdk/src/safe-star.ts":
        "export interface SharedPort { readonly transform: (value: string) => string }\n",
      "packages/plugin-sdk/src/index.ts": [
        "export * from './dangerous-star.js';",
        "export * from './safe-star.js';",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "packages/plugin-sdk/src/dangerous-star.ts plugin sandbox cannot accept an arbitrary command string",
    );
    expect(result.errors).not.toContain(
      "packages/plugin-sdk/src/index.ts plugin sandbox cannot accept an arbitrary command string",
    );
  });

  it("propagates genuine unambiguous star-exported authority", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/unique-star-authority.ts":
        "export interface UniqueAuthority { readonly execute: (command: string) => Promise<void> }\n",
      "packages/plugin-sdk/src/index.ts": "export * from './unique-star-authority.js';\n",
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toEqual(expect.arrayContaining([
      "packages/plugin-sdk/src/unique-star-authority.ts plugin sandbox cannot accept an arbitrary command string",
      "packages/plugin-sdk/src/index.ts plugin sandbox cannot accept an arbitrary command string",
    ]));
  });

  it("propagates a same-origin star export through a diamond", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/diamond-leaf.ts":
        "export interface DiamondAuthority { execute(command: string): Promise<void> }\n",
      "packages/plugin-sdk/src/diamond-left.ts": "export * from './diamond-leaf.js';\n",
      "packages/plugin-sdk/src/diamond-right.ts": "export * from './diamond-leaf.js';\n",
      "packages/plugin-sdk/src/diamond-index.ts": [
        "export * from './diamond-left.js';",
        "export * from './diamond-right.js';",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "packages/plugin-sdk/src/diamond-index.ts plugin sandbox cannot accept an arbitrary command string",
    );
  });

  it("propagates aliases of the same local binding through a star diamond", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/aliased-diamond-origin.ts": [
        "interface HiddenAuthority { execute(command: string): Promise<void> }",
        "export { HiddenAuthority as LeftAuthority, HiddenAuthority as RightAuthority };",
      ].join("\n"),
      "packages/plugin-sdk/src/aliased-diamond-left.ts":
        "export { LeftAuthority as SharedAuthority } from './aliased-diamond-origin.js';\n",
      "packages/plugin-sdk/src/aliased-diamond-right.ts":
        "export { RightAuthority as SharedAuthority } from './aliased-diamond-origin.js';\n",
      "packages/plugin-sdk/src/aliased-diamond-index.ts": [
        "export * from './aliased-diamond-left.js';",
        "export * from './aliased-diamond-right.js';",
      ].join("\n"),
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "packages/plugin-sdk/src/aliased-diamond-index.ts plugin sandbox cannot accept an arbitrary command string",
    );
  });

  it("propagates transitive authority through cyclic star barrels", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/cycle-entry.ts": [
        "export * from './cycle-peer.js';",
        "export * from './cycle-leaf.js';",
      ].join("\n"),
      "packages/plugin-sdk/src/cycle-peer.ts": "export * from './cycle-entry.js';\n",
      "packages/plugin-sdk/src/cycle-parent.ts": "export * from './cycle-peer.js';\n",
      "packages/plugin-sdk/src/cycle-leaf.ts":
        "export interface CyclicStarAuthority { execute(command: string): Promise<void> }\n",
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    expect(result.errors).toContain(
      "packages/plugin-sdk/src/cycle-parent.ts plugin sandbox cannot accept an arbitrary command string",
    );
  });

  it("propagates namespace authority through multiple star-export layers", async () => {
    const root = await phaseEightFixture({
      "packages/plugin-sdk/src/namespace-danger.ts":
        "export interface CommandPort { execute(command: string): Promise<void> }\n",
      "packages/plugin-sdk/src/namespace-binding.ts":
        "export * as Commands from './namespace-danger.js';\n",
      "packages/plugin-sdk/src/namespace-parent.ts":
        "export * from './namespace-binding.js';\n",
      "packages/plugin-sdk/src/namespace-grandparent.ts":
        "export * from './namespace-parent.js';\n",
    });

    const result = await checkArchitecture(root, await loadArchitectureManifest(root));

    for (const sourcePath of [
      "packages/plugin-sdk/src/namespace-binding.ts",
      "packages/plugin-sdk/src/namespace-parent.ts",
      "packages/plugin-sdk/src/namespace-grandparent.ts",
    ]) {
      expect(result.errors).toContain(
        `${sourcePath} plugin sandbox cannot accept an arbitrary command string`,
      );
    }
  });

  it("keeps cyclic different-origin stars ambiguous across file counts and discovery order", async () => {
    const cyclicFiles = [
      ["packages/plugin-sdk/src/ambiguity-danger.ts",
        "export interface SharedPort { execute(command: string): Promise<void> }\n"],
      ["packages/plugin-sdk/src/ambiguity-safe.ts",
        "export interface SharedPort { readonly transform: (value: string) => string }\n"],
      ["packages/plugin-sdk/src/ambiguity-a.ts", [
        "export * from './ambiguity-b.js';",
        "export * from './ambiguity-danger.js';",
      ].join("\n")],
      ["packages/plugin-sdk/src/ambiguity-b.ts", [
        "export * from './ambiguity-a.js';",
        "export * from './ambiguity-safe.js';",
      ].join("\n")],
      ["packages/plugin-sdk/src/ambiguity-parent.ts", "export * from './ambiguity-a.js';\n"],
    ] as const;
    const roots = await Promise.all([
      phaseEightFixture(Object.fromEntries(cyclicFiles)),
      phaseEightFixture(Object.fromEntries([...cyclicFiles].reverse())),
      phaseEightFixture({
        ...Object.fromEntries(cyclicFiles),
        "packages/plugin-sdk/src/unrelated.ts": "export interface Unrelated { readonly value: string }\n",
      }),
    ]);

    for (const root of roots) {
      const result = await checkArchitecture(root, await loadArchitectureManifest(root));
      expect(result.errors).toContain(
        "packages/plugin-sdk/src/ambiguity-danger.ts plugin sandbox cannot accept an arbitrary command string",
      );
      expect(result.errors).not.toContain(
        "packages/plugin-sdk/src/ambiguity-parent.ts plugin sandbox cannot accept an arbitrary command string",
      );
    }
  });
});

type FixtureOptions = {
  manifest: Record<string, unknown>;
  packageFiles: Record<string, string>;
};

async function makeFixture(options: FixtureOptions): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "urdira-architecture-"));
  await mkdir(join(root, "architecture"), { recursive: true });
  await writeFile(
    join(root, "architecture/manifest.json"),
    JSON.stringify(options.manifest),
  );

  for (const [relativePath, contents] of Object.entries(options.packageFiles)) {
    const absolutePath = join(root, relativePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, contents);
  }

  return root;
}

async function phaseEightFixture(sourceFiles: Record<string, string>): Promise<string> {
  return makeFixture({
    manifest: {
      version: 1,
      packages: [{ name: "@urdira/plugin-sdk", path: "packages/plugin-sdk", layer: 1, dependencies: [] }],
    },
    packageFiles: {
      "packages/plugin-sdk/package.json": JSON.stringify({ name: "@urdira/plugin-sdk", version: "0.1.0" }),
      ...sourceFiles,
    },
  });
}
