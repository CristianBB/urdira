# Content-Derived Record Identity

Status: **Approved**  
Last updated: 2026-08-12  
Depends on: Universal data model, incremental indexing semantics, storage and projection architecture

## Decision objective

Make every id and digest in the canonical layer (`record_occurrences`, `identity_assignments`, `artifact_dependencies`, `projection_occurrences`) a pure function of workspace-relative content, so a future workspace fork can byte-copy those rows between workspaces, rewriting only plain columns (`workspace_id`, owner artifact ids) with no digest recomputation. This is the phase-1 groundwork for a "workspace fork" primitive for git worktrees: forking a workspace for a worktree should not require re-running every plugin over content the target worktree already shares with its source.

## Note on numbering

The spec that produced this decision named it `05-content-derived-record-identity.md`. Decision 05 is already `05-storage-projection-architecture.md`; decisions 01 through 10 are all filled. This document is filed as **11** instead, the next free number, to keep the existing sequence intact. Its content, scope, and the amendment to decision 04 below are otherwise exactly what was specified.

## Layer split

Urdira's persisted state has three layers with three different identity policies, and this decision touches exactly one of them:

- **Source layer** (`source_artifacts`, `source_observations`, `artifact_versions`, observation batches) stays workspace/machine-salted and is always rebuilt fresh per checkout. It is not touched by this decision.
- **Canonical layer** (`record_occurrences`, `identity_assignments`, `artifact_dependencies`, `projection_occurrences`) is de-salted by this decision: every digest that mints an id now covers only workspace-relative content, never `workspace_id` or an owner artifact id.
- **Publication layer** (snapshots, registry, candidates, journal) stays salted. `snapshot_digest` still covers `workspace_id`; a fork mints fresh snapshots rather than copying them.

## The identity changes

- `ProposedRecord` (the plugin-facing proposal shape) no longer carries `workspace_id`, `owner_artifact_id`, or `owner_artifact_version_id`. A record is now pure content: `{ proposal_record_key, category, kind, universal_kind, facets, schema_version, source_span, identity_key, body, evidence_references }`. Its owner is supplied by the replacement scope that produced it and the work item / candidate that scoped the scope, not by the record itself.
- `record_digest` is `digest(record)` over that pure-content shape: two `ProposedRecord`s with identical content at identical workspace-relative paths in different workspaces now produce the identical digest.
- `record_id` is minted `record:${digest(record)}` on a genuinely first open (no visible previous record under the identity key, no absence barrier). On a **replacement** of a visible previous record, or on an **absence-barrier** reopen, the id is chain-salted: `record:${digest({record, previous_record_id})}`, `record:${digest({record, absence_barrier})}`, or their composition when both apply. The chain salt exists so an A→B→A content revert never re-mints the id of its own closed history row — reverting content legitimately reuses `record_digest`, but the newly opened row must still get a distinct `record_id` from the row it is not the same occurrence as. First-time opens of content-identical files across workspaces still collide (the fork property); records with edit history may diverge across workspaces, which is fine, because a fork copies only currently-visible rows.
- `identity_id` for an entity identity drops `workspace_id` from its digest input: `entity:${digest({identity_key})}` (or the absence-barrier variant, `entity:${digest({identity_key, absence_barrier})}`). `identity_assignment_id = digest({record_id, identity_key})` was already content-derived by cascade through `record_id` and is unchanged. `workspace_id` stays as a plain field on the identity template/row — it feeds the row column — it just never enters a digest.
- Projection content digests (`projectionDigest` in the engine, `projection_occurrences.content_digest` in storage) drop `workspace_id` from their input the same way. `source_artifact_version_ids` and the other source-binding arrays stay inside the stored payload for now; restructuring them is left to the fork implementation, since they are low-volume and a fork can patch them without a phase-1 digest change.

Storage row payloads (`record_occurrences.record_payload`) no longer embed `workspace_id`, `owner_artifact_id`, or `owner_artifact_version_id` — those are row columns only, sourced from the open template's own routing fields rather than parsed out of the record. `verify()`'s recomputed occurrence-identity shape and every publication-authority conflict check were updated in lockstep.

## Schema and format

`record_occurrences.record_digest` is no longer `UNIQUE`: a content revert legally produces a closed row and a live row that share a `record_digest` but carry distinct, chain-salted `record_id`s. No other canonical table had a similar digest-uniqueness assumption.

This is a breaking format change for already-indexed workspace databases: their existing rows were minted under workspace-salted derivations this code no longer computes, and mixing the two derivations silently would be unsafe. There is no data migration. A `workspace_meta` marker (`identity_format`, currently `2`) is written once when a workspace database is first created and checked whenever a workspace is opened for active use; its absence means the database predates this decision, and opening it fails with a distinct error instructing the workspace be re-indexed (`urdira workspace add` / a rescan). Background recovery loops that reconcile in-flight migrations or GC epochs at daemon startup do not gate on this marker — they are format-agnostic housekeeping, and gating them would prevent the daemon from starting at all while any one legacy workspace remains un-reindexed.

## Amendment to decision 04

[Decision 04](04-workspace-snapshot-incremental-indexing.md) states: "Reuse cannot continue a closed lifecycle identity, copy a record ID between workspaces, or suppress required dependency edges." That rule was written when record ids were workspace-salted, so copying one between workspaces was definitionally impossible without also copying the salt. Record ids are now content-derived: two workspaces with identical workspace-relative content mint the identical `record_id` for it independently, without either one copying anything from the other. Workspace scoping is enforced by row columns (`workspace_id`, owner artifact ids) and database binding (one SQLite file per workspace, `workspace_meta.workspace_id` checked on open), not by id salting. The rest of decision 04's rule — reuse cannot continue a closed lifecycle identity or suppress required dependency edges — is unchanged. A workspace fork (a follow-up decision) is expected to copy only currently-visible rows into a fresh generation-1 workspace, which this identity scheme makes possible without recomputing any digest; it remains a distinct future operation, not "reuse" in decision 04's sense.

## Non-goals for this decision

- No fork implementation. This decision only makes fork possible; it does not build it.
- No git/content-identity detection.
- No changes to source-layer ids, observation digests, or watermarks.
- No changes to snapshot/registry/candidate id derivation. `snapshot_digest` still covers `workspace_id`; a fork mints fresh snapshots rather than copying them.

## Owner migration barrier

For identity-bearing categories (`entity`, `relation`, and `diagnostic`), an
exact-key assignment found under a different owner is never reused or
continued. Core closes the prior occurrence and mints
`record:${digest({record, previous_record_id})}`. The replacement identity is
`type:${digest({identity_key, owner_migration_barrier: previous_identity_id})}`;
this is a new logical identity even when content is byte-identical. Multiple
active exact-key predecessors fail closed as `core:identity_assignment_conflict`
with `conflict_kind: multiple_active_records`.
