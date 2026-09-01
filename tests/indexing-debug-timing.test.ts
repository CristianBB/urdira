import { afterEach, describe, expect, it } from "vitest";
import {
  record as recordEngine,
  resetTimings as resetEngine,
  snapshotTimings as snapshotEngine,
} from "../packages/engine/src/debug-timing.js";
import {
  record as recordStorage,
  resetTimings as resetStorage,
  snapshotTimings as snapshotStorage,
} from "../packages/storage/src/debug-timing.js";

const previous = process.env["URDIRA_STORAGE_DEBUG_TIMING"];

afterEach(() => {
  resetEngine();
  resetStorage();
  if (previous === undefined) delete process.env["URDIRA_STORAGE_DEBUG_TIMING"];
  else process.env["URDIRA_STORAGE_DEBUG_TIMING"] = previous;
});

describe("opt-in indexing performance trace", () => {
  it("reports nearest-rank P50/P95/P99 without collecting samples while disabled", () => {
    delete process.env["URDIRA_STORAGE_DEBUG_TIMING"];
    recordEngine("phase", 99);
    expect(snapshotEngine()).toEqual({});

    process.env["URDIRA_STORAGE_DEBUG_TIMING"] = "1";
    for (let sample = 1; sample <= 100; sample += 1) {
      recordEngine("phase", sample);
      recordStorage("sql", sample * 2);
    }
    expect(snapshotEngine()["phase"]).toEqual({ ms: 5_050, count: 100, p50_ms: 50, p95_ms: 95, p99_ms: 99 });
    expect(snapshotStorage()["sql"]).toEqual({ ms: 10_100, count: 100, p50_ms: 100, p95_ms: 190, p99_ms: 198 });
  });
});
