import { describe, expect, it } from "vitest";
import {
  createJavascriptTypescriptWorker,
  createJavascriptTypescriptInstalledBundle,
  JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
  JAVASCRIPT_TYPESCRIPT_VERSION,
  JAVASCRIPT_TYPESCRIPT_RECORD_KINDS,
} from "../packages/plugin-javascript-typescript/src/index.js";
import {
  PluginPackageDiscovery,
  PluginRegistryAssembler,
  PluginResolver,
  canonicalSha256,
  parseVersionRequirementText,
} from "@urdira/plugin-sdk";
import { createCanonicalPluginDigestAuthority } from "../packages/engine/src/index.js";

/**
 * F-fix (v3 `record_occurrences.record_id` collision investigation, plan
 * `generic-waddling-hartmanis.md` §3, 2026-09-07): this frente's brief
 * hypothesized that two overload signatures reusing the same parameter
 * name (or an interface method overload, or a getter/setter pair) would
 * collide on the SAME parameter `identity_key`, because v3's identity was
 * assumed to derive from `parent qualified_name + parameter name` alone,
 * independent of position.
 *
 * This test drives the SAME production worker call the real v3 pipeline
 * uses (`analyze_artifact` through `createJavascriptTypescriptWorker`)
 * over exactly that adversarial fixture -- two `function f` overload
 * signatures plus the implementation, two `interface I { m }` overload
 * signatures, a `class C` getter/setter pair, and two `declare module`
 * `function g` overload signatures, all reusing a parameter name under the
 * same (or an equivalent-looking) parent -- and asserts every one of the
 * resulting `jsts:entity_parameter` records gets its OWN `identity_key`.
 *
 * RESULT: the hypothesis is disproved. `identity_key` for a parameter is
 * `fact.entity_id` (`crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`
 * `ParameterDeclarationFact`/`declaration_id(DeclKind::Parameter, path,
 * ident.span.start, name)`), which already keys on the parameter binding
 * identifier's own byte OFFSET -- distinct for every declaration in this
 * fixture, since no two of these seven parameters share a textual
 * position. The Rust unit test `overload_and_accessor_parameters_of_the_
 * same_name_never_collide` (`semantic_sites.rs`) independently confirms
 * this at the Rust layer with the identical fixture.
 *
 * The REAL cause of the `UNIQUE constraint failed: record_occurrences.
 * record_id` crash this frente was chasing is unrelated to parameters
 * entirely: `jsts:external_module:*`/`jsts:external_symbol:*` entities are
 * proposed identically by every importing file, and the v3 SQL
 * "direct publication" cold-scan path used to insert every staged row with
 * no `ON CONFLICT` clause. See `tests/v3-external-module-record-id-
 * collision.test.ts` for that regression's own coverage.
 */

const now = "2026-09-07T00:00:00.000Z";
const encoder = new TextEncoder();

const OVERLOAD_AND_ACCESSOR_FIXTURE = `
function f(a: string): void;
function f(a: number): void;
function f(a: any) {}

interface I {
  m(x: string): void;
  m(x: number): void;
}

class C {
  get v(): string { return ""; }
  set v(value: string) {}
}

declare module "mymod" {
  function g(p: string): void;
  function g(p: number): void;
}
`;

async function prepareRegistry(workspaceId: string) {
  const digestsAuthority = createCanonicalPluginDigestAuthority();
  const assets = [
    { normalized_relative_path: "dist/worker.mjs", bytes: encoder.encode("urdira production jsts worker"), executable: true, role: "parser" as const },
    { normalized_relative_path: "node_modules/typescript/package.json", bytes: encoder.encode('{"name":"typescript","version":"7.0.2"}'), executable: false, role: "dependency" as const },
  ];
  const bundle = createJavascriptTypescriptInstalledBundle({ digests: digestsAuthority, package_locator: "bundled:jsts", target_triple: "test-node", assets });
  const bytesByPath = new Map(assets.map((asset) => [asset.normalized_relative_path, asset.bytes]));
  const discovery = await new PluginPackageDiscovery({
    list: async () => [bundle],
    read_file: async (request) => {
      const bytes = bytesByPath.get(request.normalized_relative_path);
      if (bytes === undefined) throw new Error("missing bundle asset");
      return { bytes, byte_length: bytes.byteLength };
    },
  }, digestsAuthority, { max_file_bytes: 1_000_000 }, { max_items: 100, max_depth: 20, max_nodes: 10_000, max_bytes: 2_000_000 }).discover(["bundled"]);
  const resolved = new PluginResolver(digestsAuthority).resolve({
    packages: discovery.packages,
    requirements: [{ plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, version_requirement: parseVersionRequirementText("*") }],
    pins: [],
    supported_runtime_contract_versions: [1],
    supported_registry_contract_versions: [1],
    workspace_id: workspaceId,
    resolver_version: "1.0.0",
    clock: () => now,
    id_source: () => `lock:${workspaceId}`,
  });
  if (!resolved.ok) throw new Error(`plugin resolution failed: ${JSON.stringify(resolved.issues)}`);
  const assembled = new PluginRegistryAssembler(digestsAuthority).assemble({
    packages: resolved.packages,
    lock: resolved.lock,
    registry_snapshot_id: `registry:${workspaceId}`,
    core_registry_digest: canonicalSha256("core-registry"),
    emission_valid_from_generation: "1",
    clock: () => now,
    id_source: () => `registry-issue:${workspaceId}`,
  });
  if (!assembled.ok) throw new Error(`registry assembly failed: ${JSON.stringify(assembled.issues)}`);
  return { registry: assembled.registry, lock: resolved.lock, plugin: resolved.packages[0]! };
}

describe("v3 parameter identity: overloads and accessors never collide", () => {
  it("assigns every overload/accessor parameter its own identity_key (disproves the overload-collision hypothesis)", async () => {
    const workspaceId = "workspace:ffix-overload-repro";
    const prepared = await prepareRegistry(workspaceId);
    const files = [{
      path: "src/index.ts",
      text: OVERLOAD_AND_ACCESSOR_FIXTURE,
      artifact_id: "artifact:a",
      artifact_version_id: "version:a",
      content_hash: canonicalSha256(OVERLOAD_AND_ACCESSOR_FIXTURE),
    }];
    const worker = createJavascriptTypescriptWorker({
      compatibility_declaration_digest: prepared.plugin.compatibility.declaration_digest,
      registry_contribution_digest: prepared.plugin.contribution.contribution_digest,
      analysis_digest: prepared.plugin.compatibility.analysis_digest,
      analysis_configuration_digest: prepared.plugin.analysis_configuration_digest,
    });
    try {
      const owner = files[0]!;
      const workItemId = `work:${owner.artifact_id}`;
      const contextDigest = canonicalSha256({ registry: prepared.registry.registry_digest, owner: owner.artifact_version_id, inputs: files });
      const scope = {
        replacement_scope_id: `scope:${owner.artifact_id}`, owner_artifact_id: owner.artifact_id, owner_artifact_version_id: owner.artifact_version_id,
        capability: "core:call_relationships", record_categories: ["diagnostic", "entity", "relation"], record_kinds: [...JAVASCRIPT_TYPESCRIPT_RECORD_KINDS],
        base_record_set_digest: canonicalSha256([]), output_completeness: "accept_reported",
      };
      const workItem = {
        work_item_id: workItemId, workspace_id: workspaceId, artifact_id: owner.artifact_id, target_artifact_version_id: owner.artifact_version_id,
        operation: "full", plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, plugin_version: JAVASCRIPT_TYPESCRIPT_VERSION,
        capabilities: ["core:call_relationships"], expected_replacement_scopes: [scope], reason_codes: ["core:artifact_changed"], cause_references: [],
        analysis_context_digest: contextDigest, work_item_digest: canonicalSha256({ workItemId, contextDigest }), candidate_generation_id: "candidate:1",
      };
      const manifest = {
        plugin_input_access_manifest_id: "manifest:1",
        request_id: `request:${workItemId}`,
        analysis_view_digest: contextDigest,
        artifact_version_entries: files.map((file) => ({ artifact_id: file.artifact_id, artifact_version_id: file.artifact_version_id, content_hash: file.content_hash, access_modes: ["artifact_read"] })),
        record_entries: [], lookup_entries: [], transitive_artifact_version_ids: [],
        manifest_digest: "digest:1",
      };
      const analysisInputDigest = canonicalSha256({ owner: owner.path, inputs: manifest.artifact_version_entries });
      const response = (await worker.invoke({
        protocol_version: "1.0.0", request_id: manifest.request_id, request_digest: analysisInputDigest, call: "analyze_artifact", deadline: "2030-01-01T00:00:00.000Z", cancellation_id: `cancel:${workItemId}`,
        payload: { files, root_names: [owner.path], owner_path: owner.path, work_item: workItem, accepted_manifest: manifest, analysis_digest: prepared.plugin.compatibility.analysis_digest, analysis_configuration_digest: prepared.plugin.analysis_configuration_digest, analysis_input_digest: analysisInputDigest, created_at: now },
      })) as { readonly payload: { readonly validation_input: { readonly raw_delta: { readonly proposed_records: readonly { readonly category: string; readonly kind: string; readonly identity_key: string; readonly body: Record<string, unknown> }[] } } } };
      const records = response.payload.validation_input.raw_delta.proposed_records;
      const paramRecords = records.filter((record) => record.kind === "jsts:entity_parameter");
      const identityKeys = paramRecords.map((record) => record.identity_key);
      // Seven identifier-pattern parameters: the two `f` overload signatures'
      // own `a` plus the implementation's own `a` (three), the two `I.m`
      // overload signatures' own `x` (two), the setter's own `value` (one),
      // and the two `declare module` `g` overload signatures' own `p` (two).
      // The getter contributes no parameter.
      expect(paramRecords.length).toBe(8);
      expect(new Set(identityKeys).size).toBe(identityKeys.length);
    } finally {
      await worker.terminate();
    }
  }, 30_000);
});
