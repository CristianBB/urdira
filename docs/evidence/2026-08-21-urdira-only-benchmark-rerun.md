# Urdira-only expanded benchmark rerun

Date: 2026-08-21

This evidence records the Urdira arm rerun of the expanded benchmark. The
baseline, codebase-memory, and CodeGraph rows in the derived report are the
previous audited comparison rows; they were not re-executed in this run.

## Protocol

- Node `v24.19.0` (bundled runtime), model `gpt-5.6-luna`, semantic indexing disabled.
- Frozen corpus: `release/benchmarks/expanded-typescript-agent-benchmark.json`.
- Requested scope: eight Urdira cells (two tasks each for TypeScript,
  Playwright, Prisma, and VS Code), one sequential sample per cell.
- The runner executed all eight cells sequentially. Five completed successfully,
  one completed with an agent/grader failure, and two VS Code cells were stopped
  at a measured memory guard before they could reach readiness. The audit is
  intentionally non-passing and retains all eight observations.
- Every host log and manifest remains under
  `/tmp/urdira-expanded-urdira-v12-20260821/`.

## Result

The Urdira-only audit contains all eight requested cells. Five passed the
behavioral grader (TypeScript/transpile, both Playwright tasks, and both Prisma
tasks). The TypeScript/session task failed its grader because the required
patterns were absent; its host reached readiness. Both VS Code tasks were
stopped deliberately after the same 12,944-owner structural analysis exceeded
the safe memory budget. These are distinct agent, resource, and infrastructure
outcomes, not collapsed into a single benchmark failure.

The primary audit is
`/tmp/urdira-expanded-urdira-v12-20260821/audit.json`; per-cell manifests and
host logs are in its `runs/` directory. The existing cross-arm result files were
not overwritten because this run intentionally executed only the Urdira arm.

## Indexing and readiness measurements

The benchmark host now emits `BENCH_FRONTIER` transitions and includes the
elapsed time in `BENCH_HOST_READY`. The renderer also reconstructs frontier
events from a failed host log, so readiness evidence is retained even when a
manifest has no final host metrics.

Observed v12 evidence (times are milliseconds from host start; RSS is the
monitor's peak resident set):

| Cell | Source ready | Structural stage 1 / host ready | Peak RSS | SQLite + CAS | Outcome |
|---|---:|---:|---:|---:|---|
| TypeScript / transpile diagnostic | 2.5 s | 2.5 s (equivalent snapshot) | 3.55 GiB | 1.66 GiB + 35.4 MiB | grader passed |
| TypeScript / session project event | 2.5 s | 2.5 s (equivalent snapshot) | 3.66 GiB | 1.71 GiB + 35.9 MiB | grader failed; FSEvents drops |
| Playwright / affected tests | 7.6 s | 235.4 s | 4.08 GiB | 1.62 GiB + 27.8 MiB | grader passed |
| Playwright / reporter isolation | 7.6 s | 229.9 s | 4.12 GiB | 1.69 GiB + 27.8 MiB | grader passed |
| Prisma / wire-name validation | 84.4 s | 334.2 s | 4.63 GiB | 1.95 GiB + 43.3 MiB | grader passed; one retryable `source_changed` |
| Prisma / Mongo value-set transform | 84.5 s | 336.4 s | 4.65 GiB | 1.95 GiB + 43.3 MiB | grader passed |
| VS Code / registry notification | 56.1 s | not reached; 4,300/12,944 owners when stopped | observed 4.91 GiB | incomplete | stopped before OOM guard |
| VS Code / provider idempotence | 55.5 s | not reached; 4,200/12,944 owners when stopped | observed 4.34 GiB | incomplete | stopped before OOM guard |

The full historical index timings and storage measurements remain in the
2026-08-21 performance evidence under `/tmp/urdira-expanded-benchmark/`. This
rerun adds measured readiness, peak RSS, SQLite/CAS sizes, and the VS Code
resource boundary; it is not a new P95 claim because each cell has one sample.

The benchmark runner readiness parser was corrected from a literal backslash-n
split to an actual newline split in
`release/benchmarks/expanded-agent-benchmark-runner.mjs`; subsequent manifests
contain the three readiness events. The first two manifests predate that fix,
so their readiness was reconstructed from the host scan timings for this table.

## Root cause and remediation

The failing path was the JavaScript/TypeScript worker's
`jsts:structural_stage_1` branch. It called `JsTsAnalysisSession.analyze`,
whose first invocation builds a TypeScript `Program` and `Checker`, walks every
source file, and retains the semantic graph. The bounded large-corpus
`analyzeSyntaxProject` path therefore could not protect production readiness:
its callers were tests only. A one-worker reproduction with 512 files produced
typed facts through the old stage-1 route, confirming the checker path rather
than SQLite, digests, or MCP as the memory source.

The fix makes stage 1 syntax-only, bumps its durable cache format to `3`,
reuses one compatible syntax result across narrowed owner closures, releases it
before checker-backed stages, and bounds the source hash memo to 512 entries or
16 MiB. The regression suite includes the 512-file reproduction and asserts
that stage 1 emits no typed facts. Targeted verification after the change:

```text
3 test files passed; 50 tests passed
pnpm lint                 passed
pnpm typecheck            passed
```

A controlled TypeScript host smoke after the fix reached the stage-1 publish
boundary without a JavaScript heap fatal error: source-ready was emitted at
10.6 s, the two syntax shards completed at 19.1 s, and stage-1 analysis was
reported complete at roughly 193 s. The host was then stopped deliberately
before the full benchmark session. Its RSS still peaked around 4.7 GiB while
SQLite materialized the 137,670 visible records, so this is now a separate
publication/materialization budget to address; it is not the former retained
TypeScript checker. The worker-side native batch projection was changed in the
same fix to construct only bounded row windows, eliminating the previous
workspace-sized duplicate arrays during that hand-off.

The follow-up publication fix preserves the same immutable transaction
protocol while removing the remaining workspace-sized command retention. For
deltas at or above 2,048 record/projection opens, canonical and projection
writes are lazy generators consumed by `transactionChunked`; record identity,
closure, projection, and relational-value commands are produced in phase
order as the transaction advances. The existing materialized path remains for
small publications and compatibility callers. The relational value writer
remains hard-capped at 1,024 rows, 13,312 parameters, or 4 MiB per INSERT.

Verification for this follow-up:

```text
pnpm --filter @urdira/storage build                          passed
pnpm lint                                                    passed
pnpm typecheck                                               passed
pnpm check:architecture                                      passed
NODE_OPTIONS=--no-warnings pnpm exec vitest run              89 files / 1,587 tests passed
```

The large-publication regression creates 2,050 record opens and confirms that
the plan keeps an empty materialized canonical phase, exposes a stream, and
emits all 2,050 occurrence writes. A separate 200,000-value synthetic writer
run produced 1,368 bounded INSERT commands with RSS 141 MiB and heap 26 MiB.
The external corpus campaign was rerun for the Urdira arm in v12, but one
sample per cell is insufficient to establish new P95 readiness numbers. The
benchmark host still requires Node `>=24.18.1`; future P95 work must repeat the
same sequential protocol with the resource guard and retain all failures.

The repository verification gate also passed under the available Node
`v24.14.0` runtime: `pnpm verify` completed architecture, lint, coverage,
typecheck, coverage-gate, and publication-hygiene checks. The engine warning is
retained because the benchmark campaign itself requires Node `>=24.18.1`.

## Verification

The runner and renderer pass syntax and diff checks after the telemetry change:

```text
node --check release/benchmarks/expanded-agent-benchmark-runner.mjs
node --check release/benchmarks/render-expanded-agent-report.mjs
git diff --check -- release/benchmarks/expanded-agent-benchmark-runner.mjs release/benchmarks/render-expanded-agent-report.mjs
```

## v13 post-optimization campaign

The post-change campaign was rerun on 2026-08-21 with Node `v24.18.1`, model
`gpt-5.6-luna`, semantic indexing disabled, and output under
`/tmp/urdira-expanded-urdira-v13-20260821/`. All eight cells were executed
sequentially. Five passed, the TypeScript/session cell failed its grader, and
the two VS Code cells were stopped before readiness to avoid an OOM.

| Cell | Source ready | Readiness | Peak RSS | SQLite + CAS | Outcome |
|---|---:|---:|---:|---:|---|
| TypeScript / transpile diagnostic | 10.0 s | 212.7 s | 4.46 GiB | 1.84 GB + 35.4 MiB | grader passed |
| TypeScript / session project event | 2.6 s | 202.8 s | 3.62 GiB | 1.92 GB + 35.8 MiB | grader failed |
| Playwright / affected tests | 7.6 s | 235.5 s | 4.16 GiB | 1.81 GB + 27.8 MiB | grader passed |
| Playwright / reporter isolation | 7.5 s | 231.2 s | 4.17 GiB | 1.71 GB + 27.8 MiB | grader passed |
| Prisma / wire-name validation | 84.8 s | 340.8 s | 4.74 GiB | 2.09 GB + 43.3 MiB | grader passed |
| Prisma / Mongo value-set transform | 26.6 s | 336.8 s | 4.64 GiB | 2.13 GB + 43.3 MiB | grader passed |
| VS Code / registry notification | 55.9 s | not reached; 4,300/12,944 owners | 5.09 GiB | incomplete | stopped before OOM |
| VS Code / provider idempotence | 56.7 s | not reached; 4,100/12,944 owners | 4.68 GiB | incomplete | stopped before OOM |

The updated four-arm derived report is
`release/benchmarks/expanded-typescript-agent-benchmark-results-2026-08-21.json`.
Its baseline, codebase-memory, and CodeGraph rows are reused from the previous
audited campaign; only the eight Urdira rows were replaced by v13 observations.
The campaign is intentionally non-passing (24/32 overall comparison rows,
5/8 fresh Urdira rows). This is a readiness/memory measurement, not a new P95
claim: the two VS Code cells still cannot reach the source-first structural
boundary within the safe RSS budget.

## v14 lexical-trigrams removal campaign

After removing the redundant lexical-trigram projection, the Urdira-only
campaign was rerun sequentially on 2026-08-21 with Node `v24.18.1`, model
`gpt-5.6-luna`, semantic indexing disabled, and the benchmark RSS guard set to
5,000,000 KiB. Raw audit: `/tmp/urdira-expanded-urdira-v14-20260821/audit.json`.
The historical baseline, Codebase Memory, and CodeGraph rows were retained;
the regenerated report contains the new Urdira observations in
`release/benchmarks/expanded-typescript-agent-benchmark-results-2026-08-21.json`.

| Cell | Source ready | Readiness | Peak RSS | SQLite + CAS | Outcome |
|---|---:|---:|---:|---:|---|
| TypeScript / transpile diagnostic | 10.5 s | 224.5 s | 4.35 GiB | 1.06 GB + 35.4 MiB | grader passed |
| TypeScript / session project event | 10.8 s | 223.1 s | 4.29 GiB | 1.06 GB + 35.8 MiB | grader failed |
| Playwright / affected tests | 31.6 s | 258.3 s | 4.11 GiB | 1.25 GB + 27.8 MiB | grader passed |
| Playwright / reporter isolation | 30.0 s | 248.1 s | 4.17 GiB | 1.26 GB + 27.8 MiB | grader passed |
| Prisma / wire-name validation | 51.1 s | 362.3 s | 4.80 GiB | 2.09 GB + 43.3 MiB | grader passed; guard observed after readiness |
| Prisma / Mongo value-set transform | 49.7 s | 332.8 s | 4.73 GiB | 2.09 GB + 43.3 MiB | grader passed |
| VS Code / registry notification | 57.5 s | not reached | 4.85 GiB | 139 MB + 212 MiB | stopped by RSS guard before readiness |
| VS Code / provider idempotence | 56.3 s | not reached | 4.83 GiB | 2.30 GB + 212 MiB | stopped by RSS guard before readiness |

The fresh Urdira arm therefore completed 5/8 cells. The three non-passing
cells are preserved in the audit rather than replaced: one is a grader failure
and two are controlled memory-guard stops. The earlier disk-full failure was
infrastructure caused by retained temporary benchmark roots; those generated
roots were removed after inventory, and the rerun completed with sufficient
free space. Removing `lexical_trigrams` did not eliminate the remaining RSS
hotspots in Prisma and VS Code, which are now isolated to analysis/publication
retention and require the next memory-focused change.

## v15 FactDelta memory-boundary campaign

The worker/host memory change was then benchmarked sequentially with the same
Node `v24.18.1`, model, semantic-index setting, and 5,000,000 KiB RSS guard.
Raw audit: `/tmp/urdira-expanded-urdira-v15-20260821/audit.json`. The merged
release report was regenerated from this audit and the historical comparison
arms. In production mode the worker sends one raw `FactDelta`; the host derives
one bounded native batch at a time, persists it, and retains a compact accepted
delta for sealing.

| Cell | Source ready | Readiness | Peak RSS | SQLite + CAS | Outcome |
|---|---:|---:|---:|---:|---|
| TypeScript / transpile diagnostic | 10.2 s | 213.9 s | 4.29 GiB | 1.06 GB + 35.4 MiB | grader passed |
| TypeScript / session project event | 10.2 s | 202.9 s | 3.48 GiB | 1.06 GB + 35.9 MiB | grader failed |
| Playwright / affected tests | 31.4 s | 234.6 s | 4.11 GiB | 1.25 GB + 27.8 MiB | grader passed |
| Playwright / reporter isolation | 29.8 s | 229.2 s | 4.75 GiB | 1.25 GB + 27.8 MiB | grader passed |
| Prisma / wire-name validation | 51.1 s | 336.9 s | 4.85 GiB | 2.09 GB + 43.3 MiB | grader passed; guard after readiness |
| Prisma / Mongo value-set transform | 51.0 s | 336.6 s | 4.58 GiB | 2.09 GB + 43.3 MiB | grader passed |
| VS Code / registry notification | 56.2 s | not reached | 5.14 GiB | 1.50 GB + 212 MiB | RSS guard at 4,100/12,944 owners |
| VS Code / provider idempotence | 56.7 s | not reached | 4.81 GiB | 139 MB + 212 MiB | RSS guard before readiness |

The Urdira arm remains 5/8 successful: one grader failure and two controlled
RSS stops are preserved. TypeScript readiness improved by about 5–9%, and its
RSS fell by roughly 0.1–1.0 GiB. Playwright readiness improved by about 7–8%.
Prisma readiness improved for the first task but its high publication peak
remains. VS Code still fails before readiness, proving that its dominant peak
is in corpus/plan construction and large-project analyzer state rather than
the FactDelta batch response. The next targeted change should therefore stream
owner plans and input files instead of materialising the entire VS Code owner
set; the current change is retained as a prerequisite because it keeps the
downstream publication path bounded.

## v16 large-workspace owner-plan streaming campaign

The next memory change streams owner plans for large workspaces instead of
materialising the complete `plans` and `shards` arrays. The threshold is 4,096
source artifacts or 128 MiB of source bytes. The campaign uses Node `v24.18.1`,
the same model and semantic-index setting as v15, and the 5,000,000 KiB RSS
guard. Raw audit: `/tmp/urdira-expanded-urdira-v16-20260822/audit.json`.
The merged report was regenerated from this audit and the historical arms in
`release/benchmarks/expanded-typescript-agent-benchmark-results-2026-08-21.json`.

| Cell | Source ready | Readiness | Peak RSS | Outcome |
|---|---:|---:|---:|---|
| TypeScript / transpile diagnostic | 10.4 s | 215.5 s | 4.47 GiB | grader passed |
| TypeScript / session project event | 9.8 s | 199.7 s | 3.47 GiB | grader failed |
| Playwright / affected tests | 31.4 s | 235.9 s | 4.11 GiB | grader passed |
| Playwright / reporter isolation | 29.5 s | 234.5 s | 4.12 GiB | grader passed |
| Prisma / wire-name validation | 51.0 s | 333.5 s | 4.68 GiB | grader passed |
| Prisma / Mongo value-set transform | 50.9 s | 334.7 s | 4.56 GiB | grader passed |
| VS Code / registry notification | 56.1 s | not reached | 4.77 GiB | RSS guard at 4,300/12,944 owners |
| VS Code / provider idempotence | 56.4 s | not reached | 4.77 GiB | RSS guard at 4,300/12,944 owners |

The Urdira arm remains 5/8 successful. Compared with v15, Prisma readiness
improved by about 3–4 s and its peak RSS fell by roughly 0.17–0.18 GiB. The
large-workspace stream passed 4,300 VS Code owners before the same 5,000,000 KiB
guard, versus roughly 4,100 in v15, while preserving the guard and avoiding a
larger retained `plans`/`shards` graph. VS Code still does not reach readiness:
the remaining peak is in the TypeScript checker/analysis state and per-owner
accepted results, not in the materialised plan array alone. No failure was
removed from the audit.

## v17 publication-compaction experiment (rejected)

An incremental compactor was tested against the same benchmark with the v16
owner-plan stream. It was reverted after five completed cells because it
increased the hot publication path: Prisma wire-name validation measured
`publish=258.0 s` and readiness `344.8 s`, versus approximately `247.6 s` and
`331.7 s` in v16; Mongo value-set transform measured `publish=268.4 s` and
readiness `354.8 s`. RSS was slightly lower (4.61 GiB versus 4.68 GiB in the
wire-name cell), but the CPU/regex look-ahead overhead outweighed that benefit.
The experiment was stopped before VS Code and was not merged into the runtime.
The accepted implementation therefore keeps the bounded owner-plan stream,
while the next publication optimization must batch typed SQL writes at their
producer rather than inspect every streamed command generically.

## v18 producer-side occurrence batching (implementation)

The rejected generic compactor was replaced by explicit batching in the
publication producers. Large canonical and projection streams now accumulate
at most 512 fixed-width occurrence rows, emit one typed multi-row `INSERT`,
and immediately continue with the dependent value-node writer, facets, and
projection dependencies. The existing value writer remains independently
bounded at 1,024 rows/4 MiB. Foreign-key order, preflight conflict checks,
transaction checkpoints, row-change assertions, provenance, and all small
publication paths are unchanged; small paths still emit one occurrence per
command. No command-array post-processing or corpus-sized parameter vector is
introduced.

Phase 9 publication tests pass (99/99), including verify-integrity, warm
digest-corpus, failure-recovery, and the 2,050-record lazy-stream regression.
The latter now observes five bounded occurrence statements (512/512/512/512/2)
with the same 2,050 × 22 bound parameters, and a matching 2,050-projection
regression covers the projection path. A benchmark rerun is required to
quantify the publication/readiness effect; the v16 and v17 measurements above
remain the comparison baseline until that rerun completes.
