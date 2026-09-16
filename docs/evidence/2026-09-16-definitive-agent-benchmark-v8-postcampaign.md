# Definitive agent benchmark v8 post-campaign rendering evidence

## Scope and status

This evidence records offline rendering completed on 2026-09-16 after the
three agent campaigns and the 18 readiness attempts were retained. It does not
launch models, probes, or tests. The agent matrix remains 45 rows: 43 task-solved rows, 42 strict grader passes, two strict grader nonpasses, and one unavailable infrastructure outcome. The C3 Urdira VS Code row is task-solved with a tool-validation incident; its strict grader is a nonpass. The readiness matrix has 18 persisted failed, blocked, or interrupted
rows, zero successful probes, and no readiness qualification.
The readiness measurement objective was not achieved. This note records
offline rendering and retained attempt evidence only; the post-campaign PATH
fix is not retroactive validation and produced no new readiness evidence.

The append-only reporting-axis correction is
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-campaigns-1-3-v1/summary/benchmark-campaigns-1-3-v4-axis-correction.json`
(SHA-256 `e62bdc06fbf8c5cbb19ba6f1c28ded008e7d1df1f20e540d2bbede0ff94025e3`);
it leaves the v3 raw-derived consolidation unchanged. The readiness source
composition is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-final-composition-v1.json`
(SHA-256 `5a3be1432ac047084abdd24fbb4491c9219769c19683f4a51af06f5a616898a7`).
The append-only normalized status view is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-final-composition-v2.json`
(SHA-256 `2090d55be0745fe5f056b7058ecb1305ce22a7d34502595f087bf2bd0bb6328b`);
it preserves the v1 outcome counters and reports row-level status as 3
interrupted cold, 6 preflight failures, and 9 warm-blocked rows.
The complete readiness table is retained externally at
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-final-table-v2.md`
(SHA-256 `d1ceded62ba66614b2775042bc633f0855a0c594bbd526d835559c43f763dd0c`)
and is embedded in the dated results report.

## Supplemental recovery measurement

The original C1 Prisma/Urdira infrastructure-null row remains unchanged in the
45-row strict matrix. A separate same-identity recovery completed on attempt 2
after two retained pre-model recovery failures, followed by the successful
authorized recovery; no retry was counted after the successful model run. The
row measured 3 turns, target coverage 2/2,
agent/runner/grader exits 0/0/0, setup `16,430 ms`, elapsed `206,157 ms`,
input `717,705`, cached input `655,360`, output `7,340`, reasoning `2,703`,
total `727,748`, cost `$1.515754`, hooks `23/8/15`, shell/MCP/tgrep `3/0/0`.
This is a separate descriptive recovery measurement, not a replacement for the
original row. The addendum Markdown is
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-campaigns-1-3-v1/summary/benchmark-campaigns-1-3-v5-supplemental-prisma-urdira.md`
(SHA-256 `92c754b7597b5847b19438302caeafb87400747622c1fa61f9bd77fb38931022`);
JSON SHA-256 is
`01fbe484d537e1e933b3f414a00a78348b1a3c13f19b9e2ffa28ce3e73d7a4e4`.

## Per-campaign frozen renderer outputs

The frozen renderer was invoked separately for each campaign, using that
campaign's 15 original agent rows and six original readiness rows. The input
files apply layout-only aliases where a retained campaign input stored an
identity under `task_id` or `repository_id`; raw manifests and transcripts are
unchanged.

| Campaign | Renderer input SHA-256 | Agent rows | Readiness rows | Successful agent rows | Renderer JSON SHA-256 | Renderer Markdown SHA-256 | Readiness gate |
|---:|---|---:|---:|---:|---|---|---|
| 1 | `5b080878a19e5e3e600d37f2bd235dd85d24a55efdde557f18bb9842718d7e57` | 15 | 6 | 13 | `530317c4301796e01db13799f4f99e9d9c155b35dcd2ca33151a6341f2c5785e` | `a3affabc3f73f2029f3b58eacdab864de03da61bc620fd83254990d583b5ed6d` | false, 0/6 passed |
| 2 | `21223cb21db4f490ad6f3c50069eb5a38c5be728920bbd4161bf765aec17794a` | 15 | 6 | 15 | `ac24dcb4ef1f942556756de2cf41e241b6613648a16f381d0fdae156192aabed` | `184594cc6af2f7b177b0c0de1451acf58c2106d3096775d0a83ba008951fa93e` | false, 0/6 passed |
| 3 | `6ae626e94d0eb77b848af4049f8fb4e1cca703e54d53bf2b5ac32f119518a96e` | 15 | 6 | 14 | `708ecc119787a7fca6ce8e306ebbb8b7c882324f4fd69036925eee5ba6f973e2` | `e1a0f137908789c8a3f60b8245cd53e9d27f84bbe57fc4e89575b810ed58ab6f` | false, 0/6 passed |

Renderer outputs are per-campaign artifacts. The aggregate invocation was
intentionally not bypassed: the frozen selected-45 guard rejects a 45-row,
three-campaign input because its uniqueness check uses repository/task/arm
without campaign. The rejected attempt manifest is
`/Users/Cristian/BenchmarkResults/urdira-v8-analysis-final-20260915-v3/renderer-final-attempt-manifest-v1.json`
(SHA-256 `cb066e62d2d4ef68deec16f815056d9d2e06da226e29b035f27b941b8a00cf23`),
and its log is
`/Users/Cristian/BenchmarkResults/urdira-v8-analysis-final-20260915-v3/renderer-final-frozen-guard-failure-v1.log`
(SHA-256 `23bc47e73a3e3ca221cdc71ca18f86d329c6ffa0e13df52a8865e0d9c3c86b15`).
No aggregate output was written and no aggregate frozen-renderer pass is
claimed.

## Readiness result

The final readiness composition has 18 expected and 18 persisted rows. All
model invocation fields are `false`; setup elapsed, structural readiness, time
to first query, snapshot identity, page completeness, semantic sidecar,
freshness, publication, token, cost, correctness, coverage, efficiency, and
P95 fields are `null` when absent. Five preflight rows retain storage and
process observations. Zero probes succeeded, so readiness remains failed and
cannot qualify the benchmark.

## Post-campaign PATH-fix gates and cleanup

The current post-campaign gate manifest is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/runner-path-fix-v2/gates-final-manifest-v2.json`
(SHA-256 `b9d170bed887bf06b2522a8b956a9434fb65d9d1909734052cab31af17cbd9ed`).
The gate run recorded repository HEAD
`b05bf226a78d5290807c92c21874d5d858b69c7b` with the PATH-fix working-tree
changes present before commit; a later commit must retain this evidence
separately.
The retained `verify-v2.log` passed with 90.06% total coverage and 100%
critical branch coverage (SHA-256
`67143321d7e22fe2a9987272066d7cc7185699cb65d6df89950236a62b6a00cf`),
`package-release-v1.log` passed (SHA-256
`9a7b52db801bd734b6c4f4bf0d1e5fefdfe945d99d8f21800821fe0a53098665`),
`release-acceptance-v1.log` passed (SHA-256
`51e6b3d4489cdf093fdcea4ea60f92563204a73aa9ec8e1b34bb0918a5e2217a`), and
`diff-check-v1.log` passed (SHA-256
`53da44f38c61ac33d12c2f6799955f61db476c8aa34f89e02014d056e19db329`).
These repository and release checks add no benchmark or readiness measurements
and do not retroactively validate readiness. Cleanup v3 is retained at
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/runner-path-fix-v2/global-cleanup-v3.json`
(SHA-256 `e6d0cccd6df033e358277ac1492a7acbf0e1472400a2bc94d4d221771917bf97`);
it records zero active processes and removal of 56,735 declared temporary
bytes. The pre-gate, post-package, and post-acceptance archives remain
retained with SHA-256 values `1b4fc4f064962206f1556242e946b53390aba08edf86232e646f3a296e4a4dd6`,
`d6e0e92f827ed6973516fa338b255c9d30b9269f43b2791e2a3fdc14a8bdb5ef`, and
`4f30c892880154a903a1c4685803f588b781bcabfe2faf49953e37cf319fef60`,
respectively. No benchmark, model, or readiness retry was launched by these
gates.
