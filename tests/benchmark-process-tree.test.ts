import { describe, expect, it } from "vitest";
import { sampleProcessTree } from "../release/benchmarks/benchmark-process-tree.mjs";

describe("benchmark process-tree metrics", () => {
  it("includes the requested live root process", () => {
    expect(sampleProcessTree(process.pid)).toMatchObject({
      process_count: expect.any(Number),
      rss_kib: expect.any(Number),
      cpu_percent: expect.any(Number),
    });
    expect(sampleProcessTree(process.pid)?.process_count).toBeGreaterThanOrEqual(1);
    expect(sampleProcessTree(process.pid)?.rss_kib).toBeGreaterThan(0);
  });
});
