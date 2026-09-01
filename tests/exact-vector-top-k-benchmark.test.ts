import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createExactVectorTopKReport,
  evaluateExactVectorTopKGate,
  exactVectorTopKOracle,
  parseExactVectorTopKWorkerArguments,
  runExactVectorTopKOracleSample,
  runExactVectorTopKBenchmark,
  validateExactVectorTopKNativeBinding,
} from "../scripts/exact-vector-top-k-benchmark.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const ADDON_DIGEST = `sha256:${"b".repeat(64)}`;

function float32Bytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function sample(kernelMs: number, endToEndMs: number, rssBytes: number) {
  const matches = [
    { projection_record_id: "alpha", rank: 1 },
    { projection_record_id: "zeta", rank: 2 },
  ];
  return {
    kernel_ms: kernelMs,
    end_to_end_ms: endToEndMs,
    peak_rss_bytes: rssBytes,
    rss_before_bytes: Math.floor(rssBytes / 2),
    rss_after_bytes: Math.floor(rssBytes / 2),
    input_digest: DIGEST,
    result_digest: `sha256:${createHash("sha256").update(JSON.stringify(matches)).digest("hex")}`,
    matches,
  };
}

function workload(label: "small" | "large", candidateCount: number, values: {
  oracle: ReturnType<typeof sample>;
  native: ReturnType<typeof sample>;
}) {
  return {
    label,
    candidate_count: candidateCount,
    samples: Array.from({ length: 5 }, (_, sampleIndex) => ({
      sample_index: sampleIndex,
      execution_order: sampleIndex % 2 === 0 ? ["oracle", "native"] : ["native", "oracle"],
      oracle: structuredClone(values.oracle),
      native: structuredClone(values.native),
      equivalent: true,
    })),
  };
}

function qualifyingEvidence() {
  const tieMatches = [
    { projection_record_id: "alpha", rank: 1 },
    { projection_record_id: "zeta", rank: 2 },
    { projection_record_id: "äther", rank: 3 },
    { projection_record_id: "éclair", rank: 4 },
  ];
  return {
    schema_version: 1,
    generated_at: "2026-08-28T00:00:00.000Z",
    harness: { name: "exact-vector-top-k-benchmark", version: 1, digest: DIGEST },
    configuration: {
      sample_count: 5,
      dimensions: 8,
      k: 100,
      metric: "squared_l2",
      element_type: "float32_le",
      chunk_candidates: 4_096,
      workloads: [
        { label: "small", candidate_count: 100_000, seed: 1_337 },
        { label: "large", candidate_count: 1_000_000, seed: 7_331 },
      ],
    },
    provenance: {
      execution_mode: "real_napi",
      addon: {
        path: "/absolute/urdira-native.node",
        digest: ADDON_DIGEST,
        native_api_version: 16,
        native_target_triple: "aarch64-apple-darwin",
      },
      host: { platform: "darwin", architecture: "arm64", node: "v24.18.1" },
    },
    prerequisite_attribution: {
      source: { path: "/absolute/vector-attribution.json", file_checksum: DIGEST },
      schema_version: 1,
      evidence_kind: "urdira.exact-vector-top-k-attribution.v1",
      provenance: {
        execution_mode: "real_end_to_end_query",
        implementation: "typescript_oracle",
        query_class: "exact_vector_top_k",
        corpus_digest: DIGEST,
        query_digest: DIGEST,
      },
      samples: Array.from({ length: 5 }, (_, index) => ({
        sample_id: `query-${index + 1}`,
        time: { end_to_end_ms: 100, vector_scan_ms: 25 },
        memory: { end_to_end_incremental_peak_rss_bytes: 1_000, vector_scan_incremental_peak_rss_bytes: 100 },
      })),
    },
    workloads: [
      workload("small", 100_000, {
        oracle: sample(100, 100, 1_000),
        native: sample(45, 104, 700),
      }),
      workload("large", 1_000_000, {
        oracle: sample(1_000, 1_000, 1_000),
        native: sample(450, 800, 700),
      }),
    ],
    tie_breaking: {
      cases: ["squared_l2", "cosine"].map((metric) => ({
        metric,
        input_digest: DIGEST,
        oracle_matches: tieMatches,
        native_matches: tieMatches,
        equivalent: true,
      })),
      equivalent: true,
    },
  };
}

describe("exact vector top-k benchmark and promotion gate", () => {
  it("executes the deterministic oracle through the same hierarchical batches as the native lane", () => {
    const result = runExactVectorTopKOracleSample({ label: "coverage", candidateCount: 5_000, seed: 41 });
    expect(result.lane).toBe("oracle");
    expect(result.evaluated_candidates).toBe(5_200);
    expect(result.matches).toHaveLength(100);
    expect(result.input_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.result_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("accepts only the exact N-API version, host target, and batch export", () => {
    const hostTarget = process.platform === "darwin"
      ? (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin")
      : process.platform === "linux"
        ? (process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu")
        : "x86_64-pc-windows-msvc";
    const valid = {
      nativeApiVersion: () => 16,
      nativeTargetTriple: () => hostTarget,
      exactVectorTopKBatch: () => [],
    };
    expect(validateExactVectorTopKNativeBinding(valid)).toMatchObject({ nativeApiVersion: 16, nativeTargetTriple: hostTarget });
    expect(() => validateExactVectorTopKNativeBinding(null)).toThrow(/export an object/u);
    expect(() => validateExactVectorTopKNativeBinding({ ...valid, exactVectorTopKBatch: undefined })).toThrow(/exactVectorTopKBatch/u);
    expect(() => validateExactVectorTopKNativeBinding({ ...valid, nativeApiVersion: () => 15 })).toThrow(/expected 16/u);
    expect(() => validateExactVectorTopKNativeBinding({ ...valid, nativeTargetTriple: () => "wrong-target" })).toThrow(/does not match/u);
  });

  it("parses a closed worker command without shell or implicit addon resolution", () => {
    expect(parseExactVectorTopKWorkerArguments(["--lane", "oracle", "--label", "small", "--candidates", "100", "--seed", "41"]))
      .toEqual({ lane: "oracle", label: "small", candidateCount: 100, seed: 41, addonPath: undefined });
    expect(parseExactVectorTopKWorkerArguments(["--lane", "native", "--label", "large", "--candidates", "1000", "--seed", "42", "--addon", "/tmp/urdira-native.node"]))
      .toEqual({ lane: "native", label: "large", candidateCount: 1_000, seed: 42, addonPath: "/tmp/urdira-native.node" });
    expect(() => parseExactVectorTopKWorkerArguments(["--unknown", "value"])).toThrow(/Unknown worker argument/u);
    expect(() => parseExactVectorTopKWorkerArguments(["--lane"])).toThrow(/requires a value/u);
    expect(() => parseExactVectorTopKWorkerArguments(["--lane", "other", "--candidates", "1", "--seed", "1"])).toThrow(/lane must be/u);
    expect(() => parseExactVectorTopKWorkerArguments(["--lane", "oracle", "--candidates", "0", "--seed", "1"])).toThrow(/must be integers/u);
    expect(() => parseExactVectorTopKWorkerArguments(["--lane", "native", "--candidates", "1", "--seed", "1", "--addon", "relative.node"])).toThrow(/absolute addon/u);
  });

  it("rejects invalid deterministic oracle benchmark configuration", () => {
    for (const configuration of [null, {}, { label: "", candidateCount: 1, seed: 1 }, { label: "x", candidateCount: 0, seed: 1 }, { label: "x", candidateCount: 1, seed: 1.5 }]) {
      expect(() => runExactVectorTopKOracleSample(configuration as never)).toThrow(/configuration is invalid/u);
    }
  });

  it("rejects malformed, unsupported, and non-finite oracle requests", () => {
    const valid = {
      query: float32Bytes([1, 0]),
      candidates: float32Bytes([1, 0]),
      projectionRecordIds: ["alpha"],
      dimensions: 2,
      elementType: "float32_le",
      k: 1,
      metric: "squared_l2",
    };
    const invalid = [
      null,
      { ...valid, dimensions: 0 },
      { ...valid, k: 0 },
      { ...valid, metric: "dot" },
      { ...valid, projectionRecordIds: [""] },
      { ...valid, projectionRecordIds: ["alpha", "alpha"], candidates: float32Bytes([1, 0, 1, 0]) },
      { ...valid, query: [1, 0] },
      { ...valid, elementType: "float16_le" },
      { ...valid, query: float32Bytes([1]) },
      { ...valid, candidates: float32Bytes([1]) },
      { ...valid, query: float32Bytes([Number.NaN, 0]) },
      { ...valid, candidates: float32Bytes([Number.POSITIVE_INFINITY, 0]) },
    ];
    for (const request of invalid) expect(() => exactVectorTopKOracle(request as never)).toThrow();

    expect(() => exactVectorTopKOracle({ ...valid, metric: "cosine", query: float32Bytes([0, 0]) } as never)).toThrow(/zero vectors/u);
    expect(() => exactVectorTopKOracle({ ...valid, metric: "cosine", candidates: float32Bytes([0, 0]) } as never)).toThrow(/zero vectors/u);
    expect(exactVectorTopKOracle({ ...valid, metric: "cosine" } as never)).toEqual([{ projection_record_id: "alpha", rank: 1 }]);
  });

  it("uses exact UTF-8 identifier ordering for distance ties", () => {
    const matches = exactVectorTopKOracle({
      query: float32Bytes([1, 0]),
      candidates: float32Bytes([1, 0, 1, 0, 1, 0, 1, 0]),
      projectionRecordIds: ["éclair", "äther", "zeta", "alpha"],
      dimensions: 2,
      elementType: "float32_le",
      k: 4,
      metric: "squared_l2",
    });
    expect(matches).toEqual([
      { projection_record_id: "alpha", rank: 1 },
      { projection_record_id: "zeta", rank: 2 },
      { projection_record_id: "äther", rank: 3 },
      { projection_record_id: "éclair", rank: 4 },
    ]);
  });

  it("activates when the exact native kernel is real, equivalent, and improves end-to-end latency", () => {
    const report = createExactVectorTopKReport(qualifyingEvidence());
    expect(evaluateExactVectorTopKGate(report)).toMatchObject({
      status: "activate",
      checks: {
        exact_ordered_equivalence: true,
        deterministic_tie_breaking: true,
        real_napi_addon: true,
        real_query_attribution: true,
        target_scale_kernel_gain: true,
        large_end_to_end_improvement: true,
        small_end_to_end_regression: true,
      },
    });
    expect(report.evidence_checksum).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("fails closed for a seam, checksum drift, result drift, or a threshold miss", () => {
    const seam = qualifyingEvidence();
    seam.provenance.execution_mode = "unit_test_seam";
    (seam.provenance as { addon: unknown }).addon = null;
    expect(evaluateExactVectorTopKGate(createExactVectorTopKReport(seam)).errors)
      .toContain("Promotion requires measurements from a real N-API addon.");

    const drift = qualifyingEvidence();
    drift.workloads[1]!.samples[0]!.native.matches[0]!.projection_record_id = "different";
    expect(evaluateExactVectorTopKGate(createExactVectorTopKReport(drift)).checks.exact_ordered_equivalence).toBe(false);

    const slow = qualifyingEvidence();
    for (const entry of slow.workloads[1]!.samples) {
      entry.native.kernel_ms = 800;
      entry.native.peak_rss_bytes = 900;
      entry.native.end_to_end_ms = 900;
    }
    const slowResult = evaluateExactVectorTopKGate(createExactVectorTopKReport(slow));
    expect(slowResult.checks.target_scale_kernel_gain).toBe(false);
    expect(slowResult.checks.large_end_to_end_improvement).toBe(false);

    const checksum = createExactVectorTopKReport(qualifyingEvidence());
    checksum.evidence.workloads[0]!.samples[0]!.native.kernel_ms = 1;
    expect(evaluateExactVectorTopKGate(checksum).errors.some((error: string) => error.includes("checksum"))).toBe(true);
  });

  it("fails closed for malformed envelopes, stored decisions, samples, ties, and execution errors", () => {
    expect(evaluateExactVectorTopKGate(null)).toMatchObject({ status: "do_not_activate" });
    const explosive = new Proxy({}, { get() { throw new Error("explosive evidence"); } });
    expect(evaluateExactVectorTopKGate(explosive)).toMatchObject({ status: "do_not_activate", errors: ["Invalid exact vector top-k evidence: explosive evidence"] });
    expect(() => createExactVectorTopKReport(null as never)).toThrow(/must be an object/u);

    const storedDecision = createExactVectorTopKReport(qualifyingEvidence());
    (storedDecision.decision as { status: "activate" | "do_not_activate" }).status = "do_not_activate";
    expect(evaluateExactVectorTopKGate(storedDecision).errors).toContain("Stored promotion decision does not match the evidence.");

    const invalidWorkload = qualifyingEvidence();
    invalidWorkload.workloads[0] = null as never;
    const invalidWorkloadResult = evaluateExactVectorTopKGate(createExactVectorTopKReport(invalidWorkload));
    expect(invalidWorkloadResult.checks.sufficient_samples).toBe(false);
    expect(invalidWorkloadResult.checks.exact_ordered_equivalence).toBe(false);

    const invalidSample = qualifyingEvidence();
    invalidSample.workloads[0]!.samples[0]!.native.kernel_ms = -1;
    expect(evaluateExactVectorTopKGate(createExactVectorTopKReport(invalidSample)).errors)
      .toContain("One or more paired samples contain invalid or internally inconsistent measurements.");

    const invalidTie = qualifyingEvidence();
    invalidTie.tie_breaking.cases[0]!.native_matches[0]!.rank = 2;
    expect(evaluateExactVectorTopKGate(createExactVectorTopKReport(invalidTie)).checks.deterministic_tie_breaking).toBe(false);

    const executionFailure = qualifyingEvidence();
    Object.assign(executionFailure, { execution_errors: ["native worker crashed"] });
    expect(evaluateExactVectorTopKGate(createExactVectorTopKReport(executionFailure)).errors)
      .toContain("Benchmark execution failed: native worker crashed");
  });

  it("keeps attribution and the stretch kernel target as diagnostics rather than activation blockers", () => {
    const { prerequisite_attribution: _prerequisiteAttribution, ...missing } = qualifyingEvidence();
    const missingResult = evaluateExactVectorTopKGate(createExactVectorTopKReport(missing));
    expect(missingResult.status).toBe("activate");
    expect(missingResult.checks.real_query_attribution).toBe(false);

    const belowThreshold = qualifyingEvidence();
    for (const entry of belowThreshold.prerequisite_attribution.samples) {
      entry.time.vector_scan_ms = 19;
      entry.memory.vector_scan_incremental_peak_rss_bytes = 199;
      entry.memory.end_to_end_incremental_peak_rss_bytes = 1_000;
    }
    const belowResult = evaluateExactVectorTopKGate(createExactVectorTopKReport(belowThreshold));
    expect(belowResult.status).toBe("activate");
    expect(belowResult.checks.real_query_attribution).toBe(false);
    expect(belowResult.errors.some((error: string) => error.includes("20%"))).toBe(false);

    const belowStretchTarget = qualifyingEvidence();
    for (const entry of belowStretchTarget.workloads[1]!.samples) {
      entry.native.kernel_ms = 650;
      entry.native.peak_rss_bytes = 950;
      entry.native.end_to_end_ms = 800;
    }
    const stretchResult = evaluateExactVectorTopKGate(createExactVectorTopKReport(belowStretchTarget));
    expect(stretchResult.status).toBe("activate");
    expect(stretchResult.checks.target_scale_kernel_gain).toBe(false);

    const memoryQualified = qualifyingEvidence();
    for (const entry of memoryQualified.prerequisite_attribution.samples) {
      entry.time.vector_scan_ms = 10;
      entry.memory.vector_scan_incremental_peak_rss_bytes = 250;
    }
    expect(evaluateExactVectorTopKGate(createExactVectorTopKReport(memoryQualified)).status).toBe("activate");

    const exactBoundary = qualifyingEvidence();
    for (const entry of exactBoundary.prerequisite_attribution.samples) {
      entry.time.vector_scan_ms = 20;
      entry.memory.vector_scan_incremental_peak_rss_bytes = 0;
    }
    expect(evaluateExactVectorTopKGate(createExactVectorTopKReport(exactBoundary)).status).toBe("activate");
  });

  it("runs reduced workloads through the controlled unit-test seam but never promotes them", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-vector-top-k-benchmark-"));
    const outputPath = join(root, "evidence.json");
    const matches = [
      { projection_record_id: "alpha", rank: 1 },
      { projection_record_id: "zeta", rank: 2 },
    ];
    const report = await runExactVectorTopKBenchmark({
      executionMode: "unit_test_seam",
      outputPath,
      sampleCount: 2,
      workloads: [
        { label: "small", candidateCount: 32, seed: 1_337 },
        { label: "large", candidateCount: 64, seed: 7_331 },
      ],
      unitTestSeam: {
        async runSample({ lane, workload }) {
          return {
            ...sample(lane === "oracle" ? 10 : 4, lane === "oracle" ? 12 : 9, lane === "oracle" ? 1_000 : 650),
            input_digest: createHash("sha256").update(workload.label).digest("hex").padStart(64, "0").slice(0, 64).replace(/^/u, "sha256:"),
            matches,
          };
        },
        runTieCase() {
          return matches;
        },
      },
    });
    expect(report.decision.status).toBe("do_not_activate");
    expect(report.decision.errors).toContain("Promotion requires measurements from a real N-API addon.");
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
    expect((await readFile(`${outputPath}.sha256`, "utf8")).trim()).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("validates controlled benchmark options and records lane failures without fabricating tie evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-vector-top-k-errors-"));
    const outputPath = join(root, "evidence.json");
    await expect(runExactVectorTopKBenchmark(null as never)).rejects.toThrow(/options are required/u);
    await expect(runExactVectorTopKBenchmark({ executionMode: "unknown", outputPath } as never)).rejects.toThrow(/Unknown benchmark/u);
    await expect(runExactVectorTopKBenchmark({ executionMode: "unit_test_seam", outputPath: "relative" } as never)).rejects.toThrow(/absolute/u);
    await expect(runExactVectorTopKBenchmark({ executionMode: "unit_test_seam", outputPath, sampleCount: 0 } as never)).rejects.toThrow(/at least 5/u);
    await expect(runExactVectorTopKBenchmark({ executionMode: "unit_test_seam", outputPath, sampleCount: 1, workloads: [] } as never)).rejects.toThrow(/exactly two/u);
    await expect(runExactVectorTopKBenchmark({ executionMode: "real_napi", outputPath, sampleCount: 5, workloads: [] } as never)).rejects.toThrow(/fixed at 100K and 1M/u);
    await expect(runExactVectorTopKBenchmark({
      executionMode: "unit_test_seam",
      outputPath,
      sampleCount: 1,
      workloads: [{ label: "small", candidateCount: 0, seed: 1 }, { label: "large", candidateCount: 1, seed: 2 }],
    } as never)).rejects.toThrow(/Invalid controlled/u);

    const report = await runExactVectorTopKBenchmark({
      executionMode: "unit_test_seam",
      outputPath,
      sampleCount: 1,
      workloads: [{ label: "small", candidateCount: 1, seed: 1 }, { label: "large", candidateCount: 1, seed: 2 }],
      unitTestSeam: {
        runSample() { throw new Error("controlled lane failure"); },
        runTieCase() { throw new Error("must not run"); },
      },
    });
    expect(report.evidence["execution_errors"]).toEqual(["small sample 0: controlled lane failure"]);
    expect(report.evidence["tie_breaking"]).toEqual({ cases: [], equivalent: false });
  });
});
