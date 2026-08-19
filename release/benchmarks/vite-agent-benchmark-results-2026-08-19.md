# Vite agent-matched benchmark results

Generated at 2026-08-19T09:35:47.749Z from raw audit `sha256:d9b8fc64d898ab24766c3aacef8b7e609c3f9db859bf2ceba69223f5d69899ac`. Raw transcripts and host-local paths are retained outside the public repository. All arms ran the same three-iteration task against vitejs/vite at commit c0f2fc607ee97ee4499337b04826420c00654065, using model gpt-5.6-luna.

## Outcome

- **Runs:** 60/60 successful; 0 failed.
- **Smoke gate:** 6/6 successful; passed=true.
- **Arms:** baseline (ordinary tools), codebase-memory (codebase-memory MCP), Urdira (Urdira MCP).
- **Phases:** cold and warm; 10 samples per arm/phase.
- **Cost basis:** Estimated cost uses the campaign rates: input USD 2/M tokens; output and reasoning USD 8/M tokens. It is not a provider invoice.

## Workload scope and interpretation

This is a specific workload: a **large TypeScript monorepo**, a **highly localized change**, **precise discovery** of a few lifecycle/type paths, **three agent iterations**, and **bounded expected evidence** (nearby files, focused tests, and concise docs). It is useful for measuring code-intelligence overhead when targeted native tools may already solve the task. It should not be generalized to broad architectural exploration or distributed cross-repository changes.

## Per arm and phase (median; p95 is in JSON)

| Arm | Phase | Success | Time | Tokens | Est. cost | Outer turns | MCP calls |
|---|---|---:|---:|---:|---:|---:|---:|
| baseline | cold | 10/10 | 304 s | 4.62 M | $9.47 | 3 | 0 |
| baseline | warm | 10/10 | 317 s | 5.35 M | $10.96 | 3 | 0 |
| codebase-memory | cold | 10/10 | 329 s | 9.09 M | $18.44 | 3 | 25 |
| codebase-memory | warm | 10/10 | 337 s | 8.08 M | $16.41 | 3 | 23 |
| urdira | cold | 10/10 | 333 s | 4.04 M | $8.31 | 3 | 3 |
| urdira | warm | 10/10 | 292 s | 3.91 M | $8.10 | 3 | 3 |

## Overall by arm (cold + warm)

| Arm | Scope | Success | Time | Tokens | Est. cost | Outer turns | MCP calls |
|---|---|---:|---:|---:|---:|---:|---:|
| baseline | cold+warm | 20/20 | 317 s | 5.01 M | $10.29 | 3 | 0 |
| codebase-memory | cold+warm | 20/20 | 335 s | 8.75 M | $17.75 | 3 | 25 |
| urdira | cold+warm | 20/20 | 316 s | 4.02 M | $8.27 | 3 | 3 |

## Reliability and storage hygiene

- Failed runs: none.
- Host warnings were recorded separately from task success: 11 run log(s) contain indexing/projection diagnostics.
- Disposable Urdira data roots remaining after the campaign: 0; benchmark worktrees remaining: 0; cleanup status: **clean**.

The JSON file contains p95, means, cached/uncached input tokens, command actions, file-change batches, warnings, failures, and exact cleanup evidence.
