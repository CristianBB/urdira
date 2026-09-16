# Maintainability baseline — 2026-09-16

This note records the first non-functional maintainability gate and the first
behavior-preserving extraction. It does not claim that the repository is fully
refactored yet.

## Baseline

`pnpm check:maintainability` scans 578 maintained JavaScript/TypeScript/Rust
source files while excluding generated contract artifacts, external fixtures,
dependencies, and build output. The current JavaScript/TypeScript observations
are 366 complexity findings, 79 nesting-depth findings, and 218
oversized-function findings. The checked-in baseline permits those existing
counts and records the current finding set per file, so a local regression is
rejected even when another module improves. Resolved entries can be removed
incrementally.

## First extraction

Registry-definition discovery was moved out of
`packages/engine/src/canonical-query-data-port.ts` into
`packages/engine/src/query-definition-discovery.ts`. The public query port,
registry inventory, result shape, ordering, and matching behavior are
unchanged. The extraction makes the registry-only responsibility independently
readable and testable.

The shared glob, test-artifact, and word-boundary matching rules were then moved
into `packages/engine/src/source-matching.ts`, reused by both query ports. Their
matching semantics and Unicode boundary handling are unchanged.

The daemon's local IPC client was moved from the large runtime module into
`packages/daemon/src/client.ts`; the package export remains unchanged and the
client continues to delegate to the same protocol adapter.

Pure source-window calculations (line boundaries, context expansion, line
numbers, and surrogate-safe truncation) were moved into
`packages/engine/src/source-snippet-utils.ts`, keeping hydration orchestration
separate from text-coordinate mechanics.

Public subject projection, context-identifier extraction, and source-artifact
record construction were moved into
`packages/engine/src/query-record-projections.ts`; they remain pure and keep the
same record shapes and identity fields.

Comparison streaming, diff classification, and response projections were moved
into `packages/engine/src/query-comparison.ts`; the data port now orchestrates
participant loading and delegates comparison mechanics.

Recursive stage-output binding materialisation was moved into
`packages/engine/src/stage-handle-materialization.ts`, isolating handle
cardinality and selector conversion from query selection logic.

Source snippet hydration was moved into `packages/engine/src/source-snippet.ts`;
the query port now delegates span validation, context windows, and
surrogate-safe truncation to a source-focused module.

The `core:get_source` stream projection was moved into
`packages/engine/src/source-stream-projection.ts`, isolating option parsing,
deferred hydration metadata, and total-character budgeting from subject lookup.
Option decoding was then reduced to small named helpers; this removes one
complexity finding rather than merely relocating it.

Daemon readiness payload construction now delegates operation availability and
blocked-operation shaping to a named pure helper, keeping lifecycle code apart
from response policy while preserving all readiness reason codes.

Workspace administrative projections now use named helpers for VCS labels and
optional fields, reducing branching in the public view builder without changing
its serialized fields.

The v4 status projection now delegates lane and last-scan field construction to
named helpers, keeping generation arithmetic separate from serialization.

The v3 readiness path now delegates read-only SQLite access and monotone
last-known-state fallback to `readV3ReadinessState`, leaving readiness
derivation focused on policy rather than storage lifecycle.

The v4 readiness derivation now names its reason-code and generation-field
policies, making optional frontier fields and failure explanations auditable
without reading the full serialized object.

Its availability/freshness field matrix is now assembled by a dedicated helper,
so the top-level derivation reads as state calculation followed by projection.

The TypeScript analyzer now shares a named declaration classifier between its
normal and bounded syntax walks. This removes duplicated kind mapping and
reduces complexity without changing published IDs, spans, or universal kinds.

The analyzer also shares one `nodeName` helper across all syntax walks,
centralizing constructor naming and escaped-identifier handling so future AST
changes have one readable point of maintenance.

The bounded syntax path now names its declaration-kind mapping and transitive
dependency-closure calculation, keeping corpus-size fallback policy separate
from record assembly.

Project discovery now delegates config fallback member matching and referenced
project extraction to named helpers, making configuration semantics readable
without changing inferred roots or dependency ordering.

Semantic hash calculation now names trivia and guard-comment classification,
keeping scanner mechanics separate from the policy that distinguishes semantic
content from cache invalidation guards.

Virtual TypeScript project preparation is now a named step, centralizing root
selection, compiler options, and virtual configuration construction before the
AST walk begins.

The bounded scanner now has explicit declaration and import passes, separating
record construction from dependency-edge and incomplete-closure tracking.

Syntax-project setup now uses a named language-selection helper as well, keeping
the public result's JavaScript/TypeScript decision out of the AST orchestration.
Both bounded and checker-backed paths now use that same helper, preventing
language-selection logic from drifting between modes.

Checker-backed dependency closure calculation now goes through the same named
closure helper as the bounded path, so transitive traversal and incomplete-file
propagation have one auditable implementation.

The v4 scan path now delegates scope precedence and the single uninitialized
worker retry to named helpers. The scan body remains responsible for lifecycle,
rollback, readiness, and maintenance side effects, while recovery policy is
readable and independently bounded.

Relation-pair graph filtering now uses a pure row-collection helper, keeping
direction/kind matching separate from generation and chunked SQLite access.

Schema-to-JSON conversion now delegates scalar expression mapping to a named
helper, leaving collection, record, union, and reference composition visible
in the main dispatcher while preserving the generated schema contract.

Delta record loading now delegates corpus-scale survivor filtering to a yielding
helper, keeping cache churn accounting and database refresh orchestration
separate from the immutable cached-row merge.

Subject-selector resolution now delegates symbol lookup, context narrowing, and
ambiguity reporting to a dedicated helper, leaving artifact and identity
selectors in the top-level dispatcher.

Graph-edge fallback pagination now lives in a named relation-scan helper, while
the indexed path only chooses the native projection or the record fallback.

Semantic coverage arithmetic and provider-binding digest selection now use
named pure helpers, leaving the coverage view builder focused on projection and
optional-field assembly.

Indexed graph BFS expansion now uses a named frontier helper for direction,
alias resolution, and deduplication; hydration and depth control remain in the
orchestrator.

Literal search verification now delegates case/normalization, word-mode
matching, offsets, and line-span calculation to a pure helper; SQL candidate
selection and source hydration remain in the storage-facing method.

Comparison participant-role validation and requested stream projection now use
dedicated helpers, leaving `executeCompare` focused on participant loading and
diff orchestration.

The affected-semantic-page argument parser now owns limit clamping and cursor
decoding/error translation, keeping the operation body focused on set freshness
and page projection.

Graph pushdown operation-specific selector, direction, and depth policy now
comes from a named plan helper; the pushdown method focuses on indexed lookup,
hydration, and evaluation.

Relation-closure endpoint selection and certainty/provenance propagation now
use dedicated helpers, reducing nested control flow in the bounded BFS while
retaining exact node-cap and completeness errors.

The graph outline operation now has a dedicated evaluator; child ordering and
bounded member collection are named helpers, leaving graph-operation dispatch
separate from outline-specific snippets and pending-site projection.

The graph relation-expansion operation now has a dedicated evaluator as well;
edge construction, bounded traversal, relation projection, and optional path
materialisation are readable as one operation-specific policy without changing
selectors, direction defaults, depth limits, or result ordering.

The architecture guard itself now separates manifest indexing, workspace-package
validation, and declared-entry validation. This removes one complexity finding
from `scripts/check-architecture.mjs` while preserving validation order and all
existing error messages.

Source-import validation now delegates one import specifier to a pure helper;
relative-package resolution and workspace-dependency diagnostics remain
unchanged while the outer file scan has one less complexity and depth finding.

The v4 readiness status projection now delegates snapshot, source,
structural, and semantic field matrices to named helpers. Readiness fields,
reason codes, and generation metadata remain unchanged while the daemon
runtime loses one branch-heavy complexity finding.

The v3 readiness path now separates structural readiness/staleness decisions,
snapshot identity, and field-matrix projection from the storage read. The
v3/v4 branch remains explicit and the existing fallback and reason-code policy
is unchanged.

The public readiness payload now composes named source, syntax, structural,
semantic, and lexical detail projections. The serialized response remains
unchanged while the top-level payload builder no longer owns all nested field
and reason-code branching.

Operation availability now names the readiness predicate, blocked-reason
selection, and blocked-operation projection separately. This makes frontier
policy and retryability readable without changing the available/blocked lists
or their serialized fields.

Schema-definition validation now separates named-type validation and lifecycle
policy from the top-level schema checks. Required fields, duplicate names,
local references, and lifecycle errors retain their existing order and text.

Logical-type expression mapping now separates collection syntax and named
primitive mappings from enum and authoritative-model resolution. Unknown type
names still fail closed with the same error, while the central mapper has one
less complexity finding.

Canonical type-definition validation now delegates scalar, collection, union,
and schema-reference rules to named validators. Closed-field checks and error
semantics remain unchanged while the central dispatcher becomes a readable
policy map instead of one large switch.

Field validation now separates ordinary field definitions from
`SchemaBoundBytes` coordinate lookup and type checks. Coordinate ordering,
requiredness, and identifier/version constraints remain identical while the
field validator no longer combines both responsibilities.

Value validation now dispatches scalar, collection, record, union, and schema
reference handling through named helpers. Numeric bounds, recursive reference
cycle detection, and model-specific validation remain unchanged while the
central value validator no longer contains every type-specific branch.

Model-reference validation now isolates visible-source-state handling and the
generated authoritative-model path. Closed-field checks, special selector
models, and schema-bound coordinate validation remain explicit at their owning
helper.

Query-stage validation now names stage shape checks, input-reference checks,
and operator arity/recipe-only rules separately. Pipeline stage validation
still rejects forward references and invalid registered outputs with the same
diagnostics.

JSON Schema scalar projection now delegates the detailed BigInteger,
ExactDecimal, text, bytes, timestamp, and digest mappings to named helpers.
The canonical schema output remains unchanged, while the central scalar
dispatcher no longer hides all format-specific policy in one branch-heavy
function.

The Rust indexing worker entry point now has a module-level ownership note,
documenting the v3/v4 protocol boundary and keeping query/plugin policy clearly
outside the process loop.

Module-level responsibility notes were added to the canonical query port,
daemon runtime, and JavaScript/TypeScript analyzer so their boundaries and
ownership are visible before reading implementation details.

## Verification

- `pnpm check:maintainability` — passed.
- Maintainability gate unit suite — 6 tests passed, including generated/fixture exclusions and baseline synchronization.
- `pnpm check:architecture` — passed for 16 workspace packages.
- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- `pnpm --filter @urdira/engine build` — passed.
- Focused Vitest suite — 50 tests passed, including the new gate tests.
- `CI=true pnpm test` — 2,587 tests passed and 17 skipped across 168 files (2 test files skipped).
- Focused query-port suite after the second extraction — 74 tests passed.
- Focused daemon/runtime suite after the third extraction — 176 tests passed.
- Focused context/MCP/native query suite after the fourth extraction — 124 tests passed.
- Focused query projection suite after the fifth extraction — 113 tests passed.
- Focused comparison/query-port/native/pushdown suite after the sixth extraction — 203 tests passed.
- Re-ran `pnpm lint` and `pnpm check:architecture` after the sixth extraction — both passed.
- Focused pipeline/query suite after the stage-handle extraction — 179 tests passed.
- Focused source/query suite after the snippet extraction — 196 tests passed.
- The same source/query suite after stream-projection extraction — 196 tests passed.
- Runtime/readiness suites after availability extraction — 160 tests passed (one intentionally skipped).
- Runtime/readiness suites after status-lane extraction — 144 tests passed (one intentionally skipped).
- TypeScript plugin/analyzer suites after shared classification — 72 tests passed.
- Plugin/analyzer suites after bounded-path helper extraction — 67 tests passed.
- Project discovery/incremental suites after config helper extraction — 64 tests passed.
- Incremental/cache suites after semantic-hash helper extraction — 40 tests passed.
- Plugin/analyzer suites after virtual-project preparation extraction — 67 tests passed.
- Bounded syntax/plugin suites after declaration/import pass extraction — 64 tests passed.
- Runtime/readiness suites after v3-read helper extraction — 160 tests passed (one intentionally skipped).
- Runtime/readiness suites after v4 readiness-policy helper extraction — 144 tests passed (one intentionally skipped).
- Plugin/incremental suites after syntax-language helper extraction — 64 tests passed.
- Plugin/incremental suites after shared checker dependency-closure extraction — 64 tests passed.
- v4 scan/index-pack/mutation suites after scope/retry extraction — 16 tests passed (2 intentionally skipped).
- Contracts/schema suites after scalar schema conversion extraction — 74 tests passed.
- Canonical query-port suite after delta survivor extraction — 173 tests passed.
- Canonical query-port suite after symbol-selector extraction — 173 tests passed.
- Canonical/pushdown suites after graph-edge fallback extraction — 180 tests passed.
- Semantic coverage/provider/query-plan suites after coverage-helper extraction — 80 tests passed.
- Canonical/context/pipeline suites after outline, reference, and relation-expansion evaluator extractions — 231 tests passed.
- Contracts/schema suite after scalar JSON Schema helper extraction — 74 tests passed.
- Architecture guardrail suite after import-specifier extraction — 57 tests passed.
- Daemon v4/readiness suites after status-field extraction — 29 tests passed and 1 intentionally skipped.
- Daemon v4/readiness suites after v3 readiness extraction — 29 tests passed and 1 intentionally skipped.
- Daemon v4/readiness suites after readiness-detail projection extraction — 29 tests passed and 1 intentionally skipped.
- Web/readiness suites after operation-availability policy extraction — 47 tests passed.
- Contracts/schema suite after schema-definition validation extraction — 74 tests passed.
- Contracts/schema suite after logical-type mapping extraction — 74 tests passed.
- Contracts/schema suite after scalar/composite type-definition extraction — 74 tests passed.
- Contracts/schema suite after field/SchemaBoundBytes validation extraction — 74 tests passed.
- Contracts/schema suite after value-validation dispatch extraction — 74 tests passed.
- Contracts/schema suite after model-reference dispatch extraction — 74 tests passed.
- Contracts/schema suite after query-stage validation extraction — 74 tests passed.
- TypeScript plugin/analyzer suites after checker module-target extraction — 67 tests passed (one intentionally skipped).
- Current maintainability measurement is 366 complexity, 79 max-depth, and 217 oversized-function findings; the ratchet remains at 366/79/218 and the analyzer file baseline decreased by one.
- Contracts/schema suite after pipeline-operator and query-pipeline validation extraction — 74 tests passed.
- Current maintainability measurement is 365 complexity, 76 max-depth, and 216 oversized-function findings; schema validation remains behaviorally covered while the ratchet stays at 366/79/218.
- Contracts/schema suite after canonical type-family and union validation extraction — 74 tests passed.
- Current maintainability measurement is 364 complexity, 76 max-depth, and 216 oversized-function findings; the schema-ir file baseline now records eight complexity findings.
- Contracts/schema suite after public query-model validation extraction — 74 tests passed.
- Current maintainability measurement is 363 complexity, 76 max-depth, and 216 oversized-function findings; the schema-ir file baseline now records seven complexity findings.
- Contracts/schema suite after inline-operation constraint extraction — 74 tests passed.
- Current maintainability measurement is 360 complexity, 76 max-depth, and 216 oversized-function findings; the schema-ir file baseline now records four complexity findings.
- Semantic provider suites after local-neural option and segmentation extraction — 60 tests passed (one intentionally skipped).
- Current maintainability measurement is 358 complexity, 76 max-depth, and 215 oversized-function findings; both the contracts and embedding-local file baselines were ratcheted down without changing provider behavior.
- Semantic provider suites after line/token segmentation helper extraction — 60 tests passed (one intentionally skipped); the resolved `embedding-local` baseline entry was removed.
- Current maintainability measurement is 356 complexity, 76 max-depth, and 215 oversized-function findings.
- Daemon ownership/protocol suites after endpoint-descriptor decoding extraction — 40 tests passed (one intentionally skipped); the resolved ownership baseline entry was removed.
- Current maintainability measurement is 355 complexity, 76 max-depth, and 215 oversized-function findings.
- Daemon protocol/app-runtime suites after frame validation extraction — 35 tests passed.
- Current maintainability measurement is 354 complexity, 76 max-depth, and 215 oversized-function findings; protocol frame validation remains closed and deterministic.
- Daemon protocol/app-runtime suites after process-byte chunk field decoder extraction — 35 tests passed.
- Current maintainability measurement is 353 complexity, 76 max-depth, and 215 oversized-function findings; chunk wire-type validation and required-field checks remain unchanged.
- Daemon protocol/app-runtime suites after closed-value decoder extraction — 35 tests passed.
- Current maintainability measurement is 352 complexity, 76 max-depth, and 215 oversized-function findings; scalar, array, and object protobuf values now have separate decoding responsibilities.
- Daemon protocol/app-runtime suites after typed frame-variant reconstruction — 35 tests passed.
- Current maintainability measurement is 351 complexity, 76 max-depth, and 215 oversized-function findings; request, response, and progress reconstruction now have named validators.
- Daemon protocol/app-runtime suites after request admission and execution extraction — 35 tests passed; the resolved protocol baseline entry was removed.
- Current maintainability measurement is 350 complexity, 76 max-depth, and 215 oversized-function findings; cancellation, deadline, execution and wire-error policy now have named responsibilities.
- Daemon v4/app-runtime suites after workspace-engine resolution and sidecar-attachment extraction — 28 tests passed (2 intentionally skipped).
- Current maintainability measurement is 349 complexity, 76 max-depth, and 215 oversized-function findings; workspace lookup, cache reuse and sidecar policy are now named responsibilities.
- Daemon v4/index-pack/app-runtime suites after pending index-pack decision extraction — 28 tests passed (2 intentionally skipped); the scan remains behaviorally equivalent and its remaining complexity is explicitly tracked.
- Final maintainability, lint, architecture, typecheck, and diff checks passed with the baseline at 366 complexity, 79 max-depth, and 218 oversized-function findings.
- Final maintainability, lint, architecture, typecheck, and diff checks passed with the baseline at 373 complexity, 79 max-depth, and 218 oversized-function findings.
- Canonical/semantic suites after indexed-graph BFS extraction — 231 tests passed.
- Canonical query suite after literal-matching extraction — 173 tests passed.
- Canonical/recipe suites after comparison-role/stream extraction — 183 tests passed.
- Canonical/semantic suites after affected-page parser extraction — 197 tests passed.
- Canonical/context suites after graph-pushdown plan extraction — 212 tests passed.
- Canonical/context/pipeline suites after relation-closure extraction — 231 tests passed.
- Canonical/context/pipeline suites after outline-evaluator extraction — 231 tests passed.
- Canonical/context suites after reference-evaluator extraction — 212 tests passed.
- Daemon v4 scan finalization extraction — 28 tests passed (2 intentionally skipped); readiness publication, scan summaries, and maintenance submission now have named policy helpers.
- Current maintainability measurement is 348 complexity, 76 max-depth, and 215 oversized-function findings; `packages/daemon/src/runtime.ts` complexity baseline ratcheted from 7 to 6.
- Contract comparator validation now separates mode compatibility and path-segment resolution; the contracts suite remains at 74 passed tests.
- Current maintainability measurement is 346 complexity, 76 max-depth, and 215 oversized-function findings; `packages/contracts/src/schema-ir.ts` complexity baseline ratcheted from 3 to 1.
- Canonical timestamp validation now separates lexical parsing from calendar validation; canonical/digest suites passed 64 tests and the `scalars.ts` baseline entry was resolved and removed.
- Current maintainability measurement is 345 complexity, 76 max-depth, and 215 oversized-function findings.
- Canonical digest-schema logical type parsing now separates collection syntax from scalar mapping; canonical/digest characterization suites remain at 64 passed tests.
- The maintainability test now asserts ratchet monotonicity (no new or worsened findings) rather than requiring historical equality, so resolved debt can be removed from the baseline without weakening the gate.
- Full verification evidence after the ratchet-test fix: 168 test files passed, 2 skipped; 2,587 tests passed, 17 skipped; coverage 90.10% measured repository lines; critical branches and semantic regions 100%; typecheck, lint, architecture, maintainability, and publication hygiene passed.
- Storage CAS hash traversal, MCP query-admission formatting, stream-cursor rendering, and context-degradation detail assembly now have named helpers; the storage lifecycle suite passed 63 tests and MCP/CLI integration suites passed 67 tests.
- Current maintainability measurement after these extractions is 341 complexity, 76 max-depth, and 215 oversized-function findings; typecheck remains green.
- FactDelta record-payload and completeness validation now expose separate named responsibilities; FactDelta/planning/execution suites passed 69 tests and typecheck remains green.
- MCP query candidate/continuation resolution, bundle labels, and source-coordinate formatting now have named helpers; MCP/CLI/web suites passed 91 tests.
- Current maintainability measurement is 339 complexity, 76 max-depth, and 215 oversized-function findings.
- CLI shell parsing now separates safe-pipe scanning and sed range decoding; agent-integration and CLI suites passed 56 tests.
- Current maintainability measurement is 337 complexity, 76 max-depth, and 215 oversized-function findings.
- FactDelta dependency-source, base-record, staged-input, and completeness-status checks now use dedicated validators; FactDelta/planning suites passed 32 tests.
- Current maintainability measurement is 335 complexity, 76 max-depth, and 215 oversized-function findings.
- FactDelta dependency validation now separates source-reference parsing, membership checks, and closure checks so each policy is independently readable and testable; focused FactDelta suites remain green.
- Final focused gate for this iteration: 335 complexity, 76 max-depth, and 215 oversized-function findings; full lint and `git diff --check` pass.
- TypeScript `walkFiles` now delegates import/export, identifier, call, and heritage relation handling to named visitors; incremental/semantic/E2E suites passed 57 tests (1 skipped).
- Current maintainability measurement after the visitor extraction is 334 complexity, 74 max-depth, and 215 oversized-function findings.
- Analysis assembly now delegates coverage-relation derivation and dependency-closure construction to named pure helpers; incremental/semantic suites passed 54 tests.
- Current maintainability measurement is 333 complexity, 74 max-depth, and 215 oversized-function findings.
- Rust-authoritative semantic walking now delegates identifier, call-target, and heritage handling to dedicated visitors; incremental/semantic/E2E suites passed 57 tests (1 skipped).
- Current maintainability measurement is 332 complexity, 74 max-depth, and 215 oversized-function findings.
- Seeded analysis memo construction now separates grouping, direct-edge derivation, and per-path memo assembly; incremental/semantic suites passed 54 tests.
- Current maintainability measurement is 331 complexity, 74 max-depth, and 215 oversized-function findings.
- Full rebuild memo warm-up now delegates per-file hash and projection assembly to named helpers; incremental/semantic suites passed 54 tests.
- Current maintainability measurement is 330 complexity, 74 max-depth, and 215 oversized-function findings.
- Final ratchet measurement after the complete refactor is 313 complexity, 72 max-depth, and 213 oversized-function findings; `CI=true pnpm verify` passed all stages, including native builds/tests, lint, 2,587 Vitest tests (168 files), typecheck, coverage gate, and publication hygiene.
- Post-refactor bounded performance smoke: n8n local checkout, 64 owners and one mutation, structural-only, one worker, native release artifacts. Cold elapsed was 3,013.335 ms (readiness 1,368.658 ms); the mutation elapsed 741.599 ms (readiness 737.540 ms), with no lock errors reported. This is indicative only because the current local n8n checkout is not byte-identical to the historical benchmark corpus; it is not treated as an apples-to-apples performance claim.
- Response-budget shedding now delegates completeness shrinking, optional-payload trimming, and trailing-bundle removal to named deterministic helpers; MCP/web/CLI suites passed 47 tests, with typecheck and lint passing.
- Current maintainability measurement is 323 complexity, 74 max-depth, and 215 oversized-function findings.
- Benchmark discovery now isolates argument validation, status projection, and artifact-result formatting; MCP/web suites passed 35 tests and typecheck passed.
- Current maintainability measurement is 322 complexity, 74 max-depth, and 215 oversized-function findings.
- Invocation preparation now names snippet-line normalization, continuation detection, and payload resolution independently; MCP/web/CLI suites passed 47 tests and typecheck passed.
- Current maintainability measurement is 321 complexity, 74 max-depth, and 215 oversized-function findings.
- Top-level MCP invocation now delegates request-option creation, degradation handling, render-context construction, and page rendering; MCP/web/CLI suites passed 47 tests. The resolved MCP baseline entry was removed as required by the ratchet.
- Current maintainability measurement is 320 complexity, 74 max-depth, and 215 oversized-function findings; the maintainability gate and its six regression tests pass.
- Syntax-project import/export walking now lives in a named `collectSyntaxImports` phase, keeping project construction focused on entity collection; JavaScript/TypeScript plugin and incremental suites passed 64 tests.
- Current maintainability measurement remains 320 complexity, 74 max-depth, and 215 oversized-function findings.
- Architecture checks and full lint pass after the analyzer extraction; syntax import/export collection remains an isolated, behavior-preserving phase.
- Rust semantic window activation now isolates configurable window sizing and checker-project refresh, preserving cache invalidation and snapshot ownership; plugin/incremental suites passed 64 tests.
- Current maintainability measurement is 319 complexity, 74 max-depth, and 215 oversized-function findings.
- Session `analyze` now delegates input normalization, Rust-scope validation, and changed-path derivation to named helpers; plugin/incremental suites passed 64 tests.
- Current maintainability measurement is 318 complexity, 74 max-depth, and 215 oversized-function findings.
- Rust semantic-state preparation now isolates root/compiler-option normalization and scope validation; incremental and semantic transport suites passed 27 tests.
- Current maintainability measurement remains 318 complexity, 74 max-depth, and 215 oversized-function findings; the state method dropped from 127 to 120 lines.
- Incremental phase-2 dependent selection is now a named pure helper, preserving Rust affected-path precedence and TypeScript closure-based impact selection; incremental suite passed 20 tests.
- Current maintainability measurement is 318 complexity, 76 max-depth, and 215 oversized-function findings.
- Rust semantic declaration entities now isolate parent lookup and identity-span selection, making cache/ownership behavior explicit; plugin and incremental suites passed 64 tests.
- Current maintainability measurement is 317 complexity, 76 max-depth, and 215 oversized-function findings.
- Rust declaration resolution (alias handling, declaration cache, and stable project binding) is now an explicit reusable helper; plugin/incremental suites passed 64 tests and typecheck passed.
- Alias normalization and declaration-cache lookup are now separate helpers, reducing nested decision logic while preserving checker behavior; plugin/incremental suites passed 64 tests.
- Current maintainability measurement is 316 complexity, 76 max-depth, and 215 oversized-function findings.
- Virtual-file reconciliation is now an explicit state transition returning created, changed, deleted, and root-membership sets; incremental/semantic transport suites passed 27 tests.
- Current maintainability measurement is 316 complexity, 76 max-depth, and 215 oversized-function findings.
- Group semantic diagnostics are now collected by a dedicated bounded helper, preserving per-owner caching across windows; incremental/semantic transport suites passed 27 tests.
- Current maintainability measurement remains 316 complexity, 76 max-depth, and 215 oversized-function findings; group preparation complexity fell from 41 to 33.
- Owner-node collection now isolates the localized Rust pending-site path from the legacy AST fallback and returns explicit counters; plugin/incremental/semantic suites passed 71 tests.
- `beginRustSemanticOwnerGroup` dropped from 202 to 130 lines while preserving node order and checker batches; current maintainability measurement remains 316 complexity, 76 max-depth, and 215 oversized-function findings.
- Per-owner compiler diagnostics in `walkRustSemanticOwner` now use a dedicated helper for cached versus checker-derived diagnostics; plugin/semantic suites passed 51 tests and walk complexity fell from 40 to 36.
- Incremental API/file-map and snapshot preparation now live in `openIncrementalSnapshot`, keeping build-phase decisions separate; incremental suite passed 20 tests and `buildIncremental` dropped to 158 lines / complexity 48.
- Incremental output merging and memo rebuilding now use dedicated helpers, preserving fresh hashes and phase precedence; incremental suite passed 20 tests.
- Current maintainability measurement is 316 complexity, 76 max-depth, and 214 oversized-function findings.
- Incremental session commit (memo/state assignment and result construction) is now isolated in `commitIncrementalAnalysis`; incremental suite passed 20 tests.
- `buildIncremental` dropped to 113 lines / complexity 22; current maintainability measurement remains 316 complexity, 76 max-depth, and 214 oversized-function findings.
- Checker symbol/type batch preparation now uses `prepareRustGroupLookups`, reducing group orchestration complexity while preserving empty-batch short-circuiting; plugin/incremental/semantic suites passed 71 tests.
- `beginRustSemanticOwnerGroup` is now complexity 19; current maintainability measurement remains 316 complexity, 75 max-depth, and 213 oversized-function findings.
- Prepared Rust snapshot reopening is now isolated in `refreshPreparedRustSnapshot`, preserving changed/created/deleted event semantics; incremental/semantic transport suites passed 27 tests.
- `prepareRustSemanticState` no longer exceeds the measured complexity/size thresholds; current maintainability measurement is 315 complexity, 75 max-depth, and 213 oversized-function findings.
- Prepared-node traversal now uses an explicit helper for full versus localized walks; plugin/semantic suites passed 51 tests and current complexity is 315.
- Incremental phase-2 map construction and walking now use `walkIncrementalPhase2`, preserving phase-1/memo precedence and deterministic file ordering; incremental suite passed 20 tests.
- `buildIncremental` no longer exceeds measured size/complexity thresholds; current maintainability measurement is 314 complexity, 72 max-depth, and 213 oversized-function findings.
- Module-target resolution in `walkFiles` now isolates checker-symbol and relative-extension fallback logic; plugin/incremental suites passed 64 tests and the walker dropped to 241 lines.
- Current maintainability measurement is 314 complexity, 72 max-depth, and 213 oversized-function findings.
- Group preconditions (prepared state, non-overlap, and bounded owner paths) are now named validations; incremental/semantic transport tests and typecheck pass.
- Current maintainability measurement is 313 complexity, 72 max-depth, and 213 oversized-function findings.
- Module initialization in `walkFiles` now isolates source/module entities and export discovery; plugin/incremental suites passed 64 tests.
- `walkFiles` dropped to 217 lines, while `beginRustSemanticOwnerGroup` and `buildIncremental` no longer exceed measured thresholds; current maintainability measurement is 313 complexity, 72 max-depth, and 213 oversized-function findings.
- The global maintainability ratchet now advances to the measured 313/72/213 thresholds; the gate and its six regression tests pass exactly at the new baseline.
- Exported-declaration lookup and empty-owner semantic gating now use an explicit owner-state helper; plugin/incremental suites passed 64 tests.
- `beginRustSemanticOwnerGroup` dropped to 112 lines / complexity 26; current maintainability measurement is 316 complexity, 75 max-depth, and 213 oversized-function findings.
- Per-owner entity bucketing is now isolated from semantic traversal; plugin/semantic suites passed 51 tests and maintainability remains at 316 complexity, 75 max-depth, and 213 oversized-function findings.
- Call-target resolution now separates direct declarations, contextual signatures, and expression fallback; plugin/incremental/semantic suites passed 71 tests.
- `walkRustSemanticOwner` dropped to 292 lines / complexity 34 while preserving call relations and unresolved-call diagnostics.
- Full lint, architecture checks, and diff validation pass after the semantic-window extraction; checker snapshot ownership remains explicit through the dedicated refresh helper.
- Source-reference rendering now isolates coordinate-key derivation and first-seen source emission; deduplication tests passed 11 tests.
- Current maintainability measurement is 322 complexity, 74 max-depth, and 215 oversized-function findings; remaining complexity is concentrated in the benchmark and top-level invocation orchestrators.
- Benchmark artifact discovery now separates workspace readiness classification and query-request construction; web suite passed 24 tests and typecheck passed.
- Current maintainability measurement is 323 complexity, 74 max-depth, and 215 oversized-function findings; the extracted readiness helper remains a documented follow-up because its compatibility predicates are intentionally explicit.
- Readiness predicates are now split into published-state and freshness checks, keeping benchmark discovery policy readable and type-safe; typecheck and diff checks pass.
- Current maintainability measurement is 322 complexity, 74 max-depth, and 215 oversized-function findings.
- MCP invocation preparation is now isolated from execution and presentation, making render, snippet, continuation, and operation selection explicit; MCP/web/CLI suites passed 47 tests and typecheck passed.
- Current maintainability measurement is 323 complexity, 74 max-depth, and 215 oversized-function findings.
- Index-status workspace rendering now separates workspace records, operational details, and orphan-data hints; typecheck, lint, diff checks, and web/workspace-control suites passed (65 tests).
- Current maintainability measurement is 329 complexity, 74 max-depth, and 215 oversized-function findings.
- Bundle descriptor normalization now separates primary/body/snippet extraction from presentation policy; MCP/web/deduplication suites passed 76 tests.
- Current maintainability measurement is 328 complexity, 74 max-depth, and 215 oversized-function findings.
- Bundle source-reference rendering now isolates redaction metadata handling; MCP/web/deduplication suites passed 35 tests in the focused rerun.
- Current maintainability measurement is 327 complexity, 74 max-depth, and 215 oversized-function findings.
- Coverage/freshness rendering now delegates dimension counts and list formatting to explicit helpers; MCP/canonical-query suites passed 208 tests.
- Current maintainability measurement is 326 complexity, 74 max-depth, and 215 oversized-function findings.
- Query-page rendering now separates header/truncation, stream state, and diagnostic-report rendering; MCP/canonical-query suites passed 208 tests.
- Current maintainability measurement is 325 complexity, 74 max-depth, and 215 oversized-function findings.
- Public result formatting now separates operation errors, JSON rendering, and text rendering; MCP/web/CLI suites passed 47 tests.
- Current maintainability measurement is 324 complexity, 74 max-depth, and 215 oversized-function findings.
- Incremental rebuild planning now names phase-one selection and semantic-impact gating as separate pure helpers; incremental/semantic suites passed 54 tests.
- Index-status rendering now separates v4 lane status, reconcile summaries, metadata refresh, and import summaries into named helpers; web/workspace-control suites passed 65 tests.
- Current maintainability measurement is 330 complexity, 74 max-depth, and 215 oversized-function findings.
