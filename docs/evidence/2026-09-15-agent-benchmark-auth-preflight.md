# Definitive benchmark authentication preflight

Date: 2026-09-15

This evidence records offline preparation for the proposed v7 definitive agent
campaign. No model, benchmark cell, or readiness probe was invoked.

## Authentication route

The runner now derives one effective parent `CODEX_HOME` and checks the parent
`auth.json` with metadata only before any Codex invocation. The check requires a
regular, non-empty, readable file and routes it into each isolated arm through
a symlink. It does not read, copy, hash, or log credential bytes. Missing,
empty, unreadable, or mismatched routes fail closed.

The current redacted metadata check found the effective parent
`/Users/Cristian/.codex/auth.json` as a regular 3,936-byte mode-0600 file. All
five arm routes resolved to that parent path. The retained metadata artifact is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v7/preflight/codex-auth-route-5-v2.json`
(SHA-256 `f491f6f9f92a2d298264a3fdad1c4b7e6058c05ed859766388fc5111b79f223a`).

The focused regression suite covered missing, empty, readable permissive-mode,
effective-`CODEX_HOME`, and symlink-mismatch cases. The final focused run was
59/59 passing:

- red empty-file regression: `auth-empty-red.log`, SHA-256
  `57d731f39a2d268c30b15bb07ed94495c9020c56bd1b45821828469263301963`;
- red permission-policy regression before removing an unsupported hardening
  rule: `auth-permissions-red.log`, SHA-256
  `412cd9226304430199b383ee36a708d0db4502375396f27ec0e76176399a4150`;
- green focused run: `auth-route-focused-v5.log`, SHA-256
  `0a2b784bfab35f3e33dd184d38781da3d075d3099e5e560450f6d307dd0dc1d3`.

## No-model release and dependency checks

The v7 release binding used the package produced after the source fix:

- archive: `/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v7/urdira-darwin-arm64-0.3.3.v7-auth.tar.gz`;
- archive SHA-256: `822a63a888f942cc9fb85a253d6ad8079a443633162d2c9773b1a599d030e02c`;
- binding: the adjacent `.binding.json` file, SHA-256
  `e91adc2062eee0affc7770694c7f4195f763b92139bed8a16316dbf0ddb75bcf`.

Fresh worktrees at the three frozen repository commits passed the production
dependency-closure helper and were removed afterward. The retained validation
artifact is `dependency-validation-v7.json`, SHA-256
`3d5b4047081b3b6047b89ee744fb03f586b9ab36f8a8af8a49404e681858f951`.

A real Urdira integration preflight passed against the extracted release. It
validated the bound `status --json` parser path and did not start a daemon or
invoke a model. Its stdout log SHA-256 is
`4111e684dd6659e89ec5296dd067e575b38f196122c6933f4a77e999cb86b4b0`.

## Gates

The complete verification and release checks passed after the declaration fix:

| Command | Result | Evidence SHA-256 |
| --- | --- | --- |
| `CI=true pnpm verify` | exit 0; 90.06% lines; critical branches and semantic regions 100% | `61874d1a06d23260378823578aafad17fa030f5f10d8dcf96464c4a315f2039a` |
| `URDIRA_RELEASE_TARGET=darwin-arm64 pnpm package:release` | exit 0 | `bc90bb5993b0ae525babfa524d9f00f9b4eb1c608bd40e5a7b62b72d403a4294` |
| `URDIRA_RELEASE_TARGET=darwin-arm64 pnpm release:acceptance` | exit 0; 10/10 | `899208feb6767f8eeeb55afcafb566096e7145b37ccaca9a769e7118de8dd716` |
| `git diff --check` | exit 0 | empty output SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

The campaign remains proposal-only. Historical v6 failures and raw evidence
remain excluded and untouched; no v7 model or probe result is claimed here.
