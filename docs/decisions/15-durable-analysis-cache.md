# Durable JavaScript/TypeScript Analysis Cache

Status: Accepted
Last updated: 2026-09-09
Depends on: [JavaScript/TypeScript support](07-javascript-typescript-mvp.md) and [plugin resolution continuity](14-plugin-upgrade-relock.md)

## Current contract

The JavaScript/TypeScript analyzer may reuse a completed analysis across worker
and daemon lifetimes only when every output-affecting input matches. The cache
is an optional acceleration layer and is never an authority for publication.

The durable key covers:

- cache format and analysis-stage version;
- sorted root names and per-file content identities;
- compiler options;
- TypeScript compiler and plugin versions; and
- analysis and analysis-configuration digests.

Structural syntax-only entries and checker-backed semantic entries use distinct
format versions and stage-qualified keys. They are never interpreted as each
other. Large structural closure requests may additionally use a graph entry
keyed by the sorted path/content/length manifest and root names.

## Storage and safety

Entries live under `<data_root>/analysis-cache/jsts` and are shared by
workspaces owned by that daemon installation. The key has no workspace-local
path or identifier, so content-identical checkouts can reuse analysis safely.

The payload is gzip-compressed JSON containing its explicit format version,
durable key, and analysis result. Writes use a unique same-directory temporary
file followed by atomic rename, and complete before the worker invocation
returns. A worker may therefore be terminated immediately after its response
without racing an unfinished cache write.

Reads verify the recomputed key, format, and required result shape. A missing,
truncated, malformed, stale, or unreadable entry is removed best-effort and
treated as a cache miss. Cache I/O and pruning errors never fail a scan.

Entries are pruned oldest-first above `analysis_cache_max_entries` (default
16). `URDIRA_ANALYSIS_CACHE=0` disables durable reads and writes without
changing analysis or publication semantics.

## Interaction with analysis

An in-memory worker hit takes precedence. On an in-memory miss, a valid durable
entry is installed into the same in-memory representation as a fresh build. A
real build writes the durable entry only after producing a complete validated
result.

A compiler, analyzer, stage format, configuration, root set, or source-content
change creates a different key. The cache never adapts or partially migrates an
entry across those boundaries.

## Consequences

- Daemon restarts, content-identical workspaces, and post-fork scans can avoid a
  repeated whole-project checker build.
- Cache corruption reduces performance only; it cannot change accepted facts.
- Cache storage is local to one daemon data root and is never exported,
  synchronized, or published as workspace state.
- There is no proactive warming: an entry exists only after a successful real
  analysis of the exact key.

## Scope note: v4 workspaces do not use this cache

This decision governs the JavaScript/TypeScript plugin's own TypeScript
checker-backed analyzer/worker (`packages/plugin-javascript-typescript/src/worker.ts`,
still live and used by non-v4 workspaces). A v4 workspace
([v4 structural store](26-v4-structural-store.md), [v4 Rust-owned scan pipeline](29-v4-rust-owned-scan-pipeline.md))
never routes through that analyzer: the Rust `urdira-indexing-worker` owns
catalog, parse, and materialize as one pass, with its own incremental
mechanism (`Full`/`Changed`/`reconcile` scopes, and an incremental
`ProgramIndex` for typeflow) that this durable, gzip-JSON, per-daemon-data-root
cache plays no part in.
