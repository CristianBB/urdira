import { createHash } from "node:crypto";

const BUCKET_NIBBLES = 5;
const ZERO_BYTES = Buffer.alloc(32);
const ZERO = `sha256:${ZERO_BYTES.toString("hex")}`;
const DOMAIN_LEAFSET = Buffer.from("urdira:merkle-bucket:leafset\0", "utf8");
const DOMAIN_NODE = Buffer.from("urdira:merkle-bucket:node\0", "utf8");
const DOMAIN_RECORD_SET = Buffer.from("urdira:record-set:v4\0", "utf8");
const DOMAIN_PROJECTION_SET = Buffer.from("urdira:projection-set:v4\0", "utf8");
const DOMAIN_SOURCE_STATE = Buffer.from("urdira:source-state:v4\0", "utf8");

function digest(parts: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return `sha256:${hash.digest("hex")}`;
}

function digestBytes(value: string): Buffer {
  const hex = value.startsWith("sha256:") ? value.slice(7) : value;
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new TypeError("Merkle bucket keys and values must be sha256 digests.");
  return Buffer.from(hex, "hex");
}

function keyHex(value: string): string {
  return digestBytes(value).toString("hex");
}

function u32le(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function u64le(value: number | bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value), 0);
  return buffer;
}

/**
 * `EMPTY_NODE[d]` is the digest of a depth-`d` internal node whose entire
 * subtree (every bucket beneath it) is empty. Internal nodes are hashed
 * unconditionally — even when all 16 children are themselves empty — so an
 * untouched sibling branch still has a real, well-defined digest. This table
 * lets an incremental `set`/`delete` fall back to the correct value for a
 * sibling that has never been materialized, instead of having to build the
 * whole 16^5-bucket tree up front.
 */
function computeEmptySubtreeDigests(): readonly string[] {
  const table: string[] = new Array(5);
  let child: Buffer = ZERO_BYTES;
  for (let depth = 4; depth >= 0; depth -= 1) {
    const children: Buffer[] = new Array(16).fill(child);
    const value = digest([DOMAIN_NODE, Buffer.from([depth]), ...children]);
    table[depth] = value;
    child = digestBytes(value);
  }
  return table;
}

/** Depth is always 0..4, so this index is always populated. */
function emptyNodeDigest(depth: number): string {
  return EMPTY_NODE[depth]!;
}

const EMPTY_NODE = computeEmptySubtreeDigests();

function computeBucketDigest(members: ReadonlyMap<string, string>): string {
  const keys = [...members.keys()].sort();
  const parts: Buffer[] = [DOMAIN_LEAFSET, u32le(keys.length)];
  for (const key of keys) {
    parts.push(Buffer.from(key, "hex"));
    parts.push(digestBytes(members.get(key)!));
  }
  return digest(parts);
}

/**
 * Bucketed Merkle set: members are grouped into 16^5 = 1,048,576 buckets by
 * the first 5 hex nibbles (top 20 bits) of their 32-byte key. A `set`/
 * `delete` touches exactly one bucket digest plus 5 ancestor node digests,
 * independent of the total set size.
 *
 * This replaces `MerkleRadixSet` for v4 record/projection set digests:
 * `MerkleRadixSet` chains a node for every one of the 64 nibble-prefixes of
 * a random 256-bit key (~58 useful levels per leaf), which is ~190M SHA-256
 * for a 3.2M-member set. This fixed 5-level fan-out design needs a bucket
 * hash plus 5 node hashes per touched key, and none at all for an untouched
 * sibling bucket.
 */
export class BucketedMerkleSet {
  private readonly membersByBucket = new Map<string, Map<string, string>>();
  private readonly bucketDigest = new Map<string, string>();
  private readonly nodeDigest = new Map<string, string>();
  private count = 0;

  /**
   * Build a set in one bottom-up pass. Entries need not be pre-sorted (they
   * are grouped by bucket and sorted internally). Duplicate member keys are
   * accepted only when their logical value is identical, making the result
   * independent of arrival order.
   */
  static fromSorted(entries: Iterable<{ readonly member_digest: string; readonly logical_digest: string }>): BucketedMerkleSet {
    const tree = new BucketedMerkleSet();
    const logicalByKey = new Map<string, string>();
    for (const entry of entries) {
      const key = keyHex(entry.member_digest);
      digestBytes(entry.logical_digest);
      const previous = logicalByKey.get(key);
      if (previous !== undefined && previous !== entry.logical_digest) throw new TypeError("Merkle bucket duplicate member has conflicting logical digests.");
      logicalByKey.set(key, entry.logical_digest);
    }
    for (const [key, logical] of logicalByKey) {
      const bucketPrefix = key.slice(0, BUCKET_NIBBLES);
      let bucket = tree.membersByBucket.get(bucketPrefix);
      if (!bucket) {
        bucket = new Map();
        tree.membersByBucket.set(bucketPrefix, bucket);
      }
      bucket.set(key, logical);
    }
    tree.count = logicalByKey.size;
    for (const [bucketPrefix, bucket] of tree.membersByBucket) tree.bucketDigest.set(bucketPrefix, computeBucketDigest(bucket));
    for (let depth = 4; depth >= 0; depth -= 1) {
      const prefixes = new Set<string>();
      for (const bucketPrefix of tree.membersByBucket.keys()) prefixes.add(bucketPrefix.slice(0, depth));
      for (const prefix of prefixes) tree.nodeDigest.set(prefix, tree.computeNode(depth, prefix));
    }
    return tree;
  }

  /**
   * Streaming-friendly variant of {@link fromSorted}: consumes a sequence
   * of entry batches (e.g. one napi round trip's worth each) rather than
   * one flat `Iterable`, so a caller paging a native/raw source (a
   * `cursor`-based iterator over `N*32`-byte buffers, say) never needs to
   * materialize its own single combined array of decoded `{member_digest,
   * logical_digest}` objects before calling in -- each batch is decoded
   * and consumed lazily, one at a time, via a flattening generator.
   *
   * This does NOT reduce this class's own memory footprint (every member
   * still lands in `membersByBucket`, exactly as {@link fromSorted}
   * builds it -- a Merkle set inherently needs every leaf to compute its
   * root) -- it only avoids a second, redundant copy of the same data in
   * an intermediate flat array on the caller's side. At v4 corpus scale
   * (~1.5M members x 64 bytes of hex-string overhead each) that avoided
   * copy is the difference between one array and two.
   */
  static fromSortedBatches(batches: Iterable<Iterable<{ readonly member_digest: string; readonly logical_digest: string }>>): BucketedMerkleSet {
    function* flatten(): Generator<{ readonly member_digest: string; readonly logical_digest: string }> {
      for (const batch of batches) yield* batch;
    }
    return BucketedMerkleSet.fromSorted(flatten());
  }

  /** Insert or update a member. Setting an existing key to its current
   * logical value is a no-op; setting it to a different logical value
   * throws. */
  set(memberDigest: string, logicalDigest: string): void {
    const key = keyHex(memberDigest);
    digestBytes(logicalDigest);
    const bucketPrefix = key.slice(0, BUCKET_NIBBLES);
    const bucket = this.membersByBucket.get(bucketPrefix);
    const existing = bucket?.get(key);
    if (existing !== undefined) {
      if (existing !== logicalDigest) throw new TypeError("Merkle bucket duplicate member has conflicting logical digests.");
      return;
    }
    const target = bucket ?? new Map<string, string>();
    if (!bucket) this.membersByBucket.set(bucketPrefix, target);
    target.set(key, logicalDigest);
    this.count += 1;
    this.recompute(bucketPrefix);
  }

  /** Remove a member. Deleting a member that is not present is a no-op. */
  delete(memberDigest: string): void {
    const key = keyHex(memberDigest);
    const bucketPrefix = key.slice(0, BUCKET_NIBBLES);
    const bucket = this.membersByBucket.get(bucketPrefix);
    if (!bucket || !bucket.has(key)) return;
    bucket.delete(key);
    if (bucket.size === 0) this.membersByBucket.delete(bucketPrefix);
    this.count -= 1;
    this.recompute(bucketPrefix);
  }

  root(): string {
    return this.count === 0 ? ZERO : (this.nodeDigest.get("") ?? emptyNodeDigest(0));
  }

  size(): number {
    return this.count;
  }

  /**
   * Snapshot of every non-empty bucket's leafset digest, keyed by its
   * 5-nibble prefix (lowercase hex, no `sha256:` prefix). Exists so a
   * caller that has independently read a persisted `structural/merkle/
   * <set>.tree` file's bucket level (the file format's level-5 slots --
   * `docs/evidence/2026-09-02-v4-p0-s3-merkle-bucket.md`'s "Persistence
   * format" section) can feed those raw digests into
   * {@link rootFromBucketDigests} to independently recompute the node
   * levels (0..4) up to the root, without needing this class's own
   * in-memory member data. Used by v4 `lifecycle.verify` (P2-4): the
   * store's per-record digests are not (yet) readable from TypeScript, but
   * the tree file's own bucket-to-root structure is, so this is the
   * deepest structural self-check achievable without that native export.
   */
  bucketDigests(): ReadonlyMap<string, string> {
    return new Map(this.bucketDigest);
  }

  private recompute(bucketPrefix: string): void {
    const bucket = this.membersByBucket.get(bucketPrefix);
    if (bucket && bucket.size > 0) this.bucketDigest.set(bucketPrefix, computeBucketDigest(bucket));
    else this.bucketDigest.delete(bucketPrefix);
    for (let depth = 4; depth >= 0; depth -= 1) {
      const prefix = bucketPrefix.slice(0, depth);
      this.nodeDigest.set(prefix, this.computeNode(depth, prefix));
    }
  }

  private computeNode(depth: number, prefix: string): string {
    const children: Buffer[] = [];
    for (let digit = 0; digit < 16; digit += 1) {
      const childPrefix = prefix + digit.toString(16);
      const childDigestStr = depth === 4 ? this.bucketDigest.get(childPrefix) : this.nodeDigest.get(childPrefix);
      const fallback = depth === 4 ? ZERO_BYTES : digestBytes(emptyNodeDigest(depth + 1));
      children.push(childDigestStr !== undefined ? digestBytes(childDigestStr) : fallback);
    }
    return digest([DOMAIN_NODE, Buffer.from([depth]), ...children]);
  }
}

/** `sha256("urdira:record-set:v4\0" || u64le(count) || root32)`. */
export function recordSetDigest(root: string, count: number): string {
  return digest([DOMAIN_RECORD_SET, u64le(count), digestBytes(root)]);
}

/** `sha256("urdira:projection-set:v4\0" || kind_utf8 || 0x00 || u64le(count) || root32)`. */
export function projectionSetDigest(kind: string, root: string, count: number): string {
  return digest([DOMAIN_PROJECTION_SET, Buffer.from(kind, "utf8"), Buffer.from([0]), u64le(count), digestBytes(root)]);
}

/**
 * `Snapshot.source_state_digest` for a v4 workspace (plan §8.2; ported from
 * `crates/urdira-source-frontier/src/frontier.rs`'s `compute_source_state_digest`):
 * `sha256("urdira:source-state:v4\0" || u64le(present_count) || present_root32 || u64le(absent_count) || absent_root32)`,
 * where `present`/`absent` are two independent {@link BucketedMerkleSet}
 * roots -- `present` over every currently-visible artifact
 * (`key = sha256(normalized_uri)`, `logical = content_hash`), `absent` over
 * every currently-visible tombstone (`key = sha256(normalized_uri)`,
 * `logical = sha256(artifact_tombstone_id)`). Distinct from v3's
 * `source_state_digest` (an ordered-set digest over `MerkleRadixSet`,
 * `packages/engine/src/source-indexer.ts`); the two never apply to the same
 * workspace since v4 is a destructive, non-migrated format.
 */
export function sourceStateDigest(presentRoot: string, presentCount: number, absentRoot: string, absentCount: number): string {
  return digest([DOMAIN_SOURCE_STATE, u64le(presentCount), digestBytes(presentRoot), u64le(absentCount), digestBytes(absentRoot)]);
}

/**
 * Recomputes a {@link BucketedMerkleSet} root from a raw map of bucket-level
 * leafset digests (5-nibble hex prefix -> `sha256:`-prefixed digest, exactly
 * {@link BucketedMerkleSet.bucketDigests}'s shape), by rebuilding node levels
 * 4 down to 0 with the same unconditional-hash/`EMPTY_NODE`-fallback rule
 * `BucketedMerkleSet` itself uses (see that class's doc comment). Does not
 * need or touch member/leaf data, so it can verify a persisted `.tree`
 * file's own bucket-to-root structure (levels 0..4) from nothing but the
 * bucket digests already on disk -- a genuine from-scratch recompute of the
 * file's internal-node integrity, independent of whatever `root` its own
 * header happens to claim.
 *
 * `count` is not an input: it only determines the record-set/
 * projection-set digest (via {@link recordSetDigest}/{@link projectionSetDigest}),
 * never the tree root itself, so a caller comparing this function's output
 * against a persisted header's `root` field needs no count at all.
 *
 * An empty `buckets` map recomputes the same literal-zero empty root
 * {@link BucketedMerkleSet.root} returns for a zero-member set.
 */
export function rootFromBucketDigests(buckets: ReadonlyMap<string, string>): string {
  if (buckets.size === 0) return ZERO;
  for (const prefix of buckets.keys()) {
    if (!/^[0-9a-f]{5}$/i.test(prefix)) throw new TypeError(`Bucket prefix must be exactly ${BUCKET_NIBBLES} lowercase hex nibbles: ${prefix}`);
  }
  const nodeDigest = new Map<string, string>();
  for (let depth = 4; depth >= 0; depth -= 1) {
    const prefixes = new Set<string>();
    for (const bucketPrefix of buckets.keys()) prefixes.add(bucketPrefix.slice(0, depth));
    for (const prefix of prefixes) {
      const children: Buffer[] = [];
      for (let digit = 0; digit < 16; digit += 1) {
        const childPrefix = prefix + digit.toString(16);
        const childDigestStr = depth === 4 ? buckets.get(childPrefix) : nodeDigest.get(childPrefix);
        const fallback = depth === 4 ? ZERO_BYTES : digestBytes(emptyNodeDigest(depth + 1));
        children.push(childDigestStr !== undefined ? digestBytes(childDigestStr) : fallback);
      }
      nodeDigest.set(prefix, digest([DOMAIN_NODE, Buffer.from([depth]), ...children]));
    }
  }
  return nodeDigest.get("") ?? emptyNodeDigest(0);
}
