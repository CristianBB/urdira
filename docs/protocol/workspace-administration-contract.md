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
previous snapshot, and schedule one full reconciliation. Overflow, provider
reset, or lost events widen to a full reconciliation before freshness is
reported.
