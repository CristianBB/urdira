# Core Canonical Comparators

Status: **Approved initial registry**  
Last updated: 2026-08-08  
Depends on: [Universal data model](../decisions/01-universal-data-model.md) and [Urdira Canonical Encoding](urdira-canonical-encoding.md)

## Registry contract

This file is authoritative for the initial core `CanonicalComparatorDefinition` values. Every definition has `definition_revision: 1`, `schema_version: 1`, `comparator_version: 1`, `lifecycle_state: active`, no `plugin_owner`, and no lifecycle markers or replacement. `comparator_id@1` is pair notation; `@1` is not part of the identifier.

Each `sort_keys` cell is the complete semantic sequence of `CanonicalComparatorSortKey` values. `asc` means `direction: ascending`; every listed key uses `absent_order: forbidden` unless an explicit absent order appears. After the listed keys tie, complete UCE element bytes in ascending order are the mandatory final tie-breaker defined by the universal model.

## Definitions

| Comparator | Description | Exact `sort_keys` |
|---|---|---|
| `core:record_artifact_dependency_order@1` | Orders reverse-invalidation dependencies by their complete logical uniqueness key. | `[/record_id text_utf8 asc, /dependency_artifact_version_id text_utf8 asc, /dependency_role text_utf8 asc]` |
| `core:source_observation_order@1` | Orders normalized source-observation digest entries without using occurrence IDs or wall-clock times. | `[root uce_bytes asc]` |
| `core:visible_source_state_order@1` | Orders the closed visible-source-state union independently of storage layout. | `[root uce_bytes asc]` |
| `core:record_id_order@1` | Orders record-set digest entries by canonical record identity. | `[/record_id text_utf8 asc]` |
| `core:projection_record_id_order@1` | Orders projection-set digest items by projection occurrence identity. | `[/projection_record_id text_utf8 asc]` |
| `core:capability_state_order@1` | Orders `SnapshotCapabilityStateEntry` values independently of map or storage iteration. | `[root uce_bytes asc]` |
| `core:retention_root_order@1` | Orders closed retention-root references independently of physical root discovery. | `[root uce_bytes asc]` |
| `core:stored_object_order@1` | Orders closed stored-object references independently of the storage backend. | `[root uce_bytes asc]` |
| `core:semantic_projection_order@1` | Orders semantic projection digest items by projection occurrence identity. | `[/projection_record_id text_utf8 asc]` |
| `core:semantic_coverage_order@1` | Orders per-artifact semantic coverage first by artifact address identity and then by coverage occurrence identity. | `[/owner_artifact_id text_utf8 asc, /semantic_artifact_coverage_id text_utf8 asc]` |
| `core:queryable_vector_order@1` | Orders queryable vector digest entries by projection occurrence identity. | `[/projection_record_id text_utf8 asc]` |
| `core:participant_ordinal_order@1` | Preserves the normalized comparison participant order. | `[/participant_ordinal safe_integer_numeric asc]` |
| `core:registry_definition_order@1` | Orders the closed union of core registry definitions without depending on registry storage layout. | `[root uce_bytes asc]` |
| `core:package_file_path_order@1` | Orders package manifest files by their unique canonical relative path. | `[/normalized_relative_path text_utf8 asc]` |
| `core:namespace_owner_order@1` | Orders candidate namespace ownership deterministically. | `[/namespace text_utf8 asc, /plugin_id text_utf8 asc, /plugin_version text_utf8 asc, /contribution_digest digest_bytes asc]` |
| `core:operation_id_order@1` | Orders exact stable-operation version bindings by operation identity and version. | `[/operation_id text_utf8 asc, /operation_version safe_integer_numeric asc]` |
| `core:recipe_id_order@1` | Orders exact intent-recipe version bindings by recipe identity and version. | `[/recipe_id text_utf8 asc, /recipe_version safe_integer_numeric asc]` |
| `core:query_manifest_stream_order@1` | Orders persisted query-result streams by stable output, evidence classification, and assigned manifest ordinal. | `[/result_set text_utf8 asc, /result_classification text_utf8 asc, /ordinal safe_integer_numeric asc]` |

`root` denotes the empty RFC 6901 JSON Pointer. The compact key notation expands losslessly to the four fields of `CanonicalComparatorSortKey`; for example, `/record_id text_utf8 asc` is `{value_path: "/record_id", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden"}`.

## Validation invariants

- Every comparator reference in a core schema or digest recipe resolves to exactly one row and exact version in this registry.
- Every non-root path must resolve under the element schema and must have a type accepted by its comparison mode.
- A comparator definition is declarative data and cannot name or embed executable callbacks.
- Changing a path, mode, direction, absent order, or tie-break behavior requires another `comparator_version`; it cannot be hidden in `definition_revision`.
- Retained schemas and descriptors keep the exact comparator version even after deprecation or retirement.
