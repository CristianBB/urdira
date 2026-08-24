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
