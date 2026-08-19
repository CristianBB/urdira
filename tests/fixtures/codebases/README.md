# E2E codebase fixtures

This directory contains small, self-contained projects used as source
workspaces for Urdira indexing and query tests. The projects are intentionally
more realistic than single-file examples: they contain modules, public APIs,
implementations, callers, and tests.

The language directories contain the projects themselves. Their adjacent
`.gold.json` files are test-owned semantic expectations and are deliberately
kept outside each project root so a fixture workspace does not index its own
oracle.

## Projects

- `typescript/task-planner`: a strict TypeScript task service with a repository
  port, in-memory implementation, state transitions, and Node tests.
- `javascript/task-planner`: the equivalent JavaScript ESM task service with
  JSDoc declarations, `jsconfig.json`, and Node tests for the bundled analyzer.
- `rust/library-lending`: a dependency-free Rust library with a repository
  trait, generic lending service, error branches, and integration tests.

Run each project's documented build and test commands from its own directory.
The manifests use fixture-local subject IDs and source anchors rather than
workspace-specific Urdira IDs, snapshot IDs, or digests. The JavaScript and
TypeScript manifests are exercised by the bundled production plugin E2E suite;
the Rust fixture remains the language-neutral conformance reference.
