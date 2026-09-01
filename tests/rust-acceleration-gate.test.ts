import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  evaluateNativeAccelerationGate,
} from "../scripts/native-acceleration-gate.mjs";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digest(label: string): string {
  return sha256(label);
}

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(quantile * ordered.length) - 1)]!;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
  }
  return value;
}

function selfDigest(report: Record<string, unknown>): string {
  const { report_digest: _omitted, ...body } = report;
  return sha256(JSON.stringify(stable(body)));
}

interface Fixture {
  report: any;
  evidence: {
    report_bytes: Uint8Array;
    report_checksum: string;
    artifacts: Record<string, Uint8Array>;
  };
}

function fixture(): Fixture {
  const artifacts: Record<string, Uint8Array> = {};
  const campaigns = (["darwin-arm64", "linux-x64-gnu"] as const).flatMap((target) => [1, 2, 3].map((ordinal) => {
    const campaignId = `${target}-qualification-${ordinal}`;
    const runId = `${target}-run-${ordinal}`;
    const makeLane = (lane: "baseline" | "candidate") => {
      const candidate = lane === "candidate";
      const incrementalTimes = Array.from({ length: 60 }, (_, index) => (candidate ? 4_000 : 8_000) + ordinal * 10 + index);
      const visibleSetDigests = [digest(`${campaignId}:cold`), ...Array.from({ length: 60 }, (_, index) => digest(`${campaignId}:mutation:${index}`))];
      const rssSamples = Array.from({ length: 4 }, (_, index) => ({
        elapsed_ms: index * 100,
        process_tree_rss_bytes: (candidate ? 4 : 6) * GIB - index * MIB,
        pids: [1000 + ordinal, 2000 + ordinal],
      }));
      const artifact = (name: string, bytes: Uint8Array) => {
        const path = `/evidence/${campaignId}/${lane}.${name}`;
        artifacts[path] = bytes;
        return { path, digest: sha256(bytes), byte_length: bytes.byteLength };
      };
      const rssLines = rssSamples.map((sample, index) => ({
        sequence: index,
        captured_at: `2026-08-28T12:00:0${index}.000Z`,
        root_pid: sample.pids[0],
        total_rss_bytes: sample.process_tree_rss_bytes,
        processes: [
          { component: "controller", pid: sample.pids[0], ppid: 1, rss_bytes: sample.process_tree_rss_bytes - MIB },
          { component: "worker", pid: sample.pids[1], ppid: sample.pids[0], rss_bytes: MIB },
        ],
      }));
      const rssBytes = Buffer.from(`${rssLines.map((sample) => JSON.stringify(sample)).join("\n")}\n`);
      const phaseTimings = (phases: readonly string[], durationMs: number) => ({
        unit: "milliseconds",
        phases: phases.map((phase) => ({ phase, duration_ms: durationMs })),
        total_duration_ms: phases.length * durationMs,
      });
      const protocolLines = [
        { schema_version: 2, request_id: `${lane}:prepare`, status: "ok", corpus_digest: digest("frozen-corpus"), mutation_trace_digest: digest("mutation-trace") },
        {
          schema_version: 2,
          request_id: `${lane}:cold_index`,
          status: "ok",
          phase_timings: phaseTimings(["runtime_load", "daemon_start", "workspace_add", "readiness", "digest"], 10),
          visible_set_digest: visibleSetDigests[0],
        },
        ...visibleSetDigests.slice(1).map((visibleSetDigest, index) => ({
          schema_version: 2,
          request_id: `${lane}:incremental_mutation:${index}`,
          status: "ok",
          phase_timings: phaseTimings(["mutation_apply", "readiness", "digest"], 10),
          mutation_index: index,
          visible_set_digest: visibleSetDigest,
        })),
        { schema_version: 2, request_id: `${lane}:shutdown`, status: "ok" },
      ];
      const protocolBytes = Buffer.from(`${protocolLines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      return {
        cold_index_ms: (candidate ? 680_000 : 1_000_000) + ordinal * 1_000,
        incremental_times_ms: incrementalTimes,
        visible_set_digests: visibleSetDigests,
        incremental_p95_ms: percentile(incrementalTimes, 0.95),
        peak_process_tree_rss_bytes: Math.max(...rssSamples.map((sample) => sample.process_tree_rss_bytes)),
        raw_evidence: {
          stderr_log: artifact("stderr.log", Buffer.from(`${campaignId}:${lane}:stderr\n`)),
          protocol_log: artifact("protocol.ndjson", protocolBytes),
          rss_series: { ...artifact("rss.ndjson", rssBytes), sample_count: rssLines.length },
        },
      };
    };
    return {
      campaign_id: campaignId,
      target,
      execution_order: ordinal === 2 ? ["candidate", "baseline"] : ["baseline", "candidate"],
      corpus: {
        tier: "L",
        included_files: 81_338,
        logical_source_lines: 2_000_000,
        included_source_bytes: 700 * MIB,
      },
      host: {
        run_id: runId,
        hostname: `${target}-runner`,
        platform: target === "darwin-arm64" ? "darwin" : "linux",
        release: target === "darwin-arm64" ? "25.6.0" : "6.8.0",
        architecture: target === "darwin-arm64" ? "arm64" : "x64",
        cpu_model: target === "darwin-arm64" ? "Apple M reference" : "AMD64 reference",
        physical_cpu_count: 8,
        logical_cpu_count: 8,
        total_memory_bytes: 16 * GIB,
        filesystem_type: target === "darwin-arm64" ? "apfs" : "ext4",
        storage_class: "local_nvme",
        node: "v24.18.1",
        sqlite: "node:sqlite",
        cache_state: "cold",
        max_indexing_cores: 6,
        max_indexing_rss_bytes: 8 * GIB,
      },
      provenance: {
        corpus_digest: digest("frozen-corpus"),
        mutation_trace_digest: digest("mutation-trace"),
        manifest_digest: digest(`${campaignId}:manifest`),
        runtime_module_digest: digest("runtime-module"),
        controller_config_digests: {
          baseline: digest(`${target}:baseline-config`),
          candidate: digest(`${target}:candidate-config`),
        },
        controller_executable_digests: {
          baseline: digest("baseline-controller"),
          candidate: digest("candidate-controller"),
        },
        cargo_lock_digest: digest("cargo-lock"),
        native_closure_digest: digest(`${target}:native-closure`),
      },
      baseline: makeLane("baseline"),
      candidate: makeLane("candidate"),
    };
  }));
  const report: Record<string, unknown> = {
    schema_version: 2,
    generated_at: "2026-08-28T12:00:00.000Z",
    harness: {
      name: "run-native-acceleration-campaign",
      version: 2,
      controller_protocol: "urdira.native-acceleration-controller.v2",
      runner_digest: digest("runner"),
    },
    campaigns,
    report_digest: "",
  };
  report["report_digest"] = selfDigest(report);
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  return {
    report,
    evidence: { report_bytes: reportBytes, report_checksum: sha256(reportBytes), artifacts },
  };
}

function evaluate(test: Fixture = fixture()) {
  return evaluateNativeAccelerationGate(test.report, test.evidence);
}

describe("native acceleration release gate v2", () => {
  it("accepts exactly 3x darwin-arm64 and 3x linux-x64 with complete evidence", () => {
    expect(evaluate()).toMatchObject({ status: "passed", errors: [] });
  });

  it("validates the complete schema as a closed contract", () => {
    const unknown = fixture();
    unknown.report.campaigns[0].candidate.extra = true;
    expect(evaluate(unknown).errors.some((error) => error.includes("unknown fields"))).toBe(true);
    const missing = fixture();
    delete missing.report.campaigns[0].host.filesystem_type;
    expect(evaluate(missing).errors.some((error) => error.includes("host.filesystem_type"))).toBe(true);
    const old = fixture();
    old.report.schema_version = 1;
    expect(evaluate(old).errors.some((error) => error.includes("schema_version must be 2"))).toBe(true);
  });

  it("requires exactly 60 finite incremental times and recomputes P95", () => {
    const short = fixture();
    short.report.campaigns[0].baseline.incremental_times_ms.pop();
    expect(evaluate(short).errors.some((error) => error.includes("exactly 60"))).toBe(true);
    const forged = fixture();
    forged.report.campaigns[0].candidate.incremental_p95_ms = 1;
    expect(evaluate(forged).errors.some((error) => error.includes("does not match"))).toBe(true);
    const invalid = fixture();
    invalid.report.campaigns[0].candidate.incremental_times_ms[0] = Number.NaN;
    expect(evaluate(invalid).errors.some((error) => error.includes("finite positive"))).toBe(true);
  });

  it("requires 61 valid digests and exact cold plus mutation equivalence", () => {
    const missing = fixture();
    missing.report.campaigns[0].candidate.visible_set_digests.pop();
    expect(evaluate(missing).errors.some((error) => error.includes("exactly 61"))).toBe(true);
    const drift = fixture();
    drift.report.campaigns[0].candidate.visible_set_digests[38] = digest("drift");
    expect(evaluate(drift).errors.some((error) => error.includes("incremental mutation 37"))).toBe(true);
  });

  it("verifies the self digest, report sidecar, logs and RSS series", () => {
    const self = fixture();
    self.report.report_digest = digest("forged");
    expect(evaluate(self).errors.some((error) => error.includes("report_digest"))).toBe(true);
    const sidecar = fixture();
    sidecar.evidence.report_checksum = digest("wrong-sidecar");
    expect(evaluate(sidecar).errors.some((error) => error.includes("report checksum"))).toBe(true);
    const log = fixture();
    const logPath = log.report.campaigns[0].baseline.raw_evidence.protocol_log.path;
    log.evidence.artifacts[logPath] = Buffer.from("tampered\n");
    expect(evaluate(log).errors.some((error) => error.includes("artifact checksum"))).toBe(true);
    const rss = fixture();
    const rssPath = rss.report.campaigns[0].candidate.raw_evidence.rss_series.path;
    const raw = Buffer.from(rss.evidence.artifacts[rssPath]!).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    raw[0].total_rss_bytes -= 1;
    raw[0].processes[0].rss_bytes -= 1;
    const bytes = Buffer.from(`${raw.map((sample) => JSON.stringify(sample)).join("\n")}\n`);
    rss.evidence.artifacts[rssPath] = bytes;
    rss.report.campaigns[0].candidate.raw_evidence.rss_series.digest = sha256(bytes);
    rss.report.campaigns[0].candidate.raw_evidence.rss_series.byte_length = bytes.byteLength;
    expect(evaluate(rss).errors.some((error) => error.includes("RSS series does not match"))).toBe(true);
  });

  it("validates the controller v2 phase timings recorded in protocol evidence", () => {
    const invalid = fixture();
    const descriptor = invalid.report.campaigns[0].baseline.raw_evidence.protocol_log;
    const lines = Buffer.from(invalid.evidence.artifacts[descriptor.path]!).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    lines[1].phase_timings.phases[1].phase = "digest";
    const bytes = Buffer.from(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    invalid.evidence.artifacts[descriptor.path] = bytes;
    descriptor.digest = sha256(bytes);
    descriptor.byte_length = bytes.byteLength;
    expect(evaluate(invalid).errors.some((error) => error.includes("phase must be daemon_start"))).toBe(true);
  });

  it("requires trustworthy host metadata and content-addressed provenance", () => {
    const host = fixture();
    host.report.campaigns[0].host.architecture = "x64";
    expect(evaluate(host).errors.some((error) => error.includes("does not match target"))).toBe(true);
    const placeholder = fixture();
    placeholder.report.campaigns[0].host.cpu_model = "unknown";
    expect(evaluate(placeholder).errors.some((error) => error.includes("placeholder"))).toBe(true);
    const drift = fixture();
    drift.report.campaigns[1].provenance.runtime_module_digest = digest("different-runtime");
    expect(evaluate(drift).errors.some((error) => error.includes("provenance differs"))).toBe(true);
  });

  it("requires unique campaign, run, manifest and raw evidence identities with counterbalanced order", () => {
    const run = fixture();
    run.report.campaigns[1].host.run_id = run.report.campaigns[0].host.run_id;
    expect(evaluate(run).errors.some((error) => error.includes("Duplicate run id"))).toBe(true);
    const manifest = fixture();
    manifest.report.campaigns[1].provenance.manifest_digest = manifest.report.campaigns[0].provenance.manifest_digest;
    expect(evaluate(manifest).errors.some((error) => error.includes("manifest digest"))).toBe(true);
    const ordered = fixture();
    for (const campaign of ordered.report.campaigns.filter((entry: any) => entry.target === "darwin-arm64")) campaign.execution_order = ["baseline", "candidate"];
    expect(evaluate(ordered).errors.some((error) => error.includes("counterbalanced"))).toBe(true);
  });

  it("proves tier L within Decision 08 corpus bounds", () => {
    const tooLarge = fixture();
    tooLarge.report.campaigns[0].corpus.included_source_bytes = 2.5 * GIB + 1;
    expect(evaluate(tooLarge).errors.some((error) => error.includes("tier-L bounds"))).toBe(true);
    const medium = fixture();
    medium.report.campaigns[0].corpus = { tier: "L", included_files: 50_000, logical_source_lines: 1_000_000, included_source_bytes: 500 * MIB };
    expect(evaluate(medium).errors.some((error) => error.includes("does not establish tier L"))).toBe(true);
  });

  it("enforces tier-L absolute limits and 25/40/25 improvements", () => {
    const cold = fixture();
    for (const campaign of cold.report.campaigns.filter((entry: any) => entry.target === "darwin-arm64")) campaign.candidate.cold_index_ms = 3_100_000;
    expect(evaluate(cold).errors.some((error) => error.includes("cold-index P95 exceeds 50 minutes"))).toBe(true);
    const incremental = fixture();
    for (const campaign of incremental.report.campaigns.filter((entry: any) => entry.target === "linux-x64-gnu")) {
      campaign.candidate.incremental_times_ms = Array(60).fill(16_000);
      campaign.candidate.incremental_p95_ms = 16_000;
    }
    expect(evaluate(incremental).errors.some((error) => error.includes("incremental P95 exceeds 15 seconds"))).toBe(true);
    const rss = fixture();
    for (const campaign of rss.report.campaigns.filter((entry: any) => entry.target === "darwin-arm64")) campaign.candidate.peak_process_tree_rss_bytes = 8 * GIB + 1;
    expect(evaluate(rss).errors.some((error) => error.includes("RSS exceeds 8 GiB"))).toBe(true);
    const relative = fixture();
    for (const campaign of relative.report.campaigns.filter((entry: any) => entry.target === "linux-x64-gnu")) campaign.candidate.cold_index_ms = campaign.baseline.cold_index_ms * 0.9;
    expect(evaluate(relative).errors.some((error) => error.includes("cold-index improvement is below 25%"))).toBe(true);
  });

  it("rejects invalid divisions and any matrix other than exact 3+3", () => {
    const division = fixture();
    division.report.campaigns[0].baseline.cold_index_ms = 0;
    expect(evaluate(division).errors.some((error) => error.includes("finite positive"))).toBe(true);
    const missing = fixture();
    missing.report.campaigns.pop();
    expect(evaluate(missing).errors.some((error) => error.includes("exactly 3"))).toBe(true);
    const extra = fixture();
    extra.report.campaigns.push(structuredClone(extra.report.campaigns[0]));
    extra.report.campaigns.at(-1).campaign_id = "darwin-arm64-extra";
    extra.report.campaigns.at(-1).host.run_id = "darwin-arm64-extra-run";
    expect(evaluate(extra).errors.some((error) => error.includes("exactly 6 campaigns"))).toBe(true);
  });
});
