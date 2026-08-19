# Performance, Reliability, and Evaluation

Status: **Approved**  
Last updated: 2026-08-19
Depends on: Query, indexing, storage, and JavaScript/TypeScript MVP specifications

## Decision objective

Define measurable success criteria for indexing speed, update latency, query quality, resource use, correctness, and agent outcomes.

## Existing constraints

- Urdira is intended to reduce agent turns and unnecessary repository reads.
- Modified files should become queryable immediately or near-immediately.
- Responses must report completeness and uncertainty.
- Queries and pagination must remain consistent under concurrent updates.

## Benchmark environment and repository tiers

Performance gates run on a published baseline machine with 8 physical CPU cores, 16 GiB RAM, local NVMe storage, and no GPU. Background indexing may use at most 6 cores and 8 GiB unless the tier permits less. Every report publishes operating system, filesystem, CPU, memory, SQLite/runtime builds, plugin and model-pack digests, cold/warm cache state, and corpus digest.

Source size counts included decoded source bytes and logical lines after policy exclusions. Cold-start reports must include durable timings and row/command counts for source enumeration, cataloging, resolver closure, analyzer execution, sealing, immutable validation, SQLite publication, and readiness. The initial tiers are:

| Tier | Included files | Logical source lines | Included source bytes |
|---|---:|---:|---:|
| S | up to 5,000 | up to 100,000 | up to 50 MiB |
| M | up to 50,000 | up to 1,000,000 | up to 500 MiB |
| L | up to 250,000 | up to 5,000,000 | up to 2.5 GiB |

The benchmark corpus contains synthetic worst-case graphs, the JavaScript/TypeScript compatibility corpus, public real projects frozen by commit and content digest, one mixed-language/prose repository, one monorepo, and mutation traces derived from real editing sessions. No result may be reported only on generated easy cases.

## Indexing targets

Source-first publication is measured independently from plugin analysis. On the
Excalidraw corpus, a clean first scan must reach a complete, equivalent source
catalog at or below 10 seconds P95. The full structural target below remains
the boundary for symbol and relationship queries; semantic indexing is never
allowed to delay either boundary.

Cold full indexing to a structurally queryable snapshot, excluding asynchronous embeddings, must meet:

| Tier | P50 | P95 |
|---|---:|---:|
| S | 20 s | 45 s |
| M | 3 min | 8 min |
| L | 20 min | 50 min |

The generic semantic materialization must reach complete coverage within an additional 2, 15, and 90 minutes at P95 for S, M, and L respectively on the CPU baseline. Structural publication is never delayed for embeddings. Scan telemetry records source-ready, TypeScript program/checker, candidate/seal, canonical encoding, SQLite plan/transaction, structural-ready, and semantic-ready timings separately.

For a one-file edit after watcher receipt, P95 time to a snapshot containing updated local syntax is 500 ms for S/M and 1 s for L. P95 time to complete cross-file structural invalidation and publication is 2 s for S, 5 s for M, and 15 s for L. New embeddings for the changed scope reach a projection-only generation within 5 s, 15 s, and 45 s respectively. Deletion must make obsolete structural and semantic results invisible in the same structural publication; no latency target permits stale visibility afterward.

A 1,000-file branch switch reaches one atomic structurally queryable snapshot within 20 seconds at P95 on the M corpus. Larger switches are reported by changed-file count and must scale sublinearly relative to a cold full index when content reuse applies.

## Query and pagination targets

Latency is measured from validated request to a ready first page, including complete execution materialization. Warm-cache P95 targets on tier M are:

| Query class | P95 |
|---|---:|
| exact symbol, definition, outline, or direct references | 200 ms |
| one-hop callers/callees/dependencies | 400 ms |
| structural traversal to depth 5 over up to 100,000 eligible edges | 1.5 s |
| exact literal or identifier search | 500 ms |
| safe regular expression over the complete indexed text scope | 3 s |
| exact semantic or hybrid top-100 | 3 s |
| ordinary change-impact or related-test recipe | 5 s |
| context-building recipe within default work budget | 8 s |

Tier S targets are half the M values; tier L targets are three times the M values. Queries exceeding declared exact work limits fail explicitly and are not counted as successful approximate responses.

Once an execution is ready, P95 continuation hydration is 100 ms for a 50-item or 32,000-character page and 250 ms for a page containing snippets, excluding storage faults. Forward-backward-forward replay must return byte-equivalent normalized page content.

## Resource budgets

On tier M, steady-state daemon resident memory is at most 4 GiB during indexing and 2 GiB while idle; tier L limits are 8 GiB and 3 GiB. A single ordinary query receives 1 GiB temporary memory and 30 seconds CPU by default; operation definitions may advertise a smaller class. Admission control prevents concurrent work from exceeding the installation memory ceiling.

Structural analysis admission is explicit: owner work is deterministically sharded across a bounded number of independent workers, and a worker lease is never shared by concurrent scans. The pool rejects duplicate or over-capacity leases before starting analysis. Progressive structural publication retains only source metadata between stages; each later stage renews a captured-byte lease and verifies the referenced CAS bytes and digest before analysis. A benchmark campaign must pass all six one-sample arm/phase smoke runs before the sixty-run campaign is admitted.

Excluding explicitly installed model packs and retained historical snapshots, current structural database plus source CAS overhead must not exceed 2.5 times included source bytes. Generic semantic documents, segments, vectors, and indexes must not exceed another 3 times included source bytes. Reports separate logical live data, historical retention, shared CAS, model assets, temporary staging, and query cache so deduplication cannot conceal growth.

The default query cache is capped as specified by storage. Temporary candidate and migration space is bounded to the larger of 2 GiB or 1.2 times the affected live workspace data; operations requiring more must fail admission before altering published state.

## Structural correctness evaluation

Gold fixtures label result membership, classification, evidence, and completeness—not only top-ranked items. Metrics are reported separately for supported complete scope, explicitly unsupported scope, confirmed results, and possible candidates.

Release gates on supported complete JavaScript/TypeScript fixtures are:

| Capability | Confirmed precision | Confirmed recall |
|---|---:|---:|
| declarations and exact references | at least 99.8% | at least 99.0% |
| module resolution/import/export | at least 99.8% | at least 99.0% |
| direct and compiler-resolved call targets | at least 99.5% | at least 97.0% |
| inheritance, implementation, and override | at least 99.5% | at least 98.0% |
| supported intraprocedural control flow | at least 99.5% | at least 98.0% |
| supported intraprocedural data flow | at least 99.0% | at least 95.0% |
| related-test relations from an activated supported enricher | at least 98.0% | at least 95.0% |

An unresolved or ambiguous observation represented honestly is not a false negative in confirmed recall when the capability contract forbids confirmation, but dropping the observation or claiming complete coverage is a failure. Every false confirmed edge is a precision failure. Incremental and cold full indexing of the same state must have identical visible set digests in 100% of conformance traces.

## Semantic and ranking evaluation

The semantic corpus contains natural-language, identifier, source-code, and mixed queries in English and Spanish, without using human language as a routing field. Judgments identify all relevant implementation, artifact, analogue, and test candidates with graded relevance. Lexical-only, semantic-only, and hybrid variants are reported separately.

The bundled generic profile must achieve at least 0.80 Recall@20 and 0.65 nDCG@10 across the complete corpus, at least 0.70 Recall@20 in every query class, and no more than a 10-point absolute gap between English and Spanish aggregate Recall@20. Hybrid retrieval must improve nDCG@10 by at least 5% relative to the better single lane or document why the frozen corpus has ceiling saturation.

Determinism is absolute: the same profile, executable binding, corpus, query, and plan must produce identical vector digests and complete ordered manifests in every repeated run on a supported build. Cross-build lanes are evaluated separately and are never expected to share vector bytes unless their implementation digests are identical.

Ranking profiles are accepted only when all protected query families meet their minimum Recall@20 and no family regresses more than 2 percentage points from the previous accepted profile without an explicit major-version review. Ranking explanation fields are not evaluated because they are intentionally absent from the agent surface.

## Agent-task evaluation

Agent evaluation uses frozen coding tasks requiring discovery, impact analysis,
test selection, implementation, or architectural placement. Every comparison
holds the agent/model, prompt, repository state, time budget, iteration
protocol, and output rubric constant.

The source-first regression campaign has `baseline`, `source-only`, and
`structural` arms in cold and warm phases. Acceptance requires ten successful
samples per arm and phase (60 total); failures remain in the audit manifest and
do not replace a sample. Structural timing records source-ready, each stage,
full structural-ready, first useful discovery, post-edit freshness, and total
elapsed time. Earlier three-sample/two-arm results remain pre-source-first
evidence and are never merged with this campaign.

A separate external-tool comparison may use baseline repository tools, one
named code-intelligence service, and Urdira under the same frozen task. The
committed Vite reports use this protocol for a localized implementation task
and a broad lifecycle-map task. They publish sample counts, failures, scope,
cost assumptions, warnings, cleanup, and raw-audit digests. These comparisons
are workload-specific supporting evidence; they do not replace the formal
source-first, reliability, stress, or P95 release gates.

Tasks are scored for correct target set, unsafe omissions, evidence-grounded plan, irrelevant context, repository-read tool calls, total agent turns, characters consumed, and wall time. Urdira release acceptance requires no reduction in task success, at least 35% fewer repository-intelligence calls, at least 25% fewer source characters returned, and at least 20% fewer turns on the median task versus the stronger baseline. Change-impact tasks must have zero missed gold `will_break` items in the release corpus when completeness is reported complete.

## Reliability and adversarial testing

Stress tests run at least 20 mutable workspaces, 50 concurrent query clients, continuous edits, branch switches, plugin activation candidates, semantic projection work, backups, and GC. Successful query pages must remain snapshot-consistent, and publication generations must stay gapless.

Crash injection covers every durable phase of CAS installation, SQLite transaction, current-pointer publication, migration swap, query-manifest readiness, lease release, model-pack installation, and GC. After restart, the system must expose either the complete prior state or complete new state, never a hybrid. Recovery to queryable last-known-good state must take under 10 seconds at P95 for S/M and under 30 seconds for L, excluding an intentionally required full provider reconciliation for freshness.

Corruption tests alter, remove, duplicate, and swap database pages, canonical payloads, CAS blobs, vector shards, registry definitions, manifests, and cursor segments. Detection must identify the affected component, prevent trusted use, preserve unaffected workspaces where isolation permits, and execute the documented repair order.

Watcher tests include dropped, duplicated, reordered, and overflow events on every supported backend. The periodic reconciliation must converge to the exact full-scan digest in every trace. Fuzzing targets JSON/MCP schemas, canonical CBOR, Schema IR, plugin output, safe regex, archive/bundle parsing, model manifests, and cursor tokens.

## Release acceptance

A release candidate passes only when:

- every correctness, determinism, crash, corruption, migration, and security invariant has zero failures;
- all minimum quality thresholds above pass on the frozen corpus;
- every P95 performance and resource ceiling passes in at least three independent runs;
- no P95 latency or peak-resource metric regresses more than 10% from the previous release without an approved benchmark-baseline revision;
- full/incremental equivalence and cursor replay are 100%; and
- benchmark inputs, runner version, raw measurements, environment, and report digest are published with the release.

Flaky runs are failures until their cause is identified; rerunning until success is not acceptance. A waived performance regression may ship only as an explicit known limitation, but correctness, evidence, completeness, snapshot isolation, and data-safety invariants cannot be waived.

## Completion criteria

Every major product claim maps to a repeatable benchmark or evaluation with an explicit threshold above.
