#!/usr/bin/env node
/* c8 ignore file -- this measurement harness is exercised by its own
 * dedicated tests/v4-mutation-harness.test.ts and by explicit v4 gate runs
 * against a real corpus (plan `resilient-knitting-twilight.md` §10 P3-4),
 * not by the unit-test coverage corpus. */

// Drives a v4 (`URDIRA_V4=1`) workspace through the daemon while applying
// one filesystem mutation at a time (edit / create / delete / rename /
// hub_edit), measuring how long the daemon takes to report the mutation
// queryable (`structural_queryable_generation` advances) and durable
// (`structural_durable_generation` advances), and then -- as an oracle --
// runs a from-scratch cold scan of the mutated corpus (via
// `scripts/v4-scan.mjs`, a separate worker process into a fresh data dir)
// and compares its `MANIFEST.roots` against the incrementally-updated
// workspace's own `MANIFEST.roots`.
//
// Today (P3-1 not yet implemented) `ScanScope::Changed` is rejected by the
// worker and the daemon retries with `Full` (see
// `docs/evidence/2026-09-02-v4-p2-7-daemon-wiring.md` §6/§8): every
// mutation therefore republishes a brand-new `base-<generation>` with an
// empty `deltas` array. This harness detects that ("fallback_full") from
// the published MANIFEST shape itself (not from the daemon's one-time,
// deduplicated warning log line) so it keeps reporting the fact correctly
// for every mutation, not just the first.
//
// Usage:
//   node scripts/v4-mutation-harness.mjs --v4 \
//     --corpus /abs/path/to/corpus --native-root /abs/path/to/native \
//     --output /abs/path/to/report.json [--owners N] [--data-root /abs/dir] \
//     [--verify-roots each|final] [--mutation-kinds edit,create,delete,rename,hub_edit] \
//     [--repeat N] [--readiness-timeout-ms MS] [--poll-interval-ms MS] \
//     [--readiness poll|events] [--hub-min-importers N] [--warm N]

import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, opendir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix as pathPosix, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { computeNativeAccelerationCorpusDigest } from "./native-acceleration-controller.mjs";
import { createSlice, prepareNativeRoot } from "./indexing-structural-preflight.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// P3-2 hard rule: the shared n8n benchmark corpus
// (~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02) must
// NEVER be mutated in place. A previous agent session did exactly that (8
// files had to be restored from a known-good upstream checkout). This
// harness already copies `--corpus` into a fresh temp directory before
// applying any mutation (see `run()`'s `cp`/`createSlice` call), so the
// documented incident was never this script's own doing -- but the guard
// below makes that invariant explicit and load-bearing rather than
// incidental: any directory carrying the sentinel file is refused as a
// mutation target outright, and the scratch copy is rooted under the
// mandated benchmark scratch directory (never the OS temp dir) whenever the
// source corpus is marked read-only.
// ---------------------------------------------------------------------------
const SHARED_CORPUS_MARKER = ".urdira-shared-corpus-readonly";
const MANDATED_SCRATCH_ROOT = join(homedir(), "Proyectos", "urdira-benchmark", "v4-p3");

function isProtectedReadonlyCorpus(dir) {
  return existsSync(join(dir, SHARED_CORPUS_MARKER));
}

function assertMutable(dir, context) {
  if (isProtectedReadonlyCorpus(dir)) {
    throw new Error(`Refusing to ${context} inside ${dir}: it carries ${SHARED_CORPUS_MARKER} (shared, read-only corpus). Copy it to a scratch directory first.`);
  }
}

// ---------------------------------------------------------------------------
// Mutation kinds
// ---------------------------------------------------------------------------

const SOURCE_EXT_RE = /\.(?:mts|cts|tsx|ts|mjs|cjs|jsx|js)$/u;
const DECLARATION_RE = /\.d\.[cm]?ts$/u;
const SKIP_DIR_SEGMENTS = new Set(["dist", "build", "out", "node_modules", ".git"]);
const IMPORT_SPECIFIER_RE = /\bfrom\s*["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)|\bimport\(\s*["']([^"']+)["']\s*\)|^[ \t]*import\s*["']([^"']+)["']\s*;?/gmu;

export const KIND_VARIANTS = Object.freeze({
  edit: Object.freeze(["edit"]),
  create: Object.freeze(["create"]),
  delete: Object.freeze(["delete_leaf", "delete_with_importers"]),
  rename: Object.freeze(["rename_no_rewrite", "rename_rewrite"]),
  hub_edit: Object.freeze(["hub_edit"]),
});

export function expandKindSequence(kinds, repeat) {
  const sequence = [];
  for (let round = 0; round < repeat; round += 1) {
    for (const kind of kinds) {
      const variants = KIND_VARIANTS[kind];
      if (variants === undefined) throw new Error(`Unknown mutation kind: ${kind}`);
      for (const variant of variants) sequence.push({ kind, variant });
    }
  }
  return sequence;
}

function isCandidateSourcePath(relPath) {
  if (!SOURCE_EXT_RE.test(relPath) || DECLARATION_RE.test(relPath)) return false;
  return !relPath.split("/").some((segment) => SKIP_DIR_SEGMENTS.has(segment));
}

async function listRepoFiles(root, excludedPaths) {
  const results = [];
  const visit = async (dir, prefix) => {
    const handle = await opendir(dir);
    const names = [];
    for await (const entry of handle) names.push(entry.name);
    names.sort();
    for (const name of names) {
      const relPath = prefix === "" ? name : `${prefix}/${name}`;
      if (excludedPaths.some((excluded) => relPath === excluded || relPath.startsWith(`${excluded}/`))) continue;
      const absolute = join(dir, name);
      const info = await lstat(absolute);
      if (info.isDirectory()) await visit(absolute, relPath);
      else if (info.isFile()) results.push(relPath);
    }
  };
  await visit(root, "");
  results.sort();
  return results;
}

function extractSpecifiers(content) {
  const specifiers = [];
  for (const match of content.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier !== undefined) specifiers.push({ specifier });
  }
  return specifiers;
}

function resolveRelativeSpecifier(importerRelPath, specifier, existingSet) {
  if (!specifier.startsWith(".")) return undefined;
  const importerDir = pathPosix.dirname(importerRelPath);
  const joined = pathPosix.normalize(pathPosix.join(importerDir, specifier));
  const swapped = joined.replace(/\.(?:m|c)?jsx?$/u, "");
  const candidates = [joined];
  for (const ext of [".ts", ".tsx", ".mts", ".cts"]) candidates.push(`${swapped}${ext}`);
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]) candidates.push(`${joined}${ext}`);
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) candidates.push(`${joined}/index${ext}`);
  return candidates.find((candidate) => existingSet.has(candidate));
}

async function buildImportGraph(root, sourceRelPaths) {
  const existingSet = new Set(sourceRelPaths);
  const importersOf = new Map();
  const specifiersIn = new Map();
  for (const relPath of sourceRelPaths) {
    const content = await readFile(resolve(root, ...relPath.split("/")), "utf8");
    const specifiers = extractSpecifiers(content).map((entry) => ({ ...entry, resolvedTarget: resolveRelativeSpecifier(relPath, entry.specifier, existingSet) }));
    specifiersIn.set(relPath, specifiers);
    for (const entry of specifiers) {
      if (entry.resolvedTarget === undefined) continue;
      if (!importersOf.has(entry.resolvedTarget)) importersOf.set(entry.resolvedTarget, new Set());
      importersOf.get(entry.resolvedTarget).add(relPath);
    }
  }
  return { importersOf, specifiersIn };
}

function detectSpecifierStyle(specifiersIn) {
  let jsStyle = 0;
  let bareStyle = 0;
  for (const specs of specifiersIn.values()) {
    for (const spec of specs) {
      if (spec.resolvedTarget === undefined || !spec.specifier.startsWith(".")) continue;
      if (/\.(?:m|c)?jsx?$/u.test(spec.specifier)) jsStyle += 1;
      else bareStyle += 1;
    }
  }
  return jsStyle >= bareStyle ? "js" : "bare";
}

function pickBy(list, predicate, errorMessage) {
  const match = list.find(predicate);
  if (match === undefined) throw new Error(errorMessage);
  return match;
}

function renamedPathFor(relPath, marker) {
  const ext = pathPosix.extname(relPath);
  const stem = relPath.slice(0, relPath.length - ext.length);
  return `${stem}.urdira-renamed-${marker}${ext}`;
}

function rewrittenSpecifier(oldSpecifier, marker) {
  const match = oldSpecifier.match(/\.(?:m|c)?jsx?$/u);
  if (match !== null) return `${oldSpecifier.slice(0, -match[0].length)}.urdira-renamed-${marker}${match[0]}`;
  return `${oldSpecifier}.urdira-renamed-${marker}`;
}

function replaceSpecifierLiteral(content, oldSpecifier, newSpecifier) {
  return content.split(`"${oldSpecifier}"`).join(`"${newSpecifier}"`).split(`'${oldSpecifier}'`).join(`'${newSpecifier}'`);
}

async function applyEditFile(root, relPath, marker, tag) {
  const absolute = resolve(root, ...relPath.split("/"));
  const before = await readFile(absolute, "utf8");
  const functionName = `urdiraHarness${tag}_${marker}`;
  const after = `${before}${before.endsWith("\n") ? "" : "\n"}\nexport function ${functionName}() {\n  return ${JSON.stringify(marker)};\n}\n${functionName}();\n`;
  await writeFile(absolute, after);
}

async function applyCreateFile(root, importFromPath, marker, allPaths, specifierStyle) {
  const dirForNewFile = pathPosix.dirname(importFromPath);
  const newExt = /\.tsx?$|\.[mc]ts$/u.test(importFromPath) ? ".ts" : ".js";
  const existingSet = new Set(allPaths);
  const namePrefix = dirForNewFile === "." ? "" : `${dirForNewFile}/`;
  let candidate = `${namePrefix}urdira-harness-created-${marker}${newExt}`;
  let suffix = 2;
  while (existingSet.has(candidate)) {
    candidate = `${namePrefix}urdira-harness-created-${marker}-${suffix}${newExt}`;
    suffix += 1;
  }
  const importFromExt = pathPosix.extname(importFromPath);
  const importFromStem = importFromPath.slice(0, importFromPath.length - importFromExt.length);
  let specifier = pathPosix.relative(dirForNewFile, importFromStem);
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  if (specifierStyle === "js") specifier = `${specifier}.js`;
  const bindingName = `urdiraHarnessImported_${marker}`;
  const content = `import * as ${bindingName} from ${JSON.stringify(specifier)};\nexport function urdiraHarnessCreated_${marker}() {\n  return typeof ${bindingName};\n}\n`;
  await writeFile(resolve(root, ...candidate.split("/")), content, { flag: "wx" });
  return { path: candidate, specifier };
}

/**
 * Applies exactly one mutation `variant` against the corpus at `root`,
 * re-scanning the current on-disk source-file listing and import graph
 * fresh each call (so a prior mutation's create/delete/rename is always
 * reflected). Returns `{ paths_touched, detail, mutation_write_epoch_ms }`;
 * `paths_touched` is added to `usedPaths` by the caller so a later mutation
 * never re-targets a file this run has already edited, deleted, renamed
 * (from or to), or created.
 *
 * P3-7 (plan's watcher-detection-latency item): `mutation_write_epoch_ms` is
 * the `performance.timeOrigin + performance.now()` epoch-ms timestamp taken
 * IMMEDIATELY BEFORE the actual filesystem-mutating call for this variant
 * (the `writeFile`/`unlink`/`rename` a real watcher would react to) --
 * deliberately NOT the moment this function was entered. This function's own
 * corpus re-listing (`listRepoFiles`, an O(files) recursive `opendir`+`lstat`
 * walk) and import-graph rebuild (`buildImportGraph`, an O(candidate files)
 * SEQUENTIAL `readFile`+regex pass) together cost ~2.2-3.5s at n8n scale
 * (20,280 files, 14,046 candidates; measured directly, see
 * docs/evidence/2026-09-03-v4-p3-7-watcher-latency.md §1) and run BEFORE any
 * variant's actual mutation. A caller that captured its own "mutation
 * happened at" timestamp before calling this function (as `run()` used to)
 * was therefore timing this corpus-rescan/import-graph-rebuild window as
 * part of "time for the watcher to detect the change" -- a harness
 * measurement artifact that fully explains the previously-reported
 * `watcher_detection` medians of 2.0-3.0s at n8n scale
 * (`docs/evidence/2026-09-03-v4-p3-5-daemon-latency.md` §2.5/§5.2): a direct
 * probe of the real watcher (`scripts/watch-latency-probe.mjs`, bypassing
 * this rescan entirely) measures kqueue's actual detection latency at the
 * same corpus scale at 7-15ms, not seconds. Callers MUST use this returned
 * timestamp (not their own pre-call one) for any watcher-latency
 * measurement; `run()` below does.
 */
export async function applyMutation(root, excludedPaths, usedPaths, variant, marker, hubMinImporters) {
  assertMutable(root, `apply mutation variant ${variant}`);
  const all = await listRepoFiles(root, excludedPaths);
  const candidateAll = all.filter(isCandidateSourcePath);
  const { importersOf, specifiersIn } = await buildImportGraph(root, candidateAll);
  const available = candidateAll.filter((path) => !usedPaths.has(path));
  const writeEpochMs = () => performance.timeOrigin + performance.now();

  if (variant === "edit") {
    const target = pickBy(available, () => true, "No available source file to edit.");
    const mutation_write_epoch_ms = writeEpochMs();
    await applyEditFile(root, target, marker, "Edit");
    return { paths_touched: [target], detail: { target }, mutation_write_epoch_ms };
  }

  if (variant === "create") {
    const importFrom = pickBy(candidateAll, () => true, "No existing source file to import from.");
    const specifierStyle = detectSpecifierStyle(specifiersIn);
    const mutation_write_epoch_ms = writeEpochMs();
    const created = await applyCreateFile(root, importFrom, marker, all, specifierStyle);
    return { paths_touched: [created.path], detail: { created: created.path, imports: importFrom, specifier: created.specifier }, mutation_write_epoch_ms };
  }

  if (variant === "delete_leaf") {
    const target = pickBy(available, (path) => (importersOf.get(path)?.size ?? 0) === 0, "No unimported (leaf) source file available to delete.");
    const mutation_write_epoch_ms = writeEpochMs();
    await unlink(resolve(root, ...target.split("/")));
    return { paths_touched: [target], detail: { target, importer_count: 0 }, mutation_write_epoch_ms };
  }

  if (variant === "delete_with_importers") {
    const target = pickBy(available, (path) => (importersOf.get(path)?.size ?? 0) > 0, "No imported source file available to delete.");
    const importers = [...(importersOf.get(target) ?? [])];
    const mutation_write_epoch_ms = writeEpochMs();
    await unlink(resolve(root, ...target.split("/")));
    return { paths_touched: [target], detail: { target, importer_count: importers.length, importers }, mutation_write_epoch_ms };
  }

  if (variant === "rename_no_rewrite") {
    const target = pickBy(available, () => true, "No available source file to rename.");
    const toPath = renamedPathFor(target, marker);
    const mutation_write_epoch_ms = writeEpochMs();
    await rename(resolve(root, ...target.split("/")), resolve(root, ...toPath.split("/")));
    return { paths_touched: [target, toPath], detail: { from: target, to: toPath, rewrote_importers: false, importer_count: importersOf.get(target)?.size ?? 0 }, mutation_write_epoch_ms };
  }

  if (variant === "rename_rewrite") {
    const target = pickBy(available, (path) => (importersOf.get(path)?.size ?? 0) > 0, "No imported source file available for a rewritten rename.");
    const toPath = renamedPathFor(target, marker);
    const mutation_write_epoch_ms = writeEpochMs();
    await rename(resolve(root, ...target.split("/")), resolve(root, ...toPath.split("/")));
    const importers = [...(importersOf.get(target) ?? [])];
    const rewritten = [];
    for (const importerPath of importers) {
      const specs = (specifiersIn.get(importerPath) ?? []).filter((spec) => spec.resolvedTarget === target);
      if (specs.length === 0) continue;
      const absolute = resolve(root, ...importerPath.split("/"));
      let content = await readFile(absolute, "utf8");
      for (const spec of specs) content = replaceSpecifierLiteral(content, spec.specifier, rewrittenSpecifier(spec.specifier, marker));
      await writeFile(absolute, content);
      rewritten.push(importerPath);
    }
    return { paths_touched: [target, toPath, ...rewritten], detail: { from: target, to: toPath, rewrote_importers: true, importer_count: importers.length, rewritten_importers: rewritten }, mutation_write_epoch_ms };
  }

  if (variant === "hub_edit") {
    const ranked = available
      .map((path) => ({ path, count: importersOf.get(path)?.size ?? 0 }))
      .sort((left, right) => right.count - left.count || (left.path < right.path ? -1 : 1));
    const top = ranked[0];
    if (top === undefined) throw new Error("No available source file for a hub_edit.");
    const mutation_write_epoch_ms = writeEpochMs();
    await applyEditFile(root, top.path, marker, "Hub");
    return {
      paths_touched: [top.path],
      detail: { target: top.path, importer_count: top.count, hub_min_importers: hubMinImporters, hub_threshold_met: top.count >= hubMinImporters },
      mutation_write_epoch_ms,
    };
  }

  throw new Error(`Unknown mutation variant: ${variant}`);
}

// ---------------------------------------------------------------------------
// Structural-store MANIFEST reader / root-equality oracle
// (docs/evidence/2026-09-02-v4-p2-3-structural-store.md §1)
// ---------------------------------------------------------------------------

const HEADER_BYTES = 64;
// P3-6 item 1 (`docs/evidence/2026-09-02-v4-p2-3-structural-store.md` §1.1a)
// replaced a delta generation's `delta-<g>/` directory of standalone files
// with ONE `delta-<g>.seg` container file (a small table-of-contents header
// followed by every section's blob, byte-for-byte identical to what the
// pre-P3-6 standalone file of the same name would have contained -- see
// `crates/urdira-structural-store/src/container.rs`'s own doc comment).
// `SectionId` numbering below is copied verbatim from that enum: it is
// on-disk format, not an implementation detail this file gets to guess at.
const CONTAINER_MAGIC = "URDC";
const CONTAINER_HEADER_LEN = 64;
const TOC_ENTRY_STRIDE = 32;
const SECTION_ID = Object.freeze({
  "records.keys": 1,
  "records.meta": 2,
  "deps.keys": 12,
  "deps.meta": 13,
  "closures.records": 17,
  "closures.deps": 18,
});
const SEGMENT_TABLE = Object.freeze({
  records: Object.freeze({ keyFile: "records.keys", metaFile: "records.meta", keyStride: 32, metaStride: 96, validToOffset: 12, closureFile: "closures.records" }),
  dependency: Object.freeze({ keyFile: "deps.keys", metaFile: "deps.meta", keyStride: 32, metaStride: 32, validToOffset: 25, closureFile: "closures.deps" }),
});

function readManifest(structuralRoot) {
  return JSON.parse(readFileSync(join(structuralRoot, "MANIFEST"), "utf8"));
}

/**
 * Parses one `delta-<g>.seg` container's table of contents into
 * `section_id -> Buffer` (each value is that section's FULL blob, i.e. the
 * same bytes a pre-P3-6 standalone file of that name would have held,
 * 64-byte `FileHeader` included -- so callers index into it exactly like a
 * file read via `readFileSync`). Returns an empty Map for a file that isn't
 * actually a container (defensive; never expected once P3-6 is fully
 * rolled out).
 */
function readContainerSections(containerPath) {
  const bytes = readFileSync(containerPath);
  const sections = new Map();
  if (bytes.length < CONTAINER_HEADER_LEN || bytes.toString("ascii", 0, 4) !== CONTAINER_MAGIC) return sections;
  const sectionCount = Number(bytes.readBigUInt64LE(16));
  const tocOffset = Number(bytes.readBigUInt64LE(24));
  for (let index = 0; index < sectionCount; index += 1) {
    const entryOffset = tocOffset + index * TOC_ENTRY_STRIDE;
    const sectionId = bytes.readUInt16LE(entryOffset);
    const start = Number(bytes.readBigUInt64LE(entryOffset + 8));
    const length = Number(bytes.readBigUInt64LE(entryOffset + 16));
    sections.set(sectionId, bytes.subarray(start, start + length));
  }
  return sections;
}

/**
 * Resolves one logical segment file's bytes for either a base generation
 * (`dirPath` is a real directory, one standalone file per name -- P3-6 left
 * this shape unchanged) or a delta generation (`dirPath` is a
 * `delta-<g>.seg` container file -- P3-6's single-file format). Returns
 * `undefined` if the section/file doesn't exist (an optional section this
 * generation never wrote, e.g. a delta with no closures).
 */
function readNamedSection(dirPath, fileName) {
  if (dirPath.endsWith(".seg")) {
    const sectionId = SECTION_ID[fileName];
    if (sectionId === undefined) throw new Error(`no container SectionId mapping for ${fileName}`);
    return readContainerSections(dirPath).get(sectionId);
  }
  const filePath = join(dirPath, fileName);
  return existsSync(filePath) ? readFileSync(filePath) : undefined;
}

function readSegmentRows(dirPath, spec) {
  const keys = readNamedSection(dirPath, spec.keyFile);
  const meta = readNamedSection(dirPath, spec.metaFile);
  if (keys === undefined || meta === undefined) return [];
  const count = Math.floor((keys.length - HEADER_BYTES) / spec.keyStride);
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const keyOffset = HEADER_BYTES + index * spec.keyStride;
    const key = keys.subarray(keyOffset, keyOffset + spec.keyStride).toString("hex");
    const validTo = meta.readUInt32LE(HEADER_BYTES + index * spec.metaStride + spec.validToOffset);
    rows.push({ key, validTo });
  }
  return rows;
}

function readClosureRows(dirPath, spec) {
  const bytes = readNamedSection(dirPath, spec.closureFile);
  if (bytes === undefined) return [];
  const stride = spec.keyStride + 4;
  const count = Math.floor((bytes.length - HEADER_BYTES) / stride);
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const offset = HEADER_BYTES + index * stride;
    const key = bytes.subarray(offset, offset + spec.keyStride).toString("hex");
    const validTo = bytes.readUInt32LE(offset + spec.keyStride);
    rows.push({ key, validTo });
  }
  return rows;
}

/**
 * Effective visible key set for one table (`records` or `dependency`) at a
 * store's current published generation: base rows first, then each delta in
 * manifest order re-asserting its own newly-opened rows and overwriting
 * `valid_to` for keys named by that delta's `closures.*` file. A key is
 * visible iff its final `valid_to` is 0. See §2.3/§2.2 of
 * `docs/evidence/2026-09-02-v4-p2-3-structural-store.md`.
 *
 * A base generation is a directory (`manifest.base`, e.g. `"base-1"`); a
 * delta generation is a single `delta-<g>.seg` container FILE (P3-6 item
 * 1) -- `readNamedSection`/`readSegmentRows`/`readClosureRows` dispatch on
 * that shape difference so this function itself doesn't need to.
 */
function computeVisibleKeySet(structuralRoot, setKind) {
  const spec = SEGMENT_TABLE[setKind];
  if (spec === undefined) return undefined;
  const manifest = readManifest(structuralRoot);
  const validToByKey = new Map();
  for (const row of readSegmentRows(join(structuralRoot, manifest.base), spec)) validToByKey.set(row.key, row.validTo);
  for (const deltaName of manifest.deltas ?? []) {
    const deltaPath = join(structuralRoot, deltaName);
    for (const row of readSegmentRows(deltaPath, spec)) validToByKey.set(row.key, row.validTo);
    for (const row of readClosureRows(deltaPath, spec)) validToByKey.set(row.key, row.validTo);
  }
  const visible = new Set();
  for (const [key, validTo] of validToByKey) if (validTo === 0) visible.add(key);
  return visible;
}

/**
 * Compares two structural stores' published `MANIFEST.roots`. Fast path:
 * the sha256 root strings match, per set. On a mismatch (or a set present
 * on only one side), falls back to a full key-set diff for that set,
 * reported capped at 50 example record ids per side.
 */
export function compareRootSets(structuralRootA, structuralRootB) {
  const manifestA = readManifest(structuralRootA);
  const manifestB = readManifest(structuralRootB);
  const setKinds = [...new Set([...Object.keys(manifestA.roots ?? {}), ...Object.keys(manifestB.roots ?? {})])].sort();
  const rootsEqual = {};
  const mismatches = {};
  for (const setKind of setKinds) {
    const rootA = manifestA.roots?.[setKind];
    const rootB = manifestB.roots?.[setKind];
    if (rootA !== undefined && rootB !== undefined && rootA === rootB) {
      rootsEqual[setKind] = true;
      continue;
    }
    rootsEqual[setKind] = false;
    const visibleA = computeVisibleKeySet(structuralRootA, setKind) ?? new Set();
    const visibleB = computeVisibleKeySet(structuralRootB, setKind) ?? new Set();
    const onlyInIncremental = [...visibleA].filter((key) => !visibleB.has(key)).sort();
    const onlyInFromScratch = [...visibleB].filter((key) => !visibleA.has(key)).sort();
    mismatches[setKind] = {
      root_a: rootA,
      root_b: rootB,
      count_a: visibleA.size,
      count_b: visibleB.size,
      only_in_incremental: onlyInIncremental.slice(0, 50),
      only_in_from_scratch: onlyInFromScratch.slice(0, 50),
      truncated: onlyInIncremental.length > 50 || onlyInFromScratch.length > 50,
    };
  }
  return {
    roots_equal: rootsEqual,
    mismatches: Object.keys(mismatches).length > 0 ? mismatches : undefined,
    base_a: manifestA.base,
    deltas_a: manifestA.deltas ?? [],
    base_b: manifestB.base,
    deltas_b: manifestB.deltas ?? [],
  };
}

// ---------------------------------------------------------------------------
// Daemon driver
// ---------------------------------------------------------------------------

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TERMINAL_SCAN_ERROR_MARKERS = Object.freeze(["resource_exhausted", "protocol", "build", "analysis"]);

/** Same convention as `scripts/native-acceleration-controller.mjs`'s
 * `isTerminalScanErrorCode`: `core:workspace_scan_failed` is the daemon's
 * generic catch-all for an unexpected worker/integration failure, which
 * cannot self-heal by continuing to poll a corpus that is not changing
 * further -- see this file's own `docs/evidence/2026-09-03-v4-p3-4-mutation-harness.md`
 * for the specific `source_observation_batches` UNIQUE-constraint failure
 * this surfaces for EVERY mutation today (a pre-existing bug in the
 * Changed-unsupported-retries-Full path, out of this harness's ownership). */
function isTerminalScanErrorCode(value) {
  const normalized = value.toLowerCase();
  return normalized === "core:workspace_scan_failed" || TERMINAL_SCAN_ERROR_MARKERS.some((marker) => normalized.includes(marker));
}

function extractWorkspaceStatus(result, workspaceId) {
  if (result?.exit_code !== 0 || !isRecord(result.data) || !Array.isArray(result.data.workspaces)) throw new Error(`Urdira index status failed: ${JSON.stringify(result?.data ?? result)}`);
  const matches = result.data.workspaces.filter((workspace) => isRecord(workspace) && workspace.workspace_id === workspaceId);
  if (matches.length !== 1) throw new Error(`Urdira index status did not return exactly one workspace ${workspaceId}.`);
  return matches[0];
}

async function getWorkspaceDatabasePath(dataRoot, workspaceId) {
  const catalog = new DatabaseSync(join(dataRoot, "catalog.sqlite"), { readOnly: true, timeout: 5_000 });
  try {
    const row = catalog.prepare("SELECT database_path FROM installation_workspaces WHERE workspace_id = ? AND removed_at IS NULL").get(workspaceId);
    if (!isRecord(row) || typeof row.database_path !== "string") throw new Error(`Urdira catalog has no active database for workspace ${workspaceId}.`);
    return row.database_path;
  } finally {
    catalog.close();
  }
}

/**
 * P3-5 (plan §6.1's daemon-latency item): reads `core:status`'s
 * `daemon_epoch_ms_offset` (`packages/daemon/src/runtime.ts`'s
 * `DAEMON_START_EPOCH_MS`) once -- the epoch-ms zero point every v4
 * workspace's `last_scan_timeline` is reported relative to. Combined with
 * this harness's own `performance.timeOrigin + performance.now()` epoch-ms
 * clock (the same clock family `Date.now()`/the daemon's own offset are
 * drawn from) for the instant a mutation's filesystem write actually
 * happened, this lets `deriveTimelineLatencies` below compute a TRUE
 * latency from the daemon's own timestamps instead of being limited to this
 * harness's own poll-interval quantization.
 */
async function fetchDaemonEpochOffsetMs(runtime, daemonOptions) {
  const result = await runtime.runUrdira(["status", "--json"], { daemon: daemonOptions });
  if (result?.exit_code !== 0 || !isRecord(result.data) || typeof result.data.daemon_epoch_ms_offset !== "number") {
    throw new Error(`Urdira status did not report daemon_epoch_ms_offset: ${JSON.stringify(result?.data ?? result)}`);
  }
  return result.data.daemon_epoch_ms_offset;
}

/**
 * P3-5: converts a `last_scan_timeline` (daemon-relative ms, see
 * `fetchDaemonEpochOffsetMs`'s doc comment) plus the daemon's own epoch
 * offset into TRUE latencies (ms) from the mutation's actual filesystem
 * write, on the SAME epoch-ms clock (`performance.timeOrigin +
 * performance.now()`) `mutationWriteEpochMs` was captured on -- and a named
 * phase breakdown (watcher detection, aggregation debounce, IPC/admission,
 * worker compute to queryable, worker compute to durable, readiness-update
 * overhead) for attributing where the total latency actually goes. Returns
 * `undefined` fields wherever the timeline itself never reached that
 * milestone (a scan that failed partway, or a non-watcher-driven scan with
 * no `fs_event_at`/`aggregated_at` to report).
 */
function deriveTimelineLatencies(timeline, daemonEpochOffsetMs, mutationWriteEpochMs) {
  if (!isRecord(timeline)) return {};
  const abs = (relativeMs) => (typeof relativeMs === "number" ? daemonEpochOffsetMs + relativeMs : undefined);
  const fsEventAt = abs(timeline.fs_event_at);
  const aggregatedAt = abs(timeline.aggregated_at);
  const requestSentAt = abs(timeline.request_sent_at);
  const queryableAt = abs(timeline.queryable_at);
  const completedAt = abs(timeline.completed_at);
  const readinessUpdatedAt = abs(timeline.readiness_updated_at);
  const diff = (a, b) => (typeof a === "number" && typeof b === "number" ? round(a - b) : undefined);
  return {
    event_queryable_ms: diff(queryableAt, mutationWriteEpochMs),
    event_durable_ms: diff(completedAt, mutationWriteEpochMs),
    timeline_breakdown_ms: {
      watcher_detection: diff(fsEventAt, mutationWriteEpochMs),
      aggregation_debounce: diff(aggregatedAt, fsEventAt),
      admission_and_ipc: diff(requestSentAt, aggregatedAt),
      worker_to_queryable: diff(queryableAt, requestSentAt),
      worker_to_durable: diff(completedAt, requestSentAt),
      readiness_update_overhead: diff(readinessUpdatedAt, queryableAt),
    },
  };
}

/**
 * Polls `core:index_status` (via `urdira index --workspace <id> --json`)
 * until `structural_queryable_generation` differs from `previous`, holding
 * for a short stable window (successive identical observations) so a
 * mid-flight watcher-burst intermediate state is never mistaken for the
 * final one -- same defensive shape as
 * `scripts/native-acceleration-controller.mjs`'s `status()`, adapted to v4's
 * two-generation readiness fields (P2-7) instead of v3's snapshot id.
 */
async function waitForV4Readiness(runtime, daemonOptions, workspaceId, previous, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  const stableRequired = Math.max(2, Math.ceil(300 / pollIntervalMs));
  let stableToken;
  let stableCount = 0;
  let queryableAtWall;
  let durableAtWall;
  let lastErrorCode;
  let pendingTerminalErrorCode;
  // P3-5 (plan §6.1's daemon-latency item): the daemon's own `last_scan_timeline`
  // for this workspace (`core:index_status`, `packages/daemon/src/runtime.ts`),
  // captured from the most recent poll response. Unlike `queryableAtWall`/
  // `durableAtWall` above (this HARNESS's own poll-quantized observation, kept
  // for comparison), the timeline's own timestamps are recorded daemon-side at
  // the actual moment each milestone happened, independent of when this loop
  // happens to poll -- so grabbing whatever the LAST poll returned is enough;
  // the values themselves do not change once a milestone has been reached.
  let lastTimeline;
  await delay(pollIntervalMs);
  while (Date.now() < deadline) {
    const result = await runtime.runUrdira(["index", "--workspace", workspaceId, "--json"], { daemon: daemonOptions, admin_request_timeout_ms: timeoutMs });
    const workspace = extractWorkspaceStatus(result, workspaceId);
    if (isRecord(workspace.last_scan_timeline)) lastTimeline = workspace.last_scan_timeline;
    if (typeof workspace.last_scan_error_code === "string") {
      lastErrorCode = workspace.last_scan_error_code;
      stableToken = undefined;
      stableCount = 0;
      // A terminal, generic scan failure (`core:workspace_scan_failed`) will
      // not self-heal by continuing to poll a corpus this harness is not
      // changing further. Require observing the SAME terminal code twice in
      // a row (like `native-acceleration-controller.mjs`'s own convention)
      // before giving up early, so one transient mid-scan read is never
      // mistaken for a stuck failure.
      if (isTerminalScanErrorCode(lastErrorCode)) {
        if (pendingTerminalErrorCode === lastErrorCode) {
          throw new Error(`v4 workspace ${workspaceId} scan failed with stable terminal error ${lastErrorCode}; it will not self-heal without a new filesystem change.`);
        }
        pendingTerminalErrorCode = lastErrorCode;
      } else {
        pendingTerminalErrorCode = undefined;
      }
      await delay(pollIntervalMs);
      continue;
    }
    pendingTerminalErrorCode = undefined;
    const queryableGen = workspace.structural_queryable_generation ?? workspace.readiness?.structural?.queryable_generation;
    const durableGen = workspace.structural_durable_generation ?? workspace.readiness?.structural?.durable_generation;
    if (queryableAtWall === undefined && queryableGen !== undefined && queryableGen !== previous.queryable_generation) queryableAtWall = performance.now();
    if (durableAtWall === undefined && durableGen !== undefined && durableGen !== previous.durable_generation) durableAtWall = performance.now();
    const advanced = queryableGen !== undefined && queryableGen !== previous.queryable_generation;
    const ready = workspace.workspace_status === "ready" && advanced;
    if (ready) {
      const token = `${queryableGen}:${durableGen ?? ""}`;
      if (token === stableToken) stableCount += 1;
      else { stableToken = token; stableCount = 1; }
      if (stableCount >= stableRequired) return { workspace, queryableGen, durableGen, queryableAtWall, durableAtWall, timeline: lastTimeline };
    } else {
      stableToken = undefined;
      stableCount = 0;
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`v4 workspace ${workspaceId} did not reach a new structural generation within ${timeoutMs}ms (last_scan_error_code=${lastErrorCode ?? "none"}).`);
}

/**
 * `execFile`, retrying a transient `spawn EBADF` (`errno: -9`) up to 3
 * attempts total with a 250ms backoff between them. Found live at n8n scale
 * (`docs/evidence/2026-09-03-v4-p3-1-incremental.md` §7.7): a real,
 * non-deterministic Node.js/sandbox-environment fd-table issue, not tied to
 * any specific call count or ordering -- a bare retry is the appropriate
 * fix for a transient spawn failure, not a code defect to work around
 * structurally.
 */
async function execFileWithEbadfRetry(command, args, options, attempts = 3, backoffMs = 250) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await execFileAsync(command, args, options);
    } catch (error) {
      lastError = error;
      if (error?.code !== "EBADF" && error?.errno !== -9) throw error;
      if (attempt < attempts) await delay(backoffMs);
    }
  }
  throw lastError;
}

async function oracleVerify({ corpusRoot, workerPath, dataRoot, workspaceId, tmpRoot, label, engineExports }) {
  const incrementalDatabasePath = await getWorkspaceDatabasePath(dataRoot, workspaceId);
  const incrementalStructuralRoot = engineExports.structuralStoreDirFor(incrementalDatabasePath);
  const freshDataDir = join(tmpRoot, `oracle-${label}`);
  await mkdir(freshDataDir, { recursive: true });
  await execFileWithEbadfRetry(process.execPath, [resolve(repoRoot, "scripts/v4-scan.mjs"), corpusRoot, freshDataDir, "--force"], {
    env: { ...process.env, URDIRA_INDEXING_CORE_WORKER_PATH: workerPath },
    maxBuffer: 64 * 1024 * 1024,
  });
  const freshStructuralRoot = join(freshDataDir, "structural");
  return compareRootSets(incrementalStructuralRoot, freshStructuralRoot);
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return undefined;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[index];
}

function allRootsEqual(rootsEqualRecord) {
  if (rootsEqualRecord === undefined) return undefined;
  return Object.values(rootsEqualRecord).every(Boolean);
}

function summaryTableText(mutations) {
  const byKind = new Map();
  for (const mutation of mutations) {
    if (!byKind.has(mutation.kind)) byKind.set(mutation.kind, []);
    byKind.get(mutation.kind).push(mutation);
  }
  const header = ["kind", "count", "queryable_p50_ms", "queryable_p95_ms", "durable_p50_ms", "durable_p95_ms", "event_queryable_p50_ms", "event_queryable_p95_ms", "event_durable_p50_ms", "event_durable_p95_ms", "any_fallback_full", "roots_equal"];
  const rows = [header.join("\t")];
  for (const [kind, list] of byKind) {
    const queryable = list.map((m) => m.queryable_ms).filter((v) => typeof v === "number").sort((a, b) => a - b);
    const durable = list.map((m) => m.durable_ms).filter((v) => typeof v === "number").sort((a, b) => a - b);
    const eventQueryable = list.map((m) => m.event_queryable_ms).filter((v) => typeof v === "number").sort((a, b) => a - b);
    const eventDurable = list.map((m) => m.event_durable_ms).filter((v) => typeof v === "number").sort((a, b) => a - b);
    const anyFallback = list.some((m) => m.fallback_full === true);
    const rootsOk = list.every((m) => allRootsEqual(m.roots_equal) !== false);
    rows.push([
      kind,
      String(list.length),
      percentile(queryable, 50)?.toFixed(1) ?? "n/a",
      percentile(queryable, 95)?.toFixed(1) ?? "n/a",
      percentile(durable, 50)?.toFixed(1) ?? "n/a",
      percentile(durable, 95)?.toFixed(1) ?? "n/a",
      percentile(eventQueryable, 50)?.toFixed(1) ?? "n/a",
      percentile(eventQueryable, 95)?.toFixed(1) ?? "n/a",
      percentile(eventDurable, 50)?.toFixed(1) ?? "n/a",
      percentile(eventDurable, 95)?.toFixed(1) ?? "n/a",
      String(anyFallback),
      String(rootsOk),
    ].join("\t"));
  }
  return rows.join("\n");
}

function assertDisjointPaths(pathA, pathB, labelA, labelB) {
  const withSep = (path) => (path.endsWith("/") ? path : `${path}/`);
  const normalizedA = withSep(pathA);
  const normalizedB = withSep(pathB);
  if (normalizedA === normalizedB || normalizedA.startsWith(normalizedB) || normalizedB.startsWith(normalizedA)) {
    throw new Error(`${labelA} (${pathA}) and ${labelB} (${pathB}) must be disjoint paths.`);
  }
}

export async function run(options) {
  // P3-2 hard rule: a protected corpus never gets a temp-dir scratch copy
  // under the OS temp dir -- it goes under the mandated benchmark scratch
  // root instead, so every artifact from a run against the shared n8n
  // corpus lands somewhere durable and inspectable, never `/tmp`. An
  // unprotected corpus (fixtures, CI) keeps using the OS temp dir exactly
  // as before -- this is additive, not a behavior change for existing
  // callers/tests.
  //
  // `tmpRoot` itself (which `dataRoot` -- and therefore the daemon's own
  // `daemon.sock` Unix domain socket -- lives under, unless `--data-root`
  // overrides it) stays on the OS temp dir REGARDLESS: a `sockaddr_un`
  // path is capped at ~104 bytes on macOS, and the mandated benchmark
  // scratch root's own absolute path is already long enough that nesting
  // `urdira-v4-mutation-<rand>/data/daemon.sock` under it overflows that
  // limit outright (`EINVAL` from `listen()`, found live running this
  // exact harness against the protected n8n corpus). The hard rule is
  // about never mutating/copying the CORPUS into `/tmp` -- it says nothing
  // about the daemon's own transient socket/data directory, which holds no
  // corpus content at all. `corpusRoot` (the actual mutable copy of
  // `--corpus`) is rooted separately, under the mandated scratch root when
  // protected, so it alone satisfies the hard rule.
  const corpusIsProtected = isProtectedReadonlyCorpus(options.corpus);
  const tmpRoot = await mkdtemp(join(tmpdir(), "urdira-v4-mutation-"));
  const corpusParent = corpusIsProtected
    ? join(MANDATED_SCRATCH_ROOT, `scratch-mutation-harness-${randomBytes(4).toString("hex")}`)
    : tmpRoot;
  if (corpusIsProtected) await mkdir(corpusParent, { recursive: true });
  const corpusRoot = join(corpusParent, "corpus");
  if (resolve(corpusRoot) === resolve(options.corpus)) throw new Error("--corpus must not resolve to the harness's own scratch corpus path.");
  const usesExternalDataRoot = options.data_root !== undefined;
  const dataRoot = options.data_root ?? join(tmpRoot, "data");
  await mkdir(corpusRoot, { recursive: true });
  if (usesExternalDataRoot) {
    assertDisjointPaths(dataRoot, options.corpus, "--data-root", "--corpus");
    assertDisjointPaths(dataRoot, tmpRoot, "--data-root", "the temporary run root");
    let existingEntries = [];
    try { existingEntries = await readdir(dataRoot); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existingEntries.length > 0) throw new Error(`--data-root (${dataRoot}) must be an empty or absent directory.`);
    await mkdir(dataRoot, { recursive: true });
  }

  let nativeClosure;
  let runtime;
  let daemonOptions;
  let originalWarn;
  const fallbackWarnings = [];

  try {
    if (options.owners !== undefined) await createSlice(options.corpus, corpusRoot, options.owners);
    // Exclude the read-only sentinel itself from the copy: `cp()` would
    // otherwise happily copy `.urdira-shared-corpus-readonly` right along
    // with everything else, making the freshly-made MUTABLE scratch copy
    // itself look protected to `assertMutable`/`isProtectedReadonlyCorpus`
    // -- found live (this exact false positive blocked every mutation
    // against a freshly-copied n8n scratch corpus before this fix).
    else await cp(options.corpus, corpusRoot, { recursive: true, filter: (source) => basename(source) !== SHARED_CORPUS_MARKER });
    const excludedPaths = [".git"];

    nativeClosure = await prepareNativeRoot(options.native_root);
    const workerPath = join(nativeClosure.native_root, "urdira-indexing-worker");
    process.env["URDIRA_V4"] = "1";
    process.env["URDIRA_NATIVE_REQUIRED"] = "1";
    process.env["URDIRA_NATIVE_ROOT"] = nativeClosure.native_root;
    process.env["URDIRA_SEMANTIC_INDEX"] = "0";
    process.env["URDIRA_INDEXING_CORE_WORKER_PATH"] = workerPath;
    process.env["URDIRA_DEBUG_TIMING"] = "1";
    process.env["URDIRA_STORAGE_DEBUG_TIMING"] = "1";

    originalWarn = console.warn;
    console.warn = (...args) => {
      const text = args.map((arg) => (arg instanceof Error ? arg.stack ?? arg.message : String(arg))).join(" ");
      if (text.includes("ScanScope::Changed is not supported")) fallbackWarnings.push(text);
      originalWarn(...args);
    };

    const runtimeModule = await import(pathToFileURL(resolve(repoRoot, "apps/urdira/dist/index.js")).href);
    const engineExports = await import(pathToFileURL(resolve(repoRoot, "packages/engine/dist/index.js")).href);
    if (typeof runtimeModule.runUrdira !== "function" || typeof runtimeModule.defaultDaemonOptions !== "function") throw new Error("apps/urdira/dist/index.js must export runUrdira and defaultDaemonOptions.");
    if (typeof engineExports.structuralStoreDirFor !== "function") throw new Error("packages/engine/dist/index.js must export structuralStoreDirFor.");
    runtime = runtimeModule;
    daemonOptions = await runtimeModule.defaultDaemonOptions(dataRoot);
    const runOptions = { daemon: daemonOptions, admin_request_timeout_ms: options.readiness_timeout_ms, on_progress: (progress) => process.stderr.write(`[v4-mutation-harness] ${progress.message ?? progress.phase}\n`) };

    const started = await runtime.runUrdira(["daemon", "start", "--json", "--debug-timing"], runOptions);
    if (started.exit_code !== 0) throw new Error(`Urdira foreground daemon start failed: ${JSON.stringify(started.data)}`);

    // P3-5 (plan §6.1's daemon-latency item): `--readiness events` tightens
    // the polling loop's own interval to 25ms (there is no daemon-side
    // push-notification RPC to subscribe to instead -- see this task's own
    // evidence doc for what was checked) purely to shrink THIS harness's own
    // poll-quantization error on `queryableAtWall`/`durableAtWall`; the
    // timeline-derived `event_queryable_ms`/`event_durable_ms` fields below
    // are computed from the daemon's own timestamps either way and do not
    // depend on the poll interval at all, so they are reported in BOTH
    // modes for direct comparison.
    const effectivePollIntervalMs = options.readiness_mode === "events" ? 25 : options.poll_interval_ms;
    const daemonEpochOffsetMs = await fetchDaemonEpochOffsetMs(runtime, daemonOptions);

    const selection = JSON.stringify({ selected_technology_ids: ["typescript"], selected_plugin_ids: ["urdira:javascript_typescript"] });
    const coldStartWall = performance.now();
    const coldStartEpochMs = performance.timeOrigin + performance.now();
    const added = await runtime.runUrdira(["workspace", "add", corpusRoot, "--payload", selection, "--confirm", "--json", "--debug-timing"], runOptions);
    const workspaceId = isRecord(added.data) && isRecord(added.data.result) ? added.data.result.workspace_id : undefined;
    if (added.exit_code !== 0 || typeof workspaceId !== "string" || workspaceId.length === 0) throw new Error(`Urdira workspace add failed: ${JSON.stringify(added.data)}`);

    const coldReadiness = await waitForV4Readiness(runtime, daemonOptions, workspaceId, { queryable_generation: undefined, durable_generation: undefined }, options.readiness_timeout_ms, effectivePollIntervalMs);
    const cold = {
      queryable_ms: coldReadiness.queryableAtWall === undefined ? undefined : round(coldReadiness.queryableAtWall - coldStartWall),
      durable_ms: coldReadiness.durableAtWall === undefined ? undefined : round(coldReadiness.durableAtWall - coldStartWall),
      queryable_generation: coldReadiness.queryableGen,
      durable_generation: coldReadiness.durableGen,
      // Cold's own `fs_event_at`/`aggregated_at` are meaningless (the first
      // scan is never watcher-driven/aggregated) -- only the request-sent-
      // through-durable phases are meaningful here.
      ...deriveTimelineLatencies(coldReadiness.timeline, daemonEpochOffsetMs, coldStartEpochMs),
    };
    let previous = { queryable_generation: coldReadiness.queryableGen, durable_generation: coldReadiness.durableGen };

    let coldOracle;
    if (options.verify_roots === "each") coldOracle = await oracleVerify({ corpusRoot, workerPath, dataRoot, workspaceId, tmpRoot, label: "cold", engineExports });

    const usedPaths = new Set();
    const runNonce = randomBytes(4).toString("hex");

    // `--warm N`: run N throwaway edit mutations before the timed sequence
    // starts, without recording their timings or oracle results. Isolates
    // any one-time cold-cache effect (a freshly-warmed `SyntaxWorkerState`
    // project entry, a freshly-opened `StoreReader`, page-cache warmup on
    // the structural store's segment files) from the STEADY-STATE numbers
    // this harness's own summary table reports -- see
    // `docs/evidence/2026-09-03-v4-p3-1-incremental.md` §7.3's own
    // EDIT#1-vs-EDIT#2 cold/steady split, now reproducible through the real
    // daemon path instead of only the worker-only in-process test.
    for (let warmIndex = 0; warmIndex < options.warm; warmIndex += 1) {
      const marker = `warm${runNonce}${String(warmIndex).padStart(3, "0")}`;
      const applied = await applyMutation(corpusRoot, excludedPaths, usedPaths, "edit", marker, options.hub_min_importers);
      for (const path of applied.paths_touched) usedPaths.add(path);
      const readiness = await waitForV4Readiness(runtime, daemonOptions, workspaceId, previous, options.readiness_timeout_ms, effectivePollIntervalMs);
      previous = { queryable_generation: readiness.queryableGen, durable_generation: readiness.durableGen };
    }

    const sequence = expandKindSequence(options.mutation_kinds, options.repeat);
    const mutations = [];
    for (let index = 0; index < sequence.length; index += 1) {
      const { kind, variant } = sequence[index];
      const marker = `${runNonce}${String(index).padStart(3, "0")}`;
      // P3-7: `applyMutation` itself re-lists the whole corpus and rebuilds
      // an import graph before performing this variant's actual write (see
      // its own doc comment) -- `preCallEpochMs` is kept ONLY to report how
      // much of that harness-side overhead this specific mutation paid
      // (`harness_selection_overhead_ms` below), never as the basis for any
      // watcher-latency measurement. `applied.mutation_write_epoch_ms`
      // (captured by `applyMutation` immediately before its real
      // `writeFile`/`unlink`/`rename` call) is the correct "mutation
      // happened at" instant and is what every latency below is measured
      // from.
      const preCallEpochMs = performance.timeOrigin + performance.now();
      const applied = await applyMutation(corpusRoot, excludedPaths, usedPaths, variant, marker, options.hub_min_importers);
      for (const path of applied.paths_touched) usedPaths.add(path);
      const mutationWriteEpochMs = applied.mutation_write_epoch_ms;
      const mutationWallStart = mutationWriteEpochMs - performance.timeOrigin;
      const harness_selection_overhead_ms = round(mutationWriteEpochMs - preCallEpochMs);
      const readiness = await waitForV4Readiness(runtime, daemonOptions, workspaceId, previous, options.readiness_timeout_ms, effectivePollIntervalMs);
      const queryable_ms = readiness.queryableAtWall === undefined ? undefined : round(readiness.queryableAtWall - mutationWallStart);
      const durable_ms = readiness.durableAtWall === undefined ? undefined : round(readiness.durableAtWall - mutationWallStart);
      const timelineLatencies = deriveTimelineLatencies(readiness.timeline, daemonEpochOffsetMs, mutationWriteEpochMs);
      previous = { queryable_generation: readiness.queryableGen, durable_generation: readiness.durableGen };
      let rootsResult;
      if (options.verify_roots === "each") rootsResult = await oracleVerify({ corpusRoot, workerPath, dataRoot, workspaceId, tmpRoot, label: String(index), engineExports });
      const corpus_digest = await computeNativeAccelerationCorpusDigest(corpusRoot, excludedPaths);
      mutations.push({
        mutation_index: index,
        mutation_id: `${kind}-${variant}-${String(index).padStart(3, "0")}`,
        kind,
        variant,
        detail: applied.detail,
        // P3-7: how long THIS mutation's own `applyMutation` call spent
        // re-listing the corpus and rebuilding the import graph before
        // performing its actual write -- harness-side overhead, reported
        // for transparency, and explicitly NOT folded into any latency
        // field below (see `applyMutation`'s doc comment).
        harness_selection_overhead_ms,
        // Poll-observed (this harness's own quantized measurement, kept for
        // comparison -- plan §6.1's own instruction).
        queryable_ms,
        durable_ms,
        // Event-timeline-derived (the daemon's own true timestamps, see
        // `deriveTimelineLatencies`'s doc comment) -- `event_queryable_ms`,
        // `event_durable_ms`, `timeline_breakdown_ms`.
        ...timelineLatencies,
        queryable_generation: readiness.queryableGen,
        durable_generation: readiness.durableGen,
        fallback_full: rootsResult === undefined ? undefined : rootsResult.deltas_a.length === 0,
        roots_equal: rootsResult?.roots_equal,
        mismatches: rootsResult?.mismatches,
        resulting_corpus_digest: corpus_digest,
      });
    }

    let finalOracle;
    if (options.verify_roots === "final") finalOracle = await oracleVerify({ corpusRoot, workerPath, dataRoot, workspaceId, tmpRoot, label: "final", engineExports });

    return {
      schema_version: 1,
      mode: "v4",
      corpus: options.corpus,
      owners: options.owners,
      warm: options.warm,
      verify_roots: options.verify_roots,
      changed_scope_unsupported_warning_seen: fallbackWarnings.length > 0,
      cold: { ...cold, roots_equal: coldOracle?.roots_equal, fallback_full: coldOracle === undefined ? undefined : coldOracle.deltas_a.length === 0 },
      mutations,
      final: finalOracle === undefined ? undefined : { roots_equal: finalOracle.roots_equal, fallback_full: finalOracle.deltas_a.length === 0, mismatches: finalOracle.mismatches },
    };
  } finally {
    if (originalWarn !== undefined) console.warn = originalWarn;
    if (runtime !== undefined && daemonOptions !== undefined) {
      await runtime.runUrdira(["daemon", "stop", "--json"], { daemon: daemonOptions }).catch(() => undefined);
    }
    await nativeClosure?.cleanup().catch(() => undefined);
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    if (corpusParent !== tmpRoot) await rm(corpusParent, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const result = {
    readiness_timeout_ms: 120_000,
    poll_interval_ms: 200,
    readiness_mode: "poll",
    repeat: 1,
    verify_roots: "each",
    mutation_kinds: ["edit", "create", "delete", "rename", "hub_edit"],
    hub_min_importers: 50,
    warm: 0,
    v4: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--v4") { result.v4 = true; continue; }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${key} requires a value.`);
    if (["--corpus", "--native-root", "--output", "--data-root"].includes(key)) {
      result[key.slice(2).replaceAll("-", "_")] = resolve(value);
      index += 1;
      continue;
    }
    if (["--owners", "--repeat", "--readiness-timeout-ms", "--poll-interval-ms", "--hub-min-importers"].includes(key)) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${key} must be a positive integer.`);
      result[key.slice(2).replaceAll("-", "_")] = parsed;
      index += 1;
      continue;
    }
    if (key === "--warm") {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${key} must be a non-negative integer.`);
      result.warm = parsed;
      index += 1;
      continue;
    }
    if (key === "--verify-roots") {
      if (value !== "each" && value !== "final") throw new Error("--verify-roots must be each or final.");
      result.verify_roots = value;
      index += 1;
      continue;
    }
    // P3-5 (plan §6.1's daemon-latency item): "events" tightens the
    // readiness-wait loop's own polling interval to 25ms -- there is no
    // daemon-side push-notification RPC to subscribe to instead (checked;
    // see this task's own evidence doc) -- purely to shrink this harness's
    // OWN poll-quantization error; `--poll-interval-ms` is ignored for the
    // readiness wait in this mode (it still governs nothing else). Both
    // modes always report the timeline-derived `event_queryable_ms`/
    // `event_durable_ms` fields (computed from the daemon's own
    // timestamps, not from polling) for direct comparison.
    if (key === "--readiness") {
      if (value !== "poll" && value !== "events") throw new Error("--readiness must be poll or events.");
      result.readiness_mode = value;
      index += 1;
      continue;
    }
    if (key === "--mutation-kinds") {
      const kinds = value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      if (kinds.length === 0) throw new Error("--mutation-kinds must list at least one kind.");
      for (const kind of kinds) if (!Object.hasOwn(KIND_VARIANTS, kind)) throw new Error(`Unknown mutation kind: ${kind} (expected one of ${Object.keys(KIND_VARIANTS).join(", ")}).`);
      result.mutation_kinds = kinds;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${key}`);
  }
  if (!result.v4) throw new Error("This harness only drives v4 workspaces; pass --v4 (URDIRA_V4=1 is set for you).");
  for (const field of ["corpus", "native_root", "output"]) if (!isAbsolute(result[field] ?? "")) throw new Error(`--${field.replaceAll("_", "-")} requires an absolute path.`);
  if (result.data_root !== undefined && !isAbsolute(result.data_root)) throw new Error("--data-root requires an absolute path.");
  return result;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArguments(process.argv.slice(2));
  run(options).then(async (report) => {
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, bytes);
    process.stdout.write(`${JSON.stringify({ output: options.output, mutation_count: report.mutations.length, cold_queryable_ms: report.cold.queryable_ms, cold_durable_ms: report.cold.durable_ms, changed_scope_unsupported_warning_seen: report.changed_scope_unsupported_warning_seen })}\n`);
    process.stdout.write(`${summaryTableText(report.mutations)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
