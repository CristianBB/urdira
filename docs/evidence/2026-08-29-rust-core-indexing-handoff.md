# Rust Core Structural Indexing Handoff

Status: **Evidence-backed implementation handoff; not normative authority**  
Date: **2026-08-29**  
Scope: **cold and incremental structural indexing**

## Purpose

This report is the starting point for a fresh implementation session. It
consolidates the retained n8n evidence, records the architectural conclusion,
defines the next implementation boundary, and prevents another sequence of
expensive 512-owner runs for changes that can be rejected by smaller gates.

The implementation session that followed this handoff has now amended the
authoritative Decisions 21, 22 and 25 and the structural fast-path protocol.
The Rust composition-worker cutover described in the later entries is the
current production design; this file remains historical evidence and is not a
second source of architectural authority.

The conclusion is no longer that Rust should accelerate selected loops inside
a TypeScript-owned indexing pipeline. The complete structural write path must
be owned by a Rust core. Language engines feed that core through a bounded,
language-neutral contract. The JavaScript/TypeScript engine is the first such
engine. TypeScript application code may retain public query orchestration,
MCP/CLI integration and compatibility or differential-test oracles, but it must
not sit between language analysis and SQLite staging/publication.

This report cannot change architecture authority by itself. The amendments to
Decisions 21, 22 and 25 and to the structural fast-path protocol are recorded
in those authoritative documents; they supersede the former description of
Rust as a bounded accelerator hosted by TypeScript.

## Fixed product and correctness requirements

- The retained corpus authority digest is
  `sha256:1dd28be497b20c5f1b3585dd7438e69060ef5a2fbe5660a5e7f5d728a492d2ed`.
- Complete structural readiness includes source/CAS, syntax, declarations,
  dependencies, resolution, calls, inheritance, types, diagnostics and current
  non-vector projections.
- Embeddings remain asynchronous and do not delay structural readiness.
- Cold structural P95 is at most 30 seconds; content-only incremental P95 is at
  most 2 seconds.
- Process-tree RSS is measured against a 2 GiB advisory budget and temporary
  bytes are at most 1.5 times the final database size. An exact sample that
  exceeds the RSS budget remains admissible when its agreed time gate passes;
  the overage is retained as telemetry and an optimization item.
- Records, relationships, diagnostics, order, provenance, IDs and every
  registered digest must remain exactly equal.
- The last published snapshot remains visible until one atomic commit advances
  it. Cancellation, crash, replay and recovery may never expose partial staging.
- SQLite remains the authoritative v3 storage format. Moving SQLite ownership
  to Rust does not authorize a format, schema, identity, ordering, query or
  compatibility change.
- Public MCP, operations, schemas, pagination, ordering and query behavior do
  not change.

## Evidence summary

The retained 512-owner experiments show an exact-output improvement from
86.668 seconds to a best observed 62.622 seconds. That is material engineering
progress, but it is not close enough to either the 45-second admission gate or
the 30-second product target. The latest implementation completed in 64.063
seconds. Moving individual canonicalization, digest, projection and acceptance
loops to Rust did not remove the TypeScript-owned per-owner lifecycle around
them.

The visible-set digest for every equivalent result in the current lineage is:

`sha256:b0bca5901be3cdc71c500ff3180df59c663b5e77645c4165cd0779b8703e0934`

Two intermediate reports produced
`sha256:293304c0f2bd6dc802af503e9eb3d06f4b95cd4c0352dd869470da7efa6390c2`.
They are retained diagnostic evidence but are not correctness-equivalent
performance results.

### Retained 512-owner measurements

The table is ordered by observed wall time, not implementation chronology.
One observation is not a P95 result and small differences between adjacent
runs must not be interpreted as stable wins.

| Report | Wall | Peak RSS | Visible digest |
| --- | ---: | ---: | --- |
| `sealed-observation-projection` | 62.622 s | 2,657,337,344 B | exact |
| `light-native-observation-seal` | 64.063 s | 2,737,356,800 B | exact |
| `opaque-rust-acceptance` | 64.714 s | 2,647,982,080 B | exact |
| `stage3-consume-once` | 66.114 s | 2,877,521,920 B | exact |
| `native-observation-projection` | 66.199 s | 2,875,686,912 B | exact |
| `generic-fast-path` | 66.476 s | 2,251,423,744 B | exact |
| `rust-preseal` | 66.534 s | 2,340,651,008 B | exact |
| `group-rust-preseal` | 67.132 s | 2,737,569,792 B | exact |
| `sealed-canonical` | 67.333 s | 2,912,485,376 B | exact |
| `owner-scoped` | 67.655 s | 2,289,205,248 B | **not equivalent** |
| `global-diagnostics` | 68.310 s | 2,456,797,184 B | exact |
| `group-drain` | 68.363 s | 2,644,426,752 B | exact |
| `rust-typed` | 68.959 s | 2,414,034,944 B | exact |
| `one-pass-rust-kernel` | 69.319 s | 2,752,249,856 B | exact |
| `columnar-semantic` | 69.751 s | 3,558,293,504 B | exact |
| `batched-diagnostics` | 71.605 s | 2,454,994,944 B | **not equivalent** |
| `grouped-batches` | 71.970 s | 2,176,745,472 B | exact |
| `physical-groups` | 72.129 s | 1,990,426,624 B | exact |
| `multirow-staging` | 72.329 s | 2,402,631,680 B | exact |
| `uce-kernel` | 76.396 s | 2,089,205,760 B | exact |
| initial retained preflight | 86.668 s | 2,009,497,600 B | exact |
| `optimized` | 102.998 s | 2,225,422,336 B | exact |

The reports and their checksum sidecars are retained under
`release/benchmarks/`. The most relevant checkpoints are:

| Evidence | SHA-256 |
| --- | --- |
| `n8n-structural-preflight-512-2026-08-29.json` | `cc736a443c28e19dc0d6226fa2ea28748b4df4867eeacd57a85197ec5b952400` |
| `n8n-structural-preflight-512-2026-08-29-physical-groups.json` | `f0d56e1dfc641050382396eb0300ca444e71afe52013bc79bd1d6aef654e5961` |
| `n8n-structural-preflight-512-2026-08-29-opaque-rust-acceptance.json` | `ffc7dc1c2ce75e7ee7abb7850c64d97d727dbf2148e5686a26d8f5eff1c360bf` |
| `n8n-structural-preflight-512-2026-08-29-sealed-observation-projection.json` | `0ef94c310bb80ddf2ea13fbff3b824f2dd2fee03c942da1510ad848664951a30` |
| `n8n-structural-preflight-512-2026-08-29-light-native-observation-seal.json` | `6c17ccc1fc4dd361befbbe1d896c8029b41d9779b6ee4475a37f42aab59e261c` |

### Latest exact subspan evidence

The latest 64.063-second run reports:

| Subspan | Duration |
| --- | ---: |
| Source/stage-one structural readiness | 11,108 ms |
| Stage-three structural readiness | 48,549 ms |
| Stage-three plugin analysis | 24,586 ms |
| Outer FactDelta acceptance | 23,727 ms |
| Receiving-core Rust acceptance | 5,213 ms / 516 batches |
| Group commits | 4,042 ms / 37 groups |
| Seal | 5,959 ms |
| Typed staging | 5,910 ms |
| Publication plan construction | 8,282 ms |
| SQLite publication transaction | 8,042 ms |

The outer acceptance span begins before awaiting lazy owner stream creation.
It therefore contains language-oracle production, projection, framing and
per-owner TypeScript orchestration in addition to the separately measured Rust
receiver and grouped commits. Approximately 14.5 seconds remain around the
5.213-second receiver and 4.042-second commits. This is the direct evidence for
removing the TypeScript-to-staging owner loop, rather than optimizing another
function inside that loop.

### SQLite evidence

The set-based one-million-row microgate already meets its fixed ten-second
gate:

| Route | Rows | Transaction |
| --- | ---: | ---: |
| initial set-based publication | 1,000,000 | 9,454.544 ms |
| Rust-typed input | 1,000,000 | 5,677.647 ms |
| generic fast path | 1,000,000 | 5,782.481 ms |

This evidence rejects replacing SQLite merely because the end-to-end path is
slow. It does support moving the identical SQLite transaction, schema and
semantics into the Rust core through `rusqlite`, because database insertion is
core authority and removing the Node/worker boundary is now the objective.
The engine-specific code must never open or mutate SQLite directly.

## Required architecture

The production write path must have three layers.

```text
TypeScript application shell
  - MCP, CLI and public query contract
  - read-oriented query orchestration
  - lifecycle commands: start, status, cancel, shutdown
                    |
                    | one operation-level native boundary
                    v
Rust indexing core
  - source/CAS coordination and stable capture
  - candidate, generation and affected-owner planning
  - registry/scope/provenance validation
  - canonicalization, UCE, IDs and registered digests
  - physical grouping, backpressure and cancellation
  - rusqlite staging, receipts, WAL and publication
  - atomic current-snapshot swap, replay and recovery
                    |
                    | language-engine contract
                    v
Rust language engines
  - language discovery and project partitioning
  - syntax/declaration/dependency state
  - affected-owner calculation
  - language semantic observations
```

### Rust indexing core

Create a core-owned Rust crate and runtime component whose responsibility is
the complete mutation path from an immutable captured source generation to an
atomically published SQLite snapshot. It must own:

- the SQLite writer connection and transaction schedule;
- candidate-scoped staging tables and namespace allocation;
- independent validation of every language-engine result;
- canonical rows, IDs, UCE bodies, logical and registered digests;
- owner receipts, sequence/cursor validation and idempotent replay;
- typed open, closure, dependency, identity, diagnostic and projection rows;
- the sealed generation descriptor;
- fixed set-based publication SQL and exact `changes()` assertions;
- WAL checkpoint policy, crash recovery and incomplete-staging cleanup;
- cancellation and timeout checks between groups and SQL phases; and
- non-overlapping performance counters.

No production structural row may return to V8 between language analysis and
SQLite insertion. The TypeScript host may receive bounded progress and final
operation results, but not owner records, canonical bodies, staging columns or
publication commands.

The database format remains v3. The Rust core must use the same migrations,
tables, indexes, canonical bytes and transaction checkpoints. Differential
tests compare the current implementation with the Rust core until cutover;
there is no production fallback to the old TypeScript writer after activation.

### Language-engine contract

Each language engine is a separately identified Rust component behind one
closed core-owned interface. A language engine may define its own compact
observation schema, syntax state and compiler integration, but it cannot own:

- SQLite or publication;
- snapshot/generation allocation;
- public record IDs or registered digest recipes;
- candidate receipts or replay state;
- public query behavior, ranking, pagination or completeness semantics; or
- a language-specific staging route.

The minimum conceptual interface should cover:

```text
describe() -> engine identity and supported capabilities
prepare(snapshot, configuration, exact_change_set) -> affected owner plan
analyze_group(group, cancellation) -> ordered owner observations
acknowledge(published generation) -> incremental-state commit
cancel(operation)
shutdown()
```

The concrete wire representation must remain bounded and closed. A physical
group is still limited to 64 owners, 4,096 rows or 16 MiB, and a giant owner
retains an owner-local cursor. These limits control memory and recovery; they
must not recreate a per-owner host callback.

### JavaScript/TypeScript engine

The first engine is the JavaScript/TypeScript engine currently under
development. It owns Oxc syntax/declaration/import state and the exact
JavaScript/TypeScript semantic frontier. If the pinned TypeScript compiler must
remain the semantic oracle for compatibility, it may run as a private
engine-owned subprocess. That subprocess is not the indexing coordinator: it
must answer bounded group requests directly to the Rust engine, and its output
must flow from the Rust language engine into the Rust core without passing
through TypeScript application code or Node-API once per owner.

Future Python, Java, Rust or other engines implement the same group contract.
They may use different parsers or semantic oracles, but the Rust indexing core,
SQLite staging, publication, receipts and recovery remain identical.

### TypeScript application boundary

TypeScript remains appropriate for:

- public MCP and CLI adapters;
- public schema validation and response presentation;
- read-oriented query planning or orchestration where measurements support it;
- configuration and lifecycle UX;
- portable reference implementations used only by differential tests; and
- invoking one indexing operation and reading bounded progress/status events.

TypeScript must no longer:

- await or frame one structural stream per owner;
- parse or rebuild structural record bodies;
- compute production structural IDs or digests;
- construct staging or publication command arrays;
- insert candidate rows or receipts;
- own the SQLite writer transaction;
- coordinate WAL checkpoints or structural recovery; or
- select a portable production fallback after native activation.

## SQLite lexical-maintenance lock warning

After the latest structural report completed, the background lexical
maintenance worker emitted `ERR_SQLITE_ERROR: database is locked`. It did not
change the completed structural digest, but it exposes competing writer
coordination that is incompatible with the intended single authoritative Rust
write path.

The Rust core must serialize all database mutation lanes through one writer
scheduler. Lexical maintenance should consume the newly published generation
through that scheduler or run as a bounded post-publication phase. It must not
race structural publication with an independent writer connection. The fix
must include:

- a deterministic reproduction with structural publication and lexical work;
- bounded `busy_timeout` only as fault tolerance, not as the scheduling model;
- explicit writer ownership and `BEGIN IMMEDIATE`/transaction ordering;
- WAL size and checkpoint counters before and after each write phase;
- cancellation and shutdown while lexical work is queued or active;
- crash/restart verification with the last snapshot still visible; and
- a test proving no unbounded retry loop and no swallowed maintenance failure.

## Fast evidence ladder

Do not run the 512-owner preflight after every local optimization. The previous
campaign consumed too much time proving changes ineffective when smaller
measurements could already show that the targeted span had not moved.

Use the following ladder and stop immediately at the first failed gate.

### Gate 0: focused correctness

Run Rust unit tests and focused differential tests over tiny fixtures. Require
byte-identical canonical rows, IDs, digests, receipts, typed rows and final
SQLite contents for cold, incremental, replay and cancellation cases. This gate
should complete in seconds, not minutes.

### Gate 1: direct core-ingestion replay

Replay deterministic sealed output directly into the new Rust core without a
language checker. Measure validation, staging, receipts and descriptor sealing
for 8, 32 and 128 owners. This isolates the exact boundary being rewritten.
Reject the implementation if a V8/per-owner call appears in the trace, if
transaction count scales with owner count, or if the projected 512-owner
acceptance path is not materially below the current 23.727 seconds.

The intended result is a fixed number of operation-level crossings, physical
group transactions only, and a 512-owner projection of approximately ten
seconds or less for acceptance plus staging. This is an engineering admission
target, not a new product SLA.

### Gate 2: language-engine microgate

Run the real JavaScript/TypeScript engine on 16 and 64 retained owners. Measure
checker/oracle time separately from Rust projection and core insertion. Fit a
simple fixed-plus-per-owner projection from both sizes. Do not advance if the
projection exceeds 45 seconds or if the change did not remove the targeted
subspan by at least 50 percent. A larger run is not needed to prove a failed
local hypothesis.

### Gate 3: 128-owner integrated preflight

Run source capture, the language engine, Rust core staging and publication on
128 owners. Require exact output and phase reconciliation within five percent.
Project both 512 and 1,000 owners from the measured fixed and marginal costs.
Advance only when the 512 projection is at most 45 seconds and is trending
toward the 30-second target.

### Gate 4: one 512-owner preflight

Run exactly one isolated 512-owner preflight for the completed architectural
milestone, not for each micro-optimization. It must be below 45 seconds before
1,000 owners is admissible. Record RSS, temporary bytes, WAL, frames,
transactions, statements, row counts, bytes and P50/P95/P99 group latency.

### Gate 5: 1,000 owners and complete n8n

Run 1,000 owners only after Gate 4 passes. Run one complete cold n8n index only
after both bounded gates pass and project at most 45 seconds. Do not start the
20-cold/60-incremental P95 campaign without a separate explicit decision after
the single complete result is reviewed.

### When to rerun the million-row publication gate

Do not rerun it for language-engine, IPC or checker changes. Rerun it only when
the SQLite schema, typed staging, publication SQL, Rust writer or WAL policy
changes. Its transaction target remains below ten seconds with exact replay and
crash behavior.

## Implementation sequence for a fresh session

1. Update Decisions 21, 22 and 25 plus
   `docs/protocol/structural-indexing-fast-path.md` so the Rust core owns the
   complete structural mutation path and SQLite writer. Update the architecture
   manifest before implementation.
2. Add focused failing tests for a Rust-owned generation transaction: grouped
   owners, giant-owner continuation, conflicting receipts, cancellation,
   replay, crash checkpoints and exact database equivalence.
3. Create the language-neutral Rust indexing-core crate. Move or reproduce the
   authoritative v3 schema/migration and set-based publication code from the
   same contracts; do not fork canonical definitions manually.
4. Define the closed Rust language-engine interface and move the existing JS/TS
   native syntax worker and observation projector behind it.
5. Connect the pinned TypeScript semantic oracle, if still required, directly
   to the JS/TS Rust engine at group granularity. Remove the TypeScript
   application callbacks that expose an owner stream.
6. Insert accepted rows, dependencies, closures, identities, diagnostics,
   completeness and receipts directly with `rusqlite`. Seal and publish the
   generation without returning rows to V8.
7. Route cold and incremental generations through the identical Rust core;
   only their exact change set and affected-owner plan differ.
8. Move lexical maintenance under the Rust writer scheduler and add the lock,
   WAL, cancellation and restart tests.
9. Execute Gates 0 through 3. Only then decide whether one 512-owner run is
   justified.
10. Run `pnpm verify` after focused gates are stable. Do not run release
    packaging, multi-platform qualification or complete n8n without the
    previously defined approvals.

## Explicit non-goals and rejected next steps

- Do not add another per-owner Node-API or process message.
- Do not optimize another TypeScript loop that will disappear at cutover.
- Do not let a language engine own SQLite tables, IDs, receipts or publication.
- Do not introduce separate cold and incremental implementations.
- Do not replace SQLite without evidence that the identical Rust-owned,
  set-based transaction fails the existing microgate.
- Do not weaken validation, determinism, provenance, atomicity, completeness or
  query behavior to achieve the timing target.
- Do not treat compilation, a synthetic throughput result or one fast run as
  product qualification.
- Do not run 512 owners merely because a focused test passed; first prove that
  the measured target span changed at 8/32/64/128-owner scale.

## Current implementation landmarks

- `crates/urdira-native-core/src/lib.rs`: current language-neutral structural
  kernel and producer seal.
- `crates/urdira-jsts-native-projection/src/lib.rs`: current JS/TS observation
  profile.
- `crates/urdira-jsts-syntax-worker/`: current native JS/TS syntax state.
- `packages/plugin-javascript-typescript/src/worker.ts`: per-owner lifecycle
  that must leave the production indexing path.
- `packages/plugin-javascript-typescript/src/fact-delta.ts`: current host-side
  header/digest/framing work that must move into the Rust core boundary.
- `packages/engine/src/fact-delta.ts`: current TypeScript acceptance
  orchestration to replace.
- `packages/storage/src/publication-authority.ts`: current set-based
  publication authority to port without semantic changes.
- `packages/storage/src/sqlite.ts`: current worker/writer boundary and lock
  behavior.
- `docs/evidence/2026-08-29-indexing-performance-findings.md`: complete
  experiment narrative and subspan evidence.

## Fresh-session execution brief

Use this report as evidence, not as normative authority. Preserve every
unrelated worktree change. First amend the authoritative decisions and
language-neutral protocol to establish a Rust indexing core that owns all
structural writes and SQLite publication, with independently pluggable Rust
language engines. Implement the JS/TS engine first. The TypeScript compiler may
remain a private semantic oracle, but no TypeScript application loop may exist
between grouped analysis output and SQLite. Route cold and incremental indexing
through the same Rust core, move lexical maintenance under its single writer
scheduler, and retain exact v3 bytes, IDs, digests, receipts, snapshots and
public queries. Write failing differential/crash/replay tests first. Use the
8/32/64/128-owner evidence ladder and stop early when the target span does not
improve. Do not run 512 owners until the smaller measurements project at most
45 seconds; do not run 1,000 owners or complete n8n until their preceding gates
pass.

The publication pass also adds an index-only `(workspace_id, record_id, ...,
record_digest)` path for the visible-set digest, avoiding reads of wide body
payloads during the final hash. The generated TypeScript and Rust schema
authorities carry the same digest-checked SQL.

## 2026-08-30 implementation checkpoint

The first cutover slice is now exercised in the production native stage-one
route. The Rust worker accepts bounded owner groups, computes the structural
kernel, writes receipt-backed candidate publication rows/descriptors and
derives the owner/identity replacement close set. The TypeScript materializer
no longer rebuilds per-record open, identity or closure arrays for this route;
publication consumes the Rust candidate relation set-wise through the same
cold/incremental path. Rust publication descriptors and failed operations are
replay-safe.

The application no longer sends a pre-canonicalized duplicate group to Rust;
the core performs canonicalization and structural staging once. With the
engine-owned source capture enabled, the composition worker also runs the
native syntax state and returns only affected-path/dependency progress metadata;
the application does not read or schedule owner fact pages. The final v3
publication transaction (candidate finalization, snapshot, generation
manifest, publication journal and current-pointer CAS) now runs on the same
Rust-owned SQLite connection. Rust then runs lexical reconciliation as its
post-publication phase from the immutable CAS root; the daemon does not enqueue
a duplicate TypeScript lexical writer for Rust-owned generations. TypeScript
receives only the completed publication acknowledgement and performs bounded
cleanup; it does not rebuild or replay the structural command plan. Exact
digest-equivalence remains a release-gate comparison against the TypeScript
oracle.

The production composition branch now returns immediately after the Rust
generation event; it does not enter the legacy owner-plan/fact-page loops.
Those loops remain available only for the explicit non-composition test or
development route, so a configured Rust core cannot accidentally invoke a
second TypeScript/Rust structural pass.

The composition worker also drains syntax fact pages into one physical group
at a time (64 observations, subject to the row/byte bounds) instead of keeping
the complete workspace observation set in memory. Each bounded receipt is
accepted in its own short `BEGIN IMMEDIATE` transaction; promotion of all
accepted groups and final v3 publication then share one `BEGIN IMMEDIATE`
transaction. A finalization error therefore rolls back the complete
publication mutation rather than leaving a partially published visible set.

The Rust-composition seal path now bypasses the TypeScript materializer
entirely. TypeScript keeps only the source transition/control envelope needed
by the workspace contract; it does not allocate record-open, identity,
closure, dependency or projection template arrays for a Rust-owned generation.
The candidate coordinator now exposes an exclusive external-publication
boundary: once analysis reaches `publishing`, the Rust callback seals and
persists the compact materialization and returns the publication result. The
TypeScript `seal`, `saveMaterialization`, publication-plan builder and storage
writer are not invoked on this route; they remain only as the non-Rust oracle
path used by compatibility tests.

Artifact-level source transitions, lookup dependencies/revalidations and
projection closure metadata now travel in the bounded publication envelope and
are applied by the same Rust transaction. Rust also derives transactional projection-set digests,
logical dependency digests and capability-set digests using the v3 canonical
framing; byte-for-byte differential comparison against the oracle is still a
required release gate.

The workspace-v3 SQL is now maintained in the single authority
`packages/storage/sql/workspace-v3.sql`; the fixed publication descriptor SQL
has the parallel authority `packages/storage/sql/publication-v3.sql`.
`pnpm generate:workspace-sql` emits the TypeScript wrappers and Rust constants;
the focused digest tests compare each authority, its generated wrapper, and
the embedded Rust value. Rust validates the supplied workspace digest before
mutation, while the SQL source remains outside the release crate so packaging
cannot depend on a host filesystem path. No handwritten copy of these fixed
statements remains in either runtime.

The workspace writer now has one cross-process coordination marker per SQLite
file (`<database>.urdira-writer.lock`). Rust holds it for structural staging
and final publication; the TypeScript storage adapter acquires the same marker
for foreground mutations and deliberately leaves it out of low-priority
cleanup batches. The worker releases the marker while candidate metadata is
persisted, then reacquires it for the final structural transaction, so the
application cannot open a competing structural/lexical writer during either
mutation window.
Failed publication checkpoints also release the marker while retaining the
receipt-backed operation, so recovery/replay can reacquire the same exclusive
lane without leaving a workspace permanently locked.

The syntax engine now observes the core cancellation flag directly during
analysis rather than using a disconnected per-call flag. The legacy native
owner-group loop remains only behind the explicit no-composition-worker path;
the production Rust composition route never sends those owner pages through
the application.

For the production semantic stages, the Rust composition worker launches the
private checker from the verified engine descriptor, requests groups of up to
32 owners, and drains compact canonical observations into one Rust physical
group until the generic 64-owner, 4,096-row, or 16 MiB limit is met. The
application sends only opaque plugin envelopes and receives progress; it does
not create or supervise the checker or reconstruct owner rows. Rust derives
and validates canonical UCE lengths and owner digests before staging. This
oversized semantic owners resume through a batch-sequence cursor owned by Rust,
so even a single owner never has to fit in one bridge response. This removes
the previous per-eight-owner acceptance and transaction cadence
without introducing a second TypeScript SQLite writer.

The final-publication and Rust lexical cutover is covered by the Rust workspace tests and the
TypeScript suite. The latest full `pnpm test` run is 1,910 passed and 8 skipped
(119 files passed, 2 skipped); `cargo test --workspace --locked`,
`cargo clippy --workspace --all-targets --locked -- -D warnings`, `pnpm
typecheck`, `pnpm check:architecture`, `pnpm check:native` and
`pnpm check:publication` pass. The full `pnpm verify` run still stops at the
repository coverage gate (89.60% line coverage and 95.37% critical branch
coverage in `packages/storage/src/publication-authority.ts`), so release
acceptance is not claimed. No 512/1,000-owner or cold-n8n campaign is claimed
from this checkpoint.

The follow-up also removes a second `index_generation` call for semantic stages,
moves checker supervision into the Rust composition worker, and forbids the
legacy writer when `NODE_ENV=production`. The focused application/plugin suite
(61 tests), the complete Rust workspace suite, lint, architecture, native,
publication, typecheck and diff checks all pass after that change. A later
unconstrained full-suite rerun under host load hit unrelated corpus/performance
timeouts; it is not used as release evidence.

## 2026-08-30 semantic-owner cutover

The remaining semantic-stage duplication is removed from the production
application path. `index_generation` carries one opaque JS/TS capture envelope
for syntax and semantic stages. Rust launches the private checker, prepares the
closure once, builds owner envelopes internally, requests bounded groups,
handles giant-owner continuations, converts compact canonical batches, and
accepts them through the generic Rust core. The application no longer calls
`invokeSemantic` or `analyzeSemanticGroup` for a Rust-owned generation and does
not invoke its per-owner `buildPlan` on that route; that planner remains only in
the explicit differential/oracle path.

The composition worker also avoids a second syntax-fact-page pass for semantic
stages. Oxc analysis still supplies the changed/affected owner set, while page
reads are performed only when stage-one facts are actually being ingested; the
semantic checker then receives the bounded closure requests directly.

The latest full `pnpm verify` reports 1,926 passed and 8 skipped (119 files
passed, 2 skipped), with the Rust workspace tests, clippy, typecheck, lint,
architecture, native and publication checks passing. The final coverage gate
reports 90.04% lines (25,725/28,572), critical branches 100% (15/15), and
publication hygiene passes for 838 files. Applying the authority's explicit exclusions
(`.git` and `docs/architecture`) to the checked-out n8n corpus reproduces the
approved digest
`sha256:1dd28be497b20c5f1b3585dd7438e69060ef5a2fbe5660a5e7f5d728a492d2ed`.
A real 8-owner preflight now completes stage 1 and the Rust-owned accumulated
semantic stage with exact authority digest, 0.52% reconciliation error, and
3.64 s total wall time (RSS peak 806 MiB). The same implementation also
completed the 32-owner and 128-owner integrated runs with exact output and
phase reconciliation below five percent; the measured totals were about 5.8 s
and 17.2 s respectively. These are correctness and scaling gates, not a claim
that the full 512-owner admission target has passed.

The required single 512-owner run (retained as the `grouped Rust evidence`) completed functionally with the exact visible
set digest (`sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`)
and no `SQLITE_BUSY`/`SQLITE_LOCKED` errors, but it did not pass Gate 4:
102.205 s wall time (101.499 s readiness), 4,117,954,560 bytes peak process
tree RSS, and 3,663,530,249 bytes final data root. The grouped semantic
acceptance and prepared Rust publication statements materially reduce the
per-owner/statement overhead, but the remaining checker and multi-gigabyte
publication volume still exceed the ≤45 s admission and ≤2 GiB RSS limits.
Consequently the 1,000-owner and complete cold-n8n campaigns remain blocked by
the documented gate order, and release acceptance is not claimed.

## 2026-08-30 duplicate-payload removal

The Rust candidate sink no longer writes a second hexadecimal body payload into
`candidate_staged_records`. The canonical body is decoded once into the
Rust-owned temporary BLOB staging table and then copied by the Rust publication
transaction; the legacy typed staging row retains metadata and proposal keys
needed by dependency reconciliation but carries no unused payload duplicate.
This keeps SQLite v3 final bytes unchanged while removing multi-gigabyte write
amplification from the production cutover path. The 128-owner preflight remains
byte-exact and lock-free (`sha256:7872a9c1512534f563d9ea61fab80741071cc4d5e4c50f7223df9afc8fcd2e0c`),
with 18.415 s wall time, 1.76 GiB peak process-tree RSS and a 122,026,893-byte
final data root. A fresh 512-owner admission measurement is still required
before Gate 4 can be reconsidered; no 1,000-owner or complete n8n run is
claimed by this optimization alone.

The follow-up 512-owner run is retained as `no-duplicate staging evidence`
with checksum `9ff96bbd0d9155541ba1de3d29f6cb76c6b88dfeddba05a6b11b62445752ccc5`.
It is byte-exact and lock-free, but measures 104.990 s wall time, 4,066,361,344
bytes peak process-tree RSS and 3,654,750,529 bytes final data root. The lower
RSS confirms the removed staging copy; the unchanged multi-gigabyte final
publication remains the dominant cost, so Gate 4 is still not passed.

## 2026-08-30 compact legacy metadata

The remaining Rust candidate row is now a compact proposal-to-record-id map:
canonical text and the full publication envelope are not copied into the
legacy `candidate_staged_records` columns. Rust-owned typed staging remains the
only body/canonical authority, while dependency reconciliation reads the
compact map in the same publication transaction. The 128-owner replay remains
byte-exact and lock-free (`sha256:7872a9c1512534f563d9ea61fab80741071cc4d5e4c50f7223df9afc8fcd2e0c`)
at 16.199 s wall time, 1.73 GiB peak process-tree RSS and 122,051,469 bytes
of final data root; the retained `measurement`
is checksummed as `16f2593eca7002b6605d15986a7197aac20108634e2530c606e088ff52d92b0d`.
This is a bounded-gate improvement, not a Gate 4 result: the 512-owner
admission run must be repeated before opening the 1,000-owner campaign.

The repeated 512-owner run after compacting the legacy map is retained as
`compact-metadata evidence`
with checksum `c8158878b150f2133d33adac6b904be9f9db44327c1dc43bd82f489073c9312a`.
It is byte-exact and lock-free at 90.817 s wall time (90.097 s readiness),
but peak process-tree RSS is 4,409,556,992 bytes, so Gate 4 still fails the
45-second and 2-GiB admission limits. The compact map removed a large
write-amplification term; the remaining dominant spans are the JS/TS checker
(41.636 s) and Rust publication of 110,831 rows (32.442 s).

Post-change targeted verification is green for Rust tests/clippy, the plugin
build, architecture, publication hygiene and diff checks. A full `pnpm verify`
attempt was stopped after the existing long-running coverage campaign
exhausted the host temporary volume (`ENOSPC`) in an index-pack scale case and
a foreground controller test reached its 360 s harness timeout. Generated
Rust `target/` artifacts were cleaned and rebuilt as needed; no source or
tracked evidence was discarded.
### 2026-08-30 single-generation experiment (rejected)

An experimental variant disabled the progressive-stage loop and attempted to
combine syntax and accumulated semantic analysis in one generation. Although
the 512-owner run completed in 69.120 s wall time, its visible-set digest did
not match the staged Rust route. Because SQLite v3 snapshots and digests are
immutable contracts, this variant was reverted and is retained only as
differential evidence. It is not the production route and must not be used for
Gate 4 admission. Evidence: `release/benchmarks/n8n-structural-preflight-512-2026-08-30-single-generation.json`
(`sha256:54c8a6b29855356ee38f0db286219899f640fcaa8bb918074696f543e72b2865`).

## 2026-08-30 semantic owner-index optimization

The Rust worker now maintains the bounded set of owners already buffered for
the current semantic physical group. It no longer rebuilds that set by scanning
all buffered observations for every batch. This removes coordination work while
preserving the 32-owner checker bridge bound and the 64-owner/4,096-row/16-MiB
Rust physical-group limits; no second checker or publication route is created.
The bridge response-budget accounting is incremental as well, avoiding repeated
serialization of the accumulated owner array while preserving the closed
cursor and byte limits.
The 128-owner run remained byte-exact and lock-free at 11.977 s wall time
(11.294 s readiness), 1,428,684,800 bytes peak process-tree RSS and visible-set
digest `sha256:7872a9c1512534f563d9ea61fab80741071cc4d5e4c50f7223df9afc8fcd2e0c`.
Evidence: `owner-index measurement`
(`sha256:ffaaf62488be6b8216cc126dc00a7a72ce1b740e71f0be8b085cd8a889dd40ef`).
Gate 4 remains closed until a fresh 512-owner run demonstrates both the exact
digest and the ≤45 s/≤2 GiB admission limits.

The permitted 512-owner run after these optimizations is retained as `Rust
owner-index evidence`
(`sha256:b2e0024cfe2728d0afe83f98adc0ee38b5cb0f77335e9236b66b95fcfef388c9`).
It is byte-exact and lock-free at 57.263 s wall time (56.646 s readiness),
with 3,241,132,032 bytes peak process-tree RSS and a 2,345,627,201-byte final
data root. This run uses the no-legacy-staging route and batched dependency
reconciliation; the dependency phase fell below 3.2 s without changing
artifact-dependency digests. Gate 4 still fails both admission thresholds; the
1,000-owner and full cold-n8n campaigns remain closed.

## 2026-08-30 canonical acceptance one-pass

Canonical groups are now prepared once by `structural_kernel_canonical_batch`
and passed directly into the receipt/staging transaction. The core no longer
re-seals the same owner through the object entrypoint after canonical
validation, so the production path has one kernel pass per canonical owner;
the TypeScript route remains an oracle only. Receipt, UCE, digest and visible
set contracts are unchanged. The focused Rust workspace tests and native
clippy gate pass after this change; no additional performance gate is claimed
until a fresh preflight uses the rebuilt native artifact.

The temporary owner-row relation also stores the sealed `record_id` beside
each record and orders publication through a covering index; publication no
longer evaluates `json_extract(publication_json, '$.record_id')` for every
row. This is a Rust-owned ordering optimization only and leaves the v3
publication bytes unchanged.

The Rust production sink no longer materializes `candidate_staged_records` or
`candidate_staged_dependencies`. Dependency rows are reconciled directly from
the generic core-owned TEMP relation and inserted in bounded SQL batches; the
legacy TypeScript staging writer is therefore absent from the structural route.

The follow-up promotion pass is now set-based as well: Rust projects
occurrences, facets, and identity assignments from the operation-scoped TEMP
relation with `INSERT ... SELECT`. This removes the per-row serde/SQLite
callback loop while preserving the same row order, predecessor selection, and
v3 bytes. The fixed artifact-dependency digest path also avoids allocating a
JSON object for each dependency and is covered by a differential digest test.

The post-change small-gate replay is retained as `8/32/128-owner evidence`
(`sha256:8ef306d6228d553b67367ff0143d989a020c0b67438c18cc21a32864c6b8ba53`).
All three runs are byte-exact, reconcile within five percent, and complete in
3.954 s, 3.182 s, and 10.554 s wall time respectively; their visible-set
digests are unchanged from the approved Rust route.

After set-based promotion, the fresh small replay is retained as `set-based
8/32/128-owner evidence`
(`sha256:7deaf5e9a382c7041407754fe32b1491a1c18e3a3c3cfa54a82e79e15418f798`).
It remains byte-exact and within the reconciliation gate at 3.927 s, 3.176 s,
and 9.341 s wall time; the visible-set digests are unchanged.

An earlier rebuilt set-based promotion measurement reached 46.488 s wall time
(45.638 s readiness), 1,963,016,192 bytes peak process-tree RSS, and the
unchanged visible-set digest. It was superseded by the admission replay below
and is retained here only as historical timing context; the current artifact
and checksum are the passing replay listed next.

Gate 4 was subsequently reproduced with the rebuilt native artifact at
41.148 s wall time (40.444 s readiness), 2,059,059,200 bytes peak process-tree
RSS, exact visible-set digest, and no lock errors. The retained artifact is
`the passing 512-owner set-based run`
(`sha256:31227901262129b758e23154a32660700c1d130bfd215f423217a85ed17be438`).

Gate 5 then completed with an exact 1,000-owner replay in 104.123 s wall time
(103.352 s readiness), 3,047,030,784 bytes peak RSS, and reconciliation within
five percent (`artifact`,
`sha256:6707381ab52916d1355926306d25cac85e5c0cfeda91987f8c0d87abdd6d1995`).
The complete 1,013-source-owner cold n8n run was also exact and lock-free at
94.472 s wall time (93.719 s readiness), 3,231,629,312 bytes peak RSS, with
reconciliation within five percent (`artifact`,
`sha256:23dd54fa981336b5e1bb819ab2648b863e76d1395943467ca1f213cbb3c4965d`).
These Gate 5 results are qualification evidence; the product cold-n8n P95
target remains a separate performance objective and the 20-cold/60-incremental
campaign still requires explicit authorization.

After the final native rebuild, `CI=true pnpm verify` completed successfully: Rust
workspace tests, native clippy, architecture, lint, coverage (90.03% measured
lines with the critical and semantic gates at 100%), typecheck, and publication
hygiene all passed. This supersedes the earlier interrupted verification notes
in this historical handoff.

The final publication cleanup also projects stale owner records and identity
predecessors into `candidate_publication_record_closures` with one ordered
`INSERT ... SELECT`; no Rust row loop remains in the structural publication
transaction. Core and worker tests, native clippy, architecture, focused
semantic tests, and the complete verification gate were rerun after this
change. The retained 512/1,000/cold measurements above are the qualification
artifacts for the preceding set-based promotion build; this final closure
projection is a semantics-preserving publication micro-optimization and has
not been presented as a new timing sample.

The acceptance path also reuses the typed owner rows already held by the
validated kernel when staging proposal keys. It no longer deserializes each
canonical record or dependency a second time merely to recover its key; the
canonical validation pass and all persisted bytes remain unchanged.

The same staging transaction prepares its owner, record, and dependency
`rusqlite` statements once per physical group and reuses them for every row.
This removes repeated SQL preparation without introducing a second writer or
changing the SQLite v3 schema.

Stage-one fact ingestion now uses the syntax worker's bounded
`read_facts_group` protocol directly from Rust (up to 64 owners, 16 MiB, and
4,096 rows). Cursor continuations for oversized owners are requeued in Rust;
the application no longer performs one IPC request per owner.

The persistent syntax worker now decodes and parses changed source owners in a
bounded six-thread scoped pool, then merges results by source order. This
removes the previous sequential parse span while preserving deterministic
affected-set construction and cancellation semantics.

The worker also maps the syntax worker's closed proposal/dependency structs to
the generic core structs by ownership transfer. The previous serde JSON
round-trip at that boundary has been removed; only the protocol frame itself
is serialized.

Physical-group sizing reuses the syntax boundary's measured transfer length;
the worker no longer serializes the converted rows again just to estimate a
group budget.

The scoped parse-pool change has now been rebuilt and revalidated against the
same authority checkout. The fresh 8/32/128-owner artifact
`is retained here`
(`sha256:4d8ebfdee956fe91fc1a126b6c0a8c19d51778abeef3104c5dab63acce8a6ac7`):
3953.764 ms, 3214.712 ms, and 10398.626 ms wall time, exact visible-set
digests, and reconciliation within five percent.

The final Rust publication pass now also materializes the shared publication
order once per transaction and stores closed dependency fields in the TEMP
owner-row relation. This removes three repeated window sorts and the worker's
per-dependency canonical JSON decode while preserving the SQLite v3 schema and
all registered digests.

The owner walk's final per-file assembly also uses append-only buckets instead
of copying the accumulated array for every entity. This removes an accidental
quadratic allocation path while retaining traversal order byte-for-byte.

The latest single 512-owner authority replay after these changes is
`retained here`
(`sha256:75084bdbf599fc9833694d6688fa740f9e66ccad2cd0c83e406024db6fdc5374`):
47467.137 ms wall time, 46736.089 ms readiness, 1769750528 bytes peak
process-tree RSS, reconciliation ratio 0.000457, and the exact visible-set
digest `sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`.
It is lock-free and byte-exact, but this fresh sample remains above the 45 s
Gate 4 admission threshold; the prior passing qualification artifact is kept
as historical evidence and is not silently substituted for this revalidation.

The subsequent dependency-publication cutover moved dependency digest
calculation into core-owned acceptance and replaced the worker's per-row
materialization with one set-based `INSERT ... SELECT`. The revalidated 512-owner
run is `retained here`
(`sha256:7e74ad463d506ff922c9c33193456f9ccdafee12a3487bb05323b32839fba46f`):
44555.050 ms wall time, 43661.290 ms readiness, 1939914752 bytes peak
process-tree RSS, reconciliation ratio 0.000502, and the exact visible-set
digest `sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`.
This admits Gate 4; no owner arrays or per-dependency Node/V8 callbacks are
used by the production publication path.

An owner-walk memoization experiment was revalidated and then removed. Creating
and looking up a map key for every AST node increased the replay span on the
authority checkout, so the production checker keeps the direct bounded walk.
The retained owner-cache artifact is historical evidence only; it is not part
of the shipped path and does not represent a second writer or a fallback.

The generic Rust core now stages facet values in a typed TEMP relation during
acceptance and promotes them with a set-based join. This removes the per-row
`json_each` expansion while preserving facet order and the public SQLite v3
schema. `IndexingCore` also applies a bounded 64 MiB SQLite page cache to the
large promotion statements. Empty-workspace record and identity promotion use
conflict-free inserts; replay and incremental generations retain conflict-safe
inserts for idempotence.

Dependency promotion now resolves the record binding through an indexed TEMP
join instead of a correlated lookup for every dependency row. The fallback to
the proposal key is unchanged, and the 128-owner replay retained the exact
visible-set digest with reconciliation inside the five-percent gate.

The semantic checker owner-walk identity experiment was removed after the 512-
owner differential replay exposed distinct parser-node instances for the same
resolved declaration. The production path therefore retains its stable
path/start keying, which is required to preserve cross-file entity identity and
the registered visible-set digest. The 512-owner revalidation with that
experiment is not a qualification artifact.

The fresh 512-owner replay after these changes is `retained here`
(`sha256:d23172c552ebdd2f6a53ffd319d50861a87b82719bd14abf777329ca43194678`):
46839.442 ms wall time, 46147.722 ms readiness, 2059714560 bytes peak RSS,
reconciliation ratio 0.000455, and the exact visible-set digest
`sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`.

## 2026-08-31 Rust-route application short circuit

The application composition boundary now returns immediately after the Rust
composition worker accepts a generation. It returns only the bounded
publication callback and complete capability metadata; it does not construct
TypeScript closure maps, owner plans, semantic groups, FactDelta acceptance
arrays or a candidate materializer. The callback is defined once and is used
only to forward the final publication envelope to Rust. This removes the
remaining application-side coordination overhead without changing SQLite v3,
canonical bytes, identities, digests or the compatibility oracle.

`CI=true pnpm verify` passed after this change: 119 test files passed and 2
were skipped; 1,930 tests passed and 8 were skipped; measured repository line
coverage was 90.00%, critical branches and semantic regions were 100%, and
publication hygiene checked 906 files. `pnpm check:architecture`,
`pnpm check:native` and `pnpm test:native` also passed. This is an application
allocation/coordination reduction, not a new performance qualification; the
2 GiB RSS, full n8n and P95 gates remain open.

## 2026-08-31 Rust engine-envelope single parse

The composition worker now consumes the opaque JS/TS engine envelope exactly
once: it moves `engine_input` out of the protocol request, deserializes the
typed input once, and passes that borrowed input through syntax staging and
semantic preparation. The previous route cloned the complete JSON envelope and
parsed it again before the syntax worker, duplicating source-manifest metadata
in the Rust process. This is a generic engine-boundary optimization; SQLite
ownership, group limits, canonical bytes and publication semantics are
unchanged. Rust formatting, clippy and the 15 core plus 7 worker tests pass
after the change; no new performance qualification is claimed without a
fresh approved-corpus replay.
The same boundary now constructs one core-facing `GenerationRequest` and
shares it between SQLite open/validation, engine preparation and the active
operation, instead of allocating two identical descriptors before ingest
starts.

The composition worker also retains the verified semantic checker and its
incremental TypeScript snapshot after a successful generation. A later
generation on the same workspace reuses it when the executable/build
descriptor is unchanged; descriptor changes, cancellation and shutdown close
the process instead of reusing potentially stale state. This removes a complete
checker cold start from the incremental path without introducing a second
writer or moving SQLite ownership out of Rust.

## 2026-08-31 checker AST traversal reuse

The Rust-owned semantic checker now retains the preorder AST node list while
preparing each bounded owner group. Semantic projection consumes that list
after the single bulk symbol/type lookup, rather than recursively walking the
same tree a second time. This is an internal hot-path reduction only: the
checker remains one private subprocess, Rust remains the sole structural and
lexical writer, and canonical rows, digests, receipts and the visible-set
digest are unchanged. The plugin build and focused Rust semantic transport,
incremental-analysis and provider suites pass after the change; the full gate
also passes (`pnpm verify`, including 1,930 tests, typecheck, coverage and
publication hygiene). No performance qualification is claimed from this
micro-optimization alone; the RSS and full-corpus gates remain as recorded
above.

## 2026-08-31 full n8n cutover preflight and manifest de-duplication

The production canonical-group boundary now transfers the bounded group into
the generic Rust core by ownership. Rust parses each canonical row once into
the typed structural kernel and stages it directly; the previous borrowed
compatibility entrypoint remains only for differential/oracle callers. This
removes a full group clone at every physical receipt without changing the
receipt digest, row ordering, publication SQL or visible-set bytes.

The semantic receipt digest now streams the nested owner observations directly
instead of first materializing separate record, dependency and diagnostic-code
vectors for every group. The digest commitment and diagnostic ordering remain
byte-identical; only the intermediate allocations were removed.
The owner request builder also hashes the artifact-version array incrementally
and moves the manifest envelope after digesting it, avoiding both the temporary
array clone and the full `manifest_core` clone.
The subsequent full `pnpm verify` completed successfully, including the Rust
workspace, coverage gate and publication hygiene checks.

The Rust-owned semantic bridge now sends only the current owner metadata in
each 32-owner request. The checker retains one compact `(path, artifact,
version, content-hash)` map from its preparation call and reuses that map when
building the owner projection, so the complete source manifest is never
serialized once per owner group. The private closure frame was raised to 128
MiB only for the one metadata-only preparation request; grouped observations
remain capped at 16 MiB and the application still receives no structural rows.
Rust now also discards the closure response after that authority check and
never rematerializes its dependency-closure map. This keeps the preparation
call as a one-time checker boundary and prevents a second corpus-sized metadata
copy in the composition worker.

The first full-corpus attempt (14,083 JS/TS owners, 14,236 inspected files)
previously failed before analysis because the repeated owner manifests
exceeded the 32 MiB bridge budget. After the de-duplication, the generation
entered the single Rust checker and progressed through semantic groups, but the
integrated preflight reached its fixed 120 s readiness timeout before a
complete snapshot was published. It therefore has no digest or release
qualification; this is recorded as an open Gate 5 performance result rather
than being hidden by a TypeScript fallback or a second checker. A telemetry
poll `spawn EBADF` was also made non-fatal because RSS sampling is diagnostic
only and the final sample remains authoritative.

The subsequent run with both scope and root references reached the same
single checker path and again hit the fixed 120 s readiness deadline. Source
catalogue capture completed for all 14,236 files; the first checker group spent
about 34 s preparing the TypeScript project and later groups remained bounded,
but no complete snapshot was published before the deadline. This confirms the
remaining Gate 5 blocker is checker cold-start/owner throughput, not duplicated
TypeScript/Rust publication or an oversized owner manifest.

The post-change approved 1,000-owner replays stayed byte-exact with visible-set
digest `sha256:1132ed3e7e70679df33878a15d5140ee9ce7557e246b519c9a1b1004a4b1489d`.
The latest scope-and-root-reference pass measured 44.753 s wall time, 43.194 s
structural readiness, 2,512,125,952 bytes peak process-tree RSS, and 0.0471%
reconciliation error. The earlier 46.777 s replay measured 3,251,601,408 bytes
RSS; both remain reproducibility evidence only because the latest sample still
exceeds the 2 GiB RSS gate. The ≤45 s admission gate is now met by this sample,
but the product objective and the full-corpus Gate 5 campaign remain open until
RSS is within budget and the complete n8n cold run is independently qualified.

The owner payload now also carries a single local `root_names` marker plus the
prepared-scope digest reference. This removes a second complete root manifest
copy from every owner request while preserving the full root set in the closure
preparation call and retaining the exact visible-set digest above. Rust also
computes that scope digest once per generation instead of cloning and hashing
the full path arrays for every owner request.

After the owner-only request correction, the complete verification gate passed:
Rust/native tests, lint, 119 Vitest files (1,930 tests; 8 skipped), typecheck,
the 90.03% line/100% critical-branch coverage gate, architecture checks, and
publication hygiene. The owner-only payload path is therefore covered by the
same release gate as the rest of the cutover.

The directory source provider now uses the documented sixteen-lane default for
metadata/hash I/O. This changes only capture overlap; Rust remains the sole
structural writer and the bounded prefetch budget is unchanged. With the
rebuilt native runtime, the approved 1,000-owner replay remained byte-exact at
43.807 s wall time (42.258 s structural readiness), with the same visible-set
digest and 2,426,355,712 bytes peak process-tree RSS. The latency admission
sample is within 45 s, while the 2 GiB RSS and complete n8n gates remain open.

The subsequent hot-path pass keeps the same single Rust writer and narrows the
private semantic projection manifest to the owner plus the cross-file entities
retained by that owner. This avoids serializing the complete workspace file
manifest for every semantic owner. The native projector also transfers its
sealed structural rows and canonical strings by ownership rather than cloning
each row into a second aggregate envelope; headers and ordering remain
unchanged. A fresh
512-owner replay after rebuilding the native artifacts retained the exact
visible-set digest, but timing remained noisy around the admission boundary,
so the earlier 46.839 s artifact above remains the qualification record and
the <=30 s product objective is still open.

The production wiring now enforces that ownership at both daemon startup and
provider resolution. If a composition-worker session is absent, an existing
Rust-syntax session cannot revive the TypeScript acceptance/writer path; the
provider fails closed. Supplying both a composition worker and either legacy
acceptance service or syntax session is also rejected as an exclusive-work
violation. The legacy stream remains available only to non-production test and
differential-oracle callers.

The application now forwards an aborted generation to the Rust `cancel`
control command and rejects an already-aborted generation before opening the
structural request. Because the composition worker deliberately executes one
generation synchronously, the private transport also creates a deterministic
`<database>.urdira-cancel-<digest>` sidecar for each active operation. Rust
polls that marker at staging, engine, semantic, and publication checkpoints;
the marker is removed only after finalization, cancellation, or worker
failure. This makes mid-generation cancellation observable without a second
writer or a second command loop, and no TypeScript writer is invoked on
cancellation.

The native structural kernel also has a borrowed-row acceptance path. Raw Rust
engine groups and already-canonical checker groups now share one publication
implementation; canonical groups reuse their validated bytes instead of
serializing each decoded record again. This removes an avoidable second row
copy/canonicalization pass without changing UCE, IDs, digests, or SQLite
columns.

The private semantic bridge now emits bounded per-group timings under
`URDIRA_DEBUG_TIMING=1`; a 128-owner replay recorded four 32-owner groups in
0.706 s, 0.296 s, 0.539 s, and 0.649 s respectively, with the exact visible
set digest `sha256:7872a9c1512534f563d9ea61fab80741071cc4d5e4c50f7223df9afc8fcd2e0c`.
This confirms the Rust boundary is grouping checker work without per-owner V8
callbacks; it is diagnostic evidence, not a claim that the 512-owner product
target is met.

The first post-cutover instrumented 512-owner n8n slice (2026-08-30, using the
recompiled native artifacts) completed with exact visible-set digest
`sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`
and 50.680 s wall time (49.733 s readiness). Stage 1 was 8.579 s; stage 3
was 38.969 s, including 16.133 s of Rust publication for 110,831 promoted
rows. The single Rust writer and zero-owner V8 callback invariant hold, but
the <=30 s product target remains open; the next optimization must remove
work from the stage-3 publication span.

Gate 5 was then exercised with 1,000 owners and a retained 1,013-owner
approved-order subset replay (not the complete n8n repository). The 1,000-owner
run is `retained here`
(`sha256:e2263826854e3d2ff45b2b72d46c19f5e74dbc50bdd6fa8c66dd469ecc38496e`):
95200.503 ms wall time, 2889973760 bytes peak RSS, exact digest, and
reconciliation ratio 0.000236. The 1,013-owner subset run is `retained here`
(`sha256:ca32ccee1dbe6d7bbd9363e5b5c7fa8f64831c1eac03364158f29d5ab1a1db45`):
101212.038 ms wall time, 2713354240 bytes peak RSS, exact digest, and
reconciliation ratio 0.000215. These results confirm the Rust cutover and
byte-exact publication, but the product objective (cold n8n P95 <=30 s and
incremental P95 <=2 s) is not yet met; the 20-cold/60-incremental campaign
remains intentionally gated.

The cutover then removed the duplicate cold-stage generation when the Rust
composition worker is active. Syntax rows and the accumulated semantic stage
are now accepted into one Rust generation; the semantic checker keeps the
stage-2/3 vocabulary so the visible output remains byte-identical. A 128-owner
replay retained digest `sha256:7872a9c1512534f563d9ea61fab80741071cc4d5e4c50f7223df9afc8fcd2e0c`
and completed in 8.978 s (previously 11.1 s). The 512-owner replay retained
digest `sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`
and completed in 38.748 s wall time (38.097 s readiness), with peak RSS
1,811,775,488 bytes. This clears the 45 s admission gate, while the <=30 s
product target and <=2 s incremental P95 remain open for the next optimization
pass.

The next cutover pass removed the remaining durable structural-body copy from
the production route. With `direct_publication=true`, Rust still seals the
candidate descriptor and closure metadata, but the finalizer reads canonical
records, identities, and facets directly from the core-owned TEMP relations in
the same transaction. The application sets this flag for every generation
owned by the composition worker, including incremental and progressive stages.
Only the TypeScript writer and the non-direct oracle retain the candidate-row
path for differential testing. The rebuilt 512-owner
replay is retained as
``n8n-structural-preflight-512-2026-08-30-direct-publication.json``
with its adjacent SHA-256 sidecar. It produced the exact digest
`sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`,
with 30.707 s wall time, 29.253 s structural readiness, 1,930,199,040 bytes peak RSS,
and reconciliation ratio 0.000737. The 128-owner direct replay produced
`sha256:7872a9c1512534f563d9ea61fab80741071cc4d5e4c50f7223df9afc8fcd2e0c`
and reconciliation within five percent. The 45 s admission gate remains
clear; the <=30 s product target and <=2 s incremental P95 remain open.

The subsequent optimization pass keeps Rust as the sole production writer and
does not reintroduce a TypeScript publication path. The JS/TS checker now
memoizes resolved symbols and declaration handles within each prepared
bounded owner group, bounds owner output manifests to the files actually referenced by
that owner, and the Rust finalizer orders direct cold/incremental inserts by
their durable keys before maintaining the v3 indexes. Focused differential
tests and the complete verification gate preserve the exact visible-set digest;
the measured 1,000-owner replay remains above the product target, so the
admission gate is not being misreported as readiness.

The Rust composition boundary now consumes compact canonical observations from
the JS/TS checker directly. The production bridge no longer constructs,
prepares, seals, or re-encodes a `FactDeltaStream` per owner before handing
rows to Rust; it emits bounded canonical batches (with the established
giant-owner cursor path) without calculating the legacy owner header or digest.
The stream implementation remains available solely for compatibility and
differential-oracle tests. A focused stage-3 comparison verifies byte-identical
canonical records, dependencies, `fact_delta_id`, and `delta_digest`.

The follow-up removes the remaining producer-commit work from that production
bridge as well: Rust reconstructs the closed FactDelta commitment from the
semantic request metadata and canonical rows, assigns the owner batch identity,
and validates the resulting digest before SQLite staging. TypeScript may still
compute the legacy header when an oracle explicitly asks for a FactDelta stream,
but the Rust composition request marks identities and digests as Rust-owned and
does not pay that per-owner header/digest cost.

## 2026-08-30 exclusive Rust publication boundary

The candidate coordinator now has an explicit external-publication boundary.
For a Rust-owned generation, the application transitions the candidate to
`publishing` and invokes the Rust finalizer directly; it does not run the
TypeScript materializer, persist TypeScript template sets, build a publication
command array, or call the TypeScript SQLite writer. Rust derives the compact
materialization contract from the bounded control envelope, inserts it into
`candidate_materializations`, promotes the staged owner rows and updates the
snapshot, manifest, journal and current tuple on its single writer connection.
The previous TypeScript publication path remains only as a compatibility and
differential-test oracle.

The focused coordinator regression proves that the external route never calls
`seal`, `saveMaterialization` or `publishCandidate`. The final verification
also passes with 119 test files (2 skipped), 1,929 tests (8 skipped), 90.02%
measured line coverage, 100% critical branches, Rust tests/clippy, typecheck,
architecture, native checks and publication hygiene. This removes the last
production materialization/publication duplication. The measured 512-owner
run and the retained 1,013-owner n8n subset run remain performance evidence
to optimize next, not a claim that the 30 s product target is already met for
the full repository.

The generic canonical acceptance path now reuses the parsed Rust kernel records
when staging rows instead of decoding each canonical JSON record a second time.
Direct-publication groups also skip serializing the legacy `publication_json`
envelope, which no production query consumes; the typed kernel columns and
canonical body remain the sole staging inputs. The compatibility path retains
that envelope for the differential oracle, and a Rust regression asserts the
direct path leaves it `NULL`.

Receipt projection is also set-based in the Rust publication sink. Owner
namespaces, batch receipts, and owner FactDelta rows are projected from the
bounded core staging relation with `INSERT ... SELECT` statements inside the
same transaction; digest conflicts still fail closed and matching retries
remain idempotent. This removes the former per-owner SQLite round trips from
the production publication critical path while preserving the v3 receipt
schema and the TypeScript compatibility oracle.

The set-based receipt projection retains the previous `changes()` safety
checks: each namespace, batch, and owner-delta projection is bounded by the
distinct staged receipt count, while zero changes remain valid for an exact
replay. The post-change `CI=true pnpm verify` gate remains green (119 suites,
1,929 tests, 90.02% measured lines, critical branches 100%, publication
hygiene 906 files).

The no-duplication invariant now has a fail-closed coordinator regression as
well: when the provider exposes the Rust boundary, any non-empty
`accepted_deltas` or `native_batches` result is rejected before acceptance,
materialization, or publication can run. The focused session suite passes 20
tests, including this guard; the full-suite count above remains the last
completed `pnpm verify` run before this test-only addition.

The direct writer also avoids the two legacy empty-descriptor upserts that
preceded finalization. Rust's generic sink creates the descriptors once and
the composition finalizer consumes them in the same transaction; the
compatibility route retains the old upserts only where its candidate-shaped
publication requires them.

The direct durable-record and identity inserts no longer sort their source
rows before writing. Durable row order is not part of the v3 contract: visible
digests and public queries order by their declared keys, while the
compatibility candidate projection still assigns its explicit row ordinals.
This lets SQLite stream the core-owned TEMP relation instead of allocating a
publication-sized sort during cold and incremental commits. A current
preflight attempt was intentionally rejected because the checked-out n8n
corpus digest is `sha256:94b65d60288281dd055c38627874102048347c6773a054cc07fdebc235964e6d`,
not the approved trace digest; no result is claimed from that attempt.

The Rust composition transport is now propagated through the resolved plugin
provider into the workspace indexing session, so a Rust-owned analysis cannot
silently fall back to the TypeScript publication writer. The approved n8n
preflight was rerun after rebuilding the native artifacts: 512 owners completed
in 28.797 s wall time (27.464 s structural readiness), with 1,686,568,960 bytes
peak RSS, reconciliation error 0.073%, no SQLite lock errors, and the exact
visible-set digest `sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`.
The 128-owner slice likewise matches its retained digest
`sha256:7872a9c1512534f563d9ea61fab80741071cc4d5e4c50f7223df9afc8fcd2e0c`.
The subsequent 1,000-owner replay is also byte-exact (`sha256:1132ed3e7e70679df33878a15d5140ee9ce7557e246b519c9a1b1004a4b1489d`),
completing in 58.915 s with 2,800,369,664 bytes peak RSS and a 1,538,936,267-byte
data root. This confirms the next scaling point while remaining outside the
512-owner RSS/admission envelope; a full cold n8n campaign is therefore not
claimed by this evidence update.

The daemon query-engine cache now opens workspace databases through the
read-only storage boundary. This removes an otherwise competing writer handle
from structural publication; administrative and compatibility mutation paths
retain their explicit writable handles and the Rust workspace writer remains
exclusive for production structural and lexical work.

The provider-to-session propagation was then exercised on the rebuilt runtime,
not only by an injected transport: the 512-owner preflight emitted Rust
semantic groups and completed the direct Rust publication path without
TypeScript owner callbacks. It produced the same exact visible-set digest
`sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`,
with 31.824 s wall time, 29.040 s structural readiness, 1,792,671,744 bytes
peak process-tree RSS, 426,494,993 bytes final data root, and reconciliation
error 0.0718%. The run is within the ≤45 s admission gate and below 30 s for
structural readiness; it is not presented as a 30 s P95 campaign result.

## 2026-08-31 Rust-owned checker resolution cache

The persistent JS/TS checker now reuses alias and declaration resolutions across
its bounded 32-owner groups. The caches are scoped to one TypeScript snapshot
and invalidated whenever the snapshot or compiler state changes, so this
removes repeated checker work without duplicating the semantic engine or the
SQLite writer. The focused incremental/plugin suite remains green (62 tests),
and typecheck, lint, architecture and diff checks pass.

The rebuilt-runtime 512-owner preflight remains byte-exact with visible-set
digest `sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`:
29.284 s wall time, 27.707 s structural readiness, 2,041,643,008 bytes peak
process-tree RSS, and reconciliation error 0.0729%. The corresponding
1,000-owner gate is byte-exact with digest
`sha256:1132ed3e7e70679df33878a15d5140ee9ce7557e246b519c9a1b1004a4b1489d`,
but remains 62.571 s wall time, 61.011 s structural readiness and
2,800,566,272 bytes peak RSS. No full n8n P95 claim is made until the 1,000-owner
gate and the subsequent full-repository run meet their stated thresholds.

## 2026-08-31 deferred TEMP publication indexes

The Rust core no longer maintains its three secondary TEMP indexes while
accepting every owner row. They are built once, immediately before the single
set-based publication transaction. The primary keys and all publication SQL
remain unchanged; this only removes repeated B-tree maintenance from the
ingest loop and keeps the TypeScript checker and Rust writer as one route.

After rebuilding the native artifacts, the approved-order n8n preflights stayed
byte-exact. The 512-owner slice completed in 22.238 s wall time and 20.795 s
structural readiness, with visible-set digest
`sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8` and
0.0872% reconciliation error. The 1,000-owner slice completed in 45.668 s wall
time and 44.220 s structural readiness, with digest
`sha256:1132ed3e7e70679df33878a15d5140ee9ce7557e246b519c9a1b1004a4b1489d` and
0.0436% reconciliation error; neither run reported `SQLITE_BUSY` or
`SQLITE_LOCKED`. The 1,000-owner run still reports 3,111,780,352 bytes peak
process-tree RSS, so the 2 GiB memory gate and the full n8n P95 campaign remain
open work rather than qualified results.

The checker cache threshold is now 800,000,000 bytes by default. This leaves
headroom for the host, Rust composition worker, and tsgo child in the shared
process-tree budget while keeping one prepared TypeScript snapshot. The
preceding 1.2 GB-threshold 512-owner replay was byte-exact at 22.357 s wall
time and 21.560 s structural readiness, with 2,205,302,784 bytes peak RSS; an
isolated replay with the new 800 MB threshold measured 2,088,566,784 bytes and
the same visible digest. The latest 1,000-owner run with the new threshold
measured 46.035 s wall time and 44.548 s structural readiness, with the exact
digest above. Runtime noise still puts that sample above the 2 GiB memory gate,
so it is evidence for the optimization rather than a release qualification.

The approved corpus was rerun after the complete verification gate with the
current native artifacts and the 800 MB checker-cache limit. The 1,000-owner
slice completed in 47.197 s wall time (46.470 s structural readiness), with
visible-set digest `sha256:1132ed3e7e70679df33878a15d5140ee9ce7557e246b519c9a1b1004a4b1489d`,
2,954,952,704 bytes peak process-tree RSS, and 0.0456% reconciliation error.
The 1,013-owner approved-order slice completed in 47.279 s wall time (47.106 s
structural readiness), with digest
`sha256:9660a9c1512534f563d9ea61fab80741071cc4d5e4c50f7223df9afc8fcd2e0c`,
3,090,137,088 bytes peak RSS, and 0.0459% reconciliation error. Both runs
were byte-exact and lock-free; they confirm that the single Rust publication
route remains correct, while the 45-second admission and 2 GiB RSS gates are
still not qualified at this scale.

An instrumented 1,000-owner replay separated the remaining critical path: the
Rust semantic checker took 27.334 s and the Rust publication transaction
14.366 s (the latter promoted records and identities in 8.459 s and committed
the visible snapshot after 9.278 s). The run remained byte-exact with the
same digest, completed in 45.944 s wall time (45.213 s readiness), and used
2,994,634,752 bytes peak RSS. Lowering the checker cache threshold to 300 MB
did not reduce RSS (3,112,173,568 bytes) and increased wall time to 46.679 s,
so the 800 MB default is retained.

The cold-facet uniqueness-probe optimization was rebuilt and replayed on the
approved corpus. It preserved the exact visible-set digest but measured
46.405 s wall time (45.674 s readiness) and 3,642,802,176 bytes peak RSS for
1,000 owners, versus the preceding 45.944 s / 2,994,634,752-byte sample. The
change remains semantically safe for cold publication, but it is not treated
as a performance qualification; the 800 MB cache and single Rust writer remain
the selected production path.

The Rust scheduler now disables SQLite's automatic page-count checkpoint for
the foreground transaction and performs one passive, bounded checkpoint from
the post-publication maintenance phase. This removes checkpoint fsync latency
from structural readiness without changing WAL durability or visible-set
semantics. The rebuilt approved 1,000-owner replay stayed byte-exact and
lock-free at 43.615 s wall time (42.795 s readiness), with the same visible
digest and 2,912,632,832 bytes peak RSS; the publication subspan fell to
11.708 s. The 45-second admission gate therefore passes for this sample, while
the 2 GiB RSS gate and the full-repository P95 campaign remain open.

The same rebuilt runtime was checked at the 512-owner gate after the WAL
change: 22.934 s wall time, 22.069 s readiness, 1,974,599,680 bytes peak RSS,
0.0964% reconciliation error, and the exact retained visible-set digest
`sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`.

The current runtime was then replayed against the approved 512-owner slice
after the application short-circuit. It completed in 22.522 s wall time and
21.602 s readiness, with 1,996,308,480 bytes peak process-tree RSS, 0.0867%
reconciliation error, and the exact visible-set digest
`sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`.
The result is below the 45 s admission threshold and within the 2 GiB RSS
limit for this gate; it is not a P95 qualification or evidence that the full
n8n corpus has passed. The machine-readable result is
`release/benchmarks/n8n-structural-preflight-512-2026-08-31-rust-short-circuit.json`.

The corresponding 1,000-owner replay completed in 41.420 s wall time and
40.684 s readiness, with the same exact visible-set digest
`sha256:1132ed3e7e70679df33878a15d5140ee9ce7557e246b519c9a1b1004a4b1489d` and
0.0486% reconciliation error. It passes the 45 s admission threshold but
peaked at 2,521,956,352 bytes process-tree RSS, so the 2 GiB memory gate is
still open. The machine-readable result is
`release/benchmarks/n8n-structural-preflight-1000-2026-08-31-rust-short-circuit.json`.

The first full-corpus cold run after the application short-circuit was started
with all 14,083 approved JavaScript/TypeScript owners (14,236 discovered
files). It did not qualify: the preflight admission deadline of 120 s expired
before a complete structurally ready snapshot was published. The private
checker then terminated its pipe with `EPIPE`, and the Rust transport reported
`Indexing-core worker request timed out`. No result JSON or visible-set digest
was emitted for this attempt. This is an open performance gate, not a
production fallback condition: the Rust composition worker remained the sole
structural writer throughout the run.

After adding the checker-free path for owners with no semantic candidates, the
512-owner replay remained byte-exact and lock-free: 22.359 s wall time,
21.580 s readiness, 1,938,718,720 bytes peak process-tree RSS, 0.0872%
reconciliation error, and visible-set digest
`sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`.
The machine-readable result is
`release/benchmarks/n8n-structural-preflight-512-2026-08-31-rust-empty-owner-fastpath.json`.

The same fast path was replayed at 1,000 owners. It completed in 40.777 s
wall time and 40.041 s readiness, retained the exact visible-set digest
`sha256:1132ed3e7e70679df33878a15d5140ee9ce7557e246b519c9a1b1004a4b1489d`,
and reported 0.0505% reconciliation error. Peak process-tree RSS was
2,512,371,712 bytes, so the 2 GiB gate remains open despite the unchanged
semantic output. The machine-readable result is
`release/benchmarks/n8n-structural-preflight-1000-2026-08-31-rust-empty-owner-fastpath.json`.

The post-change verification completed with `CI=true pnpm verify`: architecture,
native formatting/lint/tests, TypeScript tests and typecheck passed; the
coverage gate measured 90.01% repository lines with all critical branches and
semantic regions covered, and publication hygiene checked 914 files.

The Rust publication path was then rebuilt with the cold-base optimization
that skips temporary join-index construction when the direct generation has no
durable record rows to probe. The 512-owner replay completed in 20.754 s wall
time and 19.868 s readiness, with 1,696,841,728 bytes peak process-tree RSS,
0.0955% reconciliation error, and the exact visible-set digest
`sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`.
The 1,000-owner replay completed in 39.068 s wall time and 38.297 s readiness,
with 2,247,245,824 bytes peak process-tree RSS, 0.0580% reconciliation error,
and the exact visible-set digest
`sha256:1132ed3e7e70679df33878a15d5140ee9ce7557e246b519c9a1b1004a4b1489d`.
The 45-second admission gate passes at both sizes; the 2 GiB RSS gate remains
open at 1,000 owners. Machine-readable results are
`release/benchmarks/n8n-structural-preflight-512-2026-08-31-rust-cold-index-skip.json`
and
`release/benchmarks/n8n-structural-preflight-1000-2026-08-31-rust-cold-index-skip.json`.

The rebuilt cold-index publication path was also exercised against all 14,083
owners. It again failed the 120 s admission deadline before a complete
snapshot became visible; the transport reported `Indexing-core worker request
timed out` and the checker pipe closed with `EPIPE`. The temporary-index skip
therefore removes publication overhead for cold slices but does not close the
full-corpus gate; no visible-set digest was emitted for this timed-out run.

The declaration-aware export-query guard was then measured on the approved
corpus. The 512-owner replay completed in 20.562 s wall time and 19.982 s
readiness with 1,846,689,792 bytes peak RSS; the 1,000-owner replay completed
in 38.576 s wall time and 37.845 s readiness with 2,420,768,768 bytes peak
RSS. Both retained their exact prior visible-set digests and stayed below the
45-second admission threshold; the 2 GiB memory gate remains open at 1,000
owners. Machine-readable results are
`release/benchmarks/n8n-structural-preflight-512-2026-08-31-rust-export-query-skip.json`
and
`release/benchmarks/n8n-structural-preflight-1000-2026-08-31-rust-export-query-skip.json`.

After that guard, the complete repository verification was rerun with
`CI=true pnpm verify` and completed successfully. Architecture checks, native
formatting/lint/tests, TypeScript tests and typecheck passed; the coverage gate
measured 90.00% repository lines with all critical branches and semantic
regions covered, and publication hygiene checked 930 files. This verification
confirms the single Rust structural/lexical writer route remains green; it does
not close the still-open full n8n performance and 1,000-owner RSS gates.

The focused production-route and incremental semantic suites were rerun after
the export-query guard (`26` tests across
`tests/app-native-runtime-binding.test.ts` and
`tests/javascript-typescript-incremental-analysis.test.ts`); all passed.

The rebuilt native artifacts were rechecked after the performance experiments:
`pnpm check:native` and `pnpm test:native` both passed (the Rust workspace
test suite reported 15 core, 7 worker, 1 JS/TS engine, 1 projection, 19 syntax
worker, launcher, digest, vector, and protocol tests with no failures). The
experimental explicit-GC checker launch was slower and raised RSS, so it was
reverted; the approved runtime remains the single Rust-writer path documented
above.

The final verification on the rebuilt, reverted runtime completed with
`CI=true pnpm verify` (`RC=0`). It measured 90.00% repository lines, 100% of
critical branches and semantic regions, and publication hygiene passed for 936
files.

The Rust semantic bridge now carries diagnostic proposal keys from the
checker’s projected headers, so `rust_semantic_delta_digest` no longer parses
canonical diagnostic rows a second time. The change preserved the exact
visible-set digest and passed the Rust worker, semantic transport and
application cutover suites (14 tests, 2 intentionally skipped). A fresh
512-owner replay completed in 20.027 s wall time and 19.306 s readiness with
1,872,936,960 bytes peak RSS and reconciliation error 0.100%; the exact digest
remained `sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`.
The corresponding 1,000-owner replay completed in 39.470 s wall time and
38.646 s readiness with 2,459,795,456 bytes peak RSS, reconciliation error
0.0513%, and the exact digest
`sha256:1132ed3e7e70679df33878a15d5140ee9ce7557e246b519c9a1b1004a4b1489d`.
The 45-second admission gate remains green; the 2 GiB RSS gate at 1,000
owners and the full n8n cold gate remain open.

After the compact diagnostic-key transport change, `CI=true pnpm verify` was
rerun on the rebuilt runtime and completed with `RC=0`: coverage measured
90.01% lines with 100% critical branches and semantic regions, and publication
hygiene checked 940 files.

The semantic checker now gates the per-owner export-table lookup on a
conservative syntactic export marker (ES module and CommonJS forms). This
removes checker RPCs for private declaration-only modules while retaining the
query for every recognized export form. JS/TS differential suites passed (62
tests, 2 skipped), and the 512-owner replay remained exact at 19.725 s wall
time and 19.091 s readiness, 1,892,597,760 bytes peak RSS, 0.1001%
reconciliation error, and visible digest
`sha256:40fb4b7953c1f1230a4e12df5bddea22cdc8cb0e29f600a5325d43941515add8`.
The 1,000-owner replay with the same gate completed in 38.842 s wall time and
38.022 s readiness, 2,197,110,784 bytes peak RSS, 0.0527% reconciliation
error, and exact visible digest
`sha256:1132ed3e7e70679df33878a15d5140ee9ce7557e246b519c9a1b1004a4b1489d`.
The memory result is materially lower but remains above the 2 GiB gate by a
small margin; full n8n cold performance is still open.

The export-marker guard was then rerun with the complete repository gate.
`CI=true pnpm verify` completed with `RC=0`; coverage measured 90.01%
repository lines, 100% critical branches and semantic regions, and publication
hygiene checked 946 files. This confirms that the latest single-writer
runtime and checker transport remain contract-clean. It does not change the
open admission items: the 1,000-owner RSS result is still slightly above
2 GiB and the complete n8n cold run still exceeds the 120 s preflight deadline.

The latest bridge pass removes duplicate response-budget serialization. Each
packed semantic batch is measured once, and completed-owner accounting reuses
the already-known envelope and batch sizes instead of serializing the same
owner a second time. Empty checker lookup batches are skipped, and the Rust
composition worker passes the owner input by reference rather than allocating
a one-owner clone. These changes preserve the closed protocol and all exact
output tests; native checks and the complete `CI=true pnpm verify` gate remain
green (`RC=0`, 90.01% lines, 100% critical branches and semantic regions, 946
publication files). No second TypeScript publication path was introduced.

The dynamic-runtime diagnostic lookup was folded into that same owner source
text pass, so the semantic walk no longer calls `getText()` and reruns the
regex for every owner. Focused JS/TS, application cutover and incremental
suites passed (69 tests, no failures). The final `CI=true pnpm verify` after
this change completed with `RC=0`, 90.01% measured lines, 100% critical
branches and semantic regions, and 946 publication files.

The workspace storage bootstrap now acquires the same cross-process writer
marker as `IndexingCore` before any writable TypeScript `openWorkspace`
connection performs schema, identity or lease mutations. Read-only query
connections remain unaffected. Storage, lexical-thread and daemon indexing
integration suites passed (100 tests); this closes the remaining pre-connection
race for the explicitly retained compatibility/maintenance writer without
creating a second structural publication path.

The writable TypeScript storage bootstrap was then verified against the full
repository gate. `CI=true pnpm verify` completed with `RC=0`; coverage measured
90.01% lines, 100% critical branches and semantic regions, and publication
hygiene checked 946 files. The storage/lexical/daemon integration suites also
remain green after the shared writer-marker change.

The remaining writable workspace lifecycle paths now use the same marker as
Rust as well: registration/schema stamping, startup migration and GC recovery,
relocation recovery, relocation itself, and destructive purge. This prevents
maintenance or filesystem operations from opening, renaming, or deleting a
workspace database while a Rust structural or lexical transaction owns it;
read-only inspection paths remain unchanged. `pnpm typecheck`, `pnpm lint`,
`git diff --check`, and the focused storage, workspace-indexing-session and
application cutover suites passed (110 tests). The 2 GiB RSS and complete n8n
cold gates remain open pending a run against the approved corpus.

Relocation now acquires both old and destination writer markers in stable path
order, and creates the destination directory before lock admission. The
regression suite passed all 83 storage tests after this correction. The final
`CI=true pnpm verify` completed with `RC=0`; repository lines measured 90.01%,
critical branches and semantic regions remained 100%, and publication hygiene
checked 946 files. This verifies the single-writer cutover without introducing
another TypeScript structural route; performance admission is still gated by
the outstanding 1,000-owner RSS and approved full n8n measurements.

The final rerun after the relocation correction is green: `CI=true pnpm verify`
returned `RC=0`, with 90.01% repository line coverage, 100% critical branches
and semantic regions, and publication hygiene over 946 files. No lifecycle
writer-marker regression remains in the storage suite.

The candidate coordinator now lazy-initializes its compatibility planner,
executor and materializer. Rust-owned generations still use the coordinator
only for candidate state, leases and the external publication boundary, so no
legacy owner-oriented object graph is allocated on that route. The focused
candidate/indexing suites passed (26 tests), and the final `CI=true pnpm verify`
returned `RC=0` with 90.01% lines, 100% critical branches and semantic regions,
and 946 publication files. This is an allocation reduction, not a second
implementation path.

The Rust semantic bridge was then tightened to remove two transient deep
copies: group requests are encoded from a borrowed slice, and the decoded
owners array is moved out of the response before deserialization. This keeps
the checker-to-core path single-copy while preserving the closed protocol and
retry behavior. `cargo test -p urdira-indexing-worker`, native build/check/test,
and the final `CI=true pnpm verify` all passed; the latter measured 90.01%
repository lines, 100% critical branches and semantic regions, and 946
publication files. The performance gates still require the approved-corpus
1,000-owner RSS and full n8n cold measurements.

The semantic bridge retry path now borrows the bounded request slice all the
way through normal and split-framing calls. It no longer clones every owner
envelope before the first checker request; only the bounded retry slices are
revisited when a frame-size error requires splitting. Continuation pages use a
single-element borrowed slice as well. `cargo fmt --all -- --check` and
`cargo test -p urdira-indexing-worker` passed (7 tests), with no protocol or
publication changes. This is a direct reduction of transient per-group memory
and serialization pressure, not a parallel TypeScript implementation.

The hot `analyze_group` framing path now serializes a borrowed Rust envelope
directly instead of first constructing a duplicate `serde_json::Value` array.
The generic checker call remains unchanged for handshake, closure and control
messages; only the repeated semantic-group path uses the borrowed serializer.
The request-slice retry change and this framing change both pass
`cargo fmt --all -- --check` and `cargo test -p urdira-indexing-worker` (7
tests), preserving the private protocol and Rust-only structural publication.

After the direct borrowed framing change, the complete gate passed again:
`CI=true pnpm verify` returned `RC=0` (119 test files passed, 2 skipped;
1,930 tests passed, 8 skipped), with 90.01% repository line coverage, 100%
critical branches and semantic regions, and publication hygiene over 946
files. The result validates the cutover and the memory reduction; it does not
close the separate approved-corpus cold-run or 2 GiB RSS admission gates.

The remaining source-catalog writer duplication was removed from the
production Rust route. `GenericSourceIndexer` now captures bytes into CAS and
defers the typed source commit; the Rust publication transaction inserts the
observation batch, artifacts, content references, observations, versions and
tombstones, including state-revision assertions. Equivalent scans use the
closed `source_index_commit` control message so they also persist freshness
without opening a TypeScript SQLite writer. The application receives the
source frontier from the in-memory deferred plan and therefore does not
reread an uncommitted catalog. Focused workspace-indexing tests (20),
`pnpm typecheck`, `cargo fmt --all -- --check`, and the Rust worker/protocol
tests passed. This closes the generic SQLite ingestion cutover; the approved
corpus performance/RSS gates remain outstanding.

The Rust source-commit applier now folds multiple commits captured from one
scan frontier (for example an authoritative watch followed by enumeration)
into one state-revision assertion at the end of the same `BEGIN IMMEDIATE`
transaction. Chained frontiers from a future language engine remain accepted;
neither case reopens the TypeScript writer. The complete `CI=true pnpm verify`
gate remains green: 90.01% repository lines, 100% critical branches and
semantic regions, and publication hygiene over 946 files.

The closed protocol regression suite now also round-trips and rejects unknown
fields on `source_index_commit` (6 protocol tests); the Rust worker suite
remains green (7 tests).

Generic source-only workspace scans now resolve the same persistent Rust
composition worker used by language-backed scans. The daemon no-plugin branch
therefore captures to CAS and commits source rows through Rust as well; the
TypeScript source writer remains available only to explicit test/oracle
callers. The focused source-only routing and cancellation tests pass (3), and
the refreshed coverage run reports 90.01% repository lines (25974/28855), with
the coverage and publication gates passing.

Workspace-fork source capture now follows the same cutover: enumeration and
CAS preparation remain bounded host-side capture, while deferred observation
commits are applied by the injected Rust worker. Fork rollback has a paired
closed `source_index_rollback` command, keeping recovery on the Rust writer
boundary instead of reopening a TypeScript source writer. Rust worker and
protocol tests pass (7 and 6 respectively).

The same writer injection is now passed to index-pack import, which reuses the
fork source-capture helper. This removes the last first-scan optimization that
could have cataloged target rows through TypeScript in production; both fork
and pack recovery use the Rust rollback command.

Final verification after this extension passed: `CI=true pnpm verify` (119
test files passed, 2 skipped; 1,933 tests passed, 8 skipped), repository line
coverage 90.00% (25,979/28,864), critical branches and semantic regions 100%,
and publication hygiene over 946 files. The focused fork and pack suites also
passed (11 tests each).

The Rust lifecycle cutover is also complete for the generic generation
boundary: candidate identity, frozen base and work-manifest metadata travel in
the request and are persisted by Rust before engine staging. The application
shell builds the pure work plan but skips candidate inserts, lifecycle
transitions, leases and receipt writes whenever the verified composition worker
owns the generation. A focused Rust test covers this ownership path.

The combined direct-publication path was corrected so carrying semantic input
no longer suppresses the syntax lane: direct generations now stage both
syntax/declaration observations and semantic observations in the same Rust
transaction. This keeps the complete structural record set while preserving a
single syntax analysis and a single publication.

The remaining TypeScript donor bulk-copy implementations are now explicitly
compatibility/oracle-only. When a persistent Rust worker is active, daemon fork
and index-pack attempts are consumed and fall through to the normal Rust
generation; the engine entrypoints reject an injected Rust writer at those
legacy boundaries. This prevents any second production structural SQLite
writer until a Rust-native donor-copy command exists.

The final `CI=true pnpm verify` completed with `RC=0`: 119 test files passed
(2 skipped), 1,933 tests passed (8 skipped), line coverage 90.00%
(25,986/28,872), critical branches and semantic regions 100%, and publication
hygiene over 946 files. The 512/1000-owner and full approved-corpus performance
gates remain separate and are not represented as an SLA claim.

The daemon no longer has a forced TypeScript lexical-maintenance escape hatch
for fork or pack success. Compatibility imports run only when no Rust core is
configured; Rust-owned generations always leave lexical reconciliation to the
Rust scheduler, preserving the same workspace writer exclusion. The focused
fork, pack and daemon integration suites remain green (36 tests).

## 2026-08-31 RSS admission amendment

The product decision for the remaining preflight gates is time-first. RSS is
still sampled from the complete process tree and retained with the report, but
the 2 GiB value is an advisory optimization budget rather than an automatic
rejection for an individual exact sample. If the agreed time gate passes (the
<=30 s product target or the <=45 s admission limit), a sample remains
admissible when its RSS is higher; the overage is reported and remains a
follow-up optimization item. OOM termination, incomplete publication, digest
mismatch, temporary-storage violation, and time-gate failure remain failures.
Accordingly, the retained 1,000-owner run at 38.842 s wall time and
2,197,110,784 bytes peak RSS is green for the <=45 s admission decision despite
exceeding 2 GiB. This does not close the full n8n cold gate, which still exceeds
the bounded preflight deadline, nor does it establish a P95 result.

## 2026-08-31 combined-lane receipt regression

The first complete syntax-plus-semantic direct generation exposed a private
staging collision: both lanes legitimately use the same owner cursor sequence.
Rust now carries an internal `observation_lane` through owner receipts, typed
rows, facets and dependency joins. The public SQLite v3 schema, canonical row
bytes, record identifiers and visible-set ordering are unchanged. A focused
Rust regression accepts the same owner and sequence in syntax and semantic
lanes and seals one logical owner; the full verification gate remains green.

The corrected 1,000-owner exact preflight published successfully with visible
set digest `sha256:838b6ee6b15eb0cf9a2ea32cac1472e6089cbcbb76892cd6b345287315b25055`
and reconciliation error below 0.05%, but measured 55.160 s wall time and
2,410,070,016 bytes peak process RSS. RSS is advisory under the amendment
above, while the 45 s admission limit is not met by this complete-lane run;
the 1,000-owner performance gate therefore remains open. No `SQLITE_BUSY` or
`SQLITE_LOCKED` was observed and no TypeScript structural writer was used.

The corresponding corrected 512-owner preflight completed in 24.995 s wall
time (23.138 s structural readiness), with 1,775,091,712 bytes peak RSS,
0.0854% reconciliation error, and visible-set digest
`sha256:b0bca5901be3cdc71c500ff3180df59c663b5e77645c4165cd0779b8703e0934`.
It passes the <=45 s admission gate; RSS remains advisory. Scaling to 1,000
owners is still the active performance blocker before the full n8n cold run.

The cold-path publication optimization was then measured with the same
complete-lane corpus. Rust drops and transactionally rebuilds only the empty
secondary lookup indexes during a cold publication; the SQLite v3 schema,
atomic swap and query indexes are otherwise unchanged. The corrected
1,000-owner sample reached 44.533 s structural readiness (45.979 s wall),
2,458,566,656 bytes peak RSS, 0.0466% reconciliation error and the same exact
visible-set digest above. This clears the <=45 s structural admission gate;
the wall-clock sample remains recorded because the preflight harness includes
runtime and readiness polling overhead. The corresponding 512-owner sample
was 24.786 s wall time with the exact digest above. RSS remains advisory under
the time-first amendment, and the full n8n/P95 campaign is still pending.

The Gate 5 full n8n attempt used all 14,083 source owners (14,236 files
inspected) with the same native Rust route. Capture completed and publication
reached the readiness polling phase, but the 120 s bounded preflight deadline
expired after 500 polls while the Rust indexing-core request was still
running. The harness therefore emitted no visible-set digest or authoritative
RSS sample; the checker transport subsequently closed with EPIPE during
shutdown. This is a bounded performance failure, not a publication or digest
acceptance, and keeps the full-corpus/P95 campaign open.

## 2026-08-31 bounded semantic checker parallelism

The composition worker now schedules semantic checker groups in bounded
parallel lanes when a generation has at least 768 affected owners. The
reusable checker remains the primary lane; up to seven short-lived verified
checker subprocesses analyze disjoint 32-owner groups, while Rust drains and
accepts every result in the original group order. No checker lane writes
SQLite, and Rust remains the sole owner of canonicalization, receipts,
staging, sealing and publication. `URDIRA_RUST_SEMANTIC_PARALLELISM` is a
closed 1..8 tuning override; the default is four lanes only above the threshold
and one lane for smaller/incremental generations.

The implementation compiles cleanly and passes the Rust worker/core/engine
tests, workspace clippy, TypeScript typecheck, lint, coverage (90.00%,
25,994/28,881 lines), critical-region coverage (100%), architecture and
publication gates. The full n8n performance gate must still be rerun with the
parallel lanes; no new digest or P95 claim is made until that bounded campaign
completes.

## 2026-08-31 parallelism measurement and full-corpus result

The bounded checker lanes were measured on the exact 1,400-owner slice. With
`URDIRA_RUST_SEMANTIC_PARALLELISM=4`, structural readiness was 43.485 s and
wall time was 45.884 s; peak process RSS was 4,783,472,640 bytes and
reconciliation error was 0.0475%. With the explicit eight-lane override,
readiness was 45.404 s and wall time was 47.008 s; peak RSS was
4,799,299,584 bytes and reconciliation error was 0.0469%. Both runs produced
the identical visible-set digest
`sha256:b55e6fa70e55f8a2656b07ec5f568898ed71425ef9aa6a5bb04f251a8ceaaa54`.
Eight lanes are therefore retained only as a bounded diagnostic override; the
default remains four lanes above 768 owners because the measured eight-lane
run was slower and used more memory. RSS remains advisory under the time-first
amendment, so these samples are not rejected for exceeding 2 GiB; the 45 s
admission limit remains a hard timing gate.

The follow-up Gate 5 run covered all 14,083 approved n8n owners with the
four-lane setting, and a single bounded retry used the eight-lane override.
Both runs completed capture and entered semantic publication, but neither
published a complete snapshot before the harness's 120 s deadline. The
preflight emitted no visible-set digest or authoritative RSS sample; checker
subprocesses closed with EPIPE during timeout shutdown. This is a timing
failure, not an RSS rejection or a publication/digest acceptance. The full
n8n cold result, and therefore the P95 campaign and release acceptance, remain
open despite the successful exact 1,400-owner output.

## 2026-08-31 duplicate-plan and diagnostic-scope removal

The production Rust route no longer builds an owner-sized TypeScript work
manifest or invalidation artifact set. `CandidateIndexer` receives only a
contract-shaped empty plan (Rust derives physical groups and publication
metadata from the captured generation), and the application omits
`candidate_work_manifest` from the Rust generation request. The compatibility
implementation retains the historical manifest for differential tests only.

The checker subprocess also stopped requesting project-wide diagnostics for
each 512-root semantic window. Diagnostics are now queried only for the
bounded owner group and retained for subsequent groups in the same snapshot;
the owner rows, canonical bytes, and visible-set digest are unchanged by this
scope reduction. Focused JavaScript/TypeScript suites pass after the change.

The exact 1,400-owner n8n slice was replayed after rebuilding the worker. It
completed with structural readiness 41.900 s and wall time 43.483 s, the same
visible-set digest
`sha256:b55e6fa70e55f8a2656b07ec5f568898ed71425ef9aa6a5bb04f251a8ceaaa54`,
and 0.0498% phase reconciliation. Peak process-tree RSS was 4,225,695,744
bytes; under the time-first admission amendment this is advisory and does not
invalidate the run because it remained below the 45 s hard timing gate. The
diagnostic-scope change therefore removes measurable checker overhead without
changing the canonical output.

For comparison, disabling the large-workspace 512-root checker windows for the
same 1,400-owner slice reduced structural readiness to 42.784 s and wall time
to 44.118 s, with 4,987,158,528 bytes peak RSS and 0.0488% reconciliation
error. The visible-set digest remained
`sha256:b55e6fa70e55f8a2656b07ec5f568898ed71425ef9aa6a5bb04f251a8ceaaa54`.
The improvement is only about 0.7 s in readiness while retaining a larger
checker resident set, so the production default remains windowed for bounded
memory; the no-window mode is an explicit diagnostic/performance experiment,
not a second indexing route.

A final six-lane calibration on the same 1,400-owner slice reached 46.154 s
structural readiness and 47.625 s wall time, with 5,130,272,768 bytes peak
RSS and 0.0467% reconciliation error. It retained the same visible-set
digest, but was slower than both four and eight lanes; the production default
and bounded override policy are consequently unchanged.

An attempted checker shortcut that reused bulk symbols for simple identifier
calls was rejected. Although the focused TypeScript suites passed, its 128-
owner preflight changed the visible-set digest from the retained exact
`sha256:66d2199b03b6f59d2e7a64f33aa6d3bb543877299edc0460a94261b95ed5e67b`
to a different value. The shortcut was removed immediately; a rerun restored
the retained digest. This confirms that semantic call resolution remains on
the TypeScript checker path until a byte-differential replacement is proven.

The Rust composition loop also stopped flattening and cloning the complete
semantic request envelope a second time: owner payload lookups now borrow the
single group-owned vectors. The rebuilt native route passed the Rust tests and
the 128-owner exact preflight, restoring visible-set digest
`sha256:66d2199b03b6f59d2e7a64f33aa6d3bb543877299edc0460a94261b95ed5e67b`.
This is an allocation/working-set reduction only; it does not change the
closed group limits or semantic output.

The 1,400-owner replay after this change remained exact
(`sha256:b55e6fa70e55f8a2656b07ec5f568898ed71425ef9aa6a5bb04f251a8ceaaa54`):
44.987 s structural readiness, 45.933 s wall time, 4,878,581,760 bytes peak
RSS and 0.0468% reconciliation error. The result is within run-to-run noise
of the prior four-lane sample, so no latency improvement is claimed from this
change.

With the additional `Arc<Value>` sharing across parallel checker lanes, the
same 1,400-owner replay stayed exact at 45.347 s readiness and 46.123 s wall
time, 4,896,210,944 bytes peak RSS and 0.0501% reconciliation error. This is
within measurement variance and is retained as a working-set optimization,
not as a new latency claim.

The closure preparation envelope is likewise now serialized by reference from
Rust: all bounded checker lanes share one immutable metadata value instead of
cloning the complete source manifest per lane. The rebuilt four-lane route
passed the 128-owner exact preflight with the retained digest
`sha256:66d2199b03b6f59d2e7a64f33aa6d3bb543877299edc0460a94261b95ed5e67b`.

The final post-change verification completed with `CI=true pnpm verify` and
`RC=0`: 90.00% repository line coverage (25,994/28,881), 100% critical
branches and semantic regions, and publication hygiene over 946 files. Rust
formatting, workspace tests and clippy also remain green.

After switching the parallel group envelopes to `Arc<Value>`, the native
artifacts were rebuilt and the complete `CI=true pnpm verify` gate was rerun;
it again completed with `RC=0` and the same 90.00% line, 100% critical-region
and 946-file publication results.

The final verification rerun after the compact-plan and owner-scoped-diagnostic
edits also completed with `CI=true pnpm verify` and `RC=0`: 90.00% repository
line coverage (26,001/28,888), 100% critical branches and semantic regions,
and publication hygiene over 946 files. This supersedes the earlier line-count
snapshot above; no behavioral or digest drift was observed.

The composition worker now retains the Rust workspace mutation lease from the
initial staging transaction through `FinalizeGeneration`. The application only
receives progress metadata between those commands, so source or structural
SQLite writes cannot interleave against the frozen base; failure cleanup still
releases the lease for receipt-backed recovery. This closes the last ownership
window without adding a second writer or changing the v3 publication bytes.

The bounded semantic-window calibration is now exposed through the private
`URDIRA_RUST_SEMANTIC_WINDOW_SIZE` override (512--4,096 roots, in 32-owner
increments). A 2,048-root window was measured on the exact slices but was not
promoted: 1,000 owners reached 47.249 s readiness / 48.826 s wall time and
1,400 owners reached 43.593 s readiness / 45.226 s wall time, both with the
retained exact visible-set digests. The production default remains 512 roots;
the override is a bounded diagnostic knob rather than a second route.

## 2026-08-31 conservative direct-call resolution

The Rust-authoritative checker walk now bypasses `getResolvedSignature` only
for a direct, non-aliased identifier whose symbol has exactly one declaration.
The declaration handle is resolved through the existing per-snapshot cache;
aliases, overload sets, property/element access and contextual calls retain the
full TypeScript resolver. This keeps semantic ownership and canonical rows
unchanged while removing a remote checker round trip on the common direct-call
shape.

The differential preflight retained the exact visible-set digest at 128 owners
(`sha256:66d2199b03b6f59d2e7a64f33aa6d3bb543877299edc0460a94261b95ed5e67b`)
and 512 owners (`sha256:b0bca5901be3cdc71c500ff3180df59c663b5e77645c4165cd0779b8703e0934`),
with no change to group limits or publication SQL. A 1,000-owner replay after
the change completed in 48.767 s wall / 48.077 s readiness and retained its
exact digest `sha256:f5ccc7d7d872638587d814a63829a566804519c160c587c36abf2fdf04083f4d`;
it remains above the 45 s admission gate, so the full n8n and P95 campaigns
stay open. Peak RSS is advisory under the amended gate.

The subsequent `CI=true pnpm verify` completed with `RC=0`: 90.03% repository
line coverage (26,019/28,900), 100% critical branches and semantic regions, and
publication hygiene over 946 files. This verification includes the direct-call
coverage test and does not alter the open full-corpus performance status.

## 2026-08-31 production fallback fail-closed guard

The resolver and default daemon options now fail closed whenever the Rust
composition worker is absent, regardless of whether `NODE_ENV` is set. The
portable TypeScript owner/coordinator remains callable only from Vitest's test
environment or when the private `URDIRA_INDEXING_CORE_ORACLE=1` baseline switch
is explicitly supplied. The release campaign baseline declares that switch;
the candidate lane does not. This prevents an unset environment or a missing
packaged worker from silently reintroducing the duplicate TypeScript SQLite
writer. The focused native-binding suite passes with this stricter boundary.

## 2026-08-31 source-transition payload removal

The Rust-owned publication envelope no longer carries the complete
TypeScript-generated `source_transitions` array when capture commits are
available. Those commits already contain the authoritative versions,
tombstones, closures and observation metadata; the composition worker now
derives the transition templates inside the same SQLite transaction before
promotion. This removes a second O(owners) serialization/allocation while
preserving the existing artifact-change and tombstone identifiers and the v3
materialization descriptor shape. The compatibility/oracle route still sends
its historical transition templates when no Rust capture commit exists.

The worker has a focused regression test covering an updated artifact,
previous-version linkage and removal of generation-only fields from the
derived template. Rust workspace tests, clippy, TypeScript compilation and
the workspace indexing-session suite remain green after the cutover.

The rebuilt-worker preflight measured 25.29 s wall for 512 owners and 47.27 s
wall (45.88 s structural readiness) for 1,000 owners, with exact visible-set
digests `sha256:3994b694fd9ae3ddfc24c1435f5c18dec4632b41f6e0b354afb49fa1786eb997`
and `sha256:f5ccc7d7d872638587d814a63829a566804519c160c587c36abf2fdf04083f4d`.
The 1,000-owner sample therefore remains outside the 45 s admission gate;
its 2.39 GiB RSS is advisory and does not independently reject the sample.
Disabling semantic windows was also measured and was slower (48.88 s wall),
so it was not promoted as a second production route.

## 2026-08-31 TypeScript source-planner cutover

The Rust-owned workspace path now supplies `CandidateIndexer` with a compact
source-plan control envelope derived from the captured source-index result.
`SourceCandidatePlanner.plan()` remains available only when the compatibility
oracle route is selected; production Rust generations no longer allocate an
owner-sized transition plan or call the TypeScript freshness writer. Changed
artifact ids are reconstructed from the deferred Rust capture commits, while
the worker derives and publishes canonical transition templates in its own
transaction. Progressive stages preserve the exact pending/equivalent rules
and provider watermark semantics.

The focused workspace-indexing tests (28 cases), TypeScript typecheck,
architecture/native checks, and all Rust workspace tests pass after this
boundary change. The performance admission result is unchanged: 512 owners
remain below 30 s, while the 1,000-owner sample remains above the 45 s gate;
RSS overage remains advisory and is not a rejection when the time and digest
gates pass.

The application-to-worker boundary also no longer rebuilds an
`artifactVersions` array merely to calculate the Rust source-state digest.
Engine capture forwards the validated source digest and snapshot coordinate
directly; the array remains allocated only by the explicit TypeScript
compatibility/oracle route. This removes another corpus-sized allocation from
production cold and incremental generations.

Authoritative watcher commits are now flushed through the same Rust source
writer before enumeration capture begins. This preserves the exact source
state revision expected by the later structural transaction and prevents a
delete/rename event combined with a scan from either being lost or producing
two deferred commits with a conflicting revision.

Direct provider/oracle invocations that omit the new digest field retain a
compatibility fallback; the production coordinator always supplies the
streamed digest before entering the Rust-owned branch.

The post-cutover verification was rerun after the source-digest and watcher
ordering changes with no concurrent build process. `CI=true pnpm verify`
completed with `RC=0`: 90.01% measured repository line coverage (26,044/28,935),
100% critical branches and semantic regions, and publication hygiene over 946
files. The focused Rust workspace tests, native checks, TypeScript typecheck,
and `git diff --check` were also green. The current retained performance
evidence remains unchanged: the 512-owner sample is below the 30-second
product target, while the 1,000-owner sample is above the 45-second admission
gate; its RSS overage is advisory and is not an independent rejection when
time, digest, publication, and resource-safety gates pass.

After the source-only watcher ordering adjustment, the final full gate was
rerun on the exact worktree: `CI=true pnpm verify` completed with `RC=0`,
90.00% measured repository line coverage (26,046/28,940), 100% critical
branches and semantic regions, and publication hygiene over 946 files.

The rebuilt-runtime replay on 2026-08-31 confirms the current boundary on the
same n8n authority corpus. The 512-owner sample completed in 24.413 s wall
(23.545 s readiness), retained visible-set digest
`sha256:3994b694fd9ae3ddfc24c1435f5c18dec4632b41f6e0b354afb49fa1786eb997`,
reported 1,871,855,616 bytes peak process-tree RSS, and had no SQLite lock
errors. The 1,000-owner sample completed in 47.721 s wall (46.983 s
readiness), retained digest
`sha256:f5ccc7d7d872638587d814a63829a566804519c160c587c36abf2fdf04083f4d`,
and reported 2,293,448,704 bytes peak process-tree RSS. Its RSS overage is
advisory as agreed, but the sample remains above the hard 45-second admission
gate; therefore the full cold n8n campaign and P95 qualification remain open.

## 2026-08-31 n8n cold/incremental correction

The current rebuilt worker uses four semantic checker lanes from 768 affected
owners and streams projection-set digest bytes directly from SQLite. The
1,000-owner slice measured 32.678 s structural cold readiness and 1.474 s
application structural time for the first real content edit; the edit's Rust
publication subspan was 1.078 s, while the harness measured 4.498 s including
its stability window.
The cold sample is still above the 30 s product target but inside the 45 s
admission door. The direct publisher now forces the owner-key index for
historical identity predecessor lookups; this removes the previous 12 s
full-history scan without changing the v3 schema or canonical bytes, but the
end-to-end incremental P95 remains unqualified. Full n8n and mutation-trace
P95 qualification remain pending. The latest `CI=true pnpm verify` ran all
1,936 tests (8 skipped) but exits at the repository line-coverage gate (89.96%,
26,069/28,978); the older RC=0 statement above is historical and not the
current release status.

## 2026-08-31 cold cache follow-up

The Rust publication timing was split by SQLite operation. On the 1,000-owner
n8n slice, rebuilding the seven destination indexes costs about 3.4--4.0 s;
the streamed visible/projection digests stay below 0.8 s. A connection-local
1 GiB SQLite page cache reduced the application cold structural span to
32.784 s and left the first content edit at 1.358 s application time. The
harness measured 34.163 s cold readiness and 7.191 s for that edit because it
waits for a bounded stable watcher observation after publication. An eight-lane
semantic checker experiment regressed cold readiness to about 34.3 s, so the
production default remains four lanes. This is diagnostic evidence only; a
complete n8n/P95 campaign and the coverage gate remain open.

## 2026-08-31 Rust-owned secondary-index maintenance

Cold publication now rebuilds only the visible-record and identity-owner-key
indexes synchronously. A bounded Rust maintenance worker rebuilds the other
derived query indexes after lexical reconciliation under the same workspace
lease, retrying behind structural source commits. The 1,000-owner n8n replay
measured 29.092 s application structural readiness (29.727 s harness) and
1.397 s application time for the first content edit, with the exact visible
digest preserved. The retained report is
`n8n-incremental-preflight-1000-edit00-rustowned-asyncindex-2026-08-31.json`
(`sha256:786ca6b11efb204a06abd098fd1bba144a3b60a3c80ab2ca1ddfbe84c64c2b6e`).
The harness edit interval (6.83 s) includes its stable-observation window and
does not represent the Rust publication span. Complete n8n/P95 qualification
and the coverage gate remain open.

## 2026-08-31 n8n semantic-lane and writer-priority follow-up

The automatic Rust semantic checker lane is now six processes for generations
with at least 768 affected owners (the four-lane experiment was faster than
eight lanes, while six lanes reduced the measured 1,000-owner semantic span).
This only parallelises checker analysis; Rust remains the sole staging,
receipt, publication, and SQLite writer. Lexical and secondary-index
maintenance now observe the same generation epoch and yield to a newer
structural generation, avoiding a writer-lease convoy after cold readiness.

The rebuilt 1,000-owner n8n slice with the real `content-10` mutation measured
28,724 ms application structural cold readiness and 2,245 ms application
incremental structural time. The harness readiness phase was 29,332 ms cold
and 7,200 ms for the edit (its stable-observation window is intentionally
included). The retained report is
`n8n-incremental-preflight-1000-edit10-rustowned-sem6-2026-08-31.json`
(`sha256:ab5101f0966a114dc602a2a495dd860e0b0be5f9d0439deeab392c7166841f7d`).
The sample is informative but not a P95 qualification: cold is near the
30-second product target and inside the 45-second admission door, while the
incremental application span remains slightly above 2 seconds. Full n8n,
mutation-trace P95, RSS, and 1,000-owner lock-safety qualification remain
pending.

## 2026-08-31 Rust-owned source frontier handoff

The production `index_generation` envelope now contains only bounded engine
configuration and semantic coordinates. It does not serialize the complete
`files`/`root_names` owner manifest from TypeScript. Once the source capture
commits are accepted, the generic core reads the current
`source_artifacts`/`artifact_versions` frontier through its leased SQLite
connection; the JS/TS engine filters its language paths and derives CAS blob
coordinates inside Rust. Oracle callers may still provide the private fields,
but they are no longer used by the production composition path.

The rebuilt 1,000-owner replay retained the prior cold and `content-10` visible
digests exactly. It measured 38.4--39.9 s application cold structural readiness
and 2.7--2.8 s for the edit, showing run-to-run checker/SQLite variance after
the handoff. These runs are diagnostic only and do not replace the earlier
retained gate report; a fresh complete n8n/P95 campaign is still required.

## 2026-08-31 Rebuilt frontier-budget control

The Rust-owned envelope budget was corrected after a control failure: an
omitted application manifest had left `max_files=1`/`max_source_bytes=1`, while
the core correctly resolved 1,000 JS/TS files from the committed SQLite
frontier. The production path now uses the closed protocol ceiling for an
omitted manifest and retains Rust-side filtering and byte validation.

The subsequent 1,000-owner replay preserved exact output but measured 41.617 s
cold harness readiness (40.967 s application structural span) and 22.765 s for
the first mutation. The mutation's actual internal structural scan was 2.557 s;
the larger harness interval came from watcher re-observation and the required
stable-readiness window. Cold debug timings were about 8.3 s facts, 16.1 s
semantic checker, and 13.5 s publication. This is diagnostic evidence, not a
passing P95 gate; no further owner-count proxy iteration is justified until
the n8n checker/publication and readiness scheduling spans are measured under a
controlled campaign.

## 2026-08-31 Direct Rust lifecycle cutover

The production Rust route now bypasses `CandidateIndexer` entirely. The
TypeScript layer captures source data and invokes the private engine contract,
then Rust owns source commit, acceptance, staging, sealing, publication and
cancellation. Candidate planning/materialization in TypeScript remains only
for the compatibility oracle. The rebuilt 1,000-owner control preserved exact
cold and incremental visible-set digests; cold readiness was 41.809 s and the
first mutation 19.541 s at the harness boundary, with internal Rust spans of
41.105 s and 2.545 s respectively. This removes the duplicate TS lifecycle but
does not qualify the cold 30 s or incremental 2 s P95 gates.

## 2026-08-31 Full n8n cold capacity attempt

The direct Rust route was exercised against the full n8n corpus with a
14,083-owner request (14,082 JS/TS owners were actually present). Source
capture completed in five batches and syntax analysis completed in 876 ms;
facts extraction took approximately 117 s for 230 groups. The run terminated
before publication with the stable Rust error `database or disk is full`
while semantic groups were still running. There is therefore no published
digest or output report for this attempt. It is evidence of an unmet
full-corpus temporary-storage/capacity precondition, not a passing or failing
45-second timing gate; RSS, temporary-space ratio, and concurrent lock safety
are still unqualified at full n8n scale.

## 2026-08-31 Syntax fact-page serialization fast path

The Rust syntax worker avoids repeated JSON serialization for the common case
where all remaining facts for an owner fit the response budget. It probes the
complete page once and retains binary search only for oversized pages, with no
change to fact bytes, cursors, row limits, or the private protocol. The
focused syntax-worker tests pass (19/19). Full n8n timing has deliberately not
been rerun after the disk-capacity failure, so this is an implementation
change awaiting a capacity-safe measurement, not a new performance result.

## 2026-08-31 compatibility-route separation and fixture cleanup

The non-Rust coordinator branch is now explicitly TypeScript-oracle-only: it
no longer carries a Rust external-publication callback, Rust-owned changed-file
calculation, or Rust lifecycle flags. The production branch returns before
constructing that candidate writer, so there is one structural owner in a
normal daemon and one isolated implementation for differential tests.

Vitest now removes stale project-scoped temporary roots at run start and in its
global teardown, while preserving user-managed model and interactive-agent
caches. This closes the interrupted-test leak that had accumulated 18,739
directories and 1,078 files in the macOS temporary directory; the cleanup
released approximately 217 GiB without touching the worktree or build
artifacts.

## 2026-08-31 latest full n8n measurement

After the temporary-storage cleanup and native rebuild, one full n8n cold run
was executed through the Rust composition worker with a 14,083-owner bound
(14,082 JS/TS owners). Source capture completed in five bounded commit batches;
syntax completed in under one second, facts extraction covered 14,082 owners
in 230 groups, and semantic extraction completed 952 groups. Rust reached
3,183,253 structural rows before the post-publication phase repeatedly saw
`database is locked` while reconciling the detached lexical projection. The
600-second readiness deadline then expired, so this run produced no complete
visible-set digest or JSON report.

The failure is bounded and diagnostic: the lexical retry loop terminated after
its configured attempts, and the structural publication was not silently
accepted as a complete readiness result. The run's temporary database root was
removed after termination. This leaves full n8n timing, P95, RSS/temporary
space, and concurrent writer qualification unresolved; the 1,000-owner slice
must not be presented as a substitute for that result.

## 2026-08-31 post-publication SQLite connection handoff

The full n8n timeout exposed a lifecycle bug in the Rust worker: detached
lexical reconciliation attempted to open its own leased SQLite connection
before the active structural operation had been removed. `FinalizeGeneration`
now returns an immutable maintenance envelope, releases the structural lease,
drops the active operation (including its TEMP staging connection), and only
then schedules lexical reconciliation or a WAL checkpoint.

A 64-owner n8n smoke with one mutation completed cold and incremental Rust
indexing without lock retries (4.334 s cold, 0.937 s incremental); lexical
maintenance completed with `wal_busy=0`. This is focused lifecycle evidence,
not a replacement for the unresolved full-corpus n8n/P95 gate.

The subsequent full run with the connection handoff reached publication
instead of the earlier lock failure, but the 600-second harness window ended
first. The worker then logged `rust core publish ms=469634` and the application
reported `structural_ready_ms=950825`; shutdown removed the temporary database
before the completion event and visible-set digest were retained. The path is
publication-capable, while a durable full-corpus digest still requires one
explicitly long-window run.

## 2026-08-31 correctness completion and lexical retry window

One explicitly long-window full n8n run was allowed to finish with a 30-minute
readiness limit. It retained a JSON result for 14,083 requested owners
(14,082 JS/TS owners): cold elapsed `1,318,331 ms`, visible-set digest
`sha256:cdcf24684b27b1053cde86066134b6bc2c67cd5301c456c1b8a1f15649d47cf8`,
and one content mutation elapsed `166,771 ms` with digest
`sha256:ba6172394b47834400c4d117ed2311f900d7c3d52c519f7f330d146390e8aef7`.
This is eventual-correctness evidence only; it is far outside the product
timing objective.

The detached lexical scheduler now retries for a bounded ten-minute window
with capped backoff, instead of a few-second fixed attempt count. A rebuilt
64-owner n8n smoke completed cold and incremental indexing and reported
`wal_busy=0` with every WAL frame checkpointed. All generated benchmark
reports and temporary roots were removed after verification.
