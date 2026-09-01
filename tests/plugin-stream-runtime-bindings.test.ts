import { describe, expect, it } from "vitest";

import {
  canonicalSchemaRegistry,
  decision25DigestRecipeRegistry,
  generateJsonSchema,
  runtimeComponentImplementationManifestSchemaV2,
  validateRuntimeComponentImplementationManifestV2,
} from "@urdira/contracts";
import {
  canonicalSha256,
  parseVersionRequirementText,
  PluginPackageDiscovery,
  PluginResolver,
  sha256Bytes,
  pluginRuntimeExecutableBindingDigest,
  runtimeComponentImplementationManifestV2Digest,
  validatePluginRuntimeExecutableBinding,
} from "@urdira/plugin-sdk";
import { createCanonicalPluginDigestAuthority } from "../packages/engine/src/plugin-digest-authority.js";
import {
  createJavascriptTypescriptInstalledBundle,
  durableAnalysisCacheKey,
  JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
} from "../packages/plugin-javascript-typescript/src/index.js";

const digest = (value: unknown): string => canonicalSha256(value);

describe("Decision 25 runtime executable contracts", () => {
  it("registers the preserved v1 schema plus the versioned v2 implementation and binding recipes", () => {
    expect(canonicalSchemaRegistry.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "core:RuntimeComponentImplementationManifest@1",
      "core:RuntimeComponentImplementationManifest@2",
      "core:PluginRuntimeExecutableBinding@1",
    ]));
    expect(decision25DigestRecipeRegistry).toEqual(expect.arrayContaining([
      expect.objectContaining({ digest_recipe_id: "core:runtime_component_implementation_digest", recipe_version: 2, payload_schema_id: "core:RuntimeComponentImplementationManifest", payload_schema_version: 2 }),
      expect.objectContaining({ digest_recipe_id: "core:plugin_runtime_executable_binding_digest", recipe_version: 1, payload_schema_id: "core:PluginRuntimeExecutableBinding", payload_schema_version: 1 }),
    ]));
    const authority = createCanonicalPluginDigestAuthority();
    expect(authority.has_core_digest_domain("core:plugin_runtime_executable_binding")).toBe(true);
    expect(authority.has_core_digest_recipe("core:runtime_component_implementation_digest", "2")).toBe(true);
    expect(authority.has_core_digest_recipe("core:plugin_runtime_executable_binding_digest", "1")).toBe(true);
  });

  it("accepts one registered target and exact entrypoint asset with digest coverage", () => {
    const digests = createCanonicalPluginDigestAuthority();
    expect(generateJsonSchema(runtimeComponentImplementationManifestSchemaV2).properties?.["runtimeTargetId"]?.enum)
      .toContain("x86_64-unknown-linux-gnu");
    const manifest = {
      runtime_component_build_id: "build:jsts-rust-linux-x64",
      component_id: "jsts:rust_syntax_worker",
      component_version: "1.0.0",
      behavior_digest: digest("behavior"),
      runtime_target_id: "x86_64-unknown-linux-gnu",
      entrypoint_asset_digest: digest("entrypoint"),
      executable_asset_digests: [digest("entrypoint")],
      native_asset_digests: [],
      dependency_asset_digests: [digest("dependency")],
    };
    expect(validateRuntimeComponentImplementationManifestV2(manifest)).toEqual(manifest);
    expect(runtimeComponentImplementationManifestV2Digest(manifest, digests)).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const bindingBase = {
      plugin_id: "urdira:javascript_typescript",
      plugin_version: "1.0.0",
      runtime_target_id: manifest.runtime_target_id,
      runtime_contract_version: 2,
      runtime_component_build_id: manifest.runtime_component_build_id,
      implementation_digest: runtimeComponentImplementationManifestV2Digest(manifest, digests),
      package_digest: digest("package"),
      entrypoint_asset_digest: manifest.entrypoint_asset_digest,
    };
    const binding = { ...bindingBase, binding_digest: pluginRuntimeExecutableBindingDigest(bindingBase, digests) };
    expect(validatePluginRuntimeExecutableBinding(binding, digests)).toEqual(binding);
  });

  it("preserves v1 while rejecting unknown targets, non-entrypoint assets, and binding digest drift", () => {
    const digests = createCanonicalPluginDigestAuthority();
    const v1 = {
      runtime_component_build_id: "build:v1",
      component_id: "test:runtime",
      component_version: "1.0.0",
      behavior_digest: digest("behavior"),
      target_triple: "test",
      executable_asset_digests: [digest("v1-entrypoint")],
      native_asset_digests: [],
      dependency_asset_digests: [],
    };
    expect(v1).not.toHaveProperty("schema_version");

    const v2 = {
      runtime_component_build_id: "build:v2",
      component_id: "test:runtime",
      component_version: "2.0.0",
      behavior_digest: digest("behavior-v2"),
      runtime_target_id: "x86_64-unknown-linux-gnu",
      entrypoint_asset_digest: digest("missing-entrypoint"),
      executable_asset_digests: [digest("different-executable")],
      native_asset_digests: [],
      dependency_asset_digests: [],
    };
    expect(() => validateRuntimeComponentImplementationManifestV2(v2)).toThrow(/entrypoint/i);
    expect(() => validateRuntimeComponentImplementationManifestV2({ ...v2, runtime_target_id: "unregistered-target", entrypoint_asset_digest: v2.executable_asset_digests[0] }))
      .toThrow(/target/i);

    const binding = {
      plugin_id: "plugin:test",
      plugin_version: "1.0.0",
      runtime_target_id: "x86_64-unknown-linux-gnu",
      runtime_contract_version: 2,
      runtime_component_build_id: "build:v2",
      implementation_digest: digest("implementation"),
      package_digest: digest("package"),
      entrypoint_asset_digest: digest("entrypoint"),
      binding_digest: digest("wrong"),
    };
    expect(() => validatePluginRuntimeExecutableBinding(binding, digests)).toThrow(/digest/i);
  });

  it("derives one native JS/TS candidate binding from addon and worker bytes and carries it through the lock", async () => {
    const encoder = new TextEncoder();
    const addon = encoder.encode("native-addon:v1");
    const worker = encoder.encode("native-worker:v1");
    const semanticWorker = encoder.encode("semantic-process-worker:v1");
    const dependency = encoder.encode('{"name":"typescript","version":"7.0.2"}');
    const assetDigest = (bytes: Uint8Array): string => sha256Bytes(bytes);
    const digests = createCanonicalPluginDigestAuthority();
    const bundle = createJavascriptTypescriptInstalledBundle({
      digests,
      package_locator: "bundled:jsts-native",
      assets: [
        { normalized_relative_path: "dist/semantic-process-worker.js", bytes: semanticWorker, executable: true, role: "parser" },
        { normalized_relative_path: "node_modules/typescript/package.json", bytes: dependency, executable: false, role: "dependency" },
      ],
      native_runtime: {
        runtime_target_id: "aarch64-apple-darwin",
        runtime_component_build_id: digest({ target: "aarch64-apple-darwin", addon: assetDigest(addon), worker: assetDigest(worker) }),
        addon: { normalized_relative_path: "native/urdira-native.node", bytes: addon },
        worker: { normalized_relative_path: "native/urdira-jsts-syntax-worker", bytes: worker },
      },
    });
    const binding = bundle.runtime_executable_binding;
    expect(binding).toBeDefined();
    expect(binding).toMatchObject({
      plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
      runtime_target_id: "aarch64-apple-darwin",
      runtime_contract_version: 2,
      runtime_component_build_id: bundle.runtime_implementation_manifests_v2?.[0]?.runtime_component_build_id,
      entrypoint_asset_digest: assetDigest(worker),
    });
    expect(bundle.runtime_implementation_manifests_v2?.[0]).toMatchObject({
      entrypoint_asset_digest: assetDigest(worker),
      executable_asset_digests: [assetDigest(semanticWorker), assetDigest(worker)],
      native_asset_digests: [assetDigest(addon)],
      dependency_asset_digests: [assetDigest(dependency)],
    });
    if (binding === undefined) throw new Error("expected native executable binding");
    const { binding_digest: _bindingDigest, ...bindingPayload } = binding;
    expect(binding.binding_digest).toBe(digests.runtime_executable_binding?.(bindingPayload));

    const bytesByPath = new Map([
      ["dist/semantic-process-worker.js", semanticWorker],
      ["node_modules/typescript/package.json", dependency],
      ["native/urdira-native.node", addon],
      ["native/urdira-jsts-syntax-worker", worker],
    ]);
    const discovery = await new PluginPackageDiscovery({
      list: async () => [bundle],
      read_file: async (request) => {
        const bytes = bytesByPath.get(request.normalized_relative_path);
        if (bytes === undefined) throw new Error("missing fixture asset");
        return { bytes, byte_length: bytes.byteLength };
      },
    }, digests, { max_file_bytes: 1_000_000 }, { max_items: 100, max_depth: 20, max_nodes: 10_000, max_bytes: 2_000_000 }).discover(["bundled"]);
    const resolved = new PluginResolver(digests).resolve({
      packages: discovery.packages,
      requirements: [{ plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, version_requirement: parseVersionRequirementText("*") }],
      pins: [],
      supported_runtime_contract_versions: [2],
      supported_registry_contract_versions: [1],
      workspace_id: "workspace:native-binding",
      resolver_version: "1.0.0",
      clock: () => "2026-08-28T00:00:00.000Z",
      id_source: () => "lock:native-binding",
    });
    expect(resolved).toMatchObject({ ok: true, lock: { resolved_plugins: [{ runtime_executable_binding: binding }] } });
    const tamperedPackage = { ...discovery.packages[0]!, runtime_executable_binding: { ...binding, binding_digest: digest("tampered-binding") } };
    expect(new PluginResolver(digests).resolve({
      packages: [tamperedPackage],
      requirements: [{ plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, version_requirement: parseVersionRequirementText("*") }],
      pins: [], supported_runtime_contract_versions: [2], supported_registry_contract_versions: [1],
      workspace_id: "workspace:native-binding", resolver_version: "1.0.0", clock: () => "2026-08-28T00:00:00.000Z", id_source: () => "issue:native-binding",
    })).toMatchObject({ ok: false, issues: [{ payload: { runtime_executable_binding_invalid: true } }] });
  });

  it("separates durable cache entries by the exact executable binding digest", () => {
    const common = { analysis_digest: digest("analysis"), analysis_configuration_digest: digest("configuration") };
    expect(durableAnalysisCacheKey("source-key", { ...common, runtime_executable_binding_digest: digest("binding-a") }))
      .not.toBe(durableAnalysisCacheKey("source-key", { ...common, runtime_executable_binding_digest: digest("binding-b") }));
  });
});
