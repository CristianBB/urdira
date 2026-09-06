#!/usr/bin/env node
// Frente S-B.1 (2026-09-06, plan §4.4, R7/R8): measures the REAL
// distribution of entity-grain candidate documents' token counts, and how
// many segments each would produce under the pinned segmenter (256-token
// window, 32-token overlap, R7), against an ALREADY-INDEXED workspace. Ola 3
// runs this against a full n8n-scale workspace to fix `max_segments` (R8);
// this script itself is corpus-agnostic and is meant to be exercised here
// (S-B.2) against a small `tests/` fixture, never against n8n directly (that
// measurement is ola 3's own job, out of this frente's scope).
//
// Reuses the reconciler's OWN eligibility/rendering functions
// (`evaluateEntityEligibility`/`renderEntityDocument`/`leadingDocComment`,
// exported from `@urdira/engine` for exactly this purpose) and the
// production segmenter (`segmentByTokens`, `@urdira/embedding-local`) --
// never a separately-maintained reimplementation that could drift from what
// `reconcileSemanticProjection`'s entity pass actually does.
//
// Usage:
//   node scripts/semantic-window-histogram.mjs --data <dataDir> \
//     [--corpus <dir>] [--workspace-id <id>] [--provider local|hash] \
//     [--model-cache-dir <dir>] [--window-tokens 256] [--overlap-tokens 32]
//
// --data <dataDir>        A `URDIRA_DATA_ROOT`-shaped directory holding an
//                          ALREADY-SCANNED (ready, published at least one
//                          generation) workspace to measure.
// --corpus <dir>           Accepted for interface parity with the ola-3
//                          runbook (which scans a corpus checkout into
//                          --data before running this script) -- this
//                          script itself never reads --corpus's own files,
//                          only the already-indexed workspace at --data.
// --workspace-id <id>      Which registered workspace to measure. Defaults
//                          to the sole registered workspace under --data
//                          (errors if there is not exactly one and this is
//                          omitted).
// --provider local|hash    Default `local`: loads the bundled MiniLM
//                          tokenizer OFFLINE (`allow_download:false`) --
//                          never touches the network; errors with a clear
//                          message (exit 3) if the model is not already
//                          provisioned, rather than silently downloading or
//                          silently falling back. `hash`: the chars/4 token
//                          estimate every non-neural provider uses (no
//                          model, no cache dir needed at all) -- this is
//                          what makes the script runnable against a tiny
//                          tests/ fixture with no model provisioned.
// --model-cache-dir <dir>  Overrides where `--provider local` looks for the
//                          model. Defaults to `<data>/models`, falling back
//                          to `~/.urdira/models` if that path does not
//                          exist.
// --window-tokens/--overlap-tokens  Override R7's pinned 256/32 for the
//                          segment-count distribution this script reports
//                          (never for the token-count histogram itself,
//                          which is window-independent). Default 256/32.
//
// Exit code: 0 on a completed measurement (even zero eligible documents);
// 2 for a usage/argument error; 3 if `--provider local` was requested but
// the model is not available offline.

import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeCanonical } from "@urdira/canonical";
// Frente S-B.1: `@urdira/storage`/`@urdira/engine`/`@urdira/embedding-local`
// are workspace packages the ROOT package.json does not list as a
// dependency, so they are NOT symlinked into the repo root's own
// `node_modules/@urdira/*` (unlike `@urdira/canonical`, which is) --
// resolved here via a relative path to each package's own BUILT `dist/`
// output instead (this script must run AFTER `pnpm --filter <pkg> build`,
// same as every other build-then-run step in this codebase's own `test`
// script chain), matching the same "root scripts read the workspace as a
// consumer, not via bare specifiers that need root-level dependency
// declarations" constraint every other `scripts/*.mjs` file in this
// directory already works within.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const {
  DEFAULT_MIN_ENTITY_SPAN_LENGTH,
  INELIGIBLE_ENTITY_RECORD_KIND,
  decodeEntityRecordBody,
  evaluateEntityEligibility,
  leadingDocComment,
  renderEntityDocument,
} = await import(join(REPO_ROOT, "packages/engine/dist/index.js"));
const { createDurableStorage, hydrateRelationalValue } = await import(join(REPO_ROOT, "packages/storage/dist/index.js"));
const { segmentByTokens, createLocalNeuralProvider, createLocalTokenCounter } = await import(join(REPO_ROOT, "packages/embedding-local/dist/index.js"));
const { CHARS_PER_TOKEN_ESTIMATE } = await import(join(REPO_ROOT, "packages/engine/dist/index.js"));

const EMBEDDABLE_TOKEN_PATTERN = /[A-Za-z0-9_$]/;
// Effectively unbounded -- this script measures the UNCAPPED distribution;
// R8's real `max_segments` decision is made by ola 3 from these numbers, not
// baked into this script as an assumption.
const MEASURE_MAX_SEGMENTS = 1_000_000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { args.help = true; continue; }
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
      "usage: semantic-window-histogram.mjs --data <dataDir> [--corpus <dir>] [--workspace-id <id>]",
      "         [--provider local|hash] [--model-cache-dir <dir>] [--window-tokens 256] [--overlap-tokens 32]",
      "",
      "  --data <dataDir>          a URDIRA_DATA_ROOT-shaped directory with an already-scanned workspace",
      "  --corpus <dir>            accepted for interface parity with the ola-3 runbook; never read directly",
      "  --workspace-id <id>       which registered workspace to measure (default: the sole one under --data)",
      "  --provider local|hash     local (default): real MiniLM tokenizer, offline only; hash: chars/4 estimate",
      "  --model-cache-dir <dir>   override for --provider local (default: <data>/models, then ~/.urdira/models)",
      "  --window-tokens <n>       segment-count distribution window (default 256, R7's pin)",
      "  --overlap-tokens <n>      segment-count distribution overlap (default 32, R7's pin)",
      "  --help, -h                print this usage and exit 0",
    ].join("\n"),
  );
}

function percentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return 0;
  const index = Math.min(sortedAscending.length - 1, Math.floor(fraction * sortedAscending.length));
  return sortedAscending[index];
}

function printHistogram(label, values) {
  const sorted = [...values].sort((left, right) => left - right);
  const max = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
  console.log(`${label}: n=${sorted.length} p50=${percentile(sorted, 0.5)} p90=${percentile(sorted, 0.9)} p99=${percentile(sorted, 0.99)} max=${max}`);
}

async function resolveTokenizers(provider, cacheDir, windowTokens, overlapTokens) {
  if (provider === "hash") {
    return {
      // A direct chars/4 estimate -- NOT `segmentByTokens(..., {window_tokens: 1, ...}).segments.length`:
      // for the LINE-fallback path (which both the hash estimator and this
      // package's own bundled MiniLM tokenizer route through -- see
      // `createLocalTokenCounter`'s own doc comment), a `window_tokens: 1`
      // cap degenerates to "one segment per LINE", not "one segment per
      // estimated token", silently undercounting any multi-token line.
      tokenCount: (text) => Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)),
      segmentCount: (text) => segmentByTokens(text, undefined, { window_tokens: windowTokens, overlap_tokens: overlapTokens, max_segments: MEASURE_MAX_SEGMENTS }).segments.length,
      close: async () => undefined,
    };
  }
  // `createLocalTokenCounter` loads just the tokenizer side for an accurate
  // TOTAL token count (see its own doc comment for why a `window_tokens: 1`
  // segmentation trick would undercount); `createLocalNeuralProvider` (a
  // SEPARATE instance) provides the real R7-window segment distribution via
  // its own `.binding.segment`. Both load the SAME cached model OFFLINE
  // (`allow_download: false`) -- a one-time cost for this diagnostic
  // script, never a hot path.
  const tokenCounter = await createLocalTokenCounter({ cache_dir: cacheDir, allow_download: false });
  const segmenter = await createLocalNeuralProvider({ cache_dir: cacheDir, allow_download: false, window_tokens: windowTokens, overlap_tokens: overlapTokens, max_segments: MEASURE_MAX_SEGMENTS });
  return {
    tokenCount: (text) => tokenCounter.countTotalTokens(text),
    segmentCount: async (text) => (await segmenter.binding.segment(text)).segments.length,
    close: async () => undefined,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); process.exit(0); }
  if (!args.data) { console.error("error: --data <dataDir> is required"); printUsage(); process.exit(2); }
  const provider = args.provider ?? "local";
  if (provider !== "local" && provider !== "hash") { console.error(`error: --provider must be "local" or "hash", got "${provider}"`); process.exit(2); }
  const windowTokens = Number(args["window-tokens"] ?? "256");
  const overlapTokens = Number(args["overlap-tokens"] ?? "32");
  if (!Number.isSafeInteger(windowTokens) || windowTokens <= 0) { console.error("error: --window-tokens must be a positive integer"); process.exit(2); }
  if (!Number.isSafeInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= windowTokens) { console.error("error: --overlap-tokens must be a non-negative integer smaller than --window-tokens"); process.exit(2); }

  const storage = await createDurableStorage({ rootDir: args.data });
  try {
    const workspaces = await storage.catalog.listWorkspaces();
    const workspaceId = args["workspace-id"] ?? (workspaces.length === 1 ? workspaces[0].workspace_id : undefined);
    if (!workspaceId) {
      console.error(workspaces.length === 0
        ? `error: no registered workspace found under ${args.data}`
        : `error: ${workspaces.length} registered workspaces under ${args.data}; pass --workspace-id (one of: ${workspaces.map((entry) => entry.workspace_id).join(", ")})`);
      process.exit(2);
    }

    const opened = await storage.openWorkspaceReadOnly(workspaceId);
    try {
      const currentState = await opened.database.get("SELECT current_generation FROM workspace_current_state WHERE workspace_id = ?", [workspaceId]);
      const generation = currentState?.current_generation;
      if (generation === undefined) { console.error(`error: workspace ${workspaceId} has never published a generation`); process.exit(2); }

      const rows = await opened.database.all(
        `SELECT record_occurrences.record_id AS record_id, record_occurrences.kind AS record_kind,
                record_occurrences.owner_artifact_id AS owner_artifact_id, record_occurrences.owner_artifact_version_id AS owner_artifact_version_id,
                record_occurrences.valid_from_generation AS valid_from_generation, record_occurrences.body_payload AS body_payload,
                artifact_versions.content_hash AS content_hash, artifact_versions.byte_length AS byte_length,
                source_artifacts.display_path AS display_path
           FROM record_occurrences
           JOIN artifact_versions ON artifact_versions.workspace_id = record_occurrences.workspace_id
            AND artifact_versions.artifact_id = record_occurrences.owner_artifact_id
            AND artifact_versions.artifact_version_id = record_occurrences.owner_artifact_version_id
           JOIN source_artifacts ON source_artifacts.workspace_id = record_occurrences.workspace_id AND source_artifacts.artifact_id = record_occurrences.owner_artifact_id
          WHERE record_occurrences.workspace_id = ? AND record_occurrences.category = 'entity' AND record_occurrences.kind <> ?
            AND artifact_versions.encoding <> 'binary'
            AND record_occurrences.valid_from_generation <= ?
            AND (record_occurrences.valid_to_generation IS NULL OR record_occurrences.valid_to_generation > ?)
          ORDER BY record_occurrences.owner_artifact_version_id, record_occurrences.record_id`,
        [workspaceId, INELIGIBLE_ENTITY_RECORD_KIND, generation, generation],
      );
      console.error(`[histogram] workspace=${workspaceId} generation=${generation} candidate entity records (pre-eligibility)=${rows.length}`);

      let cacheDir;
      if (provider === "local") {
        const dataCacheDir = join(args.data, "models");
        const fallbackCacheDir = join(homedir(), ".urdira", "models");
        cacheDir = args["model-cache-dir"] ?? (existsSync(dataCacheDir) ? dataCacheDir : fallbackCacheDir);
      }

      let tokenizers;
      try {
        tokenizers = await resolveTokenizers(provider, cacheDir, windowTokens, overlapTokens);
      } catch (error) {
        console.error(`[histogram] --provider local requires the MiniLM model already provisioned offline at ${cacheDir} -- not found or not loadable (${error instanceof Error ? error.message : String(error)}). Re-run with --provider hash, or provision the model first ("urdira workspace configure").`);
        process.exit(3);
      }

      const ownerTextCache = new Map();
      async function ownerText(row) {
        if (ownerTextCache.has(row.owner_artifact_version_id)) return ownerTextCache.get(row.owner_artifact_version_id);
        let text;
        try {
          const bytes = await storage.cas.read(row.content_hash);
          text = Buffer.from(bytes).toString("utf-8");
        } catch {
          text = undefined;
        }
        ownerTextCache.set(row.owner_artifact_version_id, text);
        return text;
      }

      let skippedUnreadableFile = 0;
      let skippedUndecodableBody = 0;
      let skippedIneligible = 0;
      let skippedEmpty = 0;
      let eligible = 0;
      const tokenCounts = [];
      const segmentCountsAtWindow = [];

      for (const row of rows) {
        const fileText = await ownerText(row);
        if (fileText === undefined) { skippedUnreadableFile += 1; continue; }
        let body;
        try {
          if (row.body_payload == null) {
            // Older/relational body storage: reconstruct from `record_value_nodes`
            // -- the exact same fallback `reconcileSemanticProjection`'s own
            // entity pass (step 5) uses, see that function's doc comment.
            const valueRows = await opened.database.all(
              "SELECT workspace_id, record_id, valid_from_generation, value_path, parent_path, sequence_ordinal, map_key, value_kind, text_value, integer_value, real_value, bool_value, bytes_value FROM record_value_nodes WHERE workspace_id = ? AND record_id = ? AND valid_from_generation = ? ORDER BY value_path",
              [workspaceId, row.record_id, row.valid_from_generation],
            );
            const hydrated = hydrateRelationalValue(valueRows);
            body = hydrated !== null && typeof hydrated === "object" && !Array.isArray(hydrated) ? hydrated : {};
          } else {
            body = decodeEntityRecordBody(decodeCanonical(row.body_payload instanceof Uint8Array ? row.body_payload : new Uint8Array(row.body_payload)));
          }
        } catch {
          skippedUndecodableBody += 1;
          continue;
        }
        const eligibility = evaluateEntityEligibility(row.record_kind, body, fileText, DEFAULT_MIN_ENTITY_SPAN_LENGTH);
        if (!eligibility.eligible) { skippedIneligible += 1; continue; }
        const spanText = fileText.slice(eligibility.start, eligibility.end);
        const docComment = leadingDocComment(fileText, eligibility.start);
        const embeddingText = renderEntityDocument({ kind: eligibility.kind, label: eligibility.label, docComment, spanText });
        if (!EMBEDDABLE_TOKEN_PATTERN.test(embeddingText)) { skippedEmpty += 1; continue; }

        eligible += 1;
        tokenCounts.push(await tokenizers.tokenCount(embeddingText));
        segmentCountsAtWindow.push(await tokenizers.segmentCount(embeddingText));
      }
      await tokenizers.close();

      console.log(`provider=${provider} window_tokens=${windowTokens} overlap_tokens=${overlapTokens}`);
      console.log(`eligible=${eligible} skipped_unreadable_file=${skippedUnreadableFile} skipped_undecodable_body=${skippedUndecodableBody} skipped_ineligible=${skippedIneligible} skipped_empty=${skippedEmpty}`);
      if (eligible === 0) {
        console.log("no eligible entity documents to measure.");
        return;
      }
      printHistogram("tokens", tokenCounts);
      const overWindow = tokenCounts.filter((count) => count > windowTokens).length;
      const overWindowTimesMax = tokenCounts.filter((count) => count > windowTokens * 64).length;
      console.log(`fraction > ${windowTokens} tokens: ${(overWindow / eligible).toFixed(4)} (${overWindow}/${eligible})`);
      console.log(`fraction > ${windowTokens}*64=${windowTokens * 64} tokens: ${(overWindowTimesMax / eligible).toFixed(4)} (${overWindowTimesMax}/${eligible})`);
      printHistogram(`segments (window=${windowTokens} overlap=${overlapTokens})`, segmentCountsAtWindow);
      const segmentDistribution = new Map();
      for (const count of segmentCountsAtWindow) segmentDistribution.set(count, (segmentDistribution.get(count) ?? 0) + 1);
      console.log("segment count distribution (segments -> document count):");
      for (const [count, documents] of [...segmentDistribution.entries()].sort((left, right) => left[0] - right[0])) console.log(`  ${count}\t${documents}`);
    } finally {
      await opened.close();
    }
  } finally {
    await storage.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
