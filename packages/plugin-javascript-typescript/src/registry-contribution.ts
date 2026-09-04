import type {
  CanonicalSchemaDefinition,
  ClosedPayloadSchema,
  PluginRegistryContribution,
  RecordKindDefinition,
} from "@urdira/contracts";
import {
  sha256Bytes,
  type InstalledPluginBundle,
  type PluginDigestAuthority,
} from "@urdira/plugin-sdk";
import {
  JAVASCRIPT_TYPESCRIPT_CAPABILITIES,
  JAVASCRIPT_TYPESCRIPT_NAMESPACE,
  JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
  JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES,
  JAVASCRIPT_TYPESCRIPT_VERSION,
  TYPESCRIPT_COMPILER_VERSION,
} from "./analyzer.js";

export const JAVASCRIPT_TYPESCRIPT_RECORD_KINDS = Object.freeze([
  "jsts:entity_type",
  "jsts:entity_callable",
  "jsts:entity_variable",
  "jsts:entity_parameter",
  "jsts:entity_container",
  "jsts:entity_inferred_type",
  "jsts:relation_contains",
  "jsts:relation_call",
  "jsts:relation_import",
  "jsts:relation_export",
  "jsts:relation_references",
  "jsts:relation_covers",
  "jsts:relation_inherits",
  "jsts:relation_implements",
  "jsts:relation_type_of",
  "jsts:diagnostic",
] as const);

export const JAVASCRIPT_TYPESCRIPT_DEPENDENCY_ROLES = Object.freeze([
  "jsts:source_input",
  "jsts:resolution_input",
  "jsts:configuration_input",
] as const);

const entityPayload: ClosedPayloadSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "Declared source name." },
    kind: { type: "string", description: "JavaScript or TypeScript declaration form." },
    language: { type: "string", enum: ["javascript", "typescript"], description: "Canonical artifact language." },
    path: { type: "string", description: "Normalized source path." },
    start: { type: "integer", minimum: 0, description: "Start offset in the source artifact." },
    end: { type: "integer", minimum: 0, description: "Exclusive end offset in the source artifact." },
    parent_id: { type: "string", description: "Pre-canonical parent anchor when present." },
    qualified_name: { type: "string", description: "Container-qualified declaration name when present." },
    type: { type: "string", description: "Checker-rendered type when available." },
    text: { type: "string", description: "Exact compiler-node source text used by lexical public queries." },
    is_test: { type: "boolean", description: "Whether a module statically imports the registered Node test API." },
  },
  required: ["name", "kind", "language", "path", "start", "end"],
} satisfies ClosedPayloadSchema);

const relationPayload: ClosedPayloadSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    source_id: { type: "string", description: "Pre-canonical source anchor." },
    target_id: { type: "string", description: "Pre-canonical target anchor when resolved." },
    classification: { type: "string", enum: ["confirmed", "possible"], description: "Evidence classification." },
    path: { type: "string", description: "Normalized owner source path." },
    start: { type: "integer", minimum: 0, description: "Start offset in the owner source artifact." },
    end: { type: "integer", minimum: 0, description: "Exclusive end offset in the owner source artifact." },
    // v4's Rust pipeline has no checker to cross-reference for context, so a
    // `classification: "possible"` row surfaces the pending site's own reason
    // directly (v3's checker-backed `relate()` never populated this field,
    // and the `jsts:unresolved_call` diagnostic that used to carry it in v4
    // was folded away on 2026-09-04: no query operation consumed it). Values
    // are the site-pending reason codes `crates/urdira-jsts-syntax-worker`
    // attaches to a CALL site that stayed unresolved through both the E1-E3
    // lane and typeflow: `call_deferred_to_e3` (a non-identifier callee --
    // member/`this`/`super`/a dynamic `import()`/any other expression --
    // never even attempted) and `call_target_uncertain` (an identifier
    // callee whose binding does not lead to a single, non-overloaded
    // declaration). P2-2j added the other two reasons the plan's fuller
    // taxonomy reserved: `overload_ambiguous` (the receiver resolved to a
    // single entity, but the requested member is declared more than once on
    // it -- `urdira_jsts_typeflow::MemberLookup::Many`) and `union_ambiguous`
    // (a union-typed receiver, `a: A | B`, where every constituent declares
    // the member -- `MemberLookup::UnionCandidates`); UNLIKE the first two
    // reasons, a row carrying either of these two ALSO carries a real
    // `target_id` (one row per candidate -- see `candidate_call_record`'s
    // own doc comment in `semantic_sites.rs`), so `required` below is
    // unaffected but a possible row is no longer guaranteed target-less.
    // `external_module`/`generic` remain reserved for a future widening of
    // the Rust emission channel and are not listed until something actually
    // produces them.
    reason: { type: "string", enum: ["call_deferred_to_e3", "call_target_uncertain", "overload_ambiguous", "union_ambiguous"], description: "Why a possible call site stayed unresolved (v4's Rust pipeline only; absent on checker-produced and confirmed rows)." },
  },
  required: ["source_id", "classification", "path", "start", "end"],
} satisfies ClosedPayloadSchema);

const diagnosticPayload: ClosedPayloadSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    code: { type: "string", description: "Registered plugin diagnostic code." },
    compiler_code: { type: "integer", minimum: 0, description: "Pinned compiler diagnostic number when applicable." },
    message: { type: "string", description: "Bounded diagnostic message." },
    path: { type: "string", description: "Normalized owner source path." },
    start: { type: "integer", minimum: 0, description: "Start offset when available." },
    end: { type: "integer", minimum: 0, description: "Exclusive end offset when available." },
  },
  required: ["code", "message", "path"],
} satisfies ClosedPayloadSchema);

function schema(
  schema_id: string,
  description: string,
  fields: ClosedPayloadSchema["properties"],
  required: readonly string[],
): CanonicalSchemaDefinition {
  return {
    schema_id,
    definition_revision: 1,
    schema_version: 1,
    description,
    root_type: {
      type_kind: "record",
      fields: Object.entries(fields).map(([field_name, property]) => ({
        field_name,
        description: `${field_name} field.`,
        presence: required.includes(field_name) ? "required" : "optional",
        value_type: property.type === "integer"
          ? { type_kind: "safe_integer", ...(property.minimum === undefined ? {} : { minimum: property.minimum }), ...(property.maximum === undefined ? {} : { maximum: property.maximum }) }
          : property.type === "boolean" ? { type_kind: "boolean" }
          : property.enum === undefined ? { type_kind: "text" } : { type_kind: "enum", values: property.enum },
      })),
    },
    type_definitions: [],
    plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
    lifecycle_state: "active",
  };
}

const canonicalSchemas = Object.freeze([
  schema("jsts:entity_payload", "Checker-backed JavaScript or TypeScript declaration payload.", entityPayload.properties, entityPayload.required),
  schema("jsts:relation_payload", "Checker-backed JavaScript or TypeScript relationship payload.", relationPayload.properties, relationPayload.required),
  schema("jsts:diagnostic_payload", "JavaScript or TypeScript analysis diagnostic payload.", diagnosticPayload.properties, diagnosticPayload.required),
  schema("jsts:semantic_projection_payload", "Deterministic semantic-preparation projection payload.", {
    identity_key: { type: "string", description: "Source declaration identity key." }, text: { type: "string", description: "Model-independent semantic text." }, path: { type: "string", description: "Normalized source path." },
    start: { type: "integer", minimum: 0, description: "Start offset." }, end: { type: "integer", minimum: 0, description: "Exclusive end offset." },
  }, ["identity_key", "text", "path", "start", "end"]),
]);

function recordKind(
  kind: string,
  category: RecordKindDefinition["category"],
  universal_kind: string,
  payload_schema: string,
  allowed_facets: readonly string[],
): RecordKindDefinition {
  return {
    kind,
    category,
    definition_revision: 1,
    schema_version: 1,
    description: `${kind} emitted by the pinned TypeScript checker analyzer.`,
    payload_schema,
    universal_kind,
    required_facets: [],
    allowed_facets,
    plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
    lifecycle_state: "active",
  };
}

const entityFacets = ["core:declaration", "core:definition", "core:member", "core:constructible", "core:abstract", "core:async", "core:generator"];
const relationFacets = ["core:structural_relation", "core:reference_relation", "core:dependency_relation", "core:flow_relation", "core:binding_relation", "core:indirect"];

export interface JavascriptTypescriptContributionInput {
  readonly digests: PluginDigestAuthority;
  readonly runtime_behavior_digest: string;
  readonly runtime_contract_version?: 1 | 2;
}

export function createJavascriptTypescriptRegistryContribution(input: JavascriptTypescriptContributionInput): PluginRegistryContribution {
  const core: Omit<PluginRegistryContribution, "contribution_digest"> = {
    plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
    plugin_version: JAVASCRIPT_TYPESCRIPT_VERSION,
    namespace: JAVASCRIPT_TYPESCRIPT_NAMESPACE,
    registry_contract_version: "1.0.0",
    dependencies: [],
    canonical_schema_definitions: canonicalSchemas,
    digest_domain_definitions: [],
    canonical_comparator_definitions: [],
    external_verification_contract_definitions: [],
    runtime_component_definitions: [{
      component_id: "jsts:semantic_projection",
      definition_revision: 1,
      schema_version: 1,
      component_version: JAVASCRIPT_TYPESCRIPT_VERSION,
      component_contracts: [{ component_kind: "projection_generator" as const, contract_version: String(input.runtime_contract_version ?? 1) }],
      description: "Deterministic JavaScript and TypeScript semantic-preparation projection generator.",
      behavior_digest: input.runtime_behavior_digest,
      plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
      lifecycle_state: "active",
    }],
    digest_recipe_definitions: [],
    digest_reference_definitions: [],
    language_definitions: [
      { language_id: "javascript", definition_revision: 1, schema_version: 1, description: "ECMAScript source and declaration semantics, including configured JSX syntax.", display_name: "JavaScript", aliases: ["cjs", "js", "jsx", "mjs"], lifecycle_state: "active" },
      { language_id: "typescript", definition_revision: 1, schema_version: 1, description: "TypeScript source and declaration semantics, including configured TSX syntax.", display_name: "TypeScript", aliases: ["cts", "mts", "ts", "tsx"], lifecycle_state: "active" },
    ],
    capability_contract_definitions: [],
    structural_stage_definitions: JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES,
    construct_class_definitions: [
      { construct_code: "jsts:dynamic_runtime_code", definition_revision: 1, schema_version: 1, description: "Runtime-generated JavaScript whose target cannot be established statically.", applicable_capabilities: ["core:symbol_resolution", "core:call_relationships", "core:data_flow"], plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, lifecycle_state: "active" },
      { construct_code: "jsts:unsupported_syntax", definition_revision: 1, schema_version: 1, description: "Source syntax rejected by the pinned compiler.", applicable_capabilities: ["core:syntax_structure"], plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, lifecycle_state: "active" },
    ],
    capability_limitation_definitions: [
      { limitation_code: "jsts:dynamic_runtime_code", definition_revision: 1, schema_version: 1, description: "Dynamic runtime behavior is retained as possible or unresolved.", allowed_capabilities: ["core:symbol_resolution", "core:call_relationships", "core:data_flow"], allowed_statuses: ["partial", "unknown"], agent_guidance: "Treat affected targets as possible, not confirmed.", plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, lifecycle_state: "active" },
      { limitation_code: "jsts:unsupported_syntax", definition_revision: 1, schema_version: 1, description: "The pinned compiler could not establish authoritative syntax semantics.", allowed_capabilities: ["core:syntax_structure"], allowed_statuses: ["partial", "unsupported"], agent_guidance: "Upgrade the analyzer or correct the source syntax before requiring complete coverage.", plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, lifecycle_state: "active" },
    ],
    record_kind_definitions: [
      recordKind("jsts:entity_type", "entity", "core:type", "jsts:entity_payload", entityFacets),
      recordKind("jsts:entity_callable", "entity", "core:callable", "jsts:entity_payload", entityFacets),
      recordKind("jsts:entity_variable", "entity", "core:value", "jsts:entity_payload", entityFacets),
      recordKind("jsts:entity_parameter", "entity", "core:parameter", "jsts:entity_payload", entityFacets),
      recordKind("jsts:entity_container", "entity", "core:container", "jsts:entity_payload", entityFacets),
      recordKind("jsts:entity_inferred_type", "entity", "core:type", "jsts:entity_payload", []),
      recordKind("jsts:relation_contains", "relation", "core:contains", "jsts:relation_payload", relationFacets),
      recordKind("jsts:relation_call", "relation", "core:call", "jsts:relation_payload", relationFacets),
      recordKind("jsts:relation_import", "relation", "core:import", "jsts:relation_payload", relationFacets),
      recordKind("jsts:relation_export", "relation", "core:export", "jsts:relation_payload", relationFacets),
      recordKind("jsts:relation_references", "relation", "core:references", "jsts:relation_payload", relationFacets),
      recordKind("jsts:relation_covers", "relation", "core:covers", "jsts:relation_payload", relationFacets),
      recordKind("jsts:relation_inherits", "relation", "core:inherits", "jsts:relation_payload", relationFacets),
      recordKind("jsts:relation_implements", "relation", "core:implements", "jsts:relation_payload", relationFacets),
      recordKind("jsts:relation_type_of", "relation", "core:type_of", "jsts:relation_payload", relationFacets),
      recordKind("jsts:diagnostic", "diagnostic", "core:construct", "jsts:diagnostic_payload", []),
    ],
    facet_definitions: [],
    semantic_role_definitions: [],
    metric_definitions: [],
    effect_definitions: [],
    diagnostic_code_definitions: [
      { code: "jsts:compiler_diagnostic", definition_revision: 1, schema_version: 1, diagnostic_category: "compiler", title: "TypeScript compiler diagnostic", description: "The pinned compiler reported a syntactic, bind, or semantic diagnostic.", emission_condition: "A compiler diagnostic intersects the owner source artifact.", default_severity: "error" as const, allowed_severities: ["warning" as const, "error" as const], allowed_scope_types: ["artifact" as const, "capability" as const], payload_schema: diagnosticPayload, lifecycle_state: "active" as const },
      { code: "jsts:dynamic_runtime_code", definition_revision: 1, schema_version: 1, diagnostic_category: "dynamic_behavior", title: "Dynamic runtime code", description: "Runtime code generation prevents complete static resolution.", emission_condition: "The checker-backed syntax tree contains eval-like execution.", default_severity: "warning" as const, allowed_severities: ["warning" as const], allowed_scope_types: ["artifact" as const, "capability" as const], payload_schema: diagnosticPayload, lifecycle_state: "active" as const },
      { code: "jsts:unresolved_call", definition_revision: 1, schema_version: 1, diagnostic_category: "resolution", title: "Unresolved call target", description: "The checker could not establish a unique call target.", emission_condition: "A call expression has no checker-resolved declaration at all (a target the checker resolves outside the frozen project -- a library call, a built-in, an ambient declaration -- is an expected analysis boundary, not this condition).", default_severity: "warning" as const, allowed_severities: ["warning" as const], allowed_scope_types: ["record" as const, "artifact" as const, "capability" as const], payload_schema: diagnosticPayload, lifecycle_state: "active" as const },
    ],
    candidate_issue_code_definitions: [],
    dependency_role_definitions: JAVASCRIPT_TYPESCRIPT_DEPENDENCY_ROLES.map((dependency_role) => ({ dependency_role, definition_revision: 1, schema_version: 1, description: `${dependency_role} reverse invalidation dependency.`, invalidation_semantics: "Invalidate the source-owned replacement scope when the exact dependency artifact version changes.", plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, lifecycle_state: "active" })),
    projection_kind_definitions: [{ projection_kind: "jsts:semantic_preparation", definition_revision: 1, schema_version: 1, description: "Model-independent semantic preparation for JavaScript and TypeScript declarations.", payload_schema: "jsts:semantic_projection_payload", generator_contract_version: "1.0.0", plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, lifecycle_state: "active" }],
    lifecycle_reason_code_definitions: [],
    completeness_reason_definitions: [
      { reason_code: "jsts:compiler_diagnostic", definition_revision: 1, schema_version: 1, description: "Compiler diagnostics prevent complete semantic coverage.", allowed_statuses: ["partial", "unsupported"], affected_capabilities: JAVASCRIPT_TYPESCRIPT_CAPABILITIES.map((entry) => entry.capability), agent_guidance: "Inspect the emitted compiler diagnostics.", plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, lifecycle_state: "active" },
      { reason_code: "jsts:dynamic_runtime_code", definition_revision: 1, schema_version: 1, description: "Runtime-generated behavior prevents complete static coverage.", allowed_statuses: ["partial", "unknown"], affected_capabilities: ["core:symbol_resolution", "core:call_relationships", "core:data_flow"], agent_guidance: "Treat unresolved targets as possible.", plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, lifecycle_state: "active" },
      { reason_code: "jsts:unresolved_call", definition_revision: 1, schema_version: 1, description: "At least one call target is unresolved.", allowed_statuses: ["partial", "unknown"], affected_capabilities: ["core:call_relationships"], agent_guidance: "Use the possible call observation and diagnostic evidence.", plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, lifecycle_state: "active" },
      // P1-B (urdira v4 plan, checker-off pipeline mode, URDIRA_JSTS_TYPEFLOW=1):
      // when the semantic checker lane is never invoked for a generation,
      // `jsts:compiler_diagnostic`/`jsts:compiler_diagnostic`-derived diagnostics
      // are never emitted at all (there is no compiler run to report them) --
      // this reason code names THAT specific, structural gap explicitly,
      // distinct from `jsts:compiler_diagnostic` (a diagnostic the compiler DID
      // report) and from `jsts:unresolved_call` (a specific call site the
      // checker COULD have resolved but didn't): it says the compiler's own
      // diagnostic channel is absent for this generation, full stop.
      { reason_code: "jsts:compiler_diagnostics_unavailable", definition_revision: 1, schema_version: 1, description: "The semantic checker lane did not run for this generation, so no compiler diagnostics could be observed.", allowed_statuses: ["partial", "unknown"], affected_capabilities: JAVASCRIPT_TYPESCRIPT_CAPABILITIES.map((entry) => entry.capability), agent_guidance: "Compiler-diagnostic-derived completeness signals are unavailable; rely on the Rust resolver's own possible/unresolved call evidence instead.", plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, lifecycle_state: "active" },
    ],
    semantic_section_kind_definitions: [{ section_kind: "jsts:declaration", definition_revision: 1, schema_version: 1, description: "A checker-backed declaration section.", allowed_origin_kinds: ["jsts:entity_type", "jsts:entity_callable", "jsts:entity_variable", "jsts:entity_container"], agent_guidance: "Use for semantic retrieval context, never for structural identity.", plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, lifecycle_state: "active" }],
    semantic_reason_definitions: [],
    evidence_assumption_definitions: [{ assumption_code: "jsts:frozen_compiler_project", definition_revision: 1, schema_version: 1, description: "All analysis inputs are frozen in one immutable compiler project.", satisfaction_contract: "The accepted plugin input manifest commits every compiler-visible artifact version and lookup.", agent_guidance: "Reanalyze when any committed input changes.", plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, lifecycle_state: "active" }],
    evidence_explanation_definitions: [{ explanation_code: "jsts:typescript_checker", definition_revision: 1, schema_version: 1, description: "The pinned TypeScript parser, binder, resolver, and checker established this result.", allowed_bases: ["syntax_tree", "compiler_symbol", "compiler_type", "resolved_signature"], allowed_derivations: ["direct", "bounded_candidate_set"], agent_guidance: "Confirmed results require a unique checker target; otherwise retain possible evidence.", plugin_owner: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, lifecycle_state: "active" }],
  };
  return Object.freeze({ ...core, contribution_digest: input.digests.registry_contribution(core as unknown as PluginRegistryContribution) });
}

export interface JavascriptTypescriptPackageAsset {
  readonly normalized_relative_path: string;
  readonly bytes: Uint8Array;
  readonly executable: boolean;
  readonly role: "parser" | "rule" | "dependency" | "model";
}

export interface JavascriptTypescriptNativeRuntimeInput {
  readonly runtime_target_id: string;
  readonly runtime_component_build_id: string;
  readonly addon: { readonly normalized_relative_path: string; readonly bytes: Uint8Array };
  readonly worker: { readonly normalized_relative_path: string; readonly bytes: Uint8Array };
}

export function createJavascriptTypescriptInstalledBundle(input: {
  readonly digests: PluginDigestAuthority;
  readonly package_locator: string;
  /** Legacy v1 target coordinate. Required when native_runtime is absent. */
  readonly target_triple?: string;
  readonly assets: readonly JavascriptTypescriptPackageAsset[];
  readonly native_runtime?: JavascriptTypescriptNativeRuntimeInput;
}): InstalledPluginBundle {
  const native = input.native_runtime;
  if (native === undefined && (input.target_triple === undefined || input.assets.length === 0 || !input.assets.some((asset) => asset.executable))) throw new TypeError("The v1 JavaScript/TypeScript bundle requires a target and executable analyzer asset.");
  if (native !== undefined && (input.target_triple !== undefined || !/^sha256:[0-9a-f]{64}$/u.test(native.runtime_component_build_id) || native.addon.bytes.byteLength === 0 || native.worker.bytes.byteLength === 0 || native.addon.normalized_relative_path === native.worker.normalized_relative_path)) {
    throw new TypeError("The native JavaScript/TypeScript bundle requires one exact target closure and build identity.");
  }
  const nativeAssets = native === undefined ? [] : [
    { normalized_relative_path: native.addon.normalized_relative_path, bytes: native.addon.bytes, executable: false },
    { normalized_relative_path: native.worker.normalized_relative_path, bytes: native.worker.bytes, executable: true },
  ];
  const allAssets = [...input.assets, ...nativeAssets];
  if (new Set(allAssets.map((asset) => asset.normalized_relative_path)).size !== allAssets.length) throw new TypeError("The JavaScript/TypeScript bundle asset paths must be unique.");
  const packageFiles = allAssets.map((asset) => ({ normalized_relative_path: asset.normalized_relative_path, content_digest: sha256Bytes(asset.bytes), byte_length: asset.bytes.byteLength, executable: asset.executable }));
  const executableDigests = packageFiles.filter((entry) => entry.executable).map((entry) => entry.content_digest);
  const roleDigests = (role: JavascriptTypescriptPackageAsset["role"]): string[] => input.assets.flatMap((asset, index) => asset.role === role && !asset.executable ? [packageFiles[index]!.content_digest] : []);
  const addonDigest = native === undefined ? undefined : sha256Bytes(native.addon.bytes);
  const workerDigest = native === undefined ? undefined : sha256Bytes(native.worker.bytes);
  const manifest = { package_format_id: "core:plugin", package_format_version: 1, plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, plugin_version: JAVASCRIPT_TYPESCRIPT_VERSION, package_files: packageFiles };
  const analyzer = {
    plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
    plugin_version: JAVASCRIPT_TYPESCRIPT_VERSION,
    analyzer_id: "jsts:typescript_checker",
    analyzer_version: JAVASCRIPT_TYPESCRIPT_VERSION,
    executable_asset_digests: executableDigests,
    parser_asset_digests: roleDigests("parser"),
    rule_asset_digests: roleDigests("rule"),
    model_asset_digests: roleDigests("model"),
    dependency_asset_digests: [...roleDigests("dependency"), ...(addonDigest === undefined ? [] : [addonDigest])],
    supported_capabilities: JAVASCRIPT_TYPESCRIPT_CAPABILITIES.map((entry) => entry.capability),
  };
  const behavior = {
    component_id: "jsts:semantic_projection",
    component_version: JAVASCRIPT_TYPESCRIPT_VERSION,
    component_kind: "projection_generator" as const,
    contract_bindings: [{ component_kind: "projection_generator" as const, contract_version: String(native === undefined ? 1 : 2) }],
    configuration_schema_ids: [],
    algorithm_ids: ["jsts:typescript_checker_semantic_preparation"],
    supported_format_ids: ["jsts:plain_text"],
    deterministic_numeric_contract: "integer_only",
    portable_behavior_rules: ["Canonical UTF-8 source order", "No embeddings or ranking"],
  };
  const behaviorDigest = input.digests.runtime_behavior(behavior);
  const runtimeContractVersion = native === undefined ? 1 : 2;
  const contribution = createJavascriptTypescriptRegistryContribution({ digests: input.digests, runtime_behavior_digest: behaviorDigest, runtime_contract_version: runtimeContractVersion });
  const implementationBase = {
    runtime_component_build_id: native?.runtime_component_build_id ?? `jsts:semantic_projection_${input.target_triple!.replace(/[^a-zA-Z0-9_]/gu, "_")}`,
    component_id: behavior.component_id,
    component_version: behavior.component_version,
    behavior_digest: behaviorDigest,
  };
  const implementationV1 = native === undefined ? {
    ...implementationBase,
    target_triple: input.target_triple!,
    executable_asset_digests: executableDigests,
    native_asset_digests: [],
    dependency_asset_digests: packageFiles.filter((entry) => !entry.executable).map((entry) => entry.content_digest),
  } : undefined;
  const implementationV2 = native === undefined ? undefined : {
    ...implementationBase,
    runtime_target_id: native.runtime_target_id,
    entrypoint_asset_digest: workerDigest!,
    executable_asset_digests: executableDigests,
    native_asset_digests: [addonDigest!],
    dependency_asset_digests: packageFiles.filter((entry) => !entry.executable && entry.content_digest !== addonDigest).map((entry) => entry.content_digest),
  };
  const configuration = { configuration_schema_id: "core:bytes", configuration_schema_version: 1, normalized_configuration: new TextEncoder().encode(JSON.stringify({ compiler: TYPESCRIPT_COMPILER_VERSION, deterministic: true })) };
  const compatibilityCore = {
    declaration_schema_version: "1.0.0",
    plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
    plugin_version: JAVASCRIPT_TYPESCRIPT_VERSION,
    namespace: JAVASCRIPT_TYPESCRIPT_NAMESPACE,
    supported_plugin_contract_versions: [runtimeContractVersion],
    supported_registry_contract_versions: [1],
    dependencies: [],
    offered_capabilities: JAVASCRIPT_TYPESCRIPT_CAPABILITIES.map((entry) => ({ capability: entry.capability, version_requirement: "1.0.0" })),
    recommended_embedding_profile_ids: [],
    package_digest: input.digests.plugin_package(manifest),
    analysis_digest: input.digests.analyzer_implementation(analyzer),
  };
  const implementationDigest = implementationV2 === undefined
    ? input.digests.runtime_implementation(implementationV1!)
    : (() => {
        if (input.digests.runtime_implementation_v2 === undefined) throw new TypeError("The native JavaScript/TypeScript bundle requires the v2 implementation digest authority.");
        return input.digests.runtime_implementation_v2(implementationV2);
      })();
  const packageDigest = compatibilityCore.package_digest;
  const bindingPayload = implementationV2 === undefined ? undefined : {
    plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
    plugin_version: JAVASCRIPT_TYPESCRIPT_VERSION,
    runtime_target_id: implementationV2.runtime_target_id,
    runtime_contract_version: runtimeContractVersion,
    runtime_component_build_id: implementationV2.runtime_component_build_id,
    implementation_digest: implementationDigest,
    package_digest: packageDigest,
    entrypoint_asset_digest: implementationV2.entrypoint_asset_digest,
  };
  if (bindingPayload !== undefined && input.digests.runtime_executable_binding === undefined) throw new TypeError("The native JavaScript/TypeScript bundle requires the executable binding digest authority.");
  const runtimeExecutableBinding = bindingPayload === undefined ? undefined : { ...bindingPayload, binding_digest: input.digests.runtime_executable_binding!(bindingPayload) };
  return Object.freeze({
    package_locator: input.package_locator,
    manifest,
    compatibility: { ...compatibilityCore, declaration_digest: input.digests.compatibility_declaration(compatibilityCore as never) },
    contribution,
    runtime_builds: [{ runtime_component_build_id: implementationBase.runtime_component_build_id, schema_version: 1, component_id: implementationBase.component_id, component_version: implementationBase.component_version, behavior_digest: behaviorDigest, implementation_digest: implementationDigest, available_from: JAVASCRIPT_TYPESCRIPT_VERSION, selectable_to: "", removed_at: "" }],
    analyzer_implementation_manifest: analyzer,
    analysis_configuration: configuration,
    runtime_behavior_manifests: [behavior],
    runtime_implementation_manifests: implementationV1 === undefined ? [] : [implementationV1],
    ...(implementationV2 === undefined ? {} : { runtime_implementation_manifests_v2: [implementationV2], runtime_executable_binding: runtimeExecutableBinding! }),
  });
}

export const JAVASCRIPT_TYPESCRIPT_PAYLOAD_SCHEMAS = Object.freeze({ entity: entityPayload, relation: relationPayload, diagnostic: diagnosticPayload });
