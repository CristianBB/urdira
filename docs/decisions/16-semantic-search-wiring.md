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

## Amendment (2026-09-08, Frente S-F): the ~5s dominant cost root-fixed; a second, production-only bug found by live measurement

The prior amendment's own "NOT fixed this session" cost center (`semantic_document_status_counts`/
`semantic_affected_documents` computed live on every call) is root-fixed:
the reconciler now materializes one `semantic_coverage_summary` row per
clean pass (same generation as its own `semantic_index_state` marker);
`buildSemanticCoverageView` reads it via one indexed point lookup instead
of the two live queries, falling back to the old pair only when no summary
has materialized yet (never a new correctness requirement). New covering
index (`semantic_document_status_affected_v2`) + `status IN (...)` (not
`<>`) + a status-first `ORDER BY` for the pagination query the reconciler's
own materialization (and `core:semantic_affected_page`'s continuation)
still runs -- confirmed via `EXPLAIN QUERY PLAN`: no `SCAN`, no `TEMP
B-TREE`.

Fixing that exposed the SAME symptom (multiple `Promise.all`'d reads all
costing ~5s, consistent with SQLite-worker-thread queueing behind one slow
call) had a SECOND, entirely separate root cause specific to production:
`NativeCanonicalQuerySnapshotPort` -- the port every real v4 (native
structural store) workspace actually uses, i.e. the daemon's own default --
hand-delegates every `semantic_*` method to the wrapped SQLite port one at
a time, and the new `semantic_coverage_summary` method was never added to
that list (the interface field is optional, so this compiled cleanly but
silently disabled the fix above in production); its own
`semantic_entity_scope_counts` also has no SQL to delegate to (structural
records are not in SQL when the native store is active) and did an
uncached full-corpus walk on every call, 5.0-5.4s at ~40k records. Both
fixed (`ef838e3`): the missing delegation, and a per-generation cache for
the entity count. Neither had ANY prior test coverage in
`tests/native-query-snapshot-port.test.ts` -- two regression tests added.

Net, measured live end-to-end against the real daemon: `core:search_semantic`
on a 2,490-file/13,454-vector real corpus, p50/p99 5,978.6ms -> 256.6/308.1ms
(~19-23x); 100-file workspace p99 222.5ms -> 52.9ms (target <=100ms MET).
`packages/cli`-scale target (<=250ms p99) not QUITE met (308ms) -- the new
dominant cost is candidate hydration (`hydrateSemanticCandidates`, ~270ms,
hydrating the full fused ~200-candidate set regardless of
`response_budget.max_items`, a documented prior decision not to thread that
budget down to this port layer) -- reported for a future frente, not fixed
here.

A full n8n-scale (real corpus, ~20k files) embed was attempted at both
`URDIRA_SEMANTIC_WORKERS=2` and `=3` this session and did NOT complete --
consistent with, not a new instance of, the standing "did not complete in
3h44m" finding from `docs/evidence/2026-09-07-v4-semantic-embed-performance-and-latency.md`.
See `docs/evidence/2026-09-08-v4-semantic-latency-and-n8n-embed.md` for the
full reproduction, an operational incident encountered along the way (disk
exhaustion + orphaned worker processes from this session's own daemon
restarts, cleanly resolved with no data loss), and the literal
processing-rate floor observed (~0.03 status-rows/second after ~366k rows
classified, independent of worker count or machine contention) -- the
stalled phase itself was not identified within this session's time budget.

## Amendment (2026-09-08, Frente S-H): periodic sweep no longer aborts in-flight semantic maintenance; resident vector cache at full n8n scale

Two bugs closed this session, both diagnosed by
`docs/evidence/2026-09-08-v4-semantic-embed-stall-root-cause.md` (Frente
S-G's own Bug 4, explicitly left unfixed there) and its own query-latency
finding (super-linear growth at full n8n scale, target NOT met).

**Bug 4 (scheduling)**: `scheduleWorkspaceScan` (`packages/daemon/src/runtime.ts`)
called `lexicalThreadRuns.get(id)?.abort()`/`semanticThreadRuns.get(id)?.abort()`
UNCONDITIONALLY the instant ANY scan was admitted -- including the periodic
reconciliation sweep's own `"checking_for_updates"` scan, which by
construction does not yet know whether anything changed. At real n8n scale
this tore down and restarted the semantic-maintenance child process every
sweep tick, forever, before it could ever reach its own finalize step --
the literal mechanism behind S-F's/S-G's own "never reaches
`semantic.current`" observations. Fixed: the two abort calls at admission
now fire only when `activity !== "checking_for_updates"` (every OTHER
admission -- a genuine edit, `core:reindex`, a first scan, outdated-format
recovery -- is by construction always about to publish, unchanged from
before); for the one ambiguous case, the abort is instead called lazily,
from the scan's own run body, at the earliest point it can confirm a real
generation is about to publish (`onQueryableLive` for v4 -- never invoked by
a `Reconcile`/`Noop` scan, R3 -- and `on_stage_published` for v3, which
likewise only fires once a stage's own `runFullWorkspaceScan` call actually
published). A second, related bug was found live measuring the fix at real
scale: `runV4WorkspaceScan`'s own unconditional `submitSemanticMaintenance`
call at the end of EVERY scan, combined with that function's own
coalesced-pending retry, spawned a fresh semantic-maintenance child process
(the THREADED default) on every no-op sweep tick that landed while an
earlier real pass was still running -- fixed by skipping that call entirely
once maintenance has genuinely been submitted at least once already for the
workspace and the just-completed scan is a `Reconcile`/`Noop`.
End-to-end regression test (`tests/phase-daemon-v4-semantic.test.ts`, real
daemon + real worker binary, `reconciliation_sweep_interval_ms: 25`):
reverting the admission-gating fix reproduces the exact livelock live
(`semantic.current` never reached within 60s, `pollUntilSemanticCurrent`
times out); with the fix, `semantic.current` is reached and
`on_semantic_maintenance_started` (new test-only counter,
`DaemonRuntimeOptions`) fires exactly once. Validated live at full n8n
scale too (this amendment's own measurement below): `reconciliation_sweep_interval_ms: 20_000`
against the real ~20k-file corpus, no restarts observed, `semantic.current`
reached in 2,238,157ms (~37.3 minutes) from `workspace_add`.

**Latency (Part 2, lever 1 -- resident vector cache)**: `SqliteCanonicalQuerySnapshotPort.semantic_vectors`
(`packages/engine/src/canonical-query-data-port.ts`) used to re-run its own
`vector_projection_rows` SELECT, `vector_shards` lookup, and one
`packed.slice(...)` allocation PER VECTOR on EVERY `core:search_semantic`/
`core:search_hybrid` call -- at n8n's own real scale (93,060 vectors) this
alone measured **5,223.9ms COLD**. Fixed: a per-`(workspace_id, profile_id,
executable_binding_id)` cache, tagged with the `generation` it was built
for (folded into the SAME `approxWarmBytes()`/`evictWarmRecords()` budget
loop `recordsCache`/`shardBytesCache` already use -- one ceiling, not a new
knob), holding the fully-decoded result. A hit for the CURRENT generation
(the common case: nothing changed between two queries) skips the SQL read,
the shard lookup, AND the slice allocations entirely, returning the exact
same array -- measured **9.8ms WARM** (a >500x reduction). Every surviving
row's bytes now also land in ONE contiguous backing `ArrayBuffer` (built
once per cache miss), each row's own `vector_payload` a zero-copy view into
it, rather than N independent per-row allocations even on the cache-miss
path. `evictWarmRecords()`/`approxWarmBytes()` cover the new cache; a
generation bump is not masked (verified live: a real new-generation vector
is visible on the very next call, never served from the stale cached
array). Regression test:
`tests/phase-canonical-query-data-port.test.ts` ("Frente S-H: caches the
fully-decoded semantic_vectors result...").

Net, measured live end-to-end against the real daemon, full n8n scale
(93,060 vectors: 72,922 entity-grain segments across 28,373 covered
documents, 20,138 artifact-grain), 20x `core:search_semantic` + 20x
`core:search_hybrid` (one warm-up excluded, `snippets: {mode: "none"}`,
matching S-F's/S-G's own methodology exactly), MiniLM neural provider (the
shipped default, model already resident locally, no download):

| operation | metric | S-G baseline (before this frente) | this frente (after lever 1) | improvement |
|---|---|---:|---:|---:|
| `core:search_semantic` | p50 | 2,538.8ms | 1,588.3ms | 1.6x |
| `core:search_semantic` | p95/p99 (20 samples, both collapse to max) | 2,825.8ms / 4,085.8ms | 1,722.2ms / 1,722.2ms | 1.6x / 2.4x |
| `core:search_hybrid` | p50 | 6,525.6ms | 1,620.2ms | 4.0x |
| `core:search_hybrid` | p95/p99 | 11,896.5ms / 18,311.2ms | 2,192.7ms / 2,192.7ms | 5.4x / 8.4x |

**Target (p99 <= 250ms) NOT MET at full n8n scale** -- reported honestly,
with the physical floor demonstrated rather than assumed. A standalone
phase decomposition against the SAME real, already-embedded n8n sidecar
data (read-only, no daemon; the SAME `SqliteCanonicalQuerySnapshotPort` +
`exactVectorScan` + the SAME native exact-vector-top-k kernel port the real
daemon configures) isolates where the remaining ~1.6-1.7s/~1.6-2.2s actually
goes:

| phase | measured |
|---|---:|
| query embed (warm, resident model) | ~0.6-2ms |
| `semantic_vectors` WARM (resident cache hit) | 9.8ms |
| `semantic_vectors` COLD (paid once per generation, not per query) | 5,223.9ms |
| entity-lane `exactVectorScan`, bounded (native kernel, limit=800 of 72,922 segments) | 581.4ms |
| entity-lane `exactVectorScan`, uncapped escalation (native kernel, all 72,922 ranked) | 1,415.9ms |
| artifact-lane `exactVectorScan` (native kernel, limit=100 of 20,138) | 54.0ms |
| remainder (aggregation, `records_by_ids` hydration, coverage/capability point lookups, JSON render) | not decomposed further this session -- the residual between the ~1.6-1.7s end-to-end total and the phases above (~640-650ms), a bounded target for a future frente |

S-G's own hypothesis (the bounded-vs-uncapped escalation branch,
`canonical-query-data-port.ts` ~line 3893, dominating the super-linear
growth) is confirmed real but SMALLER than assumed: the bounded attempt
ALSO scans every one of the 72,922 candidates (`limit` bounds the RESULT
count exactcVectorScan returns, not how many candidates it evaluates -- both
branches pay the same distance computation over the full set), so bounded
(581ms) and uncapped (1,416ms) differ by ~2.4x, not an order of magnitude.
The genuine physical floor this session found and demonstrates with a
number: **entity-lane exact top-K over n8n's own real 72,922-segment
candidate set costs 581ms through the NATIVE kernel port even in its
CHEAPEST (bounded-output) form** -- more than double the 250ms end-to-end
budget by itself, before hydration/render/aggregation are even counted.
This is very unlikely to be raw FLOP cost (72,922 x 384-dim dot products is
low tens of millions of multiply-adds, sub-10ms territory on this
hardware) and much more likely `nativeTopKChunked`'s own per-call
marshaling/recursive-merge overhead at ~18 chunks of ~4,096 candidates
each (`NATIVE_BATCH_RECORD_BUDGET`, `semantic-retrieval.ts`) -- flagged
precisely, with the measured number and the exact file/constant, for a
future frente to confirm via instrumentation and fix (candidates: raise
the native chunk byte/record budget now that this session's own number
shows chunking overhead, not compute, dominates; or reduce marshaling by
reusing one packed buffer across chunks instead of allocating one per
`nativeTopKChunked` recursion level) -- not attempted this session (a Rust/
native-boundary change, out of this frente's remaining time budget after
its own two required fixes). Per plan §0 (accuracy never sacrificed for
latency), no exactness was traded for this session's own 1.6-8.4x
improvement: every scan remains the exact, deterministic top-K this
project has always guaranteed.
