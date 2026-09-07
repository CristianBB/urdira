# Semantic Search Runtime

Status: **Approved and implemented**
Last updated: 2026-08-24
Depends on: [Semantic search and ranking](06-semantic-search-ranking.md) and [transactional projection digests](13-transactional-projection-digests.md)

## Current contract

`core:search_semantic` and `core:search_hybrid` use incrementally maintained
semantic documents and vectors through one resolved provider identity. Every
vector, materialization marker, profile, and runtime binding is pinned to that
identity so incomparable vector spaces are never mixed.

The default provider is the local neural provider in
`@urdira/embedding-local`, using `Xenova/all-MiniLM-L6-v2` through the pinned
Transformers.js/ONNX runtime. Long inputs are windowed under explicit provider
budgets, mean-pooled, and L2-normalized. The hash provider is available for
hermetic testing and explicit diagnostics; the HTTP provider is opt-in and is
never selected implicitly.

## Provisioning and isolation

Model weights are not bundled in release archives. A local neural model may be
downloaded only during an explicit workspace/configuration administrative
operation. The operation reports provisioning progress. Daemon startup,
indexing, querying, cursor continuation, replay, and semantic maintenance run
with downloads disabled.

`SemanticProviderDescriptor` is a serializable provider description. The
daemon builds neural providers with `allow_download: false`; only the
configure-time provisioning function may enable acquisition. If assets are
unavailable, structural indexing remains operational, semantic search reports
its registered unavailable state, and hybrid search uses its lexical lane with
explicit coverage metadata.

Neural embedding runs in the semantic worker process. The process boundary
contains provider failure and avoids blocking structural/query event-loop work.
Worker restart or provider failure never changes the last published structural
snapshot.

## Maintenance and retrieval

Semantic maintenance reconciles eligible artifact and entity documents against
the current structural generation. It closes stale rows before publishing
replacement vectors and writes a completion marker only for the exact provider
and source generation it finished.

Retrieval performs an exact scan over every visible vector that matches the
provider identity and structural filters, then applies the registered semantic
or hybrid ranking profile. It does not sample or silently narrow the corpus.
`core:search_semantic` returns `core:semantic_index_unavailable` when no usable
provider/materialization exists. `core:search_hybrid` may continue through its
lexical lane and reports the semantic lane as unavailable or incomplete.

Coverage maps directly to the public evaluation state:

- complete materialization: `ready`;
- partial valid materialization: `partial`;
- stale or still-building materialization: `updating`; and
- absent or unsupported provider: `unsupported`.

An item-specific generation failure is represented in semantic coverage and
diagnostics. It does not deactivate the language plugin or invalidate canonical
structural records.

## Provider changes

Changing model, runtime build, dtype, dimensions, rendering, windowing, or
configuration produces a new provider/profile identity. Maintenance closes the
old identity's current vectors and re-embeds eligible documents. Vectors are
not converted or reused across provider identities or machines.

## Consequences

- Semantic search is local and offline during normal operation.
- Model acquisition is explicit, bounded to administration, and visible to the
  user.
- Structural readiness never depends on model availability.
- Exact retrieval and completeness reporting remain deterministic and
  auditable.

## Amendment 2026-09-06 (Frente S-B): HTTP provider batching, retries, configuration

R12 (plan `generic-waddling-hartmanis.md` §0): the opt-in HTTP embedding
provider (`createHttpEmbeddingProvider`) is now a complete, production-grade
transport, not a single unbatched fire-and-forget request. `generateVectors`
splits its inputs into sequential (concurrency 1 -- never `Promise.all`)
requests, each capped at `max_batch_inputs` (default 64) items AND an
estimated `max_input_tokens` (default 8192, chars/4) total, always keeping
at least one item per request so a single oversized document still makes
progress. Each request retries up to `retry_backoff_ms.length` times
(default `[500, 1000, 2000]`ms, 3 retries / 4 total attempts) on a 429/5xx
status or a network-level failure (including this provider's own 60s
per-attempt timeout) -- never on a malformed-but-successfully-received
response body (wrong dimensionality, non-finite values, missing fields),
which is a provider contract bug retrying cannot fix. Exhausting every
retry (or an immediate non-retryable 4xx) raises the typed
`HttpEmbeddingProviderUnavailableError` (`code: "core:embedding_provider_unavailable"`)
for that batch; the reconciler's existing per-document fallback isolates
which document(s) in a failed batch actually matter and marks each
`failed` with a `provider_error:*` reason, exactly as it already did for
any other provider throw. `api_key` continues to come from
`URDIRA_EMBEDDINGS_API_KEY`/the descriptor, never a digest field.

Configuration surface: this app has always selected its semantic provider
kind (`neural`/`hash`/`http`) via environment variables read once at daemon
start (`apps/urdira/src/index.ts`'s `resolveSemanticDescriptor`), never a
per-call `workspace configure`/`config set` RPC argument for any provider
kind -- widening that existing surface with two more optional variables,
`URDIRA_EMBEDDINGS_MAX_BATCH_INPUTS`/`URDIRA_EMBEDDINGS_MAX_INPUT_TOKENS`,
is the minimal, architecture-consistent way to expose the two new knobs.
Decided in implementation: no new CLI flags were added to `packages/cli` for
this -- doing so would mean designing a new RPC-argument-based provider
configuration channel this system has never had for ANY provider kind
(the descriptor is fixed at daemon start, not mutable via RPC today), which
exceeds "add a missing flag" and was not attempted speculatively.
`ensureSemanticAssets` for an `http` descriptor now logs an explicit
"external HTTP endpoint; no local model download" notice at configure time
(previously a silent no-op), so an operator who configures `http` sees
confirmation this is the expected behavior rather than a missed
provisioning step. Local MiniLM remains the shipped default; the evaluated
model pack stays rejected (decision 06/18).

### Amendment 2026-09-06 (adversarial review item #9): environment variable reference

Every knob `resolveSemanticDescriptor` (`apps/urdira/src/index.ts`) reads is
resolved ONCE, from `process.env`, at daemon start -- there was previously no
single place documenting the full list for an operator or agent to discover
them short of reading that function's own source. Consolidated here (this is
now the canonical reference; keep it in sync with `resolveSemanticDescriptor`'s
own doc comment if the set of variables changes):

| Variable | Applies to | Effect |
|---|---|---|
| `URDIRA_EMBEDDINGS_PROVIDER` | selection | `"hash"` selects the pure-JS hermetic hash provider; anything else (unset included) falls through to `neural` unless `URDIRA_EMBEDDINGS_ENDPOINT` is set. |
| `URDIRA_EMBEDDINGS_ENDPOINT` | selection + http | Non-empty selects the opt-in HTTP provider (`{kind: "http"}`); takes priority over `URDIRA_EMBEDDINGS_PROVIDER`. |
| `URDIRA_EMBEDDINGS_MODEL` | http | Required alongside `_ENDPOINT`. |
| `URDIRA_EMBEDDINGS_DIMENSIONS` | http | Required alongside `_ENDPOINT`; positive integer. |
| `URDIRA_EMBEDDINGS_API_KEY` | http | Optional bearer token; never persisted in any digest (see above). |
| `URDIRA_EMBEDDINGS_MAX_BATCH_INPUTS` | http | Optional override for R12's per-request item cap (default 64). |
| `URDIRA_EMBEDDINGS_MAX_INPUT_TOKENS` | http | Optional override for R12's per-request estimated-token budget (default 8192), which also bounds the HTTP provider's own `.segment()` `max_segments`. |
| `URDIRA_LOCAL_EMBEDDINGS_MODEL` | neural (default) | Overrides the bundled model id (default `Xenova/all-MiniLM-L6-v2`). |
| `URDIRA_LOCAL_EMBEDDINGS_DTYPE` | neural (default) | Overrides the ONNX quantization (default `q8`). |
| `URDIRA_SEMANTIC_INDEX` | all | `0`/`false` disables semantic maintenance/search entirely (structural indexing and lexical search stay available). |
| `URDIRA_SEMANTIC_PROCESS` (legacy alias `URDIRA_SEMANTIC_THREAD`) | all | Controls whether semantic embedding runs in a separate worker process/thread vs. inline. |
| `URDIRA_SEMANTIC_EMBED_BATCH` | reconciler | Overrides `reconcileSemanticProjection`'s own `embed_batch_size` (default 16 documents/segments per commit batch). |

No CLI flag currently mirrors any of these (see the "Decided in
implementation" paragraph above) -- this table, plus `apps/urdira/src/index.ts`'s
`resolveSemanticDescriptor` doc comment, is the documented surface an
operator or agent needs to configure the HTTP provider end to end.

### Amendment 2026-09-07 (Frente S-C): v4 storage wiring + query-latency batching

**v4 storage wiring.** `runV4WorkspaceScan` (`packages/daemon/src/runtime.ts`)
used to deliberately never call `submitSemanticMaintenance` at all -- a v4
workspace's entity-grain lane would have thrown outright against
`record_occurrences`/`record_value_nodes`, tables the v4 catalog schema does
not have (docs/evidence/2026-09-02-v4-p2-1-schema.md). Fixed: `reconcileSemanticProjection`
(`@urdira/engine`'s `semantic-reconciler.ts`) now accepts an optional
`entity_record_source: SemanticEntityRecordSource` -- when provided, it
replaces the entity stale-close/missing-insert SQL and the two entity-shaped
`syncDocumentStatusBulk` statements; `undefined` (every v3 caller) keeps the
original `record_occurrences`-backed behavior byte-for-byte. A v4 workspace's
real source (`createNativeSemanticEntityRecordSource`, `semantic-entity-source-v4.ts`)
enumerates entity-category records from the native structural store's
`CanonicalQuerySnapshotPort` and joins them against `artifact_versions`/
`source_artifacts` (kept byte-identical between v3/v4) for owning-file CAS
metadata. Wired into the daemon by `resolveV4SemanticEntitySource`
(`packages/daemon/src/semantic-v4-wiring.ts`): ATTACHes the v4 semantic
sidecar directly onto the workspace's own catalog connection (mirroring
`warmWorkspaceQueryEngine`'s existing read-path ATTACH, not `submitLexicalMaintenance`'s
reversed ATTACH-catalog-onto-sidecar approach), so `database`/`database.projections`
need no duck-typed wrapping. `submitSemanticMaintenance`'s own
`v4ReadinessState.has(workspaceId)` early-return guard is gone; `runV4WorkspaceScan`
now calls it right after `submitLexicalMaintenance` on every successful scan.
`v4WorkspaceReadinessFrom`/`v4StatusFields` (`runtime.ts`) now compute
`semantic_ready`/`semantic_availability`/`semantic.current` from the real
`semanticMaterializationView`, the same way v3's `workspaceReadiness` always
has -- they used to hardcode `false`/`"unavailable"` unconditionally for v4.

Two documented simplifications in the v4 entity source (both decided in
implementation, correctness over historical exactness): every v4-sourced
row's `valid_from_generation`/stale-close `closing_generation` is the
workspace's CURRENT generation, not the record's own historical "first seen"/
"last visible" generation the v3 join recovers -- the native store's
`CanonicalQuerySnapshotPort` only answers "visible now", not "when exactly".
This never affects which vector answers a CURRENT query, only the historical
accuracy of `vector_projection_rows`' own generation bookkeeping.

**P0 discovered live, reported, NOT fixed (out of this frente's scope):**
`crates/urdira-jsts-syntax-worker`'s `push_entity_with_type_surface` publishes
every entity's `start`/`end` as the IDENTIFIER's own span
(`identifier.span.start`/`.end`), not the whole declaration's span -- unlike
v3's TS analyzer (`analyzer.ts`'s `entityForDeclaration`), which explicitly
separates `identityStart` (name-anchored, identity only) from the PUBLISHED
`start`/`end` (`node.getStart(file)`/`node.getEnd()`, the full declaration).
Verified live: every real v4 function/variable entity record fails decision
17's 120-character span eligibility check (`below_min_length`) regardless of
its real body length, because only its (typically far shorter) NAME is ever
measured. `tests/phase-daemon-v4-semantic.test.ts` works around this with a
deliberately >=120-character identifier name so its own coverage does not
depend on the fix landing first.

**Query-latency: model residency confirmed, two real batching fixes shipped.**
Measured live against the persistent neural host (`startNeuralSemanticProviderHost`,
`packages/daemon/src/semantic-process.ts`): the model is ALREADY resident and
warm across queries (an IPC `generateVector` round trip costs ~1-2ms; in-process,
already-warm embedding costs ~1ms) -- NOT the bottleneck this task's own brief
speculated it might be. The real, measured bottleneck was two sequential-await
patterns in `canonical-query-data-port.ts`'s `trySemanticSearch`/`semantic_vectors`:
(1) seven independent snapshot-port reads (`capability_states`/`semantic_index_state`/
`semantic_vectors`/`semantic_scope_counts`/`semantic_entity_scope_counts`/
`semantic_document_status_counts`/`semantic_affected_documents`) awaited one at a
time, each paying its own `SqliteWorkerAdapter` worker-thread round trip --
now fired together via one `Promise.all`; (2) `semantic_vectors`'s own packed-shard
CAS reads (one per DISTINCT `vector_shards` row, and a real workspace has many
-- one per embed-batch commit) read one at a time in a plain loop -- now
bounded-concurrency (`mapWithConcurrency`, limit 16, same magnitude as
`source-indexer.ts`/`directory-provider.ts`'s own CAS/filesystem concurrency
caps) via `@urdira/engine`'s `concurrency.ts`. Measured on a 45-real-file
workspace (multiple `vector_shards`, exceeding one `embed_batch_size`):
`core:search_semantic` p50 395.7ms -> 328.4ms, p99 493.4ms -> 444.7ms. On a
2-3-file workspace, latency was already ~42ms before this fix (well under the
"<100ms on a small workspace" bar) -- both fixes are zero-risk there (nothing
to parallelize when there is only one shard/one snapshot round trip already
fast). See `docs/evidence/2026-09-07-v4-semantic-wiring-and-embed-performance.md`
for the full before/after breakdown and the two REMAINING, larger, NOT-fixed-
this-session cost centers (`exactVectorScan`'s per-candidate `canonicalVectorBytes`
cost over an uncapped entity-candidate set; `hydrateSemanticCandidates`'s
sequential, snippet-budget-order-dependent per-candidate CAS read).

## Amendment (2026-09-07, Frente S-D): both remaining cost centers fixed

- **`exactVectorScan`'s per-candidate `canonicalVectorBytes` cost**
  (`packages/engine/src/semantic-retrieval.ts`): a new `fastCandidateBytes`
  helper skips the redundant decode -> optionally-renormalize -> re-encode
  round trip for a `Uint8Array` candidate whose byte length already matches
  the query's own `dimensions`/`element_type` -- every such candidate has
  ALREADY been filtered (same call) to share the query's exact
  `profile_id`/`executable_binding_id`, the SAME vector-space identity that
  controlled its own canonicalization the one time it was ever written
  (`putVectors`, `@urdira/storage`, the only writer of
  `vector_projection_rows`/its packed CAS shards) -- so the write-side
  guarantee is relied on instead of redundantly re-verified on every read. A
  raw `readonly number[]` candidate or a byte-length mismatch still takes
  the full, unchanged `canonicalVectorBytes` path.
- **`hydrateSemanticCandidates`'s sequential, order-dependent snippet
  budget** (`packages/engine/src/canonical-query-data-port.ts`): the shared,
  order-dependent `remainingCandidateSnippetBudget` (earlier-ranked
  candidates could consume a larger share, and every `sourceSnippet` call
  had to run one at a time to decrement it safely) is replaced with a FIXED,
  EQUAL per-candidate share of the same total budget, computed once up
  front -- independent of candidate order, so every candidate's own
  `sourceSnippet` call is safe to run with BOUNDED concurrency
  (`SEMANTIC_HYDRATION_CONCURRENCY`, `mapWithConcurrency`, same magnitude as
  `semantic_vectors`'s own shard-read concurrency). `context_lines: 0` is
  unchanged.

- **NEW finding, not in either remaining-cost-center list above: `exactVectorScan`
  rejected any query once the native candidate set exceeded a generic
  4MiB/4,096-record native batch bound** (`crates/urdira-native-core/src/lib.rs`'s
  `MAX_BATCH_FRAMED_BYTES`/`MAX_BATCH_RECORDS`, shared by several unrelated
  native operations) -- discovered live on the FIRST real query against a
  2,492-file workspace (13,454 open vectors): every `core:search_semantic`/
  `core:search_hybrid` call failed outright
  (`exactVectorTopKBatch rejected the batch: ... byte bound`). For 384-dim
  vectors this caps out around ~1,300 candidates per native call --
  n8n-scale entity-grain candidate counts (deliberately uncapped per
  decision 17) would ALWAYS exceed it, meaning semantic search was
  completely unusable on any real corpus past a few thousand vectors,
  independent of every other fix in this document. Fixed by `nativeTopKChunked`
  (`packages/engine/src/semantic-retrieval.ts`): chunks eligible candidates
  into native-sized batches, computes each chunk's own top-`limit` natively,
  then recursively merges and re-ranks chunk winners -- EXACT (decision 06:
  no ANN, no sampling), proven by a dedicated test running 9,000 synthetic
  candidates through a fake native port that itself enforces the real
  bounds.

Measured before/after on n8n (hot, full row set) and a small workspace: see
`docs/evidence/2026-09-07-v4-semantic-embed-performance-and-latency.md` Part
3.

## Amendment (2026-09-07, Frente S-E): daemon fd leak found and fixed (root
## cause: kqueue watches one file per corpus file, not a code bug); `core:coverage_incomplete`
## admission bug fixed; entity-candidate enumeration streamed

**Daemon file-descriptor "leak" at large-corpus scale -- root cause found: it
is `@parcel/watcher`'s own kqueue backend, not a forgotten `close()`
anywhere in this codebase.** Reproduced live (`lsof -p <daemon pid>` before
and after `ready` on a 2,492-file and a 20-file v4 workspace): the daemon
holds exactly one open `REG`-type file descriptor per corpus source file,
for the ENTIRE daemon lifetime, matching the corpus file count 1:1.
Exhaustively ruled out every code-level candidate this codebase owns
(`DirectorySourceProvider`/`NODE_DIRECTORY_FILE_SYSTEM`'s `read_file_stream`/
`read_file`, `@urdira/security`'s `regularFileMediaType`, the CAS `putStreamsMany`
drain, the semantic-child and structural-worker processes' own file
descriptors) via direct instrumentation of the actual running daemon -- NONE
of them were ever invoked for the v4 scan path that reproduces this. Root
cause: `packages/engine/src/watchers.ts`'s `watcherOptionsForSourceProvider`
selects `@parcel/watcher`'s kqueue backend by default on macOS (a deliberate
P3-7 choice: fs-events showed an unacceptable ~12s median detection delay
at n8n scale). `@parcel/watcher`'s kqueue backend registers one kernel-level
`EVFILT_VNODE` watch PER FILE at `subscribe()` time (confirmed by its own
documented behavior), and `EVFILT_VNODE` requires an open file descriptor
per watched file for the life of the subscription -- this is inherent to
kqueue-based per-file change detection, not a bug in any file-reading code
path. It went undetected by two PRIOR evidence docs
(`docs/evidence/2026-09-06-v4-reconcile-threshold.md` §14.5,
`docs/evidence/2026-09-03-v4-p3-1-incremental.md` §7.7) because both only
checked the KQUEUE-TYPE descriptor count (small, ~5) without realizing
kqueue's per-file registration descriptor is opened as an ordinary
REGULAR-file descriptor, not a second kqueue instance.

**Fix**: `watcherOptionsForSourceProvider` gained an optional
`fileCountEstimate` parameter and a `KQUEUE_FILE_WATCH_BUDGET` (2,000
files); above the budget it falls back to the fs-events backend instead of
kqueue, trading kqueue's latency win away only once its fd cost threatens
the daemon's own process stability (the confirmed cause of `spawn EBADF`
once enough files are watched -- see the entry below). `startWorkspaceWatcher`
(`packages/daemon/src/runtime.ts`) computes this estimate via a new,
budget-capped `countFilesUpToBudget` (`watchers.ts`) that stops walking the
instant the count is proven over budget, so a huge tree costs only enough
`readdir` fan-out to prove it is over budget, never a full enumeration.
Every pre-existing caller (no estimate passed) keeps kqueue-by-default
exactly as P3-7 shipped it. Verified live: a 2,492-file workspace (previously
3,039 open fds after `ready`) now holds 33 total fds after `ready` -- O(1)
with respect to corpus size, under the plan's own "< 200 + parcel watchers"
target.

**`core:coverage_incomplete` on a fully-indexed 2,492-file workspace for
`core:search_semantic`/`core:search_hybrid`/`core:semantic_affected_page` --
root cause found and fixed.** Reproduced live: `core:index_status` reported
every capability `complete`, yet the same query threw `core:coverage_incomplete`
with `blocking_stage: "3"` and a `capabilities` array naming structural
capabilities (`core:type_information`, `core:control_flow`, ...) these three
operations never depend on. Root cause: `packages/contracts/src/registries.ts`'s
`operationFrontiers` pinned `required_stage: 3` for all three -- the SAME bar
as `core:compare`/`core:build_context`, which genuinely need full structural
completeness -- so the daemon's OWN RPC admission gate
(`packages/daemon/src/runtime.ts`'s `requiredStructuralStage` check, run
BEFORE the engine's own semantic fast path in `canonical-query-data-port.ts`'s
`trySemanticSearch`) blocked on structural completeness for an operation
that only ever needed the separate, already-correct `semantic` frontier gate.
Directly contradicted this decision's own "must never pay corpus-load cost"
framing. **Fixed**: `required_stage: 0` for all three (matching
`core:search_text`/`core:get_source`'s own source-frontier-only admission);
the SEPARATE `semantic` frontier gate (`readiness.semantic_ready`) is now the
only readiness check these operations pay, and it correctly reports which
generation is missing when semantic materialization genuinely lags.

**Entity-candidate enumeration OOM -- root cause fixed, not just mitigated
with a larger heap.** See decision 17's amendment for the full description
(`entityCandidates()` now streams bounded pages instead of materializing the
whole corpus).

**A NEW, severe P0 found live while measuring this decision's own latency
target: `core:search_semantic` was, in effect, completely unusable (168.9s
of real CPU, then a call-stack overflow) on any real corpus whose
entity-grain candidate count exceeds the native per-call bound (~1,300 for
384-dim vectors) -- exactly n8n scale.** Root cause: `nativeTopKChunked`
(`packages/engine/src/semantic-retrieval.ts`, Frente S-D) assumed every
chunk-then-merge round strictly shrinks the candidate set -- true for a real
top-K query, but the entity lane's own call (deliberately uncapped per
decision 17, "cap 100 tras agregar" applies AFTER aggregation, not before)
defaults its `limit` to the full candidate count, degenerating every
"shrink" round into a no-op and recursing forever. Fixed with an exact
JS-side merge fallback once a round demonstrably makes no progress -- see
`docs/evidence/2026-09-07-v4-semantic-close.md` Part 2.4 for the full
diagnosis and the before/after numbers (168,963ms crash -> ~6s success on a
real 2,492-file/10,964-entity-vector workspace). This is the single most
severe correctness bug found across the whole S-frente, and per this plan's
own §0 priority ("función invocable = 100% funcional" before latency), its
fix took priority over closing the remaining latency gap below.

**Query latency at real corpus scale remains well above the 250ms target
after the above fix** -- ~5,850-6,180ms p50-p99 on the 2,492-file workspace,
~200-225ms p50-p99 even on a 100-file workspace (matching S-D's own prior
100-file number). The dominant cost (~5-5.4 SECONDS at the larger scale) is
now three of the seven parallel `Promise.all`'d snapshot-port reads in
`trySemanticSearch` -- `semantic_document_status_counts`, `semantic_affected_documents`,
and `semantic_scope_counts`/`semantic_index_state`/`semantic_entity_scope_counts`
all cluster within ~300ms of each other at 5+ seconds, consistent with
contention over the shared SQLite worker thread rather than five
independently slow queries, at `semantic_document_status`'s own ~94,500-row
scale for this corpus. NOT fixed this session (a genuine SQL/indexing
investigation, reported with root-cause hypothesis for the owner's queue)
-- see the evidence doc's own Part 3.2 for the full per-stage decomposition.

See `docs/evidence/2026-09-07-v4-semantic-close.md` for full reproduction
steps, literal counts, and the final embed/latency/incremental-edit
measurements.
