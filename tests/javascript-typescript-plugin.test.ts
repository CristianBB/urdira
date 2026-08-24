import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeProject,
  analyzeSyntaxDependencyGraph,
  analyzeSyntaxProject,
  bundledPluginCatalogEntry,
  createJavascriptTypescriptWorker,
  discoverProjects,
  extractImportSpecifiers,
  assertNativeFactDeltaBatchBudget,
  isLargeSyntaxCorpus,
  iterateNativeFactDeltaBatches,
  languageForPath,
  resolveSyntaxDependencyGraph,
  scriptKindForPath,
  JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES,
  JS_TS_IMPORT_SPECIFIER_PATTERN,
  LARGE_SYNTAX_CORPUS_BYTE_THRESHOLD,
  LARGE_SYNTAX_CORPUS_FILE_THRESHOLD,
  type AnalyzerFile,
  type JsTsDirectDependency,
} from "../packages/plugin-javascript-typescript/src/index.js";
import { detectWorkspaceTechnologies } from "../packages/engine/src/index.js";

describe("bundled JavaScript/TypeScript analyzer", () => {
  it("publishes the approved three structural stages in dependency order", () => {
    expect(JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES.map((stage) => [stage.stage_id, stage.ordinal, stage.depends_on_stage_ids])).toEqual([
      ["jsts:structural_stage_1", 1, []],
      ["jsts:structural_stage_2", 2, ["jsts:structural_stage_1"]],
      ["jsts:structural_stage_3", 3, ["jsts:structural_stage_2"]],
    ]);
    expect(new Set(JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES.flatMap((stage) => stage.capabilities)).size)
      .toBe(JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES.flatMap((stage) => stage.capabilities).length);
  });
  it("normalizes supported extensions to the two canonical languages", () => {
    expect(languageForPath("src/component.tsx")).toBe("typescript");
    expect(languageForPath("src/component.jsx")).toBe("javascript");
    expect(languageForPath("types/index.d.ts")).toBe("typescript");
    expect(scriptKindForPath("src/component.tsx")).toBe("tsx");
    expect(languageForPath("README.md")).toBeUndefined();
  });

  it.each([
    ["source.ts", "typescript", "ts"], ["source.tsx", "typescript", "tsx"], ["source.mts", "typescript", "ts"], ["source.cts", "typescript", "ts"],
    ["source.d.ts", "typescript", "ts"], ["source.d.mts", "typescript", "ts"], ["source.d.cts", "typescript", "ts"],
    ["source.js", "javascript", "js"], ["source.jsx", "javascript", "jsx"], ["source.mjs", "javascript", "js"], ["source.cjs", "javascript", "js"],
  ] as const)("supports the approved extension %s", (path, language, scriptKind) => {
    expect(languageForPath(path)).toBe(language);
    expect(scriptKindForPath(path)).toBe(scriptKind);
  });

  it("discovers configured and inferred projects deterministically", () => {
    expect(discoverProjects([
      { path: "tsconfig.json", text: '{"include":["src"]}' },
      { path: "src/main.ts", text: "export function main() {}" },
      { path: "package.json", text: '{"workspaces":["packages/*"]}' },
    ])).toMatchObject([{ config_path: "tsconfig.json", root_names: ["src/main.ts"], inferred: false, workspace_manifests: ["package.json"] }]);
  });

  it("uses the pinned compiler config parser for inheritance, excludes, references and workspace manifests", () => {
    const projects = discoverProjects([
      { path: "configs/base.json", text: '{"compilerOptions":{"strict":true},"include":["../src/**/*.ts"],"exclude":["../src/excluded.ts"]}' },
      { path: "tsconfig.json", text: '{"extends":"./configs/base.json","references":[{"path":"./packages/lib"}]}' },
      { path: "src/main.ts", text: "export const main = 1" },
      { path: "src/excluded.ts", text: "export const excluded = 1" },
      { path: "pnpm-workspace.yaml", text: "packages:\n  - packages/*" },
      { path: "bun.lock", text: "" },
    ]);
    expect(projects).toMatchObject([{ config_path: "tsconfig.json", root_names: ["src/main.ts"], referenced_projects: ["packages/lib"], configuration_dependencies: ["configs/base.json", "tsconfig.json"], workspace_manifests: ["bun.lock", "pnpm-workspace.yaml"], compiler_options: expect.objectContaining({ strict: true }) }]);
  });

  it("emits checker-backed declarations, types, containment and call uncertainty", () => {
    const input = { files: [
      { path: "src/main.ts", text: "export function main(value: number): number { missing(); return value; }" },
      { path: "src/model.ts", text: "export interface Model {}" },
    ] };
    const first = analyzeProject(input);
    expect(first).toEqual(analyzeProject(input));
    expect(first.entities.some((entity) => entity.name === "main" && entity.universal_kind === "core:callable" && entity.type?.includes("number"))).toBe(true);
    expect(first.entities.some((entity) => entity.name === "Model" && entity.universal_kind === "core:type")).toBe(true);
    expect(first.relations.some((relation) => relation.kind === "core:call" && relation.classification === "possible")).toBe(true);
    expect(first.diagnostics.some((diagnostic) => diagnostic.code === "jsts:compiler_diagnostic" && diagnostic.compiler_code !== undefined)).toBe(true);
    // `missing` has no declaration anywhere the checker can see -- a
    // genuine call-resolution gap, so `jsts:unresolved_call` is honest here.
    expect(first.diagnostics.some((diagnostic) => diagnostic.code === "jsts:unresolved_call")).toBe(true);
  });

  it("keeps stage 1 syntax-only and leaves semantic records for later stages", () => {
    const input = { files: [
      { path: "src/main.ts", text: 'import { helper } from "./helper"; export function main(value: number): number { return helper(value); }' },
      { path: "src/helper.ts", text: "export function helper(value: number): number { return value; }" },
    ] };
    const stage1 = analyzeSyntaxProject(input);
    const full = analyzeProject(input);
    expect(stage1.entities.some((entity) => entity.name === "main" && entity.type === undefined)).toBe(true);
    expect(stage1.relations.some((relation) => relation.kind === "core:import")).toBe(true);
    expect(stage1.relations.some((relation) => relation.kind === "core:call")).toBe(false);
    expect(stage1.diagnostics).toEqual([]);
    expect(full.relations.some((relation) => relation.kind === "core:call")).toBe(true);
  });

  // Completeness regression coverage for the `core:call_relationships`
  // capability (see `apps/urdira/src/index.ts`'s `analyze`, which turns
  // per-file `jsts:unresolved_call` diagnostics into the workspace's
  // `SnapshotCapabilityStateEntry` status/`affected_artifact_ids`): a call
  // whose target the checker resolves to a REAL declaration outside the
  // frozen project (a library function, a DOM/Node built-in, ...) is an
  // expected analysis boundary, not missing coverage, and must not be
  // reported as one -- otherwise every ordinary file (which calls out to
  // its runtime and dependencies constantly) reads back as "partial" with
  // a bloated, never-actually-missing `affected_artifact_ids` list. A call
  // the checker genuinely cannot resolve to ANY declaration (dynamic
  // dispatch through a computed/`any`-typed expression) must still be
  // flagged, so real incompleteness stays visible.
  it("does not flag calls resolved to declarations outside the frozen project as unresolved, but still flags calls with no resolvable declaration at all", () => {
    const ordinary = analyzeProject({ files: [
      { path: "src/main.ts", text: "export function main(value: number): number { console.log(value); return [value].map((entry) => entry).length; }" },
    ] });
    expect(ordinary.diagnostics.some((diagnostic) => diagnostic.code === "jsts:unresolved_call")).toBe(false);
    expect(ordinary.relations.filter((relation) => relation.kind === "core:call")).not.toHaveLength(0);
    expect(ordinary.relations.filter((relation) => relation.kind === "core:call").every((relation) => relation.classification === "possible")).toBe(true);

    const dynamic = analyzeProject({ files: [
      { path: "src/dynamic.ts", text: "export function getCallback(): any { return undefined; } export function callDynamic(): void { getCallback()(); }" },
    ] });
    expect(dynamic.diagnostics.some((diagnostic) => diagnostic.code === "jsts:unresolved_call")).toBe(true);
  });

  // Phase 5.1: `analyzeProject`'s `dependency_closures` -- the per-file
  // transitive import closure a caller narrows an access manifest to
  // (`apps/urdira/src/index.ts`'s `analyze`).
  it("computes each file's transitive import closure, including itself, and marks unresolved local imports incomplete", () => {
    // a -> b -> c (chain); d is isolated; e imports a genuinely missing
    // local file (unresolved relative specifier); f imports an external
    // package (bare specifier -- not a closure gap).
    const analysis = analyzeProject({ files: [
      { path: "a.ts", text: 'import { b } from "./b";\nexport const a = b;' },
      { path: "b.ts", text: 'import { c } from "./c";\nexport const b = c;' },
      { path: "c.ts", text: "export const c = 1;" },
      { path: "d.ts", text: "export const d = 1;" },
      { path: "e.ts", text: 'import { missing } from "./does-not-exist";\nexport const e = missing;' },
      { path: "f.ts", text: 'import { readFileSync } from "node:fs";\nexport const f = readFileSync;' },
    ] });
    const closures = analysis.dependency_closures;

    expect(closures["a.ts"]).toEqual({ files: ["a.ts", "b.ts", "c.ts"], complete: true });
    expect(closures["b.ts"]).toEqual({ files: ["b.ts", "c.ts"], complete: true });
    expect(closures["c.ts"]).toEqual({ files: ["c.ts"], complete: true });
    // Isolated file: closure is just itself.
    expect(closures["d.ts"]).toEqual({ files: ["d.ts"], complete: true });
    // An unresolved relative import marks this file's own closure incomplete
    // (the target file that specifier would have pulled in is unknown).
    expect(closures["e.ts"]).toMatchObject({ complete: false });
    expect(closures["e.ts"]!.files).toContain("e.ts");
    // A bare (package) specifier that doesn't resolve locally is an
    // ordinary external dependency, not a closure gap.
    expect(closures["f.ts"]).toEqual({ files: ["f.ts"], complete: true });
  });

  it("propagates closure incompleteness transitively: a file that depends on an incomplete file is itself incomplete", () => {
    // g -> h -> (unresolved local import): g's closure must also be marked
    // incomplete, since whatever h's missing import would have pulled in is
    // invisible to a closure computed only from resolved edges.
    const analysis = analyzeProject({ files: [
      { path: "g.ts", text: 'import { h } from "./h";\nexport const g = h;' },
      { path: "h.ts", text: 'import { missing } from "./also-missing";\nexport const h = missing;' },
    ] });
    const closures = analysis.dependency_closures;
    expect(closures["h.ts"]).toMatchObject({ complete: false });
    expect(closures["g.ts"]).toMatchObject({ complete: false });
    expect([...closures["g.ts"]!.files].sort()).toEqual(["g.ts", "h.ts"]);
  });

  it("rejects malformed worker source payloads and produces deterministic projections", async () => {
    const worker = createJavascriptTypescriptWorker();
    const request = {
      protocol_version: "1.0.0",
      request_id: "request-1",
      request_digest: "digest",
      call: "generate_projection" as const,
      deadline: "2030-01-01T00:00:00.000Z",
      cancellation_id: "cancel-1",
      payload: { files: [{ path: "src/main.ts", text: "export const value = 1;" }] },
    };
    const first = await worker.invoke(request);
    const second = await worker.invoke(request);
    expect(first).toEqual(second);
    await expect(worker.invoke({ ...request, payload: { files: [{ path: "../escape.ts", text: "" }] } })).rejects.toThrow();
    await worker.terminate();
  });

  it("hydrates a verified source reference directly from CAS", async () => {
    const casRoot = await mkdtemp(join(tmpdir(), "urdira-jsts-cas-"));
    const source = new TextEncoder().encode("export const value = 1;\n");
    const hex = createHash("sha256").update(source).digest("hex");
    const casPath = join(casRoot, "sha256", hex.slice(0, 2), hex.slice(2));
    await mkdir(join(casRoot, "sha256", hex.slice(0, 2)), { recursive: true });
    await writeFile(casPath, source);
    const worker = createJavascriptTypescriptWorker({ cas_root: casRoot });
    try {
      const result = await worker.invoke({
        protocol_version: "1.0.0",
        request_id: "request-cas-reference",
        request_digest: "digest-cas-reference",
        call: "discover_partitions",
        deadline: "2030-01-01T00:00:00.000Z",
        cancellation_id: "cancel-cas-reference",
        payload: { files: [{ path: "src/main.ts", content_hash: `sha256:${hex}` }] },
      }) as { readonly payload: { readonly partitions: readonly unknown[] } };
      expect(result.payload.partitions).toHaveLength(1);
      await expect(worker.invoke({
        protocol_version: "1.0.0",
        request_id: "request-cas-reference-invalid",
        request_digest: "digest-cas-reference-invalid",
        call: "discover_partitions",
        deadline: "2030-01-01T00:00:00.000Z",
        cancellation_id: "cancel-cas-reference-invalid",
        payload: { files: [{ path: "src/main.ts", content_hash: `sha256:${"0".repeat(64)}` }] },
      })).rejects.toThrow(/failed digest verification|ENOENT/);
    } finally {
      await worker.terminate();
      await rm(casRoot, { recursive: true, force: true });
    }
  });

  it("returns a FactDelta validation envelope for production-shaped analysis work", async () => {
    const worker = createJavascriptTypescriptWorker();
    const request = {
      protocol_version: "1.0.0",
      request_id: "request-fact-delta",
      request_digest: "digest-fact-delta",
      call: "analyze_artifact" as const,
      deadline: "2030-01-01T00:00:00.000Z",
      cancellation_id: "cancel-fact-delta",
      payload: {
        files: [{ path: "src/main.ts", text: "export function main() {}" }],
        work_item: {
          candidate_generation_id: "candidate:1",
          workspace_id: "workspace:1",
          artifact_id: "artifact:main",
          target_artifact_version_id: "version:main",
          work_item_id: "work:main",
          plugin_id: "urdira:javascript_typescript",
          plugin_version: "0.2.0",
          base_snapshot_id: "snapshot:1",
          expected_replacement_scopes: [{ replacement_scope_id: "scope:main", owner_artifact_id: "artifact:main", owner_artifact_version_id: "version:main", capability: "core:symbol_declarations", record_categories: ["entity"], record_kinds: ["jsts:entity_callable"], base_record_set_digest: "sha256:empty", output_completeness: "complete" }],
        },
        accepted_manifest: { plugin_input_access_manifest_id: "manifest:1", manifest_digest: "sha256:manifest", artifact_version_entries: [{ artifact_version_id: "version:main" }], record_entries: [] },
      },
    };
    const result = await worker.invoke(request) as { readonly payload: { readonly outcome: string; readonly result_type: string; readonly work_item_id: string; readonly validation_input: { readonly raw_delta: { readonly proposed_records: readonly unknown[]; readonly replacement_scopes: readonly unknown[] }; readonly accepted_manifest: unknown } } };
    expect(result.payload).toMatchObject({ outcome: "success", result_type: "fact_delta", work_item_id: "work:main" });
    expect(result.payload.validation_input.raw_delta.proposed_records.length).toBeGreaterThan(0);
    expect(result.payload.validation_input.raw_delta.replacement_scopes).toHaveLength(1);
    expect(result.payload.validation_input.accepted_manifest).toMatchObject({ manifest_digest: "sha256:manifest" });
    expect((result.payload as { readonly fact_delta_batches?: readonly unknown[] }).fact_delta_batches?.length).toBeGreaterThan(0);
    const rawDelta = result.payload.validation_input.raw_delta as Parameters<typeof iterateNativeFactDeltaBatches>[0];
    const hostBatches = [...iterateNativeFactDeltaBatches(rawDelta)];
    expect(hostBatches.length).toBeGreaterThan(0);
    for (const batch of hostBatches) assertNativeFactDeltaBatchBudget(batch);
    expect(() => assertNativeFactDeltaBatchBudget({ ...hostBatches[0]!, byte_length: 4 * 1024 * 1024 + 1 })).toThrow(/bounded memory budget/);
    const hostWorker = createJavascriptTypescriptWorker({ native_batch_transport: "host" });
    const hostResult = await hostWorker.invoke(request) as { readonly payload: { readonly fact_delta_batches?: readonly unknown[]; readonly validation_input: { readonly raw_delta: unknown } } };
    expect(hostResult.payload.fact_delta_batches).toBeUndefined();
    expect(hostResult.payload.validation_input.raw_delta).toEqual(result.payload.validation_input.raw_delta);
    await hostWorker.terminate();
    await expect(worker.invoke({
      ...request,
      payload: {
        ...request.payload,
        accepted_manifest: { ...request.payload.accepted_manifest, record_entries: [null] },
      },
    })).rejects.toThrow(/record_entries/);
    await worker.terminate();
  });

  it("rejects scanner-only analyze_artifact calls without a core work item", async () => {
    const worker = createJavascriptTypescriptWorker();
    const request = {
      protocol_version: "1.0.0",
      request_id: "request-scanner-only",
      request_digest: "digest-scanner-only",
      call: "analyze_artifact" as const,
      deadline: "2030-01-01T00:00:00.000Z",
      cancellation_id: "cancel-scanner-only",
      payload: { files: [{ path: "src/main.ts", text: "export const value = 1;" }] },
    };
    await expect(worker.invoke(request)).rejects.toThrow(/core artifact work item/);
    await worker.terminate();
  });
});

describe("workspace recognition for the bundled analyzer", () => {
  it("recommends the verified shared plugin for both languages", () => {
    const proposal = detectWorkspaceTechnologies({
      provider_fingerprint: "provider",
      git_state_fingerprint: "git",
      plugin_catalog_fingerprint: bundledPluginCatalogEntry.package_digest,
      plugin_catalog: [bundledPluginCatalogEntry],
      files: [{ path: "src/main.ts" }, { path: "src/legacy.js" }, { path: "tsconfig.json", content: "{}" }],
    });
    expect(proposal.technologies).toEqual(expect.arrayContaining([
      expect.objectContaining({ technology_id: "typescript", compatible_plugin_ids: [bundledPluginCatalogEntry.plugin_id] }),
      expect.objectContaining({ technology_id: "javascript", compatible_plugin_ids: [bundledPluginCatalogEntry.plugin_id] }),
    ]));
  });
});

// P3-3b: a host-side pre-seed (`apps/urdira/src/index.ts`) must produce
// EXACTLY the graph `analyzeSyntaxDependencyGraph` (the worker's own
// large-corpus scanner, `worker.ts`) would produce, by splitting its
// per-file extraction (`extractImportSpecifiers`) from its resolution
// (`resolveSyntaxDependencyGraph`) so a host can extract per-file as text
// streams by and resolve once, later, without ever re-reading text. Since
// both halves are the SAME exported functions `analyzeSyntaxDependencyGraph`
// itself now delegates to (see analyzer.ts), equivalence is guaranteed by
// construction for any input where the two call sites agree on `root_names`
// -- these fixtures exercise the interesting textual edge cases (equivalence
// gate: any fixture that diverged here would mean the split, not just the
// pattern, introduced a bug).
describe("P3-3b host/worker syntax-dependency-graph equivalence", () => {
  /** Simulates the host's split extract-then-resolve pre-seed path exactly. */
  function hostGraph(files: readonly AnalyzerFile[], rootNames: readonly string[]): Readonly<Record<string, JsTsDirectDependency>> {
    const filteredRootNames = rootNames.filter((path) => languageForPath(path) !== undefined);
    const rootNameSet = new Set(filteredRootNames);
    const specifiersByPath = new Map(files.filter((file) => rootNameSet.has(file.path)).map((file) => [file.path, extractImportSpecifiers(file.text)] as const));
    return resolveSyntaxDependencyGraph(filteredRootNames, specifiersByPath);
  }

  const fixtures: Readonly<Record<string, readonly AnalyzerFile[]>> = {
    "plain relative imports": [
      { path: "a.ts", text: `import { b } from "./b";\nexport const a = 1;\n` },
      { path: "b.ts", text: `export const b = 2;\n` },
    ],
    "CRLF line endings": [
      { path: "a.ts", text: `import { b } from "./b";\r\nexport const a = 1;\r\n` },
      { path: "b.ts", text: `export const b = 2;\r\n` },
    ],
    "UTF-8 BOM prefix": [
      { path: "a.ts", text: `﻿import { b } from "./b";\nexport const a = 1;\n` },
      { path: "b.ts", text: `export const b = 2;\n` },
    ],
    "export-from and re-export": [
      { path: "a.ts", text: `export * from "./b";\nexport { c } from "./c";\n` },
      { path: "b.ts", text: `export const b = 1;\n` },
      { path: "c.ts", text: `export const c = 2;\n` },
    ],
    "bare side-effect import": [
      { path: "a.ts", text: `import "./b";\nexport const a = 1;\n` },
      { path: "b.ts", text: `export const b = 1;\n` },
    ],
    // Dynamic `import("...")` is NOT matched by the shared pattern in either
    // implementation -- a known, pre-existing limitation of the bounded
    // stage-1 lexer, not something the host/worker split can diverge on.
    "dynamic import (shared limitation, not a divergence)": [
      { path: "a.ts", text: `export async function load() { return import("./b"); }\n` },
      { path: "b.ts", text: `export const b = 1;\n` },
    ],
    "unresolved external, relative asset, and missing relative specifiers": [
      { path: "a.ts", text: `import fs from "node:fs";\nimport "./styles.css";\nimport { missing } from "./missing";\nexport const a = 1;\n` },
    ],
    // A multi-line import statement is also unmatched by the shared pattern
    // (it deliberately excludes newlines, `[^;\n]*?`) in BOTH implementations.
    "multi-line import (shared limitation, not a divergence)": [
      { path: "a.ts", text: `import {\n  b,\n} from "./b";\nexport const a = 1;\n` },
      { path: "b.ts", text: `export const b = 1;\n` },
    ],
    "file containing a NUL character in otherwise-decoded text": [
      { path: "a.ts", text: `import { b } from "./b";\nexport const a = "\0";\n` },
      { path: "b.ts", text: `export const b = 1;\n` },
    ],
    "deep relative traversal and index resolution": [
      { path: "src/pkg/a.ts", text: `import { b } from "../lib/b";\nimport { c } from "./sub";\nexport const a = 1;\n` },
      { path: "src/lib/b.ts", text: `export const b = 1;\n` },
      { path: "src/pkg/sub/index.ts", text: `export const c = 1;\n` },
    ],
  };

  for (const [name, files] of Object.entries(fixtures)) {
    it(`matches analyzeSyntaxDependencyGraph exactly for: ${name}`, () => {
      const rootNames = files.map((file) => file.path);
      const monolithic = analyzeSyntaxDependencyGraph({ files, root_names: rootNames });
      expect(hostGraph(files, rootNames)).toEqual(monolithic);
    });
  }

  it("cross-checks: isLargeSyntaxCorpus is driven by the exported threshold constants, at their exact boundary", () => {
    // Real cross-check (not a re-derivation): calls the ACTUAL exported
    // `isLargeSyntaxCorpus` and asserts it flips exactly at
    // `LARGE_SYNTAX_CORPUS_FILE_THRESHOLD` -- the same constant `worker.ts`
    // imports for its own early-cache-check gate (see that file and
    // `tests/phase-worker-analysis-cache.test.ts` for the end-to-end version
    // that drives the actual worker code path with a real durable cache).
    const atThreshold = Array.from({ length: LARGE_SYNTAX_CORPUS_FILE_THRESHOLD }, (_, index): AnalyzerFile => ({ path: `f-${index}.ts`, text: `export const v${index} = ${index};\n` }));
    const belowThreshold = atThreshold.slice(0, LARGE_SYNTAX_CORPUS_FILE_THRESHOLD - 1);
    expect(isLargeSyntaxCorpus({ files: atThreshold })).toBe(true);
    expect(isLargeSyntaxCorpus({ files: belowThreshold })).toBe(false);
    const byteThresholdOnly = [{ path: "huge.ts", text: "x".repeat(LARGE_SYNTAX_CORPUS_BYTE_THRESHOLD) }];
    expect(isLargeSyntaxCorpus({ files: byteThresholdOnly })).toBe(true);
    expect(isLargeSyntaxCorpus({ files: [{ path: "small.ts", text: "x" }] })).toBe(false);
  });

  it("extractImportSpecifiers is driven by the same exported, stable pattern analyzeSyntaxDependencyGraph uses", () => {
    expect(JS_TS_IMPORT_SPECIFIER_PATTERN.flags).toContain("g");
    expect(extractImportSpecifiers(`import { a } from "./a";\nexport * from "./b";\n`)).toEqual(["./a", "./b"]);
  });
});
