# Sibling-conformance reverse-index cross-repository validation

Date: 2026-09-10  
Status: complete; the current structural worker reached a complete, current,
ready frontier on every repository in the expanded benchmark corpus.

## Contract

The validation used one selected structural readiness pass per repository. The
readiness boundary ends when structural indexing is complete, current, and
ready. Semantic indexing, semantic materialization, and the Rust semantic
sidecar were disabled. These were host-only validation passes: they did not run
a coding-agent turn, MCP query, or benchmark task.

| Repository | Frozen commit | Structural readiness | Hybrid semantics | Sibling conformance | Peak RSS evidence |
|---|---|---:|---:|---:|---:|
| `microsoft/playwright` | `1b44f5a441f391538c42c7ce36dd8ce779a5d6a1` | 5.498 s | 1.516 s | 13,073 calls / 1,871 us | 2,967,696 KiB process tree |
| `microsoft/TypeScript` | `b465fdbfe175304d9b977da137b2c178ae1091d3` | 9.086 s | unavailable | 34,428 calls / 336,797 us | unavailable |
| `prisma/prisma` | `0f37454eec96b193e8b20e8f569e453acd2af644` | 13.563 s | 6.215 s | 18,685 calls / 472 us | 4,383,216 KiB process tree |
| `microsoft/vscode` | `038b9225c82c6b75172beda6081c64887692538c` | 57.859 s | 14.862 s | 375,458 calls / 7,354,424 us | 7,858.4 MiB worker diagnostic |

The TypeScript pass did not enable detailed phase timing or process-tree
sampling, so those values remain unavailable rather than being reconstructed.
The VS Code external sampler retained only the runner PID; its process-tree RSS
is therefore invalid. The table uses the worker's internal scan-completion RSS
for VS Code and labels it separately.

## Interpretation

All four repositories exercised the optimized path and reached the required
structural frontier without semantic work. Prisma has the most tightly
instrumented directed before-and-after comparison: `hybrid_semantics` fell from
42.224 s to 6.215 s (-85.28%), `run_cold_total` from 43.094 s to 7.109 s
(-83.50%), and readiness from 49.197 s to 13.563 s (-72.43%). Its reverse
conformance index took 831 us to build and peak RSS fell by 6.39%, providing no
evidence that index construction introduced a replacement bottleneck.

The retained pre-change v4 campaign also provides structural-readiness
baselines for the other repositories under the same frozen commits, structural
boundary, disabled semantic work, single analysis worker, single analysis-pool
lane, and single structural lane. `BENCH_HOST_READY.elapsed_ms` is used on both
sides; host lifetime and agent time are excluded.

| Repository | Before | After | Time saved | Reduction | Speedup |
|---|---:|---:|---:|---:|---:|
| `microsoft/playwright` | 6.706 s | 5.498 s | 1.208 s | 18.01% | 1.22x |
| `microsoft/TypeScript` | 22.809 s | 9.086 s | 13.723 s | 60.16% | 2.51x |
| `prisma/prisma` | 49.197 s | 13.563 s | 35.634 s | 72.43% | 3.63x |
| `microsoft/vscode` | 820.366 s | 57.859 s | 762.507 s | 92.95% | 14.18x |

The Playwright baseline is the retained `affected-tests-deterministic` smoke
sample with 6.706-second structural readiness. The TypeScript baseline is the
immediate pre-change `transpile-diagnostic-callback` smoke-v3 sample. Prisma is
the directed profiled reference measured immediately before the change. VS
Code is the retained `language-registry-change-notification` v4 sample. This is
a directed one-sample before/after comparison; it measures the observed change
and is not a variance estimate.

The larger VS Code pass shows the remaining ceiling. Sibling conformance used
7.354 aggregate CPU-seconds across 375,458 calls, while typeflow lookups used
112.102 aggregate CPU-seconds and member walks used 95.165 aggregate
CPU-seconds. These counters overlap inside the 14.862-second hybrid wall phase,
so they must not be added. They indicate that typeflow lookup and member
traversal, rather than reverse-index construction or synchronization, are the
next optimization targets.

These are directed one-sample validations, not a distribution, P95 result, or
full agent-tool comparison.

## Detailed evidence

- `2026-09-10-sibling-conformance-optimized-pass.md`: matched Prisma reference
  and optimized pass.
- `2026-09-10-sibling-conformance-typescript-directed-pass.md`: TypeScript.
- `2026-09-10-playwright-affected-tests-host-only.md`: Playwright.
- `2026-09-10-vscode-language-registry-host-only.md`: VS Code.
