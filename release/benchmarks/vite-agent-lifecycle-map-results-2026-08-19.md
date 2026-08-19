# Vite agent-matched benchmark results

Generated at 2026-08-19T09:35:47.807Z from raw audit `sha256:9e3e288805ce402bd3796c78447ccee6f490c0ec705b3ceb4cbbf1121a1bb3f6`. Raw transcripts and host-local paths are retained outside the public repository. All arms ran the same three-iteration task against vitejs/vite at commit c0f2fc607ee97ee4499337b04826420c00654065, using model gpt-5.6-luna.

## Outcome

- **Runs:** 11/12 successful; 1 failed.
- **Smoke gate:** 6/6 successful; passed=true.
- **Arms:** baseline (ordinary tools), codebase-memory (codebase-memory MCP), Urdira (Urdira MCP).
- **Phases:** cold and warm; 2 samples per arm/phase.
- **Cost basis:** Estimated cost uses the campaign rates: input USD 2/M tokens; output and reasoning USD 8/M tokens. It is not a provider invoice.

## Workload scope and interpretation

This is a broad cross-cutting discovery workload in a **large TypeScript monorepo**: the agent must trace plugin lifecycle callers and consumers across build/serve paths, tests, and docs, then produce a **file:line evidence map**, caller matrix, invariants, risks, and staged migration plan over **three iterations**. It is designed to give graph-based code intelligence a plausible advantage over targeted shell search. It should not be generalized to localized implementation work.

## Per arm and phase (median; p95 is in JSON)

| Arm | Phase | Success | Time | Tokens | Est. cost | Outer turns | MCP calls |
|---|---|---:|---:|---:|---:|---:|---:|
| baseline | cold | 2/2 | 396 s | 5.19 M | $10.63 | 3 | 0 |
| baseline | warm | 2/2 | 385 s | 4.97 M | $10.20 | 3 | 0 |
| codebase-memory | cold | 2/2 | 379 s | 5.95 M | $12.19 | 3 | 50 |
| codebase-memory | warm | 1/2 | 363 s | 6.77 M | $13.78 | 3 | 45 |
| urdira | cold | 2/2 | 339 s | 4.19 M | $8.63 | 3 | 3 |
| urdira | warm | 2/2 | 363 s | 3.73 M | $7.68 | 3 | 3 |

## Overall by arm (cold + warm)

| Arm | Scope | Success | Time | Tokens | Est. cost | Outer turns | MCP calls |
|---|---|---:|---:|---:|---:|---:|---:|
| baseline | cold+warm | 4/4 | 396 s | 5.19 M | $10.63 | 3 | 0 |
| codebase-memory | cold+warm | 3/4 | 379 s | 6.05 M | $12.36 | 3 | 50 |
| urdira | cold+warm | 4/4 | 363 s | 4.19 M | $8.63 | 3 | 3 |

## Reliability and storage hygiene

- Failed runs: vite-codebase-memory-warm-2.
- Host warnings were recorded separately from task success: 3 run log(s) contain indexing/projection diagnostics.
- Disposable Urdira data roots remaining after the campaign: 0; benchmark worktrees remaining: 0; cleanup status: **clean**.

The JSON file contains p95, means, cached/uncached input tokens, command actions, file-change batches, warnings, failures, and exact cleanup evidence.
