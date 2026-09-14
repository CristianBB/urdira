# Current architecture

Status: Implemented, v4 structural store (default) with v3 retained as an
opt-out legacy path (`URDIRA_V4=0`, see [docs/versioning.md](versioning.md))

Last updated: 2026-09-14

This guide is the implementation map for the current Urdira codebase. It does
not introduce product behavior: the linked decisions and protocols remain
normative. Use it to understand how a public request reaches the storage and
indexing components, then follow the code landmarks at the end of the
document.

The system has four invariants that explain most design choices:

- every source-reading operation names an explicit workspace and immutable
  snapshot binding;
- indexing publishes immutable generations atomically, while source,
  structural, and semantic readiness may advance independently;
- query stages exchange bounded, sealed sets rather than retaining another
  in-memory copy of the indexed corpus; and
- optimizations must preserve exact results; unavailable indexed paths use
  an exact fallback or return an explicit operation/resource error.

A newly registered workspace gets the v4 format by default
(`isV4Enabled()`, `packages/daemon/src/runtime.ts`); an existing v3 workspace
keeps working as v3 with no automatic migration. Both formats share the same
public query surface, MCP tools, and daemon/CLI lifecycle commands described
below; where their internals differ, this document says so explicitly.

## Package and dependency direction

Dependencies flow downward through the layers in
[`architecture/manifest.json`](../architecture/manifest.json). Public adapters
do not reach around the engine into storage, and plugins contribute validated
facts rather than defining public operations.

```mermaid
flowchart TD
  Bootstrap["apps/bootstrap"] --> Runtime["@urdira/runtime"]
  Runtime --> CLI["@urdira/cli"]
  Runtime --> MCP["@urdira/mcp"]
  Runtime --> Web["@urdira/web"]
  Runtime --> Daemon["@urdira/daemon"]
  Runtime --> Native["@urdira/native\nloader for the compiled Rust addon"]
  Web --> CLI
  Web --> MCP
  CLI --> Daemon
  MCP --> Daemon
  Daemon --> Engine["@urdira/engine"]
  Daemon --> Storage["@urdira/storage"]
  Engine --> Storage
  Daemon --> Embedding["@urdira/embedding-local"]
  Embedding --> Engine
  Engine --> PluginSDK["@urdira/plugin-sdk"]
  Engine --> Contracts["@urdira/contracts"]
  Engine --> Canonical["@urdira/canonical"]
  Engine -. "bounded worker threads" .-> Workers["digest and pack-verification workers"]
  Engine -. "v4 only: direct addon require,\nnot the @urdira/native package boundary" .-> NativeAddon["compiled urdira-native-node addon"]
  Engine --> Security["@urdira/security"]
  Storage --> Contracts
  Storage --> Canonical
  PluginJS["@urdira/plugin-javascript-typescript"] --> PluginSDK
  PluginJS --> Contracts
  Runtime -. "per-workspace process transport" .-> IndexingWorker["urdira-indexing-worker (Rust)"]
  PluginSDK --> Contracts
  Canonical --> Contracts
```

## v4 scan pipeline: catalog, analyze, materialize, publish

The v4 route replaces the per-generation TypeScript/SQLite composition
described further below with a persistent Rust worker process
(`urdira-indexing-worker`, spawned and supervised from
`apps/urdira/src/index.ts` through the plugin package's
`indexing-core-process-transport.ts`) that owns one
workspace's structural store end to end. Its own `v4/scan.rs` module
describes the pipeline as: **catalog -> parse/semantics -> facts ->
materialize -> write -> Merkle -> snapshot -> events**, driven by three scan
scopes carried as JSON command/event payloads inside bounded, length-prefixed
`urdira.ipc.v2` Protobuf frames
(`crates/urdira-worker-protocol/src/lib.rs`): `Full` (from-scratch walk),
`Changed` (an exact caller-supplied path set, for watcher-driven incremental
scans), and `Reconcile` (below).

```mermaid
flowchart LR
  Walk["urdira-source-frontier\nwalk, hash, CAS, source-state digest"] --> Catalog["v4/catalog.rs\nsource catalog delta into SQLite"]
  Catalog --> Analyze["v4/analyze.rs + typeflow.rs\nurdira-jsts-syntax-worker, urdira-jsts-typeflow"]
  Analyze --> Deps["v4/deps.rs\ndependency and reference closure"]
  Deps --> Materialize["v4/materialize.rs\nrecord and dependency rows"]
  Materialize --> Write["urdira-structural-store\nimmutable mmap segments"]
  Write --> Merkle["merkle_bucket.rs\ngeneration-visible set Merkle roots"]
  Merkle --> Snapshot["atomic current-pointer swap"]
  Snapshot --> Events["IndexingEvent stream\nQueryable / ScanCompleted"]
  Events -. "opt-in background, off the scan critical path" .-> Residual["v4/residual.rs\nurdira-tsgo-client ResidualPass"]
```

Only JavaScript/TypeScript source ever reaches `analyze`; the pipeline itself
is language-neutral at the catalog/materialize/publish/store layer, with the
JS/TS engine (`urdira-jsts-indexing-engine`, `urdira-jsts-syntax-worker`,
`urdira-jsts-native-projection`) as the one bundled language authority.

### Reconcile: catching up after a git operation the watcher could not track

A filesystem watcher cannot safely interpret a `git checkout`, `git pull`, a
worktree branch switch, or a burst of coalesced/overflowed OS filesystem
events as a precise changed-file list. `packages/engine/src/watchers.ts` and
`reconciliation.ts` classify those situations as one of
`WatcherReconcileReason`: `branch_changed`, `events_lost`, or
`provider_reset`, and request a `ScanScope::Reconcile` scan instead of
guessing a `Changed` path list.

`run_reconcile` (`crates/urdira-indexing-worker/src/v4/scan.rs`) always
re-derives the delta from one authoritative walk — the same walk `Full`
performs — then chooses which pipeline republishes it:

- **equivalence by content hash**: a path whose content hash and byte length
  are unchanged from the current frontier (a touched file, a `git stash`, an
  index-pack import onto a fresh filesystem) is reported separately from
  `added`/`changed`/`deleted` and never opens a new artifact version;
- if the authoritative `added + changed + deleted` count is at most
  `RECONCILE_DELTA_THRESHOLD` (`0.01`, overridable with
  `URDIRA_V4_RECONCILE_THRESHOLD`) of the current frontier size, it republishes
  through the cheaper `Changed`/delta pipeline (`ReconcileMode::Delta`);
  otherwise, or if that delta pipeline fails, it republishes through the
  `Full` pipeline instead (`ReconcileMode::Cold`, with `fell_back_to_cold:
  true` in the failure case);
- an empty authoritative delta publishes nothing and reports
  `ReconcileMode::Noop`.

`core:index_status` exposes the outcome of the most recent v4 scan as
`last_scan` (omitted entirely for v3 workspaces), which carries a
`reconcile` object — `mode`, `added`/`changed`/`deleted`, `frontier_size`,
the effective `threshold`, and `fell_back_to_cold` — only when that scan's
`kind` was `"reconcile"`. `core:reindex` always forces `scope: "full"`,
bypassing reconcile's delta measurement entirely.

### Residual pass: closing the gap typeflow's local resolver cannot

`v4/typeflow.rs` builds and incrementally maintains a `ProgramIndex`
(`urdira-jsts-typeflow`) unconditionally on every v4 scan, resolving as many
member-access and heritage relationships as pure declared-type/lexical
information allows. What typeflow cannot resolve locally is emitted as a
`possible` (not `confirmed`) `core:call`/`core:inherits`/`core:implements` row
against one or more candidates, with `pending.sites` recording the open
question.

`v4/residual.rs` runs an opt-in background pass (`URDIRA_V4_RESIDUAL=1`,
default off), outside the critical path of any scan. It spawns the pinned
`tsgo` (TypeScript 7) binary through
`urdira-tsgo-client`'s JSON-RPC `--api --async` mode (decision 28,
[`docs/decisions/28-v4-rust-semantics-and-residual-checker.md`](decisions/28-v4-rust-semantics-and-residual-checker.md))
to run a real `ts.Program`/checker over the whole project and upgrade
resolvable `possible` rows to `confirmed`. `core:find_references` and similar
operations can therefore return `possible` results with a candidate list
before the residual pass completes, and `confirmed` afterward, without
changing the request shape.

### Structural store and identity pushdown

`urdira-structural-store` is the v4 production structural store: an
immutable-per-segment, mmap-served, fixed-width-array store for structural
records and artifact dependencies, with append-only segment writes and
Merkle roots for the visible record/dependency/graph/metric sets of a
generation (used for delta/cold equivalence and integrity verification).
The compiled addon
(`crates/urdira-native-node`, `structural_store_napi.rs`) exposes a
`NativeStructuralStoreHandle` that `packages/engine/src/native-structural-store-binding.ts`
loads directly (a raw `require()` of the built `.node` file, bypassing the
`@urdira/native` package boundary that governs the shipped, checksummed
addon used elsewhere). Query operations that can be expressed as an index
lookup over that store — `records_by_identity_ids`/`records_by_identity_keys`,
`by_kind_universal`, and the full catalog of pushdown-eligible operations
below — run natively in one call instead of a JavaScript scan over
deserialized rows. Over-limit identity batches fail with
`core:selector_unresolvable`; other unsupported pushdown shapes retain exact
fallback evaluation subject to resource limits. A pushdown optimization
does not change completeness or make every selector shape index-backed.

### Lexical and semantic sidecars

Both formats keep lexical (full-text/trigram) and semantic (vector) search in
separate SQLite sidecar databases attached alongside the workspace's main
catalog connection, reconciled asynchronously after structural publication —
queries never wait on either sidecar to answer a structural request.

- **Lexical**: `packages/engine/src/lexical-reconciler.ts` maintains the FTS5
  trigram index; v4 additionally supports an opt-in Rust-owned lexical build
  (`lexical_owned_by_rust`) that pushes the reconciliation work into the
  native layer.
- **Semantic**: `packages/daemon/src/semantic-v4-wiring.ts` ATTACHes the
  semantic sidecar directly onto the workspace's own catalog connection and
  builds a native-backed entity record source
  (`packages/engine/src/semantic-entity-source-v4.ts`). The sidecar tracks
  per-document state (`semantic_document_status`), a coverage summary
  (`semantic_coverage_summary`), and a segment cache
  (`semantic_segment_cache`); a document is split into token-bounded segments
  (256 tokens, 32-token overlap, capped at `MAX_SEGMENTS` per document) and
  embedded per entity segment rather than per whole file. Maintenance runs in
  sharded child processes (`URDIRA_SEMANTIC_WORKERS` bounds concurrency
  under the CPU-derived cap) so status RPCs stay responsive during a full embedding pass. `core:semantic_affected_page`
  pages through documents a materialization pass has not yet covered, keyed
  by an `affected_artifact_set_id`; `core:affected_set_stale` is returned
  instead of a mixed/partial page when that set no longer matches the
  workspace's current affected documents. See
  [docs/semantic/core-semantic-reasons.md](semantic/core-semantic-reasons.md)
  and [decision 16](decisions/16-semantic-search-wiring.md).

## v3 legacy pipeline (`URDIRA_V4=0`)

A v3 workspace retains the TypeScript source/readiness composition and the
Rust-owned indexing-core publication boundary. The following diagram shows
logical phases; production structural rows are grouped, validated and
published inside `urdira-indexing-core` / `urdira-indexing-worker`. The
TypeScript owner loop is only a differential-test oracle, not a production
fallback.

The outer per-generation pipeline is the retained route
this document previously described exclusively. `runFullWorkspaceScan`
(`packages/engine/src/workspace-indexing-session.ts`) is the composition root
for one scan: it captures a stable source observation, updates the source
catalog, analyzes only the required artifact closure, accepts bounded
FactDelta batches from the same Rust syntax/semantic workers used at v4's
`analyze` stage, seals a candidate, and asks storage
(`packages/storage/src/publication-authority.ts`) to publish it atomically
into relational SQLite. `runProgressiveWorkspaceScan` reuses one prepared
source capture across ordered structural stages (syntax, resolution,
semantic-facts), each verifying its direct predecessor is still current
before publishing.

```mermaid
flowchart LR
  Observe["Directory or Git provider\nnative batches and bounded byte hand-off"] --> Catalog["GenericSourceIndexer\nsource catalog and CAS"]
  Catalog --> SourceReady["source snapshot\nsource_ready"]
  Catalog --> Plan["candidate plan\nchanged owner closure"]
  Plan --> Analyze["Rust JS/TS workers\nFactDelta"]
  Analyze --> Batch["bounded FactDeltaBatch\n4 MiB or 4096 rows"]
  Batch --> Stage["Rust-owned SQLite staging\nreceipt and sequence checks"]
  Stage --> Seal["Rust validation and sealing\ncounts, digests, templates"]
  Seal --> Publish["atomic publication\nimmutable generation"]
  Publish --> StructuralReady["structural snapshot\nstructural_ready"]
  Publish --> Lexical["FTS5 reconciliation\nexact byte verification"]
  Publish --> Semantic["semantic reconciliation\nprofile-bound vectors"]
```

A v3 workspace keeps one correctness path even when reuse is available. A
local fork reuses a verified donor inside the same installation. An
explicitly supplied index pack crosses a trust boundary, so
`attemptIndexPackImport` validates its manifest and local source multiset,
verifies record bodies while streaming into an isolated scratch database,
then reuses the fork copy and publication machinery. Any failure rolls back
before the ordinary scan starts.

```mermaid
flowchart TD
  Add["workspace-add with explicit root"] --> Fork{"compatible local donor?"}
  Fork -->|yes| LocalVerify["local fork copy and verify"]
  LocalVerify --> Ready["ready generation"]
  Fork -->|no| Pack{"explicit index pack?"}
  Pack -->|yes| Import["attemptIndexPackImport\nmanifest + local multiset"]
  Import --> StreamVerify["stream scratch rows\nrecord verification workers"]
  StreamVerify --> Copy["bounded bulk copy\npost-copy anchors and ownership"]
  Copy -->|verified| Ready
  Import -->|skip or failure| Rollback["rollback scratch/target attempt"]
  StreamVerify -->|corrupt| Rollback
  Copy -->|mismatch| Rollback
  Pack -->|no| Scan["runProgressiveWorkspaceScan"]
  Rollback --> Scan
  Scan --> Ready
```

This diagram is the v3 route only. First-generation acceleration and the
destructive, non-migrated `index_contract` cutover between formats are
otherwise unchanged from decisions 22/23/26-29; see
[docs/decisions/23-index-pack.md](decisions/23-index-pack.md) for the pack
carrier (v4's own `core:index_pack_export`/`workspace-add --index-pack` route,
described below, re-keys `workspace_id` and runs a `reconcile` scan after
import rather than reusing this v3 fork/copy machinery).

## Readiness and operation availability

Readiness is an operation requirement, not one global boolean, in both
formats. The admission plan derives the required frontier from the requested
operation or pipeline. With freshness mode `wait`, the daemon waits only up
to the declared timeout; otherwise it returns the registered stale/not-ready
error and the frontier that is missing.

```mermaid
flowchart TD
  Request["operation, recipe, or pipeline"] --> Admit["buildQueryAdmissionPlan\nvalidate scope, DAG, budgets"]
  Admit --> Frontier{Required frontier}
  Frontier -->|source| SourceOps["find_artifacts\nget_source\nsearch_text"]
  Frontier -->|structural| StructuralOps["resolve_symbol\nfind_records\noutline and relations\nbuild_context and impact"]
  Frontier -->|semantic| SemanticOps["search_semantic\nsearch_hybrid"]
  SourceOps --> SourceSnapshot["source snapshot binding"]
  StructuralOps --> StructuralSnapshot["structural snapshot binding"]
  SemanticBinding["structural snapshot plus\nsemantic materialization binding"]
  SemanticOps --> SemanticBinding
  SourceSnapshot --> Result["explicit completeness and provenance"]
  StructuralSnapshot --> Result
  SemanticBinding --> Result
```

Lexical search uses FTS5 trigram candidates (or the v4 Rust-owned lexical
build) only when the index is complete for the selected generation and always
verifies candidates against stored bytes. Otherwise it performs an exact
selected-scope scan and reports its freshness; approximate lexical results
are never returned.

## Query execution, bounded pipelines, and cursors

`QueryEngine.execute` normalizes the complete request before work begins,
identically for v3 and v4 workspaces. A direct operation goes through
`CanonicalRecordQueryDataPort`; a recipe expands to registered operations;
and a pipeline goes through `executePipeline`. Ready independent stages may
run concurrently, but a downstream stage observes only sealed upstream
handles. Final iterators are written to an immutable manifest in forward and
reverse order before the first page is returned. On a v4 workspace, an
eligible operation is served by a native pushdown call into the structural
store instead of a JavaScript scan; the emitted results, completeness, and
cursor behavior are unchanged either way.

```mermaid
flowchart LR
  Query["API v3 QueryRequest"] --> Normalize["normalizeQueryRequest\nclosed schema and plan digest"]
  Normalize --> Kind{Expression type}
  Kind -->|operation| Port["CanonicalRecordQueryDataPort"]
  Kind -->|recipe| Recipe["executeRecipe"]
  Kind -->|pipeline| Pipeline["executePipeline\nvalidated dependency DAG"]
  Recipe --> Port
  Pipeline --> Stages["source, expand, set, filter,\njoin, deduplicate, select"]
  Stages --> Spool["execution-scoped SQLite spool\nsealed StageSetHandle values"]
  Spool --> Port
  Port -->|v4 eligible operation| NativePushdown["native structural-store pushdown\n(identity indexes, by_kind_universal)"]
  Port -->|v3, or v4 fallback| Evaluation["streams, completeness, diagnostics"]
  NativePushdown --> Evaluation
  Evaluation --> Manifest["immutable forward and reverse manifest"]
  Manifest --> Page["bounded first page and signed cursor"]
  Cursor["continuation request"] --> Manifest
  Manifest --> Next["bounded next or previous page\nwithout rerunning the query"]
```

The execution spool is temporary and is deleted on success, failure, or
cancellation. Cursor continuations use the persisted manifest, pinned scope,
ordering digest, completeness report, and expiry; they never rerun or rerank
the original request.

## Public MCP operation paths

The MCP adapter exposes three read-only tools. All paths validate API v3 and
explicit scope before local IPC. `urdira_context` lowers to the registered
`core:build_context` intent with a structural wait default, while every other
operation and pipeline is available through `urdira_query`. MCP formatting is a concise projection
of the public result and does not change query semantics; an opt-in,
hidden `snippet_lines` request field (0-3 lines, default 0) additionally
projects a bounded literal excerpt per matched source line.

```mermaid
flowchart TD
  Agent["coding agent"] --> Status["urdira_index_status"]
  Agent --> QueryTool["urdira_query"]
  Agent --> Context["urdira_context"]
  Status --> IndexCall["core:index_status\nlast_scan, orphaned_workspace_data"]
  QueryTool --> QueryCall["core:query or core:query_continue"]
  Context --> ContextIntent["core:build_context\ndefault structural wait"]
  ContextIntent --> QueryCall
  IndexCall --> IPC["local authenticated IPC"]
  QueryCall --> IPC
  IPC --> DaemonRuntime["daemon admission, readiness, execution"]
  DaemonRuntime --> Render["compact text or explicit JSON\nerrors remain typed"]
  Render --> Agent
```

Without injected context, the recommended agent sequence is to call
`urdira_index_status` with the exact workspace root, reuse the returned
`query_scope` in every source-reading request, prefer `urdira_context` or a
bound pipeline for multi-step tasks, and copy continuation envelopes literally.
For an installed prompt hook, a populated Urdira context block is already the
first scoped query and the agent starts from its source. Focused native reads
remain valid for changed, generated or unindexed state, identified gaps and
validation; unchanged source already supplied by Urdira should be reused. The
host-specific bridge, seed selection, source-safe recovery and same-session
prompt-cache behavior are defined by [Decision 19](decisions/19-agent-search-integration.md)
and implemented at `packages/cli/src/agent-integration.ts`; they do not add
fields or state to the public query protocol.

## Workspace lifecycle: orphans and index packs (v4)

Removing a workspace leaves a recoverable tombstone; purging it can still
leave behind data outside the catalog's own bookkeeping (a structural
directory, a sidecar database) if a prior operation was interrupted.
`core:workspace_orphans_list`/`core:workspace_orphans_purge`
(`urdira workspace orphans [purge]`) detect and explicitly remove that residue;
a sweep at daemon startup runs the detection automatically
and reports it without automatic deletion. This startup orphan scan is
distinct from the periodic source-reconciliation sweep, which does not abort
in-flight semantic maintenance unless source work will publish a generation.

`core:index_pack_export`/`workspace-add --index-pack` (decision 23) both use
the v4 native structural store directly: export reports a deadline and
progress and completes in tens of seconds for a multi-million-record
workspace; import re-keys `workspace_id` for the destination and always runs
a `reconcile` scan afterward instead of trusting the pack's own frontier. See
[docs/evidence/2026-09-07-v4-vscode-campaign.md](evidence/2026-09-07-v4-vscode-campaign.md)
and [docs/evidence/2026-09-08-v4-daemon-robustness.md](evidence/2026-09-08-v4-daemon-robustness.md)
for measured export/import timings.

## Response budgeting

`CursorCache.readPage` limits cumulative serialized item characters as well as
item count. Multi-stream query execution shares the character allowance across
streams. The daemon clamps the requested character allowance against its IPC
frame limit before execution and continuation. MCP presentation then measures
the complete rendered envelope and, when necessary, exposes a smaller prefix
of the same immutable execution without changing its public budget, snapshot,
ordering or logical membership. An individually oversized projection fails
explicitly with its required minimum and recovery options. No result is
silently discarded or presented as complete.

## Code landmarks

| Concern | Primary code | What to read there |
|---|---|---|
| v4 scan orchestration | `crates/urdira-indexing-worker/src/v4/scan.rs` | `run_full`/`run_reconcile`: catalog -> parse/semantics -> facts -> materialize -> write -> Merkle -> snapshot -> events. |
| v4 source catalog | `crates/urdira-source-frontier` | Walk, hash, CAS, catalog delta into SQLite and source-state digest. Full/reconcile walks visit the corpus; exact changed-path work narrows capture. |
| v4 structural store | `crates/urdira-structural-store` | Immutable-per-segment, mmap-served, fixed-width-array store with append-only writes and generation-visible set Merkle roots. |
| v4 JS/TS engine | `crates/urdira-jsts-syntax-worker`, `urdira-jsts-native-projection`, `urdira-jsts-typeflow` | Persistent content-keyed syntax analysis, native observation projection, and the local declared-type/lexical resolver. |
| v4 residual checker | `crates/urdira-indexing-worker/src/v4/residual.rs`, `crates/urdira-tsgo-client` | Background `tsgo --api --async` pass that upgrades `possible` rows to `confirmed` outside the scan critical path. |
| Native addon and pushdown | `crates/urdira-native-node/src/structural_store_napi.rs`, `packages/engine/src/native-structural-store-binding.ts` | `NativeStructuralStoreHandle` and the identity/kind pushdown surface used by `CanonicalRecordQueryDataPort`. |
| Reconcile scope | `packages/engine/src/reconciliation.ts`, `watchers.ts`, `crates/urdira-indexing-worker/src/v4/scan.rs::run_reconcile` | Watcher reconcile reasons, `RECONCILE_DELTA_THRESHOLD`/`URDIRA_V4_RECONCILE_THRESHOLD`, delta-vs-cold republish decision. |
| Semantic v4 wiring | `packages/daemon/src/semantic-v4-wiring.ts`, `packages/engine/src/semantic-entity-source-v4.ts`, `semantic-reconciler.ts` | Sidecar attachment, per-document status/coverage, segment cache, sharded child-process maintenance. |
| Workspace orphans | `packages/daemon/src/runtime.ts` (`core:workspace_orphans_list`/`_purge`), `packages/cli/src/index.ts` | Startup sweep and CLI subcommand for residual workspace data. |
| v3 scan composition | `packages/engine/src/workspace-indexing-session.ts` | `runFullWorkspaceScan`/`runProgressiveWorkspaceScan`, retained for `URDIRA_V4=0` workspaces. |
| v3 digest scheduling | `packages/engine/src/materialization-record-digest-pipeline.ts` and `materialization-digest-offload.ts` | Fail-safe record-digest overlap and `MaterializationDigestOffload`'s ordered-set worker offload, with a synchronous in-process fallback for any skipped or failed batch. |
| Index pack bootstrap | `packages/engine/src/index-pack.ts`, `index-pack-verify-core.ts`, and `workspace-fork.ts` | Portable streaming carrier, untrusted verification, bounded copy, rollback, and scan fallback (v3 route; v4 uses its own native import path). |
| Atomic storage publication | `packages/storage/src/publication-authority.ts` | Bounded command streams, phase checkpoints, immutable-row assertions, and current-pointer swap (v3). |
| Query admission | `packages/engine/src/query-plan.ts` | API v3 normalization, stage dependency validation, operation versions, budgets, and plan digest. |
| Query lifecycle | `packages/engine/src/query-execution.ts` | `QueryEngine.execute` evaluates once, persists both manifest directions, pages, and cleans up the spool. |
| Coding-agent bridge | `packages/cli/src/agent-integration.ts` | Explicit-scope prompt/pre-tool hooks, deterministic seed selection, typed source-safe recovery, and client-local prompt-context reuse; see [Decision 19](decisions/19-agent-search-integration.md). |
| Pipeline execution | `packages/engine/src/pipeline-executor.ts` | `executePipeline` schedules ready frontiers and seals every output as a `StageSetHandle`. |
| Canonical operations | `packages/engine/src/canonical-query-data-port.ts` | `CanonicalRecordQueryDataPort` implements language-neutral operations with indexed pushdown (v4) and bounded fallback paths. |
| MCP surface | `packages/mcp/src/index.ts` | `createUrdiraToolDefinitions`, request lowering, IPC invocation, result dieting, and deterministic rendering. |
| Local web surface | `packages/web/src/server/index.ts` and `packages/web/src/client/main.tsx` | Host/Origin-validated, token-free loopback CLI API, Streamable HTTP MCP composition, directory-only selection, and the bundled browser interface. |
| Daemon orchestration | `packages/daemon/src/runtime.ts` and `scheduler.ts` | Workspace lifecycle, readiness barriers, scan scheduling, query cancellation, reconcile dispatch, and maintenance. |
| Physical schema (v3) | `packages/storage/src/schema.ts` and `packages/contracts/src/relational-schema.ts` | SQLite DDL derived from Schema IR and the v3 contract marker (`0x33`). |
| Logical digests | `packages/canonical/src/logical-digest-writer.ts` | Incremental field, presence, type, length, sequence, and canonical-set framing. |

For normative detail, read [Decision 04](decisions/04-workspace-snapshot-incremental-indexing.md),
[Decision 05](decisions/05-storage-projection-architecture.md),
[Decision 20](decisions/20-source-first-readiness.md),
[Decision 21](decisions/21-native-pipeline-relational-storage.md),
[Decision 22](decisions/22-v3-optimization.md),
[Decision 23](decisions/23-index-pack.md), [Decision 24](decisions/24-local-web-interface.md),
[Decision 26 through 29](decisions/26-v4-structural-store.md) for the v4
structural store, semantics, and scan pipeline, and the
[public query contract](protocol/public-query-contract.md).
