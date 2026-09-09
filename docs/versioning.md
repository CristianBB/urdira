# Versioning Policy

Status: Approved (policy set by the project owner, 2026-08-13)
Last updated: 2026-09-09

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
| Bug fix that restores already documented behavior without changing valid data, query results, public request schemas, or persisted formats | patch | patch |
| No observable output difference (pure performance, internal refactors, comment/doc changes, byte-identical encoder rewrites) | patch | patch |

The test is not "did an interface change" but "could anything downstream —
a cache, a stored row, a fact delta, a user reading results — tell the
difference between the two versions given identical inputs?" If yes, the
change is breaking, and in `0.x` the minor slot is the breaking slot.

An error path becoming successful, progress becoming visible, or a lifecycle
command finally completing its documented operation is a patch when valid
inputs, stored state, and successful-operation results retain their contract.
It becomes a minor/major change only when the fix necessarily changes those
contracts or invalidates behavior that was previously documented as valid.

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
   re-locks and publishes an upgrade generation per workspace. This can
   require full analysis and publication; its cost depends on the workspace
   format, corpus and enabled checker/provider configuration. The historical
   v3 estimate is not a v4 upgrade benchmark. Each workspace retains its prior
   generation until the upgrade generation lands, subject to query admission.

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

## v4 index-contract bump (2026-09-03)

The v4 structural store, digest recipes, and Rust-owned scan pipeline
(`docs/decisions/26-v4-structural-store.md` through
`docs/decisions/29-v4-rust-owned-scan-pipeline.md`) are a breaking
storage-and-behavior change under the rule above: a stored row, a query
result, and a digest value can all tell v4 apart from v3 given identical
inputs, so this is a minor bump while the project is `0.x` (the same slot
decision 22's v3 cutover used), not a patch, regardless of how the change is
gated at runtime.

The runtime consequence follows decision 22's own destructive, non-migrated
boundary, extended unchanged: `index_contract` gains a new value (`0x34`)
disjoint from v3's `0x33`. The current daemon includes separate v3 and v4
readers and selects one per workspace; neither reader interprets the other
format. There is no in-place v3-to-v4 conversion. The
`recreateOutdatedWorkspaceDatabase` recovery path applies to unsupported or
outdated data, moving it aside and reindexing; it does not convert a healthy
v3 workspace merely because v4 became the default. To select v4 for an
existing source tree, register it into a fresh workspace store. CAS content may be
reused across the boundary only when its scope, length, and digest all
verify, per decision 22's existing policy.

### Default flip (2026-09-04, P4-b-2)

v4 is now the **default format for NEW workspaces**: `isV4Enabled()`
(`packages/daemon/src/runtime.ts`) selects v4 unless `URDIRA_V4` is set to
the exact string `"0"`. `URDIRA_V4=1` still works (redundant with the new
default) so nothing that already sets it explicitly needs to change. This
flip only decides the format a workspace gets stamped with the first time
its database file is created (`ensureV4Workspace`/`maybeBootstrapV4Workspace`
no-op the instant that file already exists) -- it is not a migration:

- An **existing supported v3 workspace keeps working as v3 in this release**, with no
  automatic conversion. The P4-a/P4-b-prep "outdated workspace" recreation
  path (`recreateOutdatedWorkspaceDatabase`) only fires for a genuinely
  **outdated/unsupported** `index_contract` (a stale pre-v3 layout, or a v3
  database missing a required migration) -- a healthy, current v3 database
  (`0x33`) is not outdated and is never recreated by this flip.
  `DaemonRuntime.start` logs one line at every startup naming how many
  catalogued workspaces are currently v3 versus v4
  (`DurableStorage.workspaceFormatCounts`, tallied during the same
  `recoverMigrations` sweep that already opens every catalogued workspace at
  startup -- no extra file opens).
- The opt-out (`URDIRA_V4=0`) is intended for **one release**: a later
  release may remove the v3 route entirely, at which point `isV4Enabled`
  and the flag itself go away. Until then, every workspace-registration path
  (the daemon's `core:workspace_add` RPC, the CLI, the web UI, and any
  composing application) goes through this same, single decision function --
  there is no second place a workspace's format is decided.
- A test suite that starts a bare `DaemonRuntime`/`DurableStorage` without
  wiring a v4 scan transport must still get v3 (most of this repository's
  own pre-existing tests do exactly that): `vitest.config.ts` sets a
  suite-wide baseline of `URDIRA_V4=0`, and individual tests that want the
  v4 route override it locally, exactly as they did before this flip.

No default flip or existing-workspace migration path existed before this
note (decision 29's own "Open items" listed the flip as outstanding for P4);
migration of already-registered v3 workspaces onto v4 remains unaddressed.

## Current checkout coordinates

| Coordinate | Value | Meaning |
|---|---|---|
| Application/bootstrap package | `0.3.3` | Manifest version; later local changes remain Unreleased until versioning and release gates are completed. |
| JS/TS plugin | `0.6.0` | Analyzer behavior/cache/lock identity, independent of the application version. |
| Native binding API | `17` | Compiled addon handshake, including resident vector registration/top-K. |
| v3 / v4 index contract | `0x33` / `0x34` | Per-workspace structural/digest format selection. |
| v4 segment header | `6` | Native base/delta layout, including mandatory `entities.index`. |

The v4 behavior/storage change still requires the version-policy treatment
above before publication. This documentation update does not assign a new
release number or claim that current local commits are published.

## Checklist for bumping `NATIVE_API_VERSION`

`NATIVE_API_VERSION` (`packages/native/src/loader.ts`) identifies the native
addon/worker handshake shape used by the Rust structural kernel
(`crates/urdira-native-node/src/lib.rs`). Unlike the plugin version above, it
has no single source of truth read across every boundary: the value is
duplicated across six files, and a bump that updates only some of
them fails closed with "Rust semantic bridge structural kernel binding is
incompatible" (observed live during the S-I bump from 16 to 17, when the
semantic-worker literal was left behind). Every bump must update all six files in
the same change:

1. `packages/native/src/loader.ts` — the canonical constant, checked against
   the addon binding, offline manifest, and build-id computation.
2. `crates/urdira-native-node/src/lib.rs` — the Rust-side `NATIVE_API_VERSION`
   constant returned by the addon's `nativeApiVersion()` export.
3. `scripts/package-npm.mjs` — packaging-time manifest literal.
4. `scripts/native-release.mjs` — release-artifact manifest literal.
5. The semantic child-process handshakes in
   `packages/plugin-javascript-typescript/src/rust-semantic-worker.ts` and
   `packages/plugin-javascript-typescript/src/semantic-process-worker.ts`,
   which cannot import the shared constant across the child-process boundary
   and duplicate it as a literal instead.

After bumping, `pnpm build:native` must rebuild the addon and worker before
`pnpm verify`/`pnpm test:coverage` run, or the stale prebuilt binary will
still advertise the old version and every handshake will fail closed.
