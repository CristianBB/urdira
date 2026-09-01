import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeNativeAccelerationCorpusDigest,
} from "../scripts/native-acceleration-controller.mjs";
import {
  classifyNativeAccelerationCorpusTier,
  currentNativeAccelerationTarget,
  runNativeAccelerationCampaign,
  validateNativeAccelerationCampaignManifest,
} from "../scripts/run-native-acceleration-campaign.mjs";

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
  }
  return value;
}

function stableDigest(value: unknown): string {
  return sha256(JSON.stringify(stable(value)));
}

const RUST_TARGETS: Readonly<Record<string, string>> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64-gnu": "aarch64-unknown-linux-gnu",
  "linux-x64-gnu": "x86_64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

const RUNNER_URL = new URL("../scripts/run-native-acceleration-campaign.mjs", import.meta.url);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "urdira-native-campaign-"));
  const repository = join(root, "repo");
  const baselineCorpus = join(root, "baseline-corpus");
  const candidateCorpus = join(root, "candidate-corpus");
  await Promise.all([mkdir(repository), mkdir(baselineCorpus), mkdir(candidateCorpus)]);
  const tierLLineFixture = "\n".repeat(1_000_001);
  await Promise.all([
    writeFile(join(baselineCorpus, "fixture.ts"), "export const fixture = 1;\n", "utf8"),
    writeFile(join(candidateCorpus, "fixture.ts"), "export const fixture = 1;\n", "utf8"),
    writeFile(join(baselineCorpus, "tier-l-lines.txt"), tierLLineFixture, "utf8"),
    writeFile(join(candidateCorpus, "tier-l-lines.txt"), tierLLineFixture, "utf8"),
  ]);

  const controller = join(repository, "controller.mjs");
  const runtimeModule = join(repository, "runtime.mjs");
  const cargoLock = join(repository, "Cargo.lock");
  await writeFile(controller, `
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const configIndex = process.argv.indexOf("--config");
const config = JSON.parse(readFileSync(process.argv[configIndex + 1], "utf8"));
const lane = config.lane;
const different = process.env.FIXTURE_DIFFERENT === "1";
const timings = (phases) => ({ unit: "milliseconds", phases: phases.map((phase) => ({ phase, duration_ms: 0.001 })), total_duration_ms: phases.length * 0.001 });
const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of reader) {
  const request = JSON.parse(line);
  if (request.operation === "shutdown") {
    process.stdout.write(JSON.stringify({ schema_version: 2, request_id: request.request_id, status: "ok" }) + "\\n");
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1));
  const response = { schema_version: 2, request_id: request.request_id, status: "ok" };
  if (request.operation === "prepare") {
    response.corpus_digest = request.corpus_digest;
    response.mutation_trace_digest = request.mutation_trace_digest;
  } else {
    const suffix = request.operation === "cold_index" ? "cold" : String(request.mutation_index).padStart(2, "0");
    response.phase_timings = timings(request.operation === "cold_index" ? ["runtime_load", "daemon_start", "workspace_add", "readiness", "digest"] : ["mutation_apply", "readiness", "digest"]);
    if (request.operation === "incremental_mutation") response.mutation_index = request.mutation_index;
    response.visible_set_digest = "sha256:" + createHash("sha256").update((different && lane === "candidate" ? "different-" : "") + suffix).digest("hex");
  }
  process.stdout.write(JSON.stringify(response) + "\\n");
}
`, "utf8");
  await writeFile(runtimeModule, "export function runUrdira() {}\nexport function defaultDaemonOptions() {}\nexport const URDIRA_ENGINE_BUILD_ID = 'fixture-build';\n", "utf8");
  await writeFile(cargoLock, "# fixture Cargo.lock\nversion = 4\n", "utf8");

  execFileSync("git", ["init", "--quiet"], { cwd: repository });
  execFileSync("git", ["add", "controller.mjs", "runtime.mjs", "Cargo.lock"], { cwd: repository });
  execFileSync("git", ["-c", "user.name=Urdira Tests", "-c", "user.email=tests@urdira.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: repository });

  const corpusDigest = await computeNativeAccelerationCorpusDigest(baselineCorpus, []);
  expect(await computeNativeAccelerationCorpusDigest(candidateCorpus, [])).toBe(corpusDigest);
  const fileContent = Buffer.from("export const fixture = 1;\n", "utf8");
  const trace = {
    schema_version: 1,
    trace_id: "fixture-trace",
    base_corpus_digest: corpusDigest,
    excluded_paths: [],
    mutations: Array.from({ length: 60 }, (_, mutationIndex) => ({
      mutation_index: mutationIndex,
      mutation_id: `mutation-${mutationIndex}`,
      category: "content",
      changes: [{
        kind: "write",
        path: "fixture.ts",
        before_digest: sha256(fileContent),
        after_digest: sha256(fileContent),
        content_base64: fileContent.toString("base64"),
      }],
      resulting_corpus_digest: corpusDigest,
    })),
  };
  const tracePath = join(root, "mutation-trace.json");
  const traceBytes = Buffer.from(`${JSON.stringify(trace, null, 2)}\n`, "utf8");
  await writeFile(tracePath, traceBytes);

  const nativeStage = join(root, "native-stage");
  const nativeRoot = join(nativeStage, "native");
  await mkdir(nativeRoot, { recursive: true });
  const addonBytes = Buffer.from("fixture-addon", "utf8");
  const workerBytes = Buffer.from("fixture-worker", "utf8");
  const workerName = process.platform === "win32" ? "urdira-jsts-syntax-worker.exe" : "urdira-jsts-syntax-worker";
  await Promise.all([
    writeFile(join(nativeRoot, "urdira-native.node"), addonBytes),
    writeFile(join(nativeRoot, workerName), workerBytes),
  ]);
  const nativeIdentity = {
    schema_version: 1,
    target: currentNativeAccelerationTarget(),
    rust_target: RUST_TARGETS[currentNativeAccelerationTarget()],
    binding_api: 16,
    node_api: 10,
    worker_protocol: "urdira.ipc.v2",
    files: {
      addon: { path: "native/urdira-native.node", digest: sha256(addonBytes) },
      worker: { path: `native/${workerName}`, digest: sha256(workerBytes) },
    },
  };
  const nativeManifest = {
    native_manifest_version: 1,
    target: nativeIdentity.target,
    rust_target: nativeIdentity.rust_target,
    binding_api: nativeIdentity.binding_api,
    node_api: nativeIdentity.node_api,
    worker_protocol: nativeIdentity.worker_protocol,
    build_id: stableDigest(nativeIdentity),
    files: nativeIdentity.files,
  };
  const nativeManifestBytes = Buffer.from(`${JSON.stringify(nativeManifest, null, 2)}\n`, "utf8");
  await writeFile(join(nativeRoot, "manifest.json"), nativeManifestBytes);
  const nativeClosureDigest = stableDigest({
    schema_version: 1,
    manifest_digest: sha256(nativeManifestBytes),
    target: nativeManifest.target,
    rust_target: nativeManifest.rust_target,
    build_id: nativeManifest.build_id,
    files: nativeManifest.files,
  });

  const configPath = (lane: "baseline" | "candidate") => join(root, `${lane}-controller.json`);
  const config = (lane: "baseline" | "candidate") => ({
    schema_version: 2,
    lane,
    corpus_path: lane === "baseline" ? baselineCorpus : candidateCorpus,
    mutation_trace_path: tracePath,
    data_root: join(root, `${lane}-data-root`),
    runtime_module: runtimeModule,
    workspace_selection: {
      selected_technology_ids: ["typescript"],
      selected_plugin_ids: ["urdira:javascript_typescript"],
    },
    qualification: {
      mode: "qualifying",
      corpus_tier: "L",
      cache_state: "cold",
      applied_limits: { max_indexing_cores: 6, max_rss_bytes: 8 * 1024 ** 3 },
      capture_phase_timings: true,
    },
    polling: { interval_ms: 10, readiness_timeout_ms: 5_000 },
  });
  const configBytes: Record<"baseline" | "candidate", Buffer> = {
    baseline: Buffer.from(`${JSON.stringify(config("baseline"), null, 2)}\n`, "utf8"),
    candidate: Buffer.from(`${JSON.stringify(config("candidate"), null, 2)}\n`, "utf8"),
  };
  await Promise.all([
    writeFile(configPath("baseline"), configBytes.baseline),
    writeFile(configPath("candidate"), configBytes.candidate),
  ]);

  const command = (lane: "baseline" | "candidate", different = false) => ({
    executable: process.execPath,
    args: [controller, "--config", configPath(lane)],
    cwd: repository,
    environment: lane === "baseline"
      ? { NODE_ENV: "production", URDIRA_NATIVE_REQUIRED: "0", URDIRA_INDEXING_CORE_ORACLE: "1", ...(different ? { FIXTURE_DIFFERENT: "1" } : {}) }
      : { NODE_ENV: "production", URDIRA_NATIVE_REQUIRED: "1", URDIRA_NATIVE_ROOT: nativeRoot, ...(different ? { FIXTURE_DIFFERENT: "1" } : {}) },
  });
  const revision = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  const controllerExecutableDigest = async (lane: "baseline" | "candidate", commandValue = command(lane)) => stableDigest({
    schema_version: 1,
    executable: { path: commandValue.executable, digest: sha256(await readFile(commandValue.executable)) },
    controller_script: { path: commandValue.args[0], digest: sha256(await readFile(commandValue.args[0]!)) },
    command: commandValue,
  });
  const provenance = async (lane: "baseline" | "candidate") => ({
    revision: revision(),
    build_id: "fixture-build",
    configuration_digest: sha256(await readFile(configPath(lane))),
    controller_executable_digest: await controllerExecutableDigest(lane),
    runtime_module_digest: sha256(await readFile(runtimeModule)),
    cargo_lock_digest: sha256(await readFile(cargoLock)),
    native_manifest_digest: lane === "candidate" ? sha256(nativeManifestBytes) : null,
    native_closure_digest: lane === "candidate" ? nativeClosureDigest : null,
  });

  const manifest = {
    schema_version: 2,
    campaign_id: "fixture-campaign-1",
    target: currentNativeAccelerationTarget(),
    corpus: {
      digest: corpusDigest,
      mutation_trace_digest: sha256(traceBytes),
      baseline_path: baselineCorpus,
      candidate_path: candidateCorpus,
    },
    sample_count: 60,
    execution_order: ["baseline", "candidate"],
    rss_sample_interval_ms: 20,
    qualification: {
      cache_state: "cold",
      cache_preparation: "Fresh corpus copies and absent data roots.",
      background_load: "Test runner only.",
      resource_limits: {
        cpu_cores: 6,
        memory_bytes: 8 * 1024 ** 3,
        enforcement: "Fixture process isolation.",
      },
    },
    timeouts: {
      prepare_ms: 5_000,
      cold_index_ms: 5_000,
      mutation_ms: 5_000,
      shutdown_ms: 5_000,
    },
    lanes: {
      baseline: { command: command("baseline"), provenance: await provenance("baseline") },
      candidate: { command: command("candidate"), provenance: await provenance("candidate") },
    },
  };

  async function refreshProvenance(lane: "baseline" | "candidate") {
    const refreshed = await provenance(lane);
    refreshed.controller_executable_digest = await controllerExecutableDigest(lane, manifest.lanes[lane].command);
    manifest.lanes[lane].provenance = refreshed;
  }

  async function commitControllerChange(message: string) {
    execFileSync("git", ["add", "controller.mjs"], { cwd: repository });
    execFileSync("git", ["-c", "user.name=Urdira Tests", "-c", "user.email=tests@urdira.invalid", "commit", "--quiet", "-m", message], { cwd: repository });
    await Promise.all([refreshProvenance("baseline"), refreshProvenance("candidate")]);
  }

  async function run(manifestValue = manifest, name = manifestValue.campaign_id, append = false) {
    const manifestPath = join(root, `${name}.json`);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifestValue, null, 2)}\n`, "utf8");
    await writeFile(manifestPath, manifestBytes);
    return await runNativeAccelerationCampaign(manifestValue, {
      manifestPath,
      reportPath: join(root, "report.json"),
      manifestBytes,
      append,
    });
  }

  return {
    root,
    repository,
    controller,
    runtimeModule,
    tracePath,
    nativeRoot,
    manifest,
    command,
    configPath,
    refreshProvenance,
    commitControllerChange,
    run,
  };
}

describe("native acceleration campaign harness", () => {
  it("emits schema v2 evidence bound to pristine corpus, executables, logs, and RSS samples", async () => {
    const test = await fixture();
    const reportPath = join(test.root, "report.json");
    const result = await test.run();

    expect(result.schema_version).toBe(2);
    expect(result.harness).toEqual({
      name: "run-native-acceleration-campaign",
      version: 2,
      controller_protocol: "urdira.native-acceleration-controller.v2",
      runner_digest: sha256(await readFile(RUNNER_URL)),
    });
    expect(result.campaigns).toHaveLength(1);
    const campaign = result.campaigns[0]!;
    expect(campaign.execution_order).toEqual(["baseline", "candidate"]);
    expect(campaign.host.run_id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
    expect(campaign.corpus).toEqual({ tier: "L", included_files: 2, logical_source_lines: 1_000_002, included_source_bytes: 1_000_027 });
    expect(campaign.host).toMatchObject({
      run_id: expect.any(String),
      hostname: expect.any(String),
      platform: process.platform,
      architecture: process.arch,
      cpu_model: expect.any(String),
      physical_cpu_count: expect.any(Number),
      logical_cpu_count: expect.any(Number),
      total_memory_bytes: expect.any(Number),
      filesystem_type: expect.any(String),
      storage_class: expect.any(String),
      node: process.version,
      sqlite: expect.any(String),
      cache_state: "cold",
      max_indexing_cores: test.manifest.qualification.resource_limits.cpu_cores,
      max_indexing_rss_bytes: test.manifest.qualification.resource_limits.memory_bytes,
    });
    expect(campaign.provenance).toMatchObject({
      corpus_digest: test.manifest.corpus.digest,
      mutation_trace_digest: test.manifest.corpus.mutation_trace_digest,
      manifest_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      runtime_module_digest: test.manifest.lanes.baseline.provenance.runtime_module_digest,
      controller_config_digests: {
        baseline: test.manifest.lanes.baseline.provenance.configuration_digest,
        candidate: test.manifest.lanes.candidate.provenance.configuration_digest,
      },
      controller_executable_digests: {
        baseline: test.manifest.lanes.baseline.provenance.controller_executable_digest,
        candidate: test.manifest.lanes.candidate.provenance.controller_executable_digest,
      },
      cargo_lock_digest: test.manifest.lanes.baseline.provenance.cargo_lock_digest,
      native_closure_digest: test.manifest.lanes.candidate.provenance.native_closure_digest,
    });
    expect(Object.keys(campaign.provenance).sort()).toEqual([
      "cargo_lock_digest",
      "controller_config_digests",
      "controller_executable_digests",
      "corpus_digest",
      "manifest_digest",
      "mutation_trace_digest",
      "native_closure_digest",
      "runtime_module_digest",
    ]);

    for (const lane of [campaign.baseline, campaign.candidate]) {
      expect(Object.keys(lane).sort()).toEqual([
        "cold_index_ms",
        "incremental_p95_ms",
        "incremental_times_ms",
        "peak_process_tree_rss_bytes",
        "raw_evidence",
        "visible_set_digests",
      ]);
      expect(lane.incremental_times_ms).toHaveLength(60);
      expect(lane.visible_set_digests).toHaveLength(61);
      expect(lane.incremental_p95_ms).toBeGreaterThan(0);
      expect(lane.peak_process_tree_rss_bytes).toBeGreaterThan(0);
      for (const artifact of Object.values(lane.raw_evidence)) {
        const bytes = await readFile(artifact.path);
        expect(artifact.digest).toBe(sha256(bytes));
        expect(artifact.byte_length).toBe(bytes.byteLength);
      }
      const rssLines = (await readFile(lane.raw_evidence.rss_series.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(rssLines).toHaveLength(lane.raw_evidence.rss_series.sample_count);
      expect(rssLines[0]).toMatchObject({
        sequence: 0,
        captured_at: expect.any(String),
        root_pid: expect.any(Number),
        total_rss_bytes: expect.any(Number),
        processes: expect.arrayContaining([expect.objectContaining({ component: "controller", pid: expect.any(Number), rss_bytes: expect.any(Number) })]),
      });
      const protocolResponses = (await readFile(lane.raw_evidence.protocol_log.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(protocolResponses).toHaveLength(63);
      expect(protocolResponses[1]).toMatchObject({
        schema_version: 2,
        phase_timings: {
          unit: "milliseconds",
          phases: [
            { phase: "runtime_load", duration_ms: expect.any(Number) },
            { phase: "daemon_start", duration_ms: expect.any(Number) },
            { phase: "workspace_add", duration_ms: expect.any(Number) },
            { phase: "readiness", duration_ms: expect.any(Number) },
            { phase: "digest", duration_ms: expect.any(Number) },
          ],
          total_duration_ms: expect.any(Number),
        },
      });
      expect(protocolResponses[2]).toMatchObject({ schema_version: 2, mutation_index: 0 });
    }

    const { report_digest: _reportDigest, ...withoutReportDigest } = result;
    expect(result.report_digest).toBe(stableDigest(withoutReportDigest));
    const reportBytes = await readFile(reportPath);
    expect(JSON.parse(reportBytes.toString("utf8"))).toEqual(result);
    expect((await readFile(`${reportPath}.sha256`, "utf8")).trim()).toBe(sha256(reportBytes));

    const secondManifest = structuredClone(test.manifest);
    secondManifest.campaign_id = "fixture-campaign-2";
    const { report_digest: _staleDigest, ...staleBody } = structuredClone(result);
    const staleBodyWithRunner = {
      ...staleBody,
      harness: { ...staleBody.harness, runner_digest: sha256("stale-runner") },
    };
    const staleHarness = { ...staleBodyWithRunner, report_digest: stableDigest(staleBodyWithRunner) };
    const staleBytes = Buffer.from(`${JSON.stringify(staleHarness, null, 2)}\n`);
    await writeFile(reportPath, staleBytes);
    await writeFile(`${reportPath}.sha256`, `${sha256(staleBytes)}\n`);
    await expect(test.run(secondManifest, "fixture-campaign-2", true)).rejects.toThrow(/runner_digest/u);
    await writeFile(reportPath, reportBytes);
    await writeFile(`${reportPath}.sha256`, `${sha256(reportBytes)}\n`);
    const appended = await test.run(secondManifest, "fixture-campaign-2", true);
    expect(appended.campaigns.map((entry) => entry.campaign_id)).toEqual(["fixture-campaign-1", "fixture-campaign-2"]);
    const { report_digest: _appendedDigest, ...withoutAppendedDigest } = appended;
    expect(appended.report_digest).toBe(stableDigest(withoutAppendedDigest));
  }, 30_000);

  it("fails closed on implicit commands, invalid resource ceilings, or a non-60 sample count", async () => {
    const test = await fixture();
    const implicitCommand = structuredClone(test.manifest);
    implicitCommand.lanes.baseline.command.executable = "node";
    expect(() => validateNativeAccelerationCampaignManifest(implicitCommand)).toThrow(/absolute executable/u);
    const wrongCount = structuredClone(test.manifest);
    wrongCount.sample_count = 59;
    expect(() => validateNativeAccelerationCampaignManifest(wrongCount)).toThrow(/exactly 60/u);
    const implicitShell = structuredClone(test.manifest);
    Object.assign(implicitShell.lanes.baseline.command, { shell: true });
    expect(() => validateNativeAccelerationCampaignManifest(implicitShell)).toThrow(/unknown fields: shell/u);
    const invalidEnvironment = structuredClone(test.manifest);
    Object.assign(invalidEnvironment.lanes.baseline.command, { environment: { "NOT-PORTABLE!": "value" } });
    expect(() => validateNativeAccelerationCampaignManifest(invalidEnvironment)).toThrow(/portable names/u);
    const duplicateExecutionOrder = structuredClone(test.manifest);
    duplicateExecutionOrder.execution_order = ["baseline", "baseline"];
    expect(() => validateNativeAccelerationCampaignManifest(duplicateExecutionOrder)).toThrow(/exactly once/u);
    const excessiveCpu = structuredClone(test.manifest);
    excessiveCpu.qualification.resource_limits.cpu_cores = 7;
    expect(() => validateNativeAccelerationCampaignManifest(excessiveCpu)).toThrow(/cpu_cores.*6 through 6/u);
    const excessiveMemory = structuredClone(test.manifest);
    excessiveMemory.qualification.resource_limits.memory_bytes = 8 * 1024 ** 3 + 1;
    expect(() => validateNativeAccelerationCampaignManifest(excessiveMemory)).toThrow(/memory_bytes.*8589934592 through 8589934592/u);
  });

  it("rejects substituted config, runtime, trace, revision, native closure, or manifest bytes", async () => {
    const cases: readonly {
      readonly name: string;
      readonly mutate: (test: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void;
      readonly error: RegExp;
    }[] = [
      {
        name: "config",
        mutate: async (test) => { await writeFile(test.configPath("baseline"), "{}\n", "utf8"); },
        error: /configuration_digest.*does not match/u,
      },
      {
        name: "runtime",
        mutate: async (test) => { await writeFile(test.runtimeModule, "export const replaced = true;\n", "utf8"); },
        error: /runtime_module_digest.*does not match/u,
      },
      {
        name: "trace",
        mutate: async (test) => { await writeFile(test.tracePath, "replaced trace\n", "utf8"); },
        error: /mutation_trace_digest.*does not match/u,
      },
      {
        name: "revision",
        mutate: (test) => { test.manifest.lanes.baseline.provenance.revision = "0".repeat(40); },
        error: /revision.*does not match/u,
      },
      {
        name: "native",
        mutate: async (test) => { await writeFile(join(test.nativeRoot, "urdira-native.node"), "replaced addon", "utf8"); },
        error: /native addon checksum mismatch/u,
      },
    ];
    for (const fault of cases) {
      const test = await fixture();
      await fault.mutate(test);
      await expect(test.run(test.manifest, fault.name)).rejects.toThrow(fault.error);
    }

    const manifestMismatch = await fixture();
    const manifestPath = join(manifestMismatch.root, "manifest-mismatch.json");
    const fileBytes = Buffer.from(`${JSON.stringify(manifestMismatch.manifest, null, 2)}\n`, "utf8");
    await writeFile(manifestPath, fileBytes);
    await expect(runNativeAccelerationCampaign(manifestMismatch.manifest, {
      manifestPath,
      reportPath: join(manifestMismatch.root, "manifest-mismatch-report.json"),
      manifestBytes: Buffer.from("{}\n", "utf8"),
    })).rejects.toThrow(/exact manifest bytes/u);
  }, 30_000);

  it("recalculates corpus coordinates and classifies more than 50k included files as tier L", async () => {
    expect(classifyNativeAccelerationCorpusTier({ included_files: 50_001, logical_source_lines: 1, included_source_bytes: 1 })).toBe("L");
    expect(classifyNativeAccelerationCorpusTier({ included_files: 50_000, logical_source_lines: 1, included_source_bytes: 1 })).toBe("M");
    const test = await fixture();
    test.manifest.corpus.digest = `sha256:${"0".repeat(64)}`;
    await expect(test.run(test.manifest, "false-corpus-digest")).rejects.toThrow(/corpus.*digest.*does not match/u);

    const declaredStats = await fixture();
    Object.assign(declaredStats.manifest.corpus, { tier: "L", included_files: 60_000, logical_source_lines: 1, included_source_bytes: 1 });
    expect(() => validateNativeAccelerationCampaignManifest(declaredStats.manifest)).toThrow(/unknown fields/u);
  });

  it("rejects controller config paths or lane identity that do not match the manifest", async () => {
    const test = await fixture();
    const config = JSON.parse(await readFile(test.configPath("baseline"), "utf8"));
    config.lane = "candidate";
    const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await writeFile(test.configPath("baseline"), bytes);
    await test.refreshProvenance("baseline");
    await expect(test.run(test.manifest, "wrong-config-lane")).rejects.toThrow(/controller config lane.*baseline/u);
  });

  it("rejects any baseline/candidate visible-set drift", async () => {
    const test = await fixture();
    test.manifest.lanes.candidate.command = test.command("candidate", true);
    await test.refreshProvenance("candidate");
    await expect(test.run(test.manifest, "visible-drift")).rejects.toThrow(/visible-set digest drift/u);
  }, 20_000);

  it("fails closed for malformed, unsolicited, timed-out, and prematurely closed controller protocols", async () => {
    const cases = [
      { name: "invalid-json", source: `process.stdin.once("data", () => process.stdout.write("not-json\\n"));\nsetInterval(() => {}, 1000);`, error: /stdout must contain only NDJSON/u, prepareMs: 2_000 },
      { name: "wrong-request", source: `process.stdin.once("data", () => process.stdout.write(JSON.stringify({schema_version:1,request_id:"wrong",status:"ok"})+"\\n"));\nsetInterval(() => {}, 1000);`, error: /invalid response/u, prepareMs: 2_000 },
      { name: "extra-field", source: `process.stdin.once("data", (bytes) => {const request=JSON.parse(String(bytes));process.stdout.write(JSON.stringify({schema_version:2,request_id:request.request_id,status:"ok",corpus_digest:request.corpus_digest,mutation_trace_digest:request.mutation_trace_digest,extra:true})+"\\n")});\nsetInterval(() => {}, 1000);`, error: /unknown fields/u, prepareMs: 2_000 },
      { name: "early-exit", source: `process.stdin.once("data", () => process.exit(0));`, error: /exited before responding/u, prepareMs: 2_000 },
      { name: "timeout", source: `process.stdin.resume();\nsetInterval(() => {}, 1000);`, error: /exceeded its 100 ms timeout/u, prepareMs: 100 },
    ];
    for (const fault of cases) {
      const test = await fixture();
      await writeFile(test.controller, fault.source, "utf8");
      await test.commitControllerChange(fault.name);
      test.manifest.timeouts.prepare_ms = fault.prepareMs;
      await expect(test.run(test.manifest, fault.name)).rejects.toThrow(fault.error);
    }
  }, 30_000);
});
