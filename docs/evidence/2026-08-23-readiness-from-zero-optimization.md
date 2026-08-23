# From-zero readiness optimization campaign

Date: 2026-08-23/24

## Scope

This evidence records the readiness-optimization campaign executed against the
frozen `microsoft/vscode` checkout (`038b9225c82c6b75172beda6081c64887692538c`,
17,675 artifacts, 12,944 analyzed owners), the limiting case of the expanded
TypeScript corpus. The goal was time-to-usable on a from-zero index: both the
first honestly-admitted query and full structural readiness. Every measurement
below is a single host-only sample (`expanded-agent-benchmark-runner.mjs
--host`, warm gate, `URDIRA_DEBUG_TIMING=1 URDIRA_STORAGE_DEBUG_TIMING=1`,
`URDIRA_SEMANTIC_INDEX=0`, analysis workers/pool/structural concurrency pinned
to 1 as in the campaign contract), Node v24.18.1, same hardware as the
2026-08-22 evidence.

## Headline results

| Milestone | 2026-08-22 baseline | Final (this campaign) |
|---|---:|---:|
| First admitted query (source frontier, honest `partial`) | ~469 s effective (frontier flapped; consumers waited for structural) | **19.5 s, flap-free** |
| Source catalog stage | 166.9–202.8 s | **67.2 s** |
| Stage-1 (syntax frontier) | 443–458 s | **266.9 s** (2 analysis shards) |
| Full structural readiness | 467–473 s | **278.6 s** (2 shards) / ~316 s (default 1 shard, derived) |

Peak daemon RSS during the 2-shard run: 4,835,552 KiB (~165 MiB under the
5,000,000 KiB campaign guard) — which is why multi-shard analysis ships
default-off (`URDIRA_ANALYSIS_LARGE_SHARDS` default 1, see below).

## What changed

1. **CAS shard layout flattened to one level** (`sha256/aa/rest`, 256 leaf
   directories; was `sha256/aa/bb/rest`, 65,536). A from-zero scan's
   per-fragment batch dirtied one unique leaf directory per blob, so the
   existing per-batch directory-fsync dedup coalesced nothing: 16,617
   directory fsyncs ≈ 227.7 s summed. After flattening: ≤256 per fragment,
   ~1.1 s total. Destructive-only migration per decision 22: a
   `cas/.layout` marker gates `DurableStorage.open`; pre-flattening roots are
   rejected with `core:index_contract_unsupported` and must reindex into a
   fresh v3 data root. Backup archives carry the marker; restore probes the
   legacy two-level path per object (digest-verified) so pre-flattening
   backups still restore.
2. **Per-blob file fsyncs deferred to a batched pass** (write → link →
   batched file fsyncs → batched directory fsyncs, all before
   `putMany`/`putStreamsMany` resolves). Interleaved per-blob
   fsync serialized one APFS journal transaction per file (~5.8 ms each ≈
   102 s); the batched pass measures ~0.2 ms per file. Probe:
   2,000×12 KB files, write+fsync interleaved 11,631 ms vs write-all then
   fsync-pass 847 ms. Caller-observable durability is unchanged: everything
   is durable before the call resolves, and the source catalog references
   nothing until its own SQLite commit.
3. **Read-only, write-free readiness polling**
   (`DurableStorage.openWorkspaceReadOnly`): the poll previously ran
   `initializeSchema`/`bindWorkspaceIdentity`/lease writes per poll, which hit
   SQLITE_BUSY behind the 75 s publish transaction; the swallowed error was
   reported as `source_ready: false` — the mid-scan "flap" recorded in the
   08-22/23 runs. WAL read-only connections never block behind the writer, so
   the flap is eliminated at the root (verified: zero flaps across the final
   runs; the readiness catch now logs rate-limited and serves last-known
   readiness only for transient non-`workspace_not_found` errors).
4. **Honest completeness during catalog**: while a scan is running and the
   structural snapshot has not caught up, source readiness reports
   `completeness: "partial"`, `freshness: "changes_pending"`,
   `build_state: "building"` (closed vocabulary, decision 19 updated). The
   source frontier admits queries from the first catalog fragment (~19 s on
   VS Code) with results labeled honestly.
5. **MCP graceful degradation**: a timed-out `urdira_context` structural wait
   during indexing now returns a compact plain-text notice naming the
   source/syntax-frontier operations usable immediately (find_artifacts,
   search_text, get_source; discover_definitions, find_records, get_outline
   once stage 1 lands) plus phase/stage/retry hints, instead of a bare
   timeout. Benchmark runner: non-warm phases release at the first stable
   source frontier; `BENCH_FRONTIER` now records `source_completeness`. The
   warm gate is unchanged for campaign comparability.
6. **Seal/publish overlap and memo**: record templates for from-zero scans are
   built incrementally during the acceptance loop
   (`CandidateRecordTemplateAccumulator`; byte-identical output to one-shot
   `seal()`, enforced by tests that feed deltas out of order), and the
   record-open id/digest memo seal computes is carried into publication so
   `memoizeRecordOpens` no longer re-parses (27.5 s → 0; publication's
   independent digest verification per decision 13 is untouched and still
   catches corrupted templates). `publish_plan_build` 33.1 s → ~6-7 s. seal
   69.6 s → ~45 s.
7. **Budgeted multi-shard bounded-syntax analysis** for large workspaces
   (`URDIRA_ANALYSIS_LARGE_SHARDS`, clamp [1,4], default 1 = prior behavior):
   owners stream through K workers via a shared cursor with a plan-index
   reorder buffer, so acceptance order — and every digest — is byte-identical
   to serial (tested 1 vs 2 shards). Applies only when bounded-syntax is
   active (no type checker; the OOM-era single-checker rationale does not
   apply). RSS budget (`URDIRA_ANALYSIS_RSS_BUDGET_KIB`, default 4,300,000)
   is checked before admitting extra shards and every 64 owners; over-budget
   demotes shards gracefully, never fails the scan. Measured: plugin_analyze
   60.2 s → 45.4 s with 2 shards, zero demotions, even 6472/6472 split.
   Default stays 1 until the seal/publish-window RSS peak (which is
   shard-independent but leaves only ~165 MiB margin at 2 shards) is reduced.
8. **`run_batch` SQL transport command**: adjacent same-SQL `run` commands in
   the streaming publication lane coalesce into one prepared-statement batch
   (≤2,048 rows, flat params). Measured effect small (~3 s): the large row
   emitters already used windowed multi-row inserts, and the remaining
   transaction cost is elsewhere (below).
9. **Instrumentation** now fully attributes the pipeline: engine buckets
   (`source_provider_read`, `source_batch_digest_verify`,
   `execute_non_analyze`, `accept_native_stage`, seal phase buckets,
   handoff/queue/frozen-base/pre-transaction/post-commit buckets) and
   in-worker SQLite accounting (`exec_ms`, `param_ms`, `result_ms`,
   `chunk_idle_ms`, `txn_wall_ms` on the existing batch_commit line), all
   gated on `URDIRA_STORAGE_DEBUG_TIMING=1`.

## Final attribution (run 6, 2 shards, stage-1 266.9 s)

| Bucket | ms | Notes |
|---|---:|---|
| enumerate | 8,178 | full read+hash walk |
| source_catalog | 67,243 | of which provider re-read ~40 s, batch digest verify ~8 s, CAS put+fsync ~10 s |
| plugin_analyze | 45,370 | closure 4.4 s + 2-shard owner stream |
| execute_non_analyze | ~23,700 | acceptance/staging/accumulator CPU interleaved in the loop |
| seal | 45,564 | seal_finish 2.4 s, validate 0.9 s, freeze 0.9 s, **seal_ordered_digests 42.8 s** |
| publish_plan_build | ~7,000 | memo active; snapshot digests ~6.5 s |
| publish_sql_transaction | 70,137 | native exec 28.5 s, worker chunk starvation 16.6 s, per-command dispatch ~25 s over 72,322 commands (~48k are per-row checkpoint/assert brackets) |

## Remaining levers (next session)

- `seal_ordered_digests` 42.8 s: the ordered-set descriptor digest canonically
  re-encodes every template. The definition is bit-frozen; the lever is an
  encode-once design (reuse canonical bytes already produced for per-record
  digests) or off-thread encoding with transferable buffers — needs a design
  that respects the decision-22 frozen-array memo and RSS headroom.
- `source_provider_read` ~40 s: every file is read+hashed in enumerate and
  read again for the CAS stream; a bounded byte hand-off between the two
  passes would remove the second read.
- SQL command count: ~48k of 72,322 commands are per-row
  checkpoint/assert brackets (`checkedPublicationCommand` tables); windowed
  bracketing like the big tables would cut both dispatch (~25 s) and the
  16.6 s chunk starvation. Fault-point granularity must be preserved
  deliberately.
- `execute_non_analyze` ~23.7 s and analysis sharding by default: both gated
  on reducing the publish-window RSS peak.

## Verification

- `pnpm verify` green after every phase; final: 91 files, 1,652/1,652 tests,
  coverage gate, lint, architecture, typecheck, publication hygiene all
  passing.
- Determinism gates: accumulator-vs-one-shot seal byte-equality (out-of-order
  feed), 1-shard-vs-2-shard published digest equality, memo-vs-recompute
  publication equality plus corrupted-template rejection, fsync-ordering
  hook-sequence tests, crashed-candidate-wedge regression, resumed-candidate
  re-seal.
- No analyzer semantic change: `JAVASCRIPT_TYPESCRIPT_VERSION` unchanged; all
  record/snapshot digests bit-identical (asserted by the tests above), so no
  fleet republish.
- Data-root compatibility: pre-existing v3 roots are rejected by the CAS
  layout marker and must reindex (destructive-only policy, decision 22).
- A fresh 8-cell campaign
  (`release/benchmarks/run-expanded-agent-benchmark.mjs`) has NOT yet been
  re-run after this campaign; the numbers above are single host-only samples
  and the committed campaign JSONs still describe the 08-22/23 build.
