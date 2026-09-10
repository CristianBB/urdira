# Prisma structural indexing bottleneck diagnostic

Date: 2026-09-10  
Status: one valid cold structural pass, with two preceding invalid preflight attempts recorded separately. No Codex agent or Urdira query was run in the diagnostic.

## Protocol and validity

The valid pass used a fresh detached checkout of `prisma/prisma` at commit `0f37454eec96b193e8b20e8f569e453acd2af644`, a new short data root `/tmp/u2d/p2`, and the current release indexing worker. The gate immediately before workspace registration recorded:

| Check | Value |
| --- | --- |
| checkout realpath | `/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-09/luna-diagnostic-prisma-20260910T202506+0200/worktrees/prisma-v3` |
| checkout HEAD | `0f37454eec96b193e8b20e8f569e453acd2af644` |
| `package.json` | present |
| tracked files | 7,231 |
| daemon socket | `/tmp/u2d/p2/daemon.sock` (23 bytes) |
| semantic index | disabled |
| semantic materialization | disabled |
| semantic sidecar | 0 bytes |
| reconciliation sweep | 0 ms |

The host waited for the complete structural frontier to become `current`; this is a cold pass because the data root was empty at start. There was no agent session and no query traffic. The worktree and data root were removed only after all logs and result files had been written.

## Valid pass results

| Stage | Timing | Counts and details |
| --- | ---: | --- |
| catalog | walk 0.217 s; apply 1.104 s | 7,203 observations; 7,203 added; 0 changed; 0 deleted |
| typeflow | full declaration summaries 0.066 s; index 0.144 s | 4,510 files |
| facts | 0.095 s | 4,510 files; 10 Rayon threads; 209,879 lane-1 records |
| resolve setup | 0.005 s | resolver build; available clone and project-file borrow were 0.000 s each |
| hybrid semantics | **44.203 s** | 4,510 affected paths and 4,510 hybrid owners |
| materialize pass 1 | 0.366 s | 4,510 owners; 793,652 input records |
| materialize pass 2 | 0.322 s | 793,088 records; 8,008 dependencies; 119,036 subjects; 173,027 pending sites; 564 target-not-interned |
| publish | 2.035 s | write base 1.796 s; durable 1.783 s; graph metric Merkle 0.095 s; 674,048 graph entries |
| scan orchestrator | `run_cold_total=45.066 s` | materialize call 0.689 s; publish call 2.035 s; CAS join 0.000 s |
| readiness | queryable 49.182 s; completed durable 49.330 s; host gate 51.141 s | structural `current` |

The measured `hybrid_semantics` interval is 44.203/45.066 = **98.1%** of `run_cold_total`, 44.203/49.182 = **89.9%** of the interval through the queryable event, and 44.203/51.141 = **86.4%** of the interval through host structural readiness. These are timing shares of the recorded phases; they do not identify which internal static routine or child component caused the work.

Process-tree sampling through readiness recorded peak RSS of **4,776,272 KiB**, maximum aggregate CPU of **939.9%**, mean aggregate CPU of **776.6%**, and two processes. Storage at shutdown was 2,932,736 bytes catalog SQLite, 166,887,424 bytes lexical SQLite, 793,382,671 bytes structural store, 45,391,284 bytes CAS, 0 semantic SQLite, 0 Rust semantic sidecar, and 1,044,128,594 bytes total. CAS telemetry reported 47,045,518 bytes read and copied with zero transfer, decode, retention, hashing, or corpus rereads.

## Comparison with the two frozen historical Prisma rows

The valid diagnostic has no agent phase, so comparison is limited to structural setup endpoints. The historical rows are the frozen Urdira smoke rows for `wire-name-validation` and `mongo-value-set-transform`; their `setup_elapsed_ms` includes host startup and structural readiness. Percentages are `(valid - historical) / historical`.

| Endpoint | Valid diagnostic | Historical wire-name row | Delta | Historical mongo row | Delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| host structural setup/readiness | 51,141 ms | 51,876 ms | **-1.4%** | 53,313 ms | **-4.1%** |
| queryable structural frontier | 49,182 ms | 50,871 ms readiness | **-3.3%** | 52,870 ms readiness | **-7.0%** |

The endpoint labels matter: the current diagnostic reports both queryable and host readiness, while the frozen manifests expose their setup and structural-readiness values through the campaign renderer. These are directional comparisons between the same repository family and Urdira structural contract, not independent samples or a claim of task-normalized improvement. The historical agent wall times were 179,845 ms and 155,610 ms respectively; they are not comparable to this no-agent diagnostic.

## Static candidates for follow-up inspection

The timing identifies the hybrid-semantics phase as the place to inspect. It does not establish a causal ranking among its implementation pieces. Static candidates include:

* `crates/urdira-indexing-worker/src/v4/analyze.rs`: `run_cold` and its analysis/resolve orchestration;
* `crates/urdira-indexing-worker/src/main.rs`: `run_jsts_generation`, resolver setup, facts pipeline, and the hybrid-semantics generation path;
* `crates/urdira-jsts-syntax-worker/src/resolver.rs` and `semantic_sites.rs`: module/export resolution and semantic site production;
* the JavaScript/TypeScript plugin transport and checker boundary in `packages/plugin-javascript-typescript/src/`;
* source/CAS reads and resolver asset construction surrounding the 4,510-file closure.

These are inspection candidates only. The diagnostic has no per-function profile, no per-query latency, and no attribution that would justify naming one candidate as the dominant cause.

## Provenance and raw evidence

Repository and artifact preflight was captured in `preflight.json`. The release indexing worker was `sha256:7196d349de974e954f455c0272fa522e9a14c9a3130b189de5767a9f45cdca3b`; release/prebuild syntax worker was `sha256:65a029ff04d210404f8e7f013ede18021c7b4cc3c907f75bbd5b4cf206b73c7a`; release/prebuild native addon was `sha256:9e1e6e5c4bbde6eab856e0e444d17f283adcc9c75d836741fde267b9a0240722`; plugin distribution was `sha256:6fa58ea6994946ac2081d38fda222b1d76bc3085391e323a64de60cbe1224194`; app distribution was `sha256:eb50b3c7aef979b20d8c75ff6db969d40961866f503dd2299bdebf3d394d7b56`; daemon distribution was `sha256:d2c3bde7d496d67381f6a9384895c1525766e95c378f3e408274d0b380fff5e5`; MCP distribution was `sha256:c09916b6593b08a66a4bedc1b8b7b58e98b8cdf955d30b0e431188daf071a850`. The Urdira checkout was at HEAD `445bb51cecde46cef4424f6eb0197a6963df657a` with dirty diff hash `sha256:6609bc1697bed4b6ee059deb2609b77af45d671ffee36fb8d09985c3a5a983da`.

Raw evidence directory:

`/Users/Cristian/BenchmarkResults/urdira-expanded-2026-09-09/luna-diagnostic-prisma-20260910T202506+0200`

The valid files are `evidence/urdira-prisma-cold-v3.host.log`, `evidence/urdira-prisma-cold-v3.result.json`, and `evidence/v3-checkout-gate.json`. Their SHA-256 hashes are, respectively, `9a463900d92ea68b1826531cd9a76804e1ab37b3d15fe68cabbb1b392cdfdda5`, `9e0bdb05845144a5a8ef256fac767833447c7d5ec9d5c648cb50723c4111a26f`, and `93a9ab1b6ff5e73cb151d3e8f444a1177e58fb84bbae17b970458e8db2db0287`.

## Invalid attempts retained separately

1. `urdira-prisma-cold.host.log` / `urdira-prisma-cold.result.json`: daemon startup failed after approximately 467 ms with `listen EINVAL` because the long data-root path produced an invalid Unix socket path. No workspace or worker started.
2. `urdira-prisma-cold-v2.host.log` / `urdira-prisma-cold-v2.result.json`: the short-path run started the worker and reached readiness, but the worktree had been removed during cleanup of attempt 1. It indexed an empty/nonexistent path: 0 observations, 0 owners, and 0 records. Its timings and resource values are not Prisma measurements.

Neither invalid attempt is included in the valid table or in any benchmark aggregate. No execution followed the valid pass.

