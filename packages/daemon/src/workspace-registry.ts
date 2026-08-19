import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceRegistry, type WorkspaceRegistryState } from "@urdira/engine";

/**
 * Creates the daemon-owned registry. The registry is deliberately kept outside
 * project roots so Urdira never writes `.urdira/config.json` or other files to
 * a user's source tree.
 */
export function createPersistentWorkspaceRegistry(dataRoot: string): WorkspaceRegistry {
  const registryPath = join(dataRoot, "workspaces.json");
  return new WorkspaceRegistry({
    persistence: {
      load: () => {
        try {
          const parsed: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
          return parsed as WorkspaceRegistryState;
        } catch {
          return undefined;
        }
      },
      save: (state) => {
        mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
        writeFileSync(registryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
      },
    },
  });
}

export { WorkspaceRegistry } from "@urdira/engine";
export type { WorkspaceRegistryState } from "@urdira/engine";
