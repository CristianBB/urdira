#!/usr/bin/env node
// Dev/measurement harness for the v4 cold-scan pipeline (task P2-2b, plan
// `resilient-knitting-twilight.md` §6.1). Creates a fresh v4 catalog SQLite
// (schema + workspace_meta stamped for index_contract 0x34/identity_format
// 3/structural_store=native), spawns the Rust `urdira-indexing-worker`
// binary, sends one `workspace_scan{scope: Full}` command via
// `runRustWorkspaceScan`, and prints the resulting timings and
// store/manifest paths. This is the harness for the P2 gate until the
// daemon itself is wired to send `WorkspaceScan` (plan §9's cutover, out of
// this task's scope).
//
// Usage: node scripts/v4-scan.mjs <workspaceRoot> <dataDir> [--force]
//   workspaceRoot: absolute or relative path to the source tree to scan.
//   dataDir: a NEW or EMPTY directory (never /tmp) that will hold
//     workspace.sqlite, structural/, cas/, sidecar/. Pass --force to wipe an
//     existing non-empty dataDir first (destructive; confirmed by the flag
//     itself, not interactively -- this is a dev/bench tool).
// Env:
//   URDIRA_INDEXING_CORE_WORKER_PATH: path to the `urdira-indexing-worker`
//     binary. Defaults to `target/release/urdira-indexing-worker` (the raw
//     `cargo build --release -p urdira-indexing-worker` output) relative to
//     the repo root.

import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const [workspaceRootArg, dataDirArg] = positional;
  if (workspaceRootArg === undefined || dataDirArg === undefined) {
    console.error("Usage: node scripts/v4-scan.mjs <workspaceRoot> <dataDir> [--force]");
    process.exitCode = 1;
    return;
  }
  const workspaceRoot = isAbsolute(workspaceRootArg) ? workspaceRootArg : resolve(process.cwd(), workspaceRootArg);
  const dataDir = isAbsolute(dataDirArg) ? dataDirArg : resolve(process.cwd(), dataDirArg);
  if (!existsSync(workspaceRoot)) {
    console.error(`workspaceRoot does not exist: ${workspaceRoot}`);
    process.exitCode = 1;
    return;
  }
  if (dataDir === "/tmp" || dataDir.startsWith("/tmp/")) {
    console.error("dataDir must never be under /tmp (plan §11's measurement rule).");
    process.exitCode = 1;
    return;
  }
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0) {
    if (!force) {
      console.error(`dataDir is not empty: ${dataDir} (pass --force to wipe it first).`);
      process.exitCode = 1;
      return;
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
  mkdirSync(dataDir, { recursive: true });

  const databasePath = resolve(dataDir, "workspace.sqlite");
  const structuralRoot = resolve(dataDir, "structural");
  const casRoot = resolve(dataDir, "cas");
  const sidecarRoot = resolve(dataDir, "sidecar");
  mkdirSync(casRoot, { recursive: true });
  mkdirSync(sidecarRoot, { recursive: true });

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

  const workerPath =
    process.env["URDIRA_INDEXING_CORE_WORKER_PATH"] ?? resolve(root, "target/release/urdira-indexing-worker");
  if (!existsSync(workerPath)) {
    console.error(
      `Rust indexing-core worker binary not found at ${workerPath}. Build it first: cargo build --release -p urdira-indexing-worker (or set URDIRA_INDEXING_CORE_WORKER_PATH).`,
    );
    process.exitCode = 1;
    return;
  }

  const { createIndexingCoreProcessTransport } = await import(
    resolve(root, "packages/plugin-javascript-typescript/dist/indexing-core-process-transport.js")
  );
  const { runRustWorkspaceScan } = await import(resolve(root, "packages/engine/dist/rust-workspace-scan.js"));

  const transport = createIndexingCoreProcessTransport({ command: workerPath, request_timeout_ms: 3_600_000 });
  const workspaceId = `workspace:v4-scan-cli:${Buffer.from(workspaceRoot).toString("hex").slice(0, 16)}`;
  try {
    console.log(`workspace_root=${workspaceRoot}`);
    console.log(`data_dir=${dataDir}`);
    const outcome = await runRustWorkspaceScan(transport, {
      workspace_id: workspaceId,
      workspace_root: workspaceRoot,
      database_path: databasePath,
      structural_root: structuralRoot,
      cas_root: casRoot,
      sidecar_root: sidecarRoot,
      scope: { kind: "full" },
      registry_snapshot_id: "registry:v4-scan-cli",
      configuration_revision_id: "configuration:v4-scan-cli",
      resolution_lock_id: "resolution:v4-scan-cli",
      priority: "interactive",
    });
    console.log("");
    console.log(`generation=${outcome.generation}`);
    console.log(`snapshot_id=${outcome.snapshot_id}`);
    console.log(`queryable_at_ms=${outcome.queryable_at_ms ?? "n/a"}`);
    console.log(`completed_at_ms=${outcome.completed_at_ms}`);
    console.log(`roots=${JSON.stringify(outcome.roots)}`);
    console.log(`timings=${JSON.stringify(outcome.timings)}`);
    console.log(`structural_root=${structuralRoot}`);
    console.log(`manifest_path=${outcome.queryable?.manifest_path ?? resolve(structuralRoot, "MANIFEST")}`);
  } finally {
    await transport.shutdown().catch(() => {});
    await transport.terminate();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
