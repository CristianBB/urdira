#!/usr/bin/env node
/* c8 ignore file -- measurement tool for P3-7 (plan `resilient-knitting-
 * twilight.md` section covering v4 watcher detection latency), exercised by
 * manual runs against a real corpus, not unit-test coverage. */

// Subscribes directly to @parcel/watcher (optionally through this codebase's
// own `ParcelWatcherAdapter`) on a given root with production-identical
// `ignore` globs, performs N timed `write()+fsync()` edits on a
// PRE-SELECTED set of existing files (selection happens BEFORE the timed
// loop starts -- see docs/evidence/2026-09-03-v4-p3-7-watcher-latency.md §1
// for why: the mutation harness's own `applyMutation` re-scans the whole
// corpus and rebuilds an import graph *inside* its own timed window, which
// this probe exists to avoid repeating), and measures the wall-clock gap
// between the write and the watcher callback reporting a matching event.
//
// Usage:
//   node scripts/watch-latency-probe.mjs --root /abs/path --backend kqueue \
//     [--mode raw|adapter] [--n 20] [--spacing-ms 2000] \
//     [--root-mode raw|realpath] [--source-provider core:directory_source_provider]
//
// `--mode raw` (default) subscribes directly via `@parcel/watcher` with the
// same `ignore` list production uses, bypassing this codebase's own
// `normalizedUri`/`ParcelWatcherAdapter` translation layer -- isolates pure
// backend+OS latency and lets raw event paths be inspected for
// canonicalization (symlink) mismatches without risking the adapter's
// unguarded `normalizedUri` throw crashing the process.
//
// `--mode adapter` goes through the real `packages/engine/dist/watchers.js`
// `ParcelWatcherAdapter`/`watcherOptionsForSourceProvider`, reproducing the
// exact production code path (including any throw inside `normalize_events`)
// -- run this mode in its own process (this script already is one) so a
// crash there does not take down an orchestrating script.
//
// `--mode crate` drives the P3-7 spike crate `crates/urdira-fs-watch`
// (built at `target/release/urdira-fs-watch` by default, override with
// `--crate-bin`) as a child process: it subscribes via the `notify` crate
// (FSEvents on macOS) and prints one JSON line per event with its own
// receive-side timestamp, which this mode parses the same way the other
// modes parse in-process event timestamps. `--backend` is ignored in this
// mode (the crate always uses `notify::recommended_watcher`, notify's own
// platform default).

import { writeFileSync, openSync, writeSync, fsyncSync, closeSync, realpathSync, mkdtempSync, existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { mode: "raw", n: 20, spacing_ms: 2000, root_mode: "raw", source_provider: "core:directory_source_provider", timeout_ms: 30000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") out.root = argv[++i];
    else if (arg === "--backend") out.backend = argv[++i];
    else if (arg === "--mode") out.mode = argv[++i];
    else if (arg === "--n") out.n = Number(argv[++i]);
    else if (arg === "--spacing-ms") out.spacing_ms = Number(argv[++i]);
    else if (arg === "--root-mode") out.root_mode = argv[++i];
    else if (arg === "--source-provider") out.source_provider = argv[++i];
    else if (arg === "--timeout-ms") out.timeout_ms = Number(argv[++i]);
    else if (arg === "--use-tmp-root") out.use_tmp_root = true;
    else if (arg === "--crate-bin") out.crate_bin = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.root && !out.use_tmp_root) throw new Error("--root is required (or pass --use-tmp-root to probe a symlinked os.tmpdir() root)");
  if (!out.backend && out.mode !== "crate") throw new Error("--backend is required (kqueue|fs-events|watchman|brute-force)");
  return out;
}

const SOURCE_EXT_RE = /\.(?:mts|cts|tsx|ts|mjs|cjs|jsx|js)$/u;
const SKIP_DIR_SEGMENTS = new Set(["dist", "build", "out", "node_modules", ".git", "coverage", ".urdira"]);

function isCandidateSourcePath(relPath) {
  if (!SOURCE_EXT_RE.test(relPath)) return false;
  return !relPath.split("/").some((segment) => SKIP_DIR_SEGMENTS.has(segment));
}

/** Lists candidate files ONE time, outside any timed window (see module doc). */
async function listCandidateFiles(root, limit) {
  const results = [];
  const visit = async (dir, prefix) => {
    if (results.length >= limit * 20) return; // bounded over-collection; random sample below
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (SKIP_DIR_SEGMENTS.has(entry.name)) continue;
      if (entry.isDirectory()) await visit(join(dir, entry.name), relPath);
      else if (entry.isFile() && isCandidateSourcePath(relPath)) results.push(relPath);
      if (results.length >= limit * 20) return;
    }
  };
  await visit(root, "");
  // Shuffle deterministically-ish and take `limit`.
  for (let i = results.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [results[i], results[j]] = [results[j], results[i]];
  }
  return results.slice(0, limit);
}

function writeAndFsync(absolutePath, content) {
  const fd = openSync(absolutePath, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Ignore list identical to `watcherOptionsForSourceProvider` in
// `packages/engine/src/watchers.ts` for `core:directory_source_provider`
// (DEFAULT_WORKSPACE_INCLUSION.exclude, `.git/**` included since this is not
// the git_worktree provider).
const PRODUCTION_EXCLUDE_GLOBS = ["node_modules/**", ".git/**", "dist/**", "coverage/**", "tests/baselines/**", "tests/cases/**", ".urdira/**"];
function productionIgnoreList() {
  const paths = PRODUCTION_EXCLUDE_GLOBS.map((pattern) => (pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern));
  return [...new Set([...paths, ...PRODUCTION_EXCLUDE_GLOBS])];
}

async function importParcelWatcher() {
  // Not hoisted to the repo root by pnpm; only `packages/engine`'s own
  // `node_modules/@parcel/watcher` symlink resolves it. Try the normal
  // specifier first (works when this script is run with that package as
  // the resolution root), then fall back to the pnpm store path directly.
  try {
    return await import("@parcel/watcher");
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    const fallback = resolve(repoRoot, "packages/engine/node_modules/@parcel/watcher/index.js");
    return await import(pathToFileURL(fallback).href);
  }
}

async function runRawMode(options) {
  // Resolve targets and validate BEFORE subscribing: a native FSEvents/
  // kqueue subscription starts a background thread that keeps the process
  // alive even after an uncaught throw unwinds the JS stack, so validating
  // first (rather than after subscribe()) avoids leaving an orphaned probe
  // process hanging forever on a `--n` too large for the corpus.
  const targets = await listCandidateFiles(options.selectionRoot, options.n);
  if (targets.length < options.n) throw new Error(`Only found ${targets.length} candidate files under ${options.selectionRoot}, need ${options.n}`);

  const watcher = await importParcelWatcher();
  const ignore = productionIgnoreList();
  const watcherOptions = { ignore, backend: options.backend };
  const events = [];
  let subscription;
  const errors = [];
  subscription = await watcher.subscribe(options.watchRoot, (error, evts) => {
    const t = performance.now();
    if (error) { errors.push({ t, message: error.message }); return; }
    for (const e of evts) events.push({ t, type: e.type, path: e.path });
  }, watcherOptions);

  const results = [];
  for (let i = 0; i < options.n; i += 1) {
    const relPath = targets[i];
    const absolute = join(options.selectionRoot, ...relPath.split("/"));
    const expectedAbsoluteViaWatchRoot = join(options.watchRoot, ...relPath.split("/"));
    const marker = `probe-${randomBytes(4).toString("hex")}`;
    const eventsSeenBefore = events.length;
    const t0 = performance.now();
    writeAndFsync(absolute, `// ${marker} ${Date.now()}\n`);
    const deadline = t0 + options.timeout_ms;
    let matched;
    while (performance.now() < deadline) {
      for (let idx = eventsSeenBefore; idx < events.length; idx += 1) {
        const e = events[idx];
        if (e.path === absolute || e.path === expectedAbsoluteViaWatchRoot) { matched = e; break; }
      }
      if (matched) break;
      await delay(2);
    }
    const latencyMs = matched ? matched.t - t0 : undefined;
    results.push({
      index: i,
      rel_path: relPath,
      latency_ms: latencyMs === undefined ? undefined : Math.round(latencyMs * 10) / 10,
      matched: matched !== undefined,
      reported_type: matched?.type,
      reported_path: matched?.path,
      path_exact_match: matched ? matched.path === absolute : undefined,
      // Every raw path actually seen in the window, for diagnosing
      // canonicalization mismatches (e.g. /var vs /private/var) even when
      // no path matched at all.
      all_paths_in_window: events.slice(eventsSeenBefore).map((e) => `${e.type}:${e.path}`),
    });
    if (i < options.n - 1) await delay(options.spacing_ms);
  }
  await subscription.unsubscribe();
  return { results, backend_errors: errors };
}

async function runAdapterMode(options) {
  const targets = await listCandidateFiles(options.selectionRoot, options.n);
  if (targets.length < options.n) throw new Error(`Only found ${targets.length} candidate files under ${options.selectionRoot}, need ${options.n}`);

  const engineModule = await import(pathToFileURL(resolve(repoRoot, "packages/engine/dist/watchers.js")).href);
  const { ParcelWatcherAdapter, watcherOptionsForSourceProvider } = engineModule;
  const watcherOptions = { ...watcherOptionsForSourceProvider(options.source_provider), backend: options.backend };
  const binding = {
    workspace_id: "probe-workspace",
    source_provider_binding_id: "probe-binding",
    source_provider: options.source_provider,
    source_provider_version: "1",
    ordering_domain: "probe",
    root: options.watchRoot,
  };
  const adapterErrors = [];
  const adapter = new ParcelWatcherAdapter(binding, { watcher_options: watcherOptions, on_error: (error) => adapterErrors.push({ t: performance.now(), message: error.message, stack: error.stack }) });
  const batches = [];
  const subscription = await adapter.subscribe((batch) => { batches.push({ t: performance.now(), batch }); });

  const results = [];
  for (let i = 0; i < options.n; i += 1) {
    const relPath = targets[i];
    const absolute = join(options.selectionRoot, ...relPath.split("/"));
    const marker = `probe-${randomBytes(4).toString("hex")}`;
    const seenBefore = batches.length;
    const t0 = performance.now();
    writeAndFsync(absolute, `// ${marker} ${Date.now()}\n`);
    const deadline = t0 + options.timeout_ms;
    let matched;
    while (performance.now() < deadline) {
      for (let idx = seenBefore; idx < batches.length; idx += 1) {
        const hit = batches[idx].batch.events.find((hint) => relPath.endsWith(hint.normalized_uri) || hint.normalized_uri === relPath);
        if (hit) { matched = { t: batches[idx].t, hint: hit }; break; }
      }
      if (matched) break;
      await delay(2);
    }
    results.push({
      index: i,
      rel_path: relPath,
      latency_ms: matched ? Math.round((matched.t - t0) * 10) / 10 : undefined,
      matched: matched !== undefined,
      reported_uri: matched?.hint.normalized_uri,
      reported_class: matched?.hint.event_class,
      adapter_errors_so_far: adapterErrors.length,
    });
    if (i < options.n - 1) await delay(options.spacing_ms);
  }
  await subscription.unsubscribe();
  return { results, adapter_errors: adapterErrors };
}

/**
 * `--mode crate`: spawns `crates/urdira-fs-watch`'s CLI (built via `cargo
 * build -p urdira-fs-watch --release`) and reads its one-JSON-line-per-event
 * stdout. Epoch-ms timestamps from the crate (`SystemTime::now()` since
 * `UNIX_EPOCH`) and from this script (`performance.timeOrigin +
 * performance.now()`) are the same wall-clock family on the same host, so
 * subtracting across processes is valid the same way it already is across
 * the daemon/harness boundary in `deriveTimelineLatencies`
 * (`v4-mutation-harness.mjs`).
 */
async function runCrateMode(options) {
  const targets = await listCandidateFiles(options.selectionRoot, options.n);
  if (targets.length < options.n) throw new Error(`Only found ${targets.length} candidate files under ${options.selectionRoot}, need ${options.n}`);

  const crateBin = options.crate_bin ?? resolve(repoRoot, "target/release/urdira-fs-watch");
  if (!existsSync(crateBin)) throw new Error(`Spike crate binary not found at ${crateBin}. Build it first: cargo build -p urdira-fs-watch --release`);

  const readyMarker = join(options.selectionRoot, `.urdira-fs-watch-ready-${randomBytes(4).toString("hex")}`);
  await rm(readyMarker, { force: true });
  const child = spawn(crateBin, [options.watchRoot, "--ready-marker", readyMarker], { stdio: ["ignore", "pipe", "pipe"] });
  const events = [];
  const stderrLines = [];
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    try {
      const parsed = JSON.parse(line);
      events.push({ t: performance.now(), epoch_ms: parsed.epoch_ms, kind: parsed.kind, paths: parsed.paths ?? [] });
    } catch {
      // Non-JSON stdout noise, if any -- ignored, not fatal.
    }
  });
  createInterface({ input: child.stderr }).on("line", (line) => stderrLines.push(line));
  let childExited;
  child.on("exit", (code, signal) => { childExited = { code, signal }; });

  const readyDeadline = performance.now() + 10_000;
  while (!existsSync(readyMarker) && performance.now() < readyDeadline) {
    if (childExited) throw new Error(`urdira-fs-watch exited before becoming ready (code=${childExited.code} signal=${childExited.signal}): ${stderrLines.join("\n")}`);
    await delay(10);
  }
  if (!existsSync(readyMarker)) throw new Error(`urdira-fs-watch did not become ready within 10s: ${stderrLines.join("\n")}`);
  await rm(readyMarker, { force: true });
  // The receiving-process clock (`epoch_ms` inside the crate) and this
  // script's own `performance.timeOrigin + performance.now()` clock must be
  // converted to the SAME family before comparison; capture the offset once
  // now that the crate is confirmed running, using this process's own
  // Date.now()-equivalent epoch value as the reference point.
  const localEpochAtReady = performance.timeOrigin + performance.now();

  const results = [];
  for (let i = 0; i < options.n; i += 1) {
    const relPath = targets[i];
    const absolute = join(options.selectionRoot, ...relPath.split("/"));
    const marker = `probe-${randomBytes(4).toString("hex")}`;
    const seenBefore = events.length;
    const t0Wall = performance.now();
    const t0Epoch = performance.timeOrigin + t0Wall;
    writeAndFsync(absolute, `// ${marker} ${Date.now()}\n`);
    const deadline = t0Wall + options.timeout_ms;
    let matched;
    while (performance.now() < deadline) {
      for (let idx = seenBefore; idx < events.length; idx += 1) {
        const e = events[idx];
        if (e.paths.some((p) => p === absolute || p.endsWith(`/${relPath}`))) { matched = e; break; }
      }
      if (matched) break;
      await delay(2);
    }
    results.push({
      index: i,
      rel_path: relPath,
      latency_ms: matched ? Math.round((matched.epoch_ms - t0Epoch) * 10) / 10 : undefined,
      matched: matched !== undefined,
      reported_kind: matched?.kind,
      reported_paths: matched?.paths,
      all_events_in_window: events.slice(seenBefore).map((e) => `${e.kind}:${JSON.stringify(e.paths)}`),
    });
    if (i < options.n - 1) await delay(options.spacing_ms);
  }
  child.kill();
  return { results, backend_errors: stderrLines.map((message) => ({ message })), local_epoch_at_ready: localEpochAtReady };
}

function percentile(values, p) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let watchRoot = options.root;
  if (options.use_tmp_root) {
    const base = mkdtempSync(join(tmpdir(), "urdira-watch-probe-"));
    watchRoot = base;
  }
  await mkdir(watchRoot, { recursive: true });
  if (options.use_tmp_root) {
    // Seed candidate files: `--use-tmp-root` starts from an empty
    // `mkdtemp()` directory.
    for (let i = 0; i < options.n; i += 1) writeFileSync(join(watchRoot, `seed-${i}.ts`), `export const seed${i} = ${i};\n`);
    // Let the filesystem settle so these seed writes are not mistaken for
    // the timed edits below (FSEvents can replay a just-created directory's
    // own recent history once a stream starts -- see the module doc).
    await delay(500);
  }

  const realRoot = realpathSync(watchRoot);
  const rootDiffersFromReal = realRoot !== resolve(watchRoot);
  const effectiveRoot = options.root_mode === "realpath" ? realRoot : resolve(watchRoot);

  console.error(`[probe] backend=${options.backend} mode=${options.mode} root_mode=${options.root_mode}`);
  console.error(`[probe] raw root:  ${resolve(watchRoot)}`);
  console.error(`[probe] real root: ${realRoot}`);
  console.error(`[probe] root has symlink component: ${rootDiffersFromReal}`);
  console.error(`[probe] effective (subscribed) root: ${effectiveRoot}`);

  // `selectionRoot` is always the REAL path on disk (files must be found and
  // written through a path that actually resolves); `watchRoot` passed to
  // the backend is `effectiveRoot` per `--root-mode`, which may differ.
  const outcome = options.mode === "adapter"
    ? await runAdapterMode({ ...options, watchRoot: effectiveRoot, selectionRoot: realRoot })
    : options.mode === "crate"
      ? await runCrateMode({ ...options, watchRoot: effectiveRoot, selectionRoot: realRoot })
      : await runRawMode({ ...options, watchRoot: effectiveRoot, selectionRoot: realRoot });

  const latencies = outcome.results.filter((r) => r.latency_ms !== undefined).map((r) => r.latency_ms);
  const matchedCount = outcome.results.filter((r) => r.matched).length;
  const summary = {
    root: resolve(watchRoot),
    real_root: realRoot,
    root_has_symlink_component: rootDiffersFromReal,
    effective_root: effectiveRoot,
    backend: options.backend,
    mode: options.mode,
    n: options.n,
    matched: matchedCount,
    missed: options.n - matchedCount,
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    min_ms: latencies.length ? Math.min(...latencies) : undefined,
    max_ms: latencies.length ? Math.max(...latencies) : undefined,
    errors: outcome.backend_errors ?? outcome.adapter_errors ?? [],
    results: outcome.results,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (matchedCount < options.n) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`[probe] FATAL: ${error?.stack ?? error}`);
    process.exitCode = 2;
  })
  .finally(() => {
    // A native FSEvents/kqueue subscription runs on its own background
    // thread; if this script is done reporting but somehow left a
    // subscription un-unsubscribed (an early throw, an unmatched-event
    // early return), the process would otherwise hang forever instead of
    // exiting with its already-computed exit code.
    process.exit(process.exitCode ?? 0);
  });
