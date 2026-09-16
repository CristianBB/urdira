# Developing a language plugin

Urdira currently ships one production structural plugin:
`@urdira/plugin-javascript-typescript`. The core remains language-neutral so a
new language must be implemented as a plugin rather than by adding a language
branch to the engine, daemon, storage, query planner, or public MCP contract.

The normative contract is [Decision 02](decisions/02-language-plugin-contract.md)
and its linked [structural indexing fast path](protocol/structural-indexing-fast-path.md).
This page is the implementation guide for contributors.

## What a plugin owns

A language plugin owns:

- source-language parsing and language-specific semantic resolution;
- project/compilation discovery and deterministic analysis partitions;
- language-specific canonical schemas, namespaced record kinds, facets,
  relations, dependency roles, diagnostics, capabilities, and projections;
- the plugin's compatibility declaration, registry contribution, analyzer
  implementation manifest, runtime behavior manifests, and executable builds;
- complete `FactDelta` or `FactDeltaStream@2` output with owner-artifact and
  owner-version provenance.

The core owns source enumeration, immutable views, candidate replacement and
publication, canonical identity finalization, digests, query operations,
ranking, ordering, pagination, semantic model execution, and public result
envelopes. A plugin must never add a query operation, choose result ordering,
read the host filesystem directly, execute a shell command, or carry an
embedding model/runtime.

## Recommended package shape

Start from a separate package, for example `@acme/plugin-rust`, rather than
copying the JavaScript/TypeScript package into the core. A practical layout is:

```text
packages/plugin-rust/
  package.json
  tsconfig.json                 # or the plugin's implementation language
  src/
    index.ts                    # package entrypoint and exported descriptor
    analyzer.ts                 # parsing, partitions, and semantic authority
    worker.ts                   # supervised worker call dispatcher
    registry-contribution.ts    # closed schemas and namespaced definitions
    fact-delta.ts               # validated FactDelta construction
  tests/
    plugin.test.ts
    incremental.test.ts
    protocol.test.ts
```

The package must build a distributable `dist/` tree and list every shipped
file in its `PluginPackageManifest`. Build output, generated declarations,
coverage, and local benchmark results stay out of the source repository.

## Implementation sequence

1. **Choose stable identities.** Select an immutable `plugin_id`, compact
   namespace, SemVer plugin version, language ID, and analyzer ID. Language IDs
   are shared coordinates; plugin record kinds and extension values must use
   the plugin namespace (`rust:entity_struct`, not a new `core:*` value).
2. **Declare language coverage.** Add one canonical `LanguageDefinition` per
   primary language and list accepted artifact-language IDs in the capability
   declaration. Aliases are discovery-only; they are never persisted as the
   language ID.
3. **Define the registry contribution.** Register every value the plugin can
   emit: closed payload schemas, record kinds, universal-kind mappings, facets,
   relation roles, dependency roles, diagnostics, capabilities, structural
   stages, and projection/semantic definitions. Use the SDK validators and
   digest authority; do not hand-write contribution or digest bytes.
4. **Implement the worker contract.** Support `describe`,
   `discover_partitions`, `analyze_artifact`, and, when needed,
   `analyze_closure` and `generate_projection`. Every request is self-contained
   and bounded by the supplied `PluginAnalysisContext` and `PluginResourceBudget`.
5. **Emit validated facts.** Produce exactly one complete `FactDelta` or
   bounded `FactDeltaStream@2` per work item. Use proposal anchor references
   for relationships; the core assigns canonical identities after validation.
   Preserve the exact owner artifact/version and reverse dependencies for every
   source-derived row. Unknown, partial, or unsupported output must use the
   negotiated outcome instead of being silently dropped.
6. **Declare compatibility and executable integrity.** Publish the supported
   plugin/runtime/registry contract versions, dependencies, offered
   capabilities, analysis digest, package digest, runtime component behavior
   manifest, target-specific implementation manifests, and executable asset
   digests. A changed analysis digest intentionally triggers conservative
   reanalysis.
7. **Integrate activation.** Package the complete closure as the explicit
   local `.urdira-plugin` bundle required by
   [Decision 10](decisions/10-daemon-mcp-packaging.md). Installation verifies
   bytes and manifests; workspace activation resolves one exact version and
   publishes the registry, lock, configuration, and code snapshot atomically.
   Installation alone does not activate a plugin.

## Reference implementation map

Use these files as examples, not as an invitation to copy JS/TS assumptions
into the core:

| Concern | JavaScript/TypeScript reference |
|---|---|
| Language constants, capabilities, partitions, analyzer session | [`analyzer.ts`](../packages/plugin-javascript-typescript/src/analyzer.ts) |
| Worker call dispatch and bounded inputs | [`worker.ts`](../packages/plugin-javascript-typescript/src/worker.ts) |
| Closed schemas, kinds, relations, and language definitions | [`registry-contribution.ts`](../packages/plugin-javascript-typescript/src/registry-contribution.ts) |
| FactDelta and structural stream construction | [`fact-delta.ts`](../packages/plugin-javascript-typescript/src/fact-delta.ts) |
| Worker transport and supervision boundary | [`rust-semantic-worker.ts`](../packages/plugin-javascript-typescript/src/rust-semantic-worker.ts) and [`@urdira/plugin-sdk`](../packages/plugin-sdk/src/index.ts) |
| Registry validation and canonical contribution assembly | [`registry.ts`](../packages/plugin-sdk/src/registry.ts) |
| Package/compatibility manifest validation | [`packages.ts`](../packages/plugin-sdk/src/packages.ts) |

## Required tests before proposing a plugin

At minimum, add tests for:

- deterministic parsing and partition ordering across repeated runs;
- malformed source and unsupported syntax diagnostics;
- exact record/dependency provenance and closed payload rejection;
- cross-file references, unresolved references, and deletion/rename behavior;
- cold indexing versus incremental indexing equivalence;
- bounded stream pagination and cancellation/deadline behavior;
- registry, digest, namespace, dependency, and compatibility validation;
- worker restart, protocol errors, resource exhaustion, and incomplete input;
- a small real fixture under `tests/fixtures/codebases/<language>/` with a
  fixture-local expected manifest.

Run the focused plugin tests first, then:

```bash
pnpm check:architecture
pnpm check:maintainability
pnpm lint
pnpm test
pnpm typecheck
pnpm verify
```

Do not add a language-specific exception to a core registry or query path to
make a plugin pass. If the contract cannot express the capability, update the
owning decision and language-neutral contract first.

## Current support boundary

The bundled plugin is the only production language engine today and supports
JavaScript, TypeScript, JSX, and TSX. Other languages have no bundled analyzer;
their source catalog and generic text/index-status capabilities may still be
available, while structural operations requiring a plugin fail explicitly.
