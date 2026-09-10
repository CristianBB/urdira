# Prisma profiled structural pass

Date: 2026-09-10  
Status: one valid cold structural pass; no retry was made after workspace registration. No Codex agent, MCP client, or Urdira query was started.

## Protocol and validity

The pass used a fresh detached checkout of `prisma/prisma` at commit `0f37454eec96b193e8b20e8f569e453acd2af644` and a new short data root. The gate immediately before the host started was:

| Check | Value |
| --- | --- |
| checkout realpath | `<temporary-checkout>` |
| checkout HEAD | `0f37454eec96b193e8b20e8f569e453acd2af644` |
| `package.json` | present |
| tracked files | 7,231 |
| daemon socket | `<temporary-data-root>/daemon.sock` (30 bytes) |
| semantic index | disabled |
| semantic materialization | disabled |
| semantic sidecar | 0 bytes |
| reconciliation sweep | 0 ms |

The wrapper set `URDIRA_V4_DEBUG_SEMANTIC_PERF=1`, `URDIRA_DEBUG_TIMING=1`, and `URDIRA_STORAGE_DEBUG_TIMING=1`. It used one 500 ms internal process-tree sampler. `xctrace` was verified as available, but was not attached because this pass required the internal telemetry and an attached profiler could block or perturb the single authorized measurement. No `sample`, Instruments, or cargo profiler was attached.

The host reached the complete structural frontier with `freshness_status=current`, `structural_completeness=complete`, and `workspace_status=ready`. It then shut down normally. The pass is therefore valid for structural setup and resource measurements.

## Results

| Stage | Timing | Counts and details |
| --- | ---: | --- |
| catalog | walk 0.254 s; apply 1.036 s | 7,203 observations; 7,203 added; 0 changed; 0 deleted |
| typeflow | full declaration summaries 0.068 s; index 0.145 s | 4,510 files |
| facts | 0.099 s | 4,510 files; 10 Rayon threads; 209,879 lane-1 records |
| resolve setup | 0.005 s | resolver build; available clone and project-file borrow 0.000 s each |
| ambient index | 0.000 s | rebuilt once |
| hybrid semantics | **49.506 s** | 4,510 affected paths and 4,510 hybrid owners |
| materialize pass 1 | 0.348 s | 4,510 owners; 793,652 input records; two owners bisected; maximum two batches for one owner |
| materialize pass 2 | 0.331 s | 793,088 records; 8,008 dependencies; 119,036 subjects; 173,027 pending sites; 564 target-not-interned; 0 dropped candidates |
| publish | 2.032 s write base | 1.822 s to page cache; 2.018 s durable; 0.139 s graph metric Merkle; 674,048 graph entries |
| scan orchestrator | `run_cold_total=50.378 s` | materialize call 0.680 s; publish call 2.453 s; CAS join 0.000 s |
| readiness | queryable 55.224 s; completed durable 55.508 s; host gate 57.139 s | structural `current` |

The process tree ran for 78.246 s through normal host shutdown. Through structural readiness it recorded 113 samples, peak RSS **4,731,296 KiB**, maximum aggregate CPU **944.4%**, and mean aggregate CPU **687.3%**. Across the full wrapper lifetime there were 155 samples, peak RSS 4,731,296 KiB, maximum CPU 944.4%, mean CPU 524.7%, and at most three processes.

Storage at shutdown was 2,940,928 bytes catalog SQLite, 166,223,872 bytes lexical SQLite, 793,382,672 bytes structural store, 45,391,284 bytes CAS, 0 semantic SQLite, 0 Rust semantic sidecar, and 1,043,419,793 bytes total.

## Telemetry limitation

The result JSON has a stable `semantic_perf_telemetry` field, but it contains zero records and the host log contains no `v4 semantic_perf` line. The host wrapper did set `URDIRA_V4_DEBUG_SEMANTIC_PERF=1`. The current JavaScript indexing-core process transport constructs a hermetic worker environment and forwards selected `URDIRA_*` variables; this new diagnostic variable is absent from that allowlist. Consequently, the release Rust worker did not see the flag and emitted no owner-level telemetry. There is no defensible top-10 owner table from this pass, and no owner-level or function-level attribution is claimed.

This limitation is recorded as an observation of the one authorized pass. Fixing the forwarding allowlist and collecting owner telemetry would require a new authorized run and was outside this task. The phase timing in the host log remains authoritative for the structural breakdown.

## Comparison with the valid unprofiled pass

The prior valid structural pass used the same Prisma commit and structural-only contract. The following deltas are observed endpoint differences, not a pure instrumentation overhead estimate: the worker was rebuilt once because Rust sources had changed, and the profiled pass used the diagnostic environment. Percentages are `(profiled - unprofiled) / unprofiled`.

| Endpoint | Unprofiled valid | Profiled | Delta |
| --- | ---: | ---: | ---: |
| `run_cold_total` | 45,066 ms | 50,378 ms | +5,312 ms / **+11.79%** |
| queryable | 49,182 ms | 55,224 ms | +6,042 ms / **+12.28%** |
| host structural readiness | 51,141 ms | 57,139 ms | +5,998 ms / **+11.73%** |
| hybrid semantics | 44,203 ms | 49,506 ms | +5,303 ms / **+11.997%** |

The observed increase is concentrated in the hybrid phase, but this comparison cannot separate source/build changes from the missing worker-side diagnostic flag or ordinary run-to-run variation. It must not be published as intrinsic profiler overhead.

## Provenance and raw evidence

The repository before the single build was at HEAD `445bb51cecde46cef4424f6eb0197a6963df657a`; the dirty-tree digest was `sha256:af91d28dee8a4317f400ae98cc1c3ffdb5bdf8d1af5a3c91091777d23afc2ce2`. The release worker was rebuilt with:

```text
cargo build --release --locked -p urdira-indexing-worker
```

The build exited 0. The worker changed from `sha256:7196d349de974e954f455c0272fa522e9a14c9a3130b189de5767a9f45cdca3b` (12,836,112 bytes) to `sha256:ffff53591b5c84984bbaccfaec10b6a115b689c563ee6a9919cb3473785d3e6f` (12,868,688 bytes). Preflight fingerprints, source hashes, the build result, checkout gate, and the exact environment are in the raw evidence directory:

`luna-profiled-prisma-20260910T210106+0200/evidence` in the benchmark archive

The principal artifacts are:

| Artifact | SHA-256 |
| --- | --- |
| `preflight-before-build.json` | `f9fbfee35980b67c611b8c544b04c3eada2ba0fe0ce1ba93d550a37db7c84675` |
| `preflight-after-build.json` | `3bb1f131a53807962f290ecb8da333f5405c022639888f77baf29474e48dc081` |
| `profiled-checkout-gate.json` | `b0e52f4c626dcd18d940864a54e43d869d55a5e90dc1bba8cd8310eca06b40c9` |
| `urdira-prisma-profiled.host.log` | `c57937f91443452dac864352085dce4f984762e5fd7331eb9cfc7d8216aec60d` |
| `urdira-prisma-profiled.result.json` | `ba64e882bbfa92db436584cc4c000c70e5510d67f5f2edbc8a38c5e2bbbd9daf` |
| `run-profiled-pass.mjs` | `f165aa58b1955bc5a56f6d671269b9055bfc69ee761fb7fa9cfe787872b1955f` |

The detached checkout and data root were removed only after the host log, result, gate, preflight, and wrapper had been written. No other worktree, data root, process, or repository file was changed by cleanup.
