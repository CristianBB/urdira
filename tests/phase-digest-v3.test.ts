import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BucketedMerkleSet, LogicalDigestWriter, MerkleRadixSet, digestLogicalValue, projectionSetDigest, recordSetDigest, rootFromBucketDigests, sourceStateDigest } from "@urdira/canonical";

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

// v4 (index_contract 0x34, plan section 8.2, P2-4): `docs/serialization/
// core-digest-field-contracts.md` rows 89-91 document that a v4 workspace
// computes `canonical_record_set_digest`/`projection_set_digest`/
// `source_state_digest` with the bucketed-Merkle recipes below instead of
// the v3 primitives exercised above (`MerkleRadixSet`, the linear
// `digestSortedRecordSet` array digest). These are the byte-level contract
// tests for that documented recipe -- independent of
// `tests/merkle-bucket.test.ts`'s cross-language vector coverage, which
// checks `BucketedMerkleSet`'s internal tree construction, not the exact
// outer framing the docs promise.
describe("v4 bucketed Merkle digest primitives (index_contract 0x34)", () => {
  const digest = (value: number): string => `sha256:${value.toString(16).padStart(64, "0")}`;

  it("frames canonical_record_set_digest exactly as documented: sha256(domain || u64le(count) || root32)", () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({ member_digest: digest(index + 1), logical_digest: digest(index + 1000) }));
    const tree = BucketedMerkleSet.fromSorted(entries);
    const expected = createHash("sha256")
      .update(Buffer.from("urdira:record-set:v4\0", "utf8"))
      .update((() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(tree.size()), 0); return b; })())
      .update(Buffer.from(tree.root().slice(7), "hex"))
      .digest("hex");
    expect(recordSetDigest(tree.root(), tree.size())).toBe(`sha256:${expected}`);
  });

  it("frames each transactional projection kind exactly as documented: sha256(domain || kind || 0x00 || u64le(count) || root32), dependency/graph/metric only, no lexical/vector", () => {
    const dependencyEntries = Array.from({ length: 5 }, (_, index) => ({ member_digest: digest(index + 1), logical_digest: digest(index + 500) }));
    const dependencyTree = BucketedMerkleSet.fromSorted(dependencyEntries);
    const graphTree = BucketedMerkleSet.fromSorted([]); // no relation-category records in this fixture
    const metricTree = BucketedMerkleSet.fromSorted([]); // metric has no generation-1 producer: canonical empty set

    const entries = [
      { projection_kind: "dependency", tree: dependencyTree },
      { projection_kind: "graph", tree: graphTree },
      { projection_kind: "metric", tree: metricTree },
    ].map(({ projection_kind, tree }) => ({
      projection_kind,
      generator: `core:v4-${projection_kind}-generator`,
      generator_version: "1",
      projection_set_digest: projectionSetDigest(projection_kind, tree.root(), tree.size()),
    }));

    expect(entries.map((entry) => entry.projection_kind)).toEqual(["dependency", "graph", "metric"]);
    expect(entries.some((entry) => entry.projection_kind === "lexical" || entry.projection_kind === "vector")).toBe(false);

    for (const { projection_kind, tree } of [
      { projection_kind: "dependency", tree: dependencyTree },
      { projection_kind: "graph", tree: graphTree },
      { projection_kind: "metric", tree: metricTree },
    ]) {
      const count = Buffer.alloc(8);
      count.writeBigUInt64LE(BigInt(tree.size()), 0);
      const expected = createHash("sha256")
        .update(Buffer.from("urdira:projection-set:v4\0", "utf8"))
        .update(Buffer.from(projection_kind, "utf8"))
        .update(Buffer.from([0]))
        .update(count)
        .update(Buffer.from(tree.root().slice(7), "hex"))
        .digest("hex");
      expect(projectionSetDigest(projection_kind, tree.root(), tree.size())).toBe(`sha256:${expected}`);
    }

    // metric's canonical empty set: root is the literal-zero root, count 0.
    expect(metricTree.root()).toBe(`sha256:${"0".repeat(64)}`);
    expect(metricTree.size()).toBe(0);
  });

  it("frames source_state_digest exactly as documented: sha256(domain || u64le(present_count) || present_root32 || u64le(absent_count) || absent_root32)", () => {
    const sha256Hex = (value: string): string => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
    const present = BucketedMerkleSet.fromSorted([
      { member_digest: sha256Hex("file:///a.ts"), logical_digest: sha256Hex("content-a") },
      { member_digest: sha256Hex("file:///b.ts"), logical_digest: sha256Hex("content-b") },
    ]);
    const absent = BucketedMerkleSet.fromSorted([{ member_digest: sha256Hex("file:///deleted.ts"), logical_digest: sha256Hex("tombstone:deleted") }]);

    const presentCount = Buffer.alloc(8); presentCount.writeBigUInt64LE(BigInt(present.size()), 0);
    const absentCount = Buffer.alloc(8); absentCount.writeBigUInt64LE(BigInt(absent.size()), 0);
    const expected = createHash("sha256")
      .update(Buffer.from("urdira:source-state:v4\0", "utf8"))
      .update(presentCount)
      .update(Buffer.from(present.root().slice(7), "hex"))
      .update(absentCount)
      .update(Buffer.from(absent.root().slice(7), "hex"))
      .digest("hex");

    expect(sourceStateDigest(present.root(), present.size(), absent.root(), absent.size())).toBe(`sha256:${expected}`);
  });

  it("recomputes a persisted tree's root from bucket-level digests alone (the from-scratch check available without a native record-digest export, see v4-verify.ts)", () => {
    const entries = Array.from({ length: 64 }, (_, index) => ({ member_digest: digest(index + 1), logical_digest: digest(index + 2000) }));
    const tree = BucketedMerkleSet.fromSorted(entries);
    expect(rootFromBucketDigests(tree.bucketDigests())).toBe(tree.root());
  });
});
