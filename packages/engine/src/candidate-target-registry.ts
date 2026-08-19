import {
  capabilityRegistry,
  facetRegistry,
  universalEntityKinds,
  universalRelationKinds,
  type CanonicalSchemaDefinition,
  type CanonicalTypeExpression,
  type ClosedPayloadSchema,
  type PayloadPropertyDefinition,
  type RecordKindDefinition,
} from "@urdira/contracts";
import type { AssembledPluginRegistry } from "@urdira/plugin-sdk";
import type { CandidateTargetRegistry, RegisteredArtifactVersion, RegisteredRecordKind } from "./fact-delta.js";

const DEFINITION_IDENTIFIERS = Object.freeze({
  capability_contract_definitions: "capability",
  construct_class_definitions: "construct_code",
  capability_limitation_definitions: "limitation_code",
  record_kind_definitions: "kind",
  facet_definitions: "facet",
  semantic_role_definitions: "role",
  metric_definitions: "metric",
  effect_definitions: "effect",
  diagnostic_code_definitions: "code",
  candidate_issue_code_definitions: "issue_code",
  dependency_role_definitions: "dependency_role",
  projection_kind_definitions: "projection_kind",
  lifecycle_reason_code_definitions: "reason_code",
  completeness_reason_definitions: "reason_code",
  semantic_section_kind_definitions: "section_kind",
  semantic_reason_definitions: "reason_code",
  evidence_assumption_definitions: "assumption_code",
  evidence_explanation_definitions: "explanation_code",
} as const);

function payloadProperty(field: CanonicalTypeExpression): PayloadPropertyDefinition | undefined {
  if (field === null || typeof field !== "object" || Array.isArray(field)) return undefined;
  const value = field as unknown as Record<string, unknown>;
  const kind = value["type_kind"];
  if (kind === "text") return { type: "string", description: "Canonical text field." };
  if (kind === "safe_integer") return { type: "integer", description: "Canonical safe integer field.", ...(typeof value["minimum"] === "number" ? { minimum: value["minimum"] as number } : {}), ...(typeof value["maximum"] === "number" ? { maximum: value["maximum"] as number } : {}) };
  if (kind === "boolean") return { type: "boolean", description: "Canonical boolean field." };
  if (kind === "enum" && Array.isArray(value["values"]) && value["values"].every((entry) => typeof entry === "string")) return { type: "string", enum: value["values"] as string[], description: "Closed canonical enum field." };
  return undefined;
}

function closedPayloadSchema(schema: CanonicalSchemaDefinition | undefined): ClosedPayloadSchema | undefined {
  if (schema?.root_type.type_kind !== "record") return undefined;
  const properties: Record<string, PayloadPropertyDefinition> = {};
  const required: string[] = [];
  for (const field of schema.root_type.fields) {
    const property = payloadProperty(field.value_type);
    if (property === undefined) return undefined;
    properties[field.field_name] = { ...property, description: field.description };
    if (field.presence === "required") required.push(field.field_name);
  }
  return { type: "object", additionalProperties: false, properties, required };
}

/** Materialize the core validator view from one immutable assembled registry. */
export function candidateTargetRegistryFromSnapshot(input: {
  readonly registry: AssembledPluginRegistry;
  readonly artifact_versions?: readonly RegisteredArtifactVersion[];
}): CandidateTargetRegistry {
  const identifiers = new Set<string>([...capabilityRegistry, ...facetRegistry, ...universalEntityKinds, ...universalRelationKinds]);
  for (const contribution of input.registry.contributions) identifiers.add(contribution.plugin_id);
  for (const [field, identifierField] of Object.entries(DEFINITION_IDENTIFIERS)) {
    for (const definition of input.registry.definitions[field] ?? []) {
      if (definition !== null && typeof definition === "object" && !Array.isArray(definition)) {
        const identifier = (definition as Record<string, unknown>)[identifierField];
        if (typeof identifier === "string") identifiers.add(identifier);
      }
    }
  }
  const schemas = new Map((input.registry.definitions["canonical_schema_definitions"] ?? []).map((value) => {
    const schema = value as CanonicalSchemaDefinition;
    return [schema.schema_id, schema] as const;
  }));
  const kinds = (input.registry.definitions["record_kind_definitions"] ?? []) as readonly RecordKindDefinition[];
  const recordKinds = new Map<string, RegisteredRecordKind>(kinds.map((definition) => {
    const bodySchema = closedPayloadSchema(schemas.get(definition.payload_schema));
    return [definition.kind, {
      kind: definition.kind,
      category: definition.category,
      universal_kind: definition.universal_kind,
      schema_version: definition.schema_version,
      allowed_facets: definition.allowed_facets,
      required_facets: definition.required_facets,
      ...(bodySchema === undefined ? {} : { body_schema: bodySchema }),
    }];
  }));
  const dependencyRoles = new Set((input.registry.definitions["dependency_role_definitions"] ?? []).flatMap((value) => {
    const role = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)["dependency_role"] : undefined;
    return typeof role === "string" ? [role] : [];
  }));
  return Object.freeze({
    registry_snapshot_id: input.registry.registry_snapshot_id,
    identifiers,
    record_kinds: recordKinds,
    dependency_roles: dependencyRoles,
    ...(input.artifact_versions === undefined ? {} : { artifact_versions: new Map(input.artifact_versions.map((entry) => [entry.artifact_version_id, entry])) }),
  });
}
