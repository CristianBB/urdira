import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
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
import { factDeltaStreamCanonicalRow } from "@urdira/plugin-sdk";

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

  it("rejects native-bound stage-one work before TypeScript reads or parses source", async () => {
    const worker = createJavascriptTypescriptWorker({ runtime_executable_binding_digest: `sha256:${"a".repeat(64)}` });
    await expect(worker.invoke({
      protocol_version: "1.0.0",
      request_id: "request-native-stage-one",
      request_digest: "digest-native-stage-one",
      call: "analyze_artifact",
      deadline: "2030-01-01T00:00:00.000Z",
      cancellation_id: "cancel-native-stage-one",
      payload: {
        publication_stage_id: "jsts:structural_stage_1",
        files: [{ path: "../would-fail-if-read.ts", text: "export const duplicate = true;" }],
      },
    })).rejects.toThrow(/exclusive-work violation/iu);
    await worker.terminate();
  });

  it("rejects native-bound semantic work that omits the Rust-authoritative affected scope", async () => {
    const worker = createJavascriptTypescriptWorker({ runtime_executable_binding_digest: `sha256:${"a".repeat(64)}` });
    try {
      await expect(worker.invoke({
        protocol_version: "1.0.0",
        request_id: "request-native-semantic-without-scope",
        request_digest: "digest-native-semantic-without-scope",
        call: "analyze_artifact",
        deadline: "2030-01-01T00:00:00.000Z",
        cancellation_id: "cancel-native-semantic-without-scope",
        payload: {
          publication_stage_id: "jsts:structural_stage_2",
          files: [{ path: "src/main.ts", text: "export const value = 1;" }],
          root_names: ["src/main.ts"],
        },
      })).rejects.toThrow(/exclusive-work violation.*Rust-authoritative affected scope/iu);
    } finally {
      await worker.terminate();
    }
  });

  it("prepares the checker once across semantic stages without rebuilding Rust-owned dependency work", async () => {
    let analysisBuilds = 0;
    const worker = createJavascriptTypescriptWorker({
      runtime_executable_binding_digest: `sha256:${"b".repeat(64)}`,
      on_analysis_build: () => { analysisBuilds += 1; },
    });
    const files = [
      { path: "src/main.ts", text: 'import { helper } from "./helper"; export const main = helper();' },
      { path: "src/helper.ts", text: "export function helper(): number { return 1; }" },
    ];
    const payload = {
      files,
      root_names: files.map((file) => file.path),
      rust_semantic_scope: {
        authority: "urdira:jsts-syntax-worker",
        changed_paths: files.map((file) => file.path),
        affected_paths: files.map((file) => file.path),
      },
    };
    const invokeStage = async (stage: "jsts:structural_stage_2" | "jsts:structural_stage_3", requestId: string) => await worker.invoke({
      protocol_version: "1.0.0",
      request_id: requestId,
      request_digest: `digest:${requestId}`,
      call: "analyze_closure",
      deadline: "2030-01-01T00:00:00.000Z",
      cancellation_id: `cancel:${requestId}`,
      payload: { ...payload, publication_stage_id: stage },
    }) as { readonly payload: Readonly<Record<string, unknown>> };
    try {
      const stage2 = await invokeStage("jsts:structural_stage_2", "request-native-semantic-2");
      const stage3 = await invokeStage("jsts:structural_stage_3", "request-native-semantic-3");
      for (const result of [stage2, stage3]) {
        expect(result.payload).toMatchObject({ semantic_state_prepared: true, dependency_authority: "urdira:jsts-syntax-worker" });
        expect(result.payload).not.toHaveProperty("dependency_graph");
        expect(result.payload).not.toHaveProperty("dependency_closures");
        expect(result.payload).not.toHaveProperty("impactful_changed_paths");
      }
      expect(analysisBuilds).toBe(1);
    } finally {
      await worker.terminate();
    }
  });

  it("fails closed on a Rust semantic scope that is not a subset of root_names", async () => {
    const worker = createJavascriptTypescriptWorker({ runtime_executable_binding_digest: `sha256:${"c".repeat(64)}` });
    try {
      await expect(worker.invoke({
        protocol_version: "1.0.0",
        request_id: "request-invalid-native-semantic-scope",
        request_digest: "digest:invalid-native-semantic-scope",
        call: "analyze_closure",
        deadline: "2030-01-01T00:00:00.000Z",
        cancellation_id: "cancel:invalid-native-semantic-scope",
        payload: {
          files: [{ path: "src/main.ts", text: "export const main = 1;" }],
          root_names: ["src/main.ts"],
          publication_stage_id: "jsts:structural_stage_2",
          rust_semantic_scope: {
            authority: "urdira:jsts-syntax-worker",
            changed_paths: ["src/outside.ts"],
            affected_paths: ["src/outside.ts"],
          },
        },
      })).rejects.toThrow(/members of root_names|outside root_names/iu);
    } finally {
      await worker.terminate();
    }
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

  it("reuses the verified checker snapshot for owner publication without rereading CAS source bytes", async () => {
    const casRoot = await mkdtemp(join(tmpdir(), "urdira-jsts-prepared-cas-"));
    const source = new TextEncoder().encode("export function main(value: number): number { return value; }\n");
    const hex = createHash("sha256").update(source).digest("hex");
    const contentHash = `sha256:${hex}`;
    const casPath = join(casRoot, "sha256", hex.slice(0, 2), hex.slice(2));
    await mkdir(join(casRoot, "sha256", hex.slice(0, 2)), { recursive: true });
    await writeFile(casPath, source);
    const worker = createJavascriptTypescriptWorker({
      cas_root: casRoot,
      runtime_executable_binding_digest: `sha256:${"e".repeat(64)}`,
    });
    const files = [{
      path: "src/main.ts",
      content_hash: contentHash,
      artifact_id: "artifact:main",
      artifact_version_id: "version:main",
    }];
    const rustScope = {
      authority: "urdira:jsts-syntax-worker",
      changed_paths: ["src/main.ts"],
      affected_paths: ["src/main.ts"],
    } as const;
    try {
      await worker.invoke({
        protocol_version: "1.0.0", request_id: "request-prepared-cas-closure", request_digest: "digest:prepared-cas-closure",
        call: "analyze_closure", deadline: "2030-01-01T00:00:00.000Z", cancellation_id: "cancel:prepared-cas-closure",
        payload: { files, root_names: ["src/main.ts"], publication_stage_id: "jsts:structural_stage_2", rust_semantic_scope: rustScope },
      });
      await unlink(casPath);
      await expect(worker.invoke({
        protocol_version: "1.0.0", request_id: "request-prepared-cas-owner", request_digest: "digest:prepared-cas-owner",
        call: "analyze_artifact", deadline: "2030-01-01T00:00:00.000Z", cancellation_id: "cancel:prepared-cas-owner",
        payload: {
          files,
          root_names: ["src/main.ts"],
          owner_path: "src/main.ts",
          publication_stage_id: "jsts:structural_stage_2",
          rust_semantic_scope: rustScope,
          work_item: {
            candidate_generation_id: "candidate:prepared-cas", workspace_id: "workspace:prepared-cas", artifact_id: "artifact:main",
            target_artifact_version_id: "version:main", work_item_id: "work:prepared-cas", plugin_id: "urdira:javascript_typescript",
            plugin_version: "0.5.0", expected_replacement_scopes: [{ replacement_scope_id: "scope:prepared-cas", owner_artifact_id: "artifact:main",
              owner_artifact_version_id: "version:main", capability: "core:call_relationships", record_categories: ["entity", "relation", "diagnostic"],
              record_kinds: ["jsts:relation_call", "jsts:relation_references", "jsts:relation_inherits", "jsts:relation_implements"],
              base_record_set_digest: "sha256:empty", output_completeness: "complete" }],
          },
          accepted_manifest: { plugin_input_access_manifest_id: "manifest:prepared-cas", manifest_digest: "sha256:manifest-prepared-cas", artifact_version_entries: [{ artifact_version_id: "version:main" }], record_entries: [] },
        },
      })).resolves.toMatchObject({ outcome: "success", payload: { outcome: "success", result_type: "fact_delta" } });
    } finally {
      await worker.terminate();
      await rm(casRoot, { recursive: true, force: true });
    }
  });

  // E1c cutover (design doc E1, step 3): `rust_hybrid_pending_sites` on an
  // `analyze_artifact` payload is the wire carrier for the Rust worker's own
  // localized-descent sites (`pendingSitesFromPayload` in worker.ts). This
  // exercises the wiring end to end -- ungrouped (a single `analyze_artifact`
  // call) and grouped (`invokeFactDeltaStreamGroup`, which additionally
  // routes every request's own sites through `pendingSitesByOwnerFromRequests`
  // into `beginRustSemanticOwnerGroup`) -- and confirms malformed entries are
  // dropped rather than failing the owner.
  it("wires rust_hybrid_pending_sites through analyze_artifact (ungrouped and grouped), dropping malformed entries", async () => {
    const worker = createJavascriptTypescriptWorker({ runtime_executable_binding_digest: `sha256:${"f".repeat(64)}` });
    const files = [{ path: "src/main.ts", text: "export function helper(value: number): number { return value + 1; }\nexport function main(value: number): number { return helper(value); }" }];
    const rustScope = { authority: "urdira:jsts-syntax-worker", changed_paths: ["src/main.ts"], affected_paths: ["src/main.ts"] } as const;
    const callSpanStart = files[0]!.text.indexOf("helper(value)");
    const malformedSites = [
      { start_utf16: "not-a-number", end_utf16: 5, site_kind: "call" },
      { start_utf16: 0, end_utf16: 5, site_kind: "not-a-real-kind" },
      null,
      "not-an-object",
    ];
    const workItem = (id: string) => ({
      candidate_generation_id: `candidate:${id}`, workspace_id: `workspace:${id}`, artifact_id: "artifact:main",
      target_artifact_version_id: "version:main", work_item_id: `work:${id}`, plugin_id: "urdira:javascript_typescript",
      plugin_version: "0.5.0", expected_replacement_scopes: [{ replacement_scope_id: `scope:${id}`, owner_artifact_id: "artifact:main",
        owner_artifact_version_id: "version:main", capability: "core:call_relationships", record_categories: ["entity", "relation", "diagnostic"],
        record_kinds: ["jsts:relation_call", "jsts:relation_references", "jsts:relation_inherits", "jsts:relation_implements"],
        base_record_set_digest: "sha256:empty", output_completeness: "complete" }],
    });
    const acceptedManifest = (id: string) => ({ plugin_input_access_manifest_id: `manifest:${id}`, manifest_digest: `sha256:manifest-${id}`, artifact_version_entries: [{ artifact_version_id: "version:main" }], record_entries: [] });
    try {
      await worker.invoke({
        protocol_version: "1.0.0", request_id: "request-pending-sites-prepare", request_digest: "digest:pending-sites-prepare",
        call: "analyze_closure", deadline: "2030-01-01T00:00:00.000Z", cancellation_id: "cancel:pending-sites-prepare",
        payload: { files, root_names: ["src/main.ts"], publication_stage_id: "jsts:structural_stage_2", rust_semantic_scope: rustScope },
      });
      const result = await worker.invoke({
        protocol_version: "1.0.0", request_id: "request-pending-sites-owner", request_digest: "digest:pending-sites-owner",
        call: "analyze_artifact", deadline: "2030-01-01T00:00:00.000Z", cancellation_id: "cancel:pending-sites-owner",
        payload: {
          files, root_names: ["src/main.ts"], owner_path: "src/main.ts", publication_stage_id: "jsts:structural_stage_2", rust_semantic_scope: rustScope,
          rust_hybrid_pending_sites: [{ start_utf16: callSpanStart, end_utf16: callSpanStart + "helper(value)".length, site_kind: "call" }, ...malformedSites],
          work_item: workItem("pending-sites"),
          accepted_manifest: acceptedManifest("pending-sites"),
        },
      }) as { readonly payload: { readonly outcome: string; readonly validation_input: { readonly raw_delta: { readonly proposed_records: readonly { readonly kind: string; readonly body: Readonly<Record<string, unknown>> }[] } } } };
      expect(result.payload.outcome).toBe("success");
      const records = result.payload.validation_input.raw_delta.proposed_records;
      expect(records.some((record) => record.kind === "jsts:relation_call")).toBe(true);

      // Grouped path: the same sites, but routed through
      // `pendingSitesByOwnerFromRequests` into `beginRustSemanticOwnerGroup`.
      const groupRequest = {
        protocol_version: "1.0.0", request_id: "request-pending-sites-group", request_digest: "digest:pending-sites-group",
        call: "analyze_artifact" as const, deadline: "2030-01-01T00:00:00.000Z", cancellation_id: "cancel:pending-sites-group",
        payload: {
          files, root_names: ["src/main.ts"], owner_path: "src/main.ts", publication_stage_id: "jsts:structural_stage_2", rust_semantic_scope: rustScope,
          rust_hybrid_pending_sites: [{ start_utf16: callSpanStart, end_utf16: callSpanStart + "helper(value)".length, site_kind: "call" }],
          work_item: workItem("pending-sites-group"),
          accepted_manifest: acceptedManifest("pending-sites-group"),
        },
      };
      const [groupedStream] = await worker.invokeFactDeltaStreamGroup([groupRequest]);
      const groupedRecords: string[] = [];
      for await (const batch of groupedStream!.batches) groupedRecords.push(...batch.records.map((record) => record.kind));
      expect(groupedRecords).toContain("jsts:relation_call");
    } finally {
      await worker.terminate();
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

  it("publishes type information as semantic records without reconstructing stage-one declaration records", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "urdira-jsts-semantic-spool-"));
    let semanticOwnerWalks = 0;
    let semanticGroupPreparations = 0;
    const worker = createJavascriptTypescriptWorker({
      runtime_executable_binding_digest: `sha256:${"d".repeat(64)}`,
      analysis_cache_dir: cacheDir,
      on_rust_semantic_owner_analyze: () => { semanticOwnerWalks += 1; },
      on_rust_semantic_group_prepare: () => { semanticGroupPreparations += 1; },
    });
    const files = [{ path: "src/main.ts", text: "export function helper(value: number): number { return value; }\nexport function main(value: number): number { return helper(value); }" }];
    const rustScope = { authority: "urdira:jsts-syntax-worker", changed_paths: ["src/main.ts"], affected_paths: ["src/main.ts"] };
    try {
      await worker.invoke({
        protocol_version: "1.0.0", request_id: "request-stage2-prepare-spool", request_digest: "digest:stage2-prepare-spool",
        call: "analyze_closure", deadline: "2030-01-01T00:00:00.000Z", cancellation_id: "cancel:stage2-prepare-spool",
        payload: { files, root_names: ["src/main.ts"], publication_stage_id: "jsts:structural_stage_2", rust_semantic_scope: rustScope },
      });
      const stage2Streams = await worker.invokeFactDeltaStreamGroup([{
        protocol_version: "1.0.0", request_id: "request-stage2-facts-spool", request_digest: "digest:stage2-facts-spool",
        call: "analyze_artifact" as const, deadline: "2030-01-01T00:00:00.000Z", cancellation_id: "cancel:stage2-facts-spool",
        payload: {
          files, root_names: ["src/main.ts"], owner_path: "src/main.ts", publication_stage_id: "jsts:structural_stage_2", rust_semantic_scope: rustScope,
          work_item: {
            candidate_generation_id: "candidate:stage2-spool", workspace_id: "workspace:stage2-spool", artifact_id: "artifact:main",
            target_artifact_version_id: "version:main", work_item_id: "work:stage2-spool", plugin_id: "urdira:javascript_typescript",
            plugin_version: "0.5.0", expected_replacement_scopes: [{ replacement_scope_id: "scope:stage2-spool", owner_artifact_id: "artifact:main",
              owner_artifact_version_id: "version:main", capability: "core:call_relationships", record_categories: ["entity", "relation", "diagnostic"],
              record_kinds: ["jsts:relation_call", "jsts:relation_references", "jsts:relation_inherits", "jsts:relation_implements"],
              base_record_set_digest: "sha256:empty", output_completeness: "complete" }],
          },
          accepted_manifest: { plugin_input_access_manifest_id: "manifest:stage2-spool", manifest_digest: "sha256:manifest-stage2-spool", artifact_version_entries: [{ artifact_version_id: "version:main" }], record_entries: [] },
        },
      }]);
      for await (const _batch of stage2Streams[0]!.batches) { /* seal the checker-backed stage-2 owner */ }
      expect(semanticGroupPreparations).toBe(1);
      await worker.invoke({
        protocol_version: "1.0.0", request_id: "request-stage3-prepare", request_digest: "digest:stage3-prepare",
        call: "analyze_closure", deadline: "2030-01-01T00:00:00.000Z", cancellation_id: "cancel:stage3-prepare",
        payload: { files, root_names: ["src/main.ts"], publication_stage_id: "jsts:structural_stage_3", rust_semantic_scope: rustScope },
      });
      const stage3Request = {
        protocol_version: "1.0.0", request_id: "request-stage3-facts", request_digest: "digest:stage3-facts",
        call: "analyze_artifact" as const, deadline: "2030-01-01T00:00:00.000Z", cancellation_id: "cancel:stage3-facts",
        payload: {
          files,
          root_names: ["src/main.ts"],
          owner_path: "src/main.ts",
          publication_stage_id: "jsts:structural_stage_3",
          rust_semantic_scope: rustScope,
          work_item: {
            candidate_generation_id: "candidate:stage3", workspace_id: "workspace:stage3", artifact_id: "artifact:main",
            target_artifact_version_id: "version:main", work_item_id: "work:stage3", plugin_id: "urdira:javascript_typescript",
            plugin_version: "0.5.0", expected_replacement_scopes: [{ replacement_scope_id: "scope:stage3", owner_artifact_id: "artifact:main",
              owner_artifact_version_id: "version:main", capability: "core:type_information", record_categories: ["entity", "relation", "diagnostic"],
              record_kinds: ["jsts:entity_inferred_type", "jsts:relation_type_of", "jsts:relation_covers", "jsts:diagnostic"],
              base_record_set_digest: "sha256:empty", output_completeness: "complete" }],
          },
          accepted_manifest: { plugin_input_access_manifest_id: "manifest:stage3", manifest_digest: "sha256:manifest-stage3", artifact_version_entries: [{ artifact_version_id: "version:main" }], record_entries: [] },
        },
      };
      const grouped = await worker.invokeFactDeltaStreamGroup([stage3Request]);
      const oracleRecords: string[] = [];
      const oracleDependencies: string[] = [];
      for await (const batch of grouped[0]!.batches) {
        oracleRecords.push(...batch.records.map(factDeltaStreamCanonicalRow));
        oracleDependencies.push(...batch.dependencies.map(factDeltaStreamCanonicalRow));
      }
      const direct = await worker.invokeRustSemanticObservationGroup([stage3Request]);
      expect(direct).toHaveLength(1);
      expect(direct[0]!.batches.flatMap((batch) => batch.canonical_records)).toEqual(oracleRecords);
      expect(direct[0]!.batches.flatMap((batch) => batch.canonical_dependencies)).toEqual(oracleDependencies);
      expect(direct[0]!.batches[0]!.delta_digest).toBe(grouped[0]!.header.delta_digest);
      expect(direct[0]!.batches[0]!.fact_delta_id).toBe(`${grouped[0]!.header.fact_delta_id}:0`);
      expect(semanticGroupPreparations).toBe(1);
      const result = await worker.invoke(stage3Request) as { readonly payload: { readonly validation_input: { readonly raw_delta: { readonly proposed_records: readonly { readonly kind: string; readonly body: Readonly<Record<string, unknown>> }[] } } } };
      const records = result.payload.validation_input.raw_delta.proposed_records;
      expect(records.some((record) => record.kind === "jsts:entity_inferred_type"
        && record.body["name"] === "inferred type of src/main.ts.main"
        && record.body["type"] === "(value: number) => number")).toBe(true);
      expect(records.some((record) => record.kind === "jsts:relation_type_of")).toBe(true);
      expect(records.some((record) => ["jsts:entity_type", "jsts:entity_callable", "jsts:entity_variable", "jsts:entity_parameter", "jsts:entity_container"].includes(record.kind))).toBe(false);
      expect(records.some((record) => ["jsts:relation_contains", "jsts:relation_import", "jsts:relation_export"].includes(record.kind))).toBe(false);
      expect(semanticOwnerWalks).toBe(1);
    } finally {
      await worker.terminate();
      await rm(cacheDir, { recursive: true, force: true });
    }
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
