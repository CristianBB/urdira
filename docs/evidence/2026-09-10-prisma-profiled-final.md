# Final profiled Prisma structural pass

Date: 2026-09-10  
Status: one valid cold structural pass. No agent, MCP client, Urdira query, or retry was used.

## Contract and attestation

The pass used Prisma commit `0f37454eec96b193e8b20e8f569e453acd2af644` in a fresh detached checkout. The pre-workspace gate recorded a real checkout, `package.json`, 7,231 tracked files, and a 30-byte socket path:

| Check | Value |
| --- | --- |
| checkout | `<temporary-checkout>` |
| HEAD | `0f37454eec96b193e8b20e8f569e453acd2af644` |
| tracked files | 7,231 |
| socket | `<temporary-data-root>/daemon.sock` |
| semantic index/materialization | disabled |
| reconciliation sweep | 0 ms |

The plugin distribution was rebuilt with `pnpm --filter @urdira/plugin-javascript-typescript build`, and the indexing worker was rebuilt once with `cargo build --release --locked -p urdira-indexing-worker`. Before readiness was accepted, the raw host log emitted:

```text
[urdira-indexing-worker] v4 startup_attestation {"current_exe":"<release-worker>/urdira-indexing-worker","debug_timing_enabled":true,"pid":87965,"schema_version":1,"semantic_perf_enabled":true}
```

The recorded `current_exe` equals the expected worker realpath and `semantic_perf_enabled=true`. This is independently checked in `startup-attestation-audit.json`.

## Structural timings

Readiness reached `structural_completeness=complete`, `freshness_status=current`, and `workspace_status=ready`. The pass ended at this structural readiness boundary; semantic SQLite and sidecar bytes were zero.

| Stage | Timing | Counts and details |
| --- | ---: | --- |
| catalog | walk 0.621 s; apply 1.120 s | 7,203 observations; 7,203 added; 0 changed; 0 deleted |
| typeflow | full 0.066 s; index 0.150 s | 4,510 files |
| facts | 0.091 s | 4,510 files; 10 Rayon threads; 209,879 lane-1 records |
| resolve setup | 0.006 s | available clone and project-file borrow 0.000 s |
| ambient index | 0.000 s | rebuilt once |
| hybrid semantics | **42.224 s** | 4,510 affected paths and owners |
| materialize pass 1 | 0.376 s | 4,510 owners; 793,652 input records |
| materialize pass 2 | 0.347 s | 793,088 records; 8,008 dependencies; 119,036 subjects; 173,027 pending sites; 564 target-not-interned; 0 dropped candidates |
| publish | 2.121 s write base | 1.918 s to page cache; 2.105 s durable; 0.129 s graph metric Merkle; 674,048 graph entries |
| scan orchestrator | `run_cold_total=43.094 s` | materialize call 0.725 s; publish call 2.395 s; CAS join 0.000 s |
| readiness | queryable 48.496 s; completed durable 48.644 s; host gate 49.197 s | structural `current` |

The wrapper process wall time was 166.725 s because runtime shutdown remained active after readiness; that shutdown interval is retained in the raw process samples and is excluded from `run_cold_total`, queryable, and host readiness.

## Semantic performance telemetry

The worker emitted one schema-version-1 JSON record. Aggregate counters are instrumentation counters and overlap through nested resolution calls; their elapsed values must not be summed as wall time.

| Metric | Value |
| --- | ---: |
| affected paths / hybrid owners | 4,510 / 4,510 |
| site count | 1,014,192 |
| typeflow lookups | 359,077; 395,478,584 us |
| sibling conformance | 18,685; 369,946,570 us |
| member walks | 179,713; 309,061,439 us |
| import resolution | 45,208; 245,546 us |
| reexport resolution | 2,996; 10,361 us |
| heritage resolution | 982; 36 us |
| union walks | 70; 134,321 us |
| alias chasing | 7,585; 7,060 us |

The ten owners with the largest measured owner wall time were:

| Rank | Owner | Wall | Sites | Pending | Rows | Candidates |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | `packages/1-framework/3-tooling/language-server/test/server.test.ts` | 11.198 s | 5,684 | 2,149 | 3,964 | 0 |
| 2 | `packages/1-framework/2-authoring/psl-parser/test/syntax/ast.test.ts` | 10.209 s | 4,446 | 1,105 | 3,358 | 0 |
| 3 | `packages/2-sql/4-lanes/relational-core/test/contract-free/expr-select.test.ts` | 8.144 s | 1,582 | 537 | 1,056 | 0 |
| 4 | `packages/1-framework/2-authoring/psl-parser/src/parse.ts` | 7.810 s | 1,337 | 304 | 1,178 | 26 |
| 5 | `packages/2-sql/2-authoring/contract-ts/test/contract-builder.dsl.test.ts` | 5.864 s | 1,628 | 1,076 | 585 | 0 |
| 6 | `packages/2-mongo-family/5-query-builders/query-builder/test/builder.test-d.ts` | 5.857 s | 1,166 | 450 | 813 | 21 |
| 7 | `packages/1-framework/2-authoring/psl-parser/test/parse-document.test.ts` | 5.741 s | 2,487 | 1,179 | 1,382 | 0 |
| 8 | `packages/2-sql/4-lanes/relational-core/test/contract-free/table.test.ts` | 5.136 s | 1,210 | 573 | 648 | 0 |
| 9 | `packages/1-framework/2-authoring/psl-parser/test/symbol-table.test.ts` | 5.120 s | 1,545 | 793 | 811 | 0 |
| 10 | `packages/2-sql/4-lanes/relational-core/src/ast/types.ts` | 4.041 s | 4,656 | 2,351 | 3,570 | 408 |

These values identify measured owners and counters; they do not prove causal dominance of a particular function.

## Resources and storage

The internal 500 ms process-tree sampler recorded 97 samples through readiness, peak RSS **4,682,208 KiB**, maximum aggregate CPU **937.2%**, and mean aggregate CPU **799.4%**. Across the 166.725 s wrapper lifetime it recorded 331 samples, peak RSS 4,682,208 KiB, maximum CPU 937.2%, mean CPU 246.7%, and at most two processes.

Storage was 2,920,448 bytes catalog SQLite, 166,277,120 bytes lexical SQLite, 793,382,671 bytes structural store, 45,391,284 bytes CAS, 0 semantic SQLite, 0 Rust sidecar, and 1,044,464,308 bytes total.

## Comparison with the valid unprofiled pass

The valid unprofiled pass used the same Prisma commit and structural-only contract. Percentages are `(profiled - unprofiled) / unprofiled`. The comparison is an observed run-to-run delta, not a pure profiler overhead estimate, because the worker was rebuilt and the profiled diagnostic enabled owner telemetry.

| Endpoint | Unprofiled | Final profiled | Delta |
| --- | ---: | ---: | ---: |
| `run_cold_total` | 45,066 ms | 43,094 ms | -1,972 ms / **-4.38%** |
| queryable | 49,182 ms | 48,496 ms | -686 ms / **-1.39%** |
| host structural readiness | 51,141 ms | 49,197 ms | -1,944 ms / **-3.80%** |
| hybrid semantics | 44,203 ms | 42,224 ms | -1,979 ms / **-4.48%** |

## Provenance and raw evidence

Raw evidence is preserved in the benchmark archive under
`luna-profiled-prisma-final-20260910T213000+0200/evidence`.

Relevant artifact hashes:

| Artifact | SHA-256 |
| --- | --- |
| `preflight-before-build.json` | `6519ddf73e21c10dc59f75fd3d7907ff2456ecb7303891ccbca06984126ffb5c` |
| `preflight-after-build.json` | `66ade6fd234776fbf8ed26acbc69ef7c43440a75d61c81359c6962f9a672067c` |
| `final-profiled-checkout-gate.json` | `dbf5e01576a7eaccc4702cee0dfcbc19885aa1bafb2c3cedaad052833b5a0dfc` |
| `startup-attestation-audit.json` | `1fdcc6e4f5fbec365d0b11051c0953ef4d425804b0ac9e68c424d773c40d8f5a` |
| `urdira-prisma-final-profiled.host.log` | `e56edb622ecc83f4e67d4272c6a8507927df5899b7278bc62a3f64c684490c20` |
| `urdira-prisma-final-profiled.result.json` | `665cf403c884da2294994a490f4cb23d0b0b16f086a0e1028d540286bbdd06cc` |
| `run-final-profiled-pass.mjs` | `9d695da5cfc28823bd308b53702f16b83781f8d142d5689b1a238e76312b24dd` |

The detached checkout and data root were removed after all evidence was written. `git diff --check` passed.
