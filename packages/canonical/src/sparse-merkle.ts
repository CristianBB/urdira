import { createHash } from "node:crypto";

const ZERO = `sha256:${"0".repeat(64)}`;
const encoder = new TextEncoder();
function hash(parts: readonly Uint8Array[]): string { const digest = createHash("sha256"); for (const part of parts) digest.update(part); return `sha256:${digest.digest("hex")}`; }
function bytes(value: string): Uint8Array { return encoder.encode(value); }
function bits(key: string): string { return [...key.slice(7)].map((character) => Number.parseInt(character, 16).toString(2).padStart(4, "0")).join(""); }

/** Sparse SHA-256 Merkle set with O(256) updates and deterministic roots. */
export class SparseMerkleSet {
  private readonly leaves = new Map<string, string>();
  private readonly nodes = new Map<string, string>();
  private readonly prefixCounts = new Map<string, number>();
  set(memberDigest: string, logicalDigest: string): void {
    if (!this.leaves.has(memberDigest)) {
      const path = bits(memberDigest);
      for (let depth = 0; depth <= 256; depth += 1) this.prefixCounts.set(path.slice(0, depth), (this.prefixCounts.get(path.slice(0, depth)) ?? 0) + 1);
    }
    this.leaves.set(memberDigest, hash([bytes("urdira:merkle:leaf\0"), bytes(memberDigest), bytes(logicalDigest)]));
    this.recompute(memberDigest);
  }
  delete(memberDigest: string): void {
    if (!this.leaves.has(memberDigest)) return;
    const path = bits(memberDigest);
    for (let depth = 0; depth <= 256; depth += 1) {
      const prefix = path.slice(0, depth);
      const count = (this.prefixCounts.get(prefix) ?? 1) - 1;
      if (count === 0) this.prefixCounts.delete(prefix); else this.prefixCounts.set(prefix, count);
    }
    this.leaves.delete(memberDigest);
    // A deletion is the same branch update as an insertion with the empty
    // leaf. Sibling hashes remain cached, so the update touches 256 nodes and
    // never scans the complete set.
    this.recompute(memberDigest);
  }
  root(): string { return this.leaves.size === 0 ? ZERO : this.nodes.get("") ?? ZERO; }
  nodesSnapshot(): readonly { readonly prefix: string; readonly digest: string }[] { return [...this.nodes.entries()].map(([prefix, digest]) => ({ prefix, digest })).sort((left, right) => left.prefix.localeCompare(right.prefix)); }
  leavesSnapshot(): readonly { readonly member_digest: string; readonly leaf_digest: string }[] { return [...this.leaves.entries()].map(([member_digest, leaf_digest]) => ({ member_digest, leaf_digest })).sort((left, right) => left.member_digest.localeCompare(right.member_digest)); }
  verify(entries: readonly { readonly member_digest: string; readonly logical_digest: string }[]): boolean { const expected = new SparseMerkleSet(); for (const entry of entries) expected.set(entry.member_digest, entry.logical_digest); return expected.root() === this.root(); }
  private recompute(memberDigest: string): void {
    const path = bits(memberDigest);
    let prefix = path;
    if (this.leaves.has(memberDigest)) this.nodes.set(prefix, this.leaves.get(memberDigest)!); else this.nodes.delete(prefix);
    for (let depth = 256; depth > 0; depth -= 1) {
      const parent = prefix.slice(0, -1);
      const child = Number(path[depth - 1]);
      const leftPrefix = `${parent}0`;
      const rightPrefix = `${parent}1`;
      const left = (this.prefixCounts.get(leftPrefix) ?? 0) === 0 ? ZERO : child === 0 ? this.nodes.get(prefix) ?? ZERO : this.nodes.get(leftPrefix) ?? ZERO;
      const right = (this.prefixCounts.get(rightPrefix) ?? 0) === 0 ? ZERO : child === 1 ? this.nodes.get(prefix) ?? ZERO : this.nodes.get(rightPrefix) ?? ZERO;
      if ((this.prefixCounts.get(parent) ?? 0) === 0) this.nodes.delete(parent);
      else this.nodes.set(parent, hash([bytes("urdira:merkle:node\0"), bytes(String(depth - 1)), bytes(left), bytes(right)]));
      prefix = parent;
    }
  }
}
