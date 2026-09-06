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
