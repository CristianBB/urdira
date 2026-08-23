import { describe, expect, it } from "vitest";
import { LogicalDigestWriter, MerkleRadixSet, digestLogicalValue } from "@urdira/canonical";

const digest = (value: number): string => `sha256:${value.toString(16).padStart(64, "0")}`;

describe("v3 incremental digest primitives", () => {
  it("keeps bulk Merkle construction byte-equivalent to ordered updates", () => {
    const entries = Array.from({ length: 32 }, (_, index) => ({ member_digest: digest(index + 1), logical_digest: digest(index + 100) }));
    const incremental = new MerkleRadixSet();
    for (const entry of entries) incremental.set(entry.member_digest, entry.logical_digest);
    const bulk = MerkleRadixSet.from(entries.toReversed());
    expect(bulk.root()).toBe(incremental.root());
    expect(bulk.size()).toBe(entries.length);
    expect(bulk.metrics.leaves_modified).toBe(entries.length);
    expect(bulk.metrics.nodes_recalculated).toBeGreaterThan(0);
    bulk.delete(entries[0]!.member_digest);
    expect(bulk.size()).toBe(entries.length - 1);
  });

  it("rejects conflicting duplicate members and frames logical fields incrementally", () => {
    expect(() => MerkleRadixSet.from([{ member_digest: digest(1), logical_digest: digest(2) }, { member_digest: digest(1), logical_digest: digest(3) }])).toThrow(/conflicting/);
    const writer = new LogicalDigestWriter("urdira:test:v3");
    writer.field("present", true, () => writer.value({ unicode: "ñ", nested: [null, true, 3] }));
    writer.field("absent", false, () => writer.null());
    expect(writer.metrics.bytes_hashed).toBeGreaterThan(0);
    expect(writer.metrics.collections_ordered).toBeGreaterThan(0);
    writer.value(new Uint8Array([1, 2, 3])).value(12n).value(1.5);
    expect(() => writer.value(Symbol("unsupported"))).toThrow(/Unsupported/);
    expect(digestLogicalValue({ a: 1, b: [2, 3] }, "urdira:test:v3")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("handles empty and malformed Merkle inputs without corpus materialisation", () => {
    const empty = MerkleRadixSet.from([]);
    expect(empty.root()).toMatch(/^sha256:0{64}$/);
    expect(empty.size()).toBe(0);
    expect(empty.nodesSnapshot()).toEqual([]);
    expect(empty.leavesSnapshot()).toEqual([]);
    expect(empty.verify([])).toBe(true);
    empty.delete(digest(404));
    expect(() => empty.set("not-a-digest", digest(1))).toThrow(/sha256 digests/i);
    expect(() => MerkleRadixSet.from([{ member_digest: digest(1), logical_digest: "bad" }])).toThrow(/sha256 digests/i);
    const unprefixed = new MerkleRadixSet();
    unprefixed.set(digest(5).slice(7), digest(6));
    expect(unprefixed.size()).toBe(1);
  });

  it("recomputes only one radix path for a local member update", () => {
    const tree = MerkleRadixSet.from(Array.from({ length: 128 }, (_, index) => ({ member_digest: digest(index + 10), logical_digest: digest(index + 1000) })));
    const before = tree.metrics.nodes_recalculated;
    tree.set(digest(42), digest(9999));
    expect(tree.metrics.nodes_recalculated - before).toBeLessThanOrEqual(64);
    expect(tree.root()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects invalid scalar digest values", () => {
    expect(() => new LogicalDigestWriter().real(Number.NaN)).toThrow(/finite/i);
    expect(() => new LogicalDigestWriter().real(-0)).toThrow(/negative zero/i);
    const writer = new LogicalDigestWriter();
    writer.text(0, "x").digest();
    expect(() => writer.digest()).toThrow(/finalized/i);
  });
});
