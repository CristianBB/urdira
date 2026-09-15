# Definitive selected agent benchmark v6: blocked execution evidence

Status: blocked after two campaign-1 cell attempts on 2026-09-15. This note
records the v6 freeze, launcher preparation, retained raw artifacts, and
derived partial report. It does not claim completion of the 45 agent cells or
the 18 readiness probes.

## Frozen inputs and preparation

The v6 freeze authority was
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v6/series-freeze-v6-ready-v6.json`, SHA-256
`dc04dca663c35f5783cbde7de5145db001d99bec4babc6114adc1d479a6671c8`.
It binds Urdira commit `5de04b14305bf1399b200b57db70efb888b99436`, Node
`v24.18.1`, Luna, semantic indexing off, 45 expected cells, 18 expected
readiness probes, and the 50 GiB free-space guard.

The v6 addendum v7 is retained at
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v6/series-freeze-v6-ready-v7.json`, SHA-256
`16dd200f5c517559b9f3ae4dc5357fd2688fedc433bef131ea4b9a67cf33b658`.
Its launcher validation log is 1,253 bytes with SHA-256
`2135cc818989474c67b4d513390fb24d8ff75457cade67d3fda2f77dea752514`.

The approved launcher was
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v6/launchers/run-frozen-v6-v3.mjs`, SHA-256
`addc38b810c142a2720f9646071fb3ee722c972c0c0c9e709aa4ebe0f46d4ffd`.
Its model-free regression log is retained at
`.../series-v6/launchers/test-run-frozen-v6-v3.log`, 1,253 bytes, SHA-256
`2135cc818989474c67b4d513390fb24d8ff75457cade67d3fda2f77dea752514`.

Earlier launcher/freeze preparation remained historical. The v2 launcher
SHA-256 was `5462edbac6c176c0bbeb7aa2d8f18ee5673c71d6c13bdd41e44608c0b362c42d`
and the v5 freeze SHA-256 was
`131bfaadc8b4c42c006f0f000acf29344fe76c7f69b63c6ffaa70f0f2d63fd1d`.
Those preparation artifacts were not execution evidence and were not reused.

The final pre-execution cleanup checkpoint passed:
`.../series-v6/cleanup-checkpoint-final-v9.json`, SHA-256
`b1f7bfd542d7faf0055145f331afa000a923318369ad050fa5ec62dd8fb57a79`;
free bytes were `364529238016`, with zero owned processes and zero residue.

## Execution outcome

The launcher began campaign 1 and retained two cells before stopping on the
infrastructure/preflight failure policy:

| Scope | Attempted | Not started | Outcome |
|---|---:|---:|---|
| Agent cells | 2 | 43 | blocked before completion |
| Readiness probes | 0 | 18 | not started; readiness is after all 45 cells |

The baseline Playwright cell emitted a failed manifest with
`model_invoked=true`, but its transcript is empty. The harness requested three
outer turns; the timing sidecar contains one `turn-1` with zero lines and zero
calls. Host session evidence and token evidence are absent, so the flag does
not establish a real model interaction.

The Urdira Playwright cell stopped before an execution manifest. Its retained
stderr reports that the extracted CLI rejected `urdira --version` with
`cli:command_invalid`; `model_invoked` therefore remains `null`.

Both attempted cells completed their cleanup checkpoints with zero owned
processes and no registered residue. No cell was retried, and no readiness
probe was run.

## Derived offline artifacts

The production assembler was inspected but not used to claim completion: it
requires three complete selected-15 audits and three complete selected-6
readiness manifests, so it correctly rejects this partial state. The current
renderer accepts the explicitly marked partial audit and produced the full
45-identity matrix with attempted and not-started states preserved.

The current analyzer, replay, and renderer ran only against the retained v6
raw paths and wrote to the new external directory
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v6/derived-v6-blocked-20260915-v3`.
The v1 and v2 outputs below are preserved as superseded renderer results; v3 is the
report-only analysis revision and does not alter the frozen raw artifacts.

- Partial 45-cell/18-probe audit: `partial-audit-v6.json`, 218,445 bytes,
  SHA-256 `daf8bd7afc853fa154f7c1f2e9eedcca9890ff77a9b066924d9b830cfb10625f`.
- Empty-transcript token analysis: `analyzer/playwright-baseline.tokens.json`,
  943 bytes, SHA-256 `21e17eb440601d03af36579f8eed1f4130e39505e5edd47a836ba3b6b0bb7693`.
- Offline replay: `replay/replay.json`, 6,455 bytes, SHA-256
  `d6d344946cdc13ee5156cfc85ae1e810ea31726da764b2b17b02f085386bf4dd`.
- Rendered partial JSON: `report/definitive-agent-benchmark-results-v6-blocked.json`,
  388,422 bytes, SHA-256 `8f5fd0bf0f22cc89f88aa6032f0643f8fc31bd91632fb0d66e5ca2525279a211`.
- Rendered partial Markdown: `report/definitive-agent-benchmark-results-v6-blocked.md`,
  53,438 bytes, SHA-256 `fb5bb5929a047c56d60554ded78f0f205e7917c4c33543853d758e1168479227`.

The corrected v3 render has JSON SHA-256
`0820b6c6a75f9692d6947f3f8efec137662bbd32604ea242283b017e07bfe8e8` and
Markdown SHA-256
`10bfaec018ec878a299ee47f648a32044c6cdf6d94149356bf51779a1f8f2cdf`.
Its stdout summary is retained at
`.../series-v6/derived-v6-blocked-20260915-v3/renderer.stdout.log`, SHA-256
`e82857bf8eb7191da29b7f8a57f78251c38badf9d2be46a99adb154fdd0585de` and
reports `observed_runs=2`, `observed_readiness_probes=0`.
The renderer correction reports 2 observed/attempted cells, 43 not started,
0 observed readiness probes, and 18 not started; planned rows expose
`model_invoked`, completion, and timing fields as `null` when no observation
exists. The focused regression passed 15/15 after the fix. Its retained green
log SHA is
`639028b3abdeda56a090f6de03a4da22689c94f1d86c04a73e1dca6a08a57786`.
The red evidence file is explicitly a reconstructed summary rather than
captured test output, SHA-256
`3a7b42a1786147b4c8916988b5dc01f475cc8940e507e7db55f83e8f2fed1235`.

The derived matrix contains all 45 expected cell identities: 2 attempted and
43 marked not started. All 18 readiness identities are present and marked not
started. Missing timing, token, cost, correctness, coverage, efficiency,
distribution, and readiness values remain `null`; P95 is `null` because the
campaign is incomplete. The derived report is diagnostic and does not satisfy
the complete selected-45 assembler gate.

The v5 history and its offline appendix remain separate historical evidence.
They are not merged into the v6 matrix and do not turn the blocked v6 series
into a completed campaign.
