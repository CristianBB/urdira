# Transactional Projection Digests

Status: **Approved and implemented**
Last updated: 2026-08-24
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
