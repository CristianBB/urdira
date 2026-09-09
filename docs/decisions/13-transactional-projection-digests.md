# Transactional Projection Digests

Status: Accepted
Last updated: 2026-09-09
Depends on: [Storage architecture](05-storage-projection-architecture.md) and [workspace fork](12-workspace-fork.md)

## Current contract

`Snapshot.projection_set_digests` covers only projection families committed in
the snapshot publication transaction: `graph`, `dependency`, `metric`, and
`vector`. All four entries are present even when their row count is zero.

Lexical FTS rows are maintained asynchronously after structural publication
and are therefore excluded from snapshot projection digests. Their integrity
is checked against document CAS content and their generation-specific
reconciliation state.

Within a projection family, entries are ordered by the plain UTF-16 code-unit
ordering of `projection_record_id`. Locale-sensitive comparison is forbidden.
Each `content_digest` covers the exact stored deterministic logical payload;
the implementation does not decode and re-encode an already verified payload
merely to calculate the same digest.

Ordinary publication and workspace-fork publication both use the shared
`projectionSetDigestEntries` recipe. Verification recomputes the same four
transactional entries, so later lexical reconciliation cannot invalidate a
published snapshot anchor.

## Consequences

- Snapshot integrity describes only rows that are transactionally stable with
  that snapshot.
- Lexical correctness is explicit and independently rebuildable.
- Ordering and digest output are deterministic across host locales.
- No query or publication path may treat an asynchronous cache as part of an
  immutable snapshot digest.

## Scope note: v4 computes the same field differently

This decision documents the SQL storage backend's computation of
`Snapshot.projection_set_digests` (a relational scan over
`record_occurrences` and the other projection tables). A v4 workspace's
structural corpus lives in the native segment store
(`crates/urdira-structural-store`) instead of SQLite, so it cannot recompute
this same field the SQL way; it populates the identically-shaped
`projection_set_digests` field from its own native Merkle bucket digests
instead (`packages/engine/src/v4-verify.ts`, `crates/urdira-structural-store/src/merkle.rs`
via `iterVisibleDigests`/`iterVisibleGraphDigests`/`iterVisibleDependencyDigests`).
See [v4 Merkle bucket digests](27-v4-merkle-bucket-digests.md) for that
mechanism; this decision's SQL recipe still governs every SQL-backed
(non-v4) workspace.
