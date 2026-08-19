# Versioning Policy

Status: Approved (policy set by the project owner, 2026-08-13)
Last updated: 2026-08-13

This document defines when a version number in this repository takes a major,
minor, or patch bump, and what a bump of the JS/TS analyzer plugin version
mechanically causes at runtime. It exists because the FIRST analyzer revision
that changed analysis output was mislabeled a patch (`0.1.0 -> 0.1.1`,
corrected to `0.2.0` the same day): the machinery did not care, but the number
told humans the wrong thing.

## The rule

Semantic versioning, applied to OBSERVABLE BEHAVIOR, not to API surface alone:

| Change | While in `0.x` | Once past `1.0` |
| --- | --- | --- |
| Output-changing or behavior-breaking revision (any consumer could observe a difference: analysis results, closure completeness, record/digest values, wire payloads, defaults that alter results) | **minor** (`0.1.x -> 0.2.0`) | **major** |
| Backwards-compatible additions (new optional fields, new calls, new env knobs that default to old behavior) | minor | minor |
| No observable output difference (pure performance, internal refactors, comment/doc changes, byte-identical encoder rewrites) | patch | patch |

The test is not "did an interface change" but "could anything downstream —
a cache, a stored row, a fact delta, a user reading results — tell the
difference between the two versions given identical inputs?" If yes, the
change is breaking, and in `0.x` the minor slot is the breaking slot.

When in doubt, bump the larger slot: the runtime cost of a bump is identical
either way (see below), so the only thing a too-small bump saves is honesty.

## What the plugin version mechanically gates

`JAVASCRIPT_TYPESCRIPT_VERSION` (packages/plugin-javascript-typescript/src/analyzer.ts,
kept in lockstep with that package's `package.json` version and the three test
pins that assert its propagation) is an identity token, not a compatibility
range. ANY change to it, patch or major alike, causes:

1. **Durable analysis cache invalidation** — the version feeds
   `durableAnalysisCacheKey` (worker.ts), so every cached whole-project
   analysis written by another version misses. This is deliberate: an
   analyzer whose output changed must never serve results computed under old
   semantics as current.
2. **A one-time fleet republish** — each workspace's plugin resolution lock
   pins the version it was analyzed under; on the next daemon start the
   stale-lock re-resolution path (decision 14, `docs/decisions/14-plugin-upgrade-relock.md`)
   re-locks and publishes an upgrade generation per workspace. At real
   repository scale this is roughly one full analysis (~25s per 700-file
   workspace) plus a publish, per workspace, sequentially — minutes for a
   fleet. Queries stay available throughout (each workspace serves its prior
   generation until its upgrade generation lands).

Because the machinery reacts identically to every bump, the version number's
ONLY job is communication — which is exactly why the table above must be
followed even when "it doesn't matter to the code."

## Checklist for bumping the analyzer plugin version

1. Decide the slot from the table (output changed at all => minor while 0.x).
2. Update `JAVASCRIPT_TYPESCRIPT_VERSION` (analyzer.ts) AND
   `packages/plugin-javascript-typescript/package.json` together, and state in
   the constant's comment WHAT changed and why it is (or is not) breaking.
3. Update the `plugin_version` pins in
   `tests/javascript-typescript-plugin.test.ts`,
   `tests/javascript-typescript-thread-transport.test.ts`, and
   `tests/javascript-typescript-e2e.test.ts`.
4. Note in the commit message that the next daemon start republishes existing
   workspaces once.

## Other versioned surfaces

The same table applies to every other version this repository controls —
package versions, wire `protocol_version`s, schema/format versions, embedding
profile/binding identities. Note that several of those have their own,
stricter regime documented elsewhere (canonical encoding versions and digest
recipe versions in `docs/serialization/`; embedding profile identity rules in
`docs/decisions/16-semantic-search-wiring.md` — where any output-affecting
change mints a NEW identity rather than reusing a bumped one). Where such a
regime exists, it wins; this document covers the plain semver surfaces.
