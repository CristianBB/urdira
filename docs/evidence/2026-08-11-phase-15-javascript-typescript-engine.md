# Phase 15 verification evidence

The production package, daemon composition, workspace catalog recommendation,
selection persistence, and worker surface were implemented together. Focused
verification passed:

```text
pnpm --filter @urdira/plugin-javascript-typescript build
pnpm --filter @urdira/engine build
pnpm --filter @urdira/daemon build
pnpm vitest run tests/javascript-typescript-plugin.test.ts tests/phase15-workspace-control.test.ts
pnpm vitest run tests/javascript-typescript-e2e.test.ts tests/codebase-fixtures.test.ts
pnpm exec vitest run tests/javascript-typescript-production-e2e.test.ts
pnpm exec vitest run tests/javascript-typescript-plugin.test.ts tests/javascript-typescript-e2e.test.ts tests/javascript-typescript-production-e2e.test.ts tests/phase9-deltas.test.ts tests/phase9-materialization.test.ts tests/phase15-workspace-control.test.ts tests/phase14-packaging.test.ts
pnpm check:architecture
pnpm lint
pnpm typecheck
pnpm package:release
```

The release builder produced all five targets with the official analyzer and
the exact TypeScript 7.0.2 closure. Direct archive inspection found 21 analyzer
entries and 69 compiler API/AST entries in every archive, with no testkit or
synthetic-worker entry.

The production publication E2E passes for the TypeScript and JavaScript
task-planner fixtures. It verifies package bytes, resolves the plugin lock,
assembles every `jsts` record kind and both languages into an immutable registry
snapshot, validates one source-owned FactDelta per source artifact, promotes
cross-artifact dependencies, publishes generation 1 to SQLite, verifies the
reverse dependency rows, and executes all structural public-query families over
the published snapshot. The JavaScript fixture includes compiler-checked JSDoc
types and executes successfully with Node's test runner.

The worker rejects scanner-only `analyze_artifact` calls: production analysis
must carry a core work item and accepted input manifest so proposed records are
bound to an exact FactDelta for core validation. TypeScript 7.0.2's legacy root
exports are metadata-only, while `typescript/unstable/sync` exposes the
`Program`/`Checker` surface through `tsgo`; the analyzer uses that API with an
immutable virtual filesystem and deterministic AST/checker conversion.

The repository requires Node 24.18.1 or newer; this machine reports Node
24.14.0. `pnpm verify` reached 1,060 passing tests and failed only the known
eight SQLite lifecycle tests. `pnpm release:acceptance` consequently failed its
unit and crash gates for the same lifecycle failures; all other release gates
passed. Both commands must be rerun on the supported runtime before final
release acceptance.
