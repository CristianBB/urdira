import { describe, expect, it } from "vitest";
import type { PluginPackageManifest, PluginRegistryContribution } from "@urdira/contracts";
import { computeDigest, digestDomainRegistry, digestRecipeDefinitions, encodeCanonical, externalVerificationContractDefinitions } from "@urdira/canonical";
import {
  canonicalJson,
  canonicalSha256,
  compareSemVerPrecedence,
  normalizeVersionRequirement,
  parseSemVer,
  PluginPackageDiscovery as SdkPluginPackageDiscovery,
  PluginRegistryAssembler as SdkPluginRegistryAssembler,
  PluginResolver as SdkPluginResolver,
  PluginSdkError,
  satisfiesVersionRequirement,
  sha256Bytes,
  type InstalledPluginBundle,
  type PluginDigestAuthority,
  type PluginPackageDiscoveryPort,
  type PluginResolutionInput,
  type PortMaterializationLimits,
  type RegistryAssemblyInput,
  type SdkPluginResolutionLock,
  type StructuredVersionRequirement,
} from "@urdira/plugin-sdk";

function registeredDigest(recipeId: string, value: unknown): string {
  const recipe = digestRecipeDefinitions.find((candidate) => candidate.digest_recipe_id === recipeId);
  if (!recipe) throw new Error(`missing recipe ${recipeId}`);
  const targetField = recipe.target_field.startsWith("/") ? recipe.target_field.slice(1) : undefined;
  const payload = targetField && value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== targetField))
    : value;
  return computeDigest(recipe.digest_domain, recipe.digest_recipe_id, Number(recipe.recipe_version), recipe.payload_schema_id, Number(recipe.payload_schema_version), payload);
}

const digestAuthority: PluginDigestAuthority = {
  plugin_package: (value: unknown) => registeredDigest("core:plugin_package_digest", value),
  analyzer_implementation: (value: unknown) => registeredDigest("core:analyzer_implementation_digest", value),
  compatibility_declaration: (value: unknown) => registeredDigest("core:plugin_compatibility_declaration_digest", value),
  registry_contribution: (value) => registeredDigest("core:plugin_registry_contribution_digest", { ...value, runtime_component_definitions: value.runtime_component_definitions.map((definition) => ({ ...definition, component_contracts: definition.component_contracts.map((binding) => ({ ...binding, contract_version: Number(binding.contract_version), ...(binding.configuration_schema_version === undefined ? {} : { configuration_schema_version: Number(binding.configuration_schema_version) }) })) })) }),
  analysis_configuration: (value: unknown) => registeredDigest("core:analysis_configuration_digest", value),
  runtime_behavior: (value) => registeredDigest("core:runtime_component_behavior_digest", { ...value, contract_bindings: value.contract_bindings.map((binding) => ({ ...binding, contract_version: Number(binding.contract_version), ...(binding.configuration_schema_version === undefined ? {} : { configuration_schema_version: Number(binding.configuration_schema_version) }) })) }),
  runtime_implementation: (value: unknown) => registeredDigest("core:runtime_component_implementation_digest", value),
  language_definition: (value: unknown) => registeredDigest("core:language_definition_digest", value),
  resolution_lock: (value) => registeredDigest("core:plugin_resolution_lock_digest", value),
  registry_snapshot: (value) => registeredDigest("core:registry_snapshot_digest", {
    ...value,
    registry_contract_version: value.registry_contract_version,
    namespace_bindings: value.namespace_bindings.map((binding) => ({
      ...binding,
      emission_valid_from_generation: Number(binding.emission_valid_from_generation),
      ...(binding.emission_valid_to_generation === undefined ? {} : { emission_valid_to_generation: Number(binding.emission_valid_to_generation) }),
    })),
  }),
  has_core_digest_domain: (value: string) => digestDomainRegistry.some((entry) => entry.digest_domain === value),
  has_core_digest_recipe: (id: string, version: string) => digestRecipeDefinitions.some((entry) => entry.digest_recipe_id === id && entry.recipe_version === version),
  has_core_external_verifier: (id: string, version: string) => externalVerificationContractDefinitions.some((entry) => entry.external_verification_contract_id === id && entry.contract_version === version),
};

const discoveryPolicy = { max_file_bytes: 1024 * 1024 };
const discoveryMaterializationLimits: PortMaterializationLimits = Object.freeze({
  max_items: 10_000,
  max_depth: 64,
  max_nodes: 100_000,
  max_bytes: 10 * 1024 * 1024,
});
class PluginPackageDiscovery extends SdkPluginPackageDiscovery {
  constructor(
    port: PluginPackageDiscoveryPort,
    _authority: PluginDigestAuthority = digestAuthority,
    policy = discoveryPolicy,
    materializationLimits: PortMaterializationLimits = discoveryMaterializationLimits,
  ) { super(port, digestAuthority, policy, materializationLimits); }
}
class PluginResolver extends SdkPluginResolver { constructor(_authority: PluginDigestAuthority = digestAuthority) { super(digestAuthority); } }
class PluginRegistryAssembler extends SdkPluginRegistryAssembler { constructor(_authority: PluginDigestAuthority = digestAuthority) { super(digestAuthority); } }

const fileBytes = new TextEncoder().encode("x");
const manifest: PluginPackageManifest = {
  package_format_id: "core:plugin",
  package_format_version: 1,
  plugin_id: "acme:analyzer",
  plugin_version: "1.2.3",
  package_files: [{ normalized_relative_path: "plugin.js", content_digest: sha256Bytes(fileBytes), byte_length: fileBytes.byteLength, executable: true }],
};

const runtimeBehaviorManifest = {
  component_id: "acme:analyzer_runtime", component_version: "1.0.0", component_kind: "source_provider" as const,
  contract_bindings: [{ component_kind: "source_provider" as const, contract_version: "2" }], configuration_schema_ids: [],
  algorithm_ids: [], supported_format_ids: [], deterministic_numeric_contract: "integer_only" as const, portable_behavior_rules: [],
};

const contributionCore = {
  plugin_id: "acme:analyzer",
  plugin_version: "1.2.3",
  namespace: "acme",
  registry_contract_version: "1.0.0",
  dependencies: [],
  canonical_schema_definitions: [],
  digest_domain_definitions: [],
  canonical_comparator_definitions: [],
  external_verification_contract_definitions: [],
  runtime_component_definitions: [{
    component_id: "acme:analyzer_runtime",
    definition_revision: 1,
    schema_version: 1,
    component_version: "1.0.0",
    component_contracts: [{ component_kind: "source_provider", contract_version: "2" }],
    description: "Analyzer runtime.",
    behavior_digest: digestAuthority.runtime_behavior(runtimeBehaviorManifest),
    plugin_owner: "acme:analyzer",
    lifecycle_state: "active",
  }],
  digest_recipe_definitions: [],
  digest_reference_definitions: [],
  language_definitions: [],
  capability_contract_definitions: [],
  construct_class_definitions: [],
  capability_limitation_definitions: [],
  record_kind_definitions: [],
  facet_definitions: [],
  semantic_role_definitions: [],
  metric_definitions: [],
  effect_definitions: [],
  diagnostic_code_definitions: [],
  candidate_issue_code_definitions: [],
  dependency_role_definitions: [],
  projection_kind_definitions: [],
  lifecycle_reason_code_definitions: [],
  completeness_reason_definitions: [],
  semantic_section_kind_definitions: [],
  semantic_reason_definitions: [],
  evidence_assumption_definitions: [],
  evidence_explanation_definitions: [],
} as const;
const contribution = {
  ...contributionCore,
  contribution_digest: digestAuthority.registry_contribution(contributionCore as unknown as PluginRegistryContribution),
} satisfies PluginRegistryContribution;

const analysisManifest = {
  plugin_id: "acme:analyzer", plugin_version: "1.2.3", analyzer_id: "acme:analyzer", analyzer_version: "1.2.3",
  executable_asset_digests: [manifest.package_files[0]!.content_digest], parser_asset_digests: [], rule_asset_digests: [],
  model_asset_digests: [], dependency_asset_digests: [], supported_capabilities: ["acme:syntax"],
};
const analysisConfiguration = { configuration_schema_id: "core:bytes", configuration_schema_version: 1, normalized_configuration: encodeCanonical(Uint8Array.of(1)) };
const runtimeImplementationManifest = {
  runtime_component_build_id: "acme:analyzer_build", component_id: "acme:analyzer_runtime", component_version: "1.0.0",
  behavior_digest: digestAuthority.runtime_behavior(runtimeBehaviorManifest), target_triple: "test", executable_asset_digests: [manifest.package_files[0]!.content_digest],
  native_asset_digests: [], dependency_asset_digests: [],
};
const runtimeBuild = {
  runtime_component_build_id: "acme:analyzer_build",
  schema_version: 1,
  component_id: "acme:analyzer_runtime",
  component_version: "1.0.0",
  behavior_digest: digestAuthority.runtime_behavior(runtimeBehaviorManifest),
  implementation_digest: digestAuthority.runtime_implementation(runtimeImplementationManifest),
  available_from: "1.0.0",
  selectable_to: "",
  removed_at: "",
};

const compatibilityCore = {
  declaration_schema_version: "1.0.0",
  plugin_id: "acme:analyzer",
  plugin_version: "1.2.3",
  namespace: "acme",
  supported_plugin_contract_versions: [1, 2],
  supported_registry_contract_versions: [1],
  dependencies: [],
  offered_capabilities: [{ capability: "acme:syntax", version_requirement: "1.0.0" }],
  recommended_embedding_profile_ids: [],
  package_digest: registeredDigest("core:plugin_package_digest", manifest),
  analysis_digest: registeredDigest("core:analyzer_implementation_digest", analysisManifest),
};

const validBundle: InstalledPluginBundle = {
  package_locator: "x",
  manifest,
  compatibility: {
    ...compatibilityCore,
    declaration_digest: registeredDigest("core:plugin_compatibility_declaration_digest", compatibilityCore),
  },
  contribution,
  runtime_builds: [runtimeBuild],
  analyzer_implementation_manifest: analysisManifest,
  analysis_configuration: analysisConfiguration,
  runtime_behavior_manifests: [runtimeBehaviorManifest],
  runtime_implementation_manifests: [runtimeImplementationManifest],
};

class RecordingDiscoveryPort implements PluginPackageDiscoveryPort {
  readonly calls: string[] = [];
  executions = 0;

  constructor(private readonly roots: Readonly<Record<string, readonly InstalledPluginBundle[]>>) {}

  async list(root_id: string): Promise<readonly InstalledPluginBundle[]> {
    this.calls.push(root_id);
    return this.roots[root_id] ?? [];
  }

  async read_file(request: { readonly package_locator: string }): Promise<{ readonly bytes: Uint8Array; readonly byte_length: number }> {
    const bytes = new TextEncoder().encode(request.package_locator);
    return { bytes, byte_length: bytes.byteLength };
  }

  execute(): never {
    this.executions += 1;
    throw new Error("must not execute");
  }
}

const anyVersion: StructuredVersionRequirement = { alternatives: [{}], allow_prerelease: false };

function withReversedLocaleCompare<T>(operation: () => T): T {
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = function reversedLocaleCompare(other: string): number {
    const left = String(this);
    return left < other ? 1 : left > other ? -1 : 0;
  };
  try {
    return operation();
  } finally {
    String.prototype.localeCompare = original;
  }
}

describe("Phase 8 canonical JSON ordering", () => {
  it("orders recursive object keys by UTF-8 bytes rather than UTF-16 code units", () => {
    const astral = "\u{10000}";
    const privateUse = "\uE000";
    const first = {
      [astral]: { [astral]: "nested-astral", [privateUse]: "nested-bmp" },
      [privateUse]: "bmp",
    };
    const reverseInsertion = {
      [privateUse]: "bmp",
      [astral]: { [privateUse]: "nested-bmp", [astral]: "nested-astral" },
    };
    const expected = "{\"\uE000\":\"bmp\",\"\u{10000}\":{\"\uE000\":\"nested-bmp\",\"\u{10000}\":\"nested-astral\"}}";

    expect(canonicalJson(first)).toBe(expected);
    expect(canonicalJson(reverseInsertion)).toBe(expected);
    expect(canonicalSha256(first)).toBe("sha256:dd9a02315197999baadfafa0df1ae45dc17bc0d35263f4bcf9e289e21688db91");
    expect(canonicalSha256(reverseInsertion)).toBe("sha256:dd9a02315197999baadfafa0df1ae45dc17bc0d35263f4bcf9e289e21688db91");
  });
});

describe("Phase 8 plugin SDK discovery", () => {
  it("requires explicit discovery materialization limits before calling the port", async () => {
    let calls = 0;
    const port = {
      list: async () => { calls += 1; return [validBundle]; },
      read_file: async () => ({ bytes: fileBytes, byte_length: fileBytes.byteLength }),
    };

    await expect(new (SdkPluginPackageDiscovery as any)(port, digestAuthority, discoveryPolicy).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_declaration_invalid" });
    expect(calls).toBe(0);
  });

  it("rejects a hostile huge collection before reading index zero", async () => {
    let indexReads = 0;
    const huge = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") return 200_000;
        if (property === "0") { indexReads += 1; throw new TypeError("private /host/index"); }
        return Reflect.get(target, property, receiver);
      },
    });
    const port = {
      list: async () => huge as unknown as readonly InstalledPluginBundle[],
      read_file: async () => ({ bytes: fileBytes, byte_length: fileBytes.byteLength }),
    };

    await expect(new PluginPackageDiscovery(port, digestAuthority, discoveryPolicy, { ...discoveryMaterializationLimits, max_items: 4 }).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_declaration_invalid" });
    expect(indexReads).toBe(0);
  });

  it("rejects over-depth and over-node discovery documents before reading their guarded leaves", async () => {
    const guardedLeaf = (reads: { value: number }): unknown[] => new Proxy([null], {
      get(target, property, receiver) {
        if (property === "0") { reads.value += 1; throw new TypeError("private /guarded/leaf"); }
        return Reflect.get(target, property, receiver);
      },
    });
    const depthReads = { value: 0 };
    const deep = [[[[guardedLeaf(depthReads)]]]];
    const nodeReads = { value: 0 };
    const nodes = [[], [], guardedLeaf(nodeReads)];
    const read_file = async () => ({ bytes: fileBytes, byte_length: fileBytes.byteLength });

    await expect(new PluginPackageDiscovery({ list: async () => deep as unknown as readonly InstalledPluginBundle[], read_file }, digestAuthority, discoveryPolicy, { max_items: 10, max_depth: 3, max_nodes: 100, max_bytes: 1_000 }).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_declaration_invalid" });
    await expect(new PluginPackageDiscovery({ list: async () => nodes as unknown as readonly InstalledPluginBundle[], read_file }, digestAuthority, discoveryPolicy, { max_items: 10, max_depth: 10, max_nodes: 3, max_bytes: 1_000 }).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_declaration_invalid" });
    expect({ depthReads: depthReads.value, nodeReads: nodeReads.value }).toEqual({ depthReads: 0, nodeReads: 0 });
  });

  it("bounds discovery document bytes and cycles with sanitized SDK errors", async () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    const read_file = async () => ({ bytes: fileBytes, byte_length: fileBytes.byteLength });
    const byteResult = new PluginPackageDiscovery({ list: async () => ["private-/path/".repeat(20)] as unknown as readonly InstalledPluginBundle[], read_file }, digestAuthority, discoveryPolicy, { max_items: 10, max_depth: 10, max_nodes: 100, max_bytes: 16 }).discover(["approved"]);
    const cycleResult = new PluginPackageDiscovery({ list: async () => cyclic as unknown as readonly InstalledPluginBundle[], read_file }, digestAuthority, discoveryPolicy, { max_items: 10, max_depth: 10, max_nodes: 100, max_bytes: 1_000 }).discover(["approved"]);

    for (const result of [byteResult, cycleResult]) {
      await expect(result).rejects.toBeInstanceOf(PluginSdkError);
      await result.catch((error: unknown) => {
        expect(error).toMatchObject({ code: "plugin-sdk:package_declaration_invalid" });
        expect(JSON.stringify(error)).not.toContain("private-/path");
      });
    }
  });

  it("rejects foreign prototypes and enumerable __proto__ without prototype pollution", async () => {
    const inherited = Object.create({ polluted: true }) as Record<string, unknown>;
    Object.defineProperties(inherited, Object.getOwnPropertyDescriptors(validBundle));
    const protoKey = Object.create(Object.prototype) as Record<string, unknown>;
    Object.defineProperties(protoKey, Object.getOwnPropertyDescriptors(validBundle));
    Object.defineProperty(protoKey, "__proto__", { value: { polluted: true }, enumerable: true });
    const read_file = async () => ({ bytes: fileBytes, byte_length: fileBytes.byteLength });

    for (const bundle of [inherited, protoKey]) {
      await expect(new PluginPackageDiscovery({ list: async () => [bundle as unknown as InstalledPluginBundle], read_file }).discover(["approved"]))
        .rejects.toMatchObject({ code: "plugin-sdk:package_declaration_invalid" });
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("materializes a mutable discovery collection length once and owns bundled bytes", async () => {
    let lengthReads = 0;
    const foreign = new Proxy([validBundle], {
      get(target, property, receiver) {
        if (property === "length") { lengthReads += 1; return lengthReads === 1 ? 1 : 0; }
        return Reflect.get(target, property, receiver);
      },
    });
    const result = await new PluginPackageDiscovery({
      list: async () => foreign,
      read_file: async () => ({ bytes: fileBytes, byte_length: fileBytes.byteLength }),
    }).discover(["approved"]);

    expect(result.packages).toHaveLength(1);
    expect(lengthReads).toBe(1);
    expect(result.packages[0]!.analysis_configuration.normalized_configuration).toBeInstanceOf(Uint8Array);
    expect(result.packages[0]!.analysis_configuration.normalized_configuration).not.toBe(validBundle.analysis_configuration.normalized_configuration);
  });

  it("uses authoritative registered digest domains instead of generic payload hashing", async () => {
    const payload = { value: "same" };
    expect(computeDigest("core:plugin_package", "core:plugin_package_digest", 1, "core:PluginPackageManifest", 1, payload))
      .not.toBe(computeDigest("core:analyzer_implementation", "core:analyzer_implementation_digest", 1, "core:PluginPackageManifest", 1, payload));
    expect(validBundle.compatibility.package_digest).toBe(digestAuthority.plugin_package(validBundle.manifest));
    await expect(new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [validBundle] })).discover(["approved"]))
      .resolves.toMatchObject({ packages: [{ package_digest: validBundle.compatibility.package_digest }] });
  });

  it("rejects an over-policy manifest length before invoking the bounded package byte port", async () => {
    let reads = 0;
    const oversized = { ...validBundle, manifest: { ...validBundle.manifest, package_files: [{ ...validBundle.manifest.package_files[0]!, byte_length: 1025 }] } };
    const port = { list: async () => [oversized], read_file: async () => { reads += 1; return { bytes: fileBytes, byte_length: fileBytes.byteLength }; } };
    await expect(new (PluginPackageDiscovery as any)(port, digestAuthority, { max_file_bytes: 1024 }).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_file_too_large" });
    expect(reads).toBe(0);
  });

  it("requires complete runtime asset closure and one behavior supply per component release", async () => {
    const emptyImplementation = { ...validBundle.runtime_implementation_manifests[0]!, executable_asset_digests: [] };
    const emptyBuild = { ...validBundle.runtime_builds[0]!, implementation_digest: digestAuthority.runtime_implementation(emptyImplementation) };
    const omitted = { ...validBundle, runtime_builds: [emptyBuild], runtime_implementation_manifests: [emptyImplementation] } as InstalledPluginBundle;
    const duplicate = { ...validBundle, runtime_behavior_manifests: [validBundle.runtime_behavior_manifests[0]!, validBundle.runtime_behavior_manifests[0]!] } as InstalledPluginBundle;
    await expect(new (PluginPackageDiscovery as any)(new RecordingDiscoveryPort({ approved: [omitted] }), digestAuthority, { max_file_bytes: 1024 }).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_digest_mismatch" });
    await expect(new (PluginPackageDiscovery as any)(new RecordingDiscoveryPort({ approved: [duplicate] }), digestAuthority, { max_file_bytes: 1024 }).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_declaration_invalid" });
  });

  it("accepts disjoint package-owned asset closures for separate runtime builds", async () => {
    const linuxBytes = new TextEncoder().encode("linux");
    const macBytes = new TextEncoder().encode("macos");
    const packageManifest = {
      ...validBundle.manifest,
      package_files: [
        { normalized_relative_path: "linux/plugin", content_digest: sha256Bytes(linuxBytes), byte_length: linuxBytes.byteLength, executable: true },
        { normalized_relative_path: "macos/plugin", content_digest: sha256Bytes(macBytes), byte_length: macBytes.byteLength, executable: true },
      ],
    };
    const analyzer = {
      ...validBundle.analyzer_implementation_manifest,
      executable_asset_digests: packageManifest.package_files.map((entry) => entry.content_digest),
    };
    const implementations = packageManifest.package_files.map((entry, index) => ({
      ...validBundle.runtime_implementation_manifests[0]!,
      runtime_component_build_id: `acme:analyzer_build_${index === 0 ? "linux" : "macos"}`,
      target_triple: index === 0 ? "x86_64-unknown-linux-gnu" : "aarch64-apple-darwin",
      executable_asset_digests: [entry.content_digest],
    }));
    const builds = implementations.map((implementation) => ({
      ...validBundle.runtime_builds[0]!,
      runtime_component_build_id: implementation.runtime_component_build_id,
      implementation_digest: digestAuthority.runtime_implementation(implementation),
    }));
    const compatibilityWithoutDigest = {
      ...validBundle.compatibility,
      package_digest: digestAuthority.plugin_package(packageManifest),
      analysis_digest: digestAuthority.analyzer_implementation(analyzer),
    } as Record<string, unknown>;
    delete compatibilityWithoutDigest["declaration_digest"];
    const bundle = {
      ...validBundle,
      manifest: packageManifest,
      analyzer_implementation_manifest: analyzer,
      compatibility: { ...compatibilityWithoutDigest, declaration_digest: digestAuthority.compatibility_declaration(compatibilityWithoutDigest as any) },
      runtime_builds: builds,
      runtime_implementation_manifests: implementations,
    } as unknown as InstalledPluginBundle;
    const files = new Map([["linux/plugin", linuxBytes], ["macos/plugin", macBytes]]);
    const port: PluginPackageDiscoveryPort = {
      list: async () => [bundle],
      read_file: async (request) => {
        const bytes = files.get(request.normalized_relative_path)!;
        return { bytes, byte_length: bytes.byteLength };
      },
    };

    await expect(new PluginPackageDiscovery(port).discover(["approved"]))
      .resolves.toMatchObject({ packages: [{ runtime_builds: [{ runtime_component_build_id: "acme:analyzer_build_linux" }, { runtime_component_build_id: "acme:analyzer_build_macos" }] }] });

    const extraDigest = `sha256:${"f".repeat(64)}`;
    const extraImplementation = { ...implementations[0]!, dependency_asset_digests: [extraDigest] };
    const extraBundle = {
      ...bundle,
      runtime_builds: [{ ...builds[0]!, implementation_digest: digestAuthority.runtime_implementation(extraImplementation) }, builds[1]!],
      runtime_implementation_manifests: [extraImplementation, implementations[1]!],
    } as InstalledPluginBundle;
    await expect(new PluginPackageDiscovery({ ...port, list: async () => [extraBundle] }).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_digest_mismatch" });
  });

  it("verifies every installed package file against bytes read through the package port", async () => {
    const port = new RecordingDiscoveryPort({ approved: [validBundle] });
    port.read_file = async () => { const bytes = new TextEncoder().encode("y"); return { bytes, byte_length: bytes.byteLength }; };

    await expect(new PluginPackageDiscovery(port).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_digest_mismatch" } satisfies Partial<PluginSdkError>);
  });

  it("materializes a hostile returned collection before any foreign iteration", async () => {
    const hostile = new Proxy([validBundle], {
      get(target, property, receiver) {
        if (property === "0") throw new TypeError("foreign index /private/package");
        return Reflect.get(target, property, receiver);
      },
    });
    const port = { list: async () => hostile } as unknown as PluginPackageDiscoveryPort;

    await expect(new PluginPackageDiscovery(port).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_declaration_invalid" } satisfies Partial<PluginSdkError>);
  });

  it("requires compatibility and contribution dependencies to be canonically identical", async () => {
    const bundle = packageAt("acme:consumer", "1.0.0", { dependencies: [{ plugin_id: "acme:provider", namespace: "provider", version_requirement: "^1.0.0", required_capabilities: [] }] });
    const contributionCore = { ...bundle.contribution, dependencies: [] } as Record<string, unknown>;
    delete contributionCore["contribution_digest"];
    const inconsistent = { ...bundle, contribution: { ...contributionCore, contribution_digest: digestAuthority.registry_contribution(contributionCore as unknown as PluginRegistryContribution) } } as unknown as InstalledPluginBundle;

    await expect(new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [inconsistent] })).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_declaration_invalid" } satisfies Partial<PluginSdkError>);
  });

  it("canonicalizes equivalent dependency comparator ordering", async () => {
    const dependencies = [{ plugin_id: "provider:plugin", namespace: "provider", version_requirement: ">1.0.0 <3.0.0", required_capabilities: [] }];
    const bundle = packageAt("acme:consumer", "1.0.0", { dependencies });
    const contributionCore = { ...bundle.contribution, dependencies: [{ ...dependencies[0]!, version_requirement: "<3.0.0   >1.0.0" }] } as Record<string, unknown>;
    delete contributionCore["contribution_digest"];
    const equivalent = { ...bundle, contribution: { ...contributionCore, contribution_digest: digestAuthority.registry_contribution(contributionCore as unknown as PluginRegistryContribution) } } as unknown as InstalledPluginBundle;
    await expect(new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [equivalent] })).discover(["approved"])).resolves.toMatchObject({ packages: [{ plugin_id: "acme:consumer" }] });
  });

  it.each([
    ["integer string as SemVer", packageAt("acme:plugin", "1.0.0"), (bundle: InstalledPluginBundle) => ({ ...bundle.compatibility, declaration_schema_version: "1" })],
    ["punctuated namespaced identifier", packageAt("acme.plugin:analyzer", "1.0.0", { namespace: "acme.plugin" }), (bundle: InstalledPluginBundle) => bundle.compatibility],
  ])("rejects non-authoritative logical values: %s", async (_label, original, change) => {
    const compatibilityCore = change(original) as Record<string, unknown>;
    delete compatibilityCore["declaration_digest"];
    const invalid = { ...original, compatibility: { ...compatibilityCore, declaration_digest: registeredDigest("core:plugin_compatibility_declaration_digest", compatibilityCore) } } as unknown as InstalledPluginBundle;
    await expect(new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [invalid] })).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_declaration_invalid" } satisfies Partial<PluginSdkError>);
  });

  it("rejects forged registered digests and does not collapse changed package closure under one claim", async () => {
    const forgedCompatibilityCore = { ...validBundle.compatibility, package_digest: canonicalSha256("forged") };
    delete (forgedCompatibilityCore as Partial<typeof validBundle.compatibility>).declaration_digest;
    const forged = { ...validBundle, compatibility: { ...forgedCompatibilityCore, declaration_digest: registeredDigest("core:plugin_compatibility_declaration_digest", forgedCompatibilityCore) } } as InstalledPluginBundle;
    const changedClosure = {
      ...validBundle,
      manifest: {
        ...manifest,
        package_files: [{ normalized_relative_path: "plugin.js", content_digest: "sha256:changed", byte_length: 7, executable: true }],
      },
    } as InstalledPluginBundle;

    await expect(new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [forged] })).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_digest_mismatch" } satisfies Partial<PluginSdkError>);
    await expect(new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [validBundle, changedClosure] })).discover(["approved"]))
      .rejects.toBeInstanceOf(PluginSdkError);
  });

  it.each([
    ["declaration", { ...validBundle, compatibility: { ...validBundle.compatibility, declaration_digest: canonicalSha256("forged-declaration") } }],
    ["analysis", (() => {
      const core = { ...validBundle.compatibility, analysis_digest: canonicalSha256("forged-analysis") } as Record<string, unknown>;
      delete core["declaration_digest"];
      return { ...validBundle, compatibility: { ...core, declaration_digest: registeredDigest("core:plugin_compatibility_declaration_digest", core) } };
    })()],
    ["contribution", { ...validBundle, contribution: { ...validBundle.contribution, contribution_digest: canonicalSha256("forged-contribution") } }],
    ["behavior", { ...validBundle, runtime_builds: [{ ...validBundle.runtime_builds[0]!, behavior_digest: canonicalSha256("forged-behavior") }] }],
    ["implementation", { ...validBundle, runtime_builds: [{ ...validBundle.runtime_builds[0]!, implementation_digest: canonicalSha256("forged-implementation") }] }],
  ])("rejects a forged %s digest claim", async (_digest, forged) => {
    await expect(new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [forged as InstalledPluginBundle] })).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_digest_mismatch" } satisfies Partial<PluginSdkError>);
  });

  it("sanitizes rejected discovery ports and hostile bundle getters into bounded SDK errors", async () => {
    const rejected = { list: async () => { throw new RangeError("foreign path: /private/secret/plugin"); } } as unknown as PluginPackageDiscoveryPort;
    await expect(new PluginPackageDiscovery(rejected).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_discovery_failed" } satisfies Partial<PluginSdkError>);

    const hostile = Object.defineProperty({}, "manifest", { enumerable: true, get: () => { throw new TypeError("foreign getter"); } });
    await expect(new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [hostile as InstalledPluginBundle] })).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_declaration_invalid" } satisfies Partial<PluginSdkError>);
  });

  it("materializes every fulfilled foreign bundle property exactly once", async () => {
    const reads = new Map<string, number>();
    const foreign = Object.fromEntries(Object.entries(validBundle).map(([key, value]) => [key, {
      enumerable: true,
      get: () => { reads.set(key, (reads.get(key) ?? 0) + 1); return value; },
    }])) as PropertyDescriptorMap;
    const result = await new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [Object.defineProperties({}, foreign) as InstalledPluginBundle] })).discover(["approved"]);
    expect(result.packages).toHaveLength(1);
    expect([...reads.values()]).toEqual(Array(reads.size).fill(1));
  });

  it("discovers only closed bundles from configured local roots without executing them", async () => {
    const port = new RecordingDiscoveryPort({ approved: [validBundle], ignored: [{ ...validBundle, unexpected: true } as unknown as InstalledPluginBundle] });

    const result = await new PluginPackageDiscovery(port).discover(["approved"]);

    expect(result.packages.map((item) => [item.plugin_id, item.plugin_version])).toEqual([["acme:analyzer", "1.2.3"]]);
    expect(port.calls).toEqual(["approved"]);
    expect(port.executions).toBe(0);
  });

  it("collapses closed bundles only when the full coordinate and digest are identical", async () => {
    const result = await new PluginPackageDiscovery(new RecordingDiscoveryPort({ one: [validBundle], two: [validBundle] })).discover(["one", "two"]);

    expect(result.packages).toHaveLength(1);
    expect(result.collision_candidates).toEqual([]);
  });

  it("rejects extra fields from closed bundles declarations", async () => {
    const invalid = {
      ...validBundle,
      compatibility: { ...validBundle.compatibility, executable_path: "/private/plugin" },
    } as InstalledPluginBundle;

    await expect(new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [invalid] })).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_declaration_invalid" } satisfies Partial<PluginSdkError>);
  });

  it("rejects extra fields nested in closed bundles manifests", async () => {
    const invalid = {
      ...validBundle,
      manifest: {
        ...manifest,
        package_files: [{ normalized_relative_path: "plugin.js", content_digest: "sha256:file", byte_length: 1, executable: false, mode: "0644" }],
      },
    } as unknown as InstalledPluginBundle;

    await expect(new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [invalid] })).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_declaration_invalid" } satisfies Partial<PluginSdkError>);
  });

  it("rejects malformed SemVer and structured requirements while discovering closed bundles", async () => {
    const invalid = {
      ...validBundle,
      compatibility: {
        ...validBundle.compatibility,
        dependencies: [{ plugin_id: "other:plugin", namespace: "other", version_requirement: "", required_capabilities: [] }],
      },
    };

    await expect(new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [invalid] })).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_declaration_invalid" } satisfies Partial<PluginSdkError>);
  });

  it.each([
    ["package format", { ...validBundle, manifest: { ...manifest, package_format_version: 0 } }],
    ["package file length", { ...validBundle, manifest: { ...manifest, package_files: [{ normalized_relative_path: "plugin.js", content_digest: "sha256:file", byte_length: -1, executable: false }] } }],
    ["package file executable flag", { ...validBundle, manifest: { ...manifest, package_files: [{ normalized_relative_path: "plugin.js", content_digest: "sha256:file", byte_length: 1, executable: "false" }] } }],
    ["plugin identifier", { ...validBundle, manifest: { ...manifest, plugin_id: "invalid" }, compatibility: { ...validBundle.compatibility, plugin_id: "invalid" }, contribution: { ...contribution, plugin_id: "invalid" } }],
    ["namespace", { ...validBundle, compatibility: { ...validBundle.compatibility, namespace: "core" }, contribution: { ...contribution, namespace: "core" } }],
    ["capability", { ...validBundle, compatibility: { ...validBundle.compatibility, offered_capabilities: [7] } }],
    ["dependency fields", { ...validBundle, compatibility: { ...validBundle.compatibility, dependencies: [{ plugin_id: 7, namespace: "other", version_requirement: "*", required_capabilities: [] }] } }],
    ["digest", { ...validBundle, runtime_builds: [{ ...validBundle.runtime_builds[0]!, behavior_digest: { unsafe: true } }] }],
  ])("rejects invalid closed manifest values safely: %s", async (_field, invalid) => {
    await expect(new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [invalid as unknown as InstalledPluginBundle] })).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_declaration_invalid" } satisfies Partial<PluginSdkError>);
  });

  it.each([
    ["non-array package_files", { ...validBundle, manifest: { ...manifest, package_files: {} } }, "plugin-sdk:package_declaration_invalid"],
    ["non-array compatibility dependencies", { ...validBundle, compatibility: { ...validBundle.compatibility, dependencies: {} } }, "plugin-sdk:package_declaration_invalid"],
    ["non-array offered capabilities", { ...validBundle, compatibility: { ...validBundle.compatibility, offered_capabilities: {} } }, "plugin-sdk:package_declaration_invalid"],
    ["non-array runtime contracts", { ...validBundle, compatibility: { ...validBundle.compatibility, supported_plugin_contract_versions: {} } }, "plugin-sdk:package_declaration_invalid"],
    ["non-array contribution dependencies", { ...validBundle, contribution: { ...contribution, dependencies: {} } }, "plugin-sdk:package_declaration_invalid"],
    ["non-array contribution definitions", { ...validBundle, contribution: { ...contribution, canonical_schema_definitions: {} } }, "plugin-sdk:package_declaration_invalid"],
    ["non-object package-file entry", { ...validBundle, manifest: { ...manifest, package_files: [null] } }, "plugin-sdk:package_declaration_invalid"],
    ["non-object dependency entry", { ...validBundle, compatibility: { ...validBundle.compatibility, dependencies: [null] } }, "plugin-sdk:package_declaration_invalid"],
  ])("rejects malformed discovery containers with a bounded PluginSdkError: %s", async (_field, invalid, code) => {
    try {
      await new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [invalid as unknown as InstalledPluginBundle] })).discover(["approved"]);
      throw new Error("expected discovery rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginSdkError);
      expect(error).not.toBeInstanceOf(TypeError);
      expect(error).toMatchObject({ code });
      expect((error as PluginSdkError).message.length).toBeLessThanOrEqual(240);
    }
  });

  it("rejects a non-array discovery-port result with a bounded PluginSdkError", async () => {
    const port = { list: async () => ({ unsafe: true }) } as unknown as PluginPackageDiscoveryPort;

    try {
      await new PluginPackageDiscovery(port).discover(["approved"]);
      throw new Error("expected discovery rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginSdkError);
      expect(error).not.toBeInstanceOf(TypeError);
      expect(error).toMatchObject({ code: "plugin-sdk:package_declaration_invalid" });
      expect((error as PluginSdkError).message.length).toBeLessThanOrEqual(240);
    }
  });

  const declarationMismatchCore = { ...validBundle.compatibility, plugin_version: "1.2.4" } as Record<string, unknown>;
  delete declarationMismatchCore["declaration_digest"];
  const contributionMismatchCore = { ...validBundle.contribution, plugin_id: "other:plugin" } as Record<string, unknown>;
  delete contributionMismatchCore["contribution_digest"];
  const manifestMismatch = { ...manifest, plugin_id: "other:plugin" };
  const manifestCompatibilityCore = { ...validBundle.compatibility, package_digest: registeredDigest("core:plugin_package_digest", manifestMismatch) } as Record<string, unknown>;
  delete manifestCompatibilityCore["declaration_digest"];
  it.each([
    ["manifest", { ...validBundle, manifest: manifestMismatch, compatibility: { ...manifestCompatibilityCore, declaration_digest: registeredDigest("core:plugin_compatibility_declaration_digest", manifestCompatibilityCore) } }],
    ["declaration", { ...validBundle, compatibility: { ...declarationMismatchCore, declaration_digest: registeredDigest("core:plugin_compatibility_declaration_digest", declarationMismatchCore) } }],
    ["contribution", { ...validBundle, contribution: { ...contributionMismatchCore, contribution_digest: digestAuthority.registry_contribution(contributionMismatchCore as unknown as PluginRegistryContribution) } }],
    ["runtime build", { ...validBundle, runtime_builds: [{ ...validBundle.runtime_builds[0]!, component_id: "other:runtime" }] }],
  ])("rejects package/declaration/contribution coordinate mismatch in the %s", async (_part, invalid) => {
    await expect(new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [invalid as InstalledPluginBundle] })).discover(["approved"]))
      .rejects.toMatchObject({ code: "plugin-sdk:package_coordinate_mismatch" } satisfies Partial<PluginSdkError>);
  });

  it("reports the same full version with different package bytes as a coordinate collision candidate", async () => {
    const changed = packageAt("acme:analyzer", "1.2.3", { package_digest: "changed-bytes" });

    const result = await new PluginPackageDiscovery(new RecordingDiscoveryPort({ approved: [validBundle, changed] })).discover(["approved"]);

    expect(result.packages).toHaveLength(2);
    expect(result.collision_candidates).toEqual([{
      plugin_id: "acme:analyzer",
      plugin_version: "1.2.3",
      package_digests: [validBundle.compatibility.package_digest, changed.compatibility.package_digest].sort(),
    }]);
  });
});

function packageAt(
  plugin_id: string,
  plugin_version: string,
  options: {
    namespace?: string;
    dependencies?: InstalledPluginBundle["compatibility"]["dependencies"];
    capabilities?: readonly string[];
    runtime_contract_version?: number;
    registry_contract_version?: number;
    package_digest?: string;
  } = {},
): InstalledPluginBundle {
  const namespace = options.namespace ?? plugin_id.split(":")[0]!;
  const runtimeContract = options.runtime_contract_version ?? 2;
  const registryContract = options.registry_contract_version ?? 1;
  const buildId = `${namespace}:runtime_build`;
  const componentId = `${namespace}:runtime`;
  const packageLocator = options.package_digest ?? plugin_id;
  const ownedBytes = new TextEncoder().encode(packageLocator);
  const packageManifest = {
    ...manifest,
    plugin_id,
    plugin_version,
    package_files: [{ normalized_relative_path: "plugin.js", content_digest: sha256Bytes(ownedBytes), byte_length: ownedBytes.byteLength, executable: true }],
  };
  const analysis = {
    plugin_id, plugin_version, analyzer_id: plugin_id, analyzer_version: plugin_version,
    executable_asset_digests: [packageManifest.package_files[0]!.content_digest], parser_asset_digests: [], rule_asset_digests: [],
    model_asset_digests: [], dependency_asset_digests: [], supported_capabilities: options.capabilities ?? [],
  };
  const behavior = {
    component_id: componentId, component_version: "1.0.0", component_kind: "source_provider" as const,
    contract_bindings: [{ component_kind: "source_provider" as const, contract_version: String(runtimeContract) }],
    configuration_schema_ids: [], algorithm_ids: [], supported_format_ids: [], deterministic_numeric_contract: "integer_only" as const,
    portable_behavior_rules: [],
  };
  const implementation = {
    runtime_component_build_id: buildId, component_id: componentId, component_version: "1.0.0", behavior_digest: digestAuthority.runtime_behavior(behavior),
    target_triple: "test", executable_asset_digests: [packageManifest.package_files[0]!.content_digest], native_asset_digests: [], dependency_asset_digests: [],
  };
  const contributionWithoutDigest = {
    ...contributionCore,
    plugin_id,
    plugin_version,
    namespace,
    registry_contract_version: `${registryContract}.0.0`,
    dependencies: options.dependencies ?? [],
    runtime_component_definitions: [{
      component_id: componentId, definition_revision: 1, schema_version: 1, component_version: "1.0.0",
      component_contracts: [{ component_kind: "source_provider", contract_version: String(runtimeContract) }],
      description: "Plugin runtime.", behavior_digest: digestAuthority.runtime_behavior(behavior), plugin_owner: plugin_id, lifecycle_state: "active",
    }],
  };
  const compatibilityWithoutDigest = {
    declaration_schema_version: "1.0.0",
    plugin_id,
    plugin_version,
    namespace,
    supported_plugin_contract_versions: [runtimeContract],
    supported_registry_contract_versions: [registryContract],
    dependencies: options.dependencies ?? [],
    offered_capabilities: (options.capabilities ?? []).map((capability) => ({ capability, version_requirement: "1.0.0" })),
    recommended_embedding_profile_ids: [],
    package_digest: registeredDigest("core:plugin_package_digest", packageManifest),
    analysis_digest: registeredDigest("core:analyzer_implementation_digest", analysis),
  };
  return {
    package_locator: packageLocator,
    manifest: packageManifest,
    compatibility: { ...compatibilityWithoutDigest, declaration_digest: registeredDigest("core:plugin_compatibility_declaration_digest", compatibilityWithoutDigest) },
    contribution: { ...contributionWithoutDigest, contribution_digest: digestAuthority.registry_contribution(contributionWithoutDigest as unknown as PluginRegistryContribution) },
    runtime_builds: [{ runtime_component_build_id: buildId, schema_version: 1, component_id: componentId, component_version: "1.0.0",
      behavior_digest: digestAuthority.runtime_behavior(behavior), implementation_digest: digestAuthority.runtime_implementation(implementation), available_from: "1.0.0", selectable_to: "", removed_at: "" }],
    analyzer_implementation_manifest: analysis,
    analysis_configuration: { configuration_schema_id: "core:bytes", configuration_schema_version: 1, normalized_configuration: encodeCanonical(Uint8Array.of(1)) },
    runtime_behavior_manifests: [behavior],
    runtime_implementation_manifests: [implementation],
  };
}

function resolutionInput(packages: readonly InstalledPluginBundle[], plugin_ids: readonly string[]): PluginResolutionInput {
  return {
    packages: packages.map((bundle) => ({
      ...bundle,
      plugin_id: bundle.manifest.plugin_id,
      plugin_version: bundle.manifest.plugin_version,
      namespace: bundle.compatibility.namespace,
      package_digest: bundle.compatibility.package_digest,
      declaration_digest: bundle.compatibility.declaration_digest,
      contribution_digest: bundle.contribution.contribution_digest,
      analysis_configuration_digest: registeredDigest("core:analysis_configuration_digest", bundle.analysis_configuration),
    })),
    requirements: plugin_ids.map((plugin_id) => ({ plugin_id, version_requirement: anyVersion })),
    pins: [],
    supported_runtime_contract_versions: [1, 2, 3],
    supported_registry_contract_versions: [1, 2, 3],
    workspace_id: "workspace-1",
    resolver_version: "1.0.0",
    clock: () => "2026-08-09T12:00:00Z",
    id_source: () => "lock-1",
  };
}

describe("Phase 8 structured SemVer and exact resolver", () => {
  it("uses the authoritative metadata row for every compatibility issue code emitted by resolution", () => {
    const namespace = new PluginResolver().resolve(resolutionInput([
      packageAt("one:plugin", "1.0.0", { namespace: "shared" }),
      packageAt("two:plugin", "1.0.0", { namespace: "shared" }),
    ], ["one:plugin", "two:plugin"]));
    const version = new PluginResolver().resolve(resolutionInput([], ["missing:plugin"]));
    const cycleA = packageAt("a:plugin", "1.0.0", { namespace: "a", dependencies: [{ plugin_id: "b:plugin", namespace: "b", version_requirement: "*", required_capabilities: [] }] });
    const cycleB = packageAt("b:plugin", "1.0.0", { namespace: "b", dependencies: [{ plugin_id: "a:plugin", namespace: "a", version_requirement: "*", required_capabilities: [] }] });
    const cycle = new PluginResolver().resolve(resolutionInput([cycleA, cycleB], ["a:plugin"]));
    const consumer = packageAt("consumer:plugin", "1.0.0", { namespace: "consumer", dependencies: [{ plugin_id: "provider:plugin", namespace: "provider", version_requirement: "*", required_capabilities: ["provider:syntax"] }] });
    const provider = packageAt("provider:plugin", "1.0.0", { namespace: "provider" });
    const capability = new PluginResolver().resolve(resolutionInput([consumer, provider], ["consumer:plugin"]));
    const pluginContract = new PluginResolver().resolve({ ...resolutionInput([], []), supported_runtime_contract_versions: [] });
    const registryContract = new PluginResolver().resolve({ ...resolutionInput([], []), supported_registry_contract_versions: [] });

    const metadata = [namespace, version, cycle, capability, pluginContract, registryContract].map((result) => {
      if (result.ok) throw new Error("expected compatibility issue");
      const issue = result.issues[0]!;
      return [issue.code, issue.phase, issue.severity, issue.required_action, issue.retryable];
    });
    expect(metadata).toEqual([
      ["PLUGIN_NAMESPACE_CONFLICT", "resolution", "error", "resolve_namespace_conflict", "false"],
      ["PLUGIN_VERSION_CONFLICT", "resolution", "error", "select_compatible_version", "false"],
      ["PLUGIN_DEPENDENCY_CYCLE", "resolution", "error", "remove_dependency_cycle", "false"],
      ["PLUGIN_CAPABILITY_UNAVAILABLE", "negotiation", "error", "install_capability_provider", "false"],
      ["PLUGIN_CONTRACT_INCOMPATIBLE", "negotiation", "error", "update_plugin_or_engine", "false"],
      ["REGISTRY_CONTRACT_INCOMPATIBLE", "negotiation", "error", "update_plugin_or_engine", "false"],
    ]);
  });

  it("keeps lock and issue ordering independent of locale collation", () => {
    const packages = [packageAt("zeta:plugin", "1.0.0", { namespace: "zeta" }), packageAt("alpha:plugin", "1.0.0", { namespace: "alpha" })];
    const resolved = new PluginResolver().resolve(resolutionInput(packages, ["zeta:plugin", "alpha:plugin"]));
    const reversed = withReversedLocaleCompare(() => new PluginResolver().resolve(resolutionInput(packages, ["zeta:plugin", "alpha:plugin"])));
    expect(reversed).toEqual(resolved);

    const conflictPackages = [packageAt("zeta:plugin", "1.0.0", { namespace: "shared" }), packageAt("alpha:plugin", "1.0.0", { namespace: "shared" })];
    const issue = new PluginResolver().resolve(resolutionInput(conflictPackages, ["zeta:plugin", "alpha:plugin"]));
    const reversedIssue = withReversedLocaleCompare(() => new PluginResolver().resolve(resolutionInput(conflictPackages, ["zeta:plugin", "alpha:plugin"])));
    expect(reversedIssue).toEqual(issue);
  });

  it("rejects adjacent prerelease ranges with no SemVer precedence value between them", () => {
    const provider = packageAt("provider:plugin", "1.0.0", { namespace: "provider" });
    const offeredCore = { ...provider.compatibility, offered_capabilities: [{ capability: "provider:syntax", version_requirement: ">1.0.0-alpha" }] } as Record<string, unknown>;
    delete offeredCore["declaration_digest"];
    const offered = { ...provider, compatibility: { ...offeredCore, declaration_digest: registeredDigest("core:plugin_compatibility_declaration_digest", offeredCore) } } as unknown as InstalledPluginBundle;
    const consumer = packageAt("consumer:plugin", "1.0.0", { namespace: "consumer", dependencies: [{ plugin_id: "provider:plugin", namespace: "provider", version_requirement: "*", required_capabilities: ["provider:syntax@<1.0.0-alpha.0"] }] });
    expect(new (PluginResolver as any)(digestAuthority).resolve(resolutionInput([consumer, offered], ["consumer:plugin"])))
      .toMatchObject({ ok: false, issues: [{ code: "PLUGIN_CAPABILITY_UNAVAILABLE" }] });
  });

  it("fails closed when a supplied existing lock is unavailable or tampered", () => {
    const bundle = packageAt("acme:base", "1.0.0");
    const first = new PluginResolver().resolve(resolutionInput([bundle], ["acme:base"]));
    if (!first.ok) throw new Error("expected initial lock");
    const tampered = { ...first.lock, lock_digest: `sha256:${"0".repeat(64)}` };
    expect(new (PluginResolver as any)(digestAuthority).resolve({ ...resolutionInput([bundle], ["acme:base"]), existing_lock: tampered }))
      .toMatchObject({ ok: false, issues: [{ code: "PLUGIN_VERSION_CONFLICT" }] });
  });

  it.each([
    ["unbounded offer", "*", "provider:syntax@^2.0.0"],
    ["overlapping open intervals", ">1.0.0 <3.0.0", "provider:syntax@>2.0.0 <4.0.0"],
  ])("resolves capability contract requirements by interval intersection: %s", (_label, offered, required) => {
    const provider = packageAt("provider:plugin", "1.0.0", { namespace: "provider" });
    const providerCompatibilityCore = { ...provider.compatibility, offered_capabilities: [{ capability: "provider:syntax", version_requirement: offered }] } as Record<string, unknown>;
    delete providerCompatibilityCore["declaration_digest"];
    const authoritativeProvider = { ...provider, compatibility: { ...providerCompatibilityCore, declaration_digest: registeredDigest("core:plugin_compatibility_declaration_digest", providerCompatibilityCore) } } as unknown as InstalledPluginBundle;
    const consumer = packageAt("consumer:plugin", "1.0.0", { namespace: "consumer", dependencies: [{ plugin_id: "provider:plugin", namespace: "provider", version_requirement: "*", required_capabilities: [required] }] });

    const result = new PluginResolver().resolve(resolutionInput([consumer, authoritativeProvider], ["consumer:plugin"]));
    expect(result.ok).toBe(true);
  });

  it("preserves a complete supported existing lock when newer packages are installed", () => {
    const oldPackage = packageAt("acme:base", "1.0.0");
    const first = new PluginResolver().resolve(resolutionInput([oldPackage], ["acme:base"]));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected initial lock");
    const newerPackage = packageAt("acme:base", "2.0.0");

    const second = new PluginResolver().resolve({ ...resolutionInput([oldPackage, newerPackage], ["acme:base"]), existing_lock: first.lock });
    expect(second).toMatchObject({ ok: true, lock: first.lock, preserved_existing_lock: true });
  });

  it("falls through to fresh resolution (not existing_lock_invalid) when the locked package is no longer installed and only a newer version is", () => {
    const oldPackage = packageAt("acme:base", "1.0.0");
    const first = new PluginResolver().resolve(resolutionInput([oldPackage], ["acme:base"]));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected initial lock");
    const newerPackage = packageAt("acme:base", "2.0.0");

    const second = new PluginResolver().resolve({ ...resolutionInput([newerPackage], ["acme:base"]), existing_lock: first.lock });

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected a fresh, successful resolution");
    expect(second.preserved_existing_lock).toBeFalsy();
    expect(second.lock.resolved_plugins).toHaveLength(1);
    expect(second.lock.resolved_plugins[0]!.plugin_version).toBe("2.0.0");
    expect(second.lock).not.toEqual(first.lock);
  });

  it("falls through to fresh resolution (not existing_lock_invalid) when the locked package's analysis digest no longer matches an analyzer rebuild", () => {
    const before = packageAt("acme:base", "1.0.0", { package_digest: "fixed-bytes" });
    const initial = new PluginResolver().resolve(resolutionInput([before], ["acme:base"]));
    expect(initial.ok).toBe(true);
    if (!initial.ok) throw new Error("expected initial lock");

    // Same plugin id/version/package_digest (the package identity a rebuild
    // would still expose), but a different analyzer implementation --
    // `packageAt`'s `capabilities` option flows into the `analysis` object
    // (`analyzer_implementation_manifest`), so it changes `analysis_digest`
    // (and, since `analysis_digest` is itself committed to by
    // `declaration_digest`, that digest too) without touching `package_digest`.
    const rebuilt = packageAt("acme:base", "1.0.0", { package_digest: "fixed-bytes", capabilities: ["acme:new_capability"] });
    expect(rebuilt.compatibility.package_digest).toBe(before.compatibility.package_digest);
    expect(rebuilt.compatibility.analysis_digest).not.toBe(before.compatibility.analysis_digest);

    const result = new PluginResolver().resolve({ ...resolutionInput([rebuilt], ["acme:base"]), existing_lock: initial.lock });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a fresh, successful resolution");
    expect(result.preserved_existing_lock).toBeFalsy();
    expect(result.lock).not.toEqual(initial.lock);
  });

  it.each([
    ["unknown top-level field", (lock: SdkPluginResolutionLock) => ({ ...lock, unauthenticated_extension: "x" })],
    ["wrong excluded-field type", (lock: SdkPluginResolutionLock) => ({ ...lock, created_at: 42 })],
    ["unknown nested field", (lock: SdkPluginResolutionLock) => {
      const changed = { ...lock, resolved_plugins: [{ ...lock.resolved_plugins[0]!, unauthenticated_extension: "x" }] };
      return { ...changed, lock_digest: authoritativeLockDigest(changed as SdkPluginResolutionLock) };
    }],
  ])("rejects an existing authoritative lock with an %s", (_label, change) => {
    const candidate = packageAt("acme:base", "1.0.0");
    const initial = new PluginResolver().resolve(resolutionInput([candidate], ["acme:base"]));
    if (!initial.ok) throw new Error("expected initial lock");

    const result = new PluginResolver().resolve({ ...resolutionInput([candidate], ["acme:base"]), existing_lock: change(initial.lock) as SdkPluginResolutionLock });

    expect(result).toMatchObject({ ok: false, issues: [{ code: "PLUGIN_VERSION_CONFLICT", payload: { existing_lock_invalid: true } }] });
  });

  it("materializes an existing lock once and returns a deep-owned exact snapshot", () => {
    const candidate = packageAt("acme:base", "1.0.0");
    const initial = new PluginResolver().resolve(resolutionInput([candidate], ["acme:base"]));
    if (!initial.ok) throw new Error("expected initial lock");
    let reads = 0;
    const stateful = { ...initial.lock.resolved_plugins[0]! } as Record<string, unknown>;
    Object.defineProperty(stateful, "plugin_version", {
      enumerable: true,
      get: () => { reads += 1; return reads === 1 ? initial.lock.resolved_plugins[0]!.plugin_version : "9.9.9"; },
    });
    const foreign = { ...initial.lock, resolved_plugins: [stateful] } as unknown as SdkPluginResolutionLock;

    const result = new PluginResolver().resolve({ ...resolutionInput([candidate], ["acme:base"]), existing_lock: foreign });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected preserved lock");
    expect(result.lock).toEqual(initial.lock);
    expect(reads).toBe(1);
    expect(result.lock).not.toBe(foreign);
    expect(result.lock.resolved_plugins).not.toBe(foreign.resolved_plugins);
    expect(result.lock.resolved_plugins[0]).not.toBe(foreign.resolved_plugins[0]);
  });

  it("sanitizes a throwing existing-lock getter into a registered fail-closed issue", () => {
    const candidate = packageAt("acme:base", "1.0.0");
    const initial = new PluginResolver().resolve(resolutionInput([candidate], ["acme:base"]));
    if (!initial.ok) throw new Error("expected initial lock");
    const foreign = { ...initial.lock } as Record<string, unknown>;
    Object.defineProperty(foreign, "resolved_plugins", { enumerable: true, get: () => { throw new TypeError("foreign /private/lock"); } });

    expect(() => new PluginResolver().resolve({ ...resolutionInput([candidate], ["acme:base"]), existing_lock: foreign as unknown as SdkPluginResolutionLock }))
      .not.toThrow();
    expect(new PluginResolver().resolve({ ...resolutionInput([candidate], ["acme:base"]), existing_lock: foreign as unknown as SdkPluginResolutionLock }))
      .toMatchObject({ ok: false, issues: [{ code: "PLUGIN_VERSION_CONFLICT", payload: { existing_lock_invalid: true } }] });
  });

  it("rejects a correctly re-digested existing lock from another workspace", () => {
    const candidate = packageAt("acme:base", "1.0.0");
    const initial = new PluginResolver().resolve(resolutionInput([candidate], ["acme:base"]));
    if (!initial.ok) throw new Error("expected initial lock");
    const changed = { ...initial.lock, workspace_id: "workspace-other" };
    const existing_lock = { ...changed, lock_digest: authoritativeLockDigest(changed) };

    expect(new PluginResolver().resolve({ ...resolutionInput([candidate], ["acme:base"]), existing_lock }))
      .toMatchObject({ ok: false, issues: [{ code: "PLUGIN_VERSION_CONFLICT", payload: { existing_lock_invalid: true } }] });
  });

  it("rejects a correctly re-digested existing lock with a namespace collision", () => {
    const firstPackage = packageAt("one:plugin", "1.0.0", { namespace: "shared" });
    const secondPackage = packageAt("two:plugin", "1.0.0", { namespace: "shared" });
    const first = new PluginResolver().resolve(resolutionInput([firstPackage], ["one:plugin"]));
    const second = new PluginResolver().resolve(resolutionInput([secondPackage], ["two:plugin"]));
    if (!first.ok || !second.ok) throw new Error("expected individual locks");
    const changed = { ...first.lock, resolved_plugins: [first.lock.resolved_plugins[0]!, second.lock.resolved_plugins[0]!] };
    const existing_lock = { ...changed, lock_digest: authoritativeLockDigest(changed) };

    expect(new PluginResolver().resolve({ ...resolutionInput([firstPackage, secondPackage], ["one:plugin", "two:plugin"]), existing_lock }))
      .toMatchObject({ ok: false, issues: [{ code: "PLUGIN_VERSION_CONFLICT", payload: { existing_lock_invalid: true } }] });
  });

  it("reads a hostile resolved-plugins array length only once inside containment", () => {
    const candidate = packageAt("acme:base", "1.0.0");
    const initial = new PluginResolver().resolve(resolutionInput([candidate], ["acme:base"]));
    if (!initial.ok) throw new Error("expected initial lock");
    let lengthReads = 0;
    const resolvedPlugins = new Proxy([...initial.lock.resolved_plugins], {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          return lengthReads === 1 ? target.length : 0;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const existing_lock = { ...initial.lock, resolved_plugins: resolvedPlugins };

    const result = new PluginResolver().resolve({ ...resolutionInput([candidate], ["acme:base"]), existing_lock });

    expect(result).toMatchObject({ ok: true });
    expect(lengthReads).toBe(1);
  });

  it("emits only the exact authoritative lock and resolved-plugin fields", () => {
    const candidate = packageAt("acme:base", "1.0.0");
    const result = new PluginResolver().resolve(resolutionInput([candidate], ["acme:base"]));
    if (!result.ok) throw new Error("expected authoritative lock");

    expect(Object.keys(result.lock).sort()).toEqual(["created_at", "lock_digest", "resolution_lock_id", "resolved_plugins", "resolver_version", "workspace_id"]);
    expect(Object.keys(result.lock.resolved_plugins[0]!).sort()).toEqual([
      "analysis_configuration_digest", "analysis_digest", "contribution_digest", "declaration_digest", "effective_capabilities", "namespace",
      "package_digest", "plugin_contract_version", "plugin_id", "plugin_version", "registry_contract_version", "resolved_dependency_plugin_ids",
    ]);
  });

  it.each([
    ["plugin_id", "other:plugin"],
    ["plugin_version", "2.0.0"],
    ["namespace", "other"],
    ["package_digest", `sha256:${"1".repeat(64)}`],
    ["declaration_digest", `sha256:${"2".repeat(64)}`],
    ["contribution_digest", `sha256:${"3".repeat(64)}`],
    ["analysis_digest", `sha256:${"4".repeat(64)}`],
    ["analysis_configuration_digest", `sha256:${"5".repeat(64)}`],
    ["plugin_contract_version", "3"],
    ["registry_contract_version", "2"],
    ["resolved_dependency_plugin_ids", ["other:plugin"]],
    ["effective_capabilities", ["other:capability"]],
  ] as const)("rejects an existing lock with a mutated authoritative %s pin", (field, value) => {
    const candidate = packageAt("acme:base", "1.0.0");
    const initial = new PluginResolver().resolve(resolutionInput([candidate], ["acme:base"]));
    if (!initial.ok) throw new Error("expected authoritative lock");
    const pinned = initial.lock.resolved_plugins[0]!;
    const existing_lock = { ...initial.lock, resolved_plugins: [{ ...pinned, [field]: value }] };

    expect(new PluginResolver().resolve({ ...resolutionInput([candidate], ["acme:base"]), existing_lock }))
      .toMatchObject({ ok: false, issues: [{ code: "PLUGIN_VERSION_CONFLICT", payload: { existing_lock_invalid: true } }] });
  });

  it("keeps runtime build catalog coordinates outside the authoritative plugin lock", () => {
    const bundle = packageAt("acme:base", "1.0.0");
    const firstBuild = bundle.runtime_builds[0]!;
    const secondBuild = { ...firstBuild, runtime_component_build_id: "acme:runtime_build_two", implementation_digest: canonicalSha256("second implementation") };
    const candidate = { ...bundle, runtime_builds: [firstBuild, secondBuild] };
    const input = resolutionInput([candidate], ["acme:base"]);
    const result = new PluginResolver().resolve(input);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.lock.resolved_plugins[0]).not.toHaveProperty("runtime_component_build_id");
  });

  it("preserves an exact existing lock when only runtime build catalog order changes", () => {
    const bundle = packageAt("acme:base", "1.0.0");
    const firstBuild = bundle.runtime_builds[0]!;
    const secondBuild = { ...firstBuild, runtime_component_build_id: "acme:runtime_build_two", implementation_digest: canonicalSha256("second implementation") };
    const candidate = { ...bundle, runtime_builds: [firstBuild, secondBuild] };
    const initial = new PluginResolver().resolve(resolutionInput([candidate], ["acme:base"]));
    if (!initial.ok) throw new Error("expected initial lock");
    const reordered = { ...candidate, runtime_builds: [secondBuild, firstBuild] };
    const preserved = new PluginResolver().resolve({ ...resolutionInput([reordered], ["acme:base"]), existing_lock: initial.lock });
    expect(preserved).toMatchObject({ ok: true, lock: initial.lock });
  });

  it("treats equal exclusive capability bounds as an empty intersection", () => {
    const provider = packageAt("provider:plugin", "1.0.0", { namespace: "provider" });
    const offeredCore = { ...provider.compatibility, offered_capabilities: [{ capability: "provider:syntax", version_requirement: "1.0.0" }] } as Record<string, unknown>;
    delete offeredCore["declaration_digest"];
    const offered = { ...provider, compatibility: { ...offeredCore, declaration_digest: registeredDigest("core:plugin_compatibility_declaration_digest", offeredCore) } } as unknown as InstalledPluginBundle;
    const consumer = packageAt("consumer:plugin", "1.0.0", { namespace: "consumer", dependencies: [{ plugin_id: "provider:plugin", namespace: "provider", version_requirement: "*", required_capabilities: ["provider:syntax@>1.0.0"] }] });
    expect(new PluginResolver().resolve(resolutionInput([consumer, offered], ["consumer:plugin"]))).toMatchObject({ ok: false, issues: [{ code: "PLUGIN_CAPABILITY_UNAVAILABLE" }] });
  });

  it("uses registered compatibility codes and authoritative lock analysis identities", () => {
    const candidate = packageAt("acme:base", "1.0.0");
    const resolved = new PluginResolver().resolve(resolutionInput([candidate], ["acme:base"]));
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.lock.resolved_plugins[0]).toMatchObject({
      analysis_digest: expect.stringMatching(/^sha256:/u),
      analysis_configuration_digest: expect.stringMatching(/^sha256:/u),
      plugin_contract_version: expect.any(String),
      registry_contract_version: expect.any(String),
    });

    const missing = new PluginResolver().resolve(resolutionInput([], ["missing:plugin"]));
    expect(missing).toMatchObject({ ok: false, issues: [{ code: "PLUGIN_VERSION_CONFLICT" }] });
  });

  it("negotiates required capability contract versions against offered SemVer ranges", () => {
    const provider = packageAt("provider:plugin", "1.0.0", { namespace: "provider" });
    const consumer = packageAt("consumer:plugin", "1.0.0", { namespace: "consumer", dependencies: [{
      plugin_id: "provider:plugin",
      namespace: "provider",
      version_requirement: "*",
      required_capabilities: ["provider:syntax@^2.0.0"],
    }] });
    const authoritativeProvider = {
      ...provider,
      compatibility: {
        ...provider.compatibility,
        offered_capabilities: [{ capability: "provider:syntax", version_requirement: "1.5.0" }],
      },
    };

    const result = new PluginResolver().resolve(resolutionInput([consumer, authoritativeProvider as unknown as InstalledPluginBundle], ["consumer:plugin"]));
    expect(result).toMatchObject({ ok: false, issues: [{ code: "PLUGIN_CAPABILITY_UNAVAILABLE" }] });
  });

  it("parses SemVer 2.0.0 and compares stable, prerelease, and build precedence", () => {
    expect(parseSemVer("1.2.3-alpha.1+linux.7")).toMatchObject({ normalized: "1.2.3-alpha.1+linux.7", major: 1, minor: 2, patch: 3 });
    expect(compareSemVerPrecedence("1.2.3-alpha.1", "1.2.3")).toBeLessThan(0);
    expect(compareSemVerPrecedence("1.2.3+one", "1.2.3+two")).toBe(0);
    expect(() => parseSemVer("1.02.3")).toThrow("plugin-sdk:version_invalid");
    expect(() => parseSemVer("1.2.3-01")).toThrow("plugin-sdk:version_invalid");
  });

  it("compares alphanumeric SemVer prerelease identifiers by ASCII code units", () => {
    expect(compareSemVerPrecedence("1.0.0-A", "1.0.0-a")).toBeLessThan(0);
    expect(compareSemVerPrecedence("1.0.0-Z", "1.0.0-aa")).toBeLessThan(0);
  });

  it("normalizes interval alternatives and enforces inclusive, exclusive, and prerelease bounds", () => {
    const requirement = normalizeVersionRequirement({
      alternatives: [
        { minimum: "2.0.0", minimum_inclusive: true },
        { minimum: "1.0.0", minimum_inclusive: true, maximum: "1.9.0", maximum_inclusive: false },
        { minimum: "2.0.0", minimum_inclusive: true },
      ],
      allow_prerelease: false,
    });

    expect(requirement.alternatives).toEqual([
      { minimum: "1.0.0", minimum_inclusive: true, maximum: "1.9.0", maximum_inclusive: false },
      { minimum: "2.0.0", minimum_inclusive: true },
    ]);
    expect(satisfiesVersionRequirement("1.0.0", requirement)).toBe(true);
    expect(satisfiesVersionRequirement("1.9.0", requirement)).toBe(false);
    expect(satisfiesVersionRequirement("2.1.0-beta.1", requirement)).toBe(false);
    expect(() => normalizeVersionRequirement({ alternatives: [{ minimum_inclusive: true }], allow_prerelease: false })).toThrow("plugin-sdk:version_requirement_invalid");
    expect(() => normalizeVersionRequirement({ alternatives: [{ minimum: "2.0.0", maximum: "1.0.0" }], allow_prerelease: false })).toThrow("plugin-sdk:version_requirement_invalid");
    expect(() => normalizeVersionRequirement({ alternatives: [{ minimum: "1.0.0", maximum: "1.0.0", maximum_inclusive: false }], allow_prerelease: false })).toThrow("plugin-sdk:version_requirement_invalid");
  });

  it("resolves the highest stable version and requires a full-version plus digest pin for equal precedence", () => {
    const stable = packageAt("acme:base", "2.0.0");
    const prerelease = packageAt("acme:base", "3.0.0-beta.1");
    const buildOne = packageAt("acme:base", "2.0.0+one", { package_digest: "sha256:one" });
    const buildTwo = packageAt("acme:base", "2.0.0+two", { package_digest: "sha256:two" });
    const ambiguous = new PluginResolver().resolve(resolutionInput([stable, prerelease, buildOne, buildTwo], ["acme:base"]));
    expect(ambiguous).toMatchObject({ ok: false, issues: [{ code: "PLUGIN_VERSION_CONFLICT" }] });

    const pinnedInput = { ...resolutionInput([stable, prerelease, buildOne, buildTwo], ["acme:base"]), pins: [{ plugin_id: "acme:base", plugin_version: "2.0.0+two", package_digest: buildTwo.compatibility.package_digest }] };
    const pinned = new PluginResolver().resolve(pinnedInput);
    expect(pinned.ok).toBe(true);
    if (pinned.ok) expect(pinned.lock.resolved_plugins[0]?.plugin_version).toBe("2.0.0+two");
  });

  it("backtracks across the whole graph and writes only exact resolved coordinates", () => {
    const baseLow = packageAt("acme:base", "1.9.0");
    const baseHigh = packageAt("acme:base", "2.1.0");
    const bridge = packageAt("acme:bridge", "2.0.0", { namespace: "bridge", dependencies: [{
      plugin_id: "acme:base",
      namespace: "acme",
      version_requirement: "<2.0.0",
      required_capabilities: [],
    }] });
    const result = new PluginResolver().resolve(resolutionInput([baseLow, baseHigh, bridge], ["acme:base", "acme:bridge"]));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected resolution");
    expect(result.lock.resolved_plugins.map((entry) => [entry.plugin_id, entry.plugin_version])).toEqual([
      ["acme:base", "1.9.0"],
      ["acme:bridge", "2.0.0"],
    ]);
    expect(JSON.stringify(result.lock)).not.toContain("alternatives");
  });

  it("reports dependency cycles with the repeated endpoint and missing capabilities independently", () => {
    const a = packageAt("a:plugin", "1.0.0", { namespace: "a", dependencies: [{ plugin_id: "b:plugin", namespace: "b", version_requirement: "*", required_capabilities: [] }] });
    const b = packageAt("b:plugin", "1.0.0", { namespace: "b", dependencies: [{ plugin_id: "a:plugin", namespace: "a", version_requirement: "*", required_capabilities: [] }] });
    const cycle = new PluginResolver().resolve(resolutionInput([a, b], ["a:plugin"]));
    expect(cycle).toMatchObject({ ok: false, issues: [{ code: "PLUGIN_DEPENDENCY_CYCLE", payload: { repeated_endpoint: "a:plugin" } }] });

    const consumer = packageAt("c:consumer", "1.0.0", { namespace: "c", dependencies: [{ plugin_id: "d:provider", namespace: "d", version_requirement: "*", required_capabilities: ["d:syntax"] }] });
    const provider = packageAt("d:provider", "1.0.0", { namespace: "d", capabilities: ["d:semantic"] });
    const missing = new PluginResolver().resolve(resolutionInput([consumer, provider], ["c:consumer"]));
    expect(missing).toMatchObject({ ok: false, issues: [{ code: "PLUGIN_CAPABILITY_UNAVAILABLE" }] });
  });

  it("requires the selected dependency namespace to match its declaration", () => {
    const consumer = packageAt("consumer:plugin", "1.0.0", { namespace: "consumer", dependencies: [{
      plugin_id: "provider:plugin",
      namespace: "expected",
      version_requirement: "*",
      required_capabilities: [],
    }] });
    const provider = packageAt("provider:plugin", "1.0.0", { namespace: "wrong" });

    const result = new PluginResolver().resolve(resolutionInput([consumer, provider], ["consumer:plugin"]));

    expect(result).toMatchObject({ ok: false, issues: [{ code: "PLUGIN_NAMESPACE_CONFLICT" }] });
  });

  it("rejects namespace conflicts during resolve", () => {
    const result = new PluginResolver().resolve(resolutionInput([
      packageAt("one:plugin", "1.0.0", { namespace: "shared" }),
      packageAt("two:plugin", "1.0.0", { namespace: "shared" }),
    ], ["one:plugin", "two:plugin"]));
    expect(result).toMatchObject({ ok: false, issues: [{ code: "PLUGIN_NAMESPACE_CONFLICT" }] });
  });

  it("negotiates runtime and registry contracts independently and preserves supported existing lock contract pins", () => {
    const runtimeTwoRegistryOne = packageAt("acme:base", "1.0.0", { runtime_contract_version: 2, registry_contract_version: 1 });
    const input = resolutionInput([runtimeTwoRegistryOne], ["acme:base"]);
    const first = new PluginResolver().resolve(input);
    expect(first).toMatchObject({ ok: true, lock: { resolved_plugins: [{ plugin_contract_version: "2.0.0", registry_contract_version: "1.0.0" }] } });

    const supportedThree = packageAt("acme:base", "1.0.0", { runtime_contract_version: 3, registry_contract_version: 2 });
    const installed = new PluginResolver().resolve(resolutionInput([supportedThree], ["acme:base"]));
    if (!installed.ok) throw new Error("expected installed lock");
    const pinnedInput = { ...resolutionInput([supportedThree], ["acme:base"]), existing_lock: installed.lock };
    const pinned = new PluginResolver().resolve(pinnedInput);
    expect(pinned).toMatchObject({ ok: true, lock: { resolved_plugins: [{ plugin_contract_version: "3.0.0", registry_contract_version: "2.0.0" }] } });
  });

  it("excludes created_at from the deterministic lock digest", () => {
    const candidate = packageAt("acme:base", "1.0.0");
    const firstInput = resolutionInput([candidate], ["acme:base"]);
    const secondInput = { ...firstInput, clock: () => "2030-01-01T00:00:00Z" };
    const first = new PluginResolver().resolve(firstInput);
    const second = new PluginResolver().resolve(secondInput);
    expect(first.ok && second.ok ? first.lock.lock_digest : "failure").toBe(second.ok ? second.lock.lock_digest : "other failure");
  });
});

const languageOne = {
  language_id: "languages:one",
  definition_revision: 1,
  schema_version: 1,
  description: "Language one.",
  display_name: "Language One",
  aliases: ["shared", "one"],
  lifecycle_state: "active",
};

function withContribution(bundle: InstalledPluginBundle, changes: Partial<PluginRegistryContribution>): InstalledPluginBundle {
  const core = { ...bundle.contribution, ...changes } as Record<string, unknown>;
  delete core["contribution_digest"];
  return { ...bundle, contribution: { ...core, contribution_digest: digestAuthority.registry_contribution(core as unknown as PluginRegistryContribution) } as unknown as PluginRegistryContribution };
}

function authoritativeLockDigest(lock: Pick<SdkPluginResolutionLock, "resolution_lock_id" | "workspace_id" | "resolver_version" | "resolved_plugins">): string {
  return digestAuthority.resolution_lock({
    resolution_lock_id: lock.resolution_lock_id,
    workspace_id: lock.workspace_id,
    resolver_version: lock.resolver_version,
    resolved_plugins: lock.resolved_plugins,
  });
}

function assemblyInput(packages: readonly InstalledPluginBundle[]): RegistryAssemblyInput {
  const discovered = packages.map((bundle) => ({
    ...bundle,
    plugin_id: bundle.manifest.plugin_id,
    plugin_version: bundle.manifest.plugin_version,
    namespace: bundle.compatibility.namespace,
    package_digest: bundle.compatibility.package_digest,
    declaration_digest: bundle.compatibility.declaration_digest,
    contribution_digest: bundle.contribution.contribution_digest,
    analysis_configuration_digest: registeredDigest("core:analysis_configuration_digest", bundle.analysis_configuration),
  }));
  const lockCore = {
    resolution_lock_id: "lock-1",
    workspace_id: "workspace-1",
    resolver_version: "1.0.0",
    resolved_plugins: discovered.map((item) => ({
      plugin_id: item.plugin_id,
      plugin_version: item.plugin_version,
      namespace: item.namespace,
      package_digest: item.package_digest,
      declaration_digest: item.declaration_digest,
      contribution_digest: item.contribution.contribution_digest,
      analysis_digest: item.compatibility.analysis_digest,
      analysis_configuration_digest: item.analysis_configuration_digest,
      plugin_contract_version: "2.0.0",
      registry_contract_version: "1.0.0",
      resolved_dependency_plugin_ids: item.compatibility.dependencies.map((dependency) => dependency.plugin_id),
      effective_capabilities: item.compatibility.offered_capabilities.map((entry) => entry.capability),
    })),
  };
  const lock = {
    ...lockCore,
    lock_digest: authoritativeLockDigest(lockCore),
    created_at: "2026-08-09T12:00:00Z",
  } satisfies SdkPluginResolutionLock;
  return {
    packages: discovered,
    lock,
    registry_snapshot_id: "registry-1",
    core_registry_digest: "sha256:core",
    emission_valid_from_generation: "1",
    clock: () => "2026-08-09T12:00:00Z",
    id_source: () => "issue-1",
  };
}

describe("Phase 8 atomic plugin registry assembly", () => {
  it.each([
    ["skipped ordinal", [{ stage_id: "acme:stage-1", ordinal: 1, stage_count: 2, depends_on_stage_ids: [], capabilities: ["acme:syntax"] }, { stage_id: "acme:stage-2", ordinal: 3, stage_count: 2, depends_on_stage_ids: ["acme:stage-1"], capabilities: [] }]],
    ["duplicate capability", [{ stage_id: "acme:stage-1", ordinal: 1, stage_count: 2, depends_on_stage_ids: [], capabilities: ["acme:syntax"] }, { stage_id: "acme:stage-2", ordinal: 2, stage_count: 2, depends_on_stage_ids: ["acme:stage-1"], capabilities: ["acme:syntax"] }]],
    ["cyclic dependency", [{ stage_id: "acme:stage-1", ordinal: 1, stage_count: 2, depends_on_stage_ids: ["acme:stage-2"], capabilities: ["acme:syntax"] }, { stage_id: "acme:stage-2", ordinal: 2, stage_count: 2, depends_on_stage_ids: ["acme:stage-1"], capabilities: [] }]],
  ] as const)("rejects %s structural stage declarations", (_label, stages) => {
    const bundle = withContribution(packageAt("acme:plugin", "1.0.0"), { structural_stage_definitions: stages as unknown as NonNullable<PluginRegistryContribution["structural_stage_definitions"]> });
    expect(new PluginRegistryAssembler().assemble(assemblyInput([bundle]))).toMatchObject({ ok: false });
  });

  it("uses the authoritative metadata row for the emitted registry compatibility issue", () => {
    const input = assemblyInput([packageAt("acme:plugin", "1.0.0")]);
    const result = new PluginRegistryAssembler().assemble({ ...input, packages: [] });
    expect(result).toMatchObject({
      ok: false,
      issues: [{
        code: "REGISTRY_CONTRIBUTION_INVALID",
        phase: "registry_validation",
        severity: "error",
        required_action: "repair_registry_contribution",
        retryable: "false",
      }],
    });
  });

  it("keeps non-ASCII registry content and its digest correspondence independent of locale collation", () => {
    const alpha = withContribution(packageAt("alpha:plugin", "1.0.0", { namespace: "alpha" }), {
      digest_domain_definitions: [
        { digest_domain: "alpha:emoji", definition_revision: 1, schema_version: 1, description: "\u{1F600}", lifecycle_state: "active" },
        { digest_domain: "alpha:accent", definition_revision: 1, schema_version: 1, description: "\u00e9", lifecycle_state: "active" },
      ],
    } as Partial<PluginRegistryContribution>);
    const packages = [packageAt("zeta:plugin", "1.0.0", { namespace: "zeta" }), alpha];
    const assembled = new PluginRegistryAssembler().assemble(assemblyInput(packages));
    const reversed = withReversedLocaleCompare(() => new PluginRegistryAssembler().assemble(assemblyInput(packages)));

    expect(reversed).toEqual(assembled);
    expect(assembled).toMatchObject({ ok: true });
    if (!assembled.ok) throw new Error("expected registry");
    expect((assembled.registry.definitions["digest_domain_definitions"] as readonly { readonly description: string }[]).map((entry) => entry.description)).toEqual(["\u00e9", "\u{1F600}"]);
    expect(assembled.registry.registry_digest).toBe(digestAuthority.registry_snapshot({
      registry_snapshot_id: assembled.registry.registry_snapshot_id,
      registry_contract_version: assembled.registry.registry_contract_version,
      core_registry_digest: assembled.registry.core_registry_digest,
      resolution_lock_id: assembled.registry.resolution_lock_id,
      namespace_bindings: assembled.registry.namespace_bindings,
    }));
  });

  it("uses registered language-definition and registry-snapshot digest operations", () => {
    const calls: string[] = [];
    const languageDigest = `sha256:${"a".repeat(64)}`;
    const registryDigest = `sha256:${"b".repeat(64)}`;
    const authority = {
      ...digestAuthority,
      language_definition: () => { calls.push("language_definition"); return languageDigest; },
      registry_snapshot: () => { calls.push("registry_snapshot"); return registryDigest; },
    };
    const bundle = withContribution(packageAt("one:plugin", "1.0.0", { namespace: "one" }), { language_definitions: [languageOne] });

    const result = new (SdkPluginRegistryAssembler as any)(authority).assemble(assemblyInput([bundle]));

    expect(result).toMatchObject({ ok: true, registry: { registry_digest: registryDigest, languages: [{ definition_digest: languageDigest }] } });
    expect(calls).toEqual(["language_definition", "registry_snapshot"]);
  });

  it("fails closed when the registered registry digest authority returns a forged value", () => {
    const authority = { ...digestAuthority, registry_snapshot: () => "forged" };
    const result = new (SdkPluginRegistryAssembler as any)(authority).assemble(assemblyInput([packageAt("acme:plugin", "1.0.0")]));

    expect(result).toMatchObject({ ok: false, issues: [{ payload: { reason_code: "REGISTRY_DIGEST_INVALID" } }] });
    expect(result).not.toHaveProperty("registry");
  });

  it("rejects a registry input carrying a tampered authoritative lock digest", () => {
    const input = assemblyInput([packageAt("acme:plugin", "1.0.0")]);
    const result = new PluginRegistryAssembler().assemble({ ...input, lock: { ...input.lock, lock_digest: `sha256:${"0".repeat(64)}` } });
    expect(result).toMatchObject({ ok: false, issues: [{ payload: { reason_code: "LOCK_DIGEST_INVALID" } }] });
  });

  it.each([
    ["invented core digest domain", "1.0.0", "core:invented"],
    ["schema version alias", "1.9.0", "core:plugin_package"],
  ])("rejects %s at the authoritative reference boundary", (_label, schemaVersion, digestDomain) => {
    const bundle = packageAt("acme:plugin", "1.0.0");
    const invalid = withContribution(bundle, { digest_recipe_definitions: [{
      digest_recipe_id: "acme:recipe", definition_revision: 1, schema_version: 1, recipe_version: "1.0.0",
      target_schema_id: "core:Bytes", target_schema_version: schemaVersion, target_field: "digest", digest_domain: digestDomain,
      canonical_encoding_version: "1.0.0", hash_algorithm: "sha256", payload_schema_id: "core:Bytes", payload_schema_version: schemaVersion,
      payload_binding: "direct_value", plugin_owner: "acme:plugin", lifecycle_state: "active",
    }] });
    expect(new (PluginRegistryAssembler as any)(digestAuthority).assemble(assemblyInput([invalid])))
      .toMatchObject({ ok: false, issues: [{ payload: { reason_code: "DEFINITION_REFERENCE_INVALID" } }] });
  });

  it("rejects dangling cross-definition digest and schema references transactionally", () => {
    const bundle = packageAt("acme:plugin", "1.0.0");
    const dangling = withContribution(bundle, { digest_recipe_definitions: [{
      digest_recipe_id: "acme:recipe", definition_revision: 1, schema_version: 1, recipe_version: "1.0.0",
      target_schema_id: "acme:missing_schema", target_schema_version: "1.0.0", target_field: "digest",
      digest_domain: "acme:missing_domain", canonical_encoding_version: "1.0.0", hash_algorithm: "sha256",
      payload_schema_id: "acme:missing_payload", payload_schema_version: "1.0.0", payload_binding: "complete",
      plugin_owner: "acme:plugin", lifecycle_state: "active",
    }] });

    const result = new PluginRegistryAssembler().assemble(assemblyInput([dangling]));
    expect(result).toMatchObject({ ok: false, issues: [{ payload: { reason_code: "DEFINITION_REFERENCE_INVALID" } }] });
    expect(result).not.toHaveProperty("registry");
  });

  it("rejects unknown and malformed nested authoritative definition semantics atomically", () => {
    const bundle = packageAt("acme:plugin", "1.0.0");
    const malformed = withContribution(bundle, { digest_domain_definitions: [{
      digest_domain: "acme:digest",
      definition_revision: 1,
      schema_version: 1,
      description: "Digest.",
      lifecycle_state: "invented",
      unknown: true,
    }] } as unknown as Partial<PluginRegistryContribution>);

    const result = new PluginRegistryAssembler().assemble(assemblyInput([malformed]));
    expect(result).toMatchObject({ ok: false, issues: [{ code: "REGISTRY_CONTRIBUTION_INVALID", payload: { reason_code: "DEFINITION_SEMANTICS_INVALID" } }] });
    expect(result).not.toHaveProperty("registry");
  });

  it("rejects plugin-owned forbidden runtime component kinds", () => {
    const bundle = packageAt("acme:plugin", "1.0.0");
    const forbidden = withContribution(bundle, { runtime_component_definitions: [{
      component_id: "acme:embedding",
      definition_revision: 1,
      schema_version: 1,
      component_version: "1.0.0",
      component_contracts: [{ component_kind: "embedding_generator", contract_version: "1" }],
      description: "Forbidden plugin runtime kind.",
      behavior_digest: canonicalSha256("behavior"),
      plugin_owner: "acme:plugin",
      lifecycle_state: "active",
    }] });

    const result = new PluginRegistryAssembler().assemble(assemblyInput([forbidden]));
    expect(result).toMatchObject({ ok: false, issues: [{ payload: { reason_code: "RUNTIME_COMPONENT_KIND_FORBIDDEN" } }] });
  });

  it("requires an exact lock/package bijection before registry assembly", () => {
    const input = assemblyInput([packageAt("acme:plugin", "1.0.0")]);

    const result = new PluginRegistryAssembler().assemble({ ...input, packages: [] });

    expect(result).toMatchObject({ ok: false, issues: [{ payload: { reason_code: "LOCK_PACKAGE_SET_MISMATCH" } }] });
    expect(result).not.toHaveProperty("registry");
  });

  it.each([
    ["namespace", "other"],
    ["declaration_digest", canonicalSha256("other-declaration")],
    ["contribution_digest", canonicalSha256("other-contribution")],
    ["analysis_digest", canonicalSha256("other-analysis")],
    ["analysis_configuration_digest", canonicalSha256("other-configuration")],
    ["plugin_contract_version", "3.0.0"],
    ["registry_contract_version", "2.0.0"],
  ] as const)("rejects a mismatched lock-pinned %s", (field, value) => {
    const input = assemblyInput([packageAt("acme:plugin", "1.0.0")]);
    const pinned = input.lock.resolved_plugins[0]!;
    const changed = { ...input.lock, resolved_plugins: [{ ...pinned, [field]: value }] };
    const lock = { ...changed, lock_digest: authoritativeLockDigest(changed) };

    const result = new PluginRegistryAssembler().assemble({ ...input, lock });

    expect(result).toMatchObject({ ok: false, issues: [{ payload: { reason_code: "LOCK_PACKAGE_PIN_MISMATCH" } }] });
  });

  it("rejects two selected plugin IDs claiming one namespace atomically", () => {
    const result = new PluginRegistryAssembler().assemble(assemblyInput([
      packageAt("one:plugin", "1.0.0", { namespace: "shared" }),
      packageAt("two:plugin", "1.0.0", { namespace: "shared" }),
    ]));
    expect(result).toMatchObject({ ok: false, issues: [{ code: "REGISTRY_CONTRIBUTION_INVALID", payload: { reason_code: "NAMESPACE_CONFLICT" } }] });
    expect(result).not.toHaveProperty("registry");
  });

  it.each([
    ["outside its owner namespace", packageAt("acme:plugin", "1.0.0"), { canonical_schema_definitions: [{ schema_id: "other:schema", definition_revision: 1 }] }],
    ["in the reserved core namespace", packageAt("acme:plugin", "1.0.0"), { canonical_schema_definitions: [{ schema_id: "core:schema", definition_revision: 1 }] }],
  ])("rejects a contribution definition %s", (_label, bundle, changes) => {
    const result = new PluginRegistryAssembler().assemble(assemblyInput([withContribution(bundle, changes as unknown as Partial<PluginRegistryContribution>)]));
    expect(result).toMatchObject({ ok: false, issues: [{ code: "REGISTRY_CONTRIBUTION_INVALID", payload: { reason_code: "DEFINITION_NAMESPACE_INVALID" } }] });
  });

  it("rejects duplicate definition coordinates with different bytes", () => {
    const bundle = packageAt("acme:plugin", "1.0.0");
    const result = new PluginRegistryAssembler().assemble(assemblyInput([withContribution(bundle, {
      digest_domain_definitions: [
        { digest_domain: "acme:digest", definition_revision: 1, schema_version: 1, description: "one", lifecycle_state: "active" },
        { digest_domain: "acme:digest", definition_revision: 1, schema_version: 1, description: "two", lifecycle_state: "active" },
      ],
    } as unknown as Partial<PluginRegistryContribution>)]));
    expect(result).toMatchObject({ ok: false, issues: [{ payload: { reason_code: "DEFINITION_COORDINATE_CONFLICT" } }] });
  });

  it("rejects missing mandatory dependency references in a contribution", () => {
    const bundle = packageAt("acme:plugin", "1.0.0");
    const result = new PluginRegistryAssembler().assemble(assemblyInput([withContribution(bundle, {
      dependencies: [{ plugin_id: "missing:plugin", namespace: "missing", version_requirement: "1.0.0", required_capabilities: [] }],
    })]));
    expect(result).toMatchObject({ ok: false, issues: [{ payload: { reason_code: "MANDATORY_DEPENDENCY_MISSING" } }] });
  });

  it("rejects conflicting runtime component behavior digests", () => {
    const bundle = packageAt("acme:plugin", "1.0.0");
    const result = new PluginRegistryAssembler().assemble(assemblyInput([withContribution(bundle, {
      runtime_component_definitions: [
        { component_id: "acme:runtime", definition_revision: 1, schema_version: 1, component_version: "1.0.0", component_contracts: [{ component_kind: "source_provider", contract_version: "2" }], description: "Runtime.", behavior_digest: canonicalSha256("one"), plugin_owner: "acme:plugin", lifecycle_state: "active" },
        { component_id: "acme:runtime", definition_revision: 1, schema_version: 1, component_version: "1.0.0", component_contracts: [{ component_kind: "source_provider", contract_version: "2" }], description: "Runtime.", behavior_digest: canonicalSha256("two"), plugin_owner: "acme:plugin", lifecycle_state: "active" },
      ],
    } as unknown as Partial<PluginRegistryContribution>)]));
    expect(result).toMatchObject({ ok: false, issues: [{ payload: { reason_code: "RUNTIME_COMPONENT_BEHAVIOR_CONFLICT" } }] });
  });

  it("deduplicates byte-identical language definitions and retains all supplier associations", () => {
    const first = withContribution(packageAt("one:plugin", "1.0.0", { namespace: "one" }), { language_definitions: [languageOne] });
    const second = withContribution(packageAt("two:plugin", "1.0.0", { namespace: "two" }), { language_definitions: [{ ...languageOne, aliases: ["shared", "one"] }] });
    const result = new PluginRegistryAssembler().assemble(assemblyInput([first, second]));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected registry");
    expect(result.registry.languages).toHaveLength(1);
    expect(result.registry.languages[0]?.suppliers.map((supplier) => supplier.plugin_id)).toEqual(["one:plugin", "two:plugin"]);
    expect(result.registry.languages[0]?.definition_digest).toMatch(/^sha256:/u);
  });

  it.each([
    ["alias", { aliases: ["different"] }],
    ["lifecycle", { lifecycle_state: "deprecated", deprecated_since: "1.0.0" }],
    ["replacement", { replacement_language_id: "languages:two" }],
    ["bytes", { description: "Different bytes." }],
  ])("rejects a shared language %s difference as a language definition conflict", (_kind, difference) => {
    const first = withContribution(packageAt("one:plugin", "1.0.0", { namespace: "one" }), { language_definitions: [languageOne] });
    const second = withContribution(packageAt("two:plugin", "1.0.0", { namespace: "two" }), { language_definitions: [{ ...languageOne, ...difference }] });
    const result = new PluginRegistryAssembler().assemble(assemblyInput([first, second]));
    expect(result).toMatchObject({ ok: false, issues: [{ code: "REGISTRY_CONTRIBUTION_INVALID", payload: { reason_code: "LANGUAGE_DEFINITION_CONFLICT" } }] });
  });

  it("returns every canonical language ID for an ambiguous alias while exact lookup rejects the alias", () => {
    const languageTwo = { ...languageOne, language_id: "languages:two", display_name: "Language Two", aliases: ["shared", "two"] };
    const first = withContribution(packageAt("one:plugin", "1.0.0", { namespace: "one" }), { language_definitions: [languageOne] });
    const second = withContribution(packageAt("two:plugin", "1.0.0", { namespace: "two" }), { language_definitions: [languageTwo] });
    const assembler = new PluginRegistryAssembler();
    const result = assembler.assemble(assemblyInput([first, second]));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected registry");
    expect(assembler.findLanguagesByAlias(result.registry, "SHARED").map((item) => item.definition.language_id)).toEqual(["languages:one", "languages:two"]);
    expect(assembler.getLanguage(result.registry, "shared")).toBeUndefined();
    expect(assembler.getLanguage(result.registry, "languages:one")?.definition.display_name).toBe("Language One");
  });
});
