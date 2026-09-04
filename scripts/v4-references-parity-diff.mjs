#!/usr/bin/env node
// 2026-09-04 references-parity task, Phase A step 1: a definitive per-site
// diff between v3's confirmed `jsts:relation_references` rows and v4's
// (E1a-E3 hybrid lane) `core:references` rows, on the SAME corpus checkout,
// joined by reference-site identity `(path, start, end)` (both UTF-16
// code-unit offsets, same convention `scripts/v4-call-parity-diff.mjs`
// already documents and this script's own decode path shares byte for
// byte).
//
// Modelled directly on `scripts/v4-call-parity-diff.mjs` -- read that
// script's own header comment first, this one only documents where it
// differs:
//   - v3's `core:references` population is ALL `classification: "confirmed"`
//     (verified live against the retained v3 oracle SQLite for this corpus:
//     1,110,576 rows, 1,110,576 confirmed, 0 of any other classification,
//     0 decode errors) -- there is no v3 "possible reference" bucket to
//     carry through, unlike `core:call`.
//   - v4 never emits a "possible" `core:references` row either
//     (`semantic_sites.rs`'s module doc, point 1: only identifier references
//     Rust resolves "lexically, with zero doubt" become a `core:references`
//     proposed record at all; everything else is a `SiteKind::IdentifierRef`
//     pending site kept ONLY in memory -- see `crates/urdira-indexing-
//     worker/src/v4/tests_e2e.rs`'s `n8n_references_parity_debug_dump`,
//     which is the only place that population is ever observable). So this
//     script's forward histogram has exactly three buckets, not four:
//     `v4_same_target`, `v4_different_target` (must be 0 -- the task's own
//     hard gate), `v4_missing` (no v4 `core:references` row at this span at
//     all).
//   - `--v4-pending-dump <path>` (optional) is the TSV `n8n_references_
//     parity_debug_dump` writes via `URDIRA_V4_PENDING_IDENTIFIER_REF_DUMP`
//     (`path\tstart\tend\treason`, one line per pending `IdentifierRef`
//     site, this owner's OWN pending population from the SAME run that
//     produced `--v4-bodies`) -- joined against `v4_missing` sites by
//     `(path, start, end)` to attach the exact resolver-side `reason` this
//     script's own histogram groups by, mirroring `--v4-site-dump`'s role in
//     the call-parity script exactly (same join key, same "unknown_no_
//     pending_dump_match"/absent-file fallback behavior).
//   - Phase A step 2's "v3 target KIND" bucketing (module-level entity /
//     member / parameter / inferred type / other) reads straight off each
//     `v4_missing` sample's own `v3_target` id prefix (`jsts:{kind}:...`,
//     the E0 identity convention every producer in this repo shares) --
//     no extra input needed beyond what `--v3-db` already decodes.
//   - 2026-09-04 owner follow-up (recoverability of the `v4_missing`
//     167,843 population): `--classify-targets` additionally buckets each
//     `v4_missing` site's v3 `target_id` PATH component into `workspace`
//     (the path resolves to a real file under `--corpus-root`, i.e. a
//     genuinely recoverable in-repo target -- checked with `fs.existsSync`,
//     restricted to paths that actually land inside the corpus root so an
//     absolute path that happens to exist elsewhere on THIS machine, e.g.
//     this repo's own installed TypeScript lib files, is never
//     misclassified as in-corpus), `lib` (a TypeScript `lib.*.d.ts` global,
//     matched on the path itself so this works whether the store recorded
//     an absolute or relative path), `node_modules` (a vendored dependency
//     declaration), or `other` (anything else: no path, or a path outside
//     all three). Requires `--corpus-root` (without it every site is
//     `other` and a warning is printed once). Cross-tabs against the
//     existing `reason` histogram, and -- for `workspace` sites only --
//     against the v3 target id's raw kind token (`method`, `property`,
//     `function`, `variable`, `parameter`, `class`, ... i.e. the segment
//     right after `jsts:`, NOT the coarser `targetKindBucket` groups
//     above), plus a uniform-random 5-sample reservoir per `(reason,
//     workspace)` cell (path:start + the v3 target id) so a reader can spot
//     what shape of workspace target each reason is actually losing.
//
// Usage:
//   node scripts/v4-references-parity-diff.mjs \
//     --v3-db <path/to/workspace_corpus_....sqlite> \
//     --v4-bodies <path/to/reference-bodies.bin> \
//     [--v4-pending-dump <path/to/pending-identifier-ref-dump.tsv>] \
//     [--corpus-root <path>]   # to read source text for samples (line + snippet)
//     [--samples 30] [--out <path/to/report.json>]
//     [--classify-targets 1]    # v4_missing: bucket v3 target_id path into
//                               # workspace/lib/node_modules/other (needs --corpus-root)
//                               # NOTE: `parseArgs` below always consumes the
//                               # NEXT argv token as a flag's value (a
//                               # pre-existing convention every flag in this
//                               # script already follows) -- so this is
//                               # `--classify-targets 1`, not a bare
//                               # value-less switch; anything other than
//                               # unset/"0"/"false" enables it.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { decodeCanonical } from "../packages/canonical/dist/index.js";

function parseArgs(argv) {
  const args = { samples: 30 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    args[key] = value;
    i++;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
for (const required of ["v3-db", "v4-bodies"]) {
  if (!args[required]) {
    console.error(
      `usage: v4-references-parity-diff.mjs --v3-db <path> --v4-bodies <path> [--v4-pending-dump <path>] [--corpus-root <path>] [--samples N] [--out <path>]`,
    );
    process.exit(2);
  }
}

const SAMPLE_CAP = Number(args.samples) || 30;
const CLASSIFY_TARGETS_ENABLED =
  args["classify-targets"] !== undefined &&
  args["classify-targets"] !== "0" &&
  args["classify-targets"] !== "false";

function siteKey(path, start, end) {
  return `${path} ${start} ${end}`;
}

// The E0 identity convention every producer in this repo shares:
// `jsts:{kind}:{path}:{start}:{name}` -- the kind token right after `jsts:`
// classifies what shape of declaration a target id names, independent of
// which lane (v3 checker, v4 lexical, v4 typeflow) produced it.
function targetKindBucket(targetId) {
  if (!targetId || !targetId.startsWith("jsts:")) return "other";
  const kind = targetId.slice("jsts:".length).split(":")[0];
  switch (kind) {
    case "function":
    case "class":
    case "interface":
    case "type":
    case "enum":
    case "namespace":
    case "variable":
      return "module_level_entity";
    case "method":
    case "constructor":
    case "getter":
    case "setter":
    case "property":
      return "member";
    case "parameter":
      return "parameter";
    case "inferred_type":
      return "inferred_type";
    default:
      return "other";
  }
}

// ---------------------------------------------------------------------------
// `--classify-targets`: parse `jsts:{kind}:{path}:{start}:{name}` apart (the
// path itself never contains `:` on this corpus -- verified live: every one
// of the 1,110,576 v3-confirmed `core:references` target ids splits cleanly
// into exactly kind/path/start/name by this scheme) and bucket the path.
// ---------------------------------------------------------------------------
function parseTargetId(targetId) {
  if (!targetId || !targetId.startsWith("jsts:")) return null;
  const rest = targetId.slice("jsts:".length);
  const parts = rest.split(":");
  if (parts.length < 4) return null;
  const kind = parts[0];
  const name = parts[parts.length - 1];
  const start = parts[parts.length - 2];
  const path = parts.slice(1, parts.length - 2).join(":");
  return { kind, path, start, name };
}

// TypeScript `lib.*.d.ts` globals: matched on the path text itself (works for
// both the absolute paths this repo's own installed TypeScript resolves them
// to, e.g. `.../node_modules/.pnpm/@typescript+typescript-.../lib/lib.es5.d.ts`,
// and any relative/vendored equivalent a different corpus might carry).
const LIB_DTS_RE = /(^|\/)lib\.[A-Za-z0-9_.-]*\.d\.ts$/;

const existsCache = new Map(); // absolute path -> boolean, memoized (167,843 rows repeat paths heavily)
function existsCached(absPath) {
  let hit = existsCache.get(absPath);
  if (hit === undefined) {
    hit = existsSync(absPath);
    existsCache.set(absPath, hit);
  }
  return hit;
}

function classifyTarget(targetId, corpusRoot) {
  const parsed = parseTargetId(targetId);
  const p = parsed?.path;
  if (!p) return "other";
  if (corpusRoot) {
    const absPath = isAbsolute(p) ? p : join(corpusRoot, p);
    // Only "workspace" when the resolved path actually lands INSIDE the
    // corpus root -- an absolute target path that happens to exist
    // elsewhere on this machine (this repo's own node_modules, notably) is
    // never a corpus file and must not be counted as recoverable-in-repo.
    const withinCorpus = absPath === corpusRoot || absPath.startsWith(corpusRoot.replace(/\/$/, "") + "/");
    if (withinCorpus && existsCached(absPath)) return "workspace";
  }
  if (LIB_DTS_RE.test(p)) return "lib";
  if (p.includes("node_modules/")) return "node_modules";
  return "other";
}

// The raw kind token straight off the id (`method`, `property`, `function`,
// `variable`, `parameter`, `class`, `interface`, `type`, `enum`, `getter`,
// `setter`, `constructor`, `namespace`), unlike `targetKindBucket`'s coarser
// module_level_entity/member/parameter/inferred_type/other groups above.
function rawTargetKind(targetId) {
  const parsed = parseTargetId(targetId);
  return parsed?.kind ?? "other";
}

// Uniform-random reservoir sampling (5 per cell) over an unbounded stream --
// avoids holding all 167,843 `v4_missing` candidates in memory just to
// sample from them at the end.
function reservoirPush(reservoirState, item, cap = 5) {
  reservoirState.seen++;
  if (reservoirState.items.length < cap) {
    reservoirState.items.push(item);
    return;
  }
  const j = Math.floor(Math.random() * reservoirState.seen);
  if (j < cap) reservoirState.items[j] = item;
}

// ---------------------------------------------------------------------------
// 1. v3: every `core:references` relation row, decoded.
// ---------------------------------------------------------------------------
console.error(`[v3] opening ${args["v3-db"]} (read-only)`);
const v3Db = new DatabaseSync(args["v3-db"], { readOnly: true });
const v3ByKey = new Map(); // key -> {target_id, source_id, path, start, end, classification}
const v3ClassificationHistogram = new Map();
{
  const started = Date.now();
  const stmt = v3Db.prepare(
    "select body_payload from record_occurrences where universal_kind='core:references' and valid_to_generation is null",
  );
  let n = 0;
  let decodeErrors = 0;
  for (const row of stmt.iterate()) {
    n++;
    const payload = row.body_payload;
    let decoded;
    try {
      decoded = decodeCanonical(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
    } catch {
      decodeErrors++;
      continue;
    }
    v3ClassificationHistogram.set(
      decoded.classification,
      (v3ClassificationHistogram.get(decoded.classification) ?? 0) + 1,
    );
    if (decoded.classification !== "confirmed" || !decoded.target_id) continue;
    const key = siteKey(decoded.path, decoded.start, decoded.end);
    v3ByKey.set(key, {
      target_id: decoded.target_id,
      source_id: decoded.source_id,
      path: decoded.path,
      start: decoded.start,
      end: decoded.end,
    });
  }
  console.error(
    `[v3] ${n} core:references rows, ${v3ByKey.size} confirmed-with-target, ${decodeErrors} decode errors (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
  console.error(`[v3] classification histogram: ${JSON.stringify(Object.fromEntries(v3ClassificationHistogram))}`);
}
v3Db.close();

// ---------------------------------------------------------------------------
// 2. v4: every `core:references` relation row's body + the store's own
//    authoritative `target_subject().is_some()` flag (see `dump_reference_
//    bodies`'s own doc comment: expected true for every row this dump ever
//    produces, carried through rather than assumed for the same reason
//    `dump_call_bodies` carries it explicitly).
// ---------------------------------------------------------------------------
console.error(`[v4] reading ${args["v4-bodies"]}`);
const v4ByKey = new Map(); // key -> {confirmed, target_id, source_id, path, start, end}
{
  const started = Date.now();
  const buf = readFileSync(args["v4-bodies"]);
  const total = buf.readUInt32LE(0);
  let off = 4;
  let decodeErrors = 0;
  let confirmedCount = 0;
  for (let i = 0; i < total; i++) {
    const confirmedFlag = buf.readUInt8(off);
    off += 1;
    const len = buf.readUInt32LE(off);
    off += 4;
    const body = buf.subarray(off, off + len);
    off += len;
    let decoded;
    try {
      decoded = decodeCanonical(new Uint8Array(body));
    } catch {
      decodeErrors++;
      continue;
    }
    const confirmed = confirmedFlag !== 0;
    if (confirmed) confirmedCount++;
    const key = siteKey(decoded.path, decoded.start, decoded.end);
    v4ByKey.set(key, {
      confirmed,
      target_id: decoded.target_id,
      source_id: decoded.source_id,
      path: decoded.path,
      start: decoded.start,
      end: decoded.end,
    });
  }
  console.error(
    `[v4] ${total} core:references rows, ${confirmedCount} confirmed (target_subject), ${decodeErrors} decode errors (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
}

// ---------------------------------------------------------------------------
// 3. v4 pending-`IdentifierRef` reason dump (optional).
// ---------------------------------------------------------------------------
const v4PendingReason = new Map(); // key -> reason
if (args["v4-pending-dump"] && existsSync(args["v4-pending-dump"])) {
  const started = Date.now();
  const text = readFileSync(args["v4-pending-dump"], "utf8");
  let lines = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    lines++;
    const [ownerPath, startStr, endStr, ...reasonParts] = line.split("\t");
    const key = siteKey(ownerPath, Number(startStr), Number(endStr));
    v4PendingReason.set(key, reasonParts.join("\t"));
  }
  console.error(
    `[v4-pending-dump] ${lines} pending IdentifierRef sites (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
} else if (args["v4-pending-dump"]) {
  console.error(`[v4-pending-dump] WARNING: ${args["v4-pending-dump"]} does not exist, reasons will be "unknown"`);
}

// ---------------------------------------------------------------------------
// 4. Source text cache for samples (line number + snippet).
// ---------------------------------------------------------------------------
const sourceCache = new Map();
function sourceTextFor(path) {
  if (!args["corpus-root"]) return undefined;
  if (sourceCache.has(path)) return sourceCache.get(path);
  let text;
  try {
    text = readFileSync(`${args["corpus-root"]}/${path}`, "utf8");
  } catch {
    text = undefined;
  }
  sourceCache.set(path, text);
  return text;
}

function lineAndSnippet(path, start, end) {
  const text = sourceTextFor(path);
  if (text === undefined) return { line: "?", snippet: "" };
  let line = 1;
  for (let i = 0; i < start && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  const snippetRaw = text.slice(start, Math.min(end, start + 100)).replace(/\s+/g, " ").trim();
  return { line, snippet: snippetRaw };
}

// ---------------------------------------------------------------------------
// 5. Forward diff: classify every v3-confirmed reference site.
// ---------------------------------------------------------------------------
const forwardBuckets = {
  v4_same_target: [],
  v4_different_target: [],
  v4_missing: [],
};
const forwardCounts = { v4_same_target: 0, v4_different_target: 0, v4_missing: 0 };
const missingReasonHistogram = new Map();
// 2026-09-05 A5 references-parity task, Paso 0: `reason` can now carry a
// `/`-delimited diagnostic sub-reason suffix (`semantic_sites.rs`'s
// `import_binding_sub_reason`/`member_access_sub_reason`, in-memory-only --
// see either function's own doc comment) -- this histogram groups by the
// PREFIX alone (`reason.split("/")[0]`, i.e. the coarse reason token every
// prior evidence doc's histogram already reports), so a reason with no
// sub-reason at all (every OTHER pending reason in this file, and every
// sub-reason-less `import_binding`/`re_export_binding`/`member_access`
// degrade point outside the three instrumented functions) collapses to
// itself unchanged and this histogram stays comparable across runs.
const missingReasonPrefixHistogram = new Map();
const missingTargetKindHistogram = new Map();

for (const [key, v3site] of v3ByKey) {
  const v4site = v4ByKey.get(key);
  let bucket;
  let detail = {};
  if (v4site && v4site.confirmed) {
    if (v4site.target_id === v3site.target_id) {
      bucket = "v4_same_target";
    } else {
      bucket = "v4_different_target";
      detail = { v3_target: v3site.target_id, v4_target: v4site.target_id };
    }
  } else {
    bucket = "v4_missing";
    const reason = v4PendingReason.get(key) ?? "unknown_no_pending_dump_match";
    const targetKind = targetKindBucket(v3site.target_id);
    detail = { reason, v3_target_kind: targetKind };
    missingReasonHistogram.set(reason, (missingReasonHistogram.get(reason) ?? 0) + 1);
    const reasonPrefix = reason.split("/")[0];
    missingReasonPrefixHistogram.set(reasonPrefix, (missingReasonPrefixHistogram.get(reasonPrefix) ?? 0) + 1);
    missingTargetKindHistogram.set(targetKind, (missingTargetKindHistogram.get(targetKind) ?? 0) + 1);
  }
  forwardCounts[bucket]++;
  if (forwardBuckets[bucket].length < SAMPLE_CAP) {
    const { line, snippet } = lineAndSnippet(v3site.path, v3site.start, v3site.end);
    forwardBuckets[bucket].push({
      path: v3site.path,
      line,
      start: v3site.start,
      end: v3site.end,
      snippet,
      v3_target: v3site.target_id,
      ...detail,
    });
  }
}

// ---------------------------------------------------------------------------
// 6. Cross-tab: missing reason x v3 target kind (which reasons are even
//    representable in v4's store at all, per the task's own Phase A ask).
// ---------------------------------------------------------------------------
const reasonByKindHistogram = new Map(); // "reason|kind" -> count
for (const [key, v3site] of v3ByKey) {
  const v4site = v4ByKey.get(key);
  if (v4site && v4site.confirmed) continue;
  const reason = v4PendingReason.get(key) ?? "unknown_no_pending_dump_match";
  const targetKind = targetKindBucket(v3site.target_id);
  const crossKey = `${reason}|${targetKind}`;
  reasonByKindHistogram.set(crossKey, (reasonByKindHistogram.get(crossKey) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// 6b. `--classify-targets`: for every `v4_missing` site, bucket v3's
//    target_id path (workspace/lib/node_modules/other), cross-tab against
//    `reason`, and -- workspace only -- against the raw v3 target kind
//    token, plus a 5-sample reservoir per (reason, workspace) cell.
// ---------------------------------------------------------------------------
const targetClassHistogram = new Map(); // targetClass -> count
const reasonByTargetClassHistogram = new Map(); // "reason|targetClass" -> count
const workspaceReasonByRawKindHistogram = new Map(); // "reason|rawKind" -> count (workspace-only)
const reasonWorkspaceSamples = new Map(); // reason -> {seen, items:[]}
// Paso 0: the workspace-only sibling of `missingReasonPrefixHistogram` --
// this is the table the task brief actually asks for ("sub-reason x filas
// v4_missing con destino workspace"), since every non-workspace target is
// out of this task's recoverable scope by construction (§9.8.1).
const workspaceReasonPrefixHistogram = new Map();
if (CLASSIFY_TARGETS_ENABLED) {
  if (!args["corpus-root"]) {
    console.error(
      `[classify-targets] WARNING: --corpus-root not given, every v4_missing site will classify as "other"`,
    );
  }
  for (const [key, v3site] of v3ByKey) {
    const v4site = v4ByKey.get(key);
    if (v4site && v4site.confirmed) continue;
    const reason = v4PendingReason.get(key) ?? "unknown_no_pending_dump_match";
    const targetClass = classifyTarget(v3site.target_id, args["corpus-root"]);
    targetClassHistogram.set(targetClass, (targetClassHistogram.get(targetClass) ?? 0) + 1);
    const classKey = `${reason}|${targetClass}`;
    reasonByTargetClassHistogram.set(classKey, (reasonByTargetClassHistogram.get(classKey) ?? 0) + 1);
    if (targetClass === "workspace") {
      const rawKind = rawTargetKind(v3site.target_id);
      const kindKey = `${reason}|${rawKind}`;
      workspaceReasonByRawKindHistogram.set(kindKey, (workspaceReasonByRawKindHistogram.get(kindKey) ?? 0) + 1);
      const reasonPrefix = reason.split("/")[0];
      workspaceReasonPrefixHistogram.set(reasonPrefix, (workspaceReasonPrefixHistogram.get(reasonPrefix) ?? 0) + 1);
      let reservoirState = reasonWorkspaceSamples.get(reason);
      if (!reservoirState) {
        reservoirState = { seen: 0, items: [] };
        reasonWorkspaceSamples.set(reason, reservoirState);
      }
      reservoirPush(reservoirState, {
        path: v3site.path,
        start: v3site.start,
        v3_target: v3site.target_id,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Reverse diff: v4-confirmed sites absent from v3's confirmed population.
// ---------------------------------------------------------------------------
const reverseCounts = { v4_confirmed_v3_same: 0, v4_confirmed_v3_absent: 0 };
for (const [key, v4site] of v4ByKey) {
  if (!v4site.confirmed) continue;
  reverseCounts[v3ByKey.has(key) ? "v4_confirmed_v3_same" : "v4_confirmed_v3_absent"]++;
}

// ---------------------------------------------------------------------------
// 8. Report.
// ---------------------------------------------------------------------------
const v3Total = v3ByKey.size;
console.log("");
console.log("=== v4-references-parity-diff report ===");
console.log(`v3 confirmed core:references sites: ${v3Total}`);
console.log("");
console.log("-- forward histogram (every v3-confirmed site, classified by its v4 state) --");
for (const [bucket, count] of Object.entries(forwardCounts)) {
  const pct = ((count / v3Total) * 100).toFixed(2);
  console.log(`  ${bucket.padEnd(24)} ${String(count).padStart(8)}  (${pct}%)`);
}
console.log("");
console.log("-- v4_missing reason histogram (full reason, sub-reason suffix included) --");
for (const [reason, count] of [...missingReasonHistogram.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason.padEnd(40)} ${String(count).padStart(8)}`);
}
console.log("");
console.log("-- v4_missing reason histogram (prefix only, matches prior evidence docs) --");
for (const [reason, count] of [...missingReasonPrefixHistogram.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason.padEnd(32)} ${String(count).padStart(8)}`);
}
console.log("");
console.log("-- v4_missing v3-target-kind histogram --");
for (const [kind, count] of [...missingTargetKindHistogram.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kind.padEnd(24)} ${String(count).padStart(8)}`);
}
console.log("");
console.log("-- v4_missing reason x v3-target-kind cross-tab --");
for (const [crossKey, count] of [...reasonByKindHistogram.entries()].sort((a, b) => b[1] - a[1])) {
  const [reason, kind] = crossKey.split("|");
  console.log(`  ${reason.padEnd(32)} ${kind.padEnd(20)} ${String(count).padStart(8)}`);
}
console.log("");
if (CLASSIFY_TARGETS_ENABLED) {
  const missingTotal = forwardCounts.v4_missing;
  console.log("-- v4_missing target-class histogram (v3 target_id path bucket) --");
  for (const [cls, count] of [...targetClassHistogram.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((count / missingTotal) * 100).toFixed(2);
    console.log(`  ${cls.padEnd(16)} ${String(count).padStart(8)}  (${pct}% of v4_missing)`);
  }
  console.log("");
  console.log("-- v4_missing workspace-only reason histogram (prefix only) --");
  for (const [reason, count] of [...workspaceReasonPrefixHistogram.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(32)} ${String(count).padStart(8)}`);
  }
  console.log("");
  console.log("-- v4_missing reason x target-class cross-tab --");
  for (const [crossKey, count] of [...reasonByTargetClassHistogram.entries()].sort((a, b) => b[1] - a[1])) {
    const [reason, cls] = crossKey.split("|");
    console.log(`  ${reason.padEnd(32)} ${cls.padEnd(16)} ${String(count).padStart(8)}`);
  }
  console.log("");
  console.log("-- v4_missing workspace-only: reason x raw v3-target-kind cross-tab --");
  for (const [crossKey, count] of [...workspaceReasonByRawKindHistogram.entries()].sort((a, b) => b[1] - a[1])) {
    const [reason, kind] = crossKey.split("|");
    console.log(`  ${reason.padEnd(32)} ${kind.padEnd(16)} ${String(count).padStart(8)}`);
  }
  console.log("");
  console.log("-- v4_missing workspace-only samples: 5 random per reason --");
  for (const [reason, reservoirState] of [...reasonWorkspaceSamples.entries()].sort((a, b) => b[1].seen - a[1].seen)) {
    console.log(`  reason=${reason} (${reservoirState.seen} workspace sites, ${reservoirState.items.length} shown)`);
    for (const item of reservoirState.items) {
      console.log(`    ${item.path}:${item.start}  v3_target=${item.v3_target}`);
    }
  }
  console.log("");
}
console.log("-- reverse histogram (every v4-confirmed site, classified by its v3 state) --");
for (const [bucket, count] of Object.entries(reverseCounts)) {
  console.log(`  ${bucket.padEnd(28)} ${String(count).padStart(8)}`);
}
console.log("");

for (const [bucket, samples] of Object.entries(forwardBuckets)) {
  if (samples.length === 0) continue;
  console.log(`-- forward samples: ${bucket} (${samples.length} of ${forwardCounts[bucket]} shown) --`);
  for (const s of samples) {
    const extra =
      bucket === "v4_different_target"
        ? ` v3_target=${s.v3_target} v4_target=${s.v4_target}`
        : bucket === "v4_missing"
          ? ` reason=${s.reason} v3_target_kind=${s.v3_target_kind} v3_target=${s.v3_target}`
          : bucket === "v4_same_target"
            ? ` target=${s.v3_target}`
            : "";
    console.log(`  ${s.path}:${s.line}  ${JSON.stringify(s.snippet)}${extra}`);
  }
  console.log("");
}

if (args.out) {
  const { writeFileSync } = await import("node:fs");
  const fullReport = {
    v3Total,
    forwardCounts,
    missingReasonHistogram: Object.fromEntries(missingReasonHistogram),
    missingReasonPrefixHistogram: Object.fromEntries(missingReasonPrefixHistogram),
    missingTargetKindHistogram: Object.fromEntries(missingTargetKindHistogram),
    reasonByKindHistogram: Object.fromEntries(reasonByKindHistogram),
    ...(CLASSIFY_TARGETS_ENABLED
      ? {
          targetClassHistogram: Object.fromEntries(targetClassHistogram),
          workspaceReasonPrefixHistogram: Object.fromEntries(workspaceReasonPrefixHistogram),
          reasonByTargetClassHistogram: Object.fromEntries(reasonByTargetClassHistogram),
          workspaceReasonByRawKindHistogram: Object.fromEntries(workspaceReasonByRawKindHistogram),
          reasonWorkspaceSamples: Object.fromEntries(
            [...reasonWorkspaceSamples.entries()].map(([reason, state]) => [
              reason,
              { seen: state.seen, samples: state.items },
            ]),
          ),
        }
      : {}),
    reverseCounts,
    forwardSamples: forwardBuckets,
  };
  writeFileSync(args.out, JSON.stringify(fullReport, null, 2));
  console.error(`[report] wrote ${args.out}`);
}
