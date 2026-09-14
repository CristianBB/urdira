# Definitive agent benchmark reporting — 2026-09-15

This note records the reporting contract for the pending definitive campaign.
It does not claim execution of the 45 agent cells or 18 readiness-only probes.

The final phase must read the original retained manifests, transcripts, timing
sidecars, hook audits, host logs, comparator reports, and hashes. It runs the
existing `release/benchmarks/analyze-agent-matched.mjs` analyzer and
`release/benchmarks/render-expanded-agent-report.mjs` renderer, then updates
the canonical versioned report, runbook, and current-state inventory. Raw
paths and hashes stay outside the repository; sanitized derived evidence is
retained here.

The final table is keyed by repository/task/arm/campaign. It separates runs,
passes, correctness, coverage, tokens by input/output/reasoning/cached,
cost and rate policy, setup/agent/readiness cold/warm/TTFQ/E2E timing,
hook/MCP/shell/tgrep/tool-output/full-context measurements, continuations,
duplication/density, hydration, and fallbacks. It distinguishes medians,
distributions, intervals, and failures. Unavailable values are `null`, never
`0`, and efficiency is compared only across equal correctness and coverage.

The current retained Urdira observations remain v72 Playwright, v69 Prisma,
and v86 VS Code as linked from the canonical report. The definitive campaign
remains incomplete until the complete table is generated and shown to the user.
