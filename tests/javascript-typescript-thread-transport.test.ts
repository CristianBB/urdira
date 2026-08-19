import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeProject,
  buildJavascriptTypescriptFactDelta,
  createJavascriptTypescriptThreadTransport,
  createJavascriptTypescriptWorker,
  languageForPath,
  type AnalyzerFile,
  type JavascriptTypescriptFactDeltaInput,
} from "../packages/plugin-javascript-typescript/src/index.js";

// Same fixture already used by `tests/phase-worker-analysis-cache.test.ts`
// for the in-process worker; reused here so the thread-based transport is
// exercised against real, non-trivial TypeScript source rather than a toy
// snippet.
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
    candidate_generation_id: "candidate:thread-transport-test",
    workspace_id: "workspace:thread-transport-test",
    artifact_id: `artifact:${owner}`,
    target_artifact_version_id: `version:${owner}`,
    work_item_id: `work:${owner}`,
    plugin_id: "urdira:javascript_typescript",
    plugin_version: "0.2.0",
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
    request_id: `thread-transport-test:${owner}`,
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

/** Ground truth: analyze fresh (no worker/transport involved at all) and build the delta for one owner. */
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

describe("JavaScript/TypeScript worker thread transport", () => {
  it("produces the exact same analyze_artifact delta as the in-process transport, over a real node:worker_threads worker", async () => {
    const files = await fixtureFiles();
    const sourceFiles = files.filter((file) => languageForPath(file.path) !== undefined);
    const rootNames = sourceFiles.map((file) => file.path);
    expect(sourceFiles.length).toBeGreaterThan(1);

    const threadTransport = createJavascriptTypescriptThreadTransport();
    const inProcessTransport = createJavascriptTypescriptWorker();
    try {
      for (const owner of sourceFiles) {
        const request = analyzeRequest(files, rootNames, owner.path);
        const [threadResponse, inProcessResponse] = await Promise.all([
          threadTransport.invoke(request) as Promise<{ readonly payload: { readonly validation_input: { readonly raw_delta: unknown } } }>,
          inProcessTransport.invoke(request) as Promise<{ readonly payload: { readonly validation_input: { readonly raw_delta: unknown } } }>,
        ]);
        const expected = freshDeltaFor(files, rootNames, owner.path);
        // The thread transport's delta must match both the ground truth and
        // the in-process transport's own delta for the identical request.
        expect(threadResponse.payload.validation_input.raw_delta).toEqual(expected);
        expect(threadResponse.payload.validation_input.raw_delta).toEqual(inProcessResponse.payload.validation_input.raw_delta);
      }
    } finally {
      await threadTransport.terminate();
      await inProcessTransport.terminate();
    }
  }, 60_000);

  it("supports describe and reset over the thread boundary, and rejects invoke after terminate", async () => {
    const transport = createJavascriptTypescriptThreadTransport({
      compatibility_declaration_digest: "sha256:compat",
      registry_contribution_digest: "sha256:contribution",
      analysis_digest: "sha256:analysis",
      analysis_configuration_digest: "sha256:configuration",
    });
    try {
      const described = await transport.invoke({
        protocol_version: "1.0.0", request_id: "describe:one", request_digest: "digest:describe", call: "describe",
        deadline: "2030-01-01T00:00:00.000Z", cancellation_id: "cancel:describe", payload: {},
      }) as { readonly payload: { readonly plugin_id: string; readonly compatibility_declaration_digest: string } };
      expect(described.payload.plugin_id).toBe("urdira:javascript_typescript");
      expect(described.payload.compatibility_declaration_digest).toBe("sha256:compat");
      await expect(transport.reset()).resolves.toEqual({ state_reset: true });
      await expect(transport.cancel({ cancellation_id: "cancel:describe" })).resolves.toBeUndefined();
    } finally {
      await transport.terminate();
    }
    await expect(transport.invoke({
      protocol_version: "1.0.0", request_id: "describe:two", request_digest: "digest:describe-two", call: "describe",
      deadline: "2030-01-01T00:00:00.000Z", cancellation_id: "cancel:describe-two", payload: {},
    })).rejects.toThrow();
  });
});
