# Maintainability and explainability

This repository treats readability as an engineering property. Maintained
production code, support scripts, and tests should make their responsibility,
data flow, invariants, failure modes, and authoritative contract visible to a
new contributor without changing the observable behavior of Urdira.

## Working rules

- Prefer cohesive modules and functions with domain names over cleverness,
  hidden control flow, or duplicated policy.
- Keep filesystem, process, clock, network, and model effects behind explicit
  ports or adapters. Make state transitions and error paths visible.
- Write comments for intent, invariants, security boundaries, and trade-offs;
  do not narrate statements that already say what they do.
- Document exported and non-trivial internal interfaces, including ownership,
  ordering, completeness, determinism, limits, and failure behavior.
- Generated artifacts are never edited by hand. Their header identifies the
  authoritative source and regeneration command.
- A complex algorithm may remain complex when that complexity is intrinsic, but
  it needs a local explanation and a reviewed exception rather than silence.

## Progressive gate

`pnpm check:maintainability` measures JavaScript and TypeScript complexity,
nesting depth, and function size. It excludes generated artifacts, external
fixtures, dependencies, and build output. The checked-in baseline records the
current debt so incremental work cannot add or worsen findings. Findings are
attributed per file so one improvement cannot hide a regression elsewhere.
Resolved entries must be removed from the baseline; permanent exceptions require an explanation
and an owning decision or contract.

Rust quality remains covered by `cargo fmt --check` and workspace Clippy in
`pnpm check:native`. Rust refactors should reduce broad `#[allow]` attributes,
replace argument lists with named context types where appropriate, and explain
any unavoidable algorithmic exception next to the declaration.

## Refactor workflow

For each batch, read the owning decision and package manifest, add or strengthen
characterization tests, make one responsibility-preserving extraction, run the
focused checks, and review the diff for API, serialization, ordering, ownership,
and performance drift. Bugs discovered during a readability refactor are
recorded separately instead of being silently fixed in the same change.
