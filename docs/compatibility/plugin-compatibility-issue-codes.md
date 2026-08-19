# Plugin Compatibility Issue Codes

Status: **Approved initial registry**  
Last updated: 2026-08-08  
Depends on: [Universal data model](../decisions/01-universal-data-model.md)

## Registry contract

This file is the authoritative initial registry for control-plane issues produced while resolving, negotiating, validating, or assessing plugin changes before an indexing candidate exists. Candidate planning, analysis, validation, projection, publication, and cleanup use the separate `CandidateIssue` registry. These issues are not source-owned `DiagnosticRecord` values.

Every definition below has `definition_revision: 1` and `schema_version: 1`, is active, and has no replacement. Every payload is a closed object. Every example is a complete logical `PluginCompatibilityIssue`; identifiers and digests are illustrative but structurally valid.

`default_retryable` is false for every initial code and every initial definition omits `retryable_condition`.

Allowed phases are `resolution`, `negotiation`, `declaration_validation`, `registry_validation`, and `compatibility_assessment`. Allowed severities are `warning` and `error`.

## Resolution issues

### `PLUGIN_NAMESPACE_CONFLICT`

| Definition field | Value |
|---|---|
| Title | Plugin namespace conflict |
| Description | At least two distinct plugin owners would bind the same namespace in one candidate index. |
| Emission condition | Emit only when candidate resolution retains two or more different `plugin_id` values claiming one exact namespace. |
| Does not mean | It does not indicate that either installed package is corrupt or that the packages cannot coexist when assigned to different indices. |
| Allowed phases | `resolution` |
| Severity | `error` only |
| Required action | `resolve_namespace_conflict` |
| Retryable | No; package selection or configuration must change. |
| Agent guidance | The active index is unchanged. Use one namespace owner for this workspace. |

Payload: `namespace` is the required conflicting namespace; `owner_plugin_ids` is a required deduplicated array containing at least two plugin IDs.

```json
{"issue_id":"pci_001","code":"PLUGIN_NAMESPACE_CONFLICT","severity":"error","phase":"resolution","plugin_ids":["dev.urdira.typescript","io.acme.typescript"],"definition_references":[],"requirement_references":[],"summary":"Two plugins claim the typescript namespace.","payload":{"namespace":"typescript","owner_plugin_ids":["dev.urdira.typescript","io.acme.typescript"]},"required_action":"resolve_namespace_conflict","retryable":false,"created_at":"2026-08-07T10:00:00.000000000Z"}
```

### `PLUGIN_VERSION_CONFLICT`

| Definition field | Value |
|---|---|
| Title | Plugin version requirements conflict |
| Description | Canonical version requirements cannot produce one deterministic locally available plugin package. |
| Emission condition | Emit after intersecting every applicable plugin-version requirement when the resulting local candidate set is empty, or when distinct package digests remain tied at the highest SemVer precedence without an exact digest pin. |
| Does not mean | It does not prove that no compatible package exists outside the configured local sources. |
| Allowed phases | `resolution` |
| Severity | `error` only |
| Required action | `select_compatible_version` |
| Retryable | No; installed packages, pins, or dependency requirements must change. |
| Agent guidance | Inspect the referenced requirements and install or select one version satisfying all of them. |

Payload: `required_plugin_id` is required; `available_versions` is the deduplicated ordered list of locally available full SemVer versions and may be empty; `requirement_count` is the required positive number of applicable requirements; `ambiguous_package_digests` is required as a deduplicated array of at least two values for an equal-precedence ambiguity and is omitted when the candidate set is empty.

```json
{"issue_id":"pci_002","code":"PLUGIN_VERSION_CONFLICT","severity":"error","phase":"resolution","plugin_ids":["dev.urdira.nestjs","dev.urdira.typescript"],"definition_references":[],"requirement_references":[{"requirement_type":"plugin_version","declaring_plugin_id":"dev.urdira.nestjs","target_plugin_id":"dev.urdira.typescript","requirement_digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"}],"summary":"No installed TypeScript plugin version satisfies the NestJS dependency.","payload":{"required_plugin_id":"dev.urdira.typescript","available_versions":["1.8.0","2.0.0"],"requirement_count":2},"required_action":"select_compatible_version","retryable":false,"created_at":"2026-08-07T10:00:00.000000000Z"}
```

### `PLUGIN_DEPENDENCY_CYCLE`

| Definition field | Value |
|---|---|
| Title | Plugin dependency cycle |
| Description | The candidate plugin dependency graph contains a directed cycle and cannot be resolved as an acyclic activation order. |
| Emission condition | Emit only after detecting a concrete directed cycle in the exact candidate dependency graph. |
| Does not mean | It does not mean code-level dependencies in the analyzed repository are cyclic. |
| Allowed phases | `resolution` |
| Severity | `error` only |
| Required action | `remove_dependency_cycle` |
| Retryable | No; at least one plugin dependency must change. |
| Agent guidance | The issue concerns plugin packaging, not the source repository. |

Payload: `cycle_path` is a required ordered array of at least three plugin IDs whose first and last values are equal and whose adjacent values are dependency edges.

```json
{"issue_id":"pci_003","code":"PLUGIN_DEPENDENCY_CYCLE","severity":"error","phase":"resolution","plugin_ids":["io.acme.a","io.acme.b"],"definition_references":[],"requirement_references":[],"summary":"Plugins A and B depend on each other.","payload":{"cycle_path":["io.acme.a","io.acme.b","io.acme.a"]},"required_action":"remove_dependency_cycle","retryable":false,"created_at":"2026-08-07T10:00:00.000000000Z"}
```

### `PLUGIN_CAPABILITY_UNAVAILABLE`

| Definition field | Value |
|---|---|
| Title | Required plugin capability unavailable |
| Description | The resolved dependency cannot provide a required capability contract under the candidate workspace configuration. |
| Emission condition | Emit when version resolution succeeds but no selected provider satisfies one exact `CapabilityRequirement`. |
| Does not mean | It does not describe partial source coverage after a capability contract has been satisfied. |
| Allowed phases | `resolution`, `negotiation` |
| Severity | `error` only |
| Required action | `install_capability_provider` |
| Retryable | No; provider, version, contract, or configuration must change. |
| Agent guidance | The dependent plugin remains inactive until a provider satisfies the referenced capability contract. |

Payload: `capability` and `provider_plugin_id` are required; `available_contract_versions` is the deduplicated ordered list of offered capability-contract versions and may be empty.

```json
{"issue_id":"pci_004","code":"PLUGIN_CAPABILITY_UNAVAILABLE","severity":"error","phase":"negotiation","plugin_ids":["dev.urdira.nestjs","dev.urdira.typescript"],"definition_references":[],"requirement_references":[{"requirement_type":"capability_contract","declaring_plugin_id":"dev.urdira.nestjs","target_plugin_id":"dev.urdira.typescript","capability":"core:symbol_resolution","requirement_digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}],"summary":"The selected TypeScript plugin cannot provide the required symbol-resolution contract.","payload":{"capability":"core:symbol_resolution","provider_plugin_id":"dev.urdira.typescript","available_contract_versions":["1.0.0"]},"required_action":"install_capability_provider","retryable":false,"created_at":"2026-08-07T10:00:00.000000000Z"}
```

## Negotiation and integrity issues

### `PLUGIN_CONTRACT_INCOMPATIBLE`

| Definition field | Value |
|---|---|
| Title | Plugin runtime contract incompatible |
| Description | The engine and plugin have no common exact runtime-contract version. |
| Emission condition | Emit after comparing the non-empty advertised version sets when their intersection is empty or excludes an explicit lock pin. |
| Does not mean | It does not imply that the registry contribution itself is invalid. |
| Allowed phases | `negotiation` |
| Severity | `error` only |
| Required action | `update_plugin_or_engine` |
| Retryable | No; engine, plugin, or pin must change. |
| Agent guidance | Keep using the previous published snapshot until compatible runtime contracts are available. |

The negotiated runtime contract includes the plugin's required UCE versions and digest-field contract support. An engine/plugin pair cannot advertise a common runtime-contract version unless those canonical encoding requirements are also compatible.

Payload: `plugin_supported_versions` and `engine_supported_versions` are required deduplicated positive-integer arrays; `pinned_version` is optional and present when a lock pin caused the incompatibility.

```json
{"issue_id":"pci_005","code":"PLUGIN_CONTRACT_INCOMPATIBLE","severity":"error","phase":"negotiation","plugin_ids":["dev.urdira.typescript"],"definition_references":[],"requirement_references":[{"requirement_type":"plugin_contract","declaring_plugin_id":"dev.urdira.typescript","requirement_digest":"sha256:3333333333333333333333333333333333333333333333333333333333333333"}],"summary":"No common plugin runtime contract is available.","payload":{"plugin_supported_versions":[3],"engine_supported_versions":[1,2]},"required_action":"update_plugin_or_engine","retryable":false,"created_at":"2026-08-07T10:00:00.000000000Z"}
```

### `REGISTRY_CONTRACT_INCOMPATIBLE`

| Definition field | Value |
|---|---|
| Title | Registry contract incompatible |
| Description | The engine and plugin have no common registry-contract version for a complete contribution. |
| Emission condition | Emit when no exact supported registry-contract version can be selected or a pinned version is no longer supported. |
| Does not mean | It does not prove that the plugin runtime protocol is incompatible. |
| Allowed phases | `negotiation` |
| Severity | `error` only |
| Required action | `update_plugin_or_engine` |
| Retryable | No; engine, plugin, or pin must change. |
| Agent guidance | The candidate definitions were not activated and the current registry remains authoritative. |

Payload: `plugin_supported_versions` and `engine_supported_versions` are required deduplicated positive-integer arrays; `pinned_version` is optional.

```json
{"issue_id":"pci_006","code":"REGISTRY_CONTRACT_INCOMPATIBLE","severity":"error","phase":"negotiation","plugin_ids":["dev.urdira.typescript"],"definition_references":[],"requirement_references":[{"requirement_type":"registry_contract","declaring_plugin_id":"dev.urdira.typescript","requirement_digest":"sha256:4444444444444444444444444444444444444444444444444444444444444444"}],"summary":"No common registry contract is available.","payload":{"plugin_supported_versions":[4],"engine_supported_versions":[2,3]},"required_action":"update_plugin_or_engine","retryable":false,"created_at":"2026-08-07T10:00:00.000000000Z"}
```

### `PLUGIN_DECLARATION_INVALID`

| Definition field | Value |
|---|---|
| Title | Plugin compatibility declaration invalid |
| Description | A compatibility declaration violates its closed bootstrap schema or a declaration-level invariant. |
| Emission condition | Emit only when the package declaration cannot be parsed or validated before plugin execution. |
| Does not mean | It does not describe invalid canonical records emitted during analysis. |
| Allowed phases | `declaration_validation` |
| Severity | `error` only |
| Required action | `repair_plugin_declaration` |
| Retryable | No; the package declaration must change. |
| Agent guidance | The plugin was not executed. Keep using the previous active resolution. |

Payload: `invariant_code` is required and is one of `DECLARATION_SCHEMA_VIOLATION`, `DECLARATION_IDENTITY_INVALID`, `DECLARATION_CONTRACT_SET_INVALID`, `DECLARATION_DEPENDENCY_INVALID`, or `DECLARATION_DIGEST_INVALID`; `json_pointer` is optional and identifies the invalid declaration location; `validation_error_count` is a required positive integer.

```json
{"issue_id":"pci_007","code":"PLUGIN_DECLARATION_INVALID","severity":"error","phase":"declaration_validation","plugin_ids":["io.acme.bad"],"definition_references":[],"requirement_references":[],"summary":"The plugin declaration contains an unsupported contract value.","payload":{"invariant_code":"DECLARATION_CONTRACT_SET_INVALID","json_pointer":"/supported_plugin_contract_versions/0","validation_error_count":1},"required_action":"repair_plugin_declaration","retryable":false,"created_at":"2026-08-07T10:00:00.000000000Z"}
```

### `PLUGIN_PACKAGE_DIGEST_MISMATCH`

| Definition field | Value |
|---|---|
| Title | Plugin package digest mismatch |
| Description | Installed package content does not match the package digest selected by an explicit pin or resolution lock. |
| Emission condition | Emit after Urdira computes the package digest and it differs from the required exact digest. |
| Does not mean | It does not by itself prove malicious tampering; local corruption or repackaging may also cause the mismatch. |
| Allowed phases | `declaration_validation`, `negotiation` |
| Severity | `error` only |
| Required action | `reinstall_or_repin_package` |
| Retryable | No; package bytes or the explicit pin must change. |
| Agent guidance | Do not trust or activate the mismatched package. The active index remains unchanged. |

Payload: `plugin_version`, `expected_digest`, and `actual_digest` are required exact strings.

```json
{"issue_id":"pci_008","code":"PLUGIN_PACKAGE_DIGEST_MISMATCH","severity":"error","phase":"declaration_validation","plugin_ids":["dev.urdira.typescript"],"definition_references":[],"requirement_references":[{"requirement_type":"package_integrity","declaring_plugin_id":"dev.urdira.typescript","target_plugin_id":"dev.urdira.typescript","requirement_digest":"sha256:5555555555555555555555555555555555555555555555555555555555555555"}],"summary":"The installed TypeScript plugin does not match the locked package.","payload":{"plugin_version":"2.0.0+local","expected_digest":"sha256:6666666666666666666666666666666666666666666666666666666666666666","actual_digest":"sha256:7777777777777777777777777777777777777777777777777777777777777777"},"required_action":"reinstall_or_repin_package","retryable":false,"created_at":"2026-08-07T10:00:00.000000000Z"}
```

### `REGISTRY_CONTRIBUTION_INVALID`

| Definition field | Value |
|---|---|
| Title | Plugin registry contribution invalid |
| Description | The complete contribution violates the negotiated registry schema or a cross-definition invariant. |
| Emission condition | Emit after exact contract negotiation when atomic contribution validation reports one or more errors. |
| Does not mean | It does not mean every definition in the contribution is invalid, and no valid subset is activated. |
| Allowed phases | `registry_validation` |
| Severity | `error` only |
| Required action | `repair_registry_contribution` |
| Retryable | No; the contribution or negotiated inputs must change. |
| Agent guidance | No definitions from the rejected contribution entered the active registry. |

Payload: `invariant_code` is required and is one of `CONTRIBUTION_SCHEMA_VIOLATION`, `CANONICAL_SCHEMA_INVALID`, `DIGEST_DOMAIN_INVALID`, `DIGEST_DOMAIN_CONFLICT`, `CANONICAL_COMPARATOR_INVALID`, `EXTERNAL_VERIFICATION_CONTRACT_INVALID`, `RUNTIME_COMPONENT_INVALID`, `DIGEST_RECIPE_INVALID`, `DIGEST_REFERENCE_INVALID`, `LANGUAGE_DEFINITION_CONFLICT`, `CAPABILITY_CONTRACT_INVALID`, `CONSTRUCT_CLASS_INVALID`, `CAPABILITY_LIMITATION_INVALID`, `IDENTIFIER_OWNERSHIP_INVALID`, `UNIVERSAL_MAPPING_INVALID`, `RELATION_SPECIALIZATION_INVALID`, `IMPLICATION_GRAPH_INVALID`, `DEFINITION_REVISION_INVALID`, `LIFECYCLE_TRANSITION_INVALID`, `DEPENDENCY_REFERENCE_INVALID`, or `CONTRIBUTION_DIGEST_INVALID`; `validation_error_count` is a required positive integer; `affected_identifiers` is a required deduplicated array and may be empty only for contribution-level errors. `LANGUAGE_DEFINITION_CONFLICT` is emitted when two suppliers use the same language coordinate with different canonical bytes or digests; identical supplies deduplicate and never emit it. Canonical schema, domain, comparator, verifier, component, recipe, and reference failures include the exact `uce:*` cause in internal bounded validation details when UCE validation is involved; the public compatibility payload remains stable.

```json
{"issue_id":"pci_009","code":"REGISTRY_CONTRIBUTION_INVALID","severity":"error","phase":"registry_validation","plugin_ids":["dev.urdira.typescript"],"definition_references":[],"requirement_references":[],"summary":"The contribution contains an invalid relation specialization.","payload":{"invariant_code":"RELATION_SPECIALIZATION_INVALID","validation_error_count":2,"affected_identifiers":["typescript:dynamic_call"]},"required_action":"repair_registry_contribution","retryable":false,"created_at":"2026-08-07T10:00:00.000000000Z"}
```

## Definition-evolution issues

### `DEFINITION_CHANGE_FORBIDDEN`

| Definition field | Value |
|---|---|
| Title | Stable definition identifier cannot be reused |
| Description | A candidate changes stable semantics that require a new registry identifier. |
| Emission condition | Emit when compatibility assessment classifies a definition as `new_identifier_required`. |
| Does not mean | It does not forbid publishing the new concept under another identifier and deprecating the old one. |
| Allowed phases | `compatibility_assessment` |
| Severity | `error` only |
| Required action | `publish_new_identifier` |
| Retryable | No; the candidate contribution must change. |
| Agent guidance | Historical meaning is protected; the old identifier remains valid for retained records. |

Payload: `registry_type`, `identifier`, `from_definition_revision`, `to_definition_revision`, and `reason_code` are required.

```json
{"issue_id":"pci_010","code":"DEFINITION_CHANGE_FORBIDDEN","severity":"error","phase":"compatibility_assessment","plugin_ids":["dev.urdira.typescript"],"definition_references":[{"registry_type":"metric","identifier":"typescript:complexity","definition_revision":2}],"requirement_references":[],"summary":"The metric algorithm changed under the existing identifier.","payload":{"registry_type":"metric","identifier":"typescript:complexity","from_definition_revision":1,"to_definition_revision":2,"reason_code":"METRIC_SEMANTICS_CHANGED"},"required_action":"publish_new_identifier","retryable":false,"created_at":"2026-08-07T10:00:00.000000000Z"}
```

### `DEPENDENCY_DEFINITION_DEPRECATED`

| Definition field | Value |
|---|---|
| Title | Dependency uses a deprecated definition |
| Description | A candidate dependency still references a valid definition that its owner has marked deprecated. |
| Emission condition | Emit when dependency validation resolves a foreign definition whose exact candidate state is `deprecated`. |
| Does not mean | It does not make the candidate invalid or imply that existing records are uninterpretable. |
| Allowed phases | `registry_validation`, `compatibility_assessment` |
| Severity | `warning` only |
| Required action | Default `update_dependency`; allowed `none`, `update_dependency` |
| Retryable | No by default; retrying alone does not remove the warning. |
| Agent guidance | Activation may continue, but the dependent plugin should adopt the documented replacement. |

Payload: `dependent_plugin_id`, `definition_identifier`, and `deprecated_since` are required; `replacement_identifier` is optional.

```json
{"issue_id":"pci_011","code":"DEPENDENCY_DEFINITION_DEPRECATED","severity":"warning","phase":"compatibility_assessment","plugin_ids":["dev.urdira.nestjs","dev.urdira.typescript"],"definition_references":[{"registry_type":"facet","identifier":"typescript:legacy_decorator","definition_revision":3}],"requirement_references":[],"summary":"The NestJS plugin uses a deprecated TypeScript facet.","payload":{"dependent_plugin_id":"dev.urdira.nestjs","definition_identifier":"typescript:legacy_decorator","deprecated_since":3,"replacement_identifier":"typescript:decorator"},"required_action":"update_dependency","retryable":false,"created_at":"2026-08-07T10:00:00.000000000Z"}
```

### `DEPENDENCY_DEFINITION_RETIRED`

| Definition field | Value |
|---|---|
| Title | Dependency requires a retired definition |
| Description | A candidate plugin requires a definition that cannot participate in new canonical output. |
| Emission condition | Emit when dependency validation resolves a required foreign definition whose candidate state is `retired`. |
| Does not mean | It does not invalidate historical records that still reference the retained definition. |
| Allowed phases | `registry_validation`, `compatibility_assessment` |
| Severity | `error` only |
| Required action | `update_dependency` |
| Retryable | No; a plugin or definition state must change. |
| Agent guidance | The dependent plugin cannot activate until it stops requiring the retired definition. |

Payload: `dependent_plugin_id`, `definition_identifier`, and `retired_after_definition_revision` are required; `replacement_identifier` is optional.

```json
{"issue_id":"pci_012","code":"DEPENDENCY_DEFINITION_RETIRED","severity":"error","phase":"registry_validation","plugin_ids":["dev.urdira.nestjs","dev.urdira.typescript"],"definition_references":[{"registry_type":"facet","identifier":"typescript:legacy_decorator","definition_revision":4}],"requirement_references":[],"summary":"The NestJS plugin requires a retired TypeScript facet.","payload":{"dependent_plugin_id":"dev.urdira.nestjs","definition_identifier":"typescript:legacy_decorator","retired_after_definition_revision":3,"replacement_identifier":"typescript:decorator"},"required_action":"update_dependency","retryable":false,"created_at":"2026-08-07T10:00:00.000000000Z"}
```

### `RETAINED_REGISTRY_DECODER_UNAVAILABLE`

| Definition field | Value |
|---|---|
| Title | Retained registry decoder unavailable |
| Description | The engine cannot losslessly interpret a registry contract still referenced by retained state. |
| Emission condition | Emit during preflight when at least one retained registry snapshot or active query execution requires an unsupported contract with no complete adapter chain. |
| Does not mean | It does not prove that the retained source or canonical records are corrupt. |
| Allowed phases | `negotiation`, `compatibility_assessment` |
| Severity | `error` only |
| Required action | `restore_compatible_decoder` |
| Retryable | No; engine support, adapters, or explicit retention state must change. |
| Agent guidance | The index remains preserved and is not opened for writes under the incompatible engine. |

Payload: `registry_contract_version` is required; `retained_registry_snapshot_ids` is a required non-empty deduplicated array; `affected_query_execution_count` is a required non-negative integer.

```json
{"issue_id":"pci_013","code":"RETAINED_REGISTRY_DECODER_UNAVAILABLE","severity":"error","phase":"compatibility_assessment","plugin_ids":[],"definition_references":[],"requirement_references":[{"requirement_type":"retained_decoder","requirement_digest":"sha256:8888888888888888888888888888888888888888888888888888888888888888"}],"summary":"Registry contract 1 is still retained but this engine cannot decode it.","payload":{"registry_contract_version":1,"retained_registry_snapshot_ids":["regsnap_1"],"affected_query_execution_count":2},"required_action":"restore_compatible_decoder","retryable":false,"created_at":"2026-08-07T10:00:00.000000000Z"}
```
