import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFactDeltaBatch, factDeltaBatchTransferList, FACT_DELTA_BATCH_MAX_BYTES, FACT_DELTA_BATCH_MAX_ROWS, readArenaString, validateFactDeltaBatch } from "../packages/engine/src/index.js";
import { acceptStagedColumnBatch, openSqliteDatabase } from "../packages/storage/src/index.js";

describe("FactDeltaBatch", () => {
  it("keeps strings in a UTF-8 arena and scalar fields in typed columns", () => {
    const batch = buildFactDeltaBatch({ records: [{ strings: ["alpha", "β"], numbers: [1.5], ordinals: [4], enums: [2], presence: [true, false] }] });
    expect(readArenaString(batch.records.strings, 0)).toBe("alpha");
    expect(readArenaString(batch.records.strings, 1)).toBe("β");
    expect(batch.records.numbers).toEqual(Float64Array.from([1.5]));
    expect(batch.records.ordinals).toEqual(Uint32Array.from([4]));
    expect(batch.records.enums).toEqual(Uint16Array.from([2]));
    expect(batch.records.presence).toEqual(Uint8Array.from([1, 0]));
    expect(factDeltaBatchTransferList(batch).length).toBe(12 * 4);
    expect(batch.records.strings.bytes.byteLength).toBe(new TextEncoder().encode("alphaβ").byteLength);
    expect(() => validateFactDeltaBatch(batch)).not.toThrow();
  });

  it("enforces row and byte backpressure limits before transfer", () => {
    expect(() => buildFactDeltaBatch({ records: Array.from({ length: FACT_DELTA_BATCH_MAX_ROWS + 1 }, () => ({})) })).toThrow(/rows/);
    expect(() => buildFactDeltaBatch({ records: [{ strings: ["x".repeat(FACT_DELTA_BATCH_MAX_BYTES)] }] })).toThrow(/bytes/);
  });

  it("transfers arenas directly to the SQLite worker and acknowledges retries atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-fact-delta-"));
    const database = await openSqliteDatabase({ filename: join(root, "workspace.sqlite") });
    try {
      const laneColumns = "fact_delta_key INTEGER NOT NULL, row_ordinal INTEGER NOT NULL, text_0 TEXT, text_1 TEXT, text_2 TEXT, text_3 TEXT, text_4 TEXT, text_5 TEXT, text_6 TEXT, text_7 TEXT, real_0 REAL, real_1 REAL, real_2 REAL, real_3 REAL, integer_0 INTEGER, integer_1 INTEGER, integer_2 INTEGER, integer_3 INTEGER, enum_0 INTEGER, enum_1 INTEGER, enum_2 INTEGER, enum_3 INTEGER, presence_0 INTEGER, presence_1 INTEGER, presence_2 INTEGER, presence_3 INTEGER, presence_4 INTEGER, presence_5 INTEGER, presence_6 INTEGER, presence_7 INTEGER, PRIMARY KEY (fact_delta_key, row_ordinal)";
      await database.exec(`CREATE TABLE candidate_state (candidate_generation_id TEXT PRIMARY KEY) STRICT; CREATE TABLE candidate_fact_deltas (fact_delta_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, candidate_generation_id TEXT NOT NULL, delta_digest TEXT NOT NULL, accepted_at TEXT NOT NULL) STRICT; CREATE TABLE candidate_fact_delta_namespaces (fact_delta_key INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, candidate_generation_id TEXT NOT NULL, fact_delta_id TEXT NOT NULL, producer_id TEXT, producer_version TEXT, owner_artifact_id TEXT, owner_artifact_version_id TEXT, analysis_digest TEXT, analysis_configuration_digest TEXT, UNIQUE (workspace_id, candidate_generation_id, fact_delta_id)) STRICT; CREATE TABLE candidate_staged_records (${laneColumns}) STRICT, WITHOUT ROWID; CREATE TABLE candidate_staged_graph_edges (${laneColumns}) STRICT, WITHOUT ROWID; CREATE TABLE candidate_staged_identities (${laneColumns}) STRICT, WITHOUT ROWID; CREATE TABLE candidate_staged_dependencies (${laneColumns}) STRICT, WITHOUT ROWID; CREATE TABLE candidate_fact_delta_batches (workspace_id TEXT NOT NULL, candidate_generation_id TEXT NOT NULL, fact_delta_id TEXT NOT NULL, sequence INTEGER NOT NULL, byte_length INTEGER NOT NULL, is_final INTEGER NOT NULL, accepted_at TEXT NOT NULL, PRIMARY KEY (workspace_id, candidate_generation_id, fact_delta_id, sequence)) STRICT, WITHOUT ROWID;`);
      await database.run("INSERT INTO candidate_state (candidate_generation_id) VALUES (?)", ["candidate-one"]);
      const batch = buildFactDeltaBatch({
        records: [{ strings: ["alpha", "relation", "kind", "universal", "identity", '{"record":1}'], numbers: [1.5], ordinals: [4], enums: [2], presence: [true] }],
        graph_edges: [{ strings: ["alpha", '{"record":1}'] }],
        identities: [{ strings: ["alpha", "identity", '{"record":1}'] }],
      });
      const [first] = await database.transactionChunked([{ kind: "staged_fact_delta_batch", workspace_id: "workspace-one", candidate_generation_id: "candidate-one", fact_delta_id: "delta-one", accepted_at: "2026-08-20T00:00:00.000Z", batch }], 1, { transfer_params: true });
      expect(first).toEqual({ status: "inserted" });
      expect(batch.records.strings.bytes.byteLength).toBe(0);
      expect(await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM candidate_staged_records")).toMatchObject({ count: 1 });
      expect(await database.get<{ canonical_record: string | null }>("SELECT text_5 AS canonical_record FROM candidate_staged_records LIMIT 1")).toEqual({ canonical_record: '{"record":1}' });
      expect(await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM candidate_staged_graph_edges")).toEqual({ count: 0 });
      expect(await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM candidate_staged_identities")).toEqual({ count: 0 });
      const retry = buildFactDeltaBatch({
        records: [{ strings: ["alpha", "relation", "kind", "universal", "identity", '{"record":1}'], numbers: [1.5], ordinals: [4], enums: [2], presence: [true] }],
        graph_edges: [{ strings: ["alpha", '{"record":1}'] }],
        identities: [{ strings: ["alpha", "identity", '{"record":1}'] }],
      });
      const [second] = await database.transactionChunked([{ kind: "staged_fact_delta_batch", workspace_id: "workspace-one", candidate_generation_id: "candidate-one", fact_delta_id: "delta-one", accepted_at: "2026-08-20T00:00:01.000Z", batch: retry }], 1, { transfer_params: true });
      expect(second).toEqual({ status: "already_accepted" });
      expect(await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM candidate_fact_delta_batches")).toMatchObject({ count: 1 });
      const secondBatch = buildFactDeltaBatch({ sequence: 1, final: true, records: [{ strings: ["omega"] }] });
      const [insertedSecond] = await database.transactionChunked([{ kind: "staged_fact_delta_batch", workspace_id: "workspace-one", candidate_generation_id: "candidate-one", fact_delta_id: "delta-many", accepted_at: "2026-08-20T00:00:03.000Z", batch: buildFactDeltaBatch({ sequence: 0, final: false, records: [{ strings: ["alpha"] }] }) }, { kind: "staged_fact_delta_batch", workspace_id: "workspace-one", candidate_generation_id: "candidate-one", fact_delta_id: "delta-many", accepted_at: "2026-08-20T00:00:04.000Z", batch: secondBatch }], 1, { transfer_params: true });
      expect(insertedSecond).toEqual({ status: "inserted" });
      expect(await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM candidate_staged_records")).toMatchObject({ count: 3 });
      const outOfOrder = buildFactDeltaBatch({ sequence: 2, records: [{ strings: ["late"] }] });
      await expect(database.transactionChunked([{ kind: "staged_fact_delta_batch", workspace_id: "workspace-one", candidate_generation_id: "candidate-one", fact_delta_id: "delta-two", accepted_at: "2026-08-20T00:00:02.000Z", batch: outOfOrder }], 1, { transfer_params: true })).rejects.toMatchObject({ code: "storage:fact_delta_sequence_invalid" });

      const staged = buildFactDeltaBatch({
        sequence: 2,
        final: true,
        records: [{ strings: ["record"], numbers: [1.25], ordinals: [2], enums: [3], presence: [true] }],
        graph_edges: [{ strings: ["edge"] }],
        identities: [{ strings: ["identity"] }],
        dependencies: [{ strings: ["dependency"] }],
      });
      await acceptStagedColumnBatch(database, {
        workspace_id: "workspace-one",
        candidate_generation_id: "candidate-one",
        batch: { ...staged, fact_delta_id: "delta-staged" },
      });
      expect(await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM candidate_staged_records WHERE fact_delta_key = (SELECT fact_delta_key FROM candidate_fact_delta_namespaces WHERE fact_delta_id = ?)", ["delta-staged"])).toMatchObject({ count: 1 });
      expect(await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM candidate_staged_dependencies WHERE fact_delta_key = (SELECT fact_delta_key FROM candidate_fact_delta_namespaces WHERE fact_delta_id = ?)", ["delta-staged"])).toMatchObject({ count: 1 });

      const discarded = buildFactDeltaBatch({ records: [{ strings: ["discarded-result-still-executes"] }] });
      await expect(database.transactionChunked([{
        kind: "staged_fact_delta_batch",
        workspace_id: "workspace-one",
        candidate_generation_id: "candidate-one",
        fact_delta_id: "delta-discarded-result",
        accepted_at: "2026-08-20T00:00:05.000Z",
        batch: discarded,
      }], 1, { transfer_params: true, discard_results: true })).resolves.toEqual([]);
      expect(await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM candidate_fact_delta_batches WHERE fact_delta_id = ?", ["delta-discarded-result"])).toEqual({ count: 1 });

      const groupA = buildFactDeltaBatch({ records: [{ strings: ["group-a"] }] });
      const groupB = buildFactDeltaBatch({ records: [{ strings: ["group-b"] }] });
      const [groupStatuses] = await database.transactionChunked([{
        kind: "staged_fact_delta_group",
        workspace_id: "workspace-one",
        candidate_generation_id: "candidate-one",
        accepted_at: "2026-08-20T00:00:06.000Z",
        entries: [
          { fact_delta_id: "delta-group-a", delta_digest: `sha256:${"a".repeat(64)}`, batches: [groupA] },
          { fact_delta_id: "delta-group-b", delta_digest: `sha256:${"b".repeat(64)}`, batches: [groupB] },
        ],
      }], 1, { transfer_params: true });
      expect(groupStatuses).toEqual(["inserted", "inserted"]);
      expect(await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM candidate_fact_deltas WHERE fact_delta_id LIKE 'delta-group-%'")).toEqual({ count: 2 });
      const retryA = buildFactDeltaBatch({ records: [{ strings: ["group-a"] }] });
      const retryB = buildFactDeltaBatch({ records: [{ strings: ["group-b"] }] });
      const [retryStatuses] = await database.transactionChunked([{
        kind: "staged_fact_delta_group",
        workspace_id: "workspace-one",
        candidate_generation_id: "candidate-one",
        accepted_at: "2026-08-20T00:00:07.000Z",
        entries: [
          { fact_delta_id: "delta-group-a", delta_digest: `sha256:${"a".repeat(64)}`, batches: [retryA] },
          { fact_delta_id: "delta-group-b", delta_digest: `sha256:${"b".repeat(64)}`, batches: [retryB] },
        ],
      }], 1, { transfer_params: true });
      expect(retryStatuses).toEqual(["already_accepted", "already_accepted"]);
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
