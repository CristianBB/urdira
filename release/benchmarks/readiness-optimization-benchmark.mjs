#!/usr/bin/env node
/* global TextEncoder, URL, Buffer, setTimeout, clearTimeout */
/*
 * Controlled readiness experiments. These are deliberately small, local
 * microbenchmarks: they compare the current durable implementations and
 * candidate write paths without changing the production contracts.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { ContentAddressedStore, openSqliteDatabase } from "../../packages/storage/dist/index.js";
import { analyzeProject, createJavascriptTypescriptWorker } from "../../packages/plugin-javascript-typescript/dist/index.js";

const execFileAsync = promisify(execFile);
const ROWS = Number(process.env["URDIRA_READINESS_BENCH_ROWS"] ?? 5_000);
const FILES = Number(process.env["URDIRA_READINESS_BENCH_FILES"] ?? 160);
const now = () => performance.now();
const elapsed = async (action) => { const started = now(); const value = await action(); return { value, ms: Math.round(now() - started) }; };
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const bytes = (index, size = 4096) => new TextEncoder().encode(`${String(index).padStart(8, "0")} ${"x".repeat(Math.max(0, size - 9))}`);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

async function repeat(action, count = 3) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const value = await action();
    samples.push(typeof value === "number" ? value : value.ms);
  }
  return { samples_ms: samples, median_ms: median(samples) };
}

async function casBatch(root, entries, platform = process.platform) {
  let directorySyncs = 0;
  let fileSyncs = 0;
  const store = new ContentAddressedStore(root, undefined, {
    platform,
    sync_directory: async () => { directorySyncs += 1; },
    sync_file: async () => { fileSyncs += 1; },
  });
  const result = await elapsed(() => store.putMany(entries.map((value) => ({ bytes: value }))));
  return { ms: result.ms, directory_syncs: directorySyncs, file_syncs: fileSyncs };
}

// Experimental pack candidate: one append-only immutable pack per batch plus
// an in-memory digest/offset index. It is intentionally isolated from the
// production CAS contract so the benchmark measures whether pack framing can
// beat one-file-per-object before we commit to a durable pack index/GC design.
async function packCasBatch(root, entries) {
  await mkdir(root, { recursive: true });
  const unique = new Map();
  const result = await elapsed(async () => {
    const path = join(root, "batch.pack");
    const handle = await open(path, "w", 0o600);
    let offset = 0;
    try {
      for (const value of entries) {
        const digest = sha256(value);
        if (unique.has(digest)) continue;
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(value.byteLength, 0);
        await handle.write(header);
        await handle.write(value);
        unique.set(digest, { offset, byte_length: value.byteLength });
        offset += header.byteLength + value.byteLength;
      }
      await handle.sync();
    } finally { await handle.close(); }
  });
  return { ms: result.ms, unique_objects: unique.size, pack_bytes: [...unique.values()].reduce((sum, item) => sum + 4 + item.byte_length, 0) };
}

async function runCasExperiments(root) {
  const values = Array.from({ length: 128 }, (_, i) => bytes(i));
  const sequential = await elapsed(async () => {
    const store = new ContentAddressedStore(join(root, "sequential"), undefined, { platform: "darwin", sync_directory: async () => {} });
    for (const value of values) await store.put(value);
  });
  const batched = await casBatch(join(root, "batched"), values, "darwin");
  const duplicateEntries = values.slice(0, 32).flatMap((value) => [value, value, value, value]);
  const duplicate = await casBatch(join(root, "duplicates"), duplicateEntries, "darwin");
  const deduped = await casBatch(join(root, "deduped"), values.slice(0, 32), "darwin");
  const concurrency = {};
  for (const level of [8, 16, 32, 64]) {
    const started = now();
    const store = new ContentAddressedStore(join(root, `concurrency-${level}`), undefined, { platform: "darwin", put_concurrency: level, sync_directory: async () => {} });
    await store.putMany(values.map((value) => ({ bytes: value })));
    concurrency[level] = Math.round(now() - started);
  }
  const pack = await packCasBatch(join(root, "pack-candidate"), values);
  return { pack_small_files: { sequential_ms: sequential.ms, batched_ms: batched.ms, speedup: Number((sequential.ms / Math.max(1, batched.ms)).toFixed(2)), batched_fsyncs: batched.directory_syncs + batched.file_syncs }, duplicate_staging: { duplicate_ms: duplicate.ms, deduped_ms: deduped.ms, duplicate_fsyncs: duplicate.directory_syncs + duplicate.file_syncs, deduped_fsyncs: deduped.directory_syncs + deduped.file_syncs }, cas_concurrency_ms: concurrency, pack_cas_candidate: pack };
}

function insertCommands(rows, table = "items") {
  return Array.from({ length: rows }, (_, i) => ({ kind: "run", sql: `INSERT INTO ${table}(id,payload) VALUES (?,?)`, params: [`id-${i}`, `payload-${i}-${"x".repeat(24)}`] }));
}

async function sqliteVariant(root, mode) {
  await mkdir(root, { recursive: true });
  const filename = join(root, `${mode}-${randomUUID()}.db`);
  const db = await openSqliteDatabase({ filename });
  try {
    await db.exec("CREATE TABLE items(id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
    const commands = insertCommands(ROWS);
    const result = mode === "transaction" ? await elapsed(() => db.transaction(commands)) : await elapsed(() => db.transactionChunked(commands, Number(mode), { discard_results: true }));
    return result.ms;
  } finally { await db.close(); }
}

async function runSqliteExperiments(root) {
  const modes = ["transaction", "500", "2000", "8000"];
  const values = {};
  for (const mode of modes) values[mode] = await repeat(() => sqliteVariant(root, mode), 2);
  return { rows: ROWS, variants: values };
}

async function runDeferredIndexExperiment(root) {
  await mkdir(root, { recursive: true });
  const indexed = async (defer) => {
    const db = await openSqliteDatabase({ filename: join(root, `${defer ? "deferred" : "eager"}.db`) });
    try {
      await db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, key TEXT NOT NULL, payload TEXT NOT NULL)");
      if (!defer) await db.exec("CREATE INDEX items_key ON items(key)");
      const insert = await elapsed(() => db.transactionChunked(Array.from({ length: ROWS }, (_, i) => ({ kind: "run", sql: "INSERT INTO items(id,key,payload) VALUES (?,?,?)", params: [i, `k-${i % 997}`, `payload-${i}`] })), 2_000, { discard_results: true }));
      const build = defer ? await elapsed(() => db.exec("CREATE INDEX items_key ON items(key)")) : { ms: 0 };
      return { insert_ms: insert.ms, secondary_index_ms: build.ms, total_ms: insert.ms + build.ms };
    } finally { await db.close(); }
  };
  return { rows: ROWS, eager: await indexed(false), deferred: await indexed(true) };
}

function makeFiles(count = FILES) {
  return Array.from({ length: count }, (_, i) => ({ path: `pkg-${i % 8}/file-${i}.ts`, text: `export const value${i} = ${i};\nexport function f${i}(x: number) { return x + value${i}; }\n` }));
}

async function runParallelAnalysisExperiment() {
  const files = makeFiles();
  const groups = Array.from({ length: 8 }, (_, group) => files.filter((file) => file.path.startsWith(`pkg-${group}/`)));
  const pluginUrl = new URL("../../packages/plugin-javascript-typescript/dist/index.js", import.meta.url).href;
  const serial = await elapsed(async () => { for (const group of groups) analyzeProject({ files: group }); });
  const parallel = await elapsed(() => Promise.all(groups.map((group) => new Promise((resolve, reject) => {
    const worker = new Worker(`import { parentPort, workerData } from 'node:worker_threads'; import { analyzeProject } from ${JSON.stringify(pluginUrl)}; analyzeProject({ files: workerData }); parentPort.postMessage(true);`, { eval: true, workerData: group });
    worker.once("message", () => { worker.terminate().then(resolve, reject); }); worker.once("error", reject);
  }))));
  return { files: files.length, packages: groups.length, serial_ms: serial.ms, parallel_ms: parallel.ms, speedup: Number((serial.ms / Math.max(1, parallel.ms)).toFixed(2)) };
}

function request(call, payload, id) {
  return { protocol_version: 1, request_id: id, request_digest: sha256(`${id}:${call}`), call, payload };
}

async function runDigestReuseExperiment(root) {
  const files = makeFiles(48);
  const cache = join(root, "analysis-cache");
  const firstWorker = createJavascriptTypescriptWorker({ analysis_cache_dir: cache, analysis_cache_max_entries: 16 });
  const first = await elapsed(() => firstWorker.invoke(request("analyze_closure", { files, root_names: files.map((file) => file.path) }, "first")));
  await firstWorker.terminate();
  const secondWorker = createJavascriptTypescriptWorker({ analysis_cache_dir: cache, analysis_cache_max_entries: 16 });
  const second = await elapsed(() => secondWorker.invoke(request("analyze_closure", { files, root_names: files.map((file) => file.path) }, "second")));
  await secondWorker.terminate();
  return { first_build_ms: first.ms, second_digest_reuse_ms: second.ms, speedup: Number((first.ms / Math.max(1, second.ms)).toFixed(2)) };
}

async function appendOnly(root) {
  await mkdir(root, { recursive: true });
  const path = join(root, "staging.jsonl");
  const payload = Array.from({ length: ROWS }, (_, i) => JSON.stringify({ id: i, value: `payload-${i}` }) + "\n").join("");
  const write = await elapsed(async () => { const handle = await open(path, "a", 0o600); try { await handle.write(payload); await handle.sync(); } finally { await handle.close(); } });
  const read = await elapsed(async () => (await readFile(path, "utf8")).trim().split("\n").length);
  return { write_ms: write.ms, read_ms: read.ms, bytes: Buffer.byteLength(payload), rows: read.value };
}

async function sqliteStaging(root) {
  await mkdir(root, { recursive: true });
  const db = await openSqliteDatabase({ filename: join(root, "staging.db") });
  try {
    await db.exec("CREATE TABLE staging(id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const write = await elapsed(() => db.transactionChunked(Array.from({ length: ROWS }, (_, i) => ({ kind: "run", sql: "INSERT INTO staging(id,value) VALUES (?,?)", params: [i, `payload-${i}`] })), 2_000, { discard_results: true }));
    const read = await elapsed(() => db.all("SELECT COUNT(*) AS count FROM staging"));
    return { write_ms: write.ms, read_ms: read.ms, rows: Number(read.value[0]?.count ?? 0) };
  } finally { await db.close(); }
}

async function redisStaging() {
  const port = 6390 + (process.pid % 100);
  let server;
  try {
    server = spawn("redis-server", ["--save", "", "--appendonly", "no", "--port", String(port), "--daemonize", "yes"], { stdio: "ignore" });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("redis startup timeout")), 5_000); const poll = async () => { try { await execFileAsync("redis-cli", ["-p", String(port), "PING"]); clearTimeout(timer); resolve(); } catch { setTimeout(poll, 50); } }; poll(); });
    const payload = Array.from({ length: ROWS }, (_, i) => `*3\r\n$3\r\nSET\r\n$${String(i).length + 3}\r\nid-${i}\r\n$${String(i).length + 8}\r\npayload-${i}\r\n`).join("");
    const write = await elapsed(() => new Promise((resolve, reject) => {
      const child = spawn("redis-cli", ["-p", String(port), "--pipe"], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("close", async (code) => {
        if (code === 0) { resolve({ stdout: "" }); return; }
        // macOS redis-cli can report a signal after the final pipeline reply
        // even though Redis committed the batch; accept that only when the
        // server is still reachable, otherwise retain the real failure.
        try { await execFileAsync("redis-cli", ["-p", String(port), "PING"]); resolve({ stdout: "" }); }
        catch { reject(new Error(`redis-cli --pipe exited ${code}: ${stderr}`)); }
      });
      child.stdin.end(payload);
    }));
    const read = await elapsed(() => execFileAsync("redis-cli", ["-p", String(port), "DBSIZE"]));
    return { available: true, write_ms: write.ms, read_ms: read.ms, rows: Number(read.value.stdout.trim()) };
  } catch (error) { return { available: false, reason: error instanceof Error ? error.message : String(error) }; }
  finally { try { await execFileAsync("redis-cli", ["-p", String(port), "shutdown", "nosave"]); } catch { /* already stopped or unavailable */ } if (server) server.kill("SIGTERM"); }
}

async function runStagingExperiment(root) {
  return { rows: ROWS, append_only: await appendOnly(root), sqlite: await sqliteStaging(root), redis: await redisStaging() };
}

const root = await mkdtemp(join(tmpdir(), "urdira-readiness-"));
try {
  const started = now();
  const result = { generated_at: new Date().toISOString(), node: process.version, rows: ROWS, files: FILES, experiments: {
    ...(await runCasExperiments(join(root, "cas"))),
    sqlite_inserts: await runSqliteExperiments(join(root, "sqlite")),
    deferred_secondary_indexes: await runDeferredIndexExperiment(join(root, "indexes")),
    parallel_tsconfig_packages: await runParallelAnalysisExperiment(),
    digest_reuse: await runDigestReuseExperiment(join(root, "digest")),
    staging_comparison: await runStagingExperiment(join(root, "staging")),
  }, total_ms: Math.round(now() - started) };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally { await rm(root, { recursive: true, force: true }); }
