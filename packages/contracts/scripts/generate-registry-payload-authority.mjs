import { writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const docsRoot = join(repositoryRoot, "docs");
const sourcePath = (path) => relative(docsRoot, path).split("\\").join("/");

const documentedDescriptions = new Map();
const documentedDescriptionSources = new Map();
const documentedTriggers = new Map();
const documentedTriggerSources = new Map();
const documentedPayloadFields = new Map();
const visit = (directory) => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) visit(path);
    else if (path.endsWith(".md")) {
      let code;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const heading = line.match(/^##+\s+`?(core:[a-z0-9_]+)(?:@\d+)?`?/);
        if (heading) code = heading[1];
        const row = line.match(/^\|\s*`?([a-z][a-z0-9_]*)`?\s*\|\s*[^|]+\|\s*([^|]+?)\s*\|/);
        if (code && row) {
          documentedDescriptions.set(`${code}.${row[1]}`, row[2].trim());
          documentedDescriptionSources.set(`${code}.${row[1]}`, sourcePath(path));
          const fields = documentedPayloadFields.get(code) ?? new Set();
          fields.add(row[1]);
          documentedPayloadFields.set(code, fields);
        }
        const registryRow = line.match(/^\|\s*`?(core:[a-z0-9_]+)`?\s*\|\s*([^|]+?)\s*\|/);
        if (registryRow) {
          documentedTriggers.set(registryRow[1], registryRow[2].trim());
          documentedTriggerSources.set(registryRow[1], sourcePath(path));
          const fields = documentedPayloadFields.get(registryRow[1]) ?? new Set();
          const fieldsCell = line.split("|").slice(5, 7).join(" ");
          const qualifiers = new Set(["positive", "non", "empty", "optional", "required", "string", "array", "integer", "enum", "boolean"]);
          for (const field of [...fieldsCell.matchAll(/\b([a-z][a-z0-9_]*)\b/g)].map((match) => match[1]).filter((field) => !qualifiers.has(field))) fields.add(field);
          documentedPayloadFields.set(registryRow[1], fields);
        }
        const issueRow = line.match(/^\|\s*`?(core:[a-z0-9_]+)`?\s*\|\s*([^|]+?)\s*\|\s*(?:error|warning|info)\s*\|/);
        if (issueRow) documentedTriggers.set(issueRow[1], issueRow[2].trim());
      }
    }
  }
};
visit(docsRoot);

const metadata = {};
const exactPayloadDescriptions = {
  "core:budget_invalid.budget_field": "The canonical request pointer naming the budget whose supplied value is outside the operation's advertised bounds.",
  "core:budget_invalid.provided": "The supplied numeric budget value that failed the selected operation's bounds.",
  "core:budget_invalid.minimum": "The inclusive minimum permitted value for the named budget.",
  "core:budget_invalid.maximum": "The inclusive maximum permitted value for the named budget.",
  "core:freshness_wait_timeout.workspace_ids": "The exact workspace identifiers whose freshness checkpoints did not reach the requested boundary.",
  "core:freshness_wait_timeout.waited_ms": "The elapsed non-negative wait in milliseconds before the freshness boundary expired.",
  "core:freshness_wait_timeout.pending_observation_counts": "The non-negative pending observation count for each workspace, in the same order as workspace_ids.",
  "core:freshness_wait_timeout.retry_after_ms": "The optional non-negative server estimate in milliseconds before another freshness attempt may make progress.",
  "core:semantic_coverage_incomplete.retry_after_milliseconds": "The positive server estimate in milliseconds before another semantic coverage attempt may make progress.",
  "core:embedding_profile_incompatible.incompatibility_reasons": "The non-empty closed set of embedding-profile dimensions that failed hard compatibility checks.",
  "core:semantic_index_unavailable.unavailability_reason": "The closed reason that the required semantic index or query generator cannot serve the selected lane.",
  "core:index_contract_unsupported.contract_kind": "The closed family of canonical contract required by the retained index but unsupported by this engine.",
  "core:index_contract_unsupported.canonical_encoding_version": "The positive canonical-encoding contract version required by the retained index.",
  "core:index_integrity_failed.component_kind": "The closed component family whose mandatory retained state failed integrity verification.",
  "core:index_integrity_failed.integrity_failure_kind": "The closed integrity failure category observed for the mandatory component.",
  "core:source_provider_state_changed.call": "The exact provider call whose accepted state changed during the request.",
  "core:source_provider_unavailable.call": "The exact provider call that could not be served because the provider was unavailable.",
  "core:source_provider_deadline_exceeded.call": "The exact provider call that exceeded its configured deadline.",
  "core:source_provider_resource_exhausted.call": "The exact provider call that exhausted the named resource.",
  "core:source_provider_failed.call": "The exact provider call that returned the recorded provider failure.",
  "core:work_manifest_inconsistent.invariant_code": "The closed invariant identifier violated by the frozen work manifest.",
  "core:source_observation_conflict.conflict_kind": "The closed conflict category explaining why the accepted observations cannot coexist.",
  "core:embedding_generation_failed.failure_kind": "The closed inference-output failure category observed for the embedding generation attempt.",
  "core:source_input_unavailable.availability_code": "The closed availability outcome explaining why the requested source input cannot be read.",
  "core:source_provider_resource_exhausted.resource_kind": "The closed provider resource class whose configured limit was reached.",
  "core:analyzer_failed.failure_stage": "The closed analyzer lifecycle stage at which analysis failed.",
  "core:plugin_resource_exhausted.resource_kind": "The closed plugin resource class whose configured limit was reached.",
  "core:identity_assignment_conflict.conflict_kind": "The closed identity-assignment conflict category observed for the candidate.",
  "core:projection_output_invalid.validation_kind": "The closed validation category violated by the projection output.",
  "core:atomic_publication_failed.publication_step": "The closed atomic-publication step at which the transaction failed.",
  "core:candidate_cleanup_failed.resource_type": "The closed candidate resource class that could not be cleaned up.",
  "core:candidate_cleanup_failed.cleanup_operation": "The closed cleanup operation that failed for the candidate resource.",
};
const payloadDescriptionAuthority = {};
const transcribedCommonPayloadDescription = (code, name, source) => {
  const trigger = documentedTriggers.get(code);
  if (!trigger) throw new Error(`Missing normative trigger for payload field ${code}.${name}`);
  const role = name.endsWith("_ids") ? "ordered identifier set" : name.endsWith("_codes") ? "ordered code set" : name.endsWith("_pointers") ? "ordered pointer set" : name.endsWith("_ms") || name.endsWith("_milliseconds") || name.endsWith("_count") ? "numeric measurement" : name.endsWith("_digest") ? "canonical digest" : "closed detail value";
  return `The \`${name}\` is the ${role} for \`${code}\`; normative emission trigger: ${trigger} (source: ${source}).`;
};
for (const [code, fields] of documentedPayloadFields) for (const name of fields) {
  const key = `${code}.${name}`;
  const documented = documentedDescriptions.get(key);
  const source = documentedDescriptionSources.get(key) ?? documentedTriggerSources.get(code) ?? "protocol/core-operation-error-codes.md";
  payloadDescriptionAuthority[key] = exactPayloadDescriptions[key] ?? (documented && documented !== documentedTriggers.get(code) ? documented : transcribedCommonPayloadDescription(code, name, source));
}
const record = (code, names) => {
  for (const name of names) {
    const key = `${code}.${name}`;
    const description = payloadDescriptionAuthority[key];
    if (!description) throw new Error(`Missing source-backed payload description for ${key}`);
    metadata[key] = { description };
  }
};
for (const [code, fields] of documentedPayloadFields) record(code, fields);

const nonNegative = new Set(["waited_ms", "retry_after_ms", "waited_milliseconds", "pending_artifact_count", "unsupported_artifact_count", "failed_artifact_count", "failure_offset", "recovered_region_count", "observed_dimensions", "elapsed_ms", "observed_or_required", "provided", "minimum", "maximum"]);
const positive = new Set(["requested_version", "api_version", "schema_version", "comparator_version", "digest_recipe_version", "external_verification_contract_version", "required_minimum_characters", "provided_max_characters", "maximum_document_tokens", "validation_error_count", "invalid_projection_count", "configured_limit", "timeout_ms", "expected_dimensions"]);
for (const [key, property] of Object.entries(metadata)) {
  const name = key.slice(key.indexOf(".") + 1);
  if (name === "pending_observation_counts") metadata[key] = { ...property, type: "array", items: { type: "integer", minimum: 0 } };
  else if (name === "uce_error_codes") metadata[key] = { ...property, type: "array", items: { type: "string" } };
  else if (nonNegative.has(name)) metadata[key] = { ...property, type: "integer", minimum: 0 };
  else if (positive.has(name)) metadata[key] = { ...property, type: "integer", minimum: 1 };
}
const nonEmptyStringArrays = new Set([
  "core:unsupported_construct.missing_capabilities",
  "core:embedding_generation_failed.embedding_segment_projection_ids",
  "core:semantic_coverage_incomplete.semantic_lane_ids",
  "core:semantic_coverage_incomplete.workspace_snapshot_binding_ids",
  "core:embedding_profile_incompatible.workspace_snapshot_binding_ids",
  "core:required_capability_unsupported.workspace_snapshot_binding_ids",
]);
for (const key of nonEmptyStringArrays) metadata[key] = { ...metadata[key], type: "array", minItems: 1, items: { type: "string" } };
metadata["core:undeclared_input.undeclared_ids"] = { ...metadata["core:undeclared_input.undeclared_ids"], type: "array", minItems: 1, items: { type: "string" }, description: "The non-empty artifact, base-record, or staged-record identifiers absent from the accepted access manifest." };
metadata["core:invalidation_plan_incomplete.unresolved_scope_count"] = { ...metadata["core:invalidation_plan_incomplete.unresolved_scope_count"], type: "integer", minimum: 1, description: "The number of affected scopes that remain unresolved after the registered fallback scopes were applied." };
metadata["core:invalidation_plan_incomplete.reason_codes"] = { ...metadata["core:invalidation_plan_incomplete.reason_codes"], type: "array", minItems: 1, items: { type: "string" }, description: "The non-empty registered reasons why the invalidation plan cannot prove complete coverage." };
for (const key of Object.keys(metadata)) {
  if (key.endsWith(".reason_codes") && metadata[key].type === "array") metadata[key] = { ...metadata[key], minItems: 1 };
}
const digestPattern = "^(?:sha256):[0-9a-f]{64}$";
for (const [key, property] of Object.entries(metadata)) {
  const name = key.slice(key.indexOf(".") + 1);
  if (name.endsWith("_digest") || ["expected_digest", "actual_digest", "accepted_digest", "conflicting_digest", "content_digest", "request_digest"].includes(name)) metadata[key] = { ...property, type: "string", pattern: digestPattern, description: `The canonical digest value carried by ${key.slice(0, key.indexOf("."))}.` };
}

const enums = {
  "core:missing_dependency.dependency_kind": ["source", "package", "module", "configuration", "model"],
  "core:capability_unavailable.reason": ["not_declared", "disabled", "no_provider", "incompatible_version"],
  "core:semantic_document_generation_failed.subject_type": ["artifact", "entity"],
  "core:semantic_document_generation_failed.generation_phase": ["decode", "section_build", "render", "coverage_validation", "schema_validation"],
  "core:embedding_segmentation_failed.segmentation_phase": ["semantic_region", "semantic_pack", "fallback_window", "token_validation", "coverage_validation"],
  "core:daemon_restart_required.blocking_reason": ["active_publication", "active_migration", "active_administrative_operation", "active_clients", "restart_lease_denied", "restart_lease_timeout", "storage_upgrade_required", "owner_mismatch"],
  "core:undeclared_input.input_type": ["artifact_version", "base_record", "staged_record"],
  "core:source_provider_state_changed.call": ["enumerate", "read", "reconcile"],
  "core:source_provider_unavailable.call": ["describe", "enumerate", "read", "watch", "reconcile"],
  "core:source_provider_deadline_exceeded.call": ["describe", "enumerate", "read", "watch", "reconcile"],
  "core:source_provider_resource_exhausted.call": ["describe", "enumerate", "read", "watch", "reconcile"],
  "core:source_provider_failed.call": ["describe", "enumerate", "read", "watch", "reconcile"],
  "core:work_manifest_inconsistent.invariant_code": ["DUPLICATE_WORK_ITEM", "INVALID_ARTIFACT_TRANSITION", "SCOPE_NOT_COVERED", "DIGEST_MISMATCH", "DIGEST_CONTRACT_MISMATCH", "CONTEXT_MISMATCH"],
  "core:source_observation_conflict.conflict_kind": ["STATE_MISMATCH", "SEQUENCE_REGRESSION", "TOKEN_REUSE", "COVERAGE_CONTRADICTION"],
  "core:publication_conflict.conflict_kind": ["CURRENT_POINTER_CAS_FAILED", "GENERATION_ALREADY_ASSIGNED", "MANIFEST_ALREADY_PUBLISHED", "IDENTITY_ASSIGNMENT_COLLISION", "UNIQUE_INDEX_CONFLICT"],
  "core:embedding_generation_failed.failure_kind": ["inference_error", "invalid_dimensions", "invalid_encoding", "non_finite_value", "normalization_mismatch", "digest_mismatch", "determinism_mismatch"],
  "core:unsupported_construct.support_level": ["none", "partial"],
  "core:source_input_unavailable.availability_code": ["READ_FAILED", "PROVIDER_UNAVAILABLE", "CONTENT_CHANGED_DURING_READ", "CONTENT_VERIFICATION_FAILED"],
  "core:source_provider_resource_exhausted.resource_kind": ["deadline", "response_bytes", "observations", "watch_events"],
  "core:analyzer_failed.failure_stage": ["startup", "input_loading", "parsing", "semantic_analysis", "output_generation", "shutdown"],
  "core:plugin_resource_exhausted.resource_kind": ["deadline", "memory_bytes", "output_bytes", "records", "dependencies", "context_operations", "context_bytes", "recursion_depth"],
  "core:identity_assignment_conflict.conflict_kind": ["MULTIPLE_ACTIVE_MATCHES", "DUPLICATE_CREATED_ID", "CONTINUATION_PREDECESSOR_MISMATCH", "CLOSED_ID_REUSE"],
  "core:projection_output_invalid.validation_kind": ["SCHEMA_INVALID", "OWNER_MISMATCH", "SOURCE_SET_EMPTY", "SOURCE_NOT_VISIBLE", "KEY_COLLISION", "UNDECLARED_SOURCE"],
  "core:atomic_publication_failed.publication_step": ["BEGIN", "VALIDATE_BASE", "INSTALL_SOURCE_STATE", "INSTALL_CANONICAL", "INSTALL_PROJECTIONS", "INSTALL_MANIFEST", "SWAP_CURRENT_POINTER", "COMMIT"],
  "core:candidate_cleanup_failed.resource_type": ["candidate_materialization", "retention_lease", "temporary_projection", "temporary_blob"],
  "core:candidate_cleanup_failed.cleanup_operation": ["release", "delete", "compact"],
};
for (const [key, values] of Object.entries(enums)) metadata[key] = { ...metadata[key], enum: values };

const v5PayloadAuthority = {
  "core:embedding_profile_incompatible.incompatibility_reasons": {
    type: "array", minItems: 1, items: { type: "string", enum: ["language", "content_class", "query_class", "dimensions", "encoding", "distance_metric", "generator_lock", "materialization"] },
    description: "The non-empty closed set of embedding-profile dimensions that failed hard compatibility checks.",
  },
  "core:semantic_index_unavailable.unavailability_reason": {
    type: "string", enum: ["materialization_missing", "materialization_unavailable", "query_generator_unavailable", "vector_set_unreadable"],
    description: "The registered reason the semantic index cannot serve the requested query.",
  },
  "core:semantic_coverage_incomplete.retry_after_milliseconds": {
    type: "integer", minimum: 1,
    description: "The positive delay in milliseconds after which the caller may retry semantic coverage acquisition.",
  },
  "core:index_contract_unsupported.contract_kind": {
    type: "string", enum: ["canonical_encoding", "hash_algorithm", "schema", "digest_domain", "canonical_comparator", "digest_recipe", "digest_reference", "external_verifier"],
    description: "The closed index contract family that the active implementation does not support.",
  },
  "core:index_contract_unsupported.canonical_encoding_version": {
    type: "integer", minimum: 1,
    description: "The positive canonical-encoding contract version required by the index.",
  },
  "core:index_integrity_failed.component_kind": {
    type: "string", enum: ["manifest", "canonical_record", "source_blob", "registry", "projection", "query_manifest", "storage_index"],
    description: "The closed component family whose integrity check failed.",
  },
  "core:index_integrity_failed.integrity_failure_kind": {
    type: "string", enum: ["digest_mismatch", "missing_required_component", "schema_invalid", "reference_invalid", "atomicity_violation"],
    description: "The closed integrity failure category observed while validating the index component.",
  },
};
for (const [key, override] of Object.entries(v5PayloadAuthority)) {
  if (!metadata[key]) throw new Error(`Missing payload authority entry ${key}`);
  metadata[key] = { ...metadata[key], ...override };
}

const v9PayloadAuthority = {
  "core:duplicate_comparison_participant.snapshot_ids": {
    type: "array", minItems: 1, items: { type: "string" },
    description: "The exact snapshot identifiers associated with the duplicated comparison participant.",
  },
  "core:invalid_definition_instance_selector.definition_ids": {
    type: "array", minItems: 1, items: { type: "string" },
    description: "The non-empty selected definition identifiers that belong to unsupported definition families.",
  },
  "core:invalid_definition_instance_selector.definition_types": {
    type: "array", minItems: 1, items: { type: "string" },
    description: "The non-empty selected definition families that are not record kind, facet, or language.",
  },
  "core:index_contract_unsupported.registry_snapshot_ids": {
    type: "array", minItems: 1, items: { type: "string" },
    description: "Required exact retained registries whose reachable state needs the contract.",
  },
  "core:index_integrity_failed.snapshot_ids": {
    type: "array", minItems: 1, items: { type: "string" },
    description: "Required exact snapshots whose mandatory state is affected.",
  },
  "core:required_delta_missing.replacement_scope_ids": {
    type: "array", minItems: 1, items: { type: "string" },
    description: "The non-empty replacement scopes for which no accepted delta was received.",
  },
  "core:work_manifest_inconsistent.work_item_ids": {
    type: "array", minItems: 1, items: { type: "string" },
    description: "The non-empty work-item identifiers covered by the inconsistent frozen manifest.",
  },
  "core:source_observation_conflict.source_observation_ids": {
    type: "array", minItems: 2, items: { type: "string" },
    description: "The at-least-two accepted observation identifiers that contradict one another.",
  },
  "core:ambiguous_target.candidate_entity_ids": {
    type: "array", minItems: 2, items: { type: "string" },
    description: "Required deduplicated array containing at least two candidate entities.",
  },
};
for (const [key, override] of Object.entries(v9PayloadAuthority)) {
  if (!metadata[key]) throw new Error(`Missing payload authority entry ${key}`);
  metadata[key] = { ...metadata[key], ...override };
}

writeFileSync(new globalThis.URL("../src/registry-payload-authority.ts", import.meta.url), `/** Mechanically transcribed from the core operation-error, diagnostic, and candidate-issue registries. */\nexport const authoritativePayloadMetadata = ${JSON.stringify(metadata, null, 2)} as const;\n`);
