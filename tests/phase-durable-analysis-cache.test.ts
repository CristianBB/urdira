import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeProject,
  buildJavascriptTypescriptFactDelta,
  createJavascriptTypescriptThreadTransport,
  createJavascriptTypescriptWorker,
  type AnalyzerFile,
  type JavascriptTypescriptFactDeltaInput,
} from "../packages/plugin-javascript-typescript/src/index.js";

// Regression coverage for docs/decisions/15-durable-analysis-cache.md: the
// durable (on-disk) whole-project analysis cache that lets a fresh,
// one-thread-per-scan worker (`thread-transport.ts`'s doc comment) skip a
// from-scratch `analyzeProject` build when a PRIOR process already analyzed
// the identical (files, root_names, compiler_options) under the identical
// TypeScript/analyzer build -- a daemon restart, a workspace remove+re-add,
// a post-fork rescan, or a plugin-upgrade generation over an unchanged tree.

async function withCacheDir(test: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "urdira-durable-analysis-cache-"));
  try { await test(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function cacheEntryNames(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".json.gz"));
}

/** A tiny two-file project (a.ts imports b.ts) -- small enough for a fast checker pass, non-trivial enough to exercise `analyze_closure` and a real subset-narrowed `analyze_artifact`. */
function makeFiles(probe = 0): AnalyzerFile[] {
  return [
    { path: "a.ts", text: `import { b } from "./b";\nexport function a(): number { return b + ${probe}; }` },
    { path: "b.ts", text: "export const b: number = 1;" },
  ];
}

function workItemFor(owner: string): Record<string, unknown> {
  return {
    candidate_generation_id: "candidate:durable-cache-test",
    workspace_id: "workspace:durable-cache-test",
    artifact_id: `artifact:${owner}`,
    target_artifact_version_id: `version:${owner}`,
    work_item_id: `work:${owner}`,
    plugin_id: "urdira:javascript_typescript",
    plugin_version: "0.1.0",
    expected_replacement_scopes: [{
      replacement_scope_id: `scope:${owner}`,
      owner_artifact_id: `artifact:${owner}`,
      owner_artifact_version_id: `version:${owner}`,
      capability: "core:call_relationships",
      record_categories: ["entity", "relation", "diagnostic"],
      record_kinds: [
        "jsts:entity_type", "jsts:entity_callable", "jsts:entity_container", "jsts:entity_parameter", "jsts:entity_variable",
        "jsts:relation_contains", "jsts:relation_import", "jsts:relation_export", "jsts:relation_references", "jsts:relation_call",
        "jsts:relation_implements", "jsts:relation_inherits", "jsts:relation_covers", "jsts:diagnostic",
      ],
      base_record_set_digest: "sha256:empty",
      output_completeness: "accept_reported",
    }],
  };
}

function manifestFor(owner: string): Record<string, unknown> {
  return {
    plugin_input_access_manifest_id: `manifest:${owner}`,
    manifest_digest: `sha256:manifest-${owner}`,
    artifact_version_entries: [{ artifact_version_id: `version:${owner}` }],
    record_entries: [],
  };
}

function analyzeRequest(files: readonly AnalyzerFile[], rootNames: readonly string[], owner: string) {
  return {
    protocol_version: "1.0.0",
    request_id: `durable-cache-test:${owner}`,
    request_digest: `digest:${owner}`,
    call: "analyze_artifact" as const,
    deadline: "2030-01-01T00:00:00.000Z",
    cancellation_id: `cancel:${owner}`,
    payload: {
      files,
      root_names: rootNames,
      owner_path: owner,
      work_item: workItemFor(owner),
      accepted_manifest: manifestFor(owner),
      analysis_digest: "sha256:jsts-analysis",
      analysis_configuration_digest: "sha256:jsts-configuration",
      analysis_input_digest: `digest:${owner}`,
      created_at: "1970-01-01T00:00:00.000Z",
    },
  };
}

function closureRequest(files: readonly AnalyzerFile[], rootNames: readonly string[]) {
  return {
    protocol_version: "1.0.0",
    request_id: "durable-cache-test:closure",
    request_digest: "digest:closure",
    call: "analyze_closure" as const,
    deadline: "2030-01-01T00:00:00.000Z",
    cancellation_id: "cancel:closure",
    payload: { files, root_names: rootNames },
  };
}

/** Ground truth: analyze fresh (no worker/cache involved at all) and build the delta for one owner. */
function freshDeltaFor(files: readonly AnalyzerFile[], rootNames: readonly string[], owner: string): unknown {
  const analysis = analyzeProject({ files, root_names: rootNames });
  const input: JavascriptTypescriptFactDeltaInput = {
    analysis,
    work_item: workItemFor(owner),
    accepted_manifest: manifestFor(owner),
    analysis_digest: "sha256:jsts-analysis",
    analysis_configuration_digest: "sha256:jsts-configuration",
    analysis_input_digest: `digest:${owner}`,
    created_at: "1970-01-01T00:00:00.000Z",
    owner_path: owner,
    files,
  };
  return buildJavascriptTypescriptFactDelta(input);
}

describe("JavaScript/TypeScript durable analysis cache", () => {
  it("shares one durable entry across two separate worker instances: first builds, second disk-hits with an identical payload", async () => {
    await withCacheDir(async (dir) => {
      const files = makeFiles();
      const rootNames = files.map((file) => file.path);

      let builds1 = 0;
      let loads1 = 0;
      const worker1 = createJavascriptTypescriptWorker({ analysis_cache_dir: dir, on_analysis_build: () => { builds1 += 1; }, on_analysis_cache_load: () => { loads1 += 1; } });
      const response1 = await worker1.invoke(closureRequest(files, rootNames));
      await worker1.terminate();
      expect(builds1).toBe(1);
      expect(loads1).toBe(0);
      expect(await cacheEntryNames(dir)).toHaveLength(1);

      let builds2 = 0;
      let loads2 = 0;
      const worker2 = createJavascriptTypescriptWorker({ analysis_cache_dir: dir, on_analysis_build: () => { builds2 += 1; }, on_analysis_cache_load: () => { loads2 += 1; } });
      const response2 = await worker2.invoke(closureRequest(files, rootNames));
      await worker2.terminate();
      expect(builds2).toBe(0);
      expect(loads2).toBe(1);
      expect(response2).toEqual(response1);
    });
  });

  it("reuses a disk-hit via the in-memory subset path for a narrowed analyze_artifact, matching a no-cache-dir worker's delta", async () => {
    await withCacheDir(async (dir) => {
      const files = makeFiles();
      const rootNames = files.map((file) => file.path);

      // Prime the durable cache with an unrelated worker instance.
      const primer = createJavascriptTypescriptWorker({ analysis_cache_dir: dir });
      await primer.invoke(closureRequest(files, rootNames));
      await primer.terminate();

      let builds = 0;
      let loads = 0;
      const worker = createJavascriptTypescriptWorker({ analysis_cache_dir: dir, on_analysis_build: () => { builds += 1; }, on_analysis_cache_load: () => { loads += 1; } });
      const closureResponse = await worker.invoke(closureRequest(files, rootNames)) as {
        readonly payload: { readonly dependency_closures: Readonly<Record<string, { readonly files: readonly string[]; readonly complete: boolean }>> };
      };
      expect(builds).toBe(0);
      expect(loads).toBe(1);

      const owner = "b.ts";
      const closure = closureResponse.payload.dependency_closures[owner]!;
      const narrowedFiles = files.filter((file) => closure.files.includes(file.path));
      const response = await worker.invoke(analyzeRequest(narrowedFiles, closure.files, owner)) as {
        readonly payload: { readonly validation_input: { readonly raw_delta: unknown } };
      };
      // The narrowed request must be served by the in-memory subset-reuse
      // path (installed from the disk hit above), not by a second disk read
      // or a rebuild.
      expect(builds).toBe(0);
      expect(loads).toBe(1);
      await worker.terminate();

      const noCacheWorker = createJavascriptTypescriptWorker();
      const expectedResponse = await noCacheWorker.invoke(analyzeRequest(narrowedFiles, closure.files, owner)) as {
        readonly payload: { readonly validation_input: { readonly raw_delta: unknown } };
      };
      await noCacheWorker.terminate();
      expect(response.payload.validation_input.raw_delta).toEqual(expectedResponse.payload.validation_input.raw_delta);
      expect(response.payload.validation_input.raw_delta).toEqual(freshDeltaFor(files, rootNames, owner));
    });
  });

  it("rebuilds and mints a new durable entry when a file's content genuinely changes", async () => {
    await withCacheDir(async (dir) => {
      const rootNames = makeFiles().map((file) => file.path);
      const worker1 = createJavascriptTypescriptWorker({ analysis_cache_dir: dir });
      await worker1.invoke(closureRequest(makeFiles(0), rootNames));
      await worker1.terminate();
      expect(await cacheEntryNames(dir)).toHaveLength(1);

      let builds = 0;
      const worker2 = createJavascriptTypescriptWorker({ analysis_cache_dir: dir, on_analysis_build: () => { builds += 1; } });
      await worker2.invoke(closureRequest(makeFiles(1), rootNames));
      await worker2.terminate();
      expect(builds).toBe(1);
      expect(await cacheEntryNames(dir)).toHaveLength(2);
    });
  });

  it("rebuilds and mints a new durable entry when analysis_digest differs across otherwise-identical requests", async () => {
    await withCacheDir(async (dir) => {
      const files = makeFiles();
      const rootNames = files.map((file) => file.path);
      const worker1 = createJavascriptTypescriptWorker({ analysis_cache_dir: dir, analysis_digest: "sha256:analysis-one" });
      await worker1.invoke(closureRequest(files, rootNames));
      await worker1.terminate();
      expect(await cacheEntryNames(dir)).toHaveLength(1);

      let builds = 0;
      const worker2 = createJavascriptTypescriptWorker({ analysis_cache_dir: dir, analysis_digest: "sha256:analysis-two", on_analysis_build: () => { builds += 1; } });
      await worker2.invoke(closureRequest(files, rootNames));
      await worker2.terminate();
      expect(builds).toBe(1);
      expect(await cacheEntryNames(dir)).toHaveLength(2);
    });
  });

  it("rebuilds without throwing when a durable entry is corrupted, and rewrites a valid entry a later worker can disk-hit", async () => {
    await withCacheDir(async (dir) => {
      const files = makeFiles();
      const rootNames = files.map((file) => file.path);

      const worker1 = createJavascriptTypescriptWorker({ analysis_cache_dir: dir });
      await worker1.invoke(closureRequest(files, rootNames));
      await worker1.terminate();
      const entries = await cacheEntryNames(dir);
      expect(entries).toHaveLength(1);
      await writeFile(join(dir, entries[0]!), Buffer.from("not a valid gzip payload at all"));

      let builds2 = 0;
      const worker2 = createJavascriptTypescriptWorker({ analysis_cache_dir: dir, on_analysis_build: () => { builds2 += 1; } });
      await expect(worker2.invoke(closureRequest(files, rootNames))).resolves.toBeDefined();
      await worker2.terminate();
      expect(builds2).toBe(1);

      let builds3 = 0;
      let loads3 = 0;
      const worker3 = createJavascriptTypescriptWorker({ analysis_cache_dir: dir, on_analysis_build: () => { builds3 += 1; }, on_analysis_cache_load: () => { loads3 += 1; } });
      await worker3.invoke(closureRequest(files, rootNames));
      await worker3.terminate();
      expect(builds3).toBe(0);
      expect(loads3).toBe(1);
    });
  });

  it("touches no filesystem entry and always rebuilds when analysis_cache_dir is absent", async () => {
    const files = makeFiles();
    const rootNames = files.map((file) => file.path);
    let builds = 0;
    const worker1 = createJavascriptTypescriptWorker({ on_analysis_build: () => { builds += 1; } });
    await worker1.invoke(closureRequest(files, rootNames));
    await worker1.terminate();
    const worker2 = createJavascriptTypescriptWorker({ on_analysis_build: () => { builds += 1; } });
    await worker2.invoke(closureRequest(files, rootNames));
    await worker2.terminate();
    // No durable cache to hit means every fresh worker instance rebuilds --
    // behavior byte-for-byte unchanged from before this feature existed.
    expect(builds).toBe(2);
  });

  // Prune coverage: with a cap of 2, three distinct-content builds must
  // leave at most 2 entries on disk, and the most recently built entry must
  // still disk-hit. Built via three SEPARATE worker instances (never a
  // shared in-memory cache) and given explicit, strictly increasing mtimes
  // after each write -- real filesystem mtime resolution (observed to
  // collide within the same second on APFS) would otherwise make the
  // "oldest" entry ambiguous between fast, back-to-back writes in this test.
  it("prunes the durable cache down to analysis_cache_max_entries, keeping the most recently built entry live", async () => {
    await withCacheDir(async (dir) => {
      const rootNames = ["only.ts"];
      const pastBase = new Date("2000-01-01T00:00:00.000Z").getTime();
      const seen = new Set<string>();
      let stampCounter = 0;
      for (let probe = 0; probe < 3; probe += 1) {
        const files: AnalyzerFile[] = [{ path: "only.ts", text: `export const probe = ${probe};` }];
        const worker = createJavascriptTypescriptWorker({ analysis_cache_dir: dir, analysis_cache_max_entries: 2 });
        await worker.invoke(closureRequest(files, rootNames));
        await worker.terminate();
        const newEntry = (await cacheEntryNames(dir)).find((name) => !seen.has(name));
        if (newEntry !== undefined) {
          seen.add(newEntry);
          const stamp = new Date(pastBase + stampCounter * 1000);
          await utimes(join(dir, newEntry), stamp, stamp);
          stampCounter += 1;
        }
      }
      expect((await cacheEntryNames(dir)).length).toBeLessThanOrEqual(2);

      let builds = 0;
      let loads = 0;
      const newestFiles: AnalyzerFile[] = [{ path: "only.ts", text: "export const probe = 2;" }];
      const worker = createJavascriptTypescriptWorker({ analysis_cache_dir: dir, analysis_cache_max_entries: 2, on_analysis_build: () => { builds += 1; }, on_analysis_cache_load: () => { loads += 1; } });
      await worker.invoke(closureRequest(newestFiles, rootNames));
      await worker.terminate();
      expect(builds).toBe(0);
      expect(loads).toBe(1);
    });
  });

  it("threads analysis_cache_dir through workerData: a real worker-thread's durable write completes before invoke() returns, and a fresh in-process worker over the same dir disk-hits", async () => {
    await withCacheDir(async (dir) => {
      const files = makeFiles();
      const rootNames = files.map((file) => file.path);

      const transport = createJavascriptTypescriptThreadTransport({ analysis_cache_dir: dir });
      try {
        await transport.invoke(closureRequest(files, rootNames));
      } finally {
        await transport.terminate();
      }
      // `thread-transport.ts`'s terminate() hard-kills the worker thread
      // (node's own worker.terminate(), never the in-thread worker's own
      // graceful terminate) -- the entry existing here proves the durable
      // write was awaited to completion INSIDE invoke(), before this
      // function's own await ever returned, not raced against the kill.
      expect(await cacheEntryNames(dir)).toHaveLength(1);

      let builds = 0;
      let loads = 0;
      const worker = createJavascriptTypescriptWorker({ analysis_cache_dir: dir, on_analysis_build: () => { builds += 1; }, on_analysis_cache_load: () => { loads += 1; } });
      await worker.invoke(closureRequest(files, rootNames));
      await worker.terminate();
      expect(builds).toBe(0);
      expect(loads).toBe(1);
    });
  }, 30_000);
});
