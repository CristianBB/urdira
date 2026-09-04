#!/usr/bin/env node
/**
 * Generates shared cross-language test vectors for the v4 bucketed Merkle
 * set digest (urdira P0-S3). Consumed by:
 *   - tests/merkle-bucket.test.ts (TypeScript)
 *   - crates/urdira-indexing-core/src/merkle_bucket.rs (Rust, via include_str!)
 *
 * Run after building the canonical package:
 *   pnpm --filter @urdira/canonical build
 *   node scripts/generate-merkle-bucket-vectors.mjs
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BucketedMerkleSet, recordSetDigest, projectionSetDigest } from "@urdira/canonical";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_PATH = resolve(ROOT, "tests/fixtures/digests/merkle-bucket-v4.json");
const PROJECTION_KIND = "graph";

function sha256(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** Deterministic hex digest with a chosen 5-nibble bucket prefix, useful for
 * constructing small vectors that exercise specific bucket relationships
 * without depending on where sha256 happens to place a counter. */
function keyWithPrefix(prefix, filler) {
  if (prefix.length !== 5) throw new Error("prefix must be 5 hex nibbles");
  const hex = (prefix + filler.repeat(64)).slice(0, 64);
  return `sha256:${hex}`;
}

// mulberry32: small, fast, seedable PRNG used only to shuffle insertion
// order for the bulk case below (fromSorted must be order-independent).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, seed) {
  const rand = mulberry32(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildCase(name, entries, extra = {}) {
  const tree = BucketedMerkleSet.fromSorted(entries);
  const root = tree.root();
  const count = tree.size();
  return {
    name,
    entries,
    count,
    root,
    record_set_digest: recordSetDigest(root, count),
    [`projection_set_digest_${PROJECTION_KIND}`]: projectionSetDigest(PROJECTION_KIND, root, count),
    ...extra,
  };
}

function main() {
  const cases = [];

  // Empty set: root is the literal all-zero digest, never a hash.
  cases.push(buildCase("empty", []));

  // A single leaf: exercises the "materialize every ancestor on first
  // insert" path with no siblings anywhere in the tree.
  cases.push(
    buildCase("one_leaf", [{ member_digest: sha256("member-1"), logical_digest: sha256("logical-1") }]),
  );

  // Two leaves sharing all 5 bucket nibbles: both land in the same
  // leafset, ordered by key inside the bucket digest.
  cases.push(
    buildCase("two_leaves_same_bucket", [
      { member_digest: keyWithPrefix("abcde", "1"), logical_digest: sha256("logical-a") },
      { member_digest: keyWithPrefix("abcde", "2"), logical_digest: sha256("logical-b") },
    ]),
  );

  // Two leaves sharing the first 4 nibbles (same depth-4 node) but landing
  // in different buckets (5th nibble differs).
  cases.push(
    buildCase("two_leaves_same_depth4_different_bucket", [
      { member_digest: keyWithPrefix("abcd0", "3"), logical_digest: sha256("logical-c") },
      { member_digest: keyWithPrefix("abcd1", "4"), logical_digest: sha256("logical-d") },
    ]),
  );

  // Two leaves under different top nibbles: the only shared ancestor is
  // the root.
  cases.push(
    buildCase("two_leaves_different_top_nibble", [
      { member_digest: keyWithPrefix("a0000", "5"), logical_digest: sha256("logical-e") },
      { member_digest: keyWithPrefix("b0000", "6"), logical_digest: sha256("logical-f") },
    ]),
  );

  // 1,000 pseudo-random leaves. Keys/logicals are derived deterministically
  // from a counter (sha256(counter) / sha256(counter + ":L")); the
  // mulberry32 PRNG below (seed 20260902) only shuffles insertion order, to
  // prove fromSorted's result does not depend on arrival order.
  const bulkSeed = 20260902;
  const bulkCount = 1000;
  const bulkOrdered = Array.from({ length: bulkCount }, (_, counter) => ({
    member_digest: sha256(String(counter)),
    logical_digest: sha256(`${counter}:L`),
  }));
  const bulkEntries = shuffle(bulkOrdered, bulkSeed);
  cases.push(
    buildCase("random_1000", bulkEntries, {
      generator: {
        kind: "mulberry32-shuffle",
        seed: bulkSeed,
        count: bulkCount,
        key_source: "sha256(counter)",
        logical_source: "sha256(counter + ':L')",
        note: "keys/logicals are deterministic from counter; the seed only shuffles insertion order",
      },
    }),
  );

  // Delete-then-reinsert: build the full set, delete one member, then set
  // it back with the same logical value. The final root must equal a
  // from-scratch build of the same entries.
  const dtrEntries = Array.from({ length: 20 }, (_, counter) => ({
    member_digest: sha256(`dtr-${counter}`),
    logical_digest: sha256(`dtr-${counter}:L`),
  }));
  const reinsertMember = dtrEntries[7];
  cases.push(
    buildCase("delete_then_reinsert", dtrEntries, {
      reinsert_member_digest: reinsertMember.member_digest,
      note: "apply fromSorted(entries), then delete(reinsert_member_digest), then set(reinsert_member_digest, its original logical) — result must equal root/digests below",
    }),
  );

  const document = {
    version: 1,
    spec: "urdira v4 P0-S3 bucketed merkle set",
    bucket_prefix_nibbles: 5,
    bucket_count: 16 ** 5,
    domains: {
      leafset: "urdira:merkle-bucket:leafset\\0",
      node: "urdira:merkle-bucket:node\\0",
      record_set: "urdira:record-set:v4\\0",
      projection_set: "urdira:projection-set:v4\\0",
    },
    projection_kind_used_in_vectors: PROJECTION_KIND,
    cases,
  };

  return document;
}

const document = main();
await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.log(`Wrote ${document.cases.length} cases to ${OUTPUT_PATH}`);
