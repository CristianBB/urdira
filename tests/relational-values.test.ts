import { describe, expect, it } from "vitest";
import { flattenRelationalValue, hydrateRelationalValue, iterateRelationalValue, RelationalValueBatchWriter, RELATIONAL_VALUE_BATCH_MAX_BYTES, RELATIONAL_VALUE_BATCH_MAX_PARAMETERS, RELATIONAL_VALUE_BATCH_MAX_ROWS } from "../packages/storage/src/index.js";

describe("v2 relational logical values", () => {
  it("round-trips nested objects, sequences and bytes without a serialized payload", () => {
    const input = {
      name: "worker",
      flags: [true, false],
      nested: { "a/b": 7, percent: "%" },
      bytes: new Uint8Array([1, 2, 3]),
    };
    const rows = flattenRelationalValue("workspace", "record", 4, input);
    expect(rows.some((row) => row.value_kind === "bytes" && row.bytes_value instanceof Uint8Array)).toBe(true);
    expect(rows.every((row) => row.value_path !== "[object Object]")).toBe(true);
    expect(hydrateRelationalValue(rows)).toEqual(input);
  });

  it("keeps set-like object keys deterministic", () => {
    const left = flattenRelationalValue("w", "r", 1, { z: 1, a: 2 }).map((row) => row.value_path);
    const right = flattenRelationalValue("w", "r", 1, { a: 2, z: 1 }).map((row) => row.value_path);
    expect(left).toEqual(right);
  });

  it("emits bounded multi-row value batches without retaining all row commands", () => {
    const value = { values: Array.from({ length: 11 }, (_, index) => ({ index, text: `value-${index}` })) };
    const rows = flattenRelationalValue("workspace", "record", 4, value);
    const writer = new RelationalValueBatchWriter("record_value_nodes", 2, 26, 1_024);
    const commands = [...writer.push(iterateRelationalValue("workspace", "record", 4, value)), ...writer.finish()];
    const runCommands = commands.filter((command): command is Extract<typeof command, { readonly kind: "run" }> => command.kind === "run");
    expect(commands.length).toBeGreaterThan(1);
    expect(runCommands.length).toBe(commands.length);
    expect(runCommands.every((command) => (command.params?.length ?? 0) <= 26)).toBe(true);
    expect(runCommands.reduce((total, command) => total + (command.params?.length ?? 0), 0)).toBe(rows.length * 13);
    expect(runCommands.every((command) => command.sql.includes("VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"))).toBe(true);
  });

  it("keeps the production batch limits explicit and rejects an oversized single row", () => {
    expect(RELATIONAL_VALUE_BATCH_MAX_ROWS).toBe(1_024);
    expect(RELATIONAL_VALUE_BATCH_MAX_PARAMETERS).toBe(13_312);
    expect(RELATIONAL_VALUE_BATCH_MAX_BYTES).toBe(4 * 1024 * 1024);
    const rows = flattenRelationalValue("workspace", "record", 4, { text: "x".repeat(2_048) });
    expect(() => new RelationalValueBatchWriter("record_value_nodes", 1, 13, 1_024).push(rows)).toThrow(/batch limit/u);
  });
});
