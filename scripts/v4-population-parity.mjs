#!/usr/bin/env node
// 2026-09-06 flecos-v4 task, F.1 "guard ⊇" (plan §3.1 item 3): the SECOND
// direction of the v3/v4 record-population invariant. `scripts/v4-
// references-parity-diff.mjs`/`v4-call-parity-diff.mjs` already gate
// "v4 ⊆ v3" (every v3-confirmed site v4 must reproduce with the SAME
// target, `different == 0`); this script gates the other direction,
// "v3 ⊆ v4" by POPULATION SIZE (not per-site identity -- a coarser, cheaper
// check that a whole record KIND never silently regresses): for each kind
// in `scripts/v4-population-floors.json`, v4's own count must clear an
// absolute floor (§0 rule R5: `0.99 x` the accepted n8n figure) and,
// where a v3 analog exists, the v4/v3 ratio must not fall below a stored
// (also provisional, `0.99x`-padded) ratio.
//
// v3's `record_occurrences` table stores the SAME `kind` vocabulary v4 does
// directly in a SQL column (`jsts:entity_callable`, `jsts:relation_
// contains`, ... -- confirmed live, docs/evidence/2026-09-02-v4-p0-s4-
// promotion-gap.md's own "Top record_occurrences.kind by count" table), so
// unlike `v4-references-parity-diff.mjs`/`v4-call-parity-diff.mjs` this
// script needs NO `@urdira/canonical` body decode at all for a population
// count -- a plain `GROUP BY kind` (restricted to VISIBLE rows,
// `valid_to_generation IS NULL`, the same convention every other parity
// script here already uses) is the whole v3 side.
//
// v4's side is a `kind\tcount` TSV -- written by `crates/urdira-indexing-
// worker/src/v4/tests_e2e.rs`'s `n8n_population_floors` test via
// `URDIRA_V4_POPULATION_DUMP=<path>` (see that test's own doc comment for
// the exact runbook), OR by any equivalent tool that counts a real v4
// store's visible records by `Dictionaries::kinds[view.kind_id()]` the same
// way (plus the two `identity_key`-prefix-derived `external_module`/
// `external_symbol` rows and a `records_total` row -- see that test's own
// doc comment for why those three are not a plain `kind` group-by).
//
// Usage:
//   node scripts/v4-population-parity.mjs \
//     --v3-db <path/to/v3-oracle.sqlite> \
//     --v4-populations <path/to/populations.tsv> \
//     [--floors scripts/v4-population-floors.json] \
//     [--out <path/to/report.json>]
//
// Exit code: 0 if every kind clears its floor AND (where a ratio is stored,
// `ratio > 0`) its v4/v3 ratio; non-zero (the exact bit position of the
// first fatal condition class this run hit, `1` for "any floor breach",
// added to `2` for "any ratio breach", so `3` means both) otherwise.
//
// `--help`/`-h`: prints this usage and exits 0 without touching either
// input file -- safe to run with no other args to sanity-check the script
// is wired up at all (this task's own verification requirement).

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FLOORS_PATH = join(SCRIPT_DIR, "v4-population-floors.json");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    args[key] = value;
    i++;
  }
  return args;
}

function printUsage() {
  console.log(
    [
      "usage: v4-population-parity.mjs --v3-db <path> --v4-populations <path> [--floors <path>] [--out <path>]",
      "",
      "  --v3-db <path>            v3 oracle SQLite database (record_occurrences table)",
      "  --v4-populations <path>   kind\\tcount TSV, e.g. from `n8n_population_floors`'s",
      "                            URDIRA_V4_POPULATION_DUMP output",
      "  --floors <path>           population-floors JSON (default: scripts/v4-population-floors.json)",
      "  --out <path>              optional: write the full report as JSON",
      "  --help, -h                print this usage and exit 0",
      "",
      "Exit code: 0 if every kind clears its floor and its stored v4/v3 ratio (where one is",
      "stored); otherwise non-zero.",
    ].join("\n"),
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}
for (const required of ["v3-db", "v4-populations"]) {
  if (!args[required]) {
    console.error(`missing required --${required}`);
    printUsage();
    process.exit(2);
  }
}

const floorsPath = args.floors ?? DEFAULT_FLOORS_PATH;
let floorsDoc;
try {
  floorsDoc = JSON.parse(readFileSync(floorsPath, "utf8"));
} catch (error) {
  console.error(`failed to read/parse --floors ${floorsPath}: ${error.message}`);
  process.exit(2);
}
const floorEntries = floorsDoc.kinds ?? {};

// ---------------------------------------------------------------------------
// 1. v4 populations: `kind\tcount` TSV.
// ---------------------------------------------------------------------------
function readV4Populations(path) {
  const text = readFileSync(path, "utf8");
  const counts = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) {
      console.error(`[v4-populations] WARNING: skipping malformed line (no tab): ${JSON.stringify(line)}`);
      continue;
    }
    const kind = line.slice(0, tab);
    const count = Number(line.slice(tab + 1));
    if (!Number.isFinite(count)) {
      console.error(`[v4-populations] WARNING: skipping non-numeric count for ${kind}: ${JSON.stringify(line)}`);
      continue;
    }
    counts.set(kind, count);
  }
  return counts;
}

console.error(`[v4-populations] reading ${args["v4-populations"]}`);
const v4Counts = readV4Populations(args["v4-populations"]);
console.error(`[v4-populations] ${v4Counts.size} kinds`);

// ---------------------------------------------------------------------------
// 2. v3 populations: SQL `GROUP BY kind` over `record_occurrences`, visible
//    rows only (`valid_to_generation IS NULL`, same convention every other
//    parity script here uses) -- no body decode needed, see this file's own
//    header comment for why.
// ---------------------------------------------------------------------------
console.error(`[v3-db] opening ${args["v3-db"]} (read-only)`);
const v3Db = new DatabaseSync(args["v3-db"], { readOnly: true });
const v3CountByKind = new Map();
let v3RecordsTotal = 0;
{
  const started = Date.now();
  const stmt = v3Db.prepare(
    "select kind, count(*) as n from record_occurrences where valid_to_generation is null group by kind",
  );
  for (const row of stmt.iterate()) {
    v3CountByKind.set(row.kind, Number(row.n));
    v3RecordsTotal += Number(row.n);
  }
  console.error(
    `[v3-db] ${v3CountByKind.size} distinct kinds, ${v3RecordsTotal} visible rows total (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
}
v3Db.close();

// ---------------------------------------------------------------------------
// 3. Cross-check every floor entry.
// ---------------------------------------------------------------------------
const FATAL_FLOOR = 1;
const FATAL_RATIO = 2;
let exitCode = 0;
const rows = [];

for (const [kind, entry] of Object.entries(floorEntries)) {
  const v4Count = v4Counts.get(kind) ?? 0;
  const floor = entry.floor ?? 0;
  const ratio = entry.ratio ?? 0;
  // `records_total` gets its v3 comparator from the SUM of every visible
  // row (informational only, per its own `_note` in the floors JSON --
  // still printed, but the ratio gate is skipped since `ratio` is stored
  // as 0 for this row); every other kind with a `v3_kind` looks up that
  // exact SQL `kind` value; a `v3_kind: null` entry (no v3 analog at all,
  // e.g. `jsts:entity_parameter`/`external_module`/`external_symbol`) has
  // no v3 count to show.
  const v3Count =
    kind === "records_total" ? v3RecordsTotal : entry.v3_kind === null || entry.v3_kind === undefined ? undefined : (v3CountByKind.get(entry.v3_kind) ?? 0);

  const floorOk = v4Count >= floor;
  if (!floorOk) exitCode |= FATAL_FLOOR;

  let observedRatio;
  let ratioOk = true;
  if (ratio > 0 && v3Count !== undefined && v3Count > 0) {
    observedRatio = v4Count / v3Count;
    ratioOk = observedRatio >= ratio;
    if (!ratioOk) exitCode |= FATAL_RATIO;
  }

  rows.push({
    kind,
    v3: v3Count,
    v4: v4Count,
    ratio: observedRatio,
    floor,
    storedRatio: ratio > 0 ? ratio : undefined,
    ok: floorOk && ratioOk,
  });
}

// ---------------------------------------------------------------------------
// 4. Report.
// ---------------------------------------------------------------------------
console.log("");
console.log("=== v4-population-parity report ===");
console.log(`${"kind".padEnd(28)} ${"v3".padStart(10)} ${"v4".padStart(10)} ${"v4/v3".padStart(8)} ${"floor".padStart(10)} ok`);
for (const row of rows) {
  const v3Text = row.v3 === undefined ? "n/a".padStart(10) : String(row.v3).padStart(10);
  const ratioText = row.ratio === undefined ? "n/a".padStart(8) : row.ratio.toFixed(3).padStart(8);
  console.log(
    `${row.kind.padEnd(28)} ${v3Text} ${String(row.v4).padStart(10)} ${ratioText} ${String(row.floor).padStart(10)} ${row.ok ? "OK" : "FAIL"}`,
  );
}
console.log("");
if (exitCode === 0) {
  console.log("all kinds clear their floor and stored ratio (where one applies)");
} else {
  if (exitCode & FATAL_FLOOR) console.log("FAIL: at least one kind fell below its absolute floor");
  if (exitCode & FATAL_RATIO) console.log("FAIL: at least one kind fell below its stored v4/v3 ratio");
}

if (args.out) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(args.out, JSON.stringify({ rows, exitCode }, null, 2));
  console.error(`[report] wrote ${args.out}`);
}

process.exit(exitCode);
