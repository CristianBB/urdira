# Plugin Resolution Continuity

Status: Accepted
Last updated: 2026-09-09
Depends on: [Configuration and lifecycle](09-configuration-security-lifecycle.md) and [plugin contract](02-language-plugin-contract.md)

## Current contract

Persisted plugin resolution locks are classified as:

- `preserved`: authentic and compatible with the current resolution input;
- `stale`: authentic but no longer matches installed packages, capabilities,
  pins, dependencies, or supported contract versions; or
- `invalid`: malformed, foreign, tampered, internally contradictory, or bound
  to another workspace.

A preserved lock is reused byte-for-byte, including its creation metadata. An
invalid lock fails closed with the registered plugin-resolution error. A stale
lock is resolved again against the complete current package graph.

`resolution_lock_id` includes the full resolution-input fingerprint: resolver
version, supported contracts, requirements, pins, and every discovered
package's identity, version, and digests. Registry and configuration identities
derive from that lock identity. A changed environment therefore creates new
immutable control rows instead of attempting to overwrite prior rows.

When the target resolution differs from the workspace's published resolution,
the next scan:

- forces complete plugin analysis even when source bytes are unchanged;
- forces a candidate generation instead of taking the equivalent-source fast
  path; and
- includes the target resolution in candidate/materialization identity.

Returning to an earlier authentic resolution reuses its persisted lock row.
Candidate materialization identity remains candidate-scoped, so two analysis
generations with equal logical output cannot collide in immutable publication
tables.

## Operational behavior

Resolution continuity is checked whenever a workspace is scanned. An idle
workspace is not proactively reindexed solely because an installed plugin
changed; its status and next scan reveal and apply the new resolution.

Plugin upgrade, downgrade, and rollback all use the ordinary candidate,
validation, publication, and rollback pipeline. A failure leaves the previous
published snapshot and resolution queryable.

## Consequences

- Authentic stale state is recoverable through deterministic re-resolution.
- Tampered state never falls through to a fresh permissive resolution.
- Analyzer changes cannot leave untouched artifacts carrying output from an
  earlier analysis contract.
- Immutable control rows retain exact historical meaning without being used as
  current configuration after a relock.

## Scope note: this decision does not apply to v4 workspaces

This decision governs the JavaScript/TypeScript plugin's `resolve_plugin_provider`
resolution lock (a real fingerprint over resolver version, supported
contracts, requirements, pins, and package identities/versions/digests). A
v4 workspace ([v4 structural store](26-v4-structural-store.md)) has no
plugin registry/configuration/lock concept in this sense: the Rust
`urdira-indexing-worker` owns catalog, parse, and materialize as one pass
with no external plugin-configuration surface yet, so `registry_snapshot_id`,
`configuration_revision_id`, and `resolution_lock_id` are fixed, per-workspace
placeholder strings (`registry:{workspace_id}:v4`, `configuration:{workspace_id}:v4`,
`resolution:{workspace_id}:v4`, `packages/daemon/src/runtime.ts`) that exist
only to satisfy the protocol's `registry_snapshots`/foreign-key placeholder
rows, never classified `preserved`/`stale`/`invalid`. This decision's
continuity contract remains normative for the v3 (non-v4) JS/TS plugin
resolution path.
