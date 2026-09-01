import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyNativeAccelerationMutation,
  computeNativeAccelerationCorpusDigest,
  createNativeAccelerationController,
  loadNativeAccelerationCorpusState,
  nativeAccelerationMutationTraceDigest,
  readNativeAccelerationVisibleSetDigest,
  runNativeAccelerationControllerCli,
  validateNativeAccelerationControllerConfig,
  validateNativeAccelerationMutationTrace,
} from "../scripts/native-acceleration-controller.mjs";
import {
  generateNativeAccelerationMutationTrace,
  runPrepareNativeAccelerationTraceCli,
  validatePreparedNativeAccelerationMutationTrace,
  writeNativeAccelerationMutationTrace,
} from "../scripts/prepare-native-acceleration-trace.mjs";

const sha256 = (bytes: string | Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

type CorpusEntry = { readonly path: string; readonly kind: "file"; readonly digest: string };

function corpusDigest(files: ReadonlyMap<string, string>): string {
  const entries: CorpusEntry[] = [...files.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([path, content]) => ({ path, kind: "file", digest: sha256(content) }));
  return sha256(JSON.stringify(entries));
}

async function writeCorpus(root: string, files: ReadonlyMap<string, string>): Promise<void> {
  for (const [path, content] of files) {
    const destination = join(root, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
}

function buildTrace(initial: ReadonlyMap<string, string>) {
  const files = new Map(initial);
  const mutations: Array<Record<string, unknown>> = [];
  const write = (category: string, path: string, content: string, mutationId: string) => {
    const before = files.get(path);
    files.set(path, content);
    mutations.push({
      mutation_index: mutations.length,
      mutation_id: mutationId,
      category,
      changes: [{ kind: "write", path, before_digest: before === undefined ? null : sha256(before), after_digest: sha256(content), content_base64: Buffer.from(content).toString("base64") }],
      resulting_corpus_digest: corpusDigest(files),
    });
  };
  const remove = (path: string, mutationId: string) => {
    const before = files.get(path)!;
    files.delete(path);
    mutations.push({
      mutation_index: mutations.length,
      mutation_id: mutationId,
      category: "delete",
      changes: [{ kind: "delete", path, before_digest: sha256(before) }],
      resulting_corpus_digest: corpusDigest(files),
    });
  };
  const rename = (fromPath: string, toPath: string, mutationId: string) => {
    const content = files.get(fromPath)!;
    files.delete(fromPath);
    files.set(toPath, content);
    mutations.push({
      mutation_index: mutations.length,
      mutation_id: mutationId,
      category: "rename",
      changes: [{ kind: "rename", from_path: fromPath, to_path: toPath, content_digest: sha256(content) }],
      resulting_corpus_digest: corpusDigest(files),
    });
  };

  write("content", "src/a.ts", "export const a = 2;\n", "content-00");
  write("import", "src/a.ts", "import { b } from './b.js';\nexport const a = b;\n", "import-01");
  write("create", "src/created.ts", "export const created = true;\n", "create-02");
  remove("src/delete.ts", "delete-03");
  rename("src/rename.ts", "src/renamed.ts", "rename-04");
  write("tsconfig", "tsconfig.json", "{\"compilerOptions\":{\"strict\":true}}\n", "tsconfig-05");
  write("manifest", "package.json", "{\"name\":\"controller-fixture\",\"type\":\"module\"}\n", "manifest-06");
  for (let index = 7; index < 60; index += 1) write("content", `src/content-${String(index).padStart(2, "0")}.ts`, `export const content${index} = ${index + 1};\n`, `content-${String(index).padStart(2, "0")}`);

  return {
    trace: {
      schema_version: 1,
      trace_id: "controller-fixture-trace",
      base_corpus_digest: corpusDigest(initial),
      excluded_paths: [],
      mutations,
    },
    finalFiles: files,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "urdira-native-controller-"));
  const corpus = join(root, "corpus");
  const dataRoot = join(root, "urdira-data");
  const initial = new Map<string, string>([
    ["package.json", "{\"name\":\"controller-fixture\",\"type\":\"module\"}\n"],
    ["tsconfig.json", "{\"compilerOptions\":{}}\n"],
    ["src/a.ts", "export const a = 1;\n"],
    ["src/b.ts", "export const b = 3;\n"],
    ["src/delete.ts", "export const doomed = true;\n"],
    ["src/rename.ts", "export const renamed = true;\n"],
  ]);
  for (let index = 7; index < 60; index += 1) initial.set(`src/content-${String(index).padStart(2, "0")}.ts`, `export const content${index} = ${index};\n`);
  await mkdir(corpus);
  await writeCorpus(corpus, initial);
  const built = buildTrace(initial);
  const tracePath = join(root, "mutation-trace.json");
  const traceBytes = Buffer.from(`${JSON.stringify(built.trace, null, 2)}\n`);
  await writeFile(tracePath, traceBytes);
  const config = {
    schema_version: 2,
    lane: "candidate",
    corpus_path: corpus,
    mutation_trace_path: tracePath,
    data_root: dataRoot,
    runtime_module: fileURLToPath(new URL("../apps/urdira/src/index.ts", import.meta.url)),
    workspace_selection: {
      selected_technology_ids: ["typescript"],
      selected_plugin_ids: ["urdira:javascript_typescript"],
    },
    qualification: {
      mode: "qualifying",
      corpus_tier: "L",
      cache_state: "cold",
      applied_limits: {
        max_indexing_cores: 6,
        max_rss_bytes: 8 * 1024 * 1024 * 1024,
      },
      capture_phase_timings: true,
    },
    polling: { interval_ms: 20, readiness_timeout_ms: 30_000 },
  } as const;
  return { root, corpus, dataRoot, initial, tracePath, traceBytes, trace: built.trace, finalFiles: built.finalFiles, config };
}

describe("native acceleration controller", () => {
  it("validates a closed, explicit 60-mutation trace and lane configuration", async () => {
    const test = await fixture();
    const trace = validateNativeAccelerationMutationTrace(test.trace);
    expect(trace.mutations).toHaveLength(60);
    expect(new Set(trace.mutations.map((mutation) => mutation.category))).toEqual(new Set(["content", "import", "create", "delete", "rename", "tsconfig", "manifest"]));
    expect(nativeAccelerationMutationTraceDigest(test.traceBytes)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(validateNativeAccelerationControllerConfig(test.config).lane).toBe("candidate");

    expect(() => validateNativeAccelerationMutationTrace({ ...test.trace, unexpected: true })).toThrow(/unknown fields/u);
    expect(() => validateNativeAccelerationMutationTrace({ ...test.trace, mutations: test.trace.mutations.slice(0, 59) })).toThrow(/exactly 60/u);
    expect(() => validateNativeAccelerationControllerConfig({ ...test.config, lane: "automatic" })).toThrow(/lane/u);
    expect(() => validateNativeAccelerationControllerConfig({ ...test.config, runtime_module: "apps/urdira/dist/index.js" })).toThrow(/absolute runtime module/u);
    expect(() => validateNativeAccelerationControllerConfig({ ...test.config, schema_version: 1 })).toThrow(/schema_version.*2/u);
    const { qualification: _qualification, ...withoutQualification } = test.config;
    expect(() => validateNativeAccelerationControllerConfig(withoutQualification)).toThrow(/qualification/u);
    expect(() => validateNativeAccelerationControllerConfig({
      ...test.config,
      qualification: { ...test.config.qualification, mode: "diagnostic" },
    })).toThrow(/mode.*qualifying/u);
    expect(() => validateNativeAccelerationControllerConfig({
      ...test.config,
      qualification: { ...test.config.qualification, corpus_tier: "M" },
    })).toThrow(/corpus_tier.*L/u);
    expect(() => validateNativeAccelerationControllerConfig({
      ...test.config,
      qualification: { ...test.config.qualification, cache_state: "warm" },
    })).toThrow(/cache_state.*cold/u);
    expect(() => validateNativeAccelerationControllerConfig({
      ...test.config,
      qualification: {
        ...test.config.qualification,
        applied_limits: { ...test.config.qualification.applied_limits, max_indexing_cores: 7 },
      },
    })).toThrow(/max_indexing_cores.*6/u);
    expect(() => validateNativeAccelerationControllerConfig({
      ...test.config,
      qualification: {
        ...test.config.qualification,
        applied_limits: { ...test.config.qualification.applied_limits, max_rss_bytes: 8_000_000_000 },
      },
    })).toThrow(/max_rss_bytes.*8589934592/u);
    expect(() => validateNativeAccelerationControllerConfig({
      ...test.config,
      qualification: {
        ...test.config.qualification,
        applied_limits: { ...test.config.qualification.applied_limits, host: "not-owned-by-controller" },
      },
    })).toThrow(/unknown fields/u);
    expect(() => validateNativeAccelerationControllerConfig({
      ...test.config,
      qualification: { ...test.config.qualification, capture_phase_timings: false },
    })).toThrow(/capture_phase_timings.*true/u);
    expect(() => validateNativeAccelerationControllerConfig({
      ...test.config,
      qualification: { ...test.config.qualification, host: "not-owned-by-controller" },
    })).toThrow(/unknown fields/u);
  });

  it("applies only declared bytes and paths, with before/after and resulting-tree verification", async () => {
    const test = await fixture();
    const trace = validateNativeAccelerationMutationTrace(test.trace);
    const state = await loadNativeAccelerationCorpusState(test.corpus, trace.excluded_paths);
    expect(state.digest).toBe(trace.base_corpus_digest);
    expect(await computeNativeAccelerationCorpusDigest(test.corpus, trace.excluded_paths)).toBe(trace.base_corpus_digest);

    for (const mutation of trace.mutations) await applyNativeAccelerationMutation(test.corpus, state, mutation);
    expect(state.digest).toBe(trace.mutations.at(-1)?.resulting_corpus_digest);
    for (const [path, expected] of test.finalFiles) expect(await readFile(join(test.corpus, ...path.split("/")), "utf8")).toBe(expected);
    await expect(applyNativeAccelerationMutation(test.corpus, state, trace.mutations[0]!)).rejects.toThrow(/mutation_index|before_digest|already applied/u);
  });

  it("preserves an existing file entry for content mutations", async () => {
    const test = await fixture();
    const trace = validateNativeAccelerationMutationTrace(test.trace);
    const state = await loadNativeAccelerationCorpusState(test.corpus, trace.excluded_paths);
    const linkedPath = join(test.root, "linked-a.ts");
    await link(join(test.corpus, "src", "a.ts"), linkedPath);

    await applyNativeAccelerationMutation(test.corpus, state, trace.mutations[0]!);

    expect(await readFile(linkedPath, "utf8")).toBe("export const a = 2;\n");
  });

  it("discovers real corpus candidates and prepares a deterministic representative trace without changing the corpus", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-native-trace-prep-"));
    const corpus = join(root, "corpus");
    await mkdir(corpus);
    const files = new Map<string, string>([
      ["package.json", "{\"name\":\"trace-prep\",\"type\":\"module\"}\n"],
      ["configs/tsconfig.build.json", "{\"compilerOptions\":{}}\n"],
    ]);
    for (let index = 0; index < 64; index += 1) {
      files.set(`src/unit-${String(index).padStart(2, "0")}.ts`, index === 0
        ? "import { value } from './unit-01.js';\nexport { value };\n"
        : `export const value = ${index};\n`);
    }
    await writeCorpus(corpus, files);
    const before = await computeNativeAccelerationCorpusDigest(corpus, []);
    const first = await generateNativeAccelerationMutationTrace({ corpusPath: corpus, traceId: "discovered-typescript-trace", excludedPaths: [] });
    const second = await generateNativeAccelerationMutationTrace({ corpusPath: corpus, traceId: "discovered-typescript-trace", excludedPaths: [] });
    expect(first).toEqual(second);
    expect(first.mutations).toHaveLength(60);
    expect(new Set(first.mutations.map((mutation) => mutation.category))).toEqual(new Set(["content", "import", "create", "delete", "rename", "tsconfig", "manifest"]));
    expect(await computeNativeAccelerationCorpusDigest(corpus, [])).toBe(before);

    const tracePath = join(root, "prepared-trace.json");
    await writeNativeAccelerationMutationTrace(tracePath, first);
    const validation = await validatePreparedNativeAccelerationMutationTrace({ corpusPath: corpus, tracePath });
    expect(validation).toMatchObject({ corpus_digest: before, mutation_count: 60 });
    expect(validation.mutation_trace_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const cliTracePath = join(root, "prepared-by-cli.json");
    await mkdir(join(corpus, ".git"));
    await writeFile(join(corpus, ".git", "index"), "volatile-vcs-state\n", "utf8");
    const cliOutput: string[] = [];
    await runPrepareNativeAccelerationTraceCli([
      "--corpus", corpus,
      "--trace", cliTracePath,
      "--trace-id", "prepared-by-cli",
    ], { stdout: { write: (chunk) => { cliOutput.push(String(chunk)); return true; } } });
    const cliTrace = JSON.parse(await readFile(cliTracePath, "utf8"));
    expect(cliTrace.excluded_paths).toContain(".git");
    await writeFile(join(corpus, ".git", "index"), "changed-after-generation\n", "utf8");
    await runPrepareNativeAccelerationTraceCli(["--validate", "--corpus", corpus, "--trace", cliTracePath], {
      stdout: { write: (chunk) => { cliOutput.push(String(chunk)); return true; } },
    });
    expect(cliOutput.map((line) => JSON.parse(line).status)).toEqual(["generated", "valid"]);
    await expect(runPrepareNativeAccelerationTraceCli(["--corpus", corpus, "--trace", cliTracePath])).rejects.toThrow(/trace-id/u);
  });

  it("validates a controller configuration through its non-campaign CLI path", async () => {
    const test = await fixture();
    const configPath = join(test.root, "controller.json");
    await writeFile(configPath, `${JSON.stringify(test.config, null, 2)}\n`);
    const output: string[] = [];
    await runNativeAccelerationControllerCli(["--config", configPath, "--validate"], {
      stdout: { write: (chunk) => { output.push(String(chunk)); return true; } },
    });
    expect(JSON.parse(output.join(""))).toMatchObject({
      status: "valid",
      schema_version: 2,
      lane: "candidate",
      mutation_count: 60,
      corpus_digest: test.trace.base_corpus_digest,
      configuration_digest: sha256(Buffer.from(`${JSON.stringify(test.config, null, 2)}\n`)),
    });
    await expect(runNativeAccelerationControllerCli([])).rejects.toThrow(/Usage/u);
    await expect(runNativeAccelerationControllerCli(["--unknown"])).rejects.toThrow(/Unknown argument/u);
  });

  it("allows a terminal-looking scan error to recover before its confirmation poll", async () => {
    const test = await fixture();
    const controller = await createNativeAccelerationController({
      ...test.config,
      polling: { interval_ms: 10, readiness_timeout_ms: 2_000 },
    });
    const settled = {
      workspace_id: "workspace:test",
      workspace_status: "ready",
      structural_ready: true,
      structural_freshness: "equivalent",
      current_snapshot_id: "snapshot:new",
    };
    const statuses = [
      {
        workspace_id: "workspace:test",
        workspace_status: "failed",
        structural_ready: false,
        structural_freshness: "stale",
        current_snapshot_id: "snapshot:old",
        last_scan_error_code: "core:plugin_resource_exhausted",
      },
      settled,
    ];
    Object.assign(controller, {
      workspaceId: "workspace:test",
      runtime: {
        async runUrdira() {
          const workspace = statuses.shift() ?? settled;
          return { exit_code: 0, data: { workspaces: [workspace] } };
        },
      },
    });
    await expect(controller.status("snapshot:old")).resolves.toMatchObject({ current_snapshot_id: "snapshot:new" });
  });

  it.each([
    "core:plugin_resource_exhausted",
    "plugin-sdk:worker_protocol_invalid",
    "native:worker_build_identity_mismatch",
    "engine:workspace_scan_analysis_missing",
    "core:workspace_scan_failed",
  ])("fails a sample promptly after confirming terminal scan error %s", async (scanErrorCode) => {
    const test = await fixture();
    const controller = await createNativeAccelerationController({
      ...test.config,
      polling: { interval_ms: 10, readiness_timeout_ms: 30_000 },
    });
    let calls = 0;
    Object.assign(controller, {
      workspaceId: "workspace:test",
      snapshotId: "snapshot:published",
      runtime: {
        async runUrdira() {
          calls += 1;
          return {
            exit_code: 0,
            data: { workspaces: [{
              workspace_id: "workspace:test",
              workspace_status: "degraded",
              current_snapshot_id: "snapshot:published",
              last_scan_error_code: scanErrorCode,
            }] },
          };
        },
      },
    });

    const startedAt = performance.now();
    await expect(controller.status("snapshot:published")).rejects.toThrow(
      `Urdira scan failed with stable terminal error ${scanErrorCode}; last published snapshot remains snapshot:published.`,
    );
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(calls).toBe(2);
    expect(controller.snapshotId).toBe("snapshot:published");
  });

  it("requires a stable ready snapshot before advancing to the next mutation", async () => {
    const test = await fixture();
    const controller = await createNativeAccelerationController({
      ...test.config,
      polling: { interval_ms: 10, readiness_timeout_ms: 2_000 },
    });
    const ready = (snapshot: string) => ({
      workspace_id: "workspace:test",
      workspace_status: "ready",
      structural_ready: true,
      structural_freshness: "equivalent",
      current_snapshot_id: snapshot,
    });
    const statuses = [
      ...Array.from({ length: 5 }, () => ready("snapshot:intermediate")),
      {
        workspace_id: "workspace:test",
        workspace_status: "indexing",
        structural_ready: false,
        structural_freshness: "changes_pending",
        current_snapshot_id: "snapshot:intermediate",
      },
      ready("snapshot:settled"),
    ];
    let calls = 0;
    Object.assign(controller, {
      workspaceId: "workspace:test",
      runtime: {
        async runUrdira() {
          calls += 1;
          const workspace = statuses.shift() ?? ready("snapshot:settled");
          return { exit_code: 0, data: { workspaces: [workspace] } };
        },
      },
    });
    await expect(controller.status("snapshot:old")).resolves.toMatchObject({ current_snapshot_id: "snapshot:settled" });
    expect(calls).toBeGreaterThanOrEqual(56);
  });

  it("fails closed when a scan error persists through the readiness deadline", async () => {
    const test = await fixture();
    const controller = await createNativeAccelerationController({
      ...test.config,
      polling: { interval_ms: 10, readiness_timeout_ms: 1_000 },
    });
    Object.assign(controller, {
      workspaceId: "workspace:test",
      runtime: {
        async runUrdira() {
          return {
            exit_code: 0,
            data: { workspaces: [{ workspace_id: "workspace:test", last_scan_error_code: "engine:workspace_scan_enumeration_failed" }] },
          };
        },
      },
    });
    await expect(controller.status("snapshot:old")).rejects.toThrow(/did not recover from engine:workspace_scan_enumeration_failed/u);
  }, 2_000);

  it("runs real Urdira in foreground and returns the current snapshot's authoritative visible-record-set digest", async () => {
    const test = await fixture();
    const previousSemanticIndex = process.env["URDIRA_SEMANTIC_INDEX"];
    const previousDebugTiming = process.env["URDIRA_DEBUG_TIMING"];
    const previousStorageDebugTiming = process.env["URDIRA_STORAGE_DEBUG_TIMING"];
    process.env["URDIRA_SEMANTIC_INDEX"] = "0";
    let controller: Awaited<ReturnType<typeof createNativeAccelerationController>> | undefined;
    try {
      controller = await createNativeAccelerationController(test.config);
      const prepared = await controller.handle({
        schema_version: 2,
        request_id: "candidate:prepare",
        operation: "prepare",
        campaign_id: "real-controller-test",
        lane: "candidate",
        target: "darwin-arm64",
        corpus_path: test.corpus,
        corpus_digest: test.trace.base_corpus_digest,
        mutation_trace_digest: nativeAccelerationMutationTraceDigest(test.traceBytes),
      });
      expect(prepared).toMatchObject({ status: "ok", corpus_digest: test.trace.base_corpus_digest });

      const cold = await controller.handle({
        schema_version: 2,
        request_id: "candidate:cold_index",
        operation: "cold_index",
        campaign_id: "real-controller-test",
        lane: "candidate",
        target: "darwin-arm64",
        corpus_path: test.corpus,
        corpus_digest: test.trace.base_corpus_digest,
        mutation_trace_digest: nativeAccelerationMutationTraceDigest(test.traceBytes),
      });
      expect(cold.schema_version).toBe(2);
      expect(Object.keys(cold)).toEqual(["schema_version", "request_id", "status", "phase_timings", "visible_set_digest"]);
      expect(cold.visible_set_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(cold.visible_set_digest).not.toBe(test.trace.base_corpus_digest);
      expect(cold.visible_set_digest).toBe(await readNativeAccelerationVisibleSetDigest(test.dataRoot, controller.workspaceId!, controller.snapshotId!));
      expect(cold.phase_timings).toMatchObject({
        unit: "milliseconds",
        phases: [
          { phase: "runtime_load", duration_ms: expect.any(Number) },
          { phase: "daemon_start", duration_ms: expect.any(Number) },
          { phase: "workspace_add", duration_ms: expect.any(Number) },
          { phase: "readiness", duration_ms: expect.any(Number) },
          { phase: "digest", duration_ms: expect.any(Number) },
        ],
        total_duration_ms: expect.any(Number),
      });
      expect(Object.keys(cold.phase_timings)).toEqual(["unit", "phases", "total_duration_ms"]);
      expect(cold.phase_timings.phases.every((phase) => Object.keys(phase).join(",") === "phase,duration_ms")).toBe(true);
      expect(process.env["URDIRA_DEBUG_TIMING"]).toBe("1");
      expect(process.env["URDIRA_STORAGE_DEBUG_TIMING"]).toBe("1");
      const coldSnapshotId = controller.snapshotId;

      const incremental = await controller.handle({
        schema_version: 2,
        request_id: "candidate:incremental_mutation:0",
        operation: "incremental_mutation",
        campaign_id: "real-controller-test",
        lane: "candidate",
        target: "darwin-arm64",
        corpus_path: test.corpus,
        corpus_digest: test.trace.base_corpus_digest,
        mutation_trace_digest: nativeAccelerationMutationTraceDigest(test.traceBytes),
        mutation_index: 0,
      });
      expect(incremental.schema_version).toBe(2);
      expect(Object.keys(incremental)).toEqual(["schema_version", "request_id", "status", "phase_timings", "mutation_index", "visible_set_digest"]);
      expect(controller.snapshotId).not.toBe(coldSnapshotId);
      expect(incremental.mutation_index).toBe(0);
      expect(incremental.phase_timings).toMatchObject({
        unit: "milliseconds",
        phases: [
          { phase: "mutation_apply", duration_ms: expect.any(Number) },
          { phase: "readiness", duration_ms: expect.any(Number) },
          { phase: "digest", duration_ms: expect.any(Number) },
        ],
        total_duration_ms: expect.any(Number),
      });
      expect(incremental.visible_set_digest).toBe(await readNativeAccelerationVisibleSetDigest(test.dataRoot, controller.workspaceId!, controller.snapshotId!));
      const mutationLimit = process.env["URDIRA_NATIVE_CONTROLLER_QUICK"] === "1" ? 1 : 60;
      for (let mutationIndex = 1; mutationIndex < mutationLimit; mutationIndex += 1) {
        const result = await controller.handle({
          schema_version: 2,
          request_id: `candidate:incremental_mutation:${mutationIndex}`,
          operation: "incremental_mutation",
          campaign_id: "real-controller-test",
          lane: "candidate",
          target: "darwin-arm64",
          corpus_path: test.corpus,
          corpus_digest: test.trace.base_corpus_digest,
          mutation_trace_digest: nativeAccelerationMutationTraceDigest(test.traceBytes),
          mutation_index: mutationIndex,
        });
        expect(result.visible_set_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
        expect(result.mutation_index).toBe(mutationIndex);
        expect(result.phase_timings?.phases.map((phase) => phase.phase)).toEqual(["mutation_apply", "readiness", "digest"]);
      }
      if (mutationLimit === 60) {
        await expect(controller.handle({
          schema_version: 2,
          request_id: "candidate:shutdown",
          operation: "shutdown",
          campaign_id: "real-controller-test",
          lane: "candidate",
          target: "darwin-arm64",
          corpus_path: test.corpus,
          corpus_digest: test.trace.base_corpus_digest,
          mutation_trace_digest: nativeAccelerationMutationTraceDigest(test.traceBytes),
        })).resolves.toMatchObject({ status: "ok" });
      }
    } finally {
      await controller?.dispose();
      if (previousSemanticIndex === undefined) delete process.env["URDIRA_SEMANTIC_INDEX"];
      else process.env["URDIRA_SEMANTIC_INDEX"] = previousSemanticIndex;
      if (previousDebugTiming === undefined) delete process.env["URDIRA_DEBUG_TIMING"];
      else process.env["URDIRA_DEBUG_TIMING"] = previousDebugTiming;
      if (previousStorageDebugTiming === undefined) delete process.env["URDIRA_STORAGE_DEBUG_TIMING"];
      else process.env["URDIRA_STORAGE_DEBUG_TIMING"] = previousStorageDebugTiming;
    }
  }, 360_000);
});
