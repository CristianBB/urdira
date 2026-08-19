import { describe, expect, it } from "vitest";
import {
  analyzeProject,
  analyzeSyntaxProject,
  bundledPluginCatalogEntry,
  createJavascriptTypescriptWorker,
  discoverProjects,
  languageForPath,
  scriptKindForPath,
  JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES,
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
