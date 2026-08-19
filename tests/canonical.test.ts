import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CanonicalEncodingError,
  canonicalComparatorRegistry,
  canonicalEncodingErrorCodeRegistry,
  canonicalEncodingErrorDetailContracts,
  canonicalSchemaRegistry,
  digestDomainRegistry,
  compareCanonicalValues,
  computeDigest,
  computeDigestRecipe,
  canonicalEncodingConformanceCases,
  canonicalTypedConformanceCases,
  canonicalSchemaDefinitions,
  decodeCanonical,
  decodeTypedValue,
  digestBytes,
  digestCanonicalArray,
  digestEnvelope,
  encodeArrayHeader,
  digestRecipeDefinitions,
  digestRecipeVariantDefinitions,
  digestPayloadSchemaDefinitions,
  digestReferenceDefinitions,
  externalVerificationContractDefinitions,
  encodeCanonical,
  encodeSchemaValue,
  encodeTypedValue,
  allDigestFieldContracts,
  expandedAllDigestFieldContracts,
  expandedDigestFieldContracts,
  digestFieldContracts,
  digestContractRowRegistry,
  documentedDigestFieldContracts,
  documentedDigestRecipeCoordinates,
  phase3DigestFieldContractRows,
  normalizeBytes,
  normalizeExactDecimal,
  normalizeTimestamp,
  validateDigestRecipeGraph,
  validateDigestEnvelope,
} from "@urdira/canonical";

describe("Urdira Canonical Encoding", () => {
  it("encodes deterministic CBOR maps by encoded key bytes and decodes them", () => {
    const encoded = encodeCanonical({ z: 1, a: [true, "hello"], empty: null });
    expect(Buffer.from(encoded).toString("hex")).toBe("a3616182f56568656c6c6f617a0165656d707479f6");
    expect(decodeCanonical(encoded)).toEqual({ z: 1, empty: null, a: [true, "hello"] });
  });

  it("uses shortest integer, length, and float encodings", () => {
    expect(Buffer.from(encodeCanonical(23)).toString("hex")).toBe("17");
    expect(Buffer.from(encodeCanonical(24)).toString("hex")).toBe("1818");
    expect(Buffer.from(encodeCanonical(1.5)).toString("hex")).toBe("f93e00");
  });

  it("rejects non-canonical input instead of normalizing it", () => {
    expect(() => decodeCanonical(Uint8Array.from([0x18, 0x17]))).toThrowError(
      expect.objectContaining({ code: "uce:non_canonical_encoding" }),
    );
    expect(() => decodeCanonical(Uint8Array.from([0x61, 0xff]))).toThrowError(
      expect.objectContaining({ code: "uce:invalid_utf8" }),
    );
    expect(() => decodeCanonical(Uint8Array.from([0x01, 0x00]))).toThrowError(
      expect.objectContaining({ code: "uce:trailing_data" }),
    );
    expect(() => decodeCanonical(Uint8Array.from([0x9f, 0xff]))).toThrowError(
      expect.objectContaining({ code: "uce:forbidden_cbor_feature" }),
    );
    expect(() => decodeCanonical(Uint8Array.from([0xc1, 0x00]))).toThrowError(
      expect.objectContaining({ code: "uce:forbidden_cbor_feature" }),
    );
    expect(() => decodeCanonical(Uint8Array.from([0xf9, 0x80, 0x00]))).toThrowError(
      expect.objectContaining({ code: "uce:forbidden_cbor_feature" }),
    );
    const protoKey = Uint8Array.from(Buffer.from("a1695f5f70726f746f5f5f01", "hex"));
    const decodedProto = decodeCanonical(protoKey) as Record<string, unknown>;
    expect(Object.hasOwn(decodedProto, "__proto__")).toBe(true);
    expect(decodedProto["__proto__"]).toBe(1);
  });

  it("round-trips representative scalar and collection values under property probes", () => {
    const values: unknown[] = [null, false, true, 0, 23, 24, -24, 1.5, "text", "é", new Uint8Array([0, 1, 255]), 2n ** 100n, -(2n ** 100n), [], [1, "two", null], { a: 1, nested: { b: true } }];
    for (const value of values) expect(decodeCanonical(encodeCanonical(value))).toEqual(value);
    for (let index = 0; index < 30; index += 1) {
      const left = { key: `key-${index % 7}`, value: index };
      const right = { value: index, key: `key-${index % 7}` };
      expect(Buffer.from(encodeCanonical(left)).equals(Buffer.from(encodeCanonical(right)))).toBe(true);
    }
  });

  it("round-trips non-empty typed records, maps, unions, and JSON objects", () => {
    const record = { type_kind: "record" as const, fields: [
      { field_name: "name", description: "Name.", presence: "required" as const, value_type: { type_kind: "text" as const } },
      { field_name: "count", description: "Count.", presence: "required" as const, value_type: { type_kind: "safe_integer" as const } },
    ] };
    const map = { type_kind: "map" as const, value_type: { type_kind: "text" as const } };
    const union = { type_kind: "union" as const, discriminator_field: "kind", discriminator_description: "Kind.", variants: [{ discriminator_value: "item", description: "Item.", fields: [{ field_name: "value", description: "Value.", presence: "required" as const, value_type: { type_kind: "text" as const } }] }] };
    const json = { type_kind: "schema_reference" as const, reference_scope: "external" as const, type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 };
    for (const [value, type] of [[{ name: "n", count: 2 }, record], [{ a: "b", c: "d" }, map], [{ kind: "item", value: "x" }, union], [{ a: { b: true } }, json]] as const) {
      const bytes = encodeTypedValue(value, type);
      expect(() => decodeCanonical(bytes)).not.toThrow();
      expect(decodeTypedValue(bytes, type)).toEqual(value);
    }
  });

  it("hashes the nine-element domain-separated digest envelope", () => {
    const payload = { message: "hello" };
    const envelope = digestEnvelope("core:test", "core:test_recipe", 1, "core:test_payload", 1, payload);
    const expected = createHash("sha256").update(encodeCanonical(envelope)).digest("hex");
    expect(computeDigest("core:test", "core:test_recipe", 1, "core:test_payload", 1, payload)).toBe(`sha256:${expected}`);
    expect(envelope).toEqual(["urdira", 1, "core:test", "core:test_recipe", 1, "core:test_payload", 1, "sha256", payload]);
  });

  it("sorts comparator values and uses complete bytes as a final tie-breaker", () => {
    const comparator = { comparator_id: "test:record", comparator_version: 1, sort_keys: [
      { value_path: "/name", comparison_mode: "text_utf8", direction: "ascending", absent_order: "forbidden" },
    ] } as const;
    const values = [{ name: "a", z: 2 }, { name: "a", z: 1 }, { name: "b", z: 0 }];
    expect(values.toSorted((left, right) => compareCanonicalValues(left, right, comparator))).toEqual([
      { name: "a", z: 1 }, { name: "a", z: 2 }, { name: "b", z: 0 },
    ]);
  });

  it("publishes the complete core canonical registries", () => {
    expect(canonicalSchemaRegistry).toHaveLength(46);
    expect(canonicalComparatorRegistry).toHaveLength(18);
    expect(canonicalEncodingErrorDetailContracts).toHaveLength(canonicalEncodingErrorCodeRegistry.length);
    expect(digestFieldContracts).toHaveLength(142);
    expect(digestContractRowRegistry).toHaveLength(196);
    expect(documentedDigestFieldContracts).toHaveLength(175);
    expect(phase3DigestFieldContractRows).toHaveLength(142);
    expect(phase3DigestFieldContractRows.every((row) => row.length === 4 && (row[0] === "computation" || row[0] === "reference"))).toBe(true);
    expect(allDigestFieldContracts).toHaveLength(175);
    expect(expandedDigestFieldContracts).toHaveLength(148);
    expect(expandedAllDigestFieldContracts).toHaveLength(181);
    expect(new Set(digestFieldContracts.map((contract) => contract.source_location)).size).toBe(142);
    expect(new Set(digestReferenceDefinitions.map((reference) => reference.digest_reference_id)).size).toBe(digestReferenceDefinitions.length);
    expect(new Set(digestRecipeDefinitions.map((recipe) => `${recipe.digest_recipe_id}@${recipe.recipe_version}`)).size).toBe(digestRecipeDefinitions.length);
    expect(new Set(digestDomainRegistry.map((domain) => domain.digest_domain)).size).toBe(digestDomainRegistry.length);
    expect(allDigestFieldContracts[0]).toMatchObject({
      contract_kind: "computation",
      target_field: "ContentBlob.content_hash",
      digest_recipe_id: "core:raw_artifact_content_digest",
      digest_domain: "core:artifact_content",
    });
    expect(allDigestFieldContracts.every((contract) => !["computation", "reference"].includes(contract.target_field))).toBe(true);
    expect(digestReferenceDefinitions[0]).toMatchObject({
      digest_reference_id: "core:record_envelope_analysis_digest_reference",
      target_field: "/analysis_digest",
      source_digest_recipe_id: "core:analyzer_implementation_digest",
      reference_kind: "external_asset",
      locator_bindings: [],
      external_verification_contract_id: "core:analyzer_implementation_verification_contract",
      external_verification_contract_version: "1",
    });
    expect(digestReferenceDefinitions.filter((reference) => reference.reference_kind === "model").every((reference) => (
      reference.locator_bindings.length > 0
      && reference.locator_bindings.every((binding) => (
        Object.keys(binding).toSorted().join(",") === "source_key_path,target_source_path"
        && binding.target_source_path.startsWith("/")
        && binding.source_key_path.startsWith("/")
      ))
      && reference.external_verification_contract_id === undefined
      && reference.external_verification_contract_version === undefined
    ))).toBe(true);
    expect(digestReferenceDefinitions.filter((reference) => reference.reference_kind === "external_asset").every((reference) => (
      reference.locator_bindings.length === 0
      && reference.external_verification_contract_id?.endsWith("_verification_contract") === true
      && reference.external_verification_contract_version === "1"
    ))).toBe(true);
    expect(digestRecipeDefinitions.find((recipe) => recipe.digest_recipe_id === "core:raw_artifact_content_digest")).toMatchObject({
      digest_domain: "core:artifact_content",
      payload_schema_id: "core:Bytes",
      payload_schema_version: "1",
    });
    expect(digestRecipeDefinitions.every((recipe) => recipe.payload_schema_id.length > 0 && recipe.payload_schema_version === "1")).toBe(true);
    expect(documentedDigestRecipeCoordinates.find((recipe) => recipe.digest_recipe_id === "core:record_digest")).toMatchObject({
      digest_domain: "core:canonical_record",
      target_field: "RecordEnvelope.record_digest",
      binding_summary: expect.stringContaining("record_id"),
    });
    expect(digestContractRowRegistry[0]).toEqual([
      "terminal_recipe",
      "core:raw_artifact_content_digest",
      "core:artifact_content",
      "Bytes`; the exact complete raw source bytes.",
    ]);
    expect(digestContractRowRegistry.at(-1)?.[1]).toBe("CandidateProjectionClosureTemplate.generator_configuration_digest");
    expect(canonicalEncodingErrorCodeRegistry.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "uce:non_canonical_encoding",
      "uce:schema_validation_failed",
      "uce:digest_mismatch",
      "uce:resource_limit_exceeded",
    ]));
  });

  it("publishes every authoritative digest recipe with its documented binding mode", () => {
    const coordinates = [...new Map(documentedDigestRecipeCoordinates.map((coordinate) => [
      `${coordinate.digest_recipe_id}\u0000${coordinate.digest_domain}`,
      coordinate,
    ])).values()];
    expect(coordinates).toHaveLength(85);
    expect(digestRecipeDefinitions).toHaveLength(85);
    expect(new Set(digestRecipeDefinitions.map((recipe) => `${recipe.digest_recipe_id}\u0000${recipe.digest_domain}`)).size).toBe(85);
    for (const coordinate of coordinates) {
      const definition = digestRecipeDefinitions.find((recipe) => recipe.digest_recipe_id === coordinate.digest_recipe_id && recipe.digest_domain === coordinate.digest_domain);
      expect(definition, coordinate.digest_recipe_id).toBeDefined();
      expect(definition?.payload_schema_id, coordinate.digest_recipe_id).toMatch(/^core:/);
      expect(definition?.payload_schema_version).toBe("1");
      if (coordinate.contract_kind === "terminal_recipe" || /^Scalar `input\(/.test(coordinate.binding_summary ?? "")) {
        expect(definition?.verified_input_schema_id, coordinate.digest_recipe_id).toBeTruthy();
        expect(definition?.verified_input_schema_version, coordinate.digest_recipe_id).toBe("1");
      }
    }
    expect(digestRecipeDefinitions.find((recipe) => recipe.digest_recipe_id === "core:record_digest")).toMatchObject({
      payload_binding: "record",
    });
    expect(digestRecipeDefinitions.find((recipe) => recipe.digest_recipe_id === "core:raw_artifact_content_digest")).toMatchObject({
      payload_binding: "verified_input",
      verified_input_schema_id: "core:Bytes",
      verified_input_schema_version: "1",
    });
  });

  it("materializes outer closed-record schemas for inline input fields", () => {
    for (const [recipeId, schemaId, fieldNames] of [
      ["core:compatibility_requirement_digest", "core:CompatibilityRequirementDigestPayload", ["requirement_type", "declaring_plugin_id", "target_plugin_id", "capability", "requirement"]],
      ["core:index_candidate_digest", "core:IndexCandidateDigestPayload", ["candidate_generation_id", "workspace_id", "base_snapshot_id", "materialization_digest"]],
      ["core:artifact_analysis_context_digest", "core:ArtifactAnalysisContextDigestPayload", ["plugin_id", "plugin_version", "registry_snapshot_id", "analysis_configuration_digest"]],
      ["core:language_definition_digest", "core:LanguageDefinitionDigestPayload", ["language_id", "definition_revision", "display_name"]],
      ["core:candidate_materialization_digest", "core:CandidateMaterializationDigestPayload", ["workspace_id", "accepted_fact_delta_digests"]],
      ["core:semantic_coverage_manifest_digest", "core:SemanticCoverageManifestDigestPayload", ["semantic_index_materialization_id", "element_type", "entries"]],
    ] as const) {
      const recipe = digestRecipeDefinitions.find((definition) => definition.digest_recipe_id === recipeId);
      const schema = digestPayloadSchemaDefinitions.find((definition) => definition.schema_id === schemaId);
      expect(recipe?.payload_schema_id, recipeId).toBe(schemaId);
      expect(schema?.root_type.type_kind, recipeId).toBe("record");
      expect((schema?.root_type.type_kind === "record" ? schema.root_type.fields.map((field) => field.field_name) : []), recipeId).toEqual(expect.arrayContaining([...fieldNames]));
      if (recipeId === "core:compatibility_requirement_digest" && schema?.root_type.type_kind === "record") {
        const requirement = schema.root_type.fields.find((field) => field.field_name === "requirement");
        expect(requirement?.value_type.type_kind).toBe("record");
        if (requirement?.value_type.type_kind === "record") {
          expect(requirement.value_type.fields.at(-1)?.value_type).toMatchObject({
            type_kind: "bytes",
            bound_schema_id_field: "requirement_schema_id",
            bound_schema_version_field: "requirement_schema_version",
          });
        }
      }
    }
  });

  it("preserves exact payload-schema variants for one recipe coordinate", () => {
    const variants = digestRecipeVariantDefinitions.filter((definition) => definition.digest_recipe_id === "core:cursor_projection_digest");
    expect(variants.map((definition) => definition.payload_schema_id)).toEqual(expect.arrayContaining([
      "core:NormalizedResultProjection",
      "core:NormalizedIndexStatusProjection",
    ]));
    expect(new Set(digestRecipeDefinitions.map((definition) => definition.digest_recipe_id)).size).toBe(85);
  });

  it("keeps every digest payload schema coordinate unique and root-deterministic", () => {
    const byCoordinate = new Map<string, string>();
    for (const schema of digestPayloadSchemaDefinitions) {
      const coordinate = `${schema.schema_id}@${schema.schema_version}`;
      const root = JSON.stringify(schema.root_type);
      expect(byCoordinate.has(coordinate)).toBe(false);
      byCoordinate.set(coordinate, root);
    }
    expect(byCoordinate.size).toBe(digestPayloadSchemaDefinitions.length);
    expect(digestPayloadSchemaDefinitions.length).toBeGreaterThanOrEqual(67);
  });

  it("binds a nested input field to the exact verified input value", () => {
    const recipe = digestRecipeDefinitions.find((definition) => definition.digest_recipe_id === "core:compatibility_requirement_digest");
    expect(recipe).toBeDefined();
    const requirement = { requirement_schema_id: "core:Bytes", requirement_schema_version: 1, requirement_value: encodeCanonical(Uint8Array.of(1)) };
    expect(() => computeDigestRecipe(recipe!, {
      target: { requirement_type: "capability", declaring_plugin_id: "plugin-a", target_plugin_id: "plugin-b", capability: "core:test" },
      verified_input: requirement,
    } as never)).not.toThrow();
  });

  it("rejects invalid or unknown nested SchemaBoundBytes coordinates in verified input", () => {
    const recipe = digestRecipeDefinitions.find((definition) => definition.digest_recipe_id === "core:compatibility_requirement_digest");
    expect(recipe).toBeDefined();
    const target = { requirement_type: "capability", declaring_plugin_id: "plugin-a", target_plugin_id: "plugin-b", capability: "core:test" };
    expect(() => computeDigestRecipe(recipe!, {
      target,
      verified_input: { requirement_schema_id: "core:Bytes", requirement_schema_version: 1, requirement_value: Uint8Array.of(1) },
    } as never)).toThrowError(expect.objectContaining({ code: "uce:schema_validation_failed" }));
    expect(() => computeDigestRecipe(recipe!, {
      target,
      verified_input: { requirement_schema_id: "core:Missing", requirement_schema_version: 1, requirement_value: encodeCanonical(Uint8Array.of(1)) },
    } as never)).toThrowError(expect.objectContaining({ code: "uce:unknown_schema" }));
  });

  it("rejects an altered executable record binding", () => {
    const recipe = digestRecipeDefinitions.find((definition) => definition.digest_recipe_id === "core:record_digest");
    expect(recipe).toBeDefined();
    expect(() => computeDigestRecipe({
      ...recipe!,
      payload_binding: {
        binding_kind: "record",
        field_bindings: [{ payload_field: "record_id", source_path: "/target/owner_artifact_id", value_mode: "direct_value" }],
      },
    } as never, { target: { record_id: "record-1", owner_artifact_id: "artifact-1" } })).toThrowError(expect.objectContaining({ code: "uce:digest_binding_invalid" }));
  });

  it("executes a documented inline record recipe and rejects its invalid payload", () => {
    const recipe = digestRecipeDefinitions.find((definition) => definition.digest_recipe_id === "core:record_digest");
    expect(recipe).toBeDefined();
    const target = {
      record_id: "record-1",
      category: "entity",
      kind: "core:file",
      universal_kind: "core:entity",
      facets: [],
      schema_version: 1,
      workspace_id: "workspace-1",
      owner_artifact_id: "artifact-1",
      owner_artifact_version_id: "artifact-version-1",
      valid_from_generation: 1,
      producer_id: "analyzer",
      producer_version: "1.0.0",
      analysis_digest: `sha256:${"00".repeat(32)}`,
      analysis_configuration_digest: `sha256:${"11".repeat(32)}`,
      artifact_dependency_digest: `sha256:${"22".repeat(32)}`,
      payload: {},
      record_digest: `sha256:${"33".repeat(32)}`,
    };
    expect(() => computeDigestRecipe(recipe!, { target })).not.toThrow();
    expect(() => computeDigestRecipe(recipe!, { target: { ...target, record_id: 1 } })).toThrowError(expect.objectContaining({ code: "uce:schema_validation_failed" }));
  });

  it("executes a documented non-terminal verified-input recipe and validates its input schema", () => {
    const recipe = digestRecipeDefinitions.find((definition) => definition.digest_recipe_id === "core:record_artifact_dependency_digest");
    expect(recipe).toMatchObject({
      payload_binding: "verified_input",
      verified_input_schema_id: expect.stringMatching(/^core:/),
      verified_input_schema_version: "1",
    });
    expect(() => computeDigestRecipe(recipe!, { target: {}, verified_input: [] } as never)).not.toThrow();
    expect(() => computeDigestRecipe(recipe!, { target: {}, verified_input: [1] } as never)).toThrowError(expect.objectContaining({ code: "uce:schema_validation_failed" }));
  });

  it("encodes typed digest, decimal, and timestamp scalars", () => {
    const typedDigest = encodeTypedValue(`sha256:${"ab".repeat(32)}`, { type_kind: "digest", allowed_hash_algorithms: ["sha256"] });
    expect(Buffer.from(typedDigest).toString("hex")).toBe(`82667368613235365820${"ab".repeat(32)}`);
    const decimal = encodeTypedValue("decimal:1.50", { type_kind: "exact_decimal", scale_policy: "significant" });
    expect(Buffer.from(decimal).toString("hex")).toBe("c482211896");
    const timestampType = { type_kind: "timestamp" as const };
    const timestamp = "2026-08-09T00:00:00.123456789Z";
    expect(decodeTypedValue(encodeTypedValue(timestamp, timestampType), timestampType)).toBe(timestamp);
    expect(Buffer.from(encodeTypedValue(1, { type_kind: "float64" })).toString("hex")).toBe("f93c00");
    const beforeEpoch = "1969-12-31T23:59:59.999999999Z";
    expect(decodeTypedValue(encodeTypedValue(beforeEpoch, timestampType), timestampType)).toBe(beforeEpoch);
    expect(() => decodeTypedValue(Uint8Array.of(0x01), { type_kind: "float64" })).toThrowError(CanonicalEncodingError);
  });

  it("enforces public scalar projections", () => {
    expect(Buffer.from(normalizeBytes("base64url:SGVsbG8")).toString()).toBe("Hello");
    expect(() => normalizeBytes("SGVsbG8=")).toThrowError(CanonicalEncodingError);
    expect(normalizeExactDecimal("decimal:1.500", "insignificant")).toBe("decimal:1.5");
    expect(normalizeTimestamp("2026-08-09T00:00:00.000000000Z")).toBe("2026-08-09T00:00:00.000000000Z");
    expect(() => normalizeTimestamp("2026-02-29T00:00:00.000000000Z")).toThrowError(CanonicalEncodingError);
  });

  it("canonicalizes set and ordered-set schemas with their declared ordering", () => {
    const schema = {
      schema_id: "core:test_ordered",
      definition_revision: 1,
      schema_version: 1,
      description: "Ordered set fixture.",
      root_type: {
        type_kind: "ordered_set" as const,
        element_type: {
          type_kind: "record" as const,
          fields: [{ field_name: "record_id", description: "Record ID.", presence: "required" as const, value_type: { type_kind: "text" as const } }],
        },
        comparator_id: "core:record_id_order",
        comparator_version: 1,
      },
      type_definitions: [],
      lifecycle_state: "active" as const,
    };
    const bytes = encodeSchemaValue([{ record_id: "b" }, { record_id: "a" }], schema);
    expect(Buffer.from(bytes).toString("hex")).toBe("82a1697265636f72645f69646161a1697265636f72645f69646162");
    expect(() => encodeSchemaValue([{ record_id: "a" }, { record_id: "a" }], schema)).toThrowError(CanonicalEncodingError);
  });

  it("rejects non-canonical typed set order during decode", () => {
    const bytes = encodeCanonical(["b", "a"]);
    expect(() => decodeTypedValue(bytes, { type_kind: "set", element_type: { type_kind: "text" } })).toThrowError(expect.objectContaining({ code: "uce:non_canonical_encoding" }));
  });

  it("exposes structured UCE errors", () => {
    try {
      decodeCanonical(Uint8Array.from([0x1b, 0, 0, 0, 0, 0, 0, 0, 23]));
      throw new Error("expected decode to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalEncodingError);
      expect((error as CanonicalEncodingError).code).toBe("uce:non_canonical_encoding");
    }
  });

  it("rejects referenced-digest recipe cycles before hashing", () => {
    const recipe = (id: string, reference: string) => ({
      digest_recipe_id: id,
      recipe_version: 1,
      digest_domain: "core:test",
      payload_schema_id: "core:test",
      payload_schema_version: 1,
      payload_binding: { binding_kind: "record", field_bindings: [{ payload_field: "value", source_path: "/target/value", value_mode: "referenced_digest", referenced_digest_recipe_id: reference, referenced_digest_recipe_version: "1" }] },
    });
    expect(() => validateDigestRecipeGraph([recipe("core:a", "core:b"), recipe("core:b", "core:a")])).toThrowError(expect.objectContaining({ code: "uce:digest_recipe_cycle" }));
  });

  it("binds verified-input terminal recipes to verified input", () => {
    const recipe = {
      digest_recipe_id: "core:raw_artifact_content_digest",
      recipe_version: 1,
      digest_domain: "core:artifact_content",
      payload_schema_id: "core:Bytes",
      payload_schema_version: 1,
      payload_binding: "verified_input",
    } as const;
    const context = { target: { ignored: true }, verified_input: Uint8Array.of(1, 2) } as const;
    expect(computeDigestRecipe(recipe, context as never)).toBe(computeDigest("core:artifact_content", "core:raw_artifact_content_digest", 1, "core:Bytes", 1, Uint8Array.of(1, 2)));
    expect(() => computeDigestRecipe(recipe, { target: {}, verified_input: 1 } as never)).toThrowError(expect.objectContaining({ code: "uce:schema_validation_failed" }));
    expect(() => computeDigestRecipe({ ...recipe, recipe_version: 99 }, context as never)).toThrowError(expect.objectContaining({ code: "uce:unsupported_digest_recipe_version" }));
    expect(() => computeDigestRecipe(recipe, { target: {}, verified_input: "raw-bytes" } as never)).toThrowError(CanonicalEncodingError);
    expect(() => computeDigestRecipe({ ...recipe, payload_schema_id: "core:Missing" }, context as never)).toThrowError(CanonicalEncodingError);
  });

  it("rejects whole-target and nested target-field digest bindings", () => {
    const base = {
      digest_recipe_id: "core:artifact_analysis_context_digest",
      recipe_version: 1,
      digest_domain: "core:analysis_context",
      target_field: "ArtifactWorkItem.analysis_context_digest",
      payload_schema_id: "core:ArtifactAnalysisContext",
      payload_schema_version: 1,
    } as const;
    expect(() => computeDigestRecipe({ ...base, payload_binding: { binding_kind: "record", field_bindings: [{ payload_field: "value", source_path: "/target", value_mode: "direct_value" }] } }, { target: { analysis_context_digest: "x" } })).toThrowError(expect.objectContaining({ code: "uce:digest_binding_invalid" }));
    expect(() => computeDigestRecipe({ ...base, payload_binding: { binding_kind: "record", field_bindings: [{ payload_field: "value", source_path: "/target/analysis_context_digest", value_mode: "direct_value" }] } }, { target: { analysis_context_digest: "x" } })).toThrowError(expect.objectContaining({ code: "uce:digest_binding_invalid" }));
    const omittedTarget = { digest_recipe_id: base.digest_recipe_id, recipe_version: base.recipe_version, digest_domain: base.digest_domain, payload_schema_id: base.payload_schema_id, payload_schema_version: base.payload_schema_version };
    expect(() => computeDigestRecipe({ ...omittedTarget, payload_binding: { binding_kind: "scalar", source_path: "/target/record_digest" } }, { target: { record_digest: "sha256:" + "00".repeat(32) } })).toThrowError(CanonicalEncodingError);
    expect(() => computeDigestRecipe({ ...omittedTarget, payload_binding: "direct_value" }, { target: { record_digest: "sha256:" + "00".repeat(32) } })).toThrowError(CanonicalEncodingError);
    expect(() => computeDigestRecipe({ digest_recipe_id: "core:raw_artifact_content_digest", recipe_version: 1, digest_domain: "core:artifact_content", target_field: "RecordEnvelope.record_digest", payload_schema_id: "core:Bytes", payload_schema_version: 1, payload_binding: { binding_kind: "scalar", source_path: "/target/record_digest" } }, { target: { record_digest: "sha256:" + "00".repeat(32) } } as never)).toThrowError(expect.objectContaining({ code: "uce:digest_binding_invalid" }));
  });

  it("rejects non-plain objects from JSON and typed maps", () => {
    const json = { type_kind: "schema_reference" as const, reference_scope: "external" as const, type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 };
    const map = { type_kind: "map" as const, value_type: { type_kind: "text" as const } };
    for (const value of [new Date(0), new Map([["a", "b"]]), new Set(["a"]), new Number(1), Object.create({ inherited: true })]) {
      expect(() => encodeTypedValue(value, json)).toThrowError(CanonicalEncodingError);
      expect(() => encodeTypedValue(value, map)).toThrowError(CanonicalEncodingError);
    }
    expect(() => encodeTypedValue(Symbol("x"), json)).toThrowError(CanonicalEncodingError);
    expect(() => encodeTypedValue(() => "x", json)).toThrowError(CanonicalEncodingError);
    expect(() => encodeTypedValue(1n, json)).toThrowError(CanonicalEncodingError);
    expect(() => encodeTypedValue(Number.NaN, json)).toThrowError(CanonicalEncodingError);
    expect(() => encodeTypedValue(Number.POSITIVE_INFINITY, json)).toThrowError(CanonicalEncodingError);
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype["answer"] = "ok";
    expect(decodeTypedValue(encodeTypedValue(nullPrototype, json), json)).toEqual({ answer: "ok" });
  });

  it("enforces aggregate decode element limits before allocation", () => {
    expect(() => decodeCanonical(Uint8Array.from([0x82, 0x80, 0x80]), { max_elements: 1 })).toThrowError(expect.objectContaining({ code: "uce:resource_limit_exceeded" }));
  });

  it("validates SchemaBoundBytes against the adjacent exact schema", () => {
    const schema = canonicalSchemaDefinitions.find((candidate) => candidate.schema_id === "core:AnalysisConfiguration")!;
    const valid = encodeCanonical(new Uint8Array([2]));
    expect(() => encodeSchemaValue({ configuration_schema_id: "core:Bytes", configuration_schema_version: 1, normalized_configuration: valid }, schema)).not.toThrow();
    expect(() => encodeSchemaValue({ configuration_schema_id: "core:Bytes", configuration_schema_version: 1, normalized_configuration: Uint8Array.of(2) }, schema)).toThrowError(expect.objectContaining({ code: "uce:schema_validation_failed" }));
    expect(() => encodeSchemaValue({ configuration_schema_id: "core:Missing", configuration_schema_version: 1, normalized_configuration: valid }, schema)).toThrowError(expect.objectContaining({ code: "uce:unknown_schema" }));
    const modelReferenceValue = encodeCanonical(1);
    expect(() => encodeSchemaValue({ configuration_schema_id: "core:ModelAssetManifest", configuration_schema_version: 1, normalized_configuration: modelReferenceValue }, schema)).toThrowError(expect.objectContaining({ code: "uce:schema_validation_failed" }));
  });

  it("enforces scalar constraints symmetrically during typed encode and decode", () => {
    const cases = [
      [{ type_kind: "text" as const, minimum_code_point_count: 2 }, "x", encodeCanonical("x")],
      [{ type_kind: "bytes" as const, minimum_byte_length: 2 }, Uint8Array.of(1), encodeCanonical(Uint8Array.of(1))],
      [{ type_kind: "timestamp" as const, earliest: "2026-01-01T00:00:00.000000000Z" }, "2025-12-31T23:59:59.000000000Z", encodeTypedValue("2025-12-31T23:59:59.000000000Z", { type_kind: "timestamp" })],
      [{ type_kind: "exact_decimal" as const, minimum: "decimal:2", scale_policy: "significant" as const }, "decimal:1", encodeTypedValue("decimal:1", { type_kind: "exact_decimal", scale_policy: "significant" })],
      [{ type_kind: "big_integer" as const, maximum: "bigint:2" }, "bigint:3", encodeTypedValue("bigint:3", { type_kind: "big_integer" })],
      [{ type_kind: "float64" as const, minimum: 2 }, 1, encodeTypedValue(1, { type_kind: "float64" })],
    ] as const;
    for (const [type, value, encoded] of cases) {
      expect(() => encodeTypedValue(value, type)).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^uce:/) }));
      expect(() => decodeTypedValue(encoded, type)).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^uce:/) }));
    }
  });

  it("validates digest envelope payloads against the exact payload schema", () => {
    const invalid = encodeCanonical(["urdira", 1, "core:artifact_content", "core:raw_artifact_content_digest", 1, "core:Bytes", 1, "sha256", 1]);
    const valid = encodeCanonical(["urdira", 1, "core:artifact_content", "core:raw_artifact_content_digest", 1, "core:Bytes", 1, "sha256", Uint8Array.of(1)]);
    expect(() => validateDigestEnvelope(invalid)).toThrowError(expect.objectContaining({ code: "uce:schema_validation_failed" }));
    expect(validateDigestEnvelope(valid)).toEqual(["urdira", 1, "core:artifact_content", "core:raw_artifact_content_digest", 1, "core:Bytes", 1, "sha256", Uint8Array.of(1)]);
  });

  it("preserves authoritative model locator coordinates and registry descriptions", () => {
    expect(digestReferenceDefinitions.find((reference) => reference.digest_reference_id === "core:artifact_version_content_hash_reference")?.locator_bindings).toEqual([
      { target_source_path: "/content_blob_id", source_key_path: "/content_blob_id" },
    ]);
    expect(digestDomainRegistry.find((entry) => entry.digest_domain === "core:artifact_content")?.description).toBe(
      "Digest space governed by recipes: core:raw_artifact_content_digest",
    );
    expect(canonicalEncodingErrorCodeRegistry.find((entry) => entry.code === "uce:trailing_data")?.description).toBe(
      "A valid root CBOR item ends before the supplied byte sequence ends.",
    );
    expect(digestReferenceDefinitions.find((reference) => reference.digest_reference_id === "core:namespace_binding_contribution_digest_reference")?.locator_bindings).toEqual([
      { target_source_path: "/plugin_id", source_key_path: "/plugin_id" },
      { target_source_path: "/plugin_version", source_key_path: "/plugin_version" },
      { target_source_path: "/contribution_digest", source_key_path: "/contribution_digest" },
    ]);
    expect(digestReferenceDefinitions.every((reference) => reference.locator_bindings.every((binding) => !/[\\[\\]*]/.test(`${binding.target_source_path}${binding.source_key_path}`)))).toBe(true);
  });

  it("materializes complete external verification contracts from terminal rows", () => {
    expect(externalVerificationContractDefinitions).toHaveLength(21);
    for (const definition of externalVerificationContractDefinitions) {
      expect(definition.external_verification_contract_id).toMatch(/^core:.*_verification_contract$/);
      expect(definition.contract_version).toBe("1");
      expect(definition.verified_input_schema_id).toMatch(/^core:/);
      expect(definition.verified_input_schema_version).toBe("1");
      expect(definition.terminal_digest_recipe_id).toMatch(/^core:.*_digest$/);
      expect(definition.terminal_digest_recipe_version).toBe("1");
      expect(definition.verification_semantics.length).toBeGreaterThan(20);
      expect(definition.description.length).toBeGreaterThan(20);
    }
    for (const reference of digestReferenceDefinitions.filter((candidate) => candidate.reference_kind === "external_asset")) {
      const contract = externalVerificationContractDefinitions.find((candidate) => candidate.external_verification_contract_id === reference.external_verification_contract_id);
      expect(contract, reference.digest_reference_id).toBeDefined();
      expect(contract?.contract_version).toBe(reference.external_verification_contract_version);
      expect(contract?.terminal_digest_recipe_id).toBe(reference.source_digest_recipe_id);
    }
  });

  it("enforces typed collection bounds on encode and decode", () => {
    const sequence = { type_kind: "sequence" as const, element_type: { type_kind: "text" as const }, maximum_item_count: 1 };
    const set = { type_kind: "set" as const, element_type: { type_kind: "text" as const }, minimum_item_count: 2 };
    const ordered = { type_kind: "ordered_set" as const, element_type: { type_kind: "text" as const }, comparator_id: "core:text_lexicographic_order", comparator_version: 1, maximum_item_count: 1 };
    const map = { type_kind: "map" as const, value_type: { type_kind: "text" as const }, maximum_entry_count: 1 };
    expect(() => encodeTypedValue(["a", "b"], sequence)).toThrowError(CanonicalEncodingError);
    expect(() => encodeTypedValue(["a"], set)).toThrowError(CanonicalEncodingError);
    expect(() => encodeTypedValue(["a", "b"], ordered)).toThrowError(CanonicalEncodingError);
    expect(() => encodeTypedValue({ a: "b", c: "d" }, map)).toThrowError(CanonicalEncodingError);
    expect(() => decodeTypedValue(encodeCanonical(["a", "b"]), { ...sequence, maximum_item_count: 1 })).toThrowError(CanonicalEncodingError);
  });

  it("omits the target digest field for direct-value recipe payloads", () => {
    const recipe = {
      digest_recipe_id: "core:record_digest",
      recipe_version: 1,
      digest_domain: "core:canonical_record",
      target_schema_id: "core:test_target",
      target_schema_version: 1,
      target_field: "digest",
      payload_schema_id: "core:Bytes",
      payload_schema_version: 1,
      payload_binding: "direct_value",
    } as const;
    const context = { target: { digest: `sha256:${"00".repeat(32)}`, value: "kept" } };
    expect(() => computeDigestRecipe(recipe, context)).toThrowError(CanonicalEncodingError);
  });

  it("omits nested target digest fields before direct-value hashing", () => {
    const recipe = {
      digest_recipe_id: "core:record_digest",
      recipe_version: 1,
      digest_domain: "core:canonical_record",
      target_schema_id: "core:test_target",
      target_schema_version: 1,
      target_field: "nested.digest",
      payload_schema_id: "core:Bytes",
      payload_schema_version: 1,
      payload_binding: "direct_value",
    } as const;
    const context = { target: { nested: { digest: "remove", keep: true } } };
    expect(() => computeDigestRecipe(recipe, context)).toThrowError(CanonicalEncodingError);
  });

  it("rejects invalid digest envelope coordinates without optional context", () => {
    const envelope = encodeCanonical(["urdira", 1, "core:unknown", "core:unknown_recipe", 1.5, "core:Missing", 1, "sha256", null]);
    expect(() => validateDigestEnvelope(envelope)).toThrowError(CanonicalEncodingError);
    const missingPayloadSchema = encodeCanonical(["urdira", 1, "core:canonical_record", "core:record_digest", 1, "core:Bytes", 1, "sha256", null]);
    expect(() => validateDigestEnvelope(missingPayloadSchema)).toThrowError(expect.objectContaining({ code: "uce:digest_binding_invalid" }));
  });

  it("executes the canonical conformance corpus", () => {
    expect(canonicalEncodingConformanceCases.length).toBeGreaterThanOrEqual(17);
    expect(canonicalTypedConformanceCases.length).toBeGreaterThanOrEqual(16);
    for (const vector of canonicalEncodingConformanceCases) {
      if (vector.expected_outcome === "accepted") {
        expect(vector.schema_id).toBe("core:Bytes");
        expect(Buffer.from(encodeTypedValue(vector.logical_input, { type_kind: "bytes" })).toString("hex")).toBe(vector.expected_cbor_hex);
      } else {
        expect(() => decodeCanonical(Uint8Array.from(Buffer.from(vector.encoded_input_hex, "hex")))).toThrowError(expect.objectContaining({ code: vector.expected_error_code }));
      }
    }
    for (const vector of canonicalTypedConformanceCases) {
      expect(Buffer.from(encodeTypedValue(vector.logical_input, vector.type_expression)).toString("hex")).toBe(vector.expected_cbor_hex);
    }
  });
});

describe("digestCanonicalArray", () => {
  function assertMatchesAggregate(elements: readonly unknown[]): void {
    const streamed = digestCanonicalArray(elements);
    const aggregate = digestBytes(encodeCanonical(elements, { max_elements: 10_000_000 }));
    expect(streamed).toBe(aggregate);
  }

  it("matches the aggregate digest for an empty array", () => {
    assertMatchesAggregate([]);
  });

  it("matches the aggregate digest for scalars, nested maps, and mixed element types", () => {
    assertMatchesAggregate([
      1,
      -7,
      true,
      false,
      null,
      "plain text",
      { z: 1, a: 2, nested: { deep: [1, 2, 3] } },
      [1, [2, [3, [4]]]],
      { array_in_map: [1, 2, { key: "value" }] },
    ]);
  });

  it("matches the aggregate digest for multibyte and astral-plane text", () => {
    assertMatchesAggregate([
      "café",
      "日本語",
      "\u{1f600}\u{1f601}\u{1f602}",
      { text: "\u{10348}\u{10349}" },
      [" ", "", ""],
    ]);
  });

  it("matches the aggregate digest for numbers and bigints", () => {
    assertMatchesAggregate([
      0,
      -0,
      1.5,
      -1.5,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      9_007_199_254_740_993n,
      -9_007_199_254_740_993n,
      123456789012345678901234567890n,
      -123456789012345678901234567890n,
      0.1,
      1e300,
      -1e-300,
    ]);
  });

  it("matches the aggregate digest for byte strings", () => {
    assertMatchesAggregate([
      new Uint8Array(),
      new Uint8Array([0]),
      new Uint8Array([1, 2, 3, 255]),
      { blob: new Uint8Array([9, 8, 7]) },
      [new Uint8Array([1]), new Uint8Array([2])],
    ]);
  });

  it("matches the aggregate digest for a large array of records", () => {
    const elements = Array.from({ length: 2_000 }, (_, index) => ({
      id: `record:${index}`,
      body: "x".repeat(50),
      tags: [index, index + 1, index + 2],
    }));
    assertMatchesAggregate(elements);
  });

  it("is exactly the array header followed by each element's own canonical bytes", () => {
    const elements = [1, "two", { three: 3 }];
    const parts = [encodeArrayHeader(elements.length), ...elements.map((element) => encodeCanonical(element))];
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const concatenated = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { concatenated.set(part, offset); offset += part.byteLength; }
    expect(digestCanonicalArray(elements)).toBe(digestBytes(concatenated));
    expect(digestCanonicalArray(elements)).toBe(digestBytes(encodeCanonical(elements)));
  });

  it("bounds each element by the default per-element limits, not the aggregate", () => {
    // A single array with many small elements would trip the default
    // `max_elements` (1,000,000) if consumed once for the whole array; the
    // streaming digest still enforces max_elements against the element
    // count, but never aggregates each element's own text/byte limits.
    const elements = Array.from({ length: 5 }, () => "y".repeat(1000));
    expect(() => digestCanonicalArray(elements)).not.toThrow();
    assertMatchesAggregate(elements);
  });
});
