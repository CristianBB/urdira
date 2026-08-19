import type {
  AnalysisConfiguration,
  AnalyzerImplementationManifest,
  PluginCompatibilityDeclaration,
  PluginPackageManifest,
  PluginRegistryContribution,
  LanguageDefinition,
  RegistryNamespaceBindingEntry,
  ResolvedPlugin,
  RuntimeComponentBehaviorManifest,
  RuntimeComponentImplementationManifest,
} from "@urdira/contracts";

export interface PluginResolutionLockDigestInput {
  readonly resolution_lock_id: string;
  readonly workspace_id: string;
  readonly resolver_version: string;
  readonly resolved_plugins: readonly ResolvedPlugin[];
}

export interface RegistrySnapshotDigestInput {
  readonly registry_snapshot_id: string;
  readonly registry_contract_version: string;
  readonly core_registry_digest: string;
  readonly resolution_lock_id: string;
  readonly namespace_bindings: readonly RegistryNamespaceBindingEntry[];
}

/** Canonical authority is implemented by a lower-level adapter; the SDK never carries recipe constants or a generic fallback. */
export interface PluginDigestAuthority {
  plugin_package(value: PluginPackageManifest): string;
  analyzer_implementation(value: AnalyzerImplementationManifest): string;
  compatibility_declaration(value: PluginCompatibilityDeclaration): string;
  registry_contribution(value: PluginRegistryContribution): string;
  analysis_configuration(value: AnalysisConfiguration): string;
  runtime_behavior(value: RuntimeComponentBehaviorManifest): string;
  runtime_implementation(value: RuntimeComponentImplementationManifest): string;
  language_definition(value: LanguageDefinition): string;
  resolution_lock(value: PluginResolutionLockDigestInput): string;
  registry_snapshot(value: RegistrySnapshotDigestInput): string;
  has_core_digest_domain(digest_domain: string): boolean;
  has_core_digest_recipe(digest_recipe_id: string, recipe_version: string): boolean;
  has_core_external_verifier(external_verification_contract_id: string, contract_version: string): boolean;
}
