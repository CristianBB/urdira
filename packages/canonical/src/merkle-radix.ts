import { createHash } from "node:crypto";

const ZERO_BYTES = Buffer.alloc(32);
const ZERO = `sha256:${ZERO_BYTES.toString("hex")}`;
const DOMAIN_LEAF = Buffer.from("urdira:merkle-radix:leaf\0", "utf8");
const DOMAIN_NODE = Buffer.from("urdira:merkle-radix:node\0", "utf8");

function digest(parts: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return `sha256:${hash.digest("hex")}`;
}

function digestBytes(value: string): Buffer {
  const hex = value.startsWith("sha256:") ? value.slice(7) : value;
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new TypeError("Merkle radix keys and values must be sha256 digests.");
  return Buffer.from(hex, "hex");
}

function keyHex(value: string): string {
  return digestBytes(value).toString("hex");
}

/**
 * Deterministic fanout-16 Merkle set.
 *
 * A member update touches one leaf and at most 64 radix nodes.  Unlike the
 * old 256-level binary trie it does not build a string bit path or scan and
 * sort the complete member set.  The fixed child order makes the root
 * independent of insertion order; bulk producers can feed members as they
 * arrive and retain only the affected branches.
 */
export class MerkleRadixSet {
  readonly metrics = { leaves_modified: 0, nodes_recalculated: 0, collections_ordered: 0 };
  private readonly leaves = new Map<string, string>();
  private readonly nodes = new Map<string, string>();
  private readonly prefixCounts = new Map<string, number>();

  /** Build a set in one bottom-up pass instead of recomputing 64 branches for
   * every insertion. Duplicate member keys are accepted only when their
   * logical value is identical, making the result independent of arrival
   * order. */
  static from(entries: Iterable<{ readonly member_digest: string; readonly logical_digest: string }>): MerkleRadixSet {
    const tree = new MerkleRadixSet();
    const logicalByKey = new Map<string, string>();
    for (const entry of entries) {
      const member = keyHex(entry.member_digest);
      digestBytes(entry.logical_digest);
      const previous = logicalByKey.get(member);
      if (previous !== undefined && previous !== entry.logical_digest) throw new TypeError("Merkle radix duplicate member has conflicting logical digests.");
      logicalByKey.set(member, entry.logical_digest);
    }
    for (const [key, logical] of logicalByKey) {
      tree.leaves.set(key, digest([DOMAIN_LEAF, Buffer.from(key, "hex"), digestBytes(logical)]));
      for (let depth = 0; depth <= 64; depth += 1) {
        const prefix = key.slice(0, depth);
        tree.prefixCounts.set(prefix, (tree.prefixCounts.get(prefix) ?? 0) + 1);
      }
    }
    for (const [key, leaf] of tree.leaves) tree.nodes.set(key, leaf);
    const prefixes = new Set<string>();
    for (const key of tree.leaves.keys()) for (let depth = 0; depth < 64; depth += 1) prefixes.add(key.slice(0, depth));
    tree.metrics.collections_ordered += 1;
    for (const prefix of [...prefixes].sort((left, right) => right.length - left.length || left.localeCompare(right))) {
      // `set`'s incremental recompute labels the parent by the number of
      // levels remaining including that parent (64 at a 63-nibble parent,
      // 1 at the root), i.e. prefix length + 1.
      const depth = prefix.length + 1;
      const children: Buffer[] = [];
      for (let digit = 0; digit < 16; digit += 1) children.push(tree.nodes.has(`${prefix}${digit.toString(16)}`) ? digestBytes(tree.nodes.get(`${prefix}${digit.toString(16)}`)!) : ZERO_BYTES);
      children.unshift(Buffer.from([depth]));
      children.unshift(DOMAIN_NODE);
      tree.nodes.set(prefix, digest(children));
      tree.metrics.nodes_recalculated += 1;
    }
    tree.metrics.leaves_modified = tree.leaves.size;
    return tree;
  }

  set(memberDigest: string, logicalDigest: string): void {
    this.metrics.leaves_modified += 1;
    const key = keyHex(memberDigest);
    digestBytes(logicalDigest);
    if (!this.leaves.has(key)) {
      for (let depth = 0; depth <= 64; depth += 1) {
        const prefix = key.slice(0, depth);
        this.prefixCounts.set(prefix, (this.prefixCounts.get(prefix) ?? 0) + 1);
      }
    }
    this.leaves.set(key, digest([DOMAIN_LEAF, digestBytes(memberDigest), digestBytes(logicalDigest)]));
    this.recompute(key);
  }

  delete(memberDigest: string): void {
    const key = keyHex(memberDigest);
    if (!this.leaves.has(key)) return;
    for (let depth = 0; depth <= 64; depth += 1) {
      const prefix = key.slice(0, depth);
      const count = (this.prefixCounts.get(prefix) ?? 1) - 1;
      if (count === 0) this.prefixCounts.delete(prefix); else this.prefixCounts.set(prefix, count);
    }
    this.leaves.delete(key);
    this.metrics.leaves_modified += 1;
    this.recompute(key);
  }

  root(): string { return this.leaves.size === 0 ? ZERO : this.nodes.get("") ?? ZERO; }
  size(): number { return this.leaves.size; }

  /** Diagnostic snapshot only; never used by the digest hot path. */
  nodesSnapshot(): readonly { readonly prefix: string; readonly digest: string }[] {
    return [...this.nodes.entries()].map(([prefix, value]) => ({ prefix, digest: value })).sort((left, right) => left.prefix.localeCompare(right.prefix));
  }

  /** Leaf snapshot for durable adapters; callers may persist it without rebuilding the set. */
  leavesSnapshot(): readonly { readonly member_digest: string; readonly leaf_digest: string }[] {
    return [...this.leaves.entries()].map(([member_digest, leaf_digest]) => ({ member_digest: `sha256:${member_digest}`, leaf_digest }));
  }

  verify(entries: readonly { readonly member_digest: string; readonly logical_digest: string }[]): boolean {
    const expected = new MerkleRadixSet();
    for (const entry of entries) expected.set(entry.member_digest, entry.logical_digest);
    return expected.root() === this.root();
  }

  private recompute(key: string): void {
    if (this.leaves.has(key)) this.nodes.set(key, this.leaves.get(key)!); else this.nodes.delete(key);
    let childPrefix = key;
    for (let depth = 64; depth > 0; depth -= 1) {
      const parent = childPrefix.slice(0, -1);
      if ((this.prefixCounts.get(parent) ?? 0) === 0) {
        this.nodes.delete(parent);
      } else {
        const children: Buffer[] = [];
        for (let digit = 0; digit < 16; digit += 1) {
          const child = this.nodes.get(`${parent}${digit.toString(16)}`);
          children.push(child === undefined ? ZERO_BYTES : digestBytes(child));
        }
        children.unshift(Buffer.from([depth]));
        children.unshift(DOMAIN_NODE);
        this.nodes.set(parent, digest(children));
        this.metrics.nodes_recalculated += 1;
      }
      childPrefix = parent;
    }
  }
}
