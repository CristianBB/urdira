import { describe, expect, it } from "vitest";
import { digestLogicalValue, LogicalDigestWriter } from "../packages/canonical/src/index.js";

describe("LogicalDigestWriter", () => {
  it("hashes fields incrementally with explicit presence and type tags", () => {
    const write = (present: boolean) => {
      const writer = new LogicalDigestWriter("test");
      writer.field("name", present, () => writer.text(0, "alpha"));
      return writer.digest();
    };
    expect(write(true)).not.toBe(write(false));
    const writer = new LogicalDigestWriter("records");
    writer.field("name", true, () => writer.text(0, "alpha"));
    writer.field("count", true, () => writer.integer(2));
    writer.sequence(2).text(0, "a").text(0, "b");
    expect(writer.digest()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("does not accept writes after finalization", () => {
    const writer = new LogicalDigestWriter();
    writer.digest();
    expect(() => writer.null()).toThrow(/finalized/);
  });

  it("digests nested logical values without materializing a payload", () => {
    const left = digestLogicalValue({ z: [1, "two"], a: true });
    const right = digestLogicalValue({ a: true, z: [1, "two"] });
    expect(left).toBe(right);
    expect(digestLogicalValue({ a: false })).not.toBe(left);
  });
});
