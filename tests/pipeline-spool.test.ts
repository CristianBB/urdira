import { describe, expect, it } from "vitest";
import { MemoryStageSpool, SqliteStageSpool } from "../packages/engine/src/index.js";
import { stageSetHandle, stageSetRoot } from "../packages/engine/src/stage-set-handle.js";

const values = [
  { value: { record_id: "r1" }, stable_sort_key: "001" },
  { value: { record_id: "r2" }, stable_sort_key: "002" },
] as const;

describe("v3 pipeline spools", () => {
  it("seals a bounded memory handle and cleans an execution", async () => {
    const spool = new MemoryStageSpool({ hard_bytes: 4096 });
    const handle = await spool.put("e1", "find", "subjects", values);
    expect(handle.row_count).toBe(2);
    expect([...await (async () => { const rows = []; for await (const row of handle.iterate!()) rows.push(row); return rows; })()]).toHaveLength(2);
    expect(spool.bytes).toBeGreaterThan(0);
    await spool.cleanup("e1");
    expect(spool.bytes).toBe(0);
  });

  it("round-trips canonical rows through the SQLite spool", async () => {
    const spool = await SqliteStageSpool.memory({ hard_bytes: 4096 });
    const handle = await spool.put("e2", "find", "subjects", values);
    expect(spool.bytes).toBeGreaterThan(0);
    const rows = [];
    for await (const row of handle.iterate!()) rows.push(row);
    expect(rows).toEqual(values);
    await spool.cleanup("e2");
    await spool.close();
  });

  it("seals an async source incrementally and keeps the same logical root", async () => {
    const spool = await SqliteStageSpool.memory({ hard_bytes: 4096 });
    const handle = await spool.putIterable("e-stream", "filter", "subjects", (async function* () {
      yield values[0]!;
      yield values[1]!;
    })());
    expect(handle.row_count).toBe(2);
    expect(handle.root).toBe(stageSetRoot(values).root);
    const rows = [];
    for await (const row of handle.iterate!()) rows.push(row);
    expect(rows).toEqual(values);
    await spool.close();
  });

  it("rejects a hard intermediate budget before retaining rows", async () => {
    const spool = new MemoryStageSpool({ hard_bytes: 1 });
    await expect(spool.put("e3", "find", "subjects", values)).rejects.toThrow(/hard limit/i);
  });

  it("cleans an unknown execution and closes an empty memory spool", async () => {
    const spool = new MemoryStageSpool();
    await spool.cleanup("missing");
    await spool.close();
    expect(spool.bytes).toBe(0);
  });

  it("exposes a metadata-first handle for an unclassified output", async () => {
    const handle = stageSetHandle("e4", "stage", "custom", values);
    expect(handle.logical_type).toBe("unknown");
    const rows = [];
    for await (const row of handle.iterate!()) rows.push(row);
    expect(rows).toEqual(values);
  });

  it("rejects inconsistent limits before opening a spool", () => {
    expect(() => new MemoryStageSpool({ spill_bytes: 2, hard_bytes: 1 })).toThrow(/invalid pipeline spool limits/i);
  });
});
