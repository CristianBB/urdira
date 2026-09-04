import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BucketedMerkleSet, projectionSetDigest, recordSetDigest, rootFromBucketDigests } from "@urdira/canonical";

const testRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = resolve(testRoot, "tests/fixtures/digests/merkle-bucket-v4.json");

type Entry = { readonly member_digest: string; readonly logical_digest: string };
type Case = {
  readonly name: string;
  readonly entries: readonly Entry[];
  readonly count: number;
  readonly root: string;
  readonly record_set_digest: string;
  readonly projection_set_digest_graph: string;
  readonly reinsert_member_digest?: string;
};
type Fixture = { readonly bucket_prefix_nibbles: number; readonly projection_kind_used_in_vectors: string; readonly cases: readonly Case[] };

async function loadFixture(): Promise<Fixture> {
  const raw = await readFile(fixturePath, "utf8");
  return JSON.parse(raw) as Fixture;
}

const sha256 = (value: string): string => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

// Small, fast, seedable PRNG (mulberry32) — same recipe as
// scripts/generate-merkle-bucket-vectors.mjs — used only to drive the
// randomized incremental-vs-from-scratch check below.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("BucketedMerkleSet (v4 P0-S3)", () => {
  it("matches every shared cross-language vector", async () => {
    const fixture = await loadFixture();
    expect(fixture.bucket_prefix_nibbles).toBe(5);
    expect(fixture.cases.length).toBeGreaterThan(0);
    for (const testCase of fixture.cases) {
      const tree = BucketedMerkleSet.fromSorted(testCase.entries);
      expect(tree.size(), `${testCase.name}: size`).toBe(testCase.count);
      expect(tree.root(), `${testCase.name}: root`).toBe(testCase.root);
      expect(recordSetDigest(tree.root(), tree.size()), `${testCase.name}: record_set_digest`).toBe(testCase.record_set_digest);
      expect(projectionSetDigest("graph", tree.root(), tree.size()), `${testCase.name}: projection_set_digest`).toBe(testCase.projection_set_digest_graph);

      // fromSorted must not depend on arrival order.
      const reversed = BucketedMerkleSet.fromSorted([...testCase.entries].reverse());
      expect(reversed.root(), `${testCase.name}: order independence`).toBe(testCase.root);

      // Building the same set one member at a time via `set` must match.
      const incremental = new BucketedMerkleSet();
      for (const entry of testCase.entries) incremental.set(entry.member_digest, entry.logical_digest);
      expect(incremental.root(), `${testCase.name}: incremental set`).toBe(testCase.root);
      expect(incremental.size(), `${testCase.name}: incremental size`).toBe(testCase.count);
    }
  });

  it("reproduces the delete-then-reinsert vector via delete()+set()", async () => {
    const fixture = await loadFixture();
    const testCase = fixture.cases.find((candidate) => candidate.name === "delete_then_reinsert");
    expect(testCase).toBeDefined();
    const reinsertKey = testCase!.reinsert_member_digest!;
    const reinsertEntry = testCase!.entries.find((entry) => entry.member_digest === reinsertKey)!;
    expect(reinsertEntry).toBeDefined();

    const tree = BucketedMerkleSet.fromSorted(testCase!.entries);
    tree.delete(reinsertKey);
    expect(tree.size()).toBe(testCase!.count - 1);
    tree.set(reinsertEntry.member_digest, reinsertEntry.logical_digest);
    expect(tree.size()).toBe(testCase!.count);
    expect(tree.root()).toBe(testCase!.root);
  });

  it("treats an empty tree's root as literal zero bytes, not a hash", () => {
    const tree = new BucketedMerkleSet();
    expect(tree.root()).toBe(`sha256:${"0".repeat(64)}`);
    expect(tree.size()).toBe(0);
    tree.set(sha256("solo"), sha256("solo-logical"));
    expect(tree.root()).not.toBe(`sha256:${"0".repeat(64)}`);
    tree.delete(sha256("solo"));
    expect(tree.root()).toBe(`sha256:${"0".repeat(64)}`);
  });

  it("accepts an identical duplicate set as a no-op and rejects a conflicting one", () => {
    const member = sha256("dup-member");
    const logical = sha256("dup-logical");
    const tree = new BucketedMerkleSet();
    tree.set(member, logical);
    expect(() => tree.set(member, logical)).not.toThrow();
    expect(tree.size()).toBe(1);
    expect(() => tree.set(member, sha256("other-logical"))).toThrow(/conflicting/i);

    expect(() =>
      BucketedMerkleSet.fromSorted([
        { member_digest: member, logical_digest: logical },
        { member_digest: member, logical_digest: sha256("other-logical") },
      ]),
    ).toThrow(/conflicting/i);

    const identicalBulk = BucketedMerkleSet.fromSorted([
      { member_digest: member, logical_digest: logical },
      { member_digest: member, logical_digest: logical },
    ]);
    expect(identicalBulk.size()).toBe(1);
  });

  it("deleting a missing member is a no-op", () => {
    const tree = new BucketedMerkleSet();
    tree.set(sha256("present"), sha256("present-logical"));
    const rootBefore = tree.root();
    tree.delete(sha256("absent"));
    expect(tree.root()).toBe(rootBefore);
    expect(tree.size()).toBe(1);
  });

  it("keeps incremental set/delete/change byte-identical to a from-scratch build over 200 randomized rounds", () => {
    const rand = mulberry32(424_242);
    const universe = Array.from({ length: 96 }, (_, index) => ({
      member_digest: sha256(`member-${index}`),
      logical_a: sha256(`logical-a-${index}`),
      logical_b: sha256(`logical-b-${index}`),
    }));
    const present = new Map<string, string>(); // member_digest -> logical currently in the live set
    const incremental = new BucketedMerkleSet();

    for (let round = 0; round < 200; round += 1) {
      const pick = universe[Math.floor(rand() * universe.length)]!;
      const action = rand();
      if (!present.has(pick.member_digest)) {
        // insert (roughly 2/3 of rounds touch an absent member)
        if (action < 0.9) {
          const logical = action < 0.45 ? pick.logical_a : pick.logical_b;
          incremental.set(pick.member_digest, logical);
          present.set(pick.member_digest, logical);
        } else {
          incremental.delete(pick.member_digest); // no-op, member absent
        }
      } else if (action < 0.5) {
        // delete an existing member
        incremental.delete(pick.member_digest);
        present.delete(pick.member_digest);
      } else if (action < 0.8) {
        // re-set with the same logical value: no-op
        incremental.set(pick.member_digest, present.get(pick.member_digest)!);
      } else {
        // change the logical value: delete then re-set (set() would throw on conflict)
        const nextLogical = present.get(pick.member_digest) === pick.logical_a ? pick.logical_b : pick.logical_a;
        incremental.delete(pick.member_digest);
        incremental.set(pick.member_digest, nextLogical);
        present.set(pick.member_digest, nextLogical);
      }

      const fromScratch = BucketedMerkleSet.fromSorted([...present].map(([member_digest, logical_digest]) => ({ member_digest, logical_digest })));
      expect(incremental.root(), `round ${round}`).toBe(fromScratch.root());
      expect(incremental.size(), `round ${round}`).toBe(fromScratch.size());
    }
  });

  it("frames record_set_digest and projection_set_digest exactly per spec", () => {
    const zeroRoot = `sha256:${"0".repeat(64)}`;
    const record = recordSetDigest(zeroRoot, 0);
    const expectedRecord = createHash("sha256")
      .update(Buffer.from("urdira:record-set:v4\0", "utf8"))
      .update(Buffer.from(new Array(8).fill(0)))
      .update(Buffer.alloc(32))
      .digest("hex");
    expect(record).toBe(`sha256:${expectedRecord}`);

    const projection = projectionSetDigest("graph", zeroRoot, 7);
    const count = Buffer.alloc(8);
    count.writeBigUInt64LE(7n, 0);
    const expectedProjection = createHash("sha256")
      .update(Buffer.from("urdira:projection-set:v4\0", "utf8"))
      .update(Buffer.from("graph", "utf8"))
      .update(Buffer.from([0]))
      .update(count)
      .update(Buffer.alloc(32))
      .digest("hex");
    expect(projection).toBe(`sha256:${expectedProjection}`);

    // Different kinds must not collide even with the same count/root.
    expect(projectionSetDigest("dependency", zeroRoot, 7)).not.toBe(projection);
  });

  it("rejects a malformed digest", () => {
    expect(() => new BucketedMerkleSet().set("not-a-digest", sha256("x"))).toThrow(/sha256 digest/i);
    expect(() => new BucketedMerkleSet().set(sha256("x"), "not-a-digest")).toThrow(/sha256 digest/i);
  });

  // P2-4: rootFromBucketDigests/bucketDigests() -- the node-level (0..4)
  // recompute a v4 `lifecycle.verify` can perform from a persisted
  // `structural/merkle/<set>.tree` file's own bucket-level (level 5) slots,
  // without touching any raw member/leaf data.
  describe("rootFromBucketDigests (P2-4)", () => {
    it("reproduces every shared vector's root from its bucket-digest snapshot alone", async () => {
      const fixture = await loadFixture();
      for (const testCase of fixture.cases) {
        const tree = BucketedMerkleSet.fromSorted(testCase.entries);
        const buckets = tree.bucketDigests();
        expect(rootFromBucketDigests(buckets), `${testCase.name}: root from buckets`).toBe(testCase.root);
        expect(rootFromBucketDigests(buckets), `${testCase.name}: root from buckets`).toBe(tree.root());
      }
    });

    it("returns the literal-zero root for an empty bucket map", () => {
      expect(rootFromBucketDigests(new Map())).toBe(`sha256:${"0".repeat(64)}`);
    });

    it("stays in sync with incremental set()/delete() bucket snapshots", () => {
      const tree = new BucketedMerkleSet();
      const members = Array.from({ length: 12 }, (_, index) => ({ member: sha256(`bucket-sync-${index}`), logical: sha256(`bucket-sync-logical-${index}`) }));
      for (const { member, logical } of members) {
        tree.set(member, logical);
        expect(rootFromBucketDigests(tree.bucketDigests())).toBe(tree.root());
      }
      tree.delete(members[0]!.member);
      expect(rootFromBucketDigests(tree.bucketDigests())).toBe(tree.root());
    });

    it("rejects a malformed bucket prefix", () => {
      expect(() => rootFromBucketDigests(new Map([["not-a-prefix", sha256("x")]]))).toThrow(/bucket prefix/i);
    });
  });
});
