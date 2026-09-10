import { describe, expect, it } from "vitest";
import { findWorkerStartupAttestation, parseWorkerStartupAttestation, WORKER_STARTUP_ATTESTATION_PREFIX } from "../release/benchmarks/urdira-worker-attestation.mjs";

describe("Urdira worker startup attestation", () => {
  it("parses the stable diagnostic line and ignores unrelated stderr", () => {
    const line = `${WORKER_STARTUP_ATTESTATION_PREFIX}${JSON.stringify({ schema_version: 1, pid: 42, current_exe: "/tmp/urdira-indexing-worker", debug_timing_enabled: true, semantic_perf_enabled: true })}`;
    expect(parseWorkerStartupAttestation(line)).toMatchObject({ pid: 42, semantic_perf_enabled: true });
    expect(findWorkerStartupAttestation(`other diagnostic\n${line}\n`)).toMatchObject({ current_exe: "/tmp/urdira-indexing-worker" });
  });

  it("rejects malformed or disabled attestations so profiled runs can fail closed", () => {
    const malformed = `${WORKER_STARTUP_ATTESTATION_PREFIX}{"schema_version":1,"pid":0}`;
    const disabled = `${WORKER_STARTUP_ATTESTATION_PREFIX}${JSON.stringify({ schema_version: 1, pid: 42, current_exe: null, debug_timing_enabled: true, semantic_perf_enabled: false })}`;
    expect(parseWorkerStartupAttestation(malformed)).toBeNull();
    expect(findWorkerStartupAttestation(disabled)).toMatchObject({ semantic_perf_enabled: false });
    expect(findWorkerStartupAttestation("no attestation")).toBeNull();
  });
});
