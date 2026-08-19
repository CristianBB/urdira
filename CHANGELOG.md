# Changelog

All notable user-visible changes are documented here. Urdira follows the
repository's [semantic versioning policy](docs/versioning.md).

## [0.1.0] - 2026-08-19

Initial public release candidate:

- local daemon, CLI, and four-tool MCP interface;
- explicit multi-workspace scope and immutable snapshot/cursor execution;
- deterministic structural, lexical, semantic, source, context, and impact
  query families;
- bundled JavaScript/TypeScript analyzer with progressive structural stages;
- durable SQLite/CAS storage, candidate publication, recovery, retention, and
  guarded workspace purge;
- optional user-scoped integrations for supported coding agents;
- public npm package graph (`urdira` and `@urdira/*`) plus deterministic
  platform archive tooling; and
- frozen Vite comparative benchmark protocols and digest-bound summaries.

The release must not be tagged or published until every gate in
[docs/release.md](docs/release.md) is complete.
