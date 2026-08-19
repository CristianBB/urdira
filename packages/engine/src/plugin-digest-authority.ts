import {
  computeDigest,
  digestDomainRegistry,
  digestRecipeDefinitions,
  externalVerificationContractDefinitions,
} from "@urdira/canonical";
import type { PluginDigestAuthority } from "@urdira/plugin-sdk";

function registeredDigest(recipeId: string, value: unknown): string {
  const recipe = digestRecipeDefinitions.find((candidate) => candidate.digest_recipe_id === recipeId);
  if (recipe === undefined) throw new TypeError(`The core digest recipe ${recipeId} is unavailable.`);
  const targetField = recipe.target_field.startsWith("/") ? recipe.target_field.slice(1) : undefined;
  const payload = targetField !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== targetField))
    : value;
  return computeDigest(
    recipe.digest_domain,
    recipe.digest_recipe_id,
    Number(recipe.recipe_version),
    recipe.payload_schema_id,
    Number(recipe.payload_schema_version),
    payload,
  );
}

/**
 * Production adapter between the plugin SDK's injected digest port and the
 * canonical registry. Plugins never carry core recipe constants themselves.
 */
export function createCanonicalPluginDigestAuthority(): PluginDigestAuthority {
  return Object.freeze({
    plugin_package: (value) => registeredDigest("core:plugin_package_digest", value),
    analyzer_implementation: (value) => registeredDigest("core:analyzer_implementation_digest", value),
    compatibility_declaration: (value) => registeredDigest("core:plugin_compatibility_declaration_digest", value),
    registry_contribution: (value) => registeredDigest("core:plugin_registry_contribution_digest", {
      ...value,
      runtime_component_definitions: value.runtime_component_definitions.map((definition) => ({
        ...definition,
        component_contracts: definition.component_contracts.map((binding) => ({
          ...binding,
          contract_version: Number(binding.contract_version),
          ...(binding.configuration_schema_version === undefined ? {} : { configuration_schema_version: Number(binding.configuration_schema_version) }),
        })),
      })),
    }),
    analysis_configuration: (value) => registeredDigest("core:analysis_configuration_digest", value),
    runtime_behavior: (value) => registeredDigest("core:runtime_component_behavior_digest", {
      ...value,
      contract_bindings: value.contract_bindings.map((binding) => ({
        ...binding,
        contract_version: Number(binding.contract_version),
        ...(binding.configuration_schema_version === undefined ? {} : { configuration_schema_version: Number(binding.configuration_schema_version) }),
      })),
    }),
    runtime_implementation: (value) => registeredDigest("core:runtime_component_implementation_digest", value),
    language_definition: (value) => registeredDigest("core:language_definition_digest", value),
    resolution_lock: (value) => registeredDigest("core:plugin_resolution_lock_digest", value),
    registry_snapshot: (value) => registeredDigest("core:registry_snapshot_digest", {
      ...value,
      namespace_bindings: value.namespace_bindings.map((binding) => ({
        ...binding,
        emission_valid_from_generation: Number(binding.emission_valid_from_generation),
        ...(binding.emission_valid_to_generation === undefined ? {} : { emission_valid_to_generation: Number(binding.emission_valid_to_generation) }),
      })),
    }),
    has_core_digest_domain: (value) => digestDomainRegistry.some((entry) => entry.digest_domain === value),
    has_core_digest_recipe: (id, version) => digestRecipeDefinitions.some((entry) => entry.digest_recipe_id === id && entry.recipe_version === version),
    has_core_external_verifier: (id, version) => externalVerificationContractDefinitions.some((entry) => entry.external_verification_contract_id === id && entry.contract_version === version),
  } satisfies PluginDigestAuthority);
}
