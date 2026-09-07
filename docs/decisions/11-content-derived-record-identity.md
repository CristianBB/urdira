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

## v4 incremental `records` root is not comparable to a cold oracle (Frente E-P0e, 2026-09-07)

v4's `Delta`/`Reconcile` pipeline (`crates/urdira-indexing-worker/src/v4/diff.rs::diff_owner`)
implements this decision's replacement/reopen/migration chaining with a NEW, v4-only recipe --
`chained_record_id = H("urdira:v4-record-chain:v1\0" || record_digest || predecessor_record_id)`
-- for any identity whose content actually changed since the workspace's last publish. A
from-scratch cold scan of the identically mutated tree has no prior generation to chain against at
all, so it always mints the kernel-cold `record_id = sha256(record_digest)` instead. Both sides
agree on `record_digest` (a pure function of an identity's CURRENT logical content, workspace- and
history-independent -- this decision's own "logical record content only" contract) for the exact
same final tree; only `record_id` legitimately diverges for a touched identity.

**Consequence**: the v4 `records` Merkle root (`H` over the `(record_id, record_digest)` pairs of
every live row) can NEVER be expected to equal an independent cold oracle's `records` root once any
identity has actually been replaced/reopened/migrated -- by design, not a bug. `dependency` and
`graph` carry no such chaining (`dependency_id`/relation identity never varies with content) and DO
match an independent oracle exactly. This was suspected as early as
`docs/evidence/2026-09-06-v4-reconcile-threshold.md` §9.2 and confirmed exactly by name in
`reconcile_modify_produces_a_self_consistent_incremental_merkle_update`'s own doc comment
(`crates/urdira-indexing-worker/src/v4/tests_e2e.rs`); Frente E-P0e closed the loop with live n8n
data (N=202 and N=1008 touched files, `docs/evidence/2026-09-06-v4-reconcile-threshold.md` §14).

**The comparability gate for `records` is therefore the LOGICAL SET, not the raw root**: key by
`identity_key` (workspace/history-independent), and require, between an incremental store and an
independent oracle of the identically mutated tree:

1. Every identity present on one side is present on the other (no missing/no phantom row).
2. Every identity's `record_digest` is identical on both sides (digest depends only on current
   content, so this must ALWAYS hold, whether or not that identity was ever chained).
3. A `record_id` difference is legitimate ONLY for an identity under a TOUCHED owner (this
   incremental run's own reprocessing); an untouched owner's identity keeping a *different*
   `record_id` than the oracle would mean undue reanalysis, not legitimate chaining.

`crates/urdira-indexing-worker/src/v4/tests_e2e.rs::records_logical_set_diff`/
`RecordsLogicalSetReport::assert_matches_oracle` implement exactly this gate, wired into
`scripts/v4-reconcile-threshold.mjs`'s fraction-sweep `roots_ok` computation for `records`, and into
the `tests_e2e.rs` e2e suite (`reconcile_modify_produces_a_self_consistent_incremental_merkle_
update`, `reconcile_batches_match_cold_at_1_5_10_25_50_percent`, both edit-inclusive).

**One documented, owner-approved exception**: `jsts:external_module:*`/`jsts:external_symbol:*`
identities are cross-owner-deduped (`analyze.rs::dedupe_external_entities_across_owners`'s own doc
comment) -- exactly one importer "owns" each shared external identity at a time, chosen
deterministically (alphabetically-first CURRENTLY-SCANNED owner) but re-derived per batch. Editing
or removing the current owner while a different, unscanned importer still needs the identity closes
it (temporarily; it reopens, chained, on the next scan that touches any surviving importer, or
always on a full cold rescan) -- an already-decided, self-healing tradeoff, not a bug, and
indistinguishable from real loss by a single-batch touched/untouched split alone. Measured at real
n8n scale (§14 below): 100% of every gate-violating anomaly at both N=202 and N=1008 landed on this
exact identity-kind pair; zero for every other kind at either scale. The comparator mirrors these
into their own, deliberately unasserted `external_*` counters so a real, non-external anomaly is
never masked by this pre-existing, accepted tradeoff.

## Consequences

- Content-identical workspaces may share portable canonical identities while
  retaining independent source and publication histories.
- Reuse never continues a closed lifecycle or suppresses dependency edges.
- Workspace fork remains an explicitly verified publication path, not an
  implicit cross-workspace lookup.
- Source observations, provider watermarks, snapshots, registries, candidates,
  and journals remain workspace-specific.
