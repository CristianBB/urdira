import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  authoritativeModelNames,
  artifactChangeKinds,
  modelContractRegistry,
  canonicalSchemaRegistry,
  coreSchemaDefinitions,
  comparatorRegistry,
  generatedJsonSchemaRegistry,
  generateJsonSchema,
  getGeneratedJsonSchema,
  modelRegistry,
  authoritativeModelFieldMetadata,
  authoritativePayloadMetadata,
  operationErrorDefinitions,
  operationErrorRegistry,
  operationDefinitions,
  operationRegistry,
  comparatorDefinitions,
  diagnosticDefinitions,
  diagnosticRegistry,
  candidateIssueDefinitions,
  candidateIssueRegistry,
  recipeRegistry,
  queryAlgebraOperatorIds,
  toCanonicalName,
  toPublicName,
  validateSchemaDefinition,
  validateSchemaValue,
  validateSchemaReferenceGraph,
} from "@urdira/contracts";
import type {
  CanonicalSchemaDefinition,
  EntityRecord,
  AnalysisConfiguration,
  IndexCandidate,
} from "@urdira/contracts";

const testSchema: CanonicalSchemaDefinition = {
  schema_id: "core:test_contract",
  definition_revision: 1,
  schema_version: 1,
  description: "A closed contract used to verify Schema IR behavior.",
  root_type: {
    type_kind: "union",
    discriminator_field: "kind",
    discriminator_description: "The exact closed variant discriminator.",
    variants: [
      {
        discriminator_value: "entity",
        description: "An entity variant.",
        fields: [
          {
            field_name: "owner_artifact_id",
            description: "The exact owning artifact identifier.",
            presence: "required",
            value_type: { type_kind: "text" },
          },
        ],
      },
      {
        discriminator_value: "empty",
        description: "An empty variant.",
        fields: [],
      },
    ],
  },
  type_definitions: [],
  lifecycle_state: "active",
};

const modelFixture = JSON.parse(readFileSync(new URL("./fixtures/contracts/model-fields.json", import.meta.url), "utf8")) as { models: Array<{ name: string; fields: string[] }> };
const modelInventoryFixture = JSON.parse(readFileSync(new URL("./fixtures/contracts/model-inventory.json", import.meta.url), "utf8")) as { authoritative_model_count: number; artifact_change_enum_count_excluded: number; required_field_metadata: boolean };
const registryFixture = JSON.parse(readFileSync(new URL("./fixtures/contracts/registry-families.json", import.meta.url), "utf8")) as { operations: string[]; comparators: string[]; errors: string[]; diagnostics: string[]; candidateIssues: string[] };
const schemaValueFixture = JSON.parse(readFileSync(new URL("./fixtures/contracts/schema-values.json", import.meta.url), "utf8")) as { valid: Array<{ type: unknown; value: unknown }>; invalid: Array<{ type: unknown; value: unknown }> };
const authoritativeFieldFixture = JSON.parse(readFileSync(new URL("./fixtures/contracts/authoritative-field-comparison.json", import.meta.url), "utf8")) as { fields: Array<{ model?: string; operation?: string; field: string; logical_type: string; description: string; source: string }> };
const fullConformanceFixture = JSON.parse(readFileSync(new URL("./fixtures/contracts/v5-contract-conformance.json", import.meta.url), "utf8")) as any;
const v7Authority = JSON.parse(readFileSync(new URL("./fixtures/contracts/v7-normative-authority.json", import.meta.url), "utf8")) as any;
const v8Authority = JSON.parse(readFileSync(new URL("./fixtures/contracts/v8-normative-authority.json", import.meta.url), "utf8")) as any;
const v9Authority = JSON.parse(readFileSync(new URL("./fixtures/contracts/v9-normative-authority.json", import.meta.url), "utf8")) as any;
const v10Authority = JSON.parse(readFileSync(new URL("./fixtures/contracts/v10-normative-authority.json", import.meta.url), "utf8")) as any;

function initialCandidateFixture(): IndexCandidate {
  return {
    candidate_generation_id: "candidate:initial",
    workspace_id: "workspace:initial",
    target_registry_snapshot_id: "registry:initial",
    target_configuration_revision_id: "configuration:initial",
    trigger_kind: "initial",
    state: "queued",
    source_observation_batch_ids: [],
    created_at: "2026-08-10T00:00:00.000Z",
    issue_ids: [],
  };
}

describe("Task 2 contract registries", () => {
  it("keeps source-transition target template metadata consistent with its declarations", () => {
    const expected = {
      target_artifact_version_without_generation: "CandidateArtifactVersionTemplate",
      target_artifact_tombstone_without_generation: "CandidateArtifactTombstoneTemplate",
    } as const;
    for (const name of Object.keys(expected) as Array<keyof typeof expected>) {
      const logicalType = expected[name];
      const metadata = authoritativeModelFieldMetadata[`CandidateSourceTransitionTemplate.${name}`];
      const materialized = modelContractRegistry.find((model) => model.name === "CandidateSourceTransitionTemplate")?.fields.find((field) => field.name === name);
      expect(metadata.logical_type).toBe(logicalType);
      expect(materialized?.logical_type).toBe(logicalType);
    }
  });

  it("accepts corrected candidate schemas and rejects their former scalar collection shapes", () => {
    const valueFor = (logicalType: string, active = new Set<string>()): unknown => {
      const sequence = logicalType.match(/^Sequence<(.+)>$/);
      if (sequence) return [];
      const set = logicalType.match(/^Set<(.+)>$/);
      if (set) return [];
      if (logicalType.startsWith("OrderedSet<")) return [];
      if (logicalType === "Count") return 0;
      if (logicalType === "PositiveInteger") return 1;
      if (logicalType === "Boolean") return true;
      if (logicalType === "Digest") return `sha256:${"0".repeat(64)}`;
      if (logicalType === "Bytes" || logicalType === "SchemaBoundBytes") return new Uint8Array([0]);
      if (logicalType === "Identifier") return "id";
      if (logicalType === "NamespacedIdentifier") return "core:id";
      if (logicalType === "SemVer") return "1.0.0";
      if (logicalType === "JsonValue") return {};
      if (logicalType.includes(" | ")) return logicalType.split(" | ")[0];
      const model = modelContractRegistry.find((candidate) => candidate.name === logicalType);
      if (!model || active.has(logicalType)) return "value";
      const next = new Set([...active, logicalType]);
      return Object.fromEntries(model.fields.filter((field) => field.presence === "required").map((field) => [field.name, valueFor(field.logical_type, next)]));
    };
    const schema = (typeName: string): CanonicalSchemaDefinition => ({
      schema_id: `core:test_phase9_${typeName}`,
      definition_revision: 1,
      schema_version: 1,
      description: "A Phase 9 candidate contract fixture.",
      root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: typeName, schema_id: `core:${typeName}`, schema_version: 1 },
      type_definitions: [],
      lifecycle_state: "active",
    });
    const cases = [
      ["IndexCandidate", "source_observation_batch_ids"],
      ["CandidateWorkManifest", "artifact_work_set"],
      ["ArtifactWorkItem", "capabilities"],
      ["ProjectionWorkItem", "reason_codes"],
      ["InvalidationPlan", "fallback_scopes"],
      ["FactDelta", "replacement_scopes"],
      ["ReplacementScope", "record_categories"],
    ] as const;
    for (const [typeName, formerScalarField] of cases) {
      const valid = valueFor(typeName) as Record<string, unknown>;
      expect(() => validateSchemaValue(schema(typeName), valid), typeName).not.toThrow();
      expect(() => validateSchemaValue(schema(typeName), { ...valid, [formerScalarField]: "not-a-collection" }), typeName).toThrow(/array|record|model object/u);
    }
  });

  it("represents initial candidate bases as absent and candidate collections as sequences", () => {
    const initial = initialCandidateFixture();
    expect(initial.base_snapshot_id).toBeUndefined();
    expect(initial.source_observation_batch_ids).toEqual([]);

    const field = (model: string, name: string) => modelContractRegistry
      .find((candidate) => candidate.name === model)?.fields.find((candidate) => candidate.name === name);
    expect(field("IndexCandidate", "base_snapshot_id")?.presence).toBe("optional");
    expect(field("IndexCandidate", "source_observation_batch_ids")?.logical_type).toBe("Sequence<Text>");
    expect(field("CandidateWorkManifest", "base_snapshot_id")?.presence).toBe("optional");
    expect(field("ArtifactWorkItem", "capabilities")?.logical_type).toBe("Sequence<Text>");
    expect(field("ProjectionWorkItem", "reason_codes")?.logical_type).toBe("Sequence<Text>");
    expect(field("InvalidationPlan", "fallback_scopes")?.logical_type).toBe("Sequence<Text>");
    expect(field("FactDelta", "replacement_scopes")?.logical_type).toBe("Sequence<ReplacementScope>");
    expect(field("ReplacementScope", "partition_key")?.presence).toBe("optional");
  });

  it("publishes the authoritative model inventory without duplicates", () => {
    expect(modelRegistry).toHaveLength(modelInventoryFixture.authoritative_model_count);
    expect(authoritativeModelNames).toHaveLength(modelInventoryFixture.authoritative_model_count);
    expect(new Set(modelRegistry.map((model) => model.name)).size).toBe(400);
    expect(modelContractRegistry).toHaveLength(modelInventoryFixture.authoritative_model_count);
    expect(modelInventoryFixture.required_field_metadata).toBe(true);
    expect(modelContractRegistry.every((model) => model.owner_decision.length > 0 && model.fields.length > 0)).toBe(true);
    expect(modelContractRegistry.every((model) => model.fields.every((field) => (field.name !== "value" || model.name === "LiteralTarget") && !field.description.startsWith("The complete closed value defined") && field.description.length > 0 && field.source.length > 0))).toBe(true);
    expect(modelRegistry.find((model) => model.name === "EntityRecord")).toMatchObject({
      description: expect.any(String),
    });
    expect(modelRegistry.find((model) => model.name === "QueryRequest")).toMatchObject({
      description: expect.any(String),
    });
  });

  it("keeps every exported model field authority value identical", () => {
    const registryFields = new Map(modelContractRegistry.flatMap((model) => model.fields.map((field) => [`${model.name}.${field.name}`, field] as const)));
    const metadataFields = Object.keys(authoritativeModelFieldMetadata).sort();
    expect(metadataFields).toEqual([...registryFields.keys()].sort());
    for (const [key, field] of registryFields) {
      expect(authoritativeModelFieldMetadata[key as keyof typeof authoritativeModelFieldMetadata], key).toMatchObject({ logical_type: field.logical_type, description: field.description, source: field.source });
    }
  });

  it("publishes closed public selector and result contracts without catch-all aliases", () => {
    const declarationFile = readFileSync(new URL("../packages/contracts/dist/models.d.ts", import.meta.url), "utf8");
    expect(declarationFile).not.toMatch(/type (SubjectSelector|StructuralFilter|RelationSelector|RegistrySelector|ChangeDescriptor) = unknown/);
    expect(declarationFile).not.toMatch(/interface [A-Za-z0-9_]+\s*\{\s*\}/);
    expect(declarationFile).not.toMatch(/(?:=|:)\s*unknown\b/);
    expect(modelContractRegistry.find((model) => model.name === "SubjectSelector")?.owner_decision).toBe("protocol/public-query-contract.md");
    expect(modelContractRegistry.find((model) => model.name === "ChangeDescriptor")?.owner_decision).toBe("protocol/public-query-contract.md");
  });

  it("keeps public shared schemas optional where the authority says optional and closed where it says closed", () => {
    const matcher = operationDefinitions.find((operation) => operation.operation_id === "core:discover_definitions")?.argument_schema.properties["matcher"];
    expect(matcher?.required).toEqual(["text", "mode"]);
    expect(matcher?.properties?.["limit"]).toMatchObject({ type: "integer", minimum: 1 });

    const selector = operationDefinitions.find((operation) => operation.operation_id === "core:find_records")?.argument_schema.properties["selector"];
    expect(selector?.required).toEqual([]);
    expect(selector?.anyOf).toHaveLength(4);
    expect(selector?.additionalProperties).toBe(false);

    const change = operationDefinitions.find((operation) => operation.operation_id === "core:analyze_impact")?.argument_schema.properties["change"];
    expect(change?.oneOf).toHaveLength(8);
    expect(change?.oneOf?.find((variant) => variant.properties?.["changeType"]?.enum?.[0] === "rename")?.required).toEqual(["changeType", "newName"]);
  });

  it("publishes exact representative generated model fields through the package entrypoint", () => {
    const configuration: AnalysisConfiguration = {
      configuration_schema_id: "core:analysis_configuration",
      configuration_schema_version: 1,
      normalized_configuration: new Uint8Array(),
    };
    expect(configuration.configuration_schema_id).toBe("core:analysis_configuration");
    expect(modelContractRegistry.find((model) => model.name === "AnalysisConfiguration")?.fields).toEqual([
      expect.objectContaining({ name: "configuration_schema_id", presence: "required" }),
      expect.objectContaining({ name: "configuration_schema_version", presence: "required" }),
      expect.objectContaining({ name: "normalized_configuration", presence: "required" }),
    ]);
    expect(modelContractRegistry.find((model) => model.name === "ArtifactChange")?.fields.map((field) => field.name)).toEqual([
      "artifact_change_id", "workspace_id", "artifact_id", "change_kind", "previous_artifact_version_id",
      "new_artifact_version_id", "previous_tombstone_id", "new_tombstone_id", "cause_references", "lineage_evidence_record_ids",
    ]);
  });

  it("matches fixture-defined fields and registry family memberships", () => {
    for (const fixture of modelFixture.models) {
      const model = modelContractRegistry.find((candidate) => candidate.name === fixture.name);
      expect(model?.fields.map((field) => field.name)).toEqual(fixture.fields);
    }
    expect(operationDefinitions.map((operation) => operation.operation_id)).toEqual(expect.arrayContaining(registryFixture.operations));
    expect(comparatorDefinitions.map((comparator) => comparator.comparator_id)).toEqual(expect.arrayContaining(registryFixture.comparators));
    expect(operationErrorDefinitions.map((error) => error.code)).toEqual(expect.arrayContaining(registryFixture.errors));
    expect(diagnosticDefinitions.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining(registryFixture.diagnostics));
    expect(candidateIssueDefinitions.map((issue) => issue.issue_code)).toEqual(expect.arrayContaining(registryFixture.candidateIssues));
  });

  it("compares representative generated metadata against source-backed authority", () => {
    for (const expected of authoritativeFieldFixture.fields) {
      if (expected.model) {
        const actual = modelContractRegistry.find((model) => model.name === expected.model)?.fields.find((field) => field.name === expected.field);
        expect(actual).toMatchObject({ logical_type: expected.logical_type, description: expected.description, source: expected.source });
        expect(authoritativeModelFieldMetadata[`${expected.model}.${expected.field}` as keyof typeof authoritativeModelFieldMetadata]).toMatchObject({ logical_type: expected.logical_type, description: expected.description });
      } else {
        const actual = operationDefinitions.find((operation) => operation.operation_id === expected.operation)?.argument_fields.find((field) => field.name === expected.field);
        expect(actual).toMatchObject({ logical_type: expected.logical_type, description: expected.description, source: expected.source });
      }
    }
  });

  it("matches the complete source-backed model and registry conformance matrix", () => {
    expect(fullConformanceFixture.authority_kind).toBe("normative-source-table");
    expect(modelContractRegistry.map((model) => model.name)).toEqual(fullConformanceFixture.models.map((model: { name: string }) => model.name));
    expect(modelContractRegistry.every((model) => model.fields.length > 0 && model.fields.every((field) => field.description.length > 0 && field.source.length > 0 && field.logical_type.length > 0))).toBe(true);
    expect(operationDefinitions.map(({ operation_id, operation_version }) => ({ operation_id, operation_version }))).toEqual(fullConformanceFixture.operations);
    expect(recipeRegistry.map(({ recipe_id, recipe_version }) => ({ recipe_id, recipe_version }))).toEqual(fullConformanceFixture.recipes);
    expect(operationErrorDefinitions.map((entry) => entry.code)).toEqual(fullConformanceFixture.payloads.operation_errors);
    expect(diagnosticDefinitions.map((entry) => entry.code)).toEqual(fullConformanceFixture.payloads.diagnostics);
    expect(candidateIssueDefinitions.map((entry) => entry.issue_code)).toEqual(fullConformanceFixture.payloads.candidate_issues);
    expect(coreSchemaDefinitions.map(({ schema_id, schema_version }) => ({ schema_id, schema_version })).sort((left, right) => left.schema_id.localeCompare(right.schema_id))).toEqual([...fullConformanceFixture.schemas].sort((left: { schema_id: string }, right: { schema_id: string }) => left.schema_id.localeCompare(right.schema_id)));
  });

  it("keeps the checked-in CandidateMaterialization fixture generation-neutral except for its identity-salting candidate_generation_id", () => {
    const model = modelContractRegistry.find((candidate) => candidate.name === "CandidateMaterialization");
    const fixture = fullConformanceFixture.models.find((candidate: { name: string }) => candidate.name === "CandidateMaterialization");
    expect(fixture?.fields.map((field: { name: string }) => field.name)).toEqual(model?.fields.map((field) => field.name));
    // candidate_generation_id is deliberately present (see
    // packages/engine/src/candidate-materialization.ts CandidateMaterializer.seal):
    // materialization identity is salted by its owning candidate so a
    // plugin-upgrade generation over an unchanged tree never collides with
    // the previous candidate's already-published row. Every other
    // candidate-run-specific field stays absent.
    expect(model?.fields.some((field) => field.name === "candidate_generation_id")).toBe(true);
    expect(fixture?.fields.map((field: { name: string }) => field.name)).not.toEqual(expect.arrayContaining(["base_snapshot_id", "target_registry_snapshot_id", "target_configuration_revision_id", "work_manifest_id", "created_at"]));
  });

  it("keeps the six ArtifactChange transition values outside the 400-model inventory", () => {
    expect(modelInventoryFixture.artifact_change_enum_count_excluded).toBe(6);
    expect(artifactChangeKinds).toEqual(["created", "updated", "deleted", "excluded", "recreated", "reincluded"]);
    expect(artifactChangeKinds.every((kind) => !authoritativeModelNames.includes(kind as never))).toBe(true);
    expect(authoritativeModelNames).not.toContain("ArtifactChange.created");
  });

  it("enforces the normative RecordEnvelope inheritance matrix recursively", () => {
    expect(v7Authority.authority_kind).toBe("mechanically-transcribed-normative-v7");
    for (const [modelName, variant] of Object.entries(v7Authority.record_variants)) {
      const model = modelContractRegistry.find((candidate) => candidate.name === modelName);
      expect(model?.fields.map((field) => field.name)).toEqual(v7Authority.record_envelope_fields);
      expect(model?.fields.find((field) => field.name === "category")?.description).not.toBe("");
      const schema: CanonicalSchemaDefinition = {
        schema_id: `core:test_${modelName}`,
        definition_revision: 1,
        schema_version: 1,
        description: "A record inheritance validation fixture.",
        root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: modelName, schema_id: `core:${modelName}`, schema_version: 1 },
        type_definitions: [],
        lifecycle_state: "active",
      };
      expect(() => validateSchemaValue(schema, variant)).toThrow(/required/i);
    }
  });

  it("dispatches generic model references through closed CanonicalTypeExpression and QueryExpression variants", () => {
    const root = (typeName: string): CanonicalSchemaDefinition => ({
      schema_id: `core:test_${typeName}`,
      definition_revision: 1,
      schema_version: 1,
      description: "A closed union reference fixture.",
      root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: typeName, schema_id: `core:${typeName}`, schema_version: 1 },
      type_definitions: [],
      lifecycle_state: "active",
    });
    expect(() => validateSchemaValue(root("CanonicalTypeExpression"), { type_kind: "record", fields: [] })).not.toThrow();
    expect(() => validateSchemaValue(root("CanonicalTypeExpression"), { type_kind: "record" })).toThrow(/required|fields/i);
    expect(() => validateSchemaValue(root("CanonicalTypeExpression"), { type_kind: "record", fields: [], element_type: { type_kind: "text" } })).toThrow(/unknown|forbidden/i);
    expect(() => validateSchemaValue(root("QueryExpression"), { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } })).not.toThrow();
    expect(() => validateSchemaValue(root("QueryExpression"), { expression_type: "operation", operation: "core:find_records" })).toThrow(/required|arguments/i);
    expect(() => validateSchemaValue(root("QueryExpression"), { expression_type: "operation", operation: "core:find_records", arguments: {}, stages: [] })).toThrow(/unknown|forbidden/i);
  });

  it("closes QueryExpression operations, recipes, and pipeline topology against registered contracts", () => {
    const root = (typeName: string): CanonicalSchemaDefinition => ({
      schema_id: `core:v9_${typeName}`,
      definition_revision: 1,
      schema_version: 1,
      description: "A v9 query closure fixture.",
      root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: typeName, schema_id: `core:${typeName}`, schema_version: 1 },
      type_definitions: [],
      lifecycle_state: "active",
    });
    const operation = (argumentsValue: unknown) => ({ expression_type: "operation", operation: "core:find_records", arguments: argumentsValue });
    expect(() => validateSchemaValue(root("QueryExpression"), operation({ selector: { record_categories: ["entity"] } }))).not.toThrow();
    expect(() => validateSchemaValue(root("QueryExpression"), operation({ selector: { record_categories: ["entity"] }, unknown: 1 }))).toThrow(/unknown|forbidden/i);
    expect(() => validateSchemaValue(root("QueryExpression"), { expression_type: "operation", operation: "core:not_registered", arguments: {} })).toThrow(/registered|unknown/i);

    const validRecipe = {
      expression_type: "recipe",
      recipe_id: "core:trace_behavior",
      arguments: { subjects: [{ subject_type: "entity", entity_id: "entity-1" }], direction: "outbound", relations: {}, max_depth: 1 },
    };
    expect(() => validateSchemaValue(root("QueryExpression"), validRecipe)).not.toThrow();
    expect(() => validateSchemaValue(root("QueryExpression"), { ...validRecipe, arguments: { ...validRecipe.arguments, unknown: true } })).toThrow(/unknown|forbidden/i);
    expect(() => validateSchemaValue(root("QueryExpression"), { ...validRecipe, recipe_id: "core:not_registered" })).toThrow(/registered|unknown/i);

    const validPipeline = {
      expression_type: "pipeline",
      stages: [{ stage_id: "first", operator: "source.operation", inputs: [], arguments: { operation: "core:find_records", operation_arguments: { selector: { record_categories: ["entity"] } } } }],
      outputs: [{ stage_id: "first", output: "records" }],
    };
    expect(() => validateSchemaValue(root("QueryExpression"), validPipeline)).not.toThrow();
    expect(() => validateSchemaValue(root("QueryExpression"), { ...validPipeline, stages: [] })).toThrow(/non-empty|minimum|stage/i);
    expect(() => validateSchemaValue(root("QueryExpression"), { ...validPipeline, outputs: [] })).toThrow(/non-empty|minimum|output/i);
    expect(() => validateSchemaValue(root("QueryExpression"), { ...validPipeline, stages: [validPipeline.stages[0], { ...validPipeline.stages[0] }] })).toThrow(/duplicate|stage/i);
    expect(() => validateSchemaValue(root("QueryExpression"), { ...validPipeline, stages: [{ ...validPipeline.stages[0], operator: "not_registered" }] })).toThrow(/registered|operator/i);
    expect(() => validateSchemaValue(root("QueryExpression"), { ...validPipeline, outputs: [{ stage_id: "missing", output: "records" }] })).toThrow(/stage|reference/i);
    expect(() => validateSchemaValue(root("QueryExpression"), { ...validPipeline, stages: [{ ...validPipeline.stages[0], stage_id: "first" }, { ...validPipeline.stages[0], stage_id: "second", inputs: [{ stage_id: "second", output: "records" }] }], outputs: [{ stage_id: "second", output: "records" }] })).toThrow(/backward|topolog|precede|stage/i);
  });

  it("compares v9 exact field and payload authority rather than only registry membership", () => {
    expect(v9Authority.authority_kind).toBe("mechanically-transcribed-normative-v9");
    expect([...queryAlgebraOperatorIds]).toEqual(v9Authority.query.registered_operators);
    for (const expected of v9Authority.model_fields as Array<{ model: string; field: string; presence: string; logical_type: string; description: string; source: string }>) {
      const actual = modelContractRegistry.find((model) => model.name === expected.model)?.fields.find((field) => field.name === expected.field);
      expect(actual, `${expected.model}.${expected.field}`).toMatchObject({ presence: expected.presence, logical_type: expected.logical_type, description: expected.description, source: expected.source });
    }
    const payload = (code: string) => operationErrorDefinitions.find((entry) => entry.code === code)?.details_schema.properties ?? diagnosticDefinitions.find((entry) => entry.code === code)?.payload_schema.properties ?? candidateIssueDefinitions.find((entry) => entry.issue_code === code)?.payload_schema.properties;
    for (const [key, expected] of Object.entries(v9Authority.payload_properties) as Array<[string, { type: string; minItems: number; description: string }]>) {
      const split = key.lastIndexOf(".");
      const property = payload(key.slice(0, split))?.[key.slice(split + 1)];
      expect(property, key).toMatchObject(expected);
    }
  });

  it("accepts minimal closed arguments for every registered operation and rejects unknown keys", () => {
    const root: CanonicalSchemaDefinition = {
      ...testSchema,
      root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "QueryExpression", schema_id: "core:QueryExpression", schema_version: 1 },
    };
    expect(operationDefinitions.map((operation) => operation.operation_id)).toEqual(v10Authority.operations.map((operation: { operation_id: string }) => operation.operation_id));
    for (const expected of v10Authority.operations as Array<{ operation_id: string; arguments: Record<string, unknown> }>) {
      expect(() => validateSchemaValue(root, { expression_type: "operation", operation: expected.operation_id, arguments: expected.arguments }), expected.operation_id).not.toThrow();
      expect(() => validateSchemaValue(root, { expression_type: "operation", operation: expected.operation_id, arguments: { ...expected.arguments, unknown_v10: true } }), `${expected.operation_id} unknown`).toThrow(/unknown|forbidden/i);
    }
  });

  it("has no synthetic model or payload descriptions", () => {
    for (const pattern of v10Authority.forbidden_description_patterns as string[]) {
      expect(modelContractRegistry.flatMap((model) => model.fields).some((field) => field.description.includes(pattern)), pattern).toBe(false);
      expect(Object.values(authoritativeModelFieldMetadata).some((field) => field.description.includes(pattern)), pattern).toBe(false);
      const payloadSchemas = [
        ...operationErrorDefinitions.map((definition) => definition.details_schema),
        ...diagnosticDefinitions.map((definition) => definition.payload_schema),
        ...candidateIssueDefinitions.map((definition) => definition.payload_schema),
      ];
      expect(payloadSchemas.flatMap((schema) => Object.values(schema.properties)).some((field) => field.description.includes(pattern)), pattern).toBe(false);
    }
  });

  it("matches the independent v10 authority rows for typed fields and payload meanings", () => {
    for (const expected of v10Authority.model_fields as Array<{ model: string; field: string; logical_type: string; description: string }>) {
      const actual = modelContractRegistry.find((model) => model.name === expected.model)?.fields.find((field) => field.name === expected.field);
      expect(actual, `${expected.model}.${expected.field}`).toMatchObject({ logical_type: expected.logical_type, description: expected.description });
    }
    const payloadSchemas = new Map<string, any>();
    for (const definition of [...operationErrorDefinitions, ...diagnosticDefinitions, ...candidateIssueDefinitions]) {
      const schema = "details_schema" in definition ? definition.details_schema : definition.payload_schema;
      const code = "issue_code" in definition ? definition.issue_code : definition.code;
      for (const [field, property] of Object.entries(schema.properties)) payloadSchemas.set(`${code}.${field}`, property);
    }
    for (const expected of v10Authority.payload_fields as Array<{ code: string; field: string; description: string }>) expect(payloadSchemas.get(`${expected.code}.${expected.field}`), `${expected.code}.${expected.field}`).toMatchObject({ description: expected.description });
  });

  it("enforces every normative pipeline operator arity and closed argument rule", () => {
    const root: CanonicalSchemaDefinition = {
      ...testSchema,
      root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "QueryExpression", schema_id: "core:QueryExpression", schema_version: 1 },
    };
    const source = (stage_id: string) => ({ stage_id, operator: "source.operation", inputs: [], arguments: { operation: "core:find_records", operation_arguments: { selector: { record_categories: ["entity"] } } } });
    const reference = (stage_id: string, output = "records") => ({ stage_id, output });
    const pipeline = (operator: string, inputs: unknown[], args: Record<string, unknown>, output = "subjects") => ({ expression_type: "pipeline", stages: [source("one"), source("two"), { stage_id: "operator", operator, inputs, arguments: args }], outputs: [reference("operator", output)] });
    const validPredicate = { path: ["src"] };
    const cases: Array<{ operator: string; valid: unknown; invalid: unknown; output?: string }> = [
      { operator: "set.union", valid: pipeline("set.union", [reference("one"), reference("two")], {}), invalid: pipeline("set.union", [reference("one")], {}) },
      { operator: "set.intersection", valid: pipeline("set.intersection", [reference("one"), reference("two")], {}), invalid: pipeline("set.intersection", [reference("one")], {}) },
      { operator: "set.difference", valid: pipeline("set.difference", [reference("one"), reference("two")], {}), invalid: pipeline("set.difference", [reference("one")], {}) },
      { operator: "join", valid: pipeline("join", [reference("one"), reference("two")], { predicate: "same_subject", output: "pairs" }, "pairs"), invalid: pipeline("join", [reference("one")], { predicate: "same_subject", output: "pairs" }, "pairs"), output: "pairs" },
      { operator: "deduplicate", valid: pipeline("deduplicate", [reference("one")], { identity: "subject" }), invalid: pipeline("deduplicate", [], { identity: "subject" }) },
      { operator: "filter", valid: pipeline("filter", [reference("one")], { predicate: validPredicate }), invalid: pipeline("filter", [reference("one")], { predicate: { unknown: true } }) },
      { operator: "expand.relations", valid: pipeline("expand.relations", [reference("one")], { direction: "outbound", relations: {} }), invalid: pipeline("expand.relations", [reference("one")], { direction: "sideways", relations: [] }) },
      { operator: "select", valid: pipeline("select", [reference("one")], { outputs: [{ name: "selected", input: reference("one"), projection: "subjects" }] }, "selected"), invalid: pipeline("select", [], { outputs: [{ name: "selected", input: reference("one"), projection: "subjects" }] }, "selected"), output: "selected" }
    ];
    for (const testCase of cases) {
      expect(() => validateSchemaValue(root, testCase.valid), `${testCase.operator} valid`).not.toThrow();
      expect(() => validateSchemaValue(root, testCase.invalid), `${testCase.operator} invalid`).toThrow(/input|predicate|direction|relation|recipe|stage|operator|output|reference/i);
    }
    expect(() => validateSchemaValue(root, pipeline("bind.record_selector", [reference("one", "definition_set")], { record_categories: ["entity"] }, "selector"))).toThrow(/recipe/i);
    expect(() => validateSchemaValue(root, pipeline("bind.record_selector", [reference("one", "subjects")], { record_categories: ["entity"] }, "selector"))).toThrow(/definition_set|recipe/i);
    expect(() => validateSchemaValue(root, pipeline("bind.subject_record_selector", [reference("one")], {}, "selector"))).toThrow(/recipe/i);
    expect(() => validateSchemaValue(root, pipeline("source.operation", [reference("one")], { operation: "core:find_records", operation_arguments: { selector: { record_categories: ["entity"] } } }, "records"))).toThrow(/input/i);
    expect(() => validateSchemaValue(root, { expression_type: "pipeline", stages: [{ stage_id: "registry", operator: "source.registry", inputs: [], arguments: { matcher: { text: "x", mode: "exact" }, unknown_v10: true } }], outputs: [reference("registry", "definitions")] })).toThrow(/unknown/i);
    expect(() => validateSchemaValue(root, { expression_type: "pipeline", stages: [{ stage_id: "registry", operator: "source.registry", inputs: [], arguments: { matcher: { text: "x", mode: "exact" } } }], outputs: [reference("registry", "definitions")] })).not.toThrow();
    expect(() => validateSchemaValue(root, { expression_type: "pipeline", stages: [source("one"), { stage_id: "expanded", operator: "expand.operation", inputs: [reference("one", "records")], arguments: { operation: "core:find_references", input_argument: "target", operation_arguments: {} } }], outputs: [reference("expanded", "references")] })).not.toThrow();
    expect(() => validateSchemaValue(root, { expression_type: "pipeline", stages: [source("one"), source("two"), { stage_id: "joined", operator: "join", inputs: [reference("one"), reference("two")], arguments: { predicate: "relation_exists", relation_selector: {}, direction: "outbound", output: "pairs" } }], outputs: [reference("joined", "pairs")] })).not.toThrow();
    expect(() => validateSchemaValue(root, pipeline("select", [reference("one")], { outputs: [{ name: "selected", input: reference("two"), projection: "subjects" }] }, "selected"))).toThrow(/declared|input|earlier/i);
  });

  it("enforces every normative nonempty operation array and closed item enum", () => {
    const operationAuthority = v7Authority.operation_arrays as Record<string, { minItems: number; enum?: string[] }>;
    for (const [key, expected] of Object.entries(operationAuthority)) {
      const [operationId, fieldName] = key.split(".");
      if (!operationId || !fieldName) throw new Error(`Invalid operation authority key ${key}`);
      const operation = operationDefinitions.find((candidate) => candidate.operation_id === operationId);
      const property = operation?.argument_schema.properties?.[toPublicName(fieldName)];
      expect(property, key).toMatchObject({ type: "array", minItems: expected.minItems });
      if (expected.enum) expect(property?.items?.enum).toEqual(expected.enum);
    }
  });

  it("materializes the complete v7 recipe binding additions", () => {
    const recipeAuthority = v7Authority.recipe_bindings as Record<string, Array<[string, string, string]>>;
    for (const [recipeId, expectedBindings] of Object.entries(recipeAuthority)) {
      const recipe = recipeRegistry.find((candidate) => candidate.recipe_id === recipeId)!;
      for (const [recipePath, stageId, stagePath] of expectedBindings) {
        expect(recipe.argument_bindings).toEqual(expect.arrayContaining([{ recipe_argument_path: recipePath, stage_id: stageId, stage_argument_path: stagePath }]));
      }
    }
  });

  it("enforces independent payload authority and SchemaBoundBytes JSON Schema/runtime equivalence", () => {
    const payload = (code: string) => {
      const issue = [...operationErrorDefinitions, ...diagnosticDefinitions, ...candidateIssueDefinitions].find((entry: any) => (entry.code ?? entry.issue_code) === code)! as any;
      return issue.details_schema?.properties ?? issue.payload_schema.properties;
    };
    const payloadAuthority = v7Authority.payload_constraints as Record<string, { type?: string; minItems?: number; enum?: string[] }>;
    for (const [key, expected] of Object.entries(payloadAuthority)) {
      const [code, field] = key.split(".");
      if (!code || !field) throw new Error(`Invalid payload authority key ${key}`);
      const property = payload(code)[field];
      if (expected.type) expect(property, key).toMatchObject({ type: expected.type });
      if (expected.minItems) expect(property.minItems).toBe(expected.minItems);
      if (expected.enum) expect(property.items?.enum ?? property.enum).toEqual(expected.enum);
    }
    const schema = generatedJsonSchemaRegistry["core:AnalysisConfiguration@1"];
    expect(schema?.properties?.["normalizedConfiguration"]).toMatchObject({ minLength: 12 });
    expect(() => validateSchemaValue(coreSchemaDefinitions.find((definition) => definition.schema_id === "core:AnalysisConfiguration")!, {
      configuration_schema_id: "core:analysis_configuration",
      configuration_schema_version: 1,
      normalized_configuration: "base64url:"
    })).toThrow();
  });

  it("exposes generated TypeScript model shapes for the common record envelope", () => {
    const entity: EntityRecord = {
      record_id: "record-1",
      category: "entity",
      kind: "core:definition",
      universal_kind: "core:definition",
      facets: [],
      schema_version: 1,
      workspace_id: "workspace-1",
      owner_artifact_id: "artifact-1",
      owner_artifact_version_id: "artifact-version-1",
      valid_from_generation: 1,
      producer_id: "core.test",
      producer_version: "1.0.0",
      analysis_digest: "sha256:" + "0".repeat(64),
      analysis_configuration_digest: "sha256:" + "0".repeat(64),
      artifact_dependency_digest: "sha256:" + "0".repeat(64),
      payload: {},
      record_digest: "sha256:" + "0".repeat(64),
    };

    expect(entity.category).toBe("entity");
  });

  it("preserves JsonValue payload semantics for generic and specialized record references", () => {
    expect(v8Authority.authority_kind).toBe("mechanically-transcribed-normative-v8");
    expect(v8Authority.record_payload_models).toHaveLength(6);
    const digest = "sha256:" + "0".repeat(64);
    const envelope = {
      record_id: "record-1",
      category: "entity",
      kind: "core:definition",
      universal_kind: "core:definition",
      facets: [],
      schema_version: 1,
      workspace_id: "workspace-1",
      owner_artifact_id: "artifact-1",
      owner_artifact_version_id: "artifact-version-1",
      valid_from_generation: 1,
      producer_id: "core.test",
      producer_version: "1.0.0",
      analysis_digest: digest,
      analysis_configuration_digest: digest,
      artifact_dependency_digest: digest,
      payload: { nested: ["json", true, 1, null] },
      record_digest: digest,
    };
    const root = (typeName: string): CanonicalSchemaDefinition => ({
      schema_id: `core:test_${typeName}`,
      definition_revision: 1,
      schema_version: 1,
      description: "A record payload validation fixture.",
      root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: typeName, schema_id: `core:${typeName}`, schema_version: 1 },
      type_definitions: [],
      lifecycle_state: "active",
    });
    const categories: Record<string, string> = {
      RecordEnvelope: "entity",
      EntityRecord: "entity",
      RelationRecord: "relation",
      FactRecord: "fact",
      EvidenceRecord: "evidence",
      DiagnosticRecord: "diagnostic",
    };
    for (const typeName of v8Authority.record_payload_models as string[]) {
      const value = { ...envelope, category: categories[typeName] };
      expect(() => validateSchemaValue(root(typeName), value)).not.toThrow();
    }
    for (const typeName of v8Authority.record_payload_models as string[]) {
      expect(() => validateSchemaValue(root(typeName), { ...envelope, category: categories[typeName], payload: undefined })).toThrow(/payload|JsonValue|json/i);
    }
    expect(modelContractRegistry.filter((model) => v8Authority.record_payload_models.includes(model.name)).every((model) => model.fields.find((field) => field.name === "payload")?.logical_type === v8Authority.record_payload_logical_type)).toBe(true);
    for (const typeName of v8Authority.record_payload_models as string[]) expect(authoritativeModelFieldMetadata[`${typeName}.payload` as keyof typeof authoritativeModelFieldMetadata]).toMatchObject({ logical_type: "JsonValue", description: "Data validated by the registered kind schema." });
  });

  it("keeps the initial core registry counts aligned with the approved registries", () => {
    expect(operationRegistry).toHaveLength(18);
    expect(recipeRegistry).toHaveLength(11);
    expect(canonicalSchemaRegistry).toHaveLength(46);
    expect(comparatorRegistry).toHaveLength(18);
    expect(operationErrorRegistry).toHaveLength(47);
    expect(Object.keys(generatedJsonSchemaRegistry)).toHaveLength(46);
    expect(Object.values(generatedJsonSchemaRegistry).every((schema) => schema.$schema === "https://json-schema.org/draft/2020-12/schema")).toBe(true);
    expect(operationDefinitions.every((operation) => operation.operation_id && operation.operation_version && operation.argument_schema_id)).toBe(true);
    expect(new Set(operationDefinitions.map((operation) => operation.argument_schema_id)).size).toBeGreaterThan(1);
    expect(operationDefinitions.every((operation) => operation.argument_fields.length > 0 && operation.result_streams.length > 0)).toBe(true);
    expect(recipeRegistry.every((recipe) => recipe.operation_stages.length > 0 && recipe.argument_bindings.length > 0 && recipe.streams.length > 0)).toBe(true);
    expect(comparatorDefinitions.every((comparator) => comparator.sort_keys.length > 0)).toBe(true);
    expect(operationErrorDefinitions.every((error) => error.retryable_default !== undefined && error.recovery_actions.length > 0 && error.details_schema)).toBe(true);
    expect(diagnosticDefinitions.every((diagnostic) => diagnostic.allowed_scope_types.length > 0 && diagnostic.payload_schema)).toBe(true);
    expect(candidateIssueDefinitions.every((issue) => issue.allowed_phases.length > 0 && issue.payload_schema)).toBe(true);
    expect(operationErrorDefinitions.every((error) => Object.keys(error.details_schema.properties).length > 0)).toBe(true);
    expect(diagnosticDefinitions.every((diagnostic) => diagnostic.diagnostic_category.length > 0 && Object.keys(diagnostic.payload_schema.properties).length > 0)).toBe(true);
    expect(candidateIssueDefinitions.every((issue) => Object.keys(issue.payload_schema.properties).length > 0)).toBe(true);
    expect(operationRegistry[0]).toMatchObject({ operation_id: "core:discover_definitions", operation_version: 1, argument_schema_id: "core:DiscoverDefinitionsArguments" });
    expect(comparatorRegistry[0]).toMatchObject({ comparator_id: "core:record_artifact_dependency_order", sort_keys: expect.any(Array) });
    expect(operationErrorRegistry[0]).toMatchObject({ code: "core:request_invalid", retryable_default: expect.any(Boolean), recovery_actions: expect.any(Array), details_schema: expect.any(Object) });
    expect(diagnosticRegistry[0]).toMatchObject({ code: "core:parse_failed", allowed_scope_types: expect.any(Array), payload_schema: expect.any(Object) });
    expect(candidateIssueRegistry[0]).toMatchObject({ issue_code: "core:invalidation_plan_incomplete", allowed_phases: expect.any(Array), payload_schema: expect.any(Object) });
  });

  it("marks every defaultable recipe argument optional in its model contract and generated JSON Schema so bare-name recipe calls are not rejected", () => {
    // These fields are documented with a server-injected default in
    // `docs/protocol/public-query-contract.md`'s "Recipe argument defaults"
    // and `docs/protocol/core-intent-recipes.md`; `query-plan.ts`'s
    // `withRecipeArgumentDefaults` fills them in before schema validation.
    // A caller must be able to omit every one of them.
    const defaultableFields: ReadonlyArray<readonly [string, string]> = [
      ["LocateImplementationArguments", "query_class"],
      ["UnderstandChangeImpactArguments", "include_transitive"],
      ["UnderstandChangeImpactArguments", "include_tests"],
      ["PrepareNewFeatureArguments", "query_class"],
      ["TraceBehaviorArguments", "direction"],
      ["TraceBehaviorArguments", "relations"],
      ["TraceBehaviorArguments", "max_depth"],
      ["FindRelevantTestsArguments", "relationship_scope"],
      ["FindRelevantTestsArguments", "include_fixtures"],
      ["ExplainArchitectureSliceArguments", "views"],
      ["ExplainArchitectureSliceArguments", "max_relation_depth"],
      ["CompareWorkspacesArguments", "comparison_kinds"],
      ["CompareWorkspacesArguments", "correlation_policy"],
      ["SemanticToCallersArguments", "query_class"],
      ["SemanticToCallersArguments", "max_call_depth"],
      ["ResolveAndFindReferencesArguments", "include_declarations"],
    ];
    for (const [model, field] of defaultableFields) {
      const contractField = modelContractRegistry.find((candidate) => candidate.name === model)?.fields.find((candidate) => candidate.name === field);
      expect(contractField, `${model}.${field}`).toMatchObject({ presence: "optional" });
      const jsonSchema = generatedJsonSchemaRegistry[`core:${model}@1`];
      expect(jsonSchema?.required, `${model}.${field}`).not.toContain(toPublicName(field));
    }
    // The fields the recipe genuinely cannot run without -- listed as the
    // "Keep GENUINELY required" set -- stay required in both layers.
    const stillRequiredFields: ReadonlyArray<readonly [string, string]> = [
      ["ResolveAndFindReferencesArguments", "reference"],
      ["PrepareSymbolChangeArguments", "reference"],
      ["UnderstandChangeImpactArguments", "change"],
      ["PrepareSymbolChangeArguments", "change"],
      ["UnderstandChangeImpactArguments", "target"],
      ["LocateImplementationArguments", "query_text"],
      ["SemanticToCallersArguments", "query_text"],
      ["PrepareNewFeatureArguments", "task"],
      ["TraceBehaviorArguments", "subjects"],
      ["FindRelevantTestsArguments", "subjects"],
      ["DefinitionToInstancesArguments", "matcher"],
    ];
    for (const [model, field] of stillRequiredFields) {
      const contractField = modelContractRegistry.find((candidate) => candidate.name === model)?.fields.find((candidate) => candidate.name === field);
      expect(contractField, `${model}.${field}`).toMatchObject({ presence: "required" });
      const jsonSchema = generatedJsonSchemaRegistry[`core:${model}@1`];
      expect(jsonSchema?.required, `${model}.${field}`).toContain(toPublicName(field));
    }
  });

  it("covers every authoritative field, registry payload, and canonical schema through the package entrypoint", () => {
    expect(modelContractRegistry).toHaveLength(400);
    expect(modelContractRegistry.every((model) => model.fields.every((field) => field.logical_type.length > 0 && field.description.length > 0 && field.source.length > 0))).toBe(true);
    expect(modelContractRegistry.find((model) => model.name === "PluginPackageManifest")?.fields.find((field) => field.name === "package_files")).toMatchObject({ logical_type: "OrderedSet<PackageFileEntry, core:package_file_path_order@1>" });
    expect(modelContractRegistry.find((model) => model.name === "RuntimeComponentBehaviorManifest")?.fields.find((field) => field.name === "contract_bindings")).toMatchObject({ logical_type: "Set<RuntimeComponentContractBinding>" });
    for (const error of operationErrorDefinitions) for (const property of Object.values(error.details_schema.properties)) expect(property.description.length).toBeGreaterThan(0);
    for (const diagnostic of diagnosticDefinitions) for (const property of Object.values(diagnostic.payload_schema.properties)) expect(property.description.length).toBeGreaterThan(0);
    for (const issue of candidateIssueDefinitions) for (const property of Object.values(issue.payload_schema.properties)) expect(property.description.length).toBeGreaterThan(0);
    expect(operationDefinitions.every((operation) => operation.operation_id && Number.isSafeInteger(operation.operation_version) && operation.result_stream_definitions.every((stream) => stream.stream_name && stream.item_type && stream.fields.length > 0))).toBe(true);
    expect(recipeRegistry.every((recipe) => recipe.completeness_policy === "report" && recipe.recipe_digest.startsWith("sha256:") && recipe.operation_stages.every((stage) => stage.static_arguments_schema_id && stage.partial_arguments_schema_id && stage.argument_bindings.length >= 0))).toBe(true);
    expect(coreSchemaDefinitions.every((schema) => schema.description.length > 0 && (schema.root_type.type_kind !== "schema_reference" || generatedJsonSchemaRegistry[`${schema.schema_id}@${schema.schema_version}`]?.$defs?.[schema.root_type.type_name]))).toBe(true);
  });

  it("materializes the exact public-query nested contracts and closed enums", () => {
    const operation = (id: string) => operationDefinitions.find((candidate) => candidate.operation_id === id)!;
    const findRecords = operation("core:find_records");
    expect(findRecords.argument_schema.properties["selector"]).toMatchObject({ schema_id: "core:RecordStructuralSelector", additionalProperties: false });
    expect(findRecords.argument_schema.properties["selector"]?.properties).toMatchObject({
      recordCategories: { type: "array", items: { enum: ["entity", "relation", "fact", "evidence", "diagnostic"] } },
    });
    const source = operation("core:get_source").argument_schema.properties["source"]!;
    expect(source).toMatchObject({ schema_id: "core:SourceIncludeOptions", additionalProperties: false });
    expect(source.properties?.["mode"]?.enum).toEqual(["none", "signature", "relevant", "body"]);
    const relations = operation("core:expand_relations").argument_schema.properties["relations"]!;
    expect(relations).toMatchObject({ schema_id: "core:RelationSelector", additionalProperties: false });
    expect(operation("core:expand_relations").argument_schema.properties["direction"]?.enum).toEqual(["inbound", "outbound", "both"]);
    expect(operation("core:search_text").argument_schema.properties["syntax"]?.enum).toEqual(["literal", "safe_regex"]);
    expect(operation("core:search_text").argument_schema.properties["wordMode"]?.enum).toEqual(["substring", "identifier", "token"]);
    expect(operation("core:search_text").argument_schema.properties["resultProjection"]?.enum).toEqual(["match", "artifact", "record", "entity"]);
    expect(operation("core:search_semantic").argument_schema.properties["queryClass"]?.enum).toEqual(["natural_text", "identifier", "source_code", "mixed"]);
    expect(operation("core:resolve_symbol").argument_schema.properties["resolutionScope"]?.enum).toEqual(["visible", "workspace", "exports"]);
    expect(operation("core:compare").argument_schema.properties["comparisonKinds"]?.items?.enum).toEqual(["added", "removed", "changed", "moved", "correlated"]);
    const filter = operation("core:search_text").argument_schema.properties["filter"]!;
    expect(filter.properties?.["subjectTypes"]?.items?.enum).toEqual(["entity", "record", "artifact"]);
    const subject = operation("core:resolve_symbol").argument_schema.properties["contextArtifact"]!;
    expect(subject.type).toBe("string");
    const selectors = operation("core:find_references").argument_schema.properties["target"]!;
    expect(selectors.oneOf).toHaveLength(3);
    expect(selectors.oneOf?.map((variant) => variant.required)).toEqual(expect.arrayContaining([
      ["subjectType", "entityId"], ["subjectType", "recordId"], ["subjectType", "name"],
    ]));
    expect(selectors.oneOf?.filter((variant) => !variant.oneOf).every((variant) => variant.additionalProperties === false)).toBe(true);
  });

  it("materializes recipe coordinates, bindings, guards, and unclassified streams exactly", () => {
    const locate = recipeRegistry.find((recipe) => recipe.recipe_id === "core:locate_implementation")!;
    expect(locate.stages.every((stage) => stage.static_arguments_schema_id === "core:RecipeStaticArguments" && stage.static_arguments_schema_version === 1)).toBe(true);
    expect(locate.stages.find((stage) => stage.stage_id === "search")).toMatchObject({ partial_arguments_schema_id: "core:SearchHybridArguments", partial_arguments_schema_version: 1 });
    expect(locate.argument_bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipe_argument_path: "$/filter", stage_id: "search", stage_argument_path: "/filter" }),
    ]));
    expect(locate.stages.find((stage) => stage.stage_id === "implementations")?.static_arguments).toMatchObject({ filter: { kind_selector: { any_facets: ["core:definition"] } } });
    expect(locate.streams.find((stream) => stream.stream_name === "sources")).toMatchObject({ classification: "unclassified", classifications: ["unclassified"] });
    const definitionToInstances = recipeRegistry.find((recipe) => recipe.recipe_id === "core:definition_to_instances")!;
    expect(definitionToInstances.argument_bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipe_argument_path: "$/record_categories", stage_id: "record_selector", stage_argument_path: "/record_categories" }),
      expect.objectContaining({ recipe_argument_path: "$/producer_ids", stage_id: "record_selector", stage_argument_path: "/producer_ids" }),
      expect.objectContaining({ recipe_argument_path: "$/filter", stage_id: "record_selector", stage_argument_path: "/filter" }),
    ]));
    expect(recipeRegistry.find((recipe) => recipe.recipe_id === "core:prepare_symbol_change")?.guards[0]).toMatchObject({
      failure_error_code: ["core:selector_ambiguous", "core:selector_not_found"],
    });
  });

  it("materializes the closed payload enums and semantic lower bounds", () => {
    const payload = (code: string) => candidateIssueDefinitions.find((issue) => issue.issue_code === code)!.payload_schema.properties;
    expect(payload("core:source_input_unavailable")["availability_code"]?.enum).toEqual(["READ_FAILED", "PROVIDER_UNAVAILABLE", "CONTENT_CHANGED_DURING_READ", "CONTENT_VERIFICATION_FAILED"]);
    expect(payload("core:source_provider_resource_exhausted")["resource_kind"]?.enum).toEqual(["deadline", "response_bytes", "observations", "watch_events"]);
    expect(payload("core:analyzer_failed")["failure_stage"]?.enum).toEqual(["startup", "input_loading", "parsing", "semantic_analysis", "output_generation", "shutdown"]);
    expect(payload("core:plugin_resource_exhausted")["resource_kind"]?.enum).toEqual(["deadline", "memory_bytes", "output_bytes", "records", "dependencies", "context_operations", "context_bytes", "recursion_depth"]);
    expect(payload("core:identity_assignment_conflict")["conflict_kind"]?.enum).toEqual(["MULTIPLE_ACTIVE_MATCHES", "DUPLICATE_CREATED_ID", "CONTINUATION_PREDECESSOR_MISMATCH", "CLOSED_ID_REUSE"]);
    expect(payload("core:projection_output_invalid")["validation_kind"]?.enum).toEqual(["SCHEMA_INVALID", "OWNER_MISMATCH", "SOURCE_SET_EMPTY", "SOURCE_NOT_VISIBLE", "KEY_COLLISION", "UNDECLARED_SOURCE"]);
    expect(payload("core:atomic_publication_failed")["publication_step"]?.enum).toEqual(["BEGIN", "VALIDATE_BASE", "INSTALL_SOURCE_STATE", "INSTALL_CANONICAL", "INSTALL_PROJECTIONS", "INSTALL_MANIFEST", "SWAP_CURRENT_POINTER", "COMMIT"]);
    expect(payload("core:candidate_cleanup_failed")["resource_type"]?.enum).toEqual(["candidate_materialization", "retention_lease", "temporary_projection", "temporary_blob"]);
    expect(payload("core:candidate_cleanup_failed")["cleanup_operation"]?.enum).toEqual(["release", "delete", "compact"]);
    expect(payload("core:record_schema_invalid")["validation_error_count"]?.minimum).toBe(1);
    expect(payload("core:projection_output_invalid")["invalid_projection_count"]?.minimum).toBe(1);
    expect(payload("core:source_provider_resource_exhausted")["configured_limit"]?.minimum).toBe(1);
    expect(payload("core:analyzer_timeout")["elapsed_ms"]?.minimum).toBe(0);
    expect(payload("core:analyzer_timeout")["timeout_ms"]?.minimum).toBe(1);
  });

  it("materializes documented fields for inline canonical schemas", () => {
    expect(generatedJsonSchemaRegistry["core:AnalysisConfiguration@1"]).toMatchObject({
      properties: {
        configurationSchemaId: { type: "string" },
        configurationSchemaVersion: { type: "integer" },
        normalizedConfiguration: { type: "string" },
      },
      required: ["configurationSchemaId", "configurationSchemaVersion", "normalizedConfiguration"],
      additionalProperties: false,
    });
    expect(generatedJsonSchemaRegistry["core:Bytes@1"]).toMatchObject({
      type: "string",
      pattern: "^base64url:[A-Za-z0-9_-]*$",
    });
    expect(getGeneratedJsonSchema("core:VisibleSourceStateSet", 1)).toMatchObject({ type: "array", items: { $ref: expect.stringContaining("VisibleSourceStateEntry") } });
    expect(getGeneratedJsonSchema("core:ModelAssetManifest", 1)).toMatchObject({ $ref: expect.stringContaining("ModelAssetManifest") });
    expect(() => getGeneratedJsonSchema("core:does_not_exist@1")).not.toThrow();
    expect(getGeneratedJsonSchema("core:does_not_exist@1")).toBeUndefined();
    expect(coreSchemaDefinitions).toHaveLength(46);
    for (const definition of coreSchemaDefinitions) {
      expect(() => validateSchemaDefinition(definition)).not.toThrow();
      const generated = generatedJsonSchemaRegistry[`${definition.schema_id}@${definition.schema_version}`];
      expect(generated).toBeDefined();
      expect(generated?.description).toBe(definition.description);
      if (definition.root_type.type_kind === "record") expect(definition.root_type.fields.length).toBeGreaterThan(0);
      if (definition.root_type.type_kind === "schema_reference") expect(generated?.$defs?.[definition.root_type.type_name]).toBeDefined();
    }
  });
});

describe("Schema IR validation and JSON Schema generation", () => {
  it("converts canonical snake_case names to lower camel public names and back", () => {
    expect(toPublicName("owner_artifact_version_id")).toBe("ownerArtifactVersionId");
    expect(toCanonicalName("ownerArtifactVersionId")).toBe("owner_artifact_version_id");
  });

  it("generates a closed JSON Schema 2020-12 discriminated union with exact descriptions", () => {
    const generated = generateJsonSchema(testSchema);

    expect(generated.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(generated.oneOf).toHaveLength(2);
    expect(generated.oneOf?.[0]).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { const: "entity" },
        ownerArtifactId: { description: "The exact owning artifact identifier." },
      },
      required: ["kind", "ownerArtifactId"],
    });
    expect(generated.oneOf?.[1]).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["kind"],
    });
  });

  it("rejects unknown fields, invalid discriminators, and missing required fields", () => {
    expect(() => validateSchemaValue(testSchema, {
      kind: "entity",
      owner_artifact_id: "artifact-1",
      unknown: true,
    })).toThrow(/unknown field/i);
    expect(() => validateSchemaValue(testSchema, {
      kind: "not_registered",
    })).toThrow(/discriminator/i);
    expect(() => validateSchemaValue(testSchema, {
      kind: "entity",
    })).toThrow(/owner_artifact_id/i);
  });

  it("rejects malformed Schema IR definitions before they can be published", () => {
    expect(() => validateSchemaDefinition({
      ...testSchema,
      root_type: {
        type_kind: "record",
        fields: [
          {
            field_name: "duplicate",
            description: "First definition.",
            presence: "required",
            value_type: { type_kind: "text" },
          },
          {
            field_name: "duplicate",
            description: "Second definition.",
            presence: "required",
            value_type: { type_kind: "text" },
          },
        ],
      },
    })).toThrow(/duplicate field/i);
  });

  it("closes nested canonical fields and union variants in model references", () => {
    const root = (typeName: string): CanonicalSchemaDefinition => ({
      ...testSchema,
      root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: typeName, schema_id: `core:${typeName}`, schema_version: 1 },
    });
    const validRecord = { type_kind: "record", fields: [{ field_name: "good_name", description: "A valid field.", presence: "required", value_type: { type_kind: "text" } }] };
    expect(() => validateSchemaValue(root("CanonicalTypeExpression"), validRecord)).not.toThrow();
    expect(() => validateSchemaValue(root("CanonicalTypeExpression"), { type_kind: "record", fields: [{ field_name: "badName", description: "A field.", presence: "required", value_type: { type_kind: "text" } }] })).toThrow(/snake_case/i);
    expect(() => validateSchemaValue(root("CanonicalTypeExpression"), { type_kind: "record", fields: [
      { field_name: "duplicate_name", description: "First.", presence: "required", value_type: { type_kind: "text" } },
      { field_name: "duplicate_name", description: "Second.", presence: "required", value_type: { type_kind: "text" } },
    ] })).toThrow(/duplicate/i);
    const union = (variants: unknown[]) => ({ type_kind: "union", discriminator_field: "kind", discriminator_description: "The variant kind.", variants });
    const variant = (value: string, fields: unknown[] = []) => ({ discriminator_value: value, description: `The ${value} variant.`, fields });
    expect(() => validateSchemaValue(root("CanonicalTypeExpression"), union([variant("one"), variant("one")] ))).toThrow(/duplicate/i);
    expect(() => validateSchemaValue(root("CanonicalTypeExpression"), union([variant("one", [{ field_name: "kind", description: "Redeclared.", presence: "required", value_type: { type_kind: "text" } }])]))).toThrow(/discriminator/i);
    expect(() => validateSchemaValue(root("CanonicalTypeExpression"), { type_kind: "record", fields: [{ field_name: "nested", description: "Nested.", presence: "required", value_type: { type_kind: "record", fields: [
      { field_name: "nested_name", description: "First.", presence: "required", value_type: { type_kind: "text" } },
      { field_name: "nested_name", description: "Second.", presence: "required", value_type: { type_kind: "text" } },
    ] } }] })).toThrow(/duplicate/i);
  });

  it("closes query pipeline stages and validates nested outputs", () => {
    const root: CanonicalSchemaDefinition = {
      ...testSchema,
      root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "QueryExpression", schema_id: "core:QueryExpression", schema_version: 1 },
    };
    const valid = { expression_type: "pipeline", stages: [{ stage_id: "stage_one", operator: "source.operation", inputs: [], arguments: { operation: "core:find_records", operation_arguments: { selector: { record_categories: ["entity"] } } } }], outputs: [{ stage_id: "stage_one", output: "records" }] };
    expect(() => validateSchemaValue(root, valid)).not.toThrow();
    expect(() => validateSchemaValue(root, { ...valid, stages: [{ ...valid.stages[0], unexpected: true }] })).toThrow(/unknown/i);
    expect(() => validateSchemaValue(root, { ...valid, stages: [{ stage_id: "stage_one", operator: "source.operation", inputs: [] }] })).toThrow(/required|arguments/i);
    expect(() => validateSchemaValue(root, { ...valid, stages: [{ ...valid.stages[0], inputs: [{ stage_id: "source", output: "records", unexpected: true }] }] })).toThrow(/unknown/i);
    expect(() => validateSchemaValue(root, { ...valid, outputs: [{ stage_id: "stage_one", output: "records", unexpected: true }] })).toThrow(/unknown/i);
    expect(() => validateSchemaValue(root, { ...valid, outputs: [{ stage_id: "stage_one" }] })).toThrow(/required|output/i);
  });

  it("accepts canonical logical values and enforces their exact boundaries", () => {
    const logicalSchema: CanonicalSchemaDefinition = {
      ...testSchema,
      root_type: { type_kind: "record", fields: [
        { field_name: "decimal_value", description: "A decimal.", presence: "required", value_type: { type_kind: "exact_decimal", scale_policy: "significant", minimum: "decimal:1.20", maximum: "decimal:2.00" } },
        { field_name: "timestamp_value", description: "A timestamp.", presence: "required", value_type: { type_kind: "timestamp", earliest: "2026-08-08T00:00:00.000000000Z", latest: "2026-08-09T00:00:00.000000000Z" } },
        { field_name: "digest_value", description: "A digest.", presence: "required", value_type: { type_kind: "digest", allowed_hash_algorithms: ["sha256"] } },
      ] },
    };
    validateSchemaDefinition(logicalSchema);
    expect(() => validateSchemaValue(logicalSchema, {
      decimal_value: "decimal:1.20",
      timestamp_value: "2026-08-08T00:00:00.000000000Z",
      digest_value: `sha256:${"a".repeat(64)}`,
    })).not.toThrow();
    expect(() => validateSchemaValue(logicalSchema, {
      decimal_value: "decimal:1.2",
      timestamp_value: "2026-08-08T00:00:00.000000000Z",
      digest_value: `sha256:${"a".repeat(63)}`,
    })).toThrow();
  });

  it("materializes JsonValue as a JSON-only schema reference rather than text", () => {
    const schema: CanonicalSchemaDefinition = {
      ...testSchema,
      root_type: { type_kind: "record", fields: [{
        field_name: "payload",
        description: "Data validated by the registered kind schema.",
        presence: "required",
        value_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 },
      }] },
    };
    const generated = generateJsonSchema(schema);
    expect(generated.properties?.["payload"]?.oneOf).toHaveLength(6);
    expect(() => validateSchemaValue(schema, { payload: { nested: [true, null] } })).not.toThrow();
    expect(() => validateSchemaValue(schema, { payload: { nested: undefined } })).toThrow(/JSON|value/i);
  });

  it("validates fixture cases across every Schema IR variant", () => {
    for (const fixture of schemaValueFixture.valid) {
      const schema = { ...testSchema, root_type: fixture.type as CanonicalSchemaDefinition["root_type"] };
      expect(() => validateSchemaDefinition(schema)).not.toThrow();
      expect(() => validateSchemaValue(schema, fixture.value)).not.toThrow();
    }
    for (const fixture of schemaValueFixture.invalid) {
      const schema = { ...testSchema, root_type: fixture.type as CanonicalSchemaDefinition["root_type"] };
      expect(() => validateSchemaValue(schema, fixture.value)).toThrow();
    }
  });

  it("rejects unknown Schema IR definition fields and unresolved local references", () => {
    expect(() => validateSchemaDefinition({
      ...testSchema,
      root_type: { type_kind: "schema_reference", reference_scope: "local", type_name: "missing_type" },
    })).toThrow(/unknown|reference|missing/i);
    expect(() => validateSchemaDefinition({
      ...testSchema,
      root_type: { type_kind: "text", unexpected: true } as never,
    })).toThrow(/unknown field/i);
  });

  it("resolves references recursively and rejects missing targets, cycles, and unregistered comparators", () => {
    const referenced: CanonicalSchemaDefinition = {
      ...testSchema,
      schema_id: "core:referenced_contract",
      root_type: { type_kind: "record", fields: [{ field_name: "id", description: "The identifier.", presence: "required", value_type: { type_kind: "text" } }] },
    };
    const root: CanonicalSchemaDefinition = {
      ...testSchema,
      schema_id: "core:root_contract",
      root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "referenced_contract", schema_id: referenced.schema_id, schema_version: 1 },
    };
    expect(() => validateSchemaReferenceGraph([root, referenced])).not.toThrow();
    expect(() => validateSchemaValue(root, {} , { schemas: [root, referenced] })).toThrow(/required|id/i);
    expect(() => validateSchemaValue(root, { id: "ok" }, { schemas: [root, referenced] })).not.toThrow();
    expect(() => validateSchemaDefinition({ ...root, root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "missing", schema_id: "core:missing", schema_version: 1 } })).toThrow(/missing|reference/i);
    expect(() => validateSchemaDefinition({ ...testSchema, root_type: { type_kind: "ordered_set", element_type: { type_kind: "text" }, comparator_id: "core:not_registered", comparator_version: 1 } })).toThrow(/comparator/i);
    const cycleA: CanonicalSchemaDefinition = { ...testSchema, schema_id: "core:cycle_a", root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "cycle_b", schema_id: "core:cycle_b", schema_version: 1 } };
    const cycleB: CanonicalSchemaDefinition = { ...testSchema, schema_id: "core:cycle_b", root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "cycle_a", schema_id: "core:cycle_a", schema_version: 1 } };
    expect(() => validateSchemaReferenceGraph([cycleA, cycleB])).toThrow(/cycle/i);
  });

  it("rejects invalid reference scopes and materializes closed canonical model references", () => {
    expect(() => validateSchemaDefinition({
      ...testSchema,
      root_type: { type_kind: "schema_reference", reference_scope: "floating", type_name: "Thing", schema_id: "core:Thing", schema_version: 1 } as never,
    })).toThrow(/reference_scope|local or external/i);
    expect(() => validateSchemaValue(coreSchemaDefinitions.find((schema) => schema.schema_id === "core:ModelAssetManifest")!, "not-an-object")).toThrow(/closed|model object/i);
    expect(() => validateSchemaValue(coreSchemaDefinitions.find((schema) => schema.schema_id === "core:ModelAssetManifest")!, {})).toThrow(/required/i);
    const modelSchema = getGeneratedJsonSchema("core:ModelAssetManifest", 1);
    expect(modelSchema?.$defs?.["ModelAssetManifest"]).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(["schemaVersion", "modelProviderId", "modelIdentityDigest"]),
      properties: { ["modelIdentityDigest"]: { pattern: expect.stringContaining("sha256") } },
    });
    const matcherSchema = { ...testSchema, root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "DefinitionMatcher", schema_id: "core:DefinitionMatcher", schema_version: 1 } as const };
    expect(() => validateSchemaValue(matcherSchema, { text: "needle", mode: "exact" })).not.toThrow();
    expect(() => validateSchemaValue(matcherSchema, { text: "needle", mode: "exact", limit: 0 })).toThrow(/positive/i);
    expect(() => validateSchemaValue(matcherSchema, { text: "needle", mode: "exact", unexpected: true })).toThrow(/unknown/i);
  });

  it("preserves exact generated logical bounds, set uniqueness, and SchemaBoundBytes coordinates", () => {
    const generated = generateJsonSchema({
      ...testSchema,
      root_type: { type_kind: "record", fields: [
        { field_name: "decimal_value", description: "Exact decimal.", presence: "required", value_type: { type_kind: "exact_decimal", scale_policy: "significant", minimum: "decimal:1.20", maximum: "decimal:2.00" } },
        { field_name: "values", description: "Duplicate-free values.", presence: "required", value_type: { type_kind: "set", element_type: { type_kind: "text" }, minimum_item_count: 1, maximum_item_count: 2 } },
        { field_name: "configuration_schema_id", description: "Schema identifier.", presence: "required", value_type: { type_kind: "text", identifier_kind: "namespaced_identifier" } },
        { field_name: "configuration_schema_version", description: "Schema version.", presence: "required", value_type: { type_kind: "safe_integer", minimum: 1 } },
        { field_name: "normalized_configuration", description: "Schema-bound bytes.", presence: "required", value_type: { type_kind: "bytes", bound_schema_id_field: "configuration_schema_id", bound_schema_version_field: "configuration_schema_version" } },
      ] },
    });
    expect(generated.properties?.["decimalValue"]).toMatchObject({ pattern: expect.stringContaining("decimal"), "x-urdira-exact-decimal-minimum": "decimal:1.20", "x-urdira-exact-decimal-maximum": "decimal:2.00" });
    expect(generated.properties?.["values"]).toMatchObject({ uniqueItems: true, minItems: 1, maxItems: 2 });
    expect(generated.properties?.["normalizedConfiguration"]).toMatchObject({ "x-urdira-schema-bound-bytes": { schema_id_field: "configuration_schema_id", schema_version_field: "configuration_schema_version" } });
  });

  it("publishes authoritative owner sources and exact registry payload metadata", () => {
    expect(modelContractRegistry.filter((model) => ["SubjectSelector", "QueryRequest", "ChangeDescriptor"].includes(model.name)).every((model) => model.owner_decision === "protocol/public-query-contract.md" && model.fields.every((field) => field.source === "protocol/public-query-contract.md"))).toBe(true);
    expect(modelContractRegistry.find((model) => model.name === "IntentRecipeDefinition")).toMatchObject({ owner_decision: "protocol/core-intent-recipes.md" });
    expect(operationDefinitions.find((operation) => operation.operation_id === "core:find_records")?.argument_fields.map((field) => field.name)).toEqual(["selector"]);
    expect(operationDefinitions.find((operation) => operation.operation_id === "core:search_text")?.argument_fields.map((field) => field.name)).toEqual(["pattern", "syntax", "case_sensitive", "word_mode", "filter", "result_projection"]);
    expect(candidateIssueDefinitions.every((issue) => issue.issue_category && issue.default_retryability && issue.allowed_phases.length > 0 && issue.allowed_retryabilities.length === 1)).toBe(true);
  });

  it("retains logical field types and authoritative descriptions for every model contract", () => {
    expect(modelContractRegistry.every((model) => model.fields.every((field) => field.logical_type && field.description.length > 0 && !field.description.includes("authoritative field defined")))).toBe(true);
    expect(modelContractRegistry.find((model) => model.name === "PackageFileEntry")?.fields.find((field) => field.name === "executable")).toMatchObject({ logical_type: "Boolean" });
    expect(modelContractRegistry.find((model) => model.name === "WorkspaceConfigurationRevision")?.fields.find((field) => field.name === "effective_configuration_schema_version")).toMatchObject({ logical_type: "PositiveInteger" });
  });

  it("keeps closed public and recipe model contracts free of JsonValue aliases", () => {
    const closedNames = [
      "QueryRequest", "QueryScope", "SingleWorkspaceScope", "ComparisonScope", "QueryParticipant", "QueryExpression", "OperationExpression", "PipelineExpression", "RecipeExpression", "QueryStage", "StageOutputReference", "ResponseBudget", "QueryOptions", "ContinuationRequest", "DefinitionMatcher", "SubjectSelector", "StructuralFilter", "RelationSelector", "RegistrySelector", "ChangeDescriptor",
      "IntentRecipeDefinition", "IntentRecipeStageDefinition", "RecipeArgumentBinding", "IntentRecipeOutputDefinition", "IntentRecipeRankingBinding", "IntentRecipeGuardDefinition", "IntentRecipePaginationStream",
    ];
    const aliases = modelContractRegistry
      .filter((model) => closedNames.includes(model.name))
      .flatMap((model) => model.fields.filter((field) => field.logical_type === "JsonValue").map((field) => `${model.name}.${field.name}`));
    expect(aliases).toEqual([]);
    expect(modelContractRegistry.filter((model) => closedNames.includes(model.name)).every((model) => model.fields.length > 0)).toBe(true);
  });

  it("publishes typed operation and recipe structures rather than compact strings", () => {
    const findRecords = operationDefinitions.find((operation) => operation.operation_id === "core:find_records");
    expect(findRecords?.argument_schema).toMatchObject({ type: "object", additionalProperties: false, properties: expect.any(Object) });
    expect(findRecords?.result_stream_definitions[0]).toMatchObject({ stream_name: "records", item_type: "RecordEnvelope", classifications: ["confirmed"] });
    const recipe = recipeRegistry.find((candidate) => candidate.recipe_id === "core:locate_implementation");
    expect(recipe?.operation_stages[0]).toMatchObject({ stage_id: "search", operator_id: "core:search_hybrid", operator_version: 1, input_references: expect.any(Array), static_arguments: expect.any(Object), argument_bindings: expect.any(Array) });
    expect(recipe?.argument_bindings[0]).toMatchObject({ recipe_argument_path: expect.stringContaining("/") });
    expect(recipe?.pagination_streams[0]).toMatchObject({ stream_name: "implementations.confirmed", ordering_id: "core:query_manifest_stream_order", classifications: ["confirmed"] });
  });

  it("publishes exact payload property types, enums, and diagnostic emission text", () => {
    const candidate = candidateIssueDefinitions.find((issue) => issue.issue_code === "core:invalidation_plan_incomplete");
    expect(candidate?.payload_schema.properties["representative_artifact_ids"]).toMatchObject({ type: "array", items: { type: "string" } });
    expect(candidate?.payload_schema.properties["fallback_attempted"]).toMatchObject({ type: "boolean" });
    const diagnostic = diagnosticDefinitions.find((entry) => entry.code === "core:parse_failed");
    expect(diagnostic?.payload_schema.properties["recovered_region_count"]).toMatchObject({ type: "integer", minimum: 0 });
    expect(diagnostic?.emission_condition).toContain("selected language parser cannot produce");
    const unsupported = diagnosticDefinitions.find((entry) => entry.code === "core:unsupported_construct");
    expect(unsupported?.payload_schema.properties["support_level"]?.enum).toEqual(["none", "partial"]);
  });

  it("validates referenced model field types and nested model-reference definitions", () => {
    const manifest = coreSchemaDefinitions.find((schema) => schema.schema_id === "core:ModelAssetManifest");
    expect(() => validateSchemaValue(manifest!, {
      schema_version: "not-an-integer", model_provider_id: 7, model_id: "model", model_revision: "r1", architecture_id: "core:arch", model_format: "core:format",
      configuration_asset_digests: [7], weight_asset_digests: ["sha256:bad"], model_identity_digest: "sha256:bad",
    })).toThrow();
    const visible = getGeneratedJsonSchema("core:VisibleSourceStateSet", 1);
    expect(visible?.$defs?.["VisibleSourceStateEntry"]).toBeDefined();
    expect(visible?.$defs?.["VisibleSourceStateEntry"]?.oneOf).toHaveLength(2);
  });

  it("recursively validates closed public-query model-reference unions", () => {
    const selectorSchema: CanonicalSchemaDefinition = {
      schema_id: "core:test_subject_selector",
      definition_revision: 1,
      schema_version: 1,
      description: "A closed SubjectSelector reference fixture.",
      root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "SubjectSelector", schema_id: "core:SubjectSelector", schema_version: 1 },
      type_definitions: [],
      lifecycle_state: "active",
    };
    expect(() => validateSchemaValue(selectorSchema, { subject_type: "entity", entity_id: "entity-1" })).not.toThrow();
    expect(() => validateSchemaValue(selectorSchema, { subject_type: "entity" })).toThrow(/required|entity_id/i);
    expect(() => validateSchemaValue(selectorSchema, { subject_type: "artifact", artifact_id: "artifact-1", path: "src/a.ts" })).toThrow(/exactly one|artifact/i);
    expect(() => validateSchemaValue(selectorSchema, { subject_type: "symbol", name: "f", context_byte_offset: -1 })).toThrow(/non-negative|offset/i);
    expect(() => validateSchemaValue(selectorSchema, { subject_type: "stage_output", stage_id: "s", output: "o", extra: true })).toThrow(/stage_output|pipeline|unknown|extra/i);
  });

  it("checks comparator path compatibility and honors comparator context overrides", () => {
    expect(() => validateSchemaDefinition({ ...testSchema, root_type: { type_kind: "ordered_set", element_type: { type_kind: "text" }, comparator_id: "core:record_id_order", comparator_version: 1 } })).toThrow(/path|compatible|text/i);
    const customComparator = { comparator_id: "test:text_order", comparator_version: 1, sort_keys: [{ value_path: "", comparison_mode: "text_utf8" as const, direction: "ascending" as const, absent_order: "forbidden" as const }] };
    expect(() => validateSchemaDefinition({ ...testSchema, root_type: { type_kind: "ordered_set", element_type: { type_kind: "text" }, comparator_id: "test:text_order", comparator_version: 1 } }, { comparators: [customComparator] })).not.toThrow();
  });

  it("requires declared adjacent SchemaBoundBytes coordinates and closes field definitions", () => {
    expect(() => validateSchemaDefinition({ ...testSchema, root_type: { type_kind: "record", fields: [{ field_name: "normalized_configuration", description: "Bound bytes.", presence: "required", value_type: { type_kind: "bytes", bound_schema_id_field: "configuration_schema_id", bound_schema_version_field: "configuration_schema_version" } }] } })).toThrow(/coordinate|declared|configuration_schema_id/i);
    expect(() => validateSchemaDefinition({ ...testSchema, root_type: { type_kind: "record", fields: [{ field_name: "value", description: "Value.", presence: "sometimes", extra: true, value_type: { type_kind: "text" } }] } as never })).toThrow(/unknown|presence/i);
    expect(() => validateSchemaDefinition({ ...testSchema, root_type: { type_kind: "record", fields: [
      { field_name: "configuration_schema_id", description: "Schema identifier.", presence: "optional", value_type: { type_kind: "text" } },
      { field_name: "configuration_schema_version", description: "Schema version.", presence: "optional", value_type: { type_kind: "safe_integer", minimum: 1 } },
      { field_name: "normalized_configuration", description: "Bound bytes.", presence: "required", value_type: { type_kind: "bytes", bound_schema_id_field: "configuration_schema_id", bound_schema_version_field: "configuration_schema_version" } },
    ] } })).toThrow(/required|coordinate/i);
  });

  it("uses exact nested model metadata for canonical model references", () => {
    const packageManifest = coreSchemaDefinitions.find((schema) => schema.schema_id === "core:PluginPackageManifest");
    expect(() => validateSchemaValue(packageManifest!, {
      package_format_id: "core:plugin", package_format_version: 1, plugin_id: "core:plugin", plugin_version: "1.0.0",
      package_files: [{ normalized_relative_path: "a", content_digest: `sha256:${"a".repeat(64)}`, byte_length: "not-a-count", executable: false }],
    })).toThrow(/byte_length|Count|safe integer/i);
    const behaviorManifest = coreSchemaDefinitions.find((schema) => schema.schema_id === "core:RuntimeComponentBehaviorManifest");
    expect(() => validateSchemaValue(behaviorManifest!, {
      component_id: "core:component", component_version: "1.0.0", component_kind: "source_provider",
      contract_bindings: [{ component_kind: "source_provider", contract_version: "not-positive", configuration_schema_id: "core:Config", configuration_schema_version: "not-positive" }],
      configuration_schema_ids: [], algorithm_ids: [], supported_format_ids: [], deterministic_numeric_contract: "x", portable_behavior_rules: [],
    })).toThrow(/contract_version|schema_version|positive/i);
  });

  it("publishes exact payload types and closed values for cited registry fields", () => {
    const freshness = operationErrorDefinitions.find((entry) => entry.code === "core:freshness_wait_timeout")!;
    expect(freshness.details_schema.properties["waited_ms"]).toMatchObject({ type: "integer", minimum: 0 });
    expect(freshness.details_schema.properties["retry_after_ms"]).toMatchObject({ type: "integer", minimum: 0 });
    expect(freshness.details_schema.properties["pending_observation_counts"]).toMatchObject({ type: "array", items: { type: "integer", minimum: 0 } });
    const budget = operationErrorDefinitions.find((entry) => entry.code === "core:budget_invalid")!;
    expect(budget.details_schema.properties["provided"]).toMatchObject({ type: "integer", minimum: 0 });
    const schemaInvalid = candidateIssueDefinitions.find((entry) => entry.issue_code === "core:record_schema_invalid")!;
    expect(schemaInvalid.payload_schema.properties["uce_error_codes"]).toMatchObject({ type: "array", items: { type: "string" } });
    const provider = candidateIssueDefinitions.find((entry) => entry.issue_code === "core:source_provider_state_changed")!;
    expect(provider.payload_schema.properties["call"]?.enum).toEqual(["enumerate", "read", "reconcile"]);
    const embedding = diagnosticDefinitions.find((entry) => entry.code === "core:embedding_generation_failed")!;
    expect(embedding.payload_schema.properties["failure_kind"]?.enum).toEqual(["inference_error", "invalid_dimensions", "invalid_encoding", "non_finite_value", "normalization_mismatch", "digest_mismatch", "determinism_mismatch"]);
    const invariant = candidateIssueDefinitions.find((entry) => entry.issue_code === "core:work_manifest_inconsistent")!;
    expect(invariant.payload_schema.properties["invariant_code"]?.enum).toEqual(["DUPLICATE_WORK_ITEM", "INVALID_ARTIFACT_TRANSITION", "SCOPE_NOT_COVERED", "DIGEST_MISMATCH", "DIGEST_CONTRACT_MISMATCH", "CONTEXT_MISMATCH"]);
  });

  it("matches source-backed canonical model types and field descriptions", () => {
    const field = (model: string, name: string) => modelContractRegistry.find((candidate) => candidate.name === model)?.fields.find((candidate) => candidate.name === name);
    expect(field("AnalysisConfiguration", "configuration_schema_id")).toMatchObject({ logical_type: "NamespacedIdentifier" });
    expect(field("NormalizedQueryPlan", "operation_versions")).toMatchObject({ logical_type: "OrderedSet<OperationVersionBinding, core:operation_id_order@1>" });
    expect(field("NormalizedQueryPlan", "recipe_versions")).toMatchObject({ logical_type: "OrderedSet<RecipeVersionBinding, core:recipe_id_order@1>" });
    expect(field("ModelAssetManifest", "configuration_asset_digests")).toMatchObject({ logical_type: "Sequence<Digest>" });
    expect(field("ModelAssetManifest", "weight_asset_digests")).toMatchObject({ logical_type: "Sequence<Digest>" });
    expect(field("ModelAssetManifest", "model_identity_digest")).toMatchObject({ logical_type: "Digest" });
    expect(field("WorkspaceConfigurationRevision", "installation_policy_digest")).toMatchObject({ logical_type: "Digest" });
    expect(field("WorkspaceConfigurationRevision", "revision_digest")).toMatchObject({ logical_type: "Digest" });
    expect(modelContractRegistry.every((model) => model.fields.every((candidate) => !candidate.description.startsWith("|") && !candidate.description.includes("authoritative field defined")))).toBe(true);
  });

  it("publishes the documented logical authority for packaging, snapshot, and recipe digest fields", () => {
    const field = (model: string, name: string) => modelContractRegistry.find((candidate) => candidate.name === model)?.fields.find((candidate) => candidate.name === name);
    expect(field("ModelPackManifest", "manifest_schema_version")).toMatchObject({ logical_type: "PositiveInteger", description: "Positive core bootstrap-schema version used to decode and validate the complete closed manifest before any asset is opened. Unknown versions are rejected; fields from another version are never ignored." });
    expect(field("ModelPackManifest", "model_pack_id")).toMatchObject({ logical_type: "NamespacedIdentifier", description: "Stable canonical namespaced pack identifier whose uniqueness is enforced within an installation. It conveys no authenticated publisher ownership." });
    expect(field("ModelPackManifest", "model_pack_version")).toMatchObject({ logical_type: "SemVer", description: "Exact normalized SemVer 2.0.0 version permanently bound to one canonical manifest digest. Build metadata is preserved as part of the exact coordinate even though SemVer precedence ignores it." });
    expect(field("ModelPackManifest", "manifest_digest")).toMatchObject({ logical_type: "Digest", description: "Digest of exactly the six preceding fields under `core:model_pack_manifest_digest`; the digest field itself and all delivery metadata are omitted. Urdira recomputes it before collision checks or asset acquisition." });
    expect(field("Snapshot", "source_state_digest")).toMatchObject({ logical_type: "Digest" });
    expect(field("Snapshot", "snapshot_digest")).toMatchObject({ logical_type: "Digest" });
    expect(field("ArtifactVersion", "analysis_metadata_digest")).toMatchObject({ logical_type: "Digest" });
    expect(field("IntentRecipeDefinition", "recipe_digest")).toMatchObject({ logical_type: "Digest" });
  });

  it("does not expose broad text for documented digest, version, ordinal, or count coordinates", () => {
    const forbidden = modelContractRegistry.flatMap((model) => model.fields.filter((field) => {
      const name = field.name;
      return field.logical_type === "Text" && (name.endsWith("_digest") || name.endsWith("_version") || name.endsWith("_count") || name.endsWith("_ordinal") || name.endsWith("_length") || name.endsWith("_generation"));
    }).map((field) => `${model.name}.${field.name}`));
    expect(forbidden).toEqual([]);
  });

  it("rejects invalid recursive digest and SchemaBoundBytes model values", () => {
    const manifest = coreSchemaDefinitions.find((schema) => schema.schema_id === "core:ModelAssetManifest")!;
    const validManifest = {
      schema_version: 1, model_provider_id: "core:provider", model_id: "model", model_revision: "r1", architecture_id: "core:architecture", model_format: "core:format",
      configuration_asset_digests: [], weight_asset_digests: [`sha256:${"a".repeat(64)}`], model_identity_digest: `sha256:${"b".repeat(64)}`,
    };
    expect(() => validateSchemaValue(manifest, validManifest)).not.toThrow();
    expect(() => validateSchemaValue(manifest, { ...validManifest, weight_asset_digests: ["not-a-digest"] })).toThrow(/digest/i);
    expect(() => validateSchemaValue(manifest, { ...validManifest, weight_asset_digests: [] })).toThrow(/minimum|non-empty/i);
    const configuration = coreSchemaDefinitions.find((schema) => schema.schema_id === "core:AnalysisConfiguration")!;
    expect(() => validateSchemaValue(configuration, { configuration_schema_id: "core:Config", configuration_schema_version: 1, normalized_configuration: "base64url:AA" })).not.toThrow();
    expect(() => validateSchemaValue(configuration, { configuration_schema_id: "", configuration_schema_version: 1, normalized_configuration: "base64url:AA" })).toThrow(/namespaced|schema.*id|empty/i);
    expect(() => validateSchemaValue(configuration, { configuration_schema_id: "Config", configuration_schema_version: 1, normalized_configuration: "base64url:AA" })).toThrow(/namespaced/i);
    expect(() => validateSchemaValue(configuration, { configuration_schema_id: "core:Config", configuration_schema_version: 1, normalized_configuration: "base64url:" })).toThrow(/bytes|empty|coordinate/i);
  });

  it("recursively validates nested authoritative model references", () => {
    const nested = (typeName: string): CanonicalSchemaDefinition => ({
      schema_id: `core:nested_${typeName}`,
      definition_revision: 1,
      schema_version: 1,
      description: "A nested model-reference fixture.",
      root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: typeName, schema_id: `core:${typeName}`, schema_version: 1 },
      type_definitions: [],
      lifecycle_state: "active",
    });
    const packageEntry = { normalized_relative_path: "lib/index.js", content_digest: `sha256:${"a".repeat(64)}`, byte_length: 1, executable: false };
    expect(() => validateSchemaValue(nested("PackageFileEntry"), packageEntry)).not.toThrow();
    expect(() => validateSchemaValue(nested("PackageFileEntry"), { ...packageEntry, content_digest: "sha256:bad" })).toThrow(/digest/i);
    const binding = { component_kind: "source_provider", contract_version: 1 };
    expect(() => validateSchemaValue(nested("RuntimeComponentContractBinding"), binding)).not.toThrow();
    expect(() => validateSchemaValue(nested("RuntimeComponentContractBinding"), { ...binding, configuration_schema_id: "Config" })).toThrow(/namespaced/i);
  });

  it("restricts operation selector positions and requires non-empty selector dimensions", () => {
    const operation = (id: string) => operationDefinitions.find((candidate) => candidate.operation_id === id)!;
    const outline = operation("core:get_outline").argument_schema.properties["container"]!;
    const outlineDiscriminators = outline.oneOf?.flatMap((variant) => variant.properties?.["subjectType"]?.enum ?? variant.oneOf?.flatMap((nested) => nested.properties?.["subjectType"]?.enum ?? [])) ?? [];
    expect(outlineDiscriminators).toEqual(expect.arrayContaining(["entity", "record", "artifact"]));
    expect(outlineDiscriminators).not.toEqual(expect.arrayContaining(["symbol", "stage_output"]));
    const references = operation("core:find_references").argument_schema.properties["target"]!;
    const referenceDiscriminators = references.oneOf?.flatMap((variant) => variant.properties?.["subjectType"]?.enum ?? variant.oneOf?.flatMap((nested) => nested.properties?.["subjectType"]?.enum ?? [])) ?? [];
    expect(referenceDiscriminators).toEqual(expect.arrayContaining(["entity", "record", "symbol"]));
    expect(referenceDiscriminators).not.toEqual(expect.arrayContaining(["artifact", "stage_output"]));
    const selector = operation("core:find_records").argument_schema.properties["selector"]!;
    expect(selector.properties?.["recordCategories"]?.minItems).toBe(1);
    expect(selector.properties?.["producerIds"]?.minItems).toBe(1);
    const selectorSchema: CanonicalSchemaDefinition = {
      schema_id: "core:test_record_selector",
      definition_revision: 1,
      schema_version: 1,
      description: "A closed RecordStructuralSelector reference fixture.",
      root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "RecordStructuralSelector", schema_id: "core:RecordStructuralSelector", schema_version: 1 },
      type_definitions: [],
      lifecycle_state: "active",
    };
    expect(() => validateSchemaValue(selectorSchema, { record_categories: [] })).toThrow(/non-empty|minimum|empty/i);
    expect(() => validateSchemaValue(selectorSchema, { producer_ids: [] })).toThrow(/non-empty|minimum|empty/i);
  });

  it("materializes the normative recipe stream classifications instead of defaulting them", () => {
    const streams = (id: string) => recipeRegistry.find((recipe) => recipe.recipe_id === id)?.streams.map((stream) => `${stream.output_name}.${stream.classification}`) ?? [];
    expect(streams("core:locate_implementation")).toEqual(["implementations.confirmed", "implementations.possible", "sources.unclassified"]);
    expect(streams("core:semantic_to_callers")).toEqual(["matches.confirmed", "matches.possible", "callers.confirmed", "callers.possible", "call_paths.confirmed", "call_paths.possible", "tests.confirmed", "tests.possible", "sources.unclassified"]);
    expect(streams("core:resolve_and_find_references")).toEqual(expect.arrayContaining(["declarations.confirmed", "declarations.possible", "references.confirmed", "references.possible", "owners.confirmed", "owners.possible", "sources.unclassified"]));
    expect(recipeRegistry.every((recipe) => recipe.streams.some((stream) => stream.classification === "confirmed") || recipe.recipe_id === "core:definition_to_instances")).toBe(true);
  });

  it("matches the complete recipe stream authority table", () => {
    const expected: Record<string, string[]> = {
      "core:locate_implementation": ["implementations.confirmed", "implementations.possible", "sources.unclassified"],
      "core:understand_change_impact": ["will_break.confirmed", "will_break.possible", "must_update.confirmed", "must_update.possible", "may_be_affected.confirmed", "may_be_affected.possible", "tests_to_run.confirmed", "tests_to_run.possible", "uncertain_dynamic_usage.confirmed", "uncertain_dynamic_usage.possible", "sources.unclassified"],
      "core:prepare_symbol_change": ["target.confirmed", "target.possible", "will_break.confirmed", "will_break.possible", "must_update.confirmed", "must_update.possible", "may_be_affected.confirmed", "may_be_affected.possible", "tests_to_run.confirmed", "tests_to_run.possible", "uncertain_dynamic_usage.confirmed", "uncertain_dynamic_usage.possible", "references.confirmed", "references.possible", "tests.confirmed", "tests.possible", "fixtures.confirmed", "fixtures.possible", "mocks.confirmed", "mocks.possible", "helpers.confirmed", "helpers.possible", "sources.unclassified"],
      "core:prepare_new_feature": ["analogues.confirmed", "analogues.possible", "architecture.confirmed", "architecture.possible", "context.confirmed", "context.possible", "tests.confirmed", "tests.possible", "fixtures.confirmed", "fixtures.possible", "mocks.confirmed", "mocks.possible", "helpers.confirmed", "helpers.possible"],
      "core:trace_behavior": ["subjects.confirmed", "subjects.possible", "relations.confirmed", "relations.possible", "paths.confirmed", "paths.possible", "sources.unclassified"],
      "core:find_relevant_tests": ["tests.confirmed", "tests.possible", "fixtures.confirmed", "fixtures.possible", "mocks.confirmed", "mocks.possible", "helpers.confirmed", "helpers.possible", "sources.unclassified"],
      "core:explain_architecture_slice": ["architecture.confirmed", "architecture.possible", "sources.unclassified"],
      "core:compare_workspaces": ["added.confirmed", "added.possible", "removed.confirmed", "removed.possible", "changed.confirmed", "changed.possible", "moved.confirmed", "moved.possible", "correlated.confirmed", "correlated.possible"],
      "core:semantic_to_callers": ["matches.confirmed", "matches.possible", "callers.confirmed", "callers.possible", "call_paths.confirmed", "call_paths.possible", "tests.confirmed", "tests.possible", "sources.unclassified"],
      "core:resolve_and_find_references": ["declarations.confirmed", "declarations.possible", "candidates.confirmed", "candidates.possible", "references.confirmed", "references.possible", "owners.confirmed", "owners.possible", "sources.unclassified"],
      "core:definition_to_instances": ["definitions.unclassified", "instances.unclassified"],
    };
    for (const [recipeId, streams] of Object.entries(expected)) {
      expect(recipeRegistry.find((recipe) => recipe.recipe_id === recipeId)?.streams.map((stream) => `${stream.output_name}.${stream.classification}`)).toEqual(streams);
    }
  });

  it("enforces candidate payload lower bounds and field-level descriptions", () => {
    const candidate = candidateIssueDefinitions.find((issue) => issue.issue_code === "core:invalidation_plan_incomplete")!;
    expect(candidate.payload_schema.properties["unresolved_scope_count"]).toMatchObject({ type: "integer", minimum: 1 });
    expect(candidate.payload_schema.properties["reason_codes"]).toMatchObject({ type: "array", minItems: 1, items: { type: "string" } });
    const descriptions = Object.values(candidate.payload_schema.properties).map((property) => property.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("checks every payload family for closed property metadata and digest constraints", () => {
    const definitions = [
      ...operationErrorDefinitions.map((entry) => ({ code: entry.code, schema: entry.details_schema })),
      ...diagnosticDefinitions.map((entry) => ({ code: entry.code, schema: entry.payload_schema })),
      ...candidateIssueDefinitions.map((entry) => ({ code: entry.issue_code, schema: entry.payload_schema })),
    ];
    expect(definitions).toHaveLength(95);
    for (const { code, schema } of definitions) {
      const descriptions = Object.values(schema.properties).map((property) => property.description);
      expect(descriptions.every((description) => description.length > 0)).toBe(true);
      for (const [name, property] of Object.entries(schema.properties)) {
        if (property.type === "array") expect(property.items).toBeDefined();
        if (name.endsWith("_digest") || ["expected_digest", "actual_digest", "accepted_digest", "conflicting_digest", "content_digest", "request_digest"].includes(name)) expect(property.pattern).toBe("^(?:sha256):[0-9a-f]{64}$");
        if (name === "reason_codes") expect(property.minItems).toBe(1);
      }
      expect(code.startsWith("core:")).toBe(true);
    }
  });

  it("recursively enforces the exact ModelPackManifest logical contract", () => {
    const manifestSchema: CanonicalSchemaDefinition = {
      schema_id: "core:test_model_pack_manifest",
      definition_revision: 1,
      schema_version: 1,
      description: "A model manifest reference fixture.",
      root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "ModelPackManifest", schema_id: "core:ModelPackManifest", schema_version: 1 },
      type_definitions: [],
      lifecycle_state: "active",
    };
    const primitive = (logicalType: string): unknown => {
      if (logicalType.startsWith("Sequence<")) return [primitive(logicalType.slice(9, -1))];
      if (logicalType === "PositiveInteger") return 1;
      if (logicalType === "Count") return 0;
      if (logicalType === "Identifier") return "id";
      if (logicalType === "NamespacedIdentifier") return "core:id";
      if (logicalType === "SemVer") return "1.0.0";
      if (logicalType === "Digest") return `sha256:${"0".repeat(64)}`;
      if (logicalType === "Boolean") return true;
      if (logicalType === "Bytes" || logicalType === "SchemaBoundBytes") return "base64url:AA";
      if (logicalType === "JsonValue") return {};
      if (logicalType.includes(" | ")) return logicalType.split(" | ")[0];
      const nested = modelContractRegistry.find((model) => model.name === logicalType);
      if (nested) return Object.fromEntries(nested.fields.filter((field) => field.presence === "required").map((field) => [field.name, primitive(field.logical_type)]));
      return "value";
    };
    const manifest = Object.fromEntries(modelContractRegistry.find((model) => model.name === "ModelPackManifest")!.fields.map((field) => [field.name, primitive(field.logical_type)]));
    expect(() => validateSchemaValue(manifestSchema, { ...manifest, manifest_schema_version: "not-positive" })).toThrow();
    expect(() => validateSchemaValue(manifestSchema, { ...manifest, model_pack_id: "not-namespaced" })).toThrow();
    expect(() => validateSchemaValue(manifestSchema, { ...manifest, model_pack_version: "not-semver" })).toThrow();
    expect(() => validateSchemaValue(manifestSchema, { ...manifest, manifest_digest: "not-a-digest" })).toThrow();
    expect(() => validateSchemaValue(manifestSchema, { ...manifest, embedding_profiles: [] })).toThrow();
    expect(() => validateSchemaValue(manifestSchema, { ...manifest, assets: [] })).toThrow();
    expect(() => validateSchemaValue(manifestSchema, { ...manifest, required_runtime_components: [] })).toThrow();
  });

  it("builds the conformance fixture without importing the package build", () => {
    const generator = readFileSync(new URL("../packages/contracts/scripts/generate-contract-conformance-fixture.mjs", import.meta.url), "utf8");
    expect(generator).not.toContain("dist/index.js");
    expect(generator).not.toContain("model-contract-source.ts");
    expect(generator).not.toContain("model-field-authority.ts");
    expect(generator).not.toContain("model-names.ts");
    expect(generator).toContain("v7-normative-authority.json");
    expect(generator).toContain("core-intent-recipes.md");
    expect(generator).toContain("core-operation-error-codes.md");
  });

  it("materializes exact recipe bindings, projections, and evidence classifications", () => {
    const recipe = (id: string) => recipeRegistry.find((candidate) => candidate.recipe_id === id)!;
    expect(recipe("core:prepare_new_feature").argument_bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipe_argument_path: "$/filter", stage_id: "architecture", stage_argument_path: "/filter" }),
      expect.objectContaining({ recipe_argument_path: "$/task", stage_id: "context", stage_argument_path: "/task" }),
      expect.objectContaining({ recipe_argument_path: "$/query_class", stage_id: "context", stage_argument_path: "/query_class" }),
      expect.objectContaining({ recipe_argument_path: "$/filter", stage_id: "context", stage_argument_path: "/filter" }),
    ]));
    expect(recipe("core:semantic_to_callers").argument_bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipe_argument_path: "$/query_class", stage_id: "search", stage_argument_path: "/query_class" }),
      expect.objectContaining({ recipe_argument_path: "$/filter", stage_id: "callers", stage_argument_path: "/filter" }),
      expect.objectContaining({ recipe_argument_path: "$/max_call_depth", stage_id: "callers", stage_argument_path: "/max_depth" }),
      expect.objectContaining({ recipe_argument_path: "$/filter", stage_id: "tests", stage_argument_path: "/filter" }),
    ]));
    expect(recipe("core:resolve_and_find_references").argument_bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipe_argument_path: "$/context_artifact", stage_id: "resolve", stage_argument_path: "/context_artifact" }),
      expect.objectContaining({ recipe_argument_path: "$/context_byte_offset", stage_id: "resolve", stage_argument_path: "/context_byte_offset" }),
      expect.objectContaining({ recipe_argument_path: "$/reference_roles", stage_id: "references", stage_argument_path: "/reference_roles" }),
      expect.objectContaining({ recipe_argument_path: "$/filter", stage_id: "references", stage_argument_path: "/filter" }),
    ]));
    expect(recipe("core:definition_to_instances").argument_bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipe_argument_path: "$/selector.definition_types", stage_id: "definitions", stage_argument_path: "/selector/definition_types" }),
      expect.objectContaining({ recipe_argument_path: "$/selector.namespaces", stage_id: "definitions", stage_argument_path: "/selector/namespaces" }),
      expect.objectContaining({ recipe_argument_path: "$/selector.plugin_ids", stage_id: "definitions", stage_argument_path: "/selector/plugin_ids" }),
      expect.objectContaining({ recipe_argument_path: "$/selector.lifecycle_states", stage_id: "definitions", stage_argument_path: "/selector/lifecycle_states" }),
    ]));
    expect(recipe("core:prepare_symbol_change").streams).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream_name: "references.confirmed", classification: "confirmed" }),
      expect.objectContaining({ stream_name: "references.possible", classification: "possible" }),
      expect.objectContaining({ stream_name: "sources", classification: "unclassified" }),
    ]));
    expect(recipe("core:prepare_new_feature").outputs.every((output) => ["subjects", "relations", "paths", "definitions"].includes(output.projection))).toBe(true);
  });

  it("closes the v5 operation-error enums, bounds, and field descriptions", () => {
    const error = (code: string) => operationErrorDefinitions.find((candidate) => candidate.code === code)!;
    expect(error("core:embedding_profile_incompatible").details_schema.properties["incompatibility_reasons"]?.items?.enum).toEqual(["language", "content_class", "query_class", "dimensions", "encoding", "distance_metric", "generator_lock", "materialization"]);
    expect(error("core:semantic_index_unavailable").details_schema.properties["unavailability_reason"]?.enum).toEqual(["materialization_missing", "materialization_unavailable", "query_generator_unavailable", "vector_set_unreadable"]);
    expect(error("core:semantic_coverage_incomplete").details_schema.properties["retry_after_milliseconds"]?.minimum).toBe(1);
    expect(error("core:index_contract_unsupported").details_schema.properties["contract_kind"]?.enum).toEqual(["canonical_encoding", "hash_algorithm", "schema", "digest_domain", "canonical_comparator", "digest_recipe", "digest_reference", "external_verifier"]);
    expect(error("core:index_contract_unsupported").details_schema.properties["canonical_encoding_version"]?.minimum).toBe(1);
    expect(error("core:index_integrity_failed").details_schema.properties["component_kind"]?.enum).toEqual(["manifest", "canonical_record", "source_blob", "registry", "projection", "query_manifest", "storage_index"]);
    expect(error("core:index_integrity_failed").details_schema.properties["integrity_failure_kind"]?.enum).toEqual(["digest_mismatch", "missing_required_component", "schema_invalid", "reference_invalid", "atomicity_violation"]);
    expect(Object.values(error("core:embedding_profile_incompatible").details_schema.properties).every((property) => property.description && !property.description.includes("cannot execute a semantic lane"))).toBe(true);
  });

  it("enforces the v11 public query projection, selector, and constraint authority", () => {
    const root: CanonicalSchemaDefinition = {
      ...testSchema,
      root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "QueryExpression", schema_id: "core:QueryExpression", schema_version: 1 },
    };
    const findReferences = {
      stage_id: "references",
      operator: "source.operation",
      inputs: [],
      arguments: { operation: "core:find_references", operation_arguments: { target: { subject_type: "symbol", name: "needle" } } },
    };
    const select = {
      stage_id: "projected",
      operator: "select",
      inputs: [{ stage_id: "references", output: "references" }],
      arguments: { outputs: [{ name: "references", input: { stage_id: "references", output: "references" }, projection: "references" }] },
    };
    expect(() => validateSchemaValue(root, { expression_type: "pipeline", stages: [findReferences, select], outputs: [{ stage_id: "projected", output: "references" }] })).not.toThrow();

    const expand = {
      stage_id: "expanded",
      operator: "expand.relations",
      inputs: [{ stage_id: "references", output: "references" }],
      arguments: { direction: "outbound", relations: {}, min_depth: 2 },
    };
    expect(() => validateSchemaValue(root, { expression_type: "pipeline", stages: [findReferences, expand], outputs: [{ stage_id: "expanded", output: "subjects" }] })).toThrow(/max_depth|at least|min_depth/i);

    const directStageOutput = { expression_type: "operation", operation: "core:get_source", arguments: { subjects: [{ subject_type: "stage_output", stage_id: "prior", output: "subjects" }], source: { mode: "signature", max_characters_per_snippet: 10, max_total_characters: 10, context_lines: 0 } } };
    expect(() => validateSchemaValue(root, directStageOutput)).toThrow(/stage_output|selector|operation/i);

    const invalidJoin = {
      expression_type: "pipeline",
      stages: [
        { stage_id: "left", operator: "source.operation", inputs: [], arguments: { operation: "core:find_records", operation_arguments: { selector: { record_categories: ["entity"] } } } },
        { stage_id: "right", operator: "source.operation", inputs: [], arguments: { operation: "core:find_records", operation_arguments: { selector: { record_categories: ["entity"] } } } },
        { stage_id: "joined", operator: "join", inputs: [{ stage_id: "left", output: "records" }, { stage_id: "right", output: "records" }], arguments: { predicate: "same_subject", output: "pairs", direction: "outbound", relation_selector: {} } },
      ],
      outputs: [{ stage_id: "joined", output: "pairs" }],
    };
    expect(() => validateSchemaValue(root, invalidJoin)).toThrow(/unknown|forbidden|relation_selector|direction/i);

    const validPipeline = { expression_type: "pipeline", stages: [findReferences], outputs: [{ stage_id: "references", output: "references" }] };
    expect(() => validateSchemaValue(root, { ...validPipeline, outputs: [...validPipeline.outputs, ...validPipeline.outputs] })).toThrow(/duplicate|ordered|output/i);
  });

  it("enforces v11 operation interaction constraints and authority-driven array bounds", () => {
    const root: CanonicalSchemaDefinition = {
      ...testSchema,
      root_type: { type_kind: "schema_reference", reference_scope: "external", type_name: "QueryExpression", schema_id: "core:QueryExpression", schema_version: 1 },
    };
    const operation = (operation: string, args: Record<string, unknown>) => ({ expression_type: "operation", operation, arguments: args });
    expect(() => validateSchemaValue(root, operation("core:resolve_symbol", { reference: "" }))).toThrow(/reference|non-empty/i);
    expect(() => validateSchemaValue(root, operation("core:resolve_symbol", { reference: "x", context_byte_offset: 1 }))).toThrow(/context_artifact|byte_offset/i);
    expect(() => validateSchemaValue(root, operation("core:inspect_architecture", { scope: [], views: ["entry_points"] }))).toThrow(/scope|non-empty/i);
    expect(() => validateSchemaValue(root, operation("core:compare", { selection: [], comparison_kinds: ["added"] }))).toThrow(/selection|non-empty/i);
    expect(() => validateSchemaValue(root, operation("core:find_records", { selector: { record_categories: ["entity", "entity"] } }))).toThrow(/duplicate|record_categories/i);

    const inspect = operationDefinitions.find((candidate) => candidate.operation_id === "core:inspect_architecture")!;
    const compare = operationDefinitions.find((candidate) => candidate.operation_id === "core:compare")!;
    expect(inspect.argument_schema.properties["scope"]?.minItems).toBe(1);
    expect(compare.argument_schema.properties["selection"]?.minItems).toBe(1);
  });

  it("has no materialized v11 generic model or payload description markers", () => {
    const modelFallback = /^The [a-z0-9_]+ member of [A-Z][A-Za-z0-9_]* is encoded as /;
    const payloadFallback = /^The exact [a-z0-9_ ]+ value carried by this registered payload\.$/;
    const modelGenerator = readFileSync(new URL("../packages/contracts/scripts/generate-model-field-authority.mjs", import.meta.url), "utf8");
    const payloadGenerator = readFileSync(new URL("../packages/contracts/scripts/generate-registry-payload-authority.mjs", import.meta.url), "utf8");
    expect(modelGenerator).not.toContain("The ${field} member of ${model} is encoded as");
    expect(payloadGenerator).not.toContain("semanticPayloadDescription");
    expect(payloadGenerator).not.toContain("The exact ${name.replaceAll(\"_\", \" \")} value carried by this registered payload.");
    for (const field of modelContractRegistry.flatMap((model) => model.fields)) expect(field.description).not.toMatch(modelFallback);
    for (const field of Object.values(authoritativeModelFieldMetadata)) expect(field.description).not.toMatch(modelFallback);
    for (const field of modelContractRegistry.flatMap((model) => model.fields)) expect(field.description).not.toContain("Approved field coordinate");
    for (const field of Object.values(authoritativeModelFieldMetadata)) expect(field.description).not.toContain("Approved field coordinate");
    const payloadSchemas = [
      ...operationErrorDefinitions.map((definition) => definition.details_schema),
      ...diagnosticDefinitions.map((definition) => definition.payload_schema),
      ...candidateIssueDefinitions.map((definition) => definition.payload_schema),
    ];
    for (const property of payloadSchemas.flatMap((schema) => Object.values(schema.properties))) expect(property.description).not.toMatch(payloadFallback);
    for (const property of Object.values(authoritativePayloadMetadata)) expect(property.description).not.toMatch(payloadFallback);
    for (const property of Object.values(authoritativePayloadMetadata)) expect(property.description).not.toContain("Approved payload field coordinate");
  });
});
