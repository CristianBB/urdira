# Semantic Search Runtime

Status: **Accepted**
Last updated: 2026-09-09
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
never selected implicitly (see "HTTP provider" below for its batching and
configuration contract).

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

## HTTP provider

The opt-in HTTP embedding provider (`createHttpEmbeddingProvider`) is a
batched transport with bounded retries.
`generateVectors` splits its inputs into sequential (concurrency 1, never
parallel) requests, each capped at `max_batch_inputs` (default 64) items and
an estimated `max_input_tokens` (default 8192, chars/4) total, always keeping
at least one item per request so a single oversized document still makes
progress. Each request retries up to 3 times (default backoff `[500, 1000,
2000]`ms) on a 429/5xx status or a network-level failure (including its own
60s per-attempt timeout) — never on a malformed-but-successfully-received
response body, which is a provider contract bug retrying cannot fix.
Exhausting every retry raises `HttpEmbeddingProviderUnavailableError`
(`core:embedding_provider_unavailable`) for that batch; the reconciler's
existing per-document fallback isolates and marks only the affected
document(s) `failed`. `api_key` comes from `URDIRA_EMBEDDINGS_API_KEY` or the
descriptor, never a digest field.

Provider selection and every provider-specific knob are environment
variables read once at daemon start (`apps/urdira/src/index.ts`'s
`resolveSemanticDescriptor`), never a per-call RPC argument for any provider
kind:

| Variable | Applies to | Effect |
|---|---|---|
| `URDIRA_EMBEDDINGS_PROVIDER` | selection | `"hash"` selects the pure-JS hermetic hash provider; anything else (unset included) falls through to `neural` unless `URDIRA_EMBEDDINGS_ENDPOINT` is set. |
| `URDIRA_EMBEDDINGS_ENDPOINT` | selection + http | Non-empty selects the opt-in HTTP provider; takes priority over `URDIRA_EMBEDDINGS_PROVIDER`. |
| `URDIRA_EMBEDDINGS_MODEL` | http | Required alongside `_ENDPOINT`. |
| `URDIRA_EMBEDDINGS_DIMENSIONS` | http | Required alongside `_ENDPOINT`; positive integer. |
| `URDIRA_EMBEDDINGS_API_KEY` | http | Optional bearer token; never persisted in any digest. |
| `URDIRA_EMBEDDINGS_MAX_BATCH_INPUTS` | http | Optional override for the per-request item cap (default 64). |
| `URDIRA_EMBEDDINGS_MAX_INPUT_TOKENS` | http | Optional override for the per-request token budget (default 8192), which also bounds the provider's `.segment()` `max_segments`. |
| `URDIRA_LOCAL_EMBEDDINGS_MODEL` | neural (default) | Overrides the default model id (default `Xenova/all-MiniLM-L6-v2`). |
| `URDIRA_LOCAL_EMBEDDINGS_DTYPE` | neural (default) | Overrides the ONNX quantization (default `q8`). |
| `URDIRA_SEMANTIC_INDEX` | all | `0`/`false` disables semantic maintenance/search entirely. |
| `URDIRA_SEMANTIC_PROCESS` (legacy alias `URDIRA_SEMANTIC_THREAD`) | all | Whether semantic embedding runs in a separate worker process/thread vs. inline. |
| `URDIRA_SEMANTIC_EMBED_BATCH` | reconciler | Overrides `reconcileSemanticProjection`'s `embed_batch_size` (default 16 documents/segments per commit batch). |

`ensureSemanticAssets` for an `http` descriptor logs an explicit "external
HTTP endpoint; no local model download" notice at configure time. No CLI flag
mirrors this table today; it is the documented surface for configuring the
HTTP provider end to end.

## Maintenance and retrieval

Semantic maintenance reconciles eligible artifact and entity documents against
the current structural generation. It closes stale rows before publishing
replacement vectors and writes a completion marker only for the exact provider
and source generation it finished. A v4 (native structural store) workspace
sources its entity-category documents from the native store's
`CanonicalQuerySnapshotPort` (`createNativeSemanticEntityRecordSource`)
instead of the v3 `record_occurrences` table; the reconciler's stale-close,
insert, and status-sync SQL are otherwise identical between the two sources.
The semantic sidecar is ATTACHed directly onto the workspace's own catalog
connection for both v3 and v4.

Retrieval performs an exact scan over every visible vector that matches the
provider identity and structural filters, then applies the registered semantic
or hybrid ranking profile. It does not sample or silently narrow the corpus.
For an unfiltered float32 lane, the resident-buffer kernel registers the
ordered candidate buffer once per generation and evaluates exact top-K in
one native call. Path-filtered or other unsupported resident-buffer shapes
use `exactVectorScan`, including native-sized chunking and lossless top-K
merging where applicable. Both paths preserve exact retrieval; see
[Semantic search and ranking](06-semantic-search-ranking.md). A
per-`(workspace_id, profile_id, executable_binding_id)` cache of the fully
decoded `semantic_vectors` result, tagged by generation, avoids re-reading and
re-decoding the vector set on every query; a generation bump always
invalidates it. `core:search_semantic` returns `core:semantic_index_unavailable`
when no usable provider/materialization exists. `core:search_hybrid` may
continue through its lexical lane and reports the semantic lane as
unavailable or incomplete.

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

## Operational notes

`core:search_semantic`, `core:search_hybrid`, and `core:semantic_affected_page`
gate admission only on the `semantic` readiness frontier, never on structural
completeness — they never wait on capabilities they do not depend on. On
macOS, the workspace file watcher falls back from `@parcel/watcher`'s kqueue
backend to fs-events once the estimated file count exceeds
`KQUEUE_FILE_WATCH_BUDGET` (see [Workspace, snapshot, and incremental
indexing](04-workspace-snapshot-incremental-indexing.md)), because kqueue
holds one open file descriptor per watched file for the life of the
subscription; this is independent of semantic maintenance but was found while
measuring it at real-corpus scale. The periodic reconciliation sweep never
aborts an in-flight semantic-maintenance run merely because it was admitted;
only a scan that is actually about to publish a new generation does.

## Consequences

- The default local provider operates offline after explicit provisioning.
  The opt-in HTTP provider sends document segments during maintenance and
  query text during retrieval to the configured endpoint.
- Model acquisition is explicit, bounded to administration, and visible to the
  user.
- Structural readiness never depends on model availability.
- Exact retrieval and completeness reporting remain deterministic and
  auditable.
- Query latency at full real-corpus scale (n8n, ~93,060 vectors) is
  134.99ms/178.33ms p99 for `core:search_semantic`/`core:search_hybrid`
  (measured 2026-09-08; see decision 06 for the resident-buffer native
  kernel this depends on), meeting the 250ms target. A full n8n-scale
  semantic embed from zero reaches `semantic.current` in about 37 minutes,
  dominated by ONNX inference throughput rather than any fixed cost
  documented above.


## Change history

- **2026-09-06** (`4404e6b`, Frente S-B): HTTP provider batching/retries/configuration surface, folded into "HTTP provider" above.
- **2026-09-07** (`9b49e82`, Frente S-C): v4 (native structural store) semantic maintenance wiring — entity documents sourced from the native store instead of `record_occurrences`; folded into "Maintenance and retrieval" above. Found but not fixed this frente: `crates/urdira-jsts-syntax-worker` published an entity's span as its identifier span rather than the full declaration (fixed under decision 11/17).
- **2026-09-07** (`6546997`, Frente S-D): fixed two query-latency cost centers (redundant vector re-canonicalization on read; sequential snippet-budget hydration) and a severe correctness bug where a candidate set exceeding the native batch bound made semantic search fail outright above roughly 1,300 candidates — fixed by `nativeTopKChunked`, folded into "Maintenance and retrieval" above.
- **2026-09-07** (`28dea00`, Frente S-E): fixed a daemon file-descriptor budget issue (kqueue watches one fd per corpus file; falls back to fs-events above `KQUEUE_FILE_WATCH_BUDGET`), a structural-completeness admission bug that blocked semantic-only operations, streamed entity-candidate enumeration (decision 17), and an infinite-recursion bug in `nativeTopKChunked` when the entity lane's uncapped candidate count made every chunk-merge round a no-op. Folded into "Operational notes" above.
- **2026-09-08** (`9b20fbb`, Frente S-F): materialized a `semantic_coverage_summary` row instead of computing coverage counts live on every call, plus a native-port delegation gap that had silently disabled that fix in production. `core:search_semantic` p50/p99 on a 2,490-file corpus: 5,978.6ms → 256.6/308.1ms.
- **2026-09-08** (`676bc84`, Frente S-H): fixed a livelock where the periodic reconciliation sweep aborted in-flight semantic maintenance on every tick before it could finish (folded into "Operational notes"), and added the per-generation resident `semantic_vectors` cache (folded into "Maintenance and retrieval"). n8n full-scale semantic embed reached `semantic.current` in ~37 minutes with no restarts; n8n `core:search_semantic`/`core:search_hybrid` p99 2,825.8ms/11,896.5ms → 1,722.2ms/2,192.7ms (target still not met at this point — see decision 06's resident-buffer kernel amendment for the fix that met it).
