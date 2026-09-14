# Changelog

All notable user-visible changes are documented here. Urdira follows the
repository's [semantic versioning policy](docs/versioning.md).

## Unreleased

Changes implemented after 0.3.3; no new publication/version is claimed here.
See [current state](docs/current-state.md) for evidence and remaining limits.

- Rust-owned v3 structural publication and incremental root add/remove,
  priority and scan-aggregation improvements.
- v4 default for new workspaces: native immutable structural segments,
  bucketed Merkle roots, a Rust scan pipeline, and retained v3 compatibility
  through a separate per-workspace route; no automatic format conversion.
- Authoritative reconcile scans with content-hash equivalence, a measured
  1% delta/cold threshold, and corrected import/barrel/ambient/type dependencies.
- Expanded Rust JS/TS resolution, full declaration spans with stable identifier
  positions, bounded possible-target candidates, and opt-in residual checker
  generations with partial progress and continuation.
- Native structural query pushdown, identity lookups and workspace comparison;
  explicit rejection of status as a subject-producing query operation;
  character-aware pages and daemon IPC budget clamping.
- End-to-end v4 semantic maintenance, segmented entity/artifact documents,
  coverage/affected-set pagination, sharded embedding, resumable enumeration,
  segment caching and resident native exact-vector top-K (binding API 17).
- Optional HTTP embeddings with batch limits and retries; local model assets
  remain explicitly provisioned, not bundled or downloaded by queries.
- Degraded scan-failure reporting, bounded watcher descriptor use, orphan
  detection and explicit purge, and wired v4 pack export/import with destination
  reconciliation and export progress/deadlines.
- Compact MCP output keeps inline snippets opt-in (`snippet_lines=0` default).
- Agent context now uses explicit roots, deterministic definition/caller/test
  ordering, exact page-local source sharing, envelope-aware pagination and
  portable continuations. Supported prompt and pre-tool hooks inject this
  context before model work, preserve focused native fallback, and count served
  interceptions as Urdira use without double-counting shell output.
- Documentation reconciled across README, architecture, decisions, contracts,
  release guidance and versioning; measured performance is separated from
  unfulfilled cold/memory and release qualification targets.

## [0.3.3] - 2026-08-25 — Explicit destructive v3 preparation

- `runtime prepare --dry-run` classifies the current data root and names the
  exact pre-v3 root that confirmed preparation will permanently remove;
- `runtime prepare --confirm` stages and validates the replacement runtime
  before deleting an incompatible pre-v3 root, then activates a clean v3
  runtime; and
- valid v3 roots are preserved, while a live daemon or an unclassifiable
  catalog blocks destructive preparation.

## [0.3.2] - 2026-08-25 — Bounded semantic startup

- a missing local embedding-model cache is detected before the neural runtime
  is loaded, so a fresh data root reaches structural readiness immediately;
- the persistent neural child must complete its readiness handshake within 30
  seconds and is terminated if it stalls; and
- a neural child error or premature exit now degrades semantic search instead
  of leaving daemon startup waiting indefinitely.

## [0.3.1] - 2026-08-25 — Reliable daemon discovery and replacement

- a busy live daemon with matching ownership is reused instead of racing a
  second process for the per-user lock;
- every runtime release advertises an exact engine build identity, so an
  updated CLI cannot silently keep using a daemon from an older release;
- incompatible daemons reject workspace and query operations with
  `core:daemon_restart_required`, while explicit lifecycle recovery remains
  available;
- `daemon stop` waits for ownership-lock release and `daemon restart` launches
  the installed runtime as a detached process before returning ready; and
- workspace discovery, registration, daemon attachment, shutdown, and restart
  now report terminal progress, use administrative deadlines, and render
  expected failures without internal stack traces.

## [0.3.0] - 2026-08-24 — Urdira v3 optimized pipeline

This is an intentionally incompatible release. Existing pre-v3 and early
preview-v3 data roots must be reindexed; the runtime rejects them instead of
silently serving mixed-format state.

- binding-oriented v3 pipelines now validate a closed dependency DAG, execute
  independent branches concurrently, preserve scalar cardinality, and expose
  all registered set/filter/join/deduplicate/select operators through one
  deterministic MCP call;
- logical digests use incremental `urdira.logical-digest.v3` writers; the
  canonical record-set digest streams ordered record id/digest pairs with O(1)
  auxiliary writer memory, while staging and SQLite writes use bounded batches
  and a conservative 999-variable ceiling;
- `urdira_context` and the v3 freshness barrier let agents request complete
  task context and readiness in one call; the daemon rejects pre-v3 and
  early-preview v3 data roots and requires a fresh root plus source reindexing;
- relation joins reuse a bounded exact endpoint index per immutable snapshot,
  and progressive TypeScript analysis retains persistent checker state instead
  of forcing full-project reanalysis.

## Historical v2 native pipeline

- source ingestion now streams `Uint8Array` chunks into CAS and transfers
  native arenas to worker threads without an aggregate workspace buffer;
- record bodies are stored as relational SQLite child rows with incremental
  logical SHA-256 digests and persistent sparse-Merkle set roots;
- `FactDeltaBatch` is bounded to 4 MiB or 4096 rows, validates sequence order,
  and is staged atomically with idempotent retry handling;
- local process IPC carries length-prefixed Protobuf messages with explicit
  byte and in-flight budgets; Protobuf is not persisted or hashed; and
- aggregate record payload columns and their tests are removed. v1 indexes are
  rejected and require the explicit `migrate --to-data-format 2 --reindex
  --discard-v1-index` flow.

## [0.2.2] - 2026-08-20

Patch release fixing workspace registration feedback:

- `workspace add` now prints detected technologies, evidence, confidence, and
  compatible plugins before asking for confirmation; and
- missing workspace paths fail clearly before any confirmation prompt.


## [0.2.1] - 2026-08-20

Patch release fixing daemon startup:

- `urdira daemon start` no longer requires `--dry-run` or `--confirm`;
- daemon startup runs detached, reports its startup phases, and persists logs;
- invalid CLI lifecycle requests are rejected before expensive runtime startup;
- the daemon remains alive after `start` until an explicit `stop`; and
- the bootstrap rejects Node.js versions below `24.18.1` immediately; and
- the bundled JavaScript/TypeScript plugin is published as 0.3.3 with the
  Urdira 0.2.1 dependency pins.

## [0.1.0] - 2026-08-19

Initial public release candidate:

- local daemon, CLI, and four-tool MCP interface;
- explicit multi-workspace scope and immutable snapshot/cursor execution;
- deterministic structural, lexical, semantic, source, context, and impact
  query families;
- bundled JavaScript/TypeScript analyzer with progressive structural stages;
- durable SQLite/CAS storage, candidate publication, recovery, retention, and
  guarded workspace purge;
- optional user-scoped integrations for supported coding agents;
- public npm package graph (`urdira` and `@urdira/*`) plus deterministic
  platform archive tooling; and
- frozen Vite comparative benchmark protocols and digest-bound summaries.

The release must not be tagged or published until every gate in
[docs/release.md](docs/release.md) is complete.
