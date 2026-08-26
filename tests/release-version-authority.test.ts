import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BOOTSTRAP_VERSION, RUNTIME_VERSION } from "../apps/bootstrap/src/runtime-bootstrap.js";
import { URDIRA_ENGINE_BUILD_ID, URDIRA_VERSION } from "../apps/urdira/src/index.js";
import { MCP_SERVER_VERSION } from "../packages/mcp/src/index.js";

const releaseManifests = [
  "package.json",
  "apps/bootstrap/package.json",
  "apps/urdira/package.json",
  "packages/cli/package.json",
  "packages/daemon/package.json",
  "packages/mcp/package.json",
  "packages/web/package.json",
] as const;

describe("release version authority", () => {
  it("keeps every publishable local surface on the runtime release version", async () => {
    const versions = await Promise.all(releaseManifests.map(async (path) => {
      const manifest = JSON.parse(await readFile(path, "utf8")) as { readonly version?: unknown };
      return [path, manifest.version] as const;
    }));

    expect(Object.fromEntries(versions)).toEqual(Object.fromEntries(releaseManifests.map((path) => [path, URDIRA_VERSION])));
    expect(BOOTSTRAP_VERSION).toBe(URDIRA_VERSION);
    expect(RUNTIME_VERSION).toBe(URDIRA_VERSION);
    expect(MCP_SERVER_VERSION).toBe(URDIRA_VERSION);
    expect(URDIRA_ENGINE_BUILD_ID).toBe(`urdira-core-${URDIRA_VERSION}`);
  });
});
