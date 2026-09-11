import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("query microbenchmark harness safety", () => {
  it("imports existsSync and persists rows before cleanup", () => {
    const source = readFileSync(
      new URL(
        "../release/benchmarks/query-microbenchmark.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toMatch(/existsSync/);
    expect(source).toMatch(/persist\(\)/);
    expect(source).toMatch(/stderr:\s*"pipe"/);
    expect(source).toMatch(/transport\.close/);
  });
});
