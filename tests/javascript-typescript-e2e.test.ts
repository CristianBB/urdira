import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeProject, createJavascriptTypescriptWorker, discoverProjects, type AnalyzerFile } from "../packages/plugin-javascript-typescript/src/index.js";

const run = promisify(execFile);
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "codebases", "javascript", "task-planner");
const manifestPath = resolve(fixtureRoot, "..", "task-planner.gold.json");

type GoldManifest = {
  readonly artifacts: readonly string[];
  readonly subjects: readonly { readonly name: string; readonly source: { readonly path: string } }[];
};

async function fixtureInput(): Promise<{ readonly manifest: GoldManifest; readonly files: readonly AnalyzerFile[] }> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as GoldManifest;
  const files = await Promise.all(manifest.artifacts.map(async (path) => ({ path, text: await readFile(join(fixtureRoot, path), "utf8") })));
  return { manifest, files };
}

function request(call: "discover_partitions" | "analyze_artifact" | "generate_projection", files: readonly AnalyzerFile[]) {
  return {
    protocol_version: "1.0.0",
    request_id: `javascript-e2e:${call}`,
    request_digest: `digest:${call}`,
    call,
    deadline: "2030-01-01T00:00:00.000Z",
    cancellation_id: `cancel:${call}`,
    payload: { files },
  } as const;
}

describe("JavaScript/TypeScript production-plugin E2E", () => {
  it("executes the JavaScript fixture and discovers its jsconfig project", async () => {
    const { files } = await fixtureInput();
    const result = await run(process.execPath, ["--test", "test/task-service.spec.js"], { cwd: fixtureRoot });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("tests 3");
    const partitions = discoverProjects(files);
    expect(partitions).toHaveLength(1);
    expect(partitions[0]).toMatchObject({ config_path: "jsconfig.json", inferred: false });
    expect(partitions[0]?.root_names).toContain("src/services/task-service.js");
  });

  it("indexes the JavaScript gold-manifest symbols, calls, and projections through all worker calls", async () => {
    const { manifest, files } = await fixtureInput();
    const worker = createJavascriptTypescriptWorker();
    const discovered = await worker.invoke(request("discover_partitions", files));
    expect(discovered).toMatchObject({ outcome: "success", payload: { partitions: [{ config_path: "jsconfig.json" }] } });

    const analysis = analyzeProject({ files, root_names: files.map((file) => file.path) });
    const entityNames = new Set(analysis.entities.map((entity) => entity.name));
    for (const subject of manifest.subjects) {
      if (subject.name.includes("entry module") || subject.name.includes("tests")) continue;
      expect(entityNames, `${subject.name} from ${subject.source.path}`).toContain(subject.name);
    }
    expect(analysis.relations.some((relation) => relation.kind === "core:call" && relation.classification === "confirmed")).toBe(true);
    expect(analysis.relations.some((relation) => relation.kind === "core:call" && relation.classification === "possible")).toBe(true);

    const firstProjection = await worker.invoke(request("generate_projection", files));
    const secondProjection = await worker.invoke(request("generate_projection", files));
    expect(firstProjection).toEqual(secondProjection);
    expect((firstProjection as { readonly payload: { readonly projection_set: { readonly projections: readonly unknown[] } } }).payload.projection_set.projections.length).toBeGreaterThan(0);
    await worker.terminate();
  });

  it("emits the core-facing FactDelta envelope for an artifact work item", async () => {
    const { files } = await fixtureInput();
    const worker = createJavascriptTypescriptWorker();
    const sourceFiles = files.filter((file) => file.path === "src/services/task-service.js");
    const result = await worker.invoke({
      ...request("analyze_artifact", sourceFiles),
      payload: {
        files: sourceFiles,
        work_item: {
          candidate_generation_id: "candidate:javascript-e2e",
          workspace_id: "workspace:javascript-e2e",
          artifact_id: "artifact:task-service",
          target_artifact_version_id: "version:task-service",
          work_item_id: "work:task-service",
          plugin_id: "urdira:javascript_typescript",
          plugin_version: "0.2.0",
          base_snapshot_id: "snapshot:javascript-e2e",
          expected_replacement_scopes: [{ replacement_scope_id: "scope:task-service", owner_artifact_id: "artifact:task-service", owner_artifact_version_id: "version:task-service", capability: "core:symbol_declarations", record_categories: ["entity"], record_kinds: ["jsts:entity_type", "jsts:entity_callable", "jsts:entity_variable"], base_record_set_digest: "sha256:empty", output_completeness: "complete" }],
        },
        accepted_manifest: {
          plugin_input_access_manifest_id: "manifest:javascript-e2e",
          manifest_digest: "sha256:javascript-e2e-manifest",
          artifact_version_entries: [{ artifact_version_id: "version:task-service" }],
          record_entries: [],
        },
      },
    });
    const payload = (result as { readonly payload: { readonly result_type: string; readonly validation_input: { readonly raw_delta: { readonly owner_artifact_id: string; readonly proposed_records: readonly unknown[] } } } }).payload;
    expect(payload.result_type).toBe("fact_delta");
    expect(payload.validation_input.raw_delta.owner_artifact_id).toBe("artifact:task-service");
    expect(payload.validation_input.raw_delta.proposed_records.length).toBeGreaterThan(0);
    await worker.terminate();
  });
});
