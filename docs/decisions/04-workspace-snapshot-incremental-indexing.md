# Workspace, Snapshot, and Incremental Indexing

Status: **Approved**  
Last updated: 2026-08-08  
Depends on: Universal data model and plugin contract

## Decision objective

Define workspace registration, source providers, immutable snapshots, real-time update processing, cross-file invalidation, concurrency, and snapshot retention.

## Existing constraints

- Urdira indexes workspaces rather than Git branches or repositories.
- Git metadata is optional and does not define identity.
- Git worktrees, ordinary checkouts, detached states, clones, virtual Git references, and non-Git directories are supported.
- Every live workspace has independent watching, update queues, and snapshots.
- Queries pin immutable snapshots.
- File ownership and reverse dependencies drive invalidation.
- Multiple agents may use different workspaces concurrently.
- Every code snapshot references one immutable registry snapshot and exact plugin resolution lock.
- Plugin changes build a frozen candidate generation and publish code snapshot, registry snapshot, and lock atomically; failed candidates never alter the current tuple.
- Embedding-profile selection and any configured fallback are resolved before indexing and pinned by the configuration revision. A generator or asset failure cannot switch profiles inside a candidate generation; changing the resolved profile set requires another configuration revision and new semantic materializations.

## Approved decisions

The authoritative logical schemas are defined only in the [universal data model](01-universal-data-model.md). This specification owns their operational behavior and does not restate alternate model shapes.

- Every query names its complete workspace scope; a normal query has one `workspace_id`, while an approved comparison enumerates every participant. MCP connection state never supplies an implicit workspace.
- Published workspace generations are strictly increasing, gapless integers. Candidate work uses an opaque identifier and receives a number only during successful atomic publication.
- Canonical knowledge uses half-open visibility intervals. Closure is monotonic, a closed lifecycle identity never reopens, and physical deletion is deferred.
- Source-provider observations preserve provider-local ordering separately from generations. Coverage and deletion authority are explicit; partial scans cannot infer deletion.
- Confirmed deletion and configuration exclusion create distinct artifact tombstones. Temporary unavailability preserves the last valid state and degrades freshness instead of deleting knowledge.
- Duplicate events and equivalent rescans advance freshness checkpoints without publishing empty generations.
- Confirmed deletion and exclusion are non-coalescible lifecycle barriers. If later presence is already queued, Urdira still publishes the absence and reappearance as two ordered consecutive generations so closed semantic identities cannot continue through the gap.
- Candidate analysis may run concurrently. Publication is serialized per workspace and requires the exact base snapshot, registry, and configuration to remain current. Stale candidates are replanned; the initial contract forbids automatic merge or rebase.
- Work manifests freeze artifact and projection scopes. Fact deltas are candidate-scoped, authoritative within registered replacement scopes, and idempotent by identifier and digest.
- Reverse artifact dependencies, record-input transitive artifact closure, membership-sensitive lookup dependencies, and conservative plugin fallbacks produce a complete invalidation plan. Empty or absent lookup results remain dependencies: a future matching addition re-evaluates the selector. If targeted address/selector invalidation cannot be proved safe, scope widens to plugin partition, plugin, or workspace exactly as the capability contract declares.
- Snapshot publication atomically installs the snapshot, generation manifest, canonical changes, derived changes, and current workspace tuple.
- Snapshot leases protect active queries, comparisons, candidates, and recovery operations. Pins protect policy, manual, and recovery-checkpoint retention.
- Cursor or snapshot expiration never changes query scope silently and has distinct public error codes.

## Workspace lifecycle

Registration creates a random stable `workspace_id` for one explicit source-provider binding and normalized source root. Path, Git repository, branch, commit, remote, inode, and content do not determine that identity. Registering an already active canonical provider root is idempotent and returns the existing workspace unless the caller explicitly requests a separate virtual provider instance.

A physical workspace stores both its display path and a provider-normalized canonical root. Symlinks are resolved according to the configured source-boundary policy before duplicate detection. Moving a root does not automatically transfer identity based only on matching content. Relocation is an explicit control operation that proves continuity using the old workspace ID, the previous provider fingerprint, and the new root; it updates control state without changing snapshots or entity identities. If the old root is missing and exactly one candidate matches its provider-stable filesystem identity or Git worktree administrative identity, status may propose a relocation, but activation still requires administrator approval.

`suspended` stops watching and indexing while retaining the current snapshot. Resume changes `suspended -> indexing`, performs a full authoritative reconciliation, and reaches `ready` or `degraded`; there is no separate `active` state. `removed` closes the registration, watchers, and future updates but leaves retained snapshots governed by retention. Re-registering the same directory after removal creates a new workspace ID; removed identities never reopen.

Workspace state is `registering`, `indexing`, `ready`, `degraded`, `suspended`, `removing`, or `removed`. The legacy structural query contract treats only `ready` and `degraded` as having a current queryable structural snapshot. Source-first Index Status API v3 additionally exposes a separate immutable source snapshot after generic catalog publication; that source snapshot is queryable only through the source-safe Query API v2 operations and does not make structural facts queryable. `degraded` means the last valid snapshot remains readable while freshness or optional capabilities are incomplete; it never exposes a half-published candidate.

## Codebase grouping

`Codebase` is an optional user-managed grouping for related workspaces. Urdira may propose membership using Git common-directory identity, normalized remote fingerprints, or an explicit portable project marker, but these are hints. Membership never merges snapshots, entities, plugin locks, configuration, update queues, or query scope.

Clones and worktrees may share a codebase while retaining independent workspace IDs. A non-Git directory may belong to a codebase, and a workspace may be ungrouped. Comparison requests still name every workspace explicitly; codebase membership is never an implicit fan-out selector in the initial public API.

## Source-provider protocol

Every source provider implements five exact operations:

- `describe`: return provider kind/version, immutable binding identity, supported observation features, read-only status, case behavior, and current source-state fingerprint.
- `enumerate`: return a complete or explicitly partial `SourceObservationBatch` for a requested coverage scope and a new provider watermark.
- `read`: return exact bytes and metadata for one observed artifact only when its provider version token still matches; otherwise return `source_changed`.
- `watch`: stream ordered hint events after a watermark. Events are hints and never deletion authority by themselves unless the provider contract marks the exact event class authoritative.
- `reconcile`: capture a stable authoritative enumeration for requested scopes and report whether source changed during capture.

The exact request, response, payload, feature, resource-budget, and error shapes are defined once in the universal data model. Every envelope carries the protocol version, request identity and digest, exact workspace/binding/component coordinates, call, deadline, cancellation identity, and bounded resources. Every response repeats its correlation fields and has exactly one outcome: `success`, `source_changed`, `unavailable`, `deadline_exceeded`, `resource_exhausted`, `cancelled`, or `failed`. Providers cannot create snapshots or artifacts directly; the core validates and commits successful observations.

Only a successful stable `enumerate` or `reconcile` result whose batch has complete scope coverage and deletion authority can infer absence from a missing item. An individually authoritative watch deletion may prove only its named artifact when the provider advertised and registered that event class. Empty results, partial scans, watcher overflow, source changes during capture, provider unavailability, budget exhaustion, cancellation, and generic failure never prove absence. They preserve the last published source state and drive retry or degraded freshness according to the closed outcome.

A stable enumeration is bracketed by provider state fingerprints. If the fingerprint changes during capture, the batch is non-authoritative and is retried; it cannot infer deletion. Exact file reads validate the observation token both before and after reading. Content is accepted only when the resulting digest and metadata correspond to one stable observed occurrence.

The initial providers are:

- `core:directory_source_provider`, backed by a physical directory and platform watcher;
- `core:git_worktree_source_provider`, the same physical view plus Git metadata and administrative-directory observation;
- `core:git_reference_source_provider`, a read-only tree resolved from an exact Git object ID.

The Git-reference provider resolves a branch or tag to an exact commit before enumeration. When analyzers require paths, the core materializes content into a private digest-keyed read-only cache, never checks out into the user workspace, never changes refs, and never runs repository hooks. Moving a branch later creates new observations only after explicit refresh; retained snapshots continue to identify the previous commit.

## Observation batching and reconciliation

Watcher events are low-latency hints. The default scheduler begins a workspace batch after 50 ms without another related event and forces a capture after 250 ms of continuous activity. These defaults are configurable within safety bounds and do not affect logical output. Deletion, exclusion, provider reset, and explicit freshness barriers bypass ordinary debounce.

Coalescing may collapse repeated modify hints for the same path before stable capture. It may not erase an authoritative absence barrier, reorder provider watermarks, or merge events across different provider bindings. Rename hints are normalized to absence plus presence with optional lineage metadata. The stable reconciliation result, not watcher event shape, determines content updates.

Each active physical workspace runs:

- a targeted reconciliation after every settled event batch;
- an administrative-state reconciliation after Git metadata changes;
- a complete authoritative reconciliation every 10 minutes by default; and
- an immediate complete reconciliation after watcher overflow, provider restart, daemon recovery, resume, or explicit freshness request that cannot be proven from targeted state.

Periodic timing is operational policy and may be configured, but disabling full reconciliation is forbidden for watched mutable providers. Equivalence produces only a new freshness checkpoint, not a generation.

## Branch switches and mass changes

A Git HEAD, index, worktree administrative, or provider-root transition opens a source barrier. Urdira pauses ordinary targeted publication, waits for the provider to report a stable state, performs one complete authoritative reconciliation, and plans the exact difference from the current snapshot. Queries continue against the prior snapshot and report freshness as stale while the barrier is open.

The stable target state publishes atomically as one generation even when thousands of artifacts change. Paths present on both sides are content updates; paths absent in the target receive tombstones; new paths receive new artifact occurrences. An absence followed by presence is published as two generations only when Urdira authoritatively observed and queued the absence as a stable source state before the later presence. It does not invent a transient deletion from intermediate branch-switch filesystem noise.

Mass-change analysis is chunked internally but its candidate manifest is frozen as one logical publication. Resource pressure delays publication or returns degraded status; it never exposes a mixture of old and new branch state.

When a plugin declares ordered structural stages, each stage is its own atomic
candidate generation referencing the same immutable source snapshot. Completed
capabilities are queryable with `partial` completeness; blocked capabilities
return retryable errors. `structural_ready` becomes true only after the final
stage for the current source commits. A crash exposes the prior complete stage,
never a half-published candidate.

## Freshness barriers

The public freshness modes are those defined by `QueryOptions`:

- `snapshot` requires explicit retained snapshot IDs and performs no source wait;
- `current` atomically pins the latest published snapshot and latest checkpoint, even when newer observations are pending;
- `wait_for_current` waits until the selected snapshots have `equivalent` checkpoints covering every provider watermark observed when the barrier began.

The barrier captures target watermarks once after request validation. Newer events arriving later do not perpetually extend that request. If the captured state changes while being indexed, the provider's ordered successor required to represent that captured watermark is included. The default wait timeout is 5 seconds, the maximum ordinary agent timeout is 60 seconds, and zero means perform the check without waiting. Timeout produces `core:freshness_wait_timeout`; it never falls back silently to `current`.

For comparisons, target-watermark capture and snapshot lease acquisition are atomic at the query-planning boundary. Success returns one self-consistent binding per participant; failure returns no partial comparison.

## Retention defaults

Every workspace retains its current snapshot, every active pin or lease, every active or recoverable candidate base, and the broader of:

- the previous 32 published generations; and
- every snapshot published during the previous 24 hours.

The defaults are configurable per installation or workspace. A policy may increase retention freely. Reducing it schedules collection but cannot revoke an existing pin, lease, active cursor execution, candidate, or recovery checkpoint. Query executions have a default fixed lifetime of 30 minutes and a configurable maximum of 24 hours; accessing a cursor does not extend it, so expiry is deterministic.

At least one verified recovery checkpoint per workspace is retained in addition to the current snapshot. Expiration leaves the approved minimal marker. Retention age and generation count select candidates only; reachability and the GC reader barrier authorize physical deletion.

## Content reuse and workspace overlays

Exact decoded content bytes are stored globally by content digest. Identical blobs, local syntax results, and embedding computations may be physically reused under their approved complete keys. Every `SourceArtifact`, `ArtifactVersion`, canonical record, dependency, projection, snapshot, and result subject remains workspace-owned even when bytes are shared.

Workspace overlays contain provider address, normalized relative path or URI, mode and executable metadata, symlink policy result, artifact occurrence identity, source observation, selected language, configuration, project partition, and dependency context. Overlay values are never inferred from the shared blob. Cross-file resolution output is reusable only when every workspace-context digest in its registered recipe matches exactly.

Shared-cache hits go through the same validation and canonicalization path as newly computed output. Reuse cannot continue a closed lifecycle identity, copy a record ID between workspaces, or suppress required dependency edges. (Amended by [decision 11](11-content-derived-record-identity.md): record ids are now content-derived, so two workspaces with identical content independently mint the identical record id without either "copying" it; workspace scoping is enforced by row columns and database binding, not id salting. The rest of this rule is unchanged.)

## Interrupted indexing recovery

Candidate construction uses only the canonical persisted states `queued`, `planning`, `analyzing`, `validating`, `projecting`, `ready`, `publishing`, `published`, `stale`, `failed`, and `cancelled`. Its normal path is `queued -> planning -> analyzing -> validating -> projecting -> ready -> publishing -> published`. Work-item leases and attempts are ephemeral; accepted deltas, issue records, access manifests, lookup dependencies, manifests, and verified staged objects are persisted by digest. Each delta is locally validated before dependent enrichers may consume its staged views; whole-candidate validation remains a later state. `CandidateMaterialization` is sealed and receives identity only on entry to `ready`.

On restart, Urdira first verifies the current workspace tuple and publication journal. A transaction with no committed complete publication tuple is invisible and rolled back or resumed from verified staged objects without consuming a generation. A committed tuple with an unacknowledged response or incomplete cleanup is treated as published, the candidate is confirmed as `published`, and cleanup resumes idempotently. It can never become failed or publish the same generation again. There is no state in which a snapshot is current without its manifest, registry, resolution lock, configuration, and required projections.

Candidates whose frozen base tuple is still current may resume missing idempotent work. Candidates with changed base, registry, resolution lock, configuration, or source observations are cancelled and replanned. Plugin responses from a previous daemon process are accepted only if their complete request and output digests match persisted work items; otherwise they are discarded.

Recovery runs an authoritative provider reconciliation before declaring mutable workspaces fresh. The last verified snapshot remains queryable throughout. Repeated recovery failure marks the workspace degraded and exposes bounded candidate issues; it never deletes the last valid state.

## Conformance scenarios

The indexing contract requires deterministic fixtures for duplicate and reordered watcher hints, missed events repaired by reconciliation, stable and unstable reads, watcher overflow, branch switch, detached checkout, virtual Git refresh, non-Git directories, simultaneous workspaces, deletion/reappearance barriers, daemon crash in every candidate phase, stale candidate rejection, and cursor reads while newer generations publish.

## Completion criteria

The design defines consistent behavior for concurrent updates, missed watcher events, branch switches, non-Git directories, and paginated queries over retained snapshots. Implementation acceptance requires the conformance scenarios above on every supported platform watcher.
