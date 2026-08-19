# Transactional Projection Digests

Status: **Approved**
Last updated: 2026-08-13
Depends on: [Storage/projection architecture](05-storage-projection-architecture.md), [Workspace fork](12-workspace-fork.md)

## Decision objective

Stop `projectionSetDigestEntries` (`packages/storage/src/lifecycle.ts`) from re-digesting the "lexical" projection kind at every candidate publish. Lexical rows are maintained asynchronously, after the publish transaction commits, so a publish-time digest of them was stale by construction the moment the post-`ready` rebuild landed — this was pure wasted work paid on every incremental publish, not a correctness feature.

## Context

`buildCandidatePublicationPlan` calls `computeSnapshotDigestFields`, which calls `projectionSetDigestEntries` to compute the `projection_set_digests` field stored on every new snapshot. Measured on a real 981-file workspace (177k records, 1.32M visible lexical trigram rows), this single call cost ~35-40s of a publish's fixed cost: a ~20s cross-worker SELECT of every visible `lexical_documents`/`lexical_trigrams` row, ~4s decoding, re-canonically-encoding, and SHA-256ing each payload, and a ~2.2s `localeCompare` sort of 1.3M ids (vs. ~0.36s for a plain comparator).

This cost bought nothing: `lexical_documents`/`lexical_trigrams` are not written inside the publish transaction at all. They are rewritten afterward, by the post-`ready` lexical reconciler (`packages/engine/src/lexical-reconciler.ts`, now running in a worker thread), which reconciles the lexical index against whatever generation is current at the time it runs. A `projection_set_digests` value computed at publish time therefore describes lexical rows that are guaranteed to be rewritten shortly after, and does not describe what the reconciler actually leaves behind. `verify()` already carried a permanent, documented excuse for exactly this mismatch: `storage:projection_set_digest_corrupt` is one of the pre-existing gaps `isKnownPreexistingVerifyGap` (`packages/engine/src/workspace-fork.ts`) filters out unconditionally. The digest was never actually load-bearing for lexical content — only for graph/dependency/metric/vector, all of which *are* written inside the publish transaction and therefore genuinely describe what that transaction committed.

## Decision

- `projectionSetDigestEntries` now covers **transactional** projection kinds only: `graph`, `dependency`, `metric`, `vector`. All four are still always present as entries, even with zero rows, preserving the existing shape consumers expect. The `lexical` entry and its two supporting queries (over `lexical_documents`/`lexical_trigrams`) are removed entirely.
- Entries within a kind are ordered by plain UTF-16 code-unit comparison of `projection_record_id`, not `String.prototype.localeCompare`. `localeCompare` was both the slower comparator at this scale and locale-dependent, which made the digest value liable to vary by machine locale — a defect independent of the lexical-exclusion change, fixed alongside it since it touches the same sort call.
- `content_digest` for each entry is now `digestBytes(bytes(payload))` — the digest of the exact stored canonical bytes — instead of `digestBytes(encodeCanonical(decodeCanonical(bytes(payload))))`. Every payload in these tables is written via `encodeCanonical` at publish (`artifactDependencyCommands`/`projectionCommands`, `packages/storage/src/publication-authority.ts`), copied byte-for-byte by a workspace fork's bulk copy, and re-encoded canonically by migration adapters — so for every payload actually reachable through this function, decode-then-re-encode is an identity transform. Skipping it removes a full decode+encode+hash pass over every transactional projection row, on top of dropping the lexical rows entirely.

## Consequences

- A freshly published snapshot's `projection_set_digests` now verifies cleanly against `verify()`'s own recomputation, and **stays** clean across any number of subsequent lexical reconciler rebuilds — the previous behavior was clean only until the next lexical rebuild landed.
- Snapshots published *before* this change stored a 5-entry array (lexical included) computed against whatever lexical rows existed at that publish moment. `verify()` recomputes only 4 entries now, so it reports `storage:projection_set_digest_corrupt` for every such older snapshot unconditionally. This is not a regression: any of those snapshots whose lexical index was rebuilt even once after its own publish (the normal case for a `ready` workspace) already failed this check under the old scheme too. `isKnownPreexistingVerifyGap` already excuses this error code for exactly this reason and needs no change.
- Incremental candidate publish drops roughly 35-40s of fixed cost per publish on a large workspace (measured on the 981-file/177k-record/1.3M-trigram benchmark), independent of how many records actually changed.
- `computeForkSnapshotDigestFields` (`packages/storage/src/publication-authority.ts`), which also calls `projectionSetDigestEntries` for a workspace fork's generation-1 publish, gets the identical benefit with no code change of its own — it already deferred entirely to this shared function.

## Non-goals

- No change to how the lexical reconciler itself maintains `lexical_documents`/`lexical_trigrams`, or to when it runs relative to `ready`.
- No new integrity check for lexical content. Lexical rows remain excluded from snapshot-level integrity the same way `graph_edges`/`metric_projections`/`vector_*` were already excluded from a fork's bulk-copy set (decision 12) for being non-authoritative or independently rebuildable.
- No backfill or migration of existing snapshots' stored `projection_set_digests`. The pre-existing verify gap already covers them, and rewriting historical snapshot rows is out of scope.
