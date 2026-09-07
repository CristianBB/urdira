import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultDaemonOptions, runUrdira } from "../apps/urdira/src/index.js";
import { hostNativeTarget, nativeArtifactNames } from "../scripts/native-release.mjs";
import { prepareNativeRoot } from "../scripts/indexing-structural-preflight.mjs";

/**
 * F-fix (v3 `record_occurrences.record_id` collision, plan
 * `generic-waddling-hartmanis.md` §3, 2026-09-07): regression coverage for
 * the ACTUAL root cause this frente found -- NOT the overload/parameter-
 * identity hypothesis its brief started from (see `crates/urdira-jsts-
 * syntax-worker/src/semantic_sites.rs`'s `overload_and_accessor_parameters_
 * of_the_same_name_never_collide` and `n8n_corpus_identity_key_collisions_
 * are_only_external_modules` unit tests for that disproof), but the real
 * one: `jsts:external_module:*`/`jsts:external_symbol:*` entities are
 * proposed identically (same identity_key/body/record_id) by EVERY file
 * that imports the same external specifier -- `external_module_entity`'s
 * own doc comment, `crates/urdira-jsts-syntax-worker/src/lib.rs`. The v3
 * SQL "direct publication" cold-scan fast path
 * (`crates/urdira-indexing-worker/src/main.rs`'s `record_insert_sql`/
 * `direct_sql`/`identity_insert_sql`/`direct_identity_sql` `!records_exist`/
 * `!identities_exist` branches) used to INSERT every staged row verbatim
 * with no `ON CONFLICT` clause, so the SECOND file importing the same
 * external package crashed the whole cold generation with `UNIQUE
 * constraint failed: record_occurrences.record_id` -- reproduced here with
 * only TWO files (`a.ts`/`b.ts`, both `import _ from "lodash"`), the
 * smallest possible repro (the real n8n corpus hits the identical crash at
 * row 3,525,385 of ~3.5M, needing an 8+ minute cold scan; this fixture
 * reproduces the SAME crash in under 10 seconds).
 *
 * Runs the REAL production CLI (`runUrdira`) against a REAL foreground
 * daemon wired to the REAL `urdira-indexing-worker`/`urdira-native.node`
 * artifacts built by `node scripts/build-native.mjs` -- no fake transport,
 * no mocked SQL. Skipped (not failed) when those release artifacts are not
 * built, matching `tests/v4-daemon-e2e.test.ts`'s own precedent.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const hostTarget = hostNativeTarget();
const artifactRoot = hostTarget === undefined ? undefined : resolve(repoRoot, "release/native", hostTarget);
const workerPath = hostTarget === undefined ? undefined : resolve(artifactRoot!, nativeArtifactNames(hostTarget).indexing_core_worker);
const addonPath = hostTarget === undefined ? undefined : resolve(artifactRoot!, nativeArtifactNames(hostTarget).addon);
const hasReleaseArtifacts = artifactRoot !== undefined && workerPath !== undefined && existsSync(workerPath) && addonPath !== undefined && existsSync(addonPath);
const describeIfBuilt = hasReleaseArtifacts ? describe : describe.skip;

const LODASH_FIXTURE: Readonly<Record<string, string>> = {
  "a.ts": "import _ from \"lodash\";\nexport function useA(): number {\n  return _.random(0, 10);\n}\n",
  "b.ts": "import _ from \"lodash\";\nexport function useB(): number {\n  return _.random(0, 20);\n}\n",
};

async function writeFixture(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [name, contents] of Object.entries(files)) await writeFile(join(root, name), contents, "utf8");
}

async function pollWorkspaceReady(
  runOptions: Parameters<typeof runUrdira>[1],
  workspaceId: string,
  timeoutMs: number,
): Promise<Readonly<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await runUrdira(["workspace", "show", workspaceId, "--json"], runOptions);
    const workspace = (status.data as { readonly workspace?: Record<string, unknown>; readonly result?: { readonly workspace?: Record<string, unknown> } } | undefined)?.workspace
      ?? (status.data as { readonly result?: { readonly workspace?: Record<string, unknown> } } | undefined)?.result?.workspace;
    const state = (workspace?.["status"] as string | undefined) ?? "unknown";
    if (state === "ready") return workspace ?? {};
    if (state === "error" || state === "failed") throw new Error(`workspace entered ${state}: ${JSON.stringify(workspace)}`);
    if (Date.now() >= deadline) throw new Error(`workspace did not become ready within ${timeoutMs}ms (state=${state})`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
}

describeIfBuilt("v3 direct-publication cold scan: two files sharing an external import", () => {
  it(
    "reaches ready without a record_occurrences.record_id UNIQUE constraint failure",
    async () => {
      // Short prefixes: a v3 daemon listens on a UNIX socket under
      // `dataRoot` (`daemon.sock`), and macOS's `sun_path` is capped at
      // ~104 bytes -- a verbose temp-dir prefix here overflows it with
      // `listen EINVAL: invalid argument ... daemon.sock`.
      const dataRoot = await mkdtemp(join(tmpdir(), "urd-v3xm-d-"));
      const corpusRoot = await mkdtemp(join(tmpdir(), "urd-v3xm-c-"));
      const nativeClosure = await prepareNativeRoot(artifactRoot!);
      const previousEnv = {
        URDIRA_V4: process.env["URDIRA_V4"],
        URDIRA_NATIVE_REQUIRED: process.env["URDIRA_NATIVE_REQUIRED"],
        URDIRA_NATIVE_ROOT: process.env["URDIRA_NATIVE_ROOT"],
        URDIRA_INDEXING_CORE_WORKER_PATH: process.env["URDIRA_INDEXING_CORE_WORKER_PATH"],
        URDIRA_SEMANTIC_INDEX: process.env["URDIRA_SEMANTIC_INDEX"],
      };
      try {
        await writeFixture(corpusRoot, LODASH_FIXTURE);
        process.env["URDIRA_V4"] = "0";
        process.env["URDIRA_NATIVE_REQUIRED"] = "1";
        process.env["URDIRA_NATIVE_ROOT"] = nativeClosure.native_root;
        process.env["URDIRA_INDEXING_CORE_WORKER_PATH"] = join(nativeClosure.native_root, "urdira-indexing-worker");
        process.env["URDIRA_SEMANTIC_INDEX"] = "0";
        const daemonOptions = await defaultDaemonOptions(dataRoot);
        const runOptions = { daemon: daemonOptions, admin_request_timeout_ms: 60_000 };
        const started = await runUrdira(["daemon", "start", "--json"], runOptions);
        expect(started.exit_code).toBe(0);
        try {
          const selection = JSON.stringify({ selected_technology_ids: ["typescript"], selected_plugin_ids: ["urdira:javascript_typescript"] });
          const added = await runUrdira(["workspace", "add", corpusRoot, "--payload", selection, "--confirm", "--json"], runOptions);
          expect(added.exit_code).toBe(0);
          const workspaceId = (added.data as { readonly result?: { readonly workspace_id?: string } } | undefined)?.result?.workspace_id;
          expect(typeof workspaceId).toBe("string");
          // The bug this test guards against surfaces as `workspace add`
          // itself succeeding (the scan runs asynchronously) but the
          // workspace's status transitioning to "error"/"failed" with
          // `UNIQUE constraint failed: record_occurrences.record_id`
          // instead of ever reaching "ready" -- `pollWorkspaceReady` throws
          // on either terminal failure state, surfacing that message here.
          const workspace = await pollWorkspaceReady(runOptions, workspaceId!, 60_000);
          expect(workspace["status"]).toBe("ready");
        } finally {
          await runUrdira(["daemon", "stop", "--json"], runOptions);
        }
      } finally {
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await nativeClosure.cleanup();
        await rm(dataRoot, { recursive: true, force: true });
        await rm(corpusRoot, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
