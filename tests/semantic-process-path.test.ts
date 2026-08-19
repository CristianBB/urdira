import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { semanticProcessEntryPath } from "../packages/daemon/src/semantic-process.js";

describe("semantic process entry paths", () => {
  it("converts the resolved module URL through the platform-aware file URL adapter", () => {
    const packageUrl = "file:///D:/a/urdira/packages/daemon/dist/index.js";
    const expected = fileURLToPath(new URL("semantic-maintenance-process.js", packageUrl));
    expect(semanticProcessEntryPath("semantic-maintenance-process.js", packageUrl)).toBe(expected);
  });
});
