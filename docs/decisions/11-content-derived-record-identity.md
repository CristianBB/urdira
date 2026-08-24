# Content-Derived Record Identity

Status: **Approved and implemented**
Last updated: 2026-08-24
Depends on: Universal data model, incremental indexing semantics, and storage architecture

## Current contract

Urdira separates identity into three layers:

- Source rows remain workspace-bound and are rebuilt for each source binding.
- Canonical record, identity, dependency, and projection identities are derived
  from workspace-relative logical content and lifecycle continuity.
- Publication rows remain workspace-bound. A new workspace always publishes
  its own generation, snapshot, registry, and journal.

`ProposedRecord` contains logical record content only. Workspace and owner
coordinates come from the accepted replacement scope and are persisted as
typed columns; they do not participate in the record-content digest.

`record_digest` covers the logical record. A first occurrence uses
`record:${digest(record)}`. A replacement or reopen adds the exact predecessor
or absence barrier to the identity recipe, so an A-to-B-to-A lifecycle cannot
reopen a closed row under the same `record_id`.

Entity `identity_id` values derive from the identity key and, when required,
the absence barrier. `identity_assignment_id` derives from `record_id` and the
identity key. Workspace isolation is enforced by the workspace database,
`workspace_id`, owner columns, and the checked workspace metadata binding; it
does not depend on salting canonical identities with a machine-local path.

For identity-bearing records, an exact key found under a different owner is an
owner migration. Urdira closes the previous occurrence and mints a new record
and logical identity using the prior identity as a migration barrier. Multiple
active predecessors fail closed with
`core:identity_assignment_conflict/multiple_active_records`.

Projection content digests exclude `workspace_id`. A workspace fork may retain
portable logical identifiers only after rewriting and validating every local
owner, artifact-version, dependency, and projection reference.

## Storage and verification

Record occurrences store the typed envelope in relational columns and the
logical body in `record_value_nodes`. Selected query rows reconstruct the body;
`verify()` recomputes its logical digest from the relational representation.

`record_occurrences.record_digest` is not unique because distinct lifecycle
occurrences may contain identical logical content. `record_id` remains unique
through predecessor and absence-barrier chaining.

The workspace database declares the supported `identity_format`. An absent or
unsupported marker is rejected with a typed reindex requirement. The current
runtime never mixes identity recipes inside one writable data root.

## Consequences

- Content-identical workspaces may share portable canonical identities while
  retaining independent source and publication histories.
- Reuse never continues a closed lifecycle or suppresses dependency edges.
- Workspace fork remains an explicitly verified publication path, not an
  implicit cross-workspace lookup.
- Source observations, provider watermarks, snapshots, registries, candidates,
  and journals remain workspace-specific.
