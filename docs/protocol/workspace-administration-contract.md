# Workspace administration contract

Status: **Approved**

Workspace administration is a transactional control plane. Detection produces
`WorkspaceTechnologyProposal` evidence; it never becomes canonical indexed
knowledge until the user confirms technologies and, in a separate step,
compatible installed plugins.

## Proposal identity

Every proposal carries the provider fingerprint, Git state fingerprint, plugin
catalog fingerprint, deterministic evidence list, and a proposal digest. A
confirmation whose current fingerprints differ is rejected as a stale proposal
and the assistant must run detection again.

## Configuration attempts

`WorkspaceConfigurationAttempt` is immutable and records the selected impact:
`query_only`, `analysis`, `source_selection`, `plugin_resolution`, or
`semantic_projection`. Configuration issues are closed values:
`invalid_config`, `stale_proposal`, `plugin_unavailable`,
`plugin_incompatible`, `technology_unconfirmed`, and `reindex_required`, each
with severity `info`, `warning`, or `error`.

Valid `.urdira/config.json` changes are applied through the same transaction as
administrative configuration. Invalid JSON or invalid roots remain visible in
the latest attempt and leave the active configuration and last published
snapshot untouched.

## Watcher boundary

The watcher is created only after both confirmation steps. One serialized
watcher is retained per workspace and restored by the daemon. Git `HEAD` and
worktree administration events preserve the workspace identity, stale the
previous snapshot, and schedule one reconciliation scan. Overflow, provider
reset, or lost events widen to that same reconciliation before freshness is
reported. For a v4 workspace, reconciliation is `ScanScope::Reconcile`: the
worker measures the authoritative delta against the current frontier and
republishes through the cheap incremental pipeline when it stays under
`RECONCILE_DELTA_THRESHOLD` (`0.01` of the frontier), only falling back to a
full rescan when the delta crosses that threshold or the incremental attempt
itself fails (see [current architecture](../architecture.md)); a v3 workspace
always widens to a full reconciliation. On macOS the watcher uses the native
`kqueue` backend rather than FSEvents for a workspace under roughly 2,000
files, preventing client-queue drops during large indexing operations; a
larger workspace uses the `fs-events` backend instead so `kqueue`'s per-file
descriptor budget cannot be exhausted. The same inclusion exclusions apply to
every native backend.

## Administrative listing and Codebases

`workspace list` returns active workspaces and recoverable removed tombstones;
`workspace show <workspace_id>` returns one explicit administrative record.
When a Git worktree is available, registration persists its common-repository
identity, ref kind and name, head revision, detached flag, dirty flag, and
capture time. Structured status and administrative views include the effective
`project_name`, `workspace_label`, normalized branch name, short commit,
directory/worktree kind, and observation age. These absolute-path administrative views remain CLI/local-web
data and never enter public MCP query results.

While a workspace has lifecycle status `indexing`, the local administrative
view may additionally expose transient `indexing_activity` with the closed
values `indexing` or `checking_for_updates`. A watcher event, explicit reindex,
initial scan, or recovery scan reports `indexing`. The periodic reconciliation
backstop for an otherwise ready workspace reports `checking_for_updates` until
it proves equivalence or discovers work to publish. This presentation field is
process-local, is not persisted, and is deliberately absent from public query
pages and agent MCP output.

A `Codebase` is the effective project grouping of related Workspaces.
`codebase list/create/rename/assign/unassign/remove` are the grouping
operations. Registration automatically reuses an active Codebase only for an
exact captured Git common-repository identity; independent clones require
confirmed manual assignment. Non-Git registrations receive independent
Codebases. Unassigning, or removing a Codebase, creates independent replacement
groups for active members and retains every Workspace.

New workspace identifiers use `workspace:<project-slug>:<uuid>`. The slug is
informative, the UUID is stable identity, and legacy identifiers are preserved.
Root resolution accepts an explicit registered root or nested directory and
selects the most-specific containing Workspace; its returned query scope must
be copied into each agent or web query rather than stored as global state.

Workspace removal retains the existing recoverable tombstone. Physical purge
of one named removed workspace (`workspace purge`, `core:workspace_purge`)
remains a separate destructive operation and is never implied by removing a
Workspace from the local UI.

## Orphaned workspace data

`workspace orphans` (`core:workspace_orphans_list`, read-only) reports
on-disk workspace footprints -- the catalog database plus its v4
`.structural`/`.sidecar` directories or v3 sibling files -- that have no
active or tombstoned workspace registration pointing at them, typically left
behind by a crash between deleting the registration and deleting its data. A
periodic sweep runs the same detection at daemon startup. `workspace orphans
purge` (`core:workspace_orphans_purge`, destructive) removes one or every
listed orphan's complete on-disk footprint; it never touches a registered or
tombstoned workspace's data.
