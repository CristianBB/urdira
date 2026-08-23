import { MerkleRadixSet } from "@urdira/canonical";
import type { SqliteDatabase } from "./sqlite.js";

const LEAF_PREFIX = "leaf:";

/** SQLite-backed sparse Merkle roots with a bounded branch update path. */
export class PersistentSparseMerkleSet {
  readonly #tree = new MerkleRadixSet();
  #loaded = false;
  #nodeDigests = new Map<string, string>();
  #logicalDigests = new Map<string, string>();

  constructor(private readonly database: SqliteDatabase, private readonly workspaceId: string, private readonly setKind: string, private readonly generation: number) {}

  async load(): Promise<void> {
    if (this.#loaded) return;
    const rows = await this.database.all<{ node_prefix: string; node_digest: string; member_digest: string | null; logical_digest: string | null }>("SELECT node_prefix, node_digest, member_digest, logical_digest FROM set_merkle_nodes WHERE workspace_id = ? AND set_kind = ? AND generation = ?", [this.workspaceId, this.setKind, this.generation]);
    for (const row of rows) {
      this.#nodeDigests.set(row.node_prefix, row.node_digest);
      if (row.node_prefix.startsWith(LEAF_PREFIX) && row.member_digest !== null && row.logical_digest !== null) { this.#logicalDigests.set(row.member_digest, row.logical_digest); this.#tree.set(row.member_digest, row.logical_digest); }
    }
    this.#loaded = true;
  }

  async set(memberDigest: string, logicalDigest: string): Promise<string> { await this.load(); this.#tree.set(memberDigest, logicalDigest); this.#logicalDigests.set(memberDigest, logicalDigest); return this.persist(); }
  async delete(memberDigest: string): Promise<string> { await this.load(); this.#tree.delete(memberDigest); this.#logicalDigests.delete(memberDigest); return this.persist(); }
  async root(): Promise<string> { await this.load(); return this.#tree.root(); }
  async verify(): Promise<boolean> {
    await this.load();
    const leaves = await this.database.all<{ member_digest: string; logical_digest: string }>("SELECT member_digest, logical_digest FROM set_merkle_nodes WHERE workspace_id = ? AND set_kind = ? AND generation = ? AND node_prefix LIKE ? AND member_digest IS NOT NULL AND logical_digest IS NOT NULL ORDER BY member_digest", [this.workspaceId, this.setKind, this.generation, `${LEAF_PREFIX}%`]);
    return this.#tree.verify(leaves);
  }

  private async persist(): Promise<string> {
    const leafRows = this.#tree.leavesSnapshot();
    const next = leafRows.length === 0 ? new Map<string, string>() : new Map(this.#tree.nodesSnapshot().map((node) => [node.prefix, node.digest]));
    for (const leaf of leafRows) next.set(`${LEAF_PREFIX}${leaf.member_digest}`, leaf.leaf_digest);
    // Internal branches disappear too when the last leaf below them is
    // removed.  Leaving those rows behind would not affect the in-memory
    // root, but a later process would load stale branches from SQLite.
    for (const prefix of this.#nodeDigests.keys()) if (!next.has(prefix)) await this.database.run("DELETE FROM set_merkle_nodes WHERE workspace_id = ? AND set_kind = ? AND generation = ? AND node_prefix = ?", [this.workspaceId, this.setKind, this.generation, prefix]);
    const leaves = new Map(next);
    for (const [prefix, digest] of next) {
      const memberDigest = prefix.startsWith(LEAF_PREFIX) ? prefix.slice(LEAF_PREFIX.length) : null;
      const logicalDigest = memberDigest === null ? null : this.#logicalDigests.get(memberDigest) ?? null;
      if (this.#nodeDigests.get(prefix) === digest) continue;
      await this.database.run("INSERT INTO set_merkle_nodes (workspace_id, set_kind, generation, node_prefix, node_digest, member_digest, logical_digest) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, set_kind, generation, node_prefix) DO UPDATE SET node_digest = excluded.node_digest, member_digest = excluded.member_digest, logical_digest = excluded.logical_digest", [this.workspaceId, this.setKind, this.generation, prefix, digest, memberDigest, logicalDigest]);
    }
    this.#nodeDigests = leaves;
    return this.#tree.root();
  }

}
