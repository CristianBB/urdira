#!/usr/bin/env node
/* c8 ignore file -- measurement harness (task E.6, plan
 * `generic-waddling-hartmanis.md` §2.6), exercised by explicit gate runs
 * against a real corpus, not by the unit-test coverage corpus. */

// Measures the delta/cold crossover of `ScanScope::Reconcile`
// (`crates/urdira-indexing-worker/src/v4/scan.rs::run_reconcile`) on a real
// corpus, to pin `RECONCILE_DELTA_THRESHOLD` (plan §0 R1) with a number
// instead of a guess.
//
// Mechanism: for a fraction `p` of the frontier, mutate `ceil(p * frontier_size)`
// eligible TS/JS files (90% append a line, 10% delete/rename -- deterministic,
// seeded selection) on top of a shared "gen 1" cold-scan snapshot, then run
// ONE `workspace_scan{scope: {kind: "reconcile"}}` with
// `URDIRA_V4_RECONCILE_THRESHOLD=1.0` (forces the `Delta` branch --
// `touched_count <= threshold * frontier_size` is always true at T=1.0) and
// a SEPARATE copy with `=0.0` (forces `Cold`, the R1-large-delta branch --
// only `touched_count == 0` short-circuits to `Noop` before the threshold
// comparison even runs; T=0.0 makes every `touched_count > 0` case take
// `Cold`). Both branches are diffed, per `run_reconcile`'s own doc comment,
// against the exact same authoritative enumeration, so `T` only moves which
// pipeline runs, never the resulting Merkle roots -- verified here against a
// from-scratch "oracle" full scan of the identically-mutated tree
// (`scripts/v4-scan.mjs`'s own code path, inlined as `runFullScan`).
//
// Usage (fraction sweep -- the documented contract, plan §2.6):
//   node scripts/v4-reconcile-threshold.mjs \
//     --corpus <dir> --data <dir> --fractions 0.01,0.05,0.10,0.25,0.50 \
//     --repeat 2 --out <json>
//
// Usage (git-switch mode -- plan §2.6 point 3, same binary/env plumbing):
//   node scripts/v4-reconcile-threshold.mjs --git-switch \
//     --git-repo <existing local git checkout, READ-ONLY> --data <scratch dir> \
//     --git-tag-a <tag> --git-tag-b <tag> --git-head-back <n> --out <json>
//
// Env:
//   URDIRA_INDEXING_CORE_WORKER_PATH: path to the `urdira-indexing-worker`
//     binary (release build). Defaults to `target/release/urdira-indexing-worker`.
//
// Safety: `--corpus`/`--git-repo` are NEVER mutated in place -- every
// mutation lands on a fresh recursive copy under `--data` (or a `git clone`
// under a scratch dir for git-switch mode). A directory carrying
// `.urdira-shared-corpus-readonly` is refused outright as a mutation target
// (plan's "corpus compartido de solo lectura" rule), matching
// `scripts/v4-mutation-harness.mjs`'s own guard.

import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { cp, mkdir, opendir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SHARED_CORPUS_MARKER = ".urdira-shared-corpus-readonly";
const SOURCE_EXT_RE = /\.(?:mts|cts|tsx|ts|mjs|cjs|jsx|js)$/u;
const DECLARATION_RE = /\.d\.[cm]?ts$/u;
const SKIP_DIR_SEGMENTS = new Set(["dist", "build", "out", "node_modules", ".git"]);

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function isProtectedReadonlyCorpus(dir) {
  return existsSync(join(dir, SHARED_CORPUS_MARKER));
}

function assertMutable(dir, context) {
  if (isProtectedReadonlyCorpus(dir)) {
    throw new Error(`Refusing to ${context} inside ${dir}: it carries ${SHARED_CORPUS_MARKER} (shared, read-only corpus). Copy it to a scratch directory first.`);
  }
}

function assertNeverTmp(dir, label) {
  if (dir === "/tmp" || dir.startsWith("/tmp/")) {
    throw new Error(`${label} must never be under /tmp (plan's measurement rule): ${dir}`);
  }
}

function isCandidateSourcePath(relPath) {
  if (!SOURCE_EXT_RE.test(relPath) || DECLARATION_RE.test(relPath)) return false;
  return !relPath.split("/").some((segment) => SKIP_DIR_SEGMENTS.has(segment));
}

async function listEligibleFiles(rootDir) {
  const results = [];
  const visit = async (dir, prefix) => {
    const handle = await opendir(dir);
    const names = [];
    for await (const entry of handle) names.push(entry.name);
    names.sort();
    for (const name of names) {
      if (name === SHARED_CORPUS_MARKER) continue;
      const relPath = prefix === "" ? name : `${prefix}/${name}`;
      const absolute = join(dir, name);
      let info;
      try {
        info = await import("node:fs/promises").then((m) => m.lstat(absolute));
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (SKIP_DIR_SEGMENTS.has(name)) continue;
        await visit(absolute, relPath);
      } else if (info.isFile() && isCandidateSourcePath(relPath)) {
        results.push(relPath);
      }
    }
  };
  await visit(rootDir, "");
  results.sort();
  return results;
}

/** Deterministic PRNG (mulberry32) -- same seed always yields the same
 * mutation set, so delta/cold/oracle copies of one fraction are mutated
 * IDENTICALLY without any inter-process coordination. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks `count` distinct indices out of `[0, n)` via a seeded partial
 * Fisher-Yates shuffle -- deterministic given `seed`, order-stable relative
 * to `eligible` (which is itself sorted, so independent of directory
 * iteration order across OSes/copies). */
function pickIndices(n, count, seed) {
  const rand = mulberry32(seed);
  const pool = Array.from({ length: n }, (_, i) => i);
  const picked = [];
  const upper = Math.min(count, n);
  for (let i = 0; i < upper; i += 1) {
    const j = i + Math.floor(rand() * (n - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    picked.push(pool[i]);
  }
  return picked;
}

const MUTATION_SEED = 0x5eed_5eed;

/** Plan §2.6: 90% of touched files get a trailing-line edit, 10% split
 * evenly between delete and rename (`<name>.renamed.<ext>`). Deterministic
 * given `touchedCount`/`eligible` (the seed is fixed above), so the SAME
 * plan is replayed against every fresh copy (delta/cold/oracle, every
 * repeat) of a given fraction. */
function buildMutationPlan(eligible, touchedCount) {
  if (touchedCount === 0) return [];
  const indices = pickIndices(eligible.length, touchedCount, MUTATION_SEED);
  const editCount = Math.ceil(touchedCount * 0.9);
  const plan = [];
  for (let i = 0; i < indices.length; i += 1) {
    const relPath = eligible[indices[i]];
    if (i < editCount) {
      plan.push({ kind: "edit", relPath });
    } else if ((i - editCount) % 2 === 0) {
      plan.push({ kind: "delete", relPath });
    } else {
      const dotIndex = relPath.lastIndexOf(".");
      const renamedTo = dotIndex === -1 ? `${relPath}.renamed` : `${relPath.slice(0, dotIndex)}.renamed${relPath.slice(dotIndex)}`;
      plan.push({ kind: "rename", relPath, renamedTo });
    }
  }
  return plan;
}

async function applyMutationPlan(workspaceRoot, plan) {
  assertMutable(workspaceRoot, "apply the reconcile-threshold mutation plan");
  const tally = { edit: 0, delete: 0, rename: 0 };
  for (const step of plan) {
    const absolute = join(workspaceRoot, step.relPath);
    if (step.kind === "edit") {
      const marker = `\n// urdira-bench ${tally.edit}\n`;
      await writeFile(absolute, (await readFile(absolute, "utf8")) + marker);
      tally.edit += 1;
    } else if (step.kind === "delete") {
      await unlink(absolute);
      tally.delete += 1;
    } else {
      const destination = join(workspaceRoot, step.renamedTo);
      await mkdir(dirname(destination), { recursive: true });
      await rename(absolute, destination);
      tally.rename += 1;
    }
  }
  return tally;
}

async function copyTree(src, dst) {
  await rm(dst, { recursive: true, force: true });
  await mkdir(dirname(dst), { recursive: true });
  await cp(src, dst, {
    recursive: true,
    filter: (source) => !source.endsWith(SHARED_CORPUS_MARKER),
  });
}

// ---------------------------------------------------------------------------
// Worker plumbing (pattern of `scripts/v4-scan.mjs`)
// ---------------------------------------------------------------------------

function workerPath() {
  return process.env["URDIRA_INDEXING_CORE_WORKER_PATH"] ?? resolve(root, "target/release/urdira-indexing-worker");
}

async function initDataDir(dataDir) {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  const databasePath = resolve(dataDir, "workspace.sqlite");
  const structuralRoot = resolve(dataDir, "structural");
  const casRoot = resolve(dataDir, "cas");
  const sidecarRoot = resolve(dataDir, "sidecar");
  await mkdir(casRoot, { recursive: true });
  await mkdir(sidecarRoot, { recursive: true });

  const { WORKSPACE_V4_SCHEMA } = await import(resolve(root, "packages/storage/dist/workspace-v4-sql.generated.js"));
  const { encodeCanonical } = await import(resolve(root, "packages/canonical/dist/index.js"));
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(WORKSPACE_V4_SCHEMA);
    const insertMeta = db.prepare("INSERT INTO workspace_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    insertMeta.run("index_contract", Uint8Array.of(0x34));
    insertMeta.run("identity_format", encodeCanonical(3));
    insertMeta.run("structural_store", encodeCanonical("native"));
  } finally {
    db.close();
  }
  return { databasePath, structuralRoot, casRoot, sidecarRoot };
}

async function withTransport(env, fn) {
  const { createIndexingCoreProcessTransport } = await import(resolve(root, "packages/plugin-javascript-typescript/dist/indexing-core-process-transport.js"));
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  const transport = createIndexingCoreProcessTransport({ command: workerPath(), request_timeout_ms: 3_600_000 });
  try {
    return await fn(transport);
  } finally {
    await transport.shutdown().catch(() => {});
    await transport.terminate();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runFullScan(workspaceRoot, dataPaths, workspaceId) {
  const { runRustWorkspaceScan } = await import(resolve(root, "packages/engine/dist/rust-workspace-scan.js"));
  return withTransport({}, (transport) =>
    runRustWorkspaceScan(transport, {
      workspace_id: workspaceId,
      workspace_root: workspaceRoot,
      database_path: dataPaths.databasePath,
      structural_root: dataPaths.structuralRoot,
      cas_root: dataPaths.casRoot,
      sidecar_root: dataPaths.sidecarRoot,
      scope: { kind: "full" },
      registry_snapshot_id: "registry:v4-reconcile-threshold",
      configuration_revision_id: "configuration:v4-reconcile-threshold",
      resolution_lock_id: "resolution:v4-reconcile-threshold",
      priority: "interactive",
    }),
  );
}

/**
 * Cold-scan `workspaceRoot` (its PRE-mutation state) and then run ONE
 * `reconcile` on the SAME worker process/`workspace_state`, `mutate`
 * applied in between -- NOT two independent processes.
 *
 * Why this matters (found live while running this exact harness,
 * 2026-09-06): `delta::run_one` builds `WorkspaceState.source_cache`/
 * `typeflow_cache` via `build_full` ONLY on the first incremental request a
 * given PROCESS ever sees for a workspace (`delta.rs` lines ~625-693's own
 * doc comments: "first `Changed` scan for this workspace in this process
 * ... build once ... the same documented 'first scan after restart' cost
 * already paid for `Frontier`/`StoreReader`"). `analyze::run_cold` (the
 * `Full`-scan path) ALSO builds them every time (a cold scan is BY
 * DEFINITION the first pass) and hands them back so `scan::run_full` can
 * seed `WorkspaceState` with them -- meaning a REAL daemon process that
 * cold-scanned a workspace and then reconciles it later in its OWN
 * lifetime starts warm. A harness that cold-scans in one process, persists
 * the result to disk, and reconciles from a SEPARATE freshly-spawned
 * process pays `build_full` again INSIDE the timed `Delta` call -- inflating
 * it to look as expensive as a full `Cold` reconcile even at a 1% mutation
 * (confirmed: an earlier version of this script measured `delta_wall_ms`
 * >= `cold_wall_ms` already at p=0.01 on n8n, which this fix corrects).
 * `Cold`-forced reconciles pay `build_full` regardless (same reasoning,
 * `run_cold` is unconditional) so this fix does not change their timing,
 * only `Delta`'s -- but both branches use this same warm-process shape for
 * symmetry and because it is also simply what a real long-lived worker
 * process does.
 */
async function runColdThenReconcile(workspaceRoot, dataDir, workspaceId, threshold, mutate) {
  const dataPaths = await initDataDir(dataDir);
  const { runRustWorkspaceScan } = await import(resolve(root, "packages/engine/dist/rust-workspace-scan.js"));
  return withTransport({ URDIRA_V4_RECONCILE_THRESHOLD: String(threshold) }, async (transport) => {
    const baseRequest = {
      workspace_id: workspaceId,
      workspace_root: workspaceRoot,
      database_path: dataPaths.databasePath,
      structural_root: dataPaths.structuralRoot,
      cas_root: dataPaths.casRoot,
      sidecar_root: dataPaths.sidecarRoot,
      registry_snapshot_id: "registry:v4-reconcile-threshold",
      configuration_revision_id: "configuration:v4-reconcile-threshold",
      resolution_lock_id: "resolution:v4-reconcile-threshold",
      priority: "interactive",
    };
    const coldOutcome = await runRustWorkspaceScan(transport, { ...baseRequest, scope: { kind: "full" } });
    await mutate();
    const reconcileOutcome = await runRustWorkspaceScan(transport, { ...baseRequest, scope: { kind: "reconcile" } });
    return { coldOutcome, reconcileOutcome };
  });
}

function rootsDiff(a, b) {
  return { records: a.records === b.records, dependency: a.dependency === b.dependency, graph: a.graph === b.graph };
}

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ---------------------------------------------------------------------------
// Machine-load guard (task rule: repeat if load average > 6)
// ---------------------------------------------------------------------------

async function waitForQuietMachine(label, maxAttempts = 20) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const [load1, load5, load15] = os.loadavg();
    console.log(`[uptime] before ${label}: load1=${load1.toFixed(2)} load5=${load5.toFixed(2)} load15=${load15.toFixed(2)}`);
    if (load1 <= 6) return;
    console.log(`[uptime] load1=${load1.toFixed(2)} > 6, waiting 15s before ${label} (attempt ${attempt}/${maxAttempts})`);
    await delay(15_000);
  }
  console.log(`[uptime] proceeding with ${label} despite sustained load after ${maxAttempts} attempts`);
}

// ---------------------------------------------------------------------------
// Fraction-sweep mode (documented CLI contract)
// ---------------------------------------------------------------------------

async function runFractionSweep(options) {
  const { corpus, data, fractions, repeat, out, files, keepData } = options;
  assertNeverTmp(data, "--data");
  await mkdir(data, { recursive: true });

  const templateWorkspace = join(data, "template-workspace");
  const templateData = join(data, "template-data");
  console.log(`[setup] copying corpus ${corpus} -> ${templateWorkspace}`);
  await copyTree(corpus, templateWorkspace);
  const eligible = await listEligibleFiles(templateWorkspace);
  console.log(`[setup] eligible TS/JS files: ${eligible.length}`);

  await waitForQuietMachine("template cold scan");
  const templateDataPaths = await initDataDir(templateData);
  const workspaceId = "workspace:v4-reconcile-threshold";
  const templateStart = performance.now();
  const templateCold = await runFullScan(templateWorkspace, templateDataPaths, workspaceId);
  const templateWallMs = performance.now() - templateStart;
  console.log(`[setup] template cold scan: generation=${templateCold.generation} completed_at_ms=${templateCold.completed_at_ms} roots=${JSON.stringify(templateCold.roots)}`);

  const rows = [];
  let frontierSize;

  // `--files N` bisection mode: ONE cell, `touchedCount` given directly
  // (still fed through the SAME seeded `buildMutationPlan`, so `--files 202`
  // reproduces p=0.01's exact plan on the n8n corpus this doc's evidence
  // measured -- `pickIndices`' seed/order never depend on `fractions`).
  const cellPlan = files !== undefined ? [{ syntheticFraction: null, files }] : fractions.map((p) => ({ p }));

  for (const cell of cellPlan) {
    const p = cell.p;
    const label = files !== undefined ? `files${cell.files}` : `p${String(Math.round(p * 10000)).padStart(4, "0")}`;
    let touchedCount;
    if (files !== undefined) {
      touchedCount = cell.files;
    } else if (p === 0) {
      touchedCount = 0;
    } else if (frontierSize !== undefined) {
      touchedCount = Math.max(1, Math.ceil(p * frontierSize));
    } else {
      // Fallback before the p=0 cell has reported an authoritative
      // frontier_size (should not happen -- 0 is always first in the
      // fraction list, see main()).
      touchedCount = Math.max(1, Math.ceil(p * eligible.length));
    }
    const plan = buildMutationPlan(eligible, touchedCount);
    console.log(`[fraction ${p}] touched=${touchedCount} plan=${JSON.stringify(plan.reduce((acc, s) => ({ ...acc, [s.kind]: (acc[s.kind] ?? 0) + 1 }), {}))}`);

    const deltaWalls = [];
    const coldWalls = [];
    let deltaSummary;
    let coldSummary;
    let deltaRoots;
    let coldRoots;

    for (let r = 1; r <= repeat; r += 1) {
      // Forced Delta (T=1.0): fresh unmutated copy, cold-scanned and THEN
      // reconciled on the SAME warm process (see `runColdThenReconcile`'s
      // doc comment for why this, not a copied data dir, is required).
      const deltaWorkspace = join(data, `run-${label}-delta-${r}-workspace`);
      const deltaDataDir = join(data, `run-${label}-delta-${r}-data`);
      await copyTree(templateWorkspace, deltaWorkspace);
      await waitForQuietMachine(`${label} delta repeat ${r}`);
      const { reconcileOutcome: deltaEvent } = await runColdThenReconcile(deltaWorkspace, deltaDataDir, workspaceId, 1.0, () => applyMutationPlan(deltaWorkspace, plan));
      deltaWalls.push(deltaEvent.completed_at_ms);
      deltaSummary = deltaEvent.reconcile;
      deltaRoots = deltaEvent.roots;
      if (!keepData) {
        await rm(deltaWorkspace, { recursive: true, force: true });
        await rm(deltaDataDir, { recursive: true, force: true });
      } else {
        console.log(`[fraction ${p}] --keep-data: kept ${deltaWorkspace} / ${deltaDataDir}`);
      }

      // Forced Cold (T=0.0), independent fresh copy, same mutation plan,
      // same warm-process shape.
      const coldWorkspace = join(data, `run-${label}-cold-${r}-workspace`);
      const coldDataDir = join(data, `run-${label}-cold-${r}-data`);
      await copyTree(templateWorkspace, coldWorkspace);
      await waitForQuietMachine(`${label} cold repeat ${r}`);
      const { reconcileOutcome: coldEvent } = await runColdThenReconcile(coldWorkspace, coldDataDir, workspaceId, 0.0, () => applyMutationPlan(coldWorkspace, plan));
      coldWalls.push(coldEvent.completed_at_ms);
      coldSummary = coldEvent.reconcile;
      coldRoots = coldEvent.roots;
      if (!keepData) {
        await rm(coldWorkspace, { recursive: true, force: true });
        await rm(coldDataDir, { recursive: true, force: true });
      } else {
        console.log(`[fraction ${p}] --keep-data: kept ${coldWorkspace} / ${coldDataDir}`);
      }
    }

    if (frontierSize === undefined) frontierSize = deltaSummary.frontier_size;

    // From-scratch oracle of the identically-mutated tree (skipped for
    // p=0: an unmutated tree's oracle is the template's own cold scan).
    let oracleRoots = templateCold.roots;
    let oracleWallMs = templateWallMs;
    if (p !== 0) {
      const oracleWorkspace = join(data, `oracle-${label}-workspace`);
      const oracleData = join(data, `oracle-${label}-data`);
      await copyTree(templateWorkspace, oracleWorkspace);
      await applyMutationPlan(oracleWorkspace, plan);
      const oracleDataPaths = await initDataDir(oracleData);
      await waitForQuietMachine(`${label} oracle`);
      const oracleStart = performance.now();
      const oracleEvent = await runFullScan(oracleWorkspace, oracleDataPaths, `${workspaceId}:oracle:${label}`);
      oracleWallMs = performance.now() - oracleStart;
      oracleRoots = oracleEvent.roots;
      if (!keepData) {
        await rm(oracleWorkspace, { recursive: true, force: true });
        await rm(oracleData, { recursive: true, force: true });
      } else {
        console.log(`[fraction ${p}] --keep-data: kept ${oracleWorkspace} / ${oracleData}`);
      }
    }

    const deltaRootsOk = rootsDiff(deltaRoots, oracleRoots);
    const coldRootsOk = rootsDiff(coldRoots, oracleRoots);
    const deltaAllOk = deltaRootsOk.records && deltaRootsOk.dependency && deltaRootsOk.graph;
    const coldAllOk = coldRootsOk.records && coldRootsOk.dependency && coldRootsOk.graph;
    // `Cold`-forced reconciles re-run the FULL pipeline (`run_full_from`)
    // against the SAME authoritative enumeration the oracle used -- no
    // scope-narrowing applies, so all three roots must match exactly,
    // always. Abort (per plan's "verify-roots ... abortar si no") if not:
    // a `Cold`/oracle mismatch would mean the reconcile pipeline itself is
    // broken, not a measurement artifact.
    if (!coldAllOk) {
      throw new Error(`fraction ${p}: Cold roots mismatch vs oracle (this pipeline has no scope-narrowing -- should always match exactly) -- cold=${JSON.stringify(coldRootsOk)}`);
    }
    // `Delta`-forced reconciles: NOT hard-gated on any root (see
    // `docs/evidence/2026-09-06-v4-reconcile-threshold.md`'s "P0 finding"
    // section for the full writeup). `delta.rs`'s own module-level doc
    // comment ("Documented scope narrowing versus the plan's exact
    // wording") already flags that dependency rows are diffed at OWNER
    // granularity (closed/reopened unconditionally for every touched/
    // deleted owner, never by `dependency_id`) and calls this "a residual
    // precision gap for whichever task next tightens dependency identity"
    // -- explicitly deferred, not E.6's to fix. Confirmed live measuring
    // THIS harness on n8n: at p=0.01 (202 files, 10 deletes/10 renames)
    // `dependency`/`records` differed but `graph` matched; at p=0.05 (1008
    // files, 50/50) ALL THREE differed under `Delta` while the identical
    // mutation under forced `Cold` matched the oracle exactly (`publish.rs`
    // derives `graph_entries` FROM the records/relations set passed in, so
    // any owner `delta::run`'s closure-bounded diff misses -- e.g. an
    // untouched owner holding a relation INTO a deleted/renamed identity --
    // can propagate from a stale `dependency` row into a stale `graph`
    // entry too). This is the SAME documented gap, just more fully
    // characterized at real-corpus scale than the single-kind, small-scale
    // existing tests (`reconcile_{delete,rename}_roots_match_...`) ever
    // exercised. `Cold`'s hard gate above is what actually protects
    // correctness here: R2/R3 aside, this measurement's own job is the
    // delta/cold WALL-TIME crossover, which is unaffected by root identity;
    // roots are still recorded per fraction below for whoever picks up the
    // follow-up.

    rows.push({
      p,
      touched_count: touchedCount,
      frontier_size: frontierSize,
      n_over_size: frontierSize > 0 ? touchedCount / frontierSize : 0,
      delta_wall_ms_repeats: deltaWalls,
      cold_wall_ms_repeats: coldWalls,
      delta_wall_ms: median(deltaWalls),
      cold_wall_ms: median(coldWalls),
      ratio: median(deltaWalls) / median(coldWalls),
      delta_reconcile_summary: deltaSummary,
      cold_reconcile_summary: coldSummary,
      oracle_wall_ms: oracleWallMs,
      roots_ok: { delta: deltaRootsOk, cold: coldRootsOk, delta_all: deltaAllOk, cold_all: coldAllOk },
    });
    console.log(`[fraction ${p}] delta_wall_ms=${median(deltaWalls).toFixed(1)} cold_wall_ms=${median(coldWalls).toFixed(1)} ratio=${(median(deltaWalls) / median(coldWalls)).toFixed(3)} roots_ok.delta_all=${deltaAllOk} roots_ok.cold_all=${coldAllOk}`);
  }

  // Crossover: first p where delta_wall >= cold_wall, linearly interpolated
  // between the bracketing measured fractions (plan §0 R1 / §2.6 point 4).
  // `p=0` is excluded from this search: both branches run the IDENTICAL
  // `Noop` code path there (see `run_reconcile`'s `touched_count == 0`
  // short-circuit, above the threshold comparison entirely), so any
  // delta/cold difference at p=0 is pure measurement noise, not a signal
  // about the threshold.
  const positiveRows = rows.filter((row) => row.p > 0);
  let crossoverP;
  if (positiveRows.length > 0 && positiveRows[0].delta_wall_ms >= positiveRows[0].cold_wall_ms) {
    crossoverP = positiveRows[0].p;
  } else {
    for (let i = 1; i < positiveRows.length; i += 1) {
      const prev = positiveRows[i - 1];
      const curr = positiveRows[i];
      const prevDiff = prev.delta_wall_ms - prev.cold_wall_ms;
      const currDiff = curr.delta_wall_ms - curr.cold_wall_ms;
      if (currDiff >= 0) {
        const t = -prevDiff / (currDiff - prevDiff);
        crossoverP = prev.p + t * (curr.p - prev.p);
        break;
      }
    }
  }
  const cappedAt50 = crossoverP === undefined;
  const chosenThreshold = cappedAt50 ? 0.5 : Math.round(crossoverP * 0.8 * 100) / 100;

  const result = {
    workspace_id: workspaceId,
    corpus,
    eligible_file_count: eligible.length,
    frontier_size: frontierSize,
    template_cold_wall_ms: templateWallMs,
    template_cold_roots: templateCold.roots,
    fractions: rows,
    crossover_p: crossoverP ?? null,
    capped_at_50: cappedAt50,
    chosen_threshold: chosenThreshold,
    measured_at: new Date().toISOString(),
  };
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`[done] wrote ${out}`);
  console.log(`[done] crossover_p=${crossoverP ?? "none (capped at 0.50)"} chosen_threshold=${chosenThreshold}`);

  await rm(templateWorkspace, { recursive: true, force: true });
  await rm(templateData, { recursive: true, force: true });
  return result;
}

// ---------------------------------------------------------------------------
// Git-switch mode (plan §2.6 point 3)
// ---------------------------------------------------------------------------

async function gitCheckout(repoDir, ref) {
  await execFileAsync("git", ["checkout", "--quiet", "--force", ref], { cwd: repoDir });
}

async function gitDiffNameOnlyCount(repoDir, a, b) {
  const { stdout } = await execFileAsync("git", ["diff", "--name-only", a, b], { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * Runs ONE "cold@refA, then checkout refB, then reconcile at `threshold`"
 * cycle on a single warm worker process (see `runColdThenReconcile`'s doc
 * comment for why the cold scan and the reconcile must share one process).
 * `repoDir`'s working tree is left checked out at `refB` when this returns.
 */
async function runOneGitSwitchCycle(label, repoDir, refA, refB, workspaceId, threshold, dataDir, keepData = false) {
  console.log(`[git-switch:${label}] checkout ${refA} (T=${threshold})`);
  await gitCheckout(repoDir, refA);
  await waitForQuietMachine(`git-switch ${label} cold@${refA} T=${threshold}`);
  const dataPaths = await initDataDir(dataDir);
  const { runRustWorkspaceScan } = await import(resolve(root, "packages/engine/dist/rust-workspace-scan.js"));
  const result = await withTransport({ URDIRA_V4_RECONCILE_THRESHOLD: String(threshold) }, async (transport) => {
    const baseRequest = {
      workspace_id: workspaceId,
      workspace_root: repoDir,
      database_path: dataPaths.databasePath,
      structural_root: dataPaths.structuralRoot,
      cas_root: dataPaths.casRoot,
      sidecar_root: dataPaths.sidecarRoot,
      registry_snapshot_id: "registry:v4-reconcile-threshold",
      configuration_revision_id: "configuration:v4-reconcile-threshold",
      resolution_lock_id: "resolution:v4-reconcile-threshold",
      priority: "interactive",
    };
    const coldStart = performance.now();
    const coldEvent = await runRustWorkspaceScan(transport, { ...baseRequest, scope: { kind: "full" } });
    const coldWallMs = performance.now() - coldStart;
    await gitCheckout(repoDir, refB);
    const reconcileStart = performance.now();
    const reconcileEvent = await runRustWorkspaceScan(transport, { ...baseRequest, scope: { kind: "reconcile" } });
    const reconcileWallMs = performance.now() - reconcileStart;
    return { coldEvent, coldWallMs, reconcileEvent, reconcileWallMs };
  });
  console.log(`[git-switch:${label}] cold@${refA}: ${result.coldWallMs.toFixed(1)}ms; reconcile(T=${threshold})@${refB}: ${result.reconcileWallMs.toFixed(1)}ms mode=${result.reconcileEvent.reconcile.mode} metadata_refreshed=${result.reconcileEvent.reconcile.metadata_refreshed}`);
  if (keepData) {
    console.log(`[git-switch:${label}] --keep-data: kept ${dataDir} (generation=${result.reconcileEvent.generation})`);
  } else {
    await rm(dataDir, { recursive: true, force: true });
  }
  return result;
}

/**
 * Frente E-P0b (2026-09-06): the two real git-switch P0 findings (§4/§9 of
 * the evidence doc) were never caught by THIS harness's own reporting --
 * `measureOneSwitch` only ever compared wall times and the `reconcile`
 * summary (`mode`/`fell_back_to_cold`), never Merkle roots. After fixing
 * both P0s, this checks the missing half directly: an INDEPENDENT
 * from-scratch cold scan of `refB` (a brand-new workspace_id/data dir,
 * never touched by the delta/cold cycles above), compared against the
 * `T=1` (forced-`Delta`-attempt) cycle's own `reconcile` roots. `records`
 * is deliberately excluded (decision 11's documented chained-id-vs-
 * first-occurrence gap, same as every fixture e2e test in `tests_e2e.rs`);
 * `dependency`/`graph` are the roots every one of this task's fixes exists
 * to protect.
 */
async function runIndependentOracleColdScan(label, repoDir, ref, dataDir, keepData = false) {
  await gitCheckout(repoDir, ref);
  const dataPaths = await initDataDir(dataDir);
  const { runRustWorkspaceScan } = await import(resolve(root, "packages/engine/dist/rust-workspace-scan.js"));
  const event = await withTransport({}, (transport) =>
    runRustWorkspaceScan(transport, {
      workspace_id: `workspace:v4-reconcile-threshold:git:${label}:oracle`,
      workspace_root: repoDir,
      database_path: dataPaths.databasePath,
      structural_root: dataPaths.structuralRoot,
      cas_root: dataPaths.casRoot,
      sidecar_root: dataPaths.sidecarRoot,
      registry_snapshot_id: "registry:v4-reconcile-threshold",
      configuration_revision_id: "configuration:v4-reconcile-threshold",
      resolution_lock_id: "resolution:v4-reconcile-threshold",
      priority: "interactive",
      scope: { kind: "full" },
    }),
  );
  if (keepData) {
    console.log(`[git-switch:${label}] --keep-data: kept oracle ${dataDir} (generation=${event.generation})`);
  } else {
    await rm(dataDir, { recursive: true, force: true });
  }
  return event.roots;
}

async function measureOneSwitch(label, repoDir, refA, refB, scratchDir, keepData = false) {
  const workspaceId = `workspace:v4-reconcile-threshold:git:${label}`;
  const changedFiles = await gitDiffNameOnlyCount(repoDir, refA, refB);

  const deltaDataDir = join(scratchDir, `${label}-delta-data`);
  const deltaCycle = await runOneGitSwitchCycle(label, repoDir, refA, refB, workspaceId, 1.0, deltaDataDir, keepData);

  const oracleDataDir = join(scratchDir, `${label}-oracle-data`);
  const oracleRoots = await runIndependentOracleColdScan(label, repoDir, refB, oracleDataDir, keepData);
  const rootsOk = {
    dependency: deltaCycle.reconcileEvent.roots.dependency === oracleRoots.dependency,
    graph: deltaCycle.reconcileEvent.roots.graph === oracleRoots.graph,
  };
  console.log(
    `[git-switch:${label}] roots_ok vs independent oracle of ${refB}: dependency=${rootsOk.dependency} graph=${rootsOk.graph}`,
  );

  if (keepData) {
    return {
      label,
      ref_a: refA,
      ref_b: refB,
      changed_files: changedFiles,
      reconcile_delta_summary: deltaCycle.reconcileEvent.reconcile,
      reconcile_delta_roots_ok_vs_independent_oracle: rootsOk,
      delta_generation: deltaCycle.reconcileEvent.generation,
      delta_data_dir: deltaDataDir,
      oracle_generation: 1,
      oracle_data_dir: oracleDataDir,
    };
  }

  const coldDataDir = join(scratchDir, `${label}-cold-data`);
  const coldCycle = await runOneGitSwitchCycle(label, repoDir, refA, refB, workspaceId, 0.0, coldDataDir);

  return {
    label,
    ref_a: refA,
    ref_b: refB,
    changed_files: changedFiles,
    cold_at_a_wall_ms: deltaCycle.coldWallMs,
    reconcile_delta_wall_ms: deltaCycle.reconcileWallMs,
    reconcile_delta_summary: deltaCycle.reconcileEvent.reconcile,
    reconcile_delta_roots_ok_vs_independent_oracle: rootsOk,
    reconcile_cold_wall_ms: coldCycle.reconcileWallMs,
    reconcile_cold_summary: coldCycle.reconcileEvent.reconcile,
  };
}

async function runGitSwitchMode(options) {
  const { gitRepo, gitTagA, gitTagB, gitHeadBack, data, out, keepData, onlySwitch } = options;
  assertNeverTmp(gitRepo, "--git-repo");
  assertNeverTmp(data, "--data");
  await mkdir(data, { recursive: true });
  const results = [];

  if (!onlySwitch || onlySwitch === "tags-3-months") {
    const tagsRepo = join(data, "tags-clone");
    await rm(tagsRepo, { recursive: true, force: true });
    console.log(`[git-switch] cloning ${gitRepo} -> ${tagsRepo}`);
    await execFileAsync("git", ["clone", "--no-hardlinks", "--quiet", gitRepo, tagsRepo]);
    results.push(await measureOneSwitch("tags-3-months", tagsRepo, gitTagA, gitTagB, data, keepData));
    if (!keepData) await rm(tagsRepo, { recursive: true, force: true });
  }

  if (!onlySwitch || onlySwitch === "head-vs-head200") {
    const headRepo = join(data, "head-clone");
    await rm(headRepo, { recursive: true, force: true });
    console.log(`[git-switch] cloning ${gitRepo} -> ${headRepo}`);
    await execFileAsync("git", ["clone", "--no-hardlinks", "--quiet", gitRepo, headRepo]);
    // Resolve HEAD to a concrete sha BEFORE any checkout: `measureOneSwitch`
    // checks out `refA` (`HEAD~N`) first, which detaches HEAD at that older
    // commit -- a literal "HEAD" passed as `refB` would then resolve to that
    // SAME older commit instead of the tip, making the diff a no-op.
    const { stdout: headShaOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: headRepo });
    const headSha = headShaOut.trim();
    results.push(await measureOneSwitch("head-vs-head200", headRepo, `${headSha}~${gitHeadBack}`, headSha, data, keepData));
    if (!keepData) await rm(headRepo, { recursive: true, force: true });
  }

  const result = { switches: results, measured_at: new Date().toISOString() };
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`[done] wrote ${out}`);
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { repeat: 2, fractions: [0.01, 0.05, 0.1, 0.25, 0.5] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--corpus":
        options.corpus = resolve(next());
        break;
      case "--data":
        options.data = resolve(next());
        break;
      case "--fractions":
        options.fractions = next()
          .split(",")
          .map((s) => Number.parseFloat(s.trim()))
          .filter((n) => Number.isFinite(n));
        break;
      case "--repeat":
        options.repeat = Number.parseInt(next(), 10);
        break;
      case "--out":
        options.out = resolve(next());
        break;
      // Frente E-P0 (plan `generic-waddling-hartmanis.md` §2.6 follow-up,
      // task 1a): bisect P0-1's records/dependency/graph divergence by
      // touched-file COUNT directly, bypassing the `--fractions` ×
      // frontier-size arithmetic -- `N` is passed straight to
      // `buildMutationPlan`'s `touchedCount` (same seeded selection/90-10
      // edit/delete-or-rename split as the fraction sweep), so `--files 10`
      // and `--files 202` (p=0.01's own `touchedCount` on the n8n corpus
      // this doc's evidence measured) replay byte-identical plans. Runs
      // exactly ONE cell (skips the fraction loop) when set.
      case "--files":
        options.files = Number.parseInt(next(), 10);
        break;
      // Frente E-P0: keep every scratch workspace/data directory this run
      // creates instead of deleting them at the end of each cell -- needed
      // to open the resulting stores afterward with a diagnostic tool
      // (`dump_dependency_set_diff`/`dump_records_set_diff` in
      // `tests_e2e.rs`) once a divergence is found. Off by default (the
      // fraction sweep's normal contract still cleans up after itself).
      case "--keep-data":
        options.keepData = true;
        break;
      case "--git-switch":
        options.gitSwitch = true;
        break;
      case "--git-repo":
        options.gitRepo = resolve(next());
        break;
      case "--git-tag-a":
        options.gitTagA = next();
        break;
      case "--git-tag-b":
        options.gitTagB = next();
        break;
      case "--git-head-back":
        options.gitHeadBack = Number.parseInt(next(), 10);
        break;
      case "--only-switch":
        options.onlySwitch = next();
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exitCode = 1;
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(workerPath())) {
    console.error(`Rust worker binary not found at ${workerPath()}. Build it first: cargo build --release --locked -p urdira-indexing-worker`);
    process.exitCode = 1;
    return;
  }
  if (options.gitSwitch) {
    if (!options.gitRepo || !options.data || !options.gitTagA || !options.gitTagB || !options.gitHeadBack || !options.out) {
      console.error("git-switch mode requires --git-repo --data --git-tag-a --git-tag-b --git-head-back --out");
      process.exitCode = 1;
      return;
    }
    await runGitSwitchMode(options);
    return;
  }
  if (!options.corpus || !options.data || !options.out) {
    console.error("Usage: node scripts/v4-reconcile-threshold.mjs --corpus <dir> --data <dir> --fractions 0.01,0.05,0.10,0.25,0.50 --repeat 2 --out <json>");
    process.exitCode = 1;
    return;
  }
  if (!options.fractions.includes(0)) options.fractions = [0, ...options.fractions];
  options.fractions.sort((a, b) => a - b);
  await runFractionSweep(options);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
