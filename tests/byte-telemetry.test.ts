import { describe, expect, it } from "vitest";
import { ByteBoundaryTelemetry } from "../packages/storage/src/index.js";

describe("byte boundary telemetry", () => {
  it("aggregates declared reads/transfers/copies and rejects impossible copy counts", () => {
    const telemetry = new ByteBoundaryTelemetry();
    telemetry.add("provider", { read: 10, transferred: 10 });
    telemetry.add("cas", { read: 10, copied: 2 });
    telemetry.assertNoUndeclaredCopies();
    expect(telemetry.snapshot().cas?.copied).toBe(2);
    telemetry.add("ipc", { copied: 100 });
    expect(() => telemetry.assertNoUndeclaredCopies()).toThrow(/Undeclared/);
  });
});
