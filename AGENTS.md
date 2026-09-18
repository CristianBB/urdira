# Urdira Agent Contribution Guide

This file is the operating contract for coding agents working on Urdira. It
applies to fixes, features, refactors, documentation changes, tests, and
release work. The repository's approved architecture is the source of truth;
this guide explains how to work within it.

## Start here

Before changing anything, read these files in order:

1. [`README.md`](README.md) for the project purpose and public usage.
2. [`docs/README.md`](docs/README.md) for documentation structure and
   authority rules.
3. [`docs/product-foundation.md`](docs/product-foundation.md) for the
   architectural decision index.
4. The relevant approved decision in [`docs/decisions/`](docs/decisions/).
5. The linked protocol, registry, serialization, taxonomy, diagnostic,
   semantic, compatibility, or indexing contract for the behavior being
   changed.
6. [`architecture/manifest.json`](architecture/manifest.json) for the package
   owner and dependency direction.

Do not use an implementation plan, test fixture, generated file, or previous
agent report as a substitute for an approved decision. If the documents
conflict, stop and record the conflict for resolution before changing code.

## Understand the requested change first

Classify the request before opening a package:

- **Public behavior**: inspect the public query contract and MCP contract.
- **Shared model or field**: inspect the universal data model and Schema IR.
- **Registry value or diagnostic**: inspect the owning registry and its closed
  payload definition.
- **Canonical bytes or digest**: inspect the Urdira Canonical Encoding and the
  digest-field contract.
- **Workspace or indexing behavior**: inspect the workspace, storage, and
  candidate-publication decisions.
- **Plugin behavior**: inspect the language-neutral plugin contract. Language
  plugins stay in dedicated packages; the composed application may bundle an
  approved plugin, but core contracts and query behavior remain language-neutral.
- **Semantic behavior**: inspect the semantic decision and core-owned model
  profile contracts. Plugins do not own embeddings, ranking, or ordering.
- **Daemon, CLI, MCP, or packaging**: inspect the daemon/MCP/packaging decision
  and its protocol contract.

Use the smallest package set that owns the behavior. The package dependency
direction is enforced by `architecture/manifest.json`; infrastructure must not
leak into contracts, canonical logic, or the plugin SDK.

## Non-negotiable invariants

- Urdira's public intelligence surface is read-only. Never add source editing,
  patch application, arbitrary command execution, or a network transport.
- Every source-derived record and projection retains its indexed owner artifact
  and exact owner artifact version. Cross-file derivations also retain reverse
  artifact dependencies.
- Every source-reading request has explicit workspace scope. Never infer scope
  from MCP connection state, current directory, branch, environment, or process
  state.
- Queries are exact and deterministic. Never hide truncation, approximate
  retrieval, incomplete coverage, or stale semantic materialization.
- Snapshots and cursor executions are immutable. Continuations reuse their
  persisted ordered manifest and never rerun or rerank the query.
- Closed unions, registries, schemas, diagnostic codes, and operation errors
  reject unknown values. Do not invent identifiers in runtime output.
- Plugins contribute validated language-neutral knowledge only. They cannot
  define query operations, recipes, ranking, pagination, public schemas,
  embeddings, or response ordering.
- Test-only synthetic workers stay in `@urdira/testkit` and must never enter a
  production release archive.
- Documentation and code comments are written in English.

## Implementation workflow

1. **Inspect the current state.** Preserve unrelated user changes. Use the
   repository's code-intelligence tools when available; otherwise search only
   the relevant package and its tests.
2. **Write or update a focused failing test first.** The test must state the
   normative behavior, including invalid inputs, completeness, provenance,
   pagination, or failure semantics where applicable.
3. **Implement behind the existing port.** Keep domain decisions pure and
   deterministic. Put filesystem, SQLite, watcher, process, clock, and model
   runtime effects behind injected adapters.
4. **Regenerate derived artifacts from their authority.** Public schemas come
   from Schema IR; canonical and digest projections come from their registries;
   never hand-edit generated output.
5. **Update documentation in the same change.** Follow the documentation
   checklist below.
6. **Run the narrowest relevant tests, then the full gate.** Do not report a
   change as complete without verification evidence.
7. **Review the diff for contract drift.** Confirm package boundaries, closed
   identifiers, source ownership, explicit scope, and no accidental generated
   or plugin artifact.

## Documentation update policy

Documentation is part of the implementation, not a follow-up task. Update
`README.md` in the same change whenever any of these changes:

- what Urdira does or does not do;
- installation, startup, CLI, MCP, or configuration instructions;
- public tools, operations, options, response behavior, pagination, or errors;
- supported workspace providers, platforms, model packs, or plugin status;
- contributor workflow, verification commands, package layout, or release
  behavior.

Update the authoritative document as well when behavior changes:

- `docs/decisions/` for product or architecture decisions;
- `docs/protocol/` for public API, operation, recipe, error, or MCP contracts;
- `docs/serialization/` for canonical encoding, comparison, or digest rules;
- the owning registry directory for new or changed closed values;
- `docs/evidence/` for phase verification and release evidence.

Never “fix” an architectural conflict by updating only the README or a plan.
Resolve the authority first, then update the README and derived documents.

## Verification commands

Run the targeted checks while iterating:

```bash
pnpm check:architecture
pnpm lint
pnpm test
pnpm typecheck
```

Before handoff, run the complete gate:

```bash
pnpm verify
```

`pnpm verify` runs, in order: `check:architecture`, `build:native-artifacts`
(`build:native` plus the release `urdira-indexing-worker` build), `check:native`
(`cargo fmt --check` + `cargo clippy -D warnings`), `test:native:smoke` (small
native protocol/core/structural-store checks), `lint`, `test:coverage`
(builds every package, then `vitest run --coverage`), `typecheck`,
`check:coverage-gate`, and `check:publication`. On a memory-constrained machine
run these stages one at a time instead of the combined `pnpm verify`, and set
`CI=true` before any `vitest`-based stage (`test`, `test:coverage`): it caps
`maxWorkers` at 2 and raises the test/hook timeouts, which is what keeps a
loaded machine from producing spurious timeouts. Never poll for or wait on a
background verify from another agent turn or subagent — a subagent cannot
observe a job finishing after its own turn ends; resume it and check again
instead.

For release-facing changes, also run:

```bash
pnpm package:release
pnpm release:acceptance
```

Coverage thresholds do not replace scenario tests. Critical canonical,
publication, cursor, and security-policy behavior must retain the required
branch coverage and adversarial cases.

### Native builds and `NATIVE_API_VERSION`

The opt-in `pnpm benchmark:native-tests` command runs the heavier
`urdira-tsgo-client` `--ignored` suites and `urdira-indexing-worker` residual
tests. Those suites need `URDIRA_TSGO_BINARY` pointing at the pinned
`@typescript/typescript-<platform>` `tsc` binary inside `node_modules/.pnpm`
(see `benchmark:native-tests` in `package.json` for the exact glob). They are
local benchmark/qualification commands, not merge CI.
After bumping `NATIVE_API_VERSION`, update all six files listed in
[docs/versioning.md](docs/versioning.md#checklist-for-bumping-native_api_version)
and run `pnpm build:native` before `test:coverage` or `verify`; a stale
prebuilt addon fails every native handshake closed instead of reporting a
clear version mismatch.

### Working in a git worktree

Prefer a plain clone or `git worktree add` for isolated agent work. Two traps
have caused repeated real breakage:

- The worktree's root `node_modules` is a symlink into the main checkout's
  pnpm store, not a real pnpm install. Per-package `node_modules/@urdira/*`
  links must point INSIDE the worktree, not back at the main checkout's
  packages — an agent that runs its own install from inside the worktree can
  redirect those links onto the main checkout by mistake. If a link points at
  the wrong tree, delete the broken link and reinstall with
  `CI=true pnpm install --offline --frozen-lockfile` rather than a bare
  `pnpm install`.
- `CARGO_TARGET_DIR` should be shared across worktrees (point it at one
  directory outside any worktree) so parallel agents do not each build a full
  30-50 GB Rust target tree. After a `git reset` in a worktree, remove any
  stale `dist/` output and `*.tsbuildinfo` files before rebuilding — leftover
  build artifacts from before the reset can mask a real compile failure.

Record what changed and what was measured for a performance- or
integrity-sensitive front as a dated file under `docs/evidence/` (one file per
front, named `YYYY-MM-DD-<front>.md`), even when the work does not land in the
same commit as the evidence file.

## Handoff checklist

Before declaring work complete, report:

- the user-visible or internal behavior changed;
- the authoritative documents consulted or updated;
- the packages and tests changed;
- the README and other documentation updates made;
- the exact verification commands and their result;
- any known limitation, incomplete capability, or follow-up that remains.

Do not claim success from compilation alone, from a single targeted test, or
from an implementation plan that has not been verified against the current
source tree.
