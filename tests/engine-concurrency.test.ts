import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../packages/engine/src/index.js";

describe("mapWithConcurrency", () => {
  it("returns an empty array for an empty input without calling fn", async () => {
    let calls = 0;
    const result = await mapWithConcurrency([], 4, async () => { calls += 1; return 0; });
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  it("preserves result order by index even when items settle out of order", async () => {
    const delays = [30, 10, 20, 0, 15];
    const result = await mapWithConcurrency(delays, 4, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    });
    expect(result).toEqual([0, 1, 2, 3, 4]);
  });

  it("never runs more than `limit` calls concurrently", async () => {
    const items = Array.from({ length: 12 }, (_, index) => index);
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(items, 3, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("uses every item when the limit exceeds the item count, without over-calling fn", async () => {
    const items = [1, 2, 3];
    let calls = 0;
    const result = await mapWithConcurrency(items, 100, async (item) => { calls += 1; return item * 2; });
    expect(result).toEqual([2, 4, 6]);
    expect(calls).toBe(3);
  });

  it("treats a non-positive or fractional limit as 1", async () => {
    const items = [1, 2, 3];
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await mapWithConcurrency(items, 0, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return item;
    });
    expect(maxInFlight).toBe(1);
    expect(result).toEqual(items);
  });

  it("rejects when any fn call rejects, having still invoked every item (bounded prefetch, not early-abort)", async () => {
    const items = [1, 2, 3, 4];
    const attempted: number[] = [];
    await expect(mapWithConcurrency(items, 2, async (item) => {
      attempted.push(item);
      if (item === 2) throw new Error(`failed on ${item}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return item;
    })).rejects.toThrow("failed on 2");
    // Give any still-in-flight workers a chance to finish before asserting
    // every item was attempted despite the early rejection.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempted.sort((left, right) => left - right)).toEqual(items);
  });

  it("claims every index exactly once under real async interleaving with randomized delays", async () => {
    const items = Array.from({ length: 50 }, (_, index) => index);
    const seen = new Set<number>();
    const result = await mapWithConcurrency(items, 8, async (item, index) => {
      await new Promise((resolve) => setTimeout(resolve, (index * 7) % 13));
      expect(seen.has(index)).toBe(false);
      seen.add(index);
      return item;
    });
    expect(seen.size).toBe(items.length);
    expect(result).toEqual(items);
  });
});
