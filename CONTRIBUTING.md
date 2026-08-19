# Contributing to Urdira

Urdira welcomes contributions from people and coding agents. Contributions
must preserve the approved architecture, explicit workspace scope,
language-neutral core, read-only public behavior, deterministic exact queries,
source provenance, and persistent pagination.

## Before opening a change

Read:

- [`README.md`](README.md) for the project overview and usage;
- [`AGENTS.md`](AGENTS.md) for the mandatory implementation workflow;
- [`docs/README.md`](docs/README.md) for documentation authority;
- [`docs/product-foundation.md`](docs/product-foundation.md) and the relevant
  approved decision;
- [`architecture/manifest.json`](architecture/manifest.json) for package
  ownership and allowed dependencies.

If the requested behavior is not defined, do not invent a local interpretation
in code. Add or update the appropriate architectural decision first, then
derive the implementation design and tests from it.

## Change workflow

1. Keep the change focused on one behavior or one coherent architectural
   decision.
2. Add a failing test that captures the intended behavior before production
   implementation.
3. Implement through the owning package and its explicit ports. Preserve the
   dependency direction and avoid importing infrastructure into contracts or
   canonical logic.
4. Validate malformed, incomplete, stale, paginated, and failure cases where
   the behavior has those dimensions.
5. Update `README.md` whenever the project description, public usage,
   supported capability, command, or limitation changes.
6. Update the authoritative architecture and protocol documents in the same
   change whenever the behavior is normative.
7. Run targeted verification followed by `pnpm verify`.

## E2E codebase fixtures

Reusable source workspaces belong under
[`tests/fixtures/codebases`](tests/fixtures/codebases), grouped by language.
Keep each project independently buildable, deterministic, dependency-light,
and small enough for repeatable indexing tests. Put its gold manifest beside
the project root so the oracle is not indexed as project source. Gold manifests
use fixture-local IDs and registered core operation/relation values; they must
not introduce public API identifiers or workspace-specific Urdira IDs.

## Where changes belong

| Change | Primary location |
|---|---|
| Reusable TypeScript/Rust e2e workspace or gold manifest | `tests/fixtures/codebases/` and its fixture-contract test |
| Shared model, field, lifecycle, or identity | `docs/decisions/01-universal-data-model.md` and `@urdira/contracts` |
| Public operation, recipe, error, or MCP field | `docs/protocol/` and `@urdira/contracts` / `@urdira/mcp` |
| Canonical encoding, comparator, or digest | `docs/serialization/` and `@urdira/canonical` |
| Closed diagnostic or issue code | Its owning registry under `docs/` and the contracts registry |
| Workspace, watcher, or provider behavior | Workspace decision and `@urdira/engine` |
| Durable storage, projection, or publication | Storage decision and `@urdira/storage` / `@urdira/engine` |
| Plugin protocol or worker supervision | Plugin decision and `@urdira/plugin-sdk` |
| Semantic documents, vectors, or coverage | Semantic decision and core semantic engine |
| Daemon, CLI, MCP transport, or release archive | Daemon/MCP decision and owning adapter package |
| Review, phase, or release evidence | `docs/evidence/` |

Generated schemas, declaration files, build output, coverage output, release
archives, private workflow reports, and raw benchmark transcripts are not
authoritative source files and do not belong in the public repository.

## Pull request or agent handoff checklist

- [ ] The change has a focused test-first justification.
- [ ] The relevant authoritative document was read and remains consistent.
- [ ] Public fields, identifiers, errors, and schemas are closed and documented.
- [ ] Every source-derived record keeps owner-artifact provenance.
- [ ] Workspace and snapshot scope are explicit; no connection-local fallback
      was introduced.
- [ ] Exactness, completeness, evidence, diagnostics, snippets, and pagination
      behavior are covered where relevant.
- [ ] No language-specific behavior leaked into the core, and no arbitrary
      command execution, source mutation, or hidden network transport was added.
- [ ] `README.md` was updated if user-facing behavior or project instructions
      changed.
- [ ] `pnpm verify` passes.
- [ ] The final summary includes tests, documentation, and known limitations.

## Reporting conflicts and security issues

When two architecture documents disagree, report the exact documents and
sections and stop implementation at that boundary until the authority is
resolved. Do not paper over the disagreement in a plan or test.

Do not include secrets, absolute private paths, credentials, or sensitive
source excerpts in issues, tests, diagnostics, or agent handoffs. Security
boundary changes must include adversarial tests and the relevant security
decision update.
