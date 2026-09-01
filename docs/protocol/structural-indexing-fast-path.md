# Structural indexing fast path

Status: **Internal approved protocol**  
Version: **1.0.0**  
Last updated: 2026-08-29

## Purpose

This protocol defines the language-neutral high-throughput route from an
immutable source snapshot to structural SQLite authority. JavaScript and
TypeScript are the first production adapter, not part of the core contract.
Adding another language must not add language identifiers, record kinds or
semantic branches to the engine, native core or storage packages.

## Roles

The route has five independently versioned roles:

1. A language syntax adapter consumes exact source bytes and returns ordered
   affected owners plus language-neutral `FactDeltaStream@2` rows. It may be a
   supervised native worker and may retain incremental syntax/dependency state.
2. A language semantic oracle owns only semantics that require its authoritative
   compiler or analyzer. It keeps one prepared program per workspace and serves
   bounded owner groups. It does not publish, assign generations or open SQLite.
3. The core-owned Rust structural kernel validates the closed physical row
   shape, performs canonicalization, UCE bodies, content identities and
   registered digests once, and attaches typed publication scalars to the same
   accepted rows. Registry, scope and snapshot coordinates remain core inputs.
4. Candidate staging atomically stores recovery rows, typed publication rows and
   owner receipts. A receipt is durable only after the complete owner stream is
   valid. Partial staging is never visible.
5. SQLite publication is executed by the Rust core against sealed typed
   relations through a fixed set of `INSERT ... SELECT`, `UPDATE`, `JOIN` and
   `EXCEPT` statements and atomically advances the current snapshot. The
   TypeScript storage implementation is retained only as a differential test
   oracle, never as the production writer after Rust cutover.

Cold indexing is the empty-base case of this route. Incremental indexing uses
the same roles and contracts, with an affected-owner set and typed open/closure
relations. It is not a separate TypeScript implementation.

## Required limits and ordering

- One logical owner stream is independently attributable by workspace,
  candidate, work item, owner artifact/version, scope, digest and receipt.
- A physical fact group is bounded by 64 owners, 4,096 rows or 16 MiB. The
  core seals it dynamically before admitting the next owner.
- A semantic lookup group is bounded by 32 owners and a 16 MiB request. Its
  result is not an aggregate durability unit: each result remains an
  independently pullable owner stream and may cross one or more physical fact
  groups downstream.
- `semantic_group_start` returns owner-delimited headers only. Rows are obtained
  with a bounded `semantic_group_next` continuation that carries several
  ordered owner frames and the exact next owner cursor. Each owner frame carries
  Rust-sealed canonical record/dependency rows plus closed stream metadata
  rather than a nested JavaScript object graph. A partially drained oversized owner
  continues at its own batch sequence. A group header must never contain
  materialized batches.
- One oversized owner continues with its own cursor. It is isolated in its own
  physical transaction and cannot make another owner's partial stream durable.
- Cancellation is checked before scheduling a group and between every remote
  cursor, staging batch and SQL phase.
- Canonical order, public IDs, digests, diagnostics and query order are
  independent of physical group boundaries.
- Canonical owner observations may carry the producer's exact `fact_delta_id`;
  when present, Rust reuses that namespace for receipts and typed staging.
  A missing id is accepted only for private compatibility clients and is
  replaced by a deterministic internal receipt id.

## Semantic oracle contract

An oracle may batch symbol, alias, signature, type and diagnostic operations,
but the returned result remains delimited by owner. Compiler handles may live
only for the active group. The prepared program/checker survives between groups
and incremental updates; it is not periodically reconstructed.

The semantic process must not reject a lookup group after emitting an earlier
owner merely because the combined results exceed the physical row or byte
budget. Result volume is unknowable until the owner streams are pulled. The
language-neutral core acceptance service owns that backpressure boundary and
seals 4,096-row/16-MiB physical groups without replaying compiler work.

The JavaScript/TypeScript adapter uses the pinned TypeScript checker for this
role. A future Rust, Python, Java or other adapter supplies its own oracle while
using the same downstream fact, kernel, staging, receipt and publication route.

An oracle process may execute the core structural kernel only through an exact
binding supplied in its versioned private handshake by the composition root.
It must reject relative paths, ambient resolution and API mismatches. This is
an execution placement optimization, not a language-specific core contract.
Owner observations are projected once, Rust-owned canonical bytes seal the
header and typed rows, and final framing reuses that seal. A future language
oracle may emit different observations, but it must use this same one-pass
owner lifecycle for both cold and incremental work.

Before framing, an oracle exposes a bounded ordered collection of prepared
owners to `prepareFactDeltaStreamStructuralGroup`. The port accepts at most 64
owners and 4,096 total records plus dependencies. It concatenates only for the
row-intrinsic Rust kernel call; it never merges headers, scopes, digests,
receipts or transactions. The language adapter then seals each owner in its
original order using the cached Rust result. If a group cannot be presealed,
scalar framing remains authoritative and must reproduce the exact validation
outcome. This contract is shared by every language engine.

A sealed stage handoff is consume-once. When an upstream semantic stage has
already executed its language oracle and sealed the complete projection for a
downstream stage, the downstream stage must read that generation-scoped spool
without rerunning the oracle, checker or analyzer. The optimization is allowed
only when every requested owner matches the exact generation and stage entry.
One missing, stale or invalid entry selects the complete oracle-backed path for
the bounded group, so a group never combines partial spool authority with
fresh observations. This rule applies identically to cold and incremental
generations and is independent of the language-specific oracle.

The Rust-owned JavaScript/TypeScript bridge sends the complete changed and
affected path scope exactly once with `analyze_closure`. Each subsequent owner
request carries a canonical `rust_semantic_scope_ref` and its local
`root_names` marker; the checker accepts the request only when that reference
matches the prepared scope. This compact private framing is semantically
equivalent to repeating the closed scope object and prevents an O(owners)
copy of the workspace manifest without introducing a second analysis or
writer.

The sealed-row response is not a trust shortcut. Protocol 1.8 retains canonical
rows as opaque strings in the host. Native API v15 independently parses them
into closed Rust structs, rejects non-canonical text, validates the target
record definition and returns compact accepted fields plus the typed
projection. The engine separately checks owner, candidate, scope, manifest,
dependency closure and completeness before staging. Only this receiving-core
result is eligible for staging. This invariant is shared by every language
oracle and by cold and incremental generations.

## Native observation projection

Semantic process protocol 1.9 and native API v16 remove the producer-side
logical-row loop. A language adapter sends a bounded group to a closed native
projection profile. The generic envelope contains only `profile_id` and a
profile-owned observation batch; unknown profile identities and unknown fields
are rejected. The JavaScript/TypeScript profile
`urdira:jsts-semantic-observations:v1` accepts checker entities, relations,
diagnostics, immutable artifact bindings and the already-authorized record-kind
set. It emits ordinary language-neutral FactDelta rows and immediately invokes
the shared producer seal for canonical bytes and compact identity headers. The
producer response deliberately omits nested logical rows, IDs, registered
digests and typed publication objects. Owner header and delta digests are
streamed over the immutable canonical rows; the independent receiving core
then reparses them and remains the only authority that may emit IDs, UCE
payloads, registered digests and typed staging scalars.

Each future language engine owns its observation schema and native projector,
but must return the same structural result and then use the same owner-scoped
headers, canonical receiving-core validation, typed staging, receipts and
set-based SQLite publication. A language profile cannot define publication,
query, pagination, receipt or digest semantics. Cold and incremental runs use
the same profile and differ only in the owner set selected by core invalidation.

## Typed publication eligibility

Typed promotion is fail closed. Every logical record open must have an exact
native projection and body payload, and the sealed descriptor counts and
digests must match the canonical template sets. Progressive initial successors
may use the direct typed lane even when a syntax snapshot is already visible,
provided their replacement scopes contain only first opens and no closures.

Incremental publication stages record closures in a candidate-scoped typed
relation and applies them with one set-based update. Replacement or
absence-barrier opens that do not yet carry a native lifecycle descriptor use
the ordinary canonical materializer only on the portable compatibility/oracle
route, when no Rust composition worker owns the generation. Once the Rust
composition worker is active, a missing native lifecycle descriptor is a
closed error; the application never falls back to the TypeScript materializer
or writer. This compatibility-only branch changes performance only, never
identity, atomicity or completeness.

## Conformance

Every language adapter must pass the same conformance suite with:

- exact cold/incremental visible-set and digest equivalence;
- owner ordering, continuation, oversized-owner and backpressure cases;
- cancellation, crash, replay and conflicting-receipt cases;
- a structurally different reference adapter in addition to JavaScript and
  TypeScript; and
- no language namespace in core/native/storage implementation branches.

Embeddings are outside this protocol and never block structural readiness.

## Rust indexing-core operation boundary

The production operation is a closed `index_generation` request carrying the
workspace, base/source snapshot, explicit absolute `cas_root` for the captured
content-addressed source blobs, registry/configuration/resolution
coordinates, exact change set, verified engine descriptor, and deadline. The
application receives only bounded progress and a final result, plus
`cancel`, `status`, and `shutdown` responses. A persistent composition worker
dispatches the request to the language engine and writes SQLite directly.
The request also carries the immutable candidate, frozen-base and work-manifest
coordinates; Rust persists that lifecycle metadata before accepting engine
groups, so the application does not open a competing candidate writer.
For the built-in JS/TS engine the request also carries an opaque source
configuration (project identity, analysis configuration and bounded budgets).
The composition worker resolves the source frontier and CAS paths itself,
runs the persistent syntax state, and returns only bounded progress metadata
(affected paths and dependency graph) to the application.

The finalization envelope may include the immutable CAS root and byte bound for
lexical maintenance. Rust executes that reconciliation only after the
structural publication commit, under the same workspace writer exclusion; the
TypeScript daemon does not enqueue a second lexical writer for that generation.

Source-catalog rows use the same Rust writer even when reconciliation is an
equivalent scan with no candidate publication. The private
`source_index_commit` control message carries bounded, CAS-only source commit
metadata; Rust validates the workspace/state revision and inserts batches,
artifacts, observations, content references, versions and tombstones in one
`BEGIN IMMEDIATE` transaction. No TypeScript SQLite source writer is selected
on the production cutover route.
Failed first-generation fork attempts use the paired `source_index_rollback`
control message, so source-layer recovery remains on the Rust writer boundary
and cannot leave a partially committed catalog for the TypeScript fallback
scan.

Cancellation is carried on the closed control protocol. The local process
transport additionally supplies a deterministic private sidecar path derived
from the database path and operation identity. The sidecar is created before
`index_generation`, written by `cancel`, and removed after finalization or
failure. Rust treats its presence as cancellation at every checkpoint, so a
synchronous generation remains cancellable without opening another SQLite
writer or exposing a filesystem control surface to the application.

Rust owns validation, physical grouping (64 owners/4,096 rows/16 MiB),
idempotent receipts, canonical/UCE/ID/digest sealing, staging, publication,
recovery, cancellation, and metrics. Publication and lexical reconciliation
run under one exclusive workspace writer schedule, coordinated across
processes by `<database>.urdira-writer.lock`; query connections remain
read-only. The TypeScript owner planner and writer are retained solely as a
differential oracle and are not a production fallback after activation. When a
production process requires the verified native runtime, startup also fails
closed if the packaged `urdira-indexing-worker` is absent instead of silently
selecting that oracle.

The Rust sink records the exact publication descriptor and canonical body
payload in its typed temporary staging rows; the legacy candidate metadata
table retains only proposal/identity fields and no second hexadecimal body
copy. If a legacy acceptance has already materialized the same owner namespace,
Rust reuses that validated namespace instead of inserting duplicate rows; the
cutover path promotes the Rust-owned rows directly. This applies to cold and
incremental replacements: the Rust engine owns both opened-row and
replacement-close staging. A private candidate hook runs after the candidate
materialization is persisted and hands only the bounded publication envelope to
Rust; Rust then installs the v3 relations, snapshot, manifest, journal and
current-pointer CAS in one atomic transaction.

When the Rust composition worker is active, the application requests a single
generation with the syntax frontier and accumulated semantic stage-2/3
capabilities. The worker accepts both into the same core staging transaction;
the portable compatibility route alone retains progressive multi-generation
publication. This prevents re-analyzing and re-promoting the same cold owner
set while preserving the stage-2/3 record vocabulary and visible-set digest.

Candidate identity and lifecycle metadata follow the same boundary. The
application constructs the immutable candidate and pure work manifest, then
includes them in the opaque generation envelope; it does not insert candidate
rows, select manifests or transition candidate state on its SQLite connection.
Rust records the candidate as `analyzing` before engine staging and marks it
published (or failed) in the Rust publication/recovery transaction.

### Source frontier handoff amendment (2026-08-31)

The production opaque JS/TS source capture no longer contains `files` or
`root_names`. After the source-index commit is visible, the generic core reads
the current `source_artifacts` and `artifact_versions` frontier through its
leased connection. The language engine filters its own extensions and derives
the absolute CAS coordinates inside Rust. The private fields remain accepted
only for differential/oracle callers, so no owner-sized source manifest is
sent across the application/Rust IPC boundary.
