# VS Code v75 independent validation

Date: 2026-09-14

This record independently reconstructs the two patches from the frozen
`microsoft/vscode` commit
`038b9225c82c6b75172beda6081c64887692538c` using Node 24.18.1. The benchmark
arm was `urdira-typescript`, the model was `gpt-5.6-luna`, readiness was
structural, and semantic indexing was disabled.

The retained benchmark strict grader passed both frozen tasks. Comparable
cumulative usage was 1,248,648 tokens for
`language-registry-change-notification` and 1,462,541 for
`language-provider-registration-idempotence`. Structural readiness was 29,537
ms and 43,880 ms respectively. The host log identifies the worker as
`target/release/urdira-indexing-worker`, SHA-256
`2d4d981ec9f8fd5c7cbe38a08f8f3ff5f3eebedb0ea4b882167a5ee3792133c5`.

Independent checks passed:

- extension TypeScript typecheck and emit;
- `npm run transpile-client`;
- focused TypeScript integration tests: 3 passing;
- focused `LanguageFeatureRegistry` Electron tests: 2 passing after the test
  fixture was completed;
- targeted ESLint;
- `git diff --check`.

The first registry test invocation failed before exercising the implementation
because the generated test mock omitted `ITextModel.isTooLargeForSyncing`.
Adding `isTooLargeForSyncing: () => false` to the temporary validation fixture
made both registry tests pass. No production source was changed by this
validation.

The benchmark hook audit recorded 13 served and 11 fallback actions for the
registry task, and 11 served and 20 fallback actions for provider registration.
Served hook output counts as Urdira transport; fallback shell reads remain
valid supplemental work. Raw transcript, manifest, hook-audit, benchmark
metadata, and cleanup references are retained in
`/Users/Cristian/BenchmarkResults/urdira-context-density-20260914-v75/`.
