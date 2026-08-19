# Entity-Grain Semantic Documents and Segment Vectors

Status: **Approved** (owner 2026-08-13: measure-then-approve; the measurement gate
below was run the same day and holds. Owner priority: embed must be as fast as
possible.)
Last updated: 2026-08-13

## Measurement gate results (2026-08-13, excalidraw-wt5 / workspace fedcd2b0, bench in job b84c46a9 tmp/entity-grain-bench.mjs)

Corpus was built from the REAL live entity records of the bench workspace (17,787
candidate entities), applying this doc's eligibility policy (top-level approximated
by column-0 declaration, span >= 120 chars, parameters/locals never eligible):

- **Eligible corpus: 2,544 entity docs** -- inside the 2-4k estimate. By kind:
  2,008 variable, 182 type, 143 function, 81 class, 77 interface, 25 property,
  15 method, 11 namespace, 2 enum. Doc sizes: p50 572 chars (1 provider window),
  p90 3.4k, p99 12k.
- **Embed cost: 83.9s one-time per workspace** (33ms/doc, 30.3 docs/s) through the
  real bundled MiniLM q8 provider with `generateVectors` batching (batch 64, CPU).
  Well under the 5-8 min estimate; combined with the existing ~120s artifact pass
  the initial embed stays in the low minutes.
- **Exact-scan latency** (`exactVectorScan`, cosine, 384 dims, limit 50, median of
  20): 1,000 vectors 29ms / 2,500 42ms / 5,000 85ms / 10,000 169ms. At the ~3.5k
  total vectors this workspace would carry (~1k artifact + ~2.5k entity), the scan
  stays under ~60ms; the 5k gate point is 85ms -- double-digit, accepted.
- **Scan headroom noted:** the cost is ~17us/vector, dominated by per-candidate
  byte->number[] decoding inside the scan (DataView + Array.from per query). If the
  entity lane ever pushes latency out of budget, pre-decoding candidates into
  Float32Array once per corpus load is an order-of-magnitude lever -- no ANN needed.
- **Policy amendment from measurement:** module/whole-file entities must be
  INELIGIBLE for entity documents -- they duplicate the artifact-grain document of
  the same file (654 of them on this corpus, including 400KB+ spans). The
  eligibility list above already reflects this.
Depends on: [Semantic search and ranking](06-semantic-search-ranking.md), [Semantic search wiring](16-semantic-search-wiring.md)

## Decision objective

Complete decision 06's dual-document-view architecture: add entity-grain documents
(one vector per code entity) and persisted segment vectors (span-addressable windows
of long documents) on top of the shipped artifact-grain v1, so `core:search_semantic`
can answer "which FUNCTION does X" instead of only "which FILE mentions X", and can
point at a span inside a large file instead of the whole file.

## Context

Decision 16 shipped artifact-grain v1 deliberately: one vector per visible artifact
version, whole-file rendering, exact scan. Measured on excalidraw (975 embeddable
files): ~120s/workspace initial embed under the bundled ONNX model. The same corpus
holds ~26.7k entities -- a naive one-vector-per-entity design multiplies embed cost
by ~27x and pushes the exact-scan candidate set from ~1k to ~28k vectors per
workspace. Both are tractable only with batch embedding (shipped separately) and a
deliberate eligibility policy.

## Proposed decision

- **Eligibility, not exhaustiveness.** Entity documents are generated only for
  entities that are (a) exported or top-level (the analyzer already computes the
  exported surface -- `exportedDeclarations` in
  `packages/plugin-javascript-typescript/src/analyzer.ts`), and (b) span at least a
  minimum source length (default 120 chars; parameters/locals never qualify). This
  bounds the corpus to roughly the entities a person would name in a query, an
  order-of-magnitude reduction from "every declaration". The policy knobs live in
  the reconciler input, digested into the document rendering identity.
- **Rendering (PINNED once approved).** An entity document is
  `<kind> <qualified_name>\n<leading doc comment if present>\n<source span text>`,
  truncated to the provider's document budget. The renderer consumes the existing
  `jsts:semantic_preparation` projection rows (kind, qualified name, path, span) plus
  artifact text already available to the reconciler -- no new analyzer output needed.
- **Identity.** One vector row per (entity identity record, artifact version,
  provider identity), with `document_id` derived from the owning entity RECORD id --
  the same content-derived identity machinery records already have (decision 11), so
  an unchanged entity in a changed file keeps its vector only if its own record
  reused (same record_id => same source span content => same rendered document).
  Profile scoping follows `semanticVectorProjectionRecordId` exactly (decision 16's
  profile-swap lesson).
- **Maintenance.** The semantic reconciler grows a second pass alongside the
  artifact pass, same marker/failure/skip discipline, same worker-thread execution,
  same generation-held-still rule. The completion marker gains a
  `document_grains: ["artifact", "entity"]` field; a marker written by an older
  daemon (artifact-only) reads as incomplete for entity coverage, triggering the
  entity backfill without disturbing artifact vectors.
- **Query.** `core:search_semantic` gains `subject_types` discrimination between
  artifact-grain and entity-grain results (both scanned under the same exact-scan
  cap, entity lane capped separately); hybrid fuses all three lanes (lexical,
  semantic-artifact, semantic-entity) with RRF as today. Results carry the entity's
  span so clients land on the declaration, not the file top.
- **Segment vectors (second increment).** For artifact documents exceeding one
  provider window, persist each window's vector (bounded by the existing
  `max_windows` cap) alongside the mean-pooled document vector, tagged with its char
  range. Retrieval scans document vectors first and only expands the winners'
  segments to refine the reported span -- segments never enter the primary
  candidate scan, so the scan cost stays at document count, not window count.

## Costs and gates

- Embed cost at excalidraw scale with eligibility policy: est. 2-4k entity docs
  (~5-8 min initial with batching, per-workspace, one-time) -- must be measured on
  the bench fleet before approval.
- Exact-scan latency with ~5k vectors/workspace must stay in the current tens-of-ms
  envelope (it scales linearly; measure).
- No schema migration: vector rows/shards already carry arbitrary document ids;
  only the marker format gains a field (older markers remain readable).

## Explicitly out of scope

Cross-workspace vector sharing, ANN indexing (decision 06 pins exact scan), and any
change to the record diet decision (declined 2026-08-13; entity documents read
existing records, they never add new ones).
