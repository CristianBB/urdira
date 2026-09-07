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

## Parameter identity, and same-generation duplicate proposals (2026-09-07)

A parameter's `identity_key` is its `entity_id`, `jsts:parameter:{path}:
{nameStart}:{name}` -- keyed by the parameter's OWN binding identifier byte
offset (`declaration_id(DeclKind::Parameter, path, ident.span.start, name)`,
`crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`), the same recipe
every other entity kind uses. This is investigated-and-confirmed collision-
free for the adversarial shapes one might expect to break it: two overload
signatures of the same function reusing a parameter name, two overloaded
interface method signatures, a getter/setter pair, and two `declare module`
function overloads -- every one of these declarations has its OWN parameter
binding identifier at a distinct byte offset, so `identity_key` never
collides between them (`overload_and_accessor_parameters_of_the_same_name_
never_collide`, `semantic_sites.rs`; `n8n_corpus_identity_key_collisions_
are_only_external_modules`, the same file, over the real n8n corpus:
720,953 distinct identity_keys, zero parameter/variable collisions). An
ordinal-based alternative (signature-ordinal-within-file + parameter-index,
instead of byte offset) was considered and rejected: it would add a moving
part (signature ordinal tracking) to solve a collision that does not occur
under the current byte-offset recipe, and byte-offset identity is already
the documented, uniform recipe every entity kind shares -- switching only
parameters to a different recipe would itself be a fidelity regression.

The identity recipe genuinely DOES produce the same `identity_key`,
`record_digest`, and `record_id` for two DIFFERENT owners in one
scenario, BY DESIGN: `jsts:external_module:*`/`jsts:external_symbol:*`
entities are a pure function of the external specifier/name alone, never
the importing file (`external_module_entity`'s own doc comment,
`crates/urdira-jsts-syntax-worker/src/lib.rs`) -- every file that imports
the same external package proposes the identical entity. Multiple owners
sharing one identity within an established workspace already resolves
correctly (an existing "owner migration"/reuse path, `ON CONFLICT DO
NOTHING` on the affected `INSERT ... SELECT`s). The v3 SQL "direct
publication" fast path used for a workspace's first-ever (cold) generation
(`crates/urdira-indexing-worker/src/main.rs`'s `record_insert_sql`/
`direct_sql`/`identity_insert_sql`/`direct_identity_sql`, the `!records_
exist`/`!identities_exist` branches) used to skip that conflict handling
entirely for performance (a virgin table has nothing to probe against), so
the SECOND owner proposing an already-staged external entity crashed the
whole generation with `UNIQUE constraint failed: record_occurrences.
record_id` -- reliably, on any corpus with two or more files importing the
same external package (confirmed on the real n8n corpus at 3,525,385
staged rows, and reproduced with a two-file fixture in under 10 seconds).
Fixed by de-duplicating those four cold-branch `INSERT ... SELECT`s to
exactly one representative row per `record_id` (the lowest `row_ordinal`/
`rowid`, i.e. the first owner staged for that identity this generation) --
every OTHER row for that `record_id` is content-identical by construction,
so keeping any one of them loses nothing.

## Consequences

- Content-identical workspaces may share portable canonical identities while
  retaining independent source and publication histories.
- Reuse never continues a closed lifecycle or suppresses dependency edges.
- Workspace fork remains an explicitly verified publication path, not an
  implicit cross-workspace lookup.
- Source observations, provider watermarks, snapshots, registries, candidates,
  and journals remain workspace-specific.
