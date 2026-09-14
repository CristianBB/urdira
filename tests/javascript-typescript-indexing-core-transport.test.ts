import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { chunkSourceIndexCommits, createIndexingCoreProcessTransport } from "../packages/plugin-javascript-typescript/src/indexing-core-process-transport.js";

describe("chunkSourceIndexCommits", () => {
  it("returns the whole array as a single chunk when it already fits the budget", () => {
    const commits = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(chunkSourceIndexCommits(commits, 16 * 1024 * 1024)).toEqual([commits]);
  });

  it("returns a single chunk unchanged for zero or one commit", () => {
    expect(chunkSourceIndexCommits([], 16 * 1024 * 1024)).toEqual([[]]);
    const one = [{ id: "solo" }];
    expect(chunkSourceIndexCommits(one, 16 * 1024 * 1024)).toEqual([one]);
  });

  it("splits an oversized batch into multiple bounded chunks, preserving order", () => {
    // Each commit encodes to roughly 1000 bytes; a 2500-byte budget should
    // pack at most 2 per chunk (90% headroom keeps it from ever landing
    // exactly on a 1000-byte boundary).
    const commits = Array.from({ length: 7 }, (_, index) => ({ id: `commit-${index}`, payload: "x".repeat(950) }));
    const chunks = chunkSourceIndexCommits(commits, 2500);
    expect(chunks.length).toBeGreaterThan(1);
    // Every original commit appears exactly once, in its original order.
    expect(chunks.flat()).toEqual(commits);
    // No chunk exceeds the configured budget fraction of the byte ceiling.
    for (const chunk of chunks) {
      const encodedBytes = chunk.reduce((total: number, commit) => total + Buffer.byteLength(JSON.stringify(commit), "utf8"), 0);
      expect(encodedBytes).toBeLessThanOrEqual(2500);
    }
  });

  it("still emits a single oversized commit alone rather than dropping or splitting it", () => {
    const huge = { id: "huge", payload: "x".repeat(5000) };
    const commits = [{ id: "small" }, huge, { id: "small-2" }];
    const chunks = chunkSourceIndexCommits(commits, 1000);
    expect(chunks.flat()).toEqual(commits);
    expect(chunks.some((chunk) => chunk.length === 1 && chunk[0] === huge)).toBe(true);
  });
});

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

it("does not signal an unspawned worker and consumes its asynchronous error", () => {
  const child = Object.assign(new EventEmitter(), { pid: undefined, kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  expect(() => createIndexingCoreProcessTransport({ command: "/missing-worker" })).toThrow("did not expose a process identity");
  expect(child.kill).not.toHaveBeenCalled();
  expect(() => child.emit("error", new Error("spawn EACCES"))).not.toThrow();
});
