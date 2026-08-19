import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeProject,
  buildJavascriptTypescriptFactDelta,
  createJavascriptTypescriptWorker,
  languageForPath,
  type AnalyzerFile,
  type JavascriptTypescriptFactDeltaInput,
} from "../packages/plugin-javascript-typescript/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, "fixtures", "codebases", "typescript", "task-planner");
const manifestPath = resolve(fixtureRoot, "..", "task-planner.gold.json");

type GoldManifest = { readonly artifacts: readonly string[] };

async function fixtureFiles(): Promise<readonly AnalyzerFile[]> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as GoldManifest;
  return Promise.all(manifest.artifacts.map(async (path): Promise<AnalyzerFile> => ({ path, text: await readFile(join(fixtureRoot, path), "utf8") })));
}

function workItemFor(owner: string): Record<string, unknown> {
  return {
    candidate_generation_id: "candidate:cache-test",
    workspace_id: "workspace:cache-test",
    artifact_id: `artifact:${owner}`,
    target_artifact_version_id: `version:${owner}`,
    work_item_id: `work:${owner}`,
    plugin_id: "urdira:javascript_typescript",
    plugin_version: "0.1.0",
    expected_replacement_scopes: [{
      replacement_scope_id: `scope:${owner}`,
      owner_artifact_id: `artifact:${owner}`,
      owner_artifact_version_id: `version:${owner}`,
      capability: "core:call_relationships",
      record_categories: ["entity", "relation", "diagnostic"],
      record_kinds: [
        "jsts:entity_type", "jsts:entity_callable", "jsts:entity_container", "jsts:entity_parameter", "jsts:entity_variable",
        "jsts:relation_contains", "jsts:relation_import", "jsts:relation_export", "jsts:relation_references", "jsts:relation_call",
        "jsts:relation_implements", "jsts:relation_inherits", "jsts:relation_covers", "jsts:diagnostic",
      ],
      base_record_set_digest: "sha256:empty",
      output_completeness: "accept_reported",
    }],
  };
}

function manifestFor(owner: string): Record<string, unknown> {
  return {
    plugin_input_access_manifest_id: `manifest:${owner}`,
    manifest_digest: `sha256:manifest-${owner}`,
    artifact_version_entries: [{ artifact_version_id: `version:${owner}` }],
    record_entries: [],
  };
}

function analyzeRequest(files: readonly AnalyzerFile[], rootNames: readonly string[], owner: string) {
  return {
    protocol_version: "1.0.0",
    request_id: `cache-test:${owner}`,
    request_digest: `digest:${owner}`,
    call: "analyze_artifact" as const,
    deadline: "2030-01-01T00:00:00.000Z",
    cancellation_id: `cancel:${owner}`,
    payload: {
      files,
      root_names: rootNames,
      owner_path: owner,
      work_item: workItemFor(owner),
      accepted_manifest: manifestFor(owner),
      analysis_digest: "sha256:jsts-analysis",
      analysis_configuration_digest: "sha256:jsts-configuration",
      analysis_input_digest: `digest:${owner}`,
      created_at: "1970-01-01T00:00:00.000Z",
    },
  };
}

function closureRequest(files: readonly AnalyzerFile[], rootNames: readonly string[]) {
  return {
    protocol_version: "1.0.0",
    request_id: "cache-test:closure",
    request_digest: "digest:closure",
    call: "analyze_closure" as const,
    deadline: "2030-01-01T00:00:00.000Z",
    cancellation_id: "cancel:closure",
    payload: { files, root_names: rootNames },
  };
}

/** Ground truth: analyze fresh (no cache involved at all) and build the delta for one owner. */
function freshDeltaFor(files: readonly AnalyzerFile[], rootNames: readonly string[], owner: string): unknown {
  const analysis = analyzeProject({ files, root_names: rootNames });
  const input: JavascriptTypescriptFactDeltaInput = {
    analysis,
    work_item: workItemFor(owner),
    accepted_manifest: manifestFor(owner),
    analysis_digest: "sha256:jsts-analysis",
    analysis_configuration_digest: "sha256:jsts-configuration",
    analysis_input_digest: `digest:${owner}`,
    created_at: "1970-01-01T00:00:00.000Z",
    owner_path: owner,
    files,
  };
  return buildJavascriptTypescriptFactDelta(input);
}

describe("JavaScript/TypeScript worker analysis cache", () => {
  it("reuses a single cached whole-project analysis across analyze_artifact calls for different owners without cross-contamination", async () => {
    const files = await fixtureFiles();
    const sourceFiles = files.filter((file) => languageForPath(file.path) !== undefined);
    const rootNames = sourceFiles.map((file) => file.path);
    const worker = createJavascriptTypescriptWorker();
    try {
      for (const owner of sourceFiles) {
        const response = await worker.invoke(analyzeRequest(files, rootNames, owner.path)) as {
          readonly payload: { readonly validation_input: { readonly raw_delta: unknown } };
        };
        const expected = freshDeltaFor(files, rootNames, owner.path);
        expect(response.payload.validation_input.raw_delta).toEqual(expected);
      }
      // Re-request an owner already served earlier: must still be correct after intervening calls.
      const firstOwner = sourceFiles[0]!;
      const repeated = await worker.invoke(analyzeRequest(files, rootNames, firstOwner.path)) as {
        readonly payload: { readonly validation_input: { readonly raw_delta: unknown } };
      };
      expect(repeated.payload.validation_input.raw_delta).toEqual(freshDeltaFor(files, rootNames, firstOwner.path));
    } finally {
      await worker.terminate();
    }
  });

  it("computes the expensive whole-project analysis only once across N invoke() calls with the same effective inputs", async () => {
    const files = await fixtureFiles();
    const sourceFiles = files.filter((file) => languageForPath(file.path) !== undefined);
    const rootNames = sourceFiles.map((file) => file.path);
    let analysisBuildCount = 0;
    const worker = createJavascriptTypescriptWorker({ on_analysis_build: () => { analysisBuildCount += 1; } });
    try {
      for (const owner of sourceFiles) {
        await worker.invoke(analyzeRequest(files, rootNames, owner.path));
      }
      expect(sourceFiles.length).toBeGreaterThan(1);
      expect(analysisBuildCount).toBe(1);
    } finally {
      await worker.terminate();
    }
  });

  it("rebuilds when the effective inputs genuinely change, and caches again afterwards", async () => {
    const files = await fixtureFiles();
    const sourceFiles = files.filter((file) => languageForPath(file.path) !== undefined);
    const rootNames = sourceFiles.map((file) => file.path);
    let analysisBuildCount = 0;
    const worker = createJavascriptTypescriptWorker({ on_analysis_build: () => { analysisBuildCount += 1; } });
    try {
      const owner = sourceFiles[0]!;
      await worker.invoke(analyzeRequest(files, rootNames, owner.path));
      await worker.invoke(analyzeRequest(files, rootNames, owner.path));
      expect(analysisBuildCount).toBe(1);

      // Genuinely change the content of one file: this must invalidate the cache.
      const changedFiles = files.map((file) => file.path === owner.path ? { ...file, text: `${file.text}\nexport const cacheInvalidationProbe = 1;` } : file);
      await worker.invoke(analyzeRequest(changedFiles, rootNames, owner.path));
      expect(analysisBuildCount).toBe(2);

      // Same changed content again: must hit the cache, not rebuild.
      await worker.invoke(analyzeRequest(changedFiles, rootNames, owner.path));
      expect(analysisBuildCount).toBe(2);
    } finally {
      await worker.terminate();
    }
  });

  it("clears the cache on terminate so a fresh worker never reuses a prior instance's analysis", async () => {
    const files = await fixtureFiles();
    const sourceFiles = files.filter((file) => languageForPath(file.path) !== undefined);
    const rootNames = sourceFiles.map((file) => file.path);
    let analysisBuildCount = 0;
    const owner = sourceFiles[0]!;
    const firstWorker = createJavascriptTypescriptWorker({ on_analysis_build: () => { analysisBuildCount += 1; } });
    await firstWorker.invoke(analyzeRequest(files, rootNames, owner.path));
    await firstWorker.terminate();
    const secondWorker = createJavascriptTypescriptWorker({ on_analysis_build: () => { analysisBuildCount += 1; } });
    await secondWorker.invoke(analyzeRequest(files, rootNames, owner.path));
    await secondWorker.terminate();
    expect(analysisBuildCount).toBe(2);
  });

  // Phase 5.1: the worker's subset-reuse contract (`isSubsetOfCache`,
  // `packages/plugin-javascript-typescript/src/worker.ts`). A full-corpus
  // `analyze_closure` call builds and caches the whole-project analysis;
  // subsequent `analyze_artifact` calls whose `files` is an exact
  // (path, content_hash) subset of that cached corpus must reuse it
  // (no rebuild) even though their own `files`/`root_names` differ from the
  // cached entry's -- that's the whole point (a narrowed per-owner request
  // over the thread transport must not force a whole-project rebuild).
  it("reuses the cached whole-project analysis for a narrowed (subset) analyze_artifact request after an analyze_closure call", async () => {
    const files = await fixtureFiles();
    const sourceFiles = files.filter((file) => languageForPath(file.path) !== undefined);
    const rootNames = sourceFiles.map((file) => file.path);
    let analysisBuildCount = 0;
    const worker = createJavascriptTypescriptWorker({ on_analysis_build: () => { analysisBuildCount += 1; } });
    try {
      const closureResponse = await worker.invoke(closureRequest(files, rootNames)) as {
        readonly payload: { readonly dependency_closures: Readonly<Record<string, { readonly files: readonly string[]; readonly complete: boolean }>> };
      };
      expect(analysisBuildCount).toBe(1);
      const owner = sourceFiles[0]!;
      const closure = closureResponse.payload.dependency_closures[owner.path];
      expect(closure).toBeDefined();
      expect(closure!.files).toContain(owner.path);

      // A narrowed request: only the owner's own closure files, not the
      // whole corpus -- both `files` and `root_names` differ from the
      // closure call's, so this would NOT hit the plain cache-key match.
      const closureFiles = files.filter((file) => closure!.files.includes(file.path));
      const response = await worker.invoke(analyzeRequest(closureFiles, closure!.files, owner.path)) as {
        readonly payload: { readonly validation_input: { readonly raw_delta: unknown } };
      };
      // No rebuild: subset-reuse served this from the cached whole-project
      // analysis instead of `analyzeProject` running again.
      expect(analysisBuildCount).toBe(1);
      // And the result is still correct: identical to analyzing fresh over
      // the full corpus and extracting the same owner's delta.
      expect(response.payload.validation_input.raw_delta).toEqual(freshDeltaFor(files, rootNames, owner.path));
    } finally {
      await worker.terminate();
    }
  });

  it("rebuilds (does not subset-reuse) when a file inside the narrowed subset has actually changed", async () => {
    const files = await fixtureFiles();
    const sourceFiles = files.filter((file) => languageForPath(file.path) !== undefined);
    const rootNames = sourceFiles.map((file) => file.path);
    let analysisBuildCount = 0;
    const worker = createJavascriptTypescriptWorker({ on_analysis_build: () => { analysisBuildCount += 1; } });
    try {
      const closureResponse = await worker.invoke(closureRequest(files, rootNames)) as {
        readonly payload: { readonly dependency_closures: Readonly<Record<string, { readonly files: readonly string[]; readonly complete: boolean }>> };
      };
      expect(analysisBuildCount).toBe(1);
      const owner = sourceFiles[0]!;
      const closure = closureResponse.payload.dependency_closures[owner.path]!;

      // Mutate the owner file's own text within the narrowed subset: the
      // (path, content_hash) pair for `owner.path` no longer matches what
      // the cached whole-project analysis was built from, so this must be
      // treated as a mismatch -- a rebuild, not a stale reuse.
      const mutatedClosureFiles = files
        .filter((file) => closure.files.includes(file.path))
        .map((file) => file.path === owner.path ? { ...file, text: `${file.text}\nexport const subsetMutationProbe = 1;` } : file);
      await worker.invoke(analyzeRequest(mutatedClosureFiles, closure.files, owner.path));
      expect(analysisBuildCount).toBe(2);
    } finally {
      await worker.terminate();
    }
  });
});
