# Workspace Fork

Status: Accepted
Last updated: 2026-09-09
Depends on: [Content-derived record identity](11-content-derived-record-identity.md), [workspace indexing](04-workspace-snapshot-incremental-indexing.md), and [storage](05-storage-projection-architecture.md)

## Current contract

A newly registered workspace may bootstrap from another `ready` workspace on
the same installation when both represent exactly the same visible source and
resolve the same plugin analysis contract. Fork is an automatic first-scan
optimization. It never changes source identity, workspace isolation,
publication semantics, or the full-scan fallback.

**Current reachability**: `attemptWorkspaceFork`'s donor bulk-copy writes
target structural rows through the TypeScript storage adapter
(`packages/engine/src/workspace-fork.ts`), so the daemon only enters it when
the resolved plugin carries no Rust indexing-core generation port
(`plugin.indexing_core === undefined`, `packages/daemon/src/runtime.ts`).
Since the Rust cutover ([Rust native acceleration](25-rust-native-acceleration.md))
is the default production route for the JavaScript/TypeScript plugin, and v4
([v4 structural store](26-v4-structural-store.md)) is the default for newly
added workspaces, this predicate is false in ordinary production use today:
production falls through to the ordinary Rust-backed full or incremental
scan instead of forking. The mechanism below remains live for a
non-Rust-core plugin resolution (compatibility/test route) and documents the
byte and publication contract a future Rust-native donor-copy command would
have to preserve; no such command exists yet (confirmed: no donor/fork
copier in `crates/urdira-indexing-worker`). v4's own answer to "an existing
tree already has published bytes on disk" is the `reconcile` scope
described in [v4 Rust-owned scan pipeline](29-v4-rust-owned-scan-pipeline.md),
which is a different mechanism (git-checkout/pull equivalence on an
ALREADY-registered workspace) from this decision's donor-to-new-workspace
bootstrap.

## Donor selection

A donor must:

- be a different registered workspace in `ready` state;
- have the same selected plugin set;
- resolve the same plugin identities, versions, declaration digests,
  contribution digests, analysis digests, and configuration contract; and
- have the exact same sorted `(normalized_uri, content_hash)` source multiset.

Git common-directory and peeled-HEAD equality is only an ordering hint. It may
place the likely donor first, but it never proves content identity because
untracked files can still be inside the workspace inclusion scope.

The source multiset comparison is authoritative and always runs. Donor reads
use the narrow visible-artifact projection rather than hydrating canonical
records or computing a full Git status.

## Execution flow

1. Enumerate and hash the target source without publishing it.
2. Select and verify a donor and its plugin resolution.
3. Capture and validate the target source layer through `GenericSourceIndexer`,
   including normal byte reads, CAS writes, lengths, and content-digest
   verification; defer its typed rows to the persistent Rust indexing core for
   the single SQLite commit (the direct TypeScript commit is test/oracle-only).
4. Copy the donor's visible canonical rows into the target database while
   rewriting target-local ownership and dependency references.
5. Build and atomically publish a fresh target generation and snapshot.
6. Verify the published target. Any failure rolls back every fork-owned source,
   canonical, projection, control, and publication row; source recovery uses
   the Rust `source_index_rollback` command on the production route.

If a precondition is absent or a check fails, the daemon runs the ordinary
progressive scan. A skipped or failed fork must never leave state that changes
the fallback scan's interpretation of a first publication.

## Copied and rebuilt state

Visible record occurrences and identity assignments are copied with bounded
cross-database relational operations. Logical `record_id`, `record_digest`,
and portable identity values remain unchanged; target `workspace_id`, owner
artifact coordinates, validity, and first-open state are target-local.

Artifact dependencies are rebuilt against the target's artifact map.
Projection occurrences rewrite owner and source references and mint target
projection occurrence identifiers when their contract is workspace-local.
Rows with unresolved rewritten inputs are rejected rather than published
dangling.

Capability-state entries are copied and verified so the target snapshot reports
the same proven capabilities as the donor. Lexical FTS state and other
rebuildable caches are not copied; their normal reconcilers rebuild them from
the published canonical/CAS authority.

Snapshots, candidates, registries, journals, generation manifests, control
state, retention rows, and workspace metadata are never copied as donor rows.
The target mints them through its fork-specific publication plan.

## Publication and integrity

Fork publication uses the same transaction checkpoints, immutable-row checks,
current-pointer compare-and-swap, logical digest recipes, and rollback rules as
ordinary publication. It computes target snapshot and set digests from the
copied relational rows without re-running plugin analysis.

Post-copy verification checks at least:

- source path/content equality;
- canonical record count and record-set digest;
- identity, dependency, projection, and capability-state integrity;
- target owner mappings and workspace binding;
- source-state and snapshot anchors; and
- database integrity and current-generation visibility.

The fast verifier may avoid hydrating every logical record, but it cannot skip
an anchor or ownership check. Full verification remains available as an
operational diagnostic.

## Scheduling and recovery

Watcher hints under excluded `.git/**` paths do not schedule content scans.
Git HEAD/index/administrative changes that can alter the visible tree retain
their authoritative full-reconciliation classification.

The first workspace scan remains protected until `has_completed_first_scan`
is true; progressive publication of an intermediate structural snapshot does
not make trailing checkout events eligible to abort that same initial scan.

A daemon restart reloads persisted plugin resolution state. An authentic and
still-compatible lock is reused byte-for-byte; a genuine resolution change
mints a new lock/configuration identity and forces complete reanalysis.

## Boundaries

- Fork is same-installation only and has no independent public or MCP command.
- It does not skip target source enumeration, byte reads, hashing, or CAS
  verification.
- It applies only before the target has completed its first scan.
- It does not share mutable SQLite generations or query caches across
  workspaces.
- Disabling the optimization changes performance only; the progressive scan
  remains authoritative.

## Historial de cambios

- **2026-08-31** (Rust cutover): the donor-row bulk copier became
  compatibility/oracle-only once a persistent `urdira-indexing-worker` was
  available in production — the daemon stopped entering it (and the engine
  rejects an injected Rust writer at its boundary) so exactly one production
  structural SQLite writer remains; folded into "Current reachability" above.
- **2026-09-06/09** (v4 structural store campaign): v4 became the default
  for newly added workspaces, widening the set of installations for which
  this decision's copier is unreachable; the analogous "already-published
  tree" optimization for v4 workspaces is the `reconcile` scope in
  [decision 29](29-v4-rust-owned-scan-pipeline.md), not this mechanism.
