import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultDaemonOptions } from "../apps/urdira/src/index.js";
import { DaemonClient, DaemonRuntime } from "../packages/daemon/src/index.js";
import { JAVASCRIPT_TYPESCRIPT_PLUGIN_ID } from "../packages/plugin-javascript-typescript/src/index.js";
import { createDurableStorage } from "../packages/storage/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, "fixtures", "codebases", "typescript", "task-planner");

/**
 * `defaultDaemonOptions` (`apps/urdira/src/index.ts`) now resolves a REAL
 * embedding provider by default -- the bundled open-model local neural
 * provider, which downloads a model on first use -- per
 * `docs/decisions/16-semantic-search-wiring.md`'s open-model-default
 * addendum. This test exercises identity-assignment churn, not embeddings,
 * so it forces the explicit `URDIRA_EMBEDDINGS_PROVIDER=hash` escape hatch
 * for the duration of the wrapped call, restoring whatever was there before
 * -- keeping this suite hermetic (no network, no model download).
 */
async function withHashEmbeddingsProvider<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env["URDIRA_EMBEDDINGS_PROVIDER"];
  process.env["URDIRA_EMBEDDINGS_PROVIDER"] = "hash";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env["URDIRA_EMBEDDINGS_PROVIDER"];
    else process.env["URDIRA_EMBEDDINGS_PROVIDER"] = previous;
  }
}

async function pollUntilReady(client: DaemonClient, workspaceId: string, timeoutMs = 60_000): Promise<{ readonly workspace_status: string; readonly current_snapshot_id?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await client.call("core:index_status", {});
    if (response.outcome !== "success") throw new Error(JSON.stringify(response));
    const payload = response.payload as { readonly workspaces: ReadonlyArray<{ readonly workspace_id: string; readonly workspace_status: string }> };
    const workspace = payload.workspaces.find((entry) => entry.workspace_id === workspaceId);
    if (workspace === undefined) throw new Error(`core:index_status did not report workspace ${workspaceId}.`);
    if (workspace.workspace_status === "ready" || workspace.workspace_status === "degraded") {
      const detail = await client.call("core:index_status", { workspace_ids: [workspaceId] });
      const detailPayload = detail.payload as { readonly workspaces: ReadonlyArray<{ readonly workspace_status: string; readonly current_snapshot_id?: string }> };
      return detailPayload.workspaces[0]!;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Workspace ${workspaceId} did not leave "indexing" within ${timeoutMs}ms.`);
}

// Regression coverage for a real e2e performance finding (excalidraw donor +
// fork, real one-file incremental edits): publish time on a real
// incremental scan grew with the *affected-owner closure* size (665, then
// 383 owners for two successive one-file edits, publish 144s then 236s),
// not with how much content actually changed. Root cause, confirmed by
// reading `recordTemplates` (`packages/engine/src/candidate-materialization.ts`):
// every REUSED record (unchanged content, same `record_id`) in a matched
// replacement scope still pushed a fresh "continued" `CandidateIdentityAssignmentTemplate`
// -- and because `identity_assignments` includes `valid_from_generation` in
// its own primary key (unlike `record_occurrences`, which never re-opens a
// reused row), every incremental scan durably inserted a BRAND NEW physical
// row, at the current generation, for every reused record that happened to
// have an identity -- for every owner in the affected closure, not just the
// owner whose content actually changed. `assertPublicationImmutableRows`
// (`packages/storage/src/publication-authority.ts`) then byte-compared each
// one. Fixed by no longer pushing an identity template for the reused
// branch at all: the already-durable identity assignment row from whichever
// generation first opened it remains correctly visible forever (`CanonicalOccurrenceRepository.currentlyVisible`'s
// own join already finds the MOST RECENT visible row by `record_id`, not
// one from every generation -- confirmed by reading `repositories.ts`).
//
// This test can't reach excalidraw's own scale, but asserts the qualitative
// invariant directly: editing a single, widely-imported file (`task.ts`,
// imported by five other files in this fixture) that widens the affected
// scan scope without changing any of ITS OWN previously-published
// declarations must not durably write (or byte-compare) an `identity_assignments`
// row for every reused record across every affected owner -- only for
// whatever genuinely opened or replaced this generation.
describe("Incremental publish: identity-assignment churn", () => {
  it("an incremental publish's identity_assignments row count tracks changed records, not affected-scope size", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "urdira-identity-churn-data-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "urdira-identity-churn-ws-"));
    let runtime: DaemonRuntime | undefined;
    try {
      await cp(fixtureRoot, workspaceRoot, { recursive: true });
      runtime = await DaemonRuntime.start(await withHashEmbeddingsProvider(() => defaultDaemonOptions(dataRoot)));
      const client = new DaemonClient(runtime.endpoint);

      const added = await client.call("core:workspace_add", { args: [workspaceRoot], confirmed: true, selected_technology_ids: ["typescript"], selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID] });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      const first = await pollUntilReady(client, workspaceId);
      expect(first.workspace_status).toBe("ready");

      // `task.ts` is imported (directly or transitively) by task-repository.ts,
      // in-memory-task-repository.ts, task-service.ts, main.ts, and index.ts --
      // appending a new, unrelated, standalone type widens the affected-owner
      // closure to all of them (each is re-analyzed since its own closure
      // intersects the changed file), but leaves `TaskStatus`/`Task`/`CreateTaskInput`
      // -- and therefore every existing declaration in every one of those
      // other files -- byte-identical, so every one of their records is
      // reused, not replaced.
      const taskPath = join(workspaceRoot, "src", "domain", "task.ts");
      const original = await readFile(taskPath, "utf8");
      await writeFile(taskPath, `${original}\nexport interface TaskArchiveMarker { readonly archived: boolean; }\n`, "utf8");
      const reindexed = await client.call("core:reindex", { args: [workspaceId] });
      expect(reindexed.outcome).toBe("success");
      const second = await pollUntilReady(client, workspaceId);
      expect(second.workspace_status).toBe("ready");
      expect(second.current_snapshot_id).not.toBe(first.current_snapshot_id);

      await runtime.stop();
      runtime = undefined;

      const storage = await createDurableStorage({ rootDir: dataRoot });
      try {
        const database = await storage.openWorkspace(workspaceId);
        try {
          const currentGeneration = (await database.database.get<{ current_generation: number }>("SELECT current_generation FROM workspace_current_state WHERE workspace_id = ?", [workspaceId]))?.current_generation;
          expect(currentGeneration).toBeDefined();
          expect(currentGeneration).toBeGreaterThan(1);

          const openedRecordsThisGeneration = (await database.database.get<{ c: number }>("SELECT COUNT(*) AS c FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation = ?", [workspaceId, currentGeneration!]))!.c;
          const identityAssignmentsThisGeneration = (await database.database.get<{ c: number }>("SELECT COUNT(*) AS c FROM identity_assignments WHERE workspace_id = ? AND valid_from_generation = ?", [workspaceId, currentGeneration!]))!.c;
          const totalVisibleRecords = (await database.database.get<{ c: number }>("SELECT COUNT(*) AS c FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)", [workspaceId, currentGeneration!, currentGeneration!]))!.c;

          // The real, structural fix: an identity_assignments row can only be
          // durably written this generation for a record that ALSO opened
          // (freshly or as a replacement) this generation -- never for a
          // merely-reused one. Before the fix, this could exceed the opened
          // record count by however many reused, identity-bearing records
          // sat in the affected scope.
          expect(identityAssignmentsThisGeneration).toBeLessThanOrEqual(openedRecordsThisGeneration);
          // And the load-bearing, scope-proportionality assertion the task
          // asked for directly: strictly fewer identity assignments were
          // written this generation than there are records visible in total
          // (i.e. NOT one per reused record across the whole affected
          // closure) -- before the fix, a wide affected closure with even a
          // handful of identity-bearing reused records would push this at or
          // above the total visible count.
          expect(identityAssignmentsThisGeneration).toBeLessThan(totalVisibleRecords);
        } finally {
          await database.close();
        }
      } finally {
        await storage.close();
      }
    } finally {
      if (runtime) await runtime.stop();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
