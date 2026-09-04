#!/usr/bin/env node
// v4 plan P2-5: converts a v3 workspace SQLite database into a native
// structural store directory, so the native `CanonicalQuerySnapshotPort`
// can be tested against real indexed fixtures before the v4 Rust cold
// pipeline exists. Thin CLI wrapper over
// `packages/engine/src/native-store-convert.ts`'s `convertV3WorkspaceToNativeStore`.
//
// Usage:
//   node scripts/convert-v3-to-native-store.mjs <db-path> <workspace-id> <out-dir> [generation] [--set-meta]
//
// `generation` defaults to the workspace's `workspace_current_state.current_generation`.
// `--set-meta` additionally writes `workspace_meta.structural_store = "native"`
// into the source database (so the daemon itself picks the native port on
// next open) -- omitted by default.

import { resolve } from "node:path";
import { URL, pathToFileURL } from "node:url";

const [, , dbPath, workspaceId, outDir, maybeGeneration, maybeFlag] = process.argv;
if (!dbPath || !workspaceId || !outDir) {
  console.error("usage: convert-v3-to-native-store.mjs <db-path> <workspace-id> <out-dir> [generation] [--set-meta]");
  process.exit(1);
}
const setMeta = process.argv.includes("--set-meta");
const explicitGeneration = maybeGeneration !== undefined && maybeGeneration !== "--set-meta" ? Number(maybeGeneration) : undefined;
if (explicitGeneration !== undefined && !Number.isSafeInteger(explicitGeneration)) {
  console.error(`invalid generation: ${maybeGeneration}`);
  process.exit(1);
}
void maybeFlag;

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const { openSqliteDatabase } = await import(pathToFileURL(resolve(rootDir, "packages/storage/dist/index.js")));
const { convertV3WorkspaceToNativeStore } = await import(pathToFileURL(resolve(rootDir, "packages/engine/dist/index.js")));

const database = await openSqliteDatabase({ filename: resolve(dbPath) });
try {
  let generation = explicitGeneration;
  if (generation === undefined) {
    const current = await database.get("SELECT current_generation FROM workspace_current_state WHERE workspace_id = ?", [workspaceId]);
    if (current === undefined) throw new Error(`workspace ${workspaceId} has no workspace_current_state row; pass generation explicitly.`);
    generation = current.current_generation;
  }
  const started = Date.now();
  const result = await convertV3WorkspaceToNativeStore(database, workspaceId, generation, resolve(outDir), { setStructuralStoreMeta: setMeta });
  const elapsedMs = Date.now() - started;
  console.error(`[convert] workspace=${workspaceId} generation=${generation} records=${result.recordCount} dependencies=${result.dependencyCount} elapsed=${elapsedMs}ms`);
  console.error(`[convert] records_root=${result.recordsRoot} dependency_root=${result.dependencyRoot}`);
  console.error(`[convert] wrote ${resolve(outDir)}${setMeta ? " (workspace_meta.structural_store set to 'native')" : ""}`);
} finally {
  await database.close();
}
