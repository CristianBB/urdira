import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestBytes } from "@urdira/canonical";
import {
  AdministrativeModelPackDownloader,
  InMemoryStagingStore,
  PluginPackageLifecycleManager,
  checkIpcPeerPermissions,
  classifySecret,
  ensureOwnerOnlyDirectory,
  evaluateInclusion,
  inspectInclusionPath,
  inspectModelPack,
  inspectPluginPackage,
  inspectStorageRoot,
  mergeConfiguration,
  normalizeWorkspacePath,
  parseConfigurationLayer,
  redactSnippet,
  resolveSafePath,
  assertAllowedExternalRoot,
  safeLogEvent,
} from "@urdira/security";

describe("Phase 6 security contracts", () => {
  it("narrows configuration authority across the precedence chain", () => {
    const result = mergeConfiguration(
      {
        installation: { allow_network: false, max_response_items: 100, allowed_external_roots: [] },
        user: { max_response_items: 50 },
        workspace: { allow_network: true, max_response_items: 200, allowed_external_roots: ["/outside"] },
        request: { max_response_items: 10 },
      },
      { allow_network: false, max_response_items: 100, allowed_external_roots: [] },
    );

    expect(result.effective.max_response_items).toBe(10);
    expect(result.effective.allow_network).toBe(false);
    expect(result.effective.allowed_external_roots).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toContain("security:configuration_authority_narrowed");
  });

  it("allows installation policy to establish authority while lower layers only narrow it", () => {
    const result = mergeConfiguration(
      { workspace: { allow_network: false, max_response_items: 25, allowed_external_roots: [] }, request: { max_response_items: 5 } },
      { allow_network: true, max_response_items: 100, allowed_external_roots: ["/outside"] },
    );
    expect(result.effective.allow_network).toBe(false);
    expect(result.effective.max_response_items).toBe(5);
    expect(result.issues).toHaveLength(0);
  });

  it("merges the installation layer before lower-precedence configuration layers", () => {
    const result = mergeConfiguration(
      {
        installation: { allow_network: false, max_response_items: 5 },
        user: { max_response_items: 40 },
        workspace: { max_response_items: 20 },
      },
      { allow_network: true, max_response_items: 100 },
    );
    expect(result.effective.allow_network).toBe(false);
    expect(result.effective.max_response_items).toBe(5);
    expect(result.layer_digests["installation"]).toMatch(/^sha256:/u);
  });

  it("rejects traversal and normalizes workspace paths", () => {
    expect(normalizeWorkspacePath("/workspace", "src\\main.ts")).toBe("src/main.ts");
    expect(() => normalizeWorkspacePath("/workspace", "../secret.txt")).toThrow("security:path_outside_workspace");
    expect(() => normalizeWorkspacePath("/workspace", "/etc/passwd")).toThrow("security:path_outside_workspace");
  });

  it("rejects duplicate and malformed configuration layers", () => {
    expect(() => mergeConfiguration({ workspace: { unknown: true } }, { allow_network: false })).toThrow("security:configuration_unknown_field");
    expect(() => parseConfigurationLayer('{"max_response_items":1,"max_response_items":2}', "workspace")).toThrow("security:configuration_duplicate_key");
    expect(() => parseConfigurationLayer('{"schema_version":2}', "workspace")).toThrow("security:configuration_unsupported_schema");
    expect(() => parseConfigurationLayer('{"max_response_items":"bad"}', "workspace")).toThrow("security:configuration_invalid");
    expect(() => parseConfigurationLayer('{"expose_secret_snippets":1}', "workspace")).toThrow("security:configuration_invalid");
    expect(() => parseConfigurationLayer('{"sandbox_strength":"\\ud800"}', "workspace")).toThrow("security:configuration_invalid");
    expect(() => parseConfigurationLayer('{"retention_hours":0}', "workspace")).toThrow("security:configuration_invalid");
    expect(() => mergeConfiguration({ workspace: { retention_hours: 12 } }, { retention_hours: 24 })).toThrow("security:configuration_invalid");
  });

  it("normalizes configuration roots before authority comparison and requires absolute roots", () => {
    const result = mergeConfiguration({ workspace: { allowed_external_roots: ["/outside/"] } }, { allowed_external_roots: ["/tmp/../outside"] });
    expect(result.effective.allowed_external_roots).toEqual(["/outside"]);
    expect(result.issues).toHaveLength(0);
    expect(() => mergeConfiguration({}, { allowed_external_roots: ["relative/../outside"] })).toThrow("security:configuration_invalid");
    const platformNormalized = mergeConfiguration({ workspace: { allowed_external_roots: ["/outside\\child"] } }, { allowed_external_roots: ["/outside/child"] });
    expect(platformNormalized.effective.allowed_external_roots).toEqual(["/outside/child"]);
  });

  it("revalidates symlink targets against the configured boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-root-"));
    const outside = await mkdtemp(join(tmpdir(), "urdira-phase6-outside-"));
    await mkdir(join(root, "src"));
    await symlink(outside, join(root, "src", "escape"));
    await expect(resolveSafePath(root, "src/escape/file.txt")).rejects.toThrow("security:path_outside_workspace");
  });

  it("sanitizes symlink-cycle traversal errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-cycle-path-"));
    await mkdir(join(root, "src"));
    await symlink("cycle", join(root, "src", "cycle"));
    await expect(resolveSafePath(root, "src/cycle")).rejects.toMatchObject({ code: "security:symlink_cycle" });
    await expect(resolveSafePath(root, "src/cycle")).rejects.not.toThrow(root);
  });

  it("enforces lstat-derived symlink follow policy and detects cycles", () => {
    const observation = { normalized_path: "src/link.txt", is_symlink: true, is_directory: false, byte_length: 10, media_type: "text/plain" };
    expect(evaluateInclusion(observation, { include: ["src/link.txt"], exclude: [], allow_external_root: false, follow_symlinks: false }, { enabled: false, patterns: [] }).reason_code).toBe("security:symlink_forbidden");
    expect(evaluateInclusion(observation, { include: ["src/link.txt"], exclude: [], allow_external_root: false, follow_symlinks: true }, { enabled: false, patterns: [] }).included).toBe(true);
    expect(evaluateInclusion({ ...observation, symlink_cycle: true }, { include: ["src/link.txt"], exclude: [], allow_external_root: false, follow_symlinks: true }, { enabled: false, patterns: [] }).reason_code).toBe("security:symlink_cycle");
    expect(evaluateInclusion({ ...observation, outside_allowed_root: true }, { include: ["src/link.txt"], exclude: [], allow_external_root: false, follow_symlinks: true }, { enabled: false, patterns: [] }).reason_code).toBe("security:external_root_forbidden");
  });

  it("inspects real symlink entries before inclusion", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-inclusion-links-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "target.txt"), "safe");
    await symlink("target.txt", join(root, "src", "link.txt"));
    expect((await inspectInclusionPath(root, "src/link.txt", { include: ["src/link.txt"], exclude: [], allow_external_root: false }, { enabled: false, patterns: [] })).reason_code).toBe("security:symlink_forbidden");
    expect((await inspectInclusionPath(root, "src/link.txt", { include: ["src/link.txt"], exclude: [], allow_external_root: false, follow_symlinks: true }, { enabled: false, patterns: [] })).included).toBe(true);
    await symlink("cycle", join(root, "src", "cycle"));
    expect((await inspectInclusionPath(root, "src/cycle", { include: ["src/cycle"], exclude: [], allow_external_root: false, follow_symlinks: true }, { enabled: false, patterns: [] })).reason_code).toBe("security:symlink_cycle");
  });

  it("rejects a dangling symlink by follow policy before resolving its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-inclusion-probe-"));
    await mkdir(join(root, "src"));
    await symlink(join(root, "missing-target"), join(root, "src", "dangling.txt"));
    expect((await inspectInclusionPath(root, "src/dangling.txt", { include: ["src/dangling.txt"], exclude: [], allow_external_root: false, follow_symlinks: false }, { enabled: false, patterns: [] })).reason_code).toBe("security:symlink_forbidden");
  });

  it("requires registered external roots even when external inclusion is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-unregistered-root-"));
    const outside = await mkdtemp(join(tmpdir(), "urdira-phase6-unregistered-outside-"));
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(join(outside, "secret.txt"), join(root, "outside.txt"));
    expect(evaluateInclusion({ normalized_path: "outside.txt", is_symlink: true, is_directory: false, byte_length: 7, media_type: "text/plain", outside_allowed_root: true }, { include: ["outside.txt"], exclude: [], allow_external_root: true, follow_symlinks: true }, { enabled: false, patterns: [] }).reason_code).toBe("security:external_root_forbidden");
    expect((await inspectInclusionPath(root, "outside.txt", { include: ["outside.txt"], exclude: [], allow_external_root: true, follow_symlinks: true }, { enabled: false, patterns: [] })).reason_code).toBe("security:external_root_forbidden");
  });

  it("does not let a configured external root bypass a disabled external-inclusion policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-disabled-external-root-"));
    const outside = await mkdtemp(join(tmpdir(), "urdira-phase6-disabled-external-target-"));
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(join(outside, "secret.txt"), join(root, "outside.txt"));
    const result = await inspectInclusionPath(root, "outside.txt", { include: ["outside.txt"], exclude: [], allow_external_root: false, allowed_external_roots: [outside], follow_symlinks: true }, { enabled: false, patterns: [] });
    expect(result.reason_code).toBe("security:external_root_forbidden");
    expect(result.included).toBe(false);
  });

  it("classifies ordinary regular text as eligible and rejects special targets despite explicit rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-inclusion-types-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "readme.txt"), "ordinary text");
    expect((await inspectInclusionPath(root, "src/readme.txt", { include: [], exclude: [], allow_external_root: false }, { enabled: false, patterns: [] })).included).toBe(true);
    if (process.platform !== "win32") {
      await symlink("/dev/null", join(root, "src", "device"));
      expect((await inspectInclusionPath(root, "src/device", { include: ["src/device"], exclude: [], allow_external_root: true, allowed_external_roots: ["/dev"], follow_symlinks: true }, { enabled: false, patterns: [] })).reason_code).toBe("security:path_invalid");
    }
  });

  it("keeps mandatory exclusions stronger than includes and git ignores", () => {
    const result = evaluateInclusion(
      { normalized_path: ".git/config", is_symlink: false, is_directory: false, byte_length: 100, media_type: "text/plain" },
      { include: [".git/**"], exclude: [], allow_external_root: false },
      { patterns: ["**/*"], enabled: true },
    );
    expect(result.included).toBe(false);
    expect(result.reason_code).toBe("security:mandatory_exclusion");
    expect(evaluateInclusion({ normalized_path: "dist/app.js", is_symlink: false, is_directory: false, byte_length: 10, media_type: "text/plain" }, { include: [], exclude: [], allow_external_root: false }, { enabled: false, patterns: [] }).included).toBe(false);
    expect(evaluateInclusion({ normalized_path: "src/app.ts", is_symlink: false, is_directory: false, byte_length: 10, media_type: "text/plain" }, { include: [], exclude: [], allow_external_root: false }, { enabled: true, patterns: ["src/**"] }).reason_code).toBe("security:gitignore");
    expect(evaluateInclusion({ normalized_path: "src/app.ts", is_symlink: false, is_directory: false, byte_length: 10, media_type: "text/plain" }, { include: ["src/app.ts"], exclude: [], allow_external_root: false }, { enabled: true, patterns: ["src/**"] }).included).toBe(true);
    expect(evaluateInclusion({ normalized_path: "src/app.ts", is_symlink: false, is_directory: true, byte_length: 0, media_type: "text/plain" }, { include: [], exclude: [], allow_external_root: false }, { enabled: false, patterns: [] }).reason_code).toBe("security:directory_not_artifact");
    expect(evaluateInclusion({ normalized_path: "src/app.ts", is_symlink: false, is_directory: false, byte_length: 11 * 1024 * 1024, media_type: "text/plain" }, { include: ["src/app.ts"], exclude: [], allow_external_root: false }, { enabled: false, patterns: [] }).reason_code).toBe("security:size_exclusion");
    expect(evaluateInclusion({ normalized_path: "src/app.bin", is_symlink: false, is_directory: false, byte_length: 10, media_type: "application/octet-stream" }, { include: [], exclude: [], allow_external_root: false }, { enabled: false, patterns: [] }).included).toBe(false);
    expect(evaluateInclusion({ normalized_path: "file.bin", is_symlink: false, is_directory: false, byte_length: 10, media_type: "text/plain" }, { include: ["**/*.bin"], exclude: [], allow_external_root: false }, { enabled: false, patterns: [] }).included).toBe(true);
    expect(evaluateInclusion({ normalized_path: "../outside.bin", is_symlink: false, is_directory: false, byte_length: 10, media_type: "text/plain" }, { include: ["**/*.bin"], exclude: [], allow_external_root: true }, { enabled: false, patterns: [] }).reason_code).toBe("security:path_outside_workspace");
  });

  it("classifies secrets without returning secret values", () => {
    const detections = classifySecret({ normalized_path: ".env", media_type: "text/plain" }, Buffer.from("TOKEN=super-secret\n"));
    expect(detections.map((item) => item.rule_code)).toEqual(expect.arrayContaining(["secret:dotenv_assignment"]));
    expect(JSON.stringify(detections)).not.toContain("super-secret");
  });

  it("classifies DSA private-key PEM content", () => {
    const pem = Buffer.from("-----BEGIN DSA PRIVATE KEY-----\nprivate-material\n-----END DSA PRIVATE KEY-----", "utf8");
    expect(classifySecret({ normalized_path: "config.txt", media_type: "text/plain" }, pem).map((item) => item.rule_code)).toContain("secret:private_key_or_explicit_path");
  });

  it("classifies encrypted private-key PEM content", () => {
    const pem = Buffer.from("-----BEGIN ENCRYPTED PRIVATE KEY-----\nencrypted-material\n-----END ENCRYPTED PRIVATE KEY-----", "utf8");
    expect(classifySecret({ normalized_path: "config.txt", media_type: "text/plain" }, pem).map((item) => item.rule_code)).toContain("secret:private_key_or_explicit_path");
  });

  it("redacts snippets and emits safe operational logs", () => {
    const snippet = redactSnippet("prefix TOKEN=super-secret suffix", [{ start_byte: 7, end_byte: 25, rule_code: "secret:token_assignment" }], { max_characters: 100 });
    expect(snippet.text).toContain("[REDACTED]");
    expect(snippet.redacted).toBe(true);
    const log = safeLogEvent({ event_code: "security:test", workspace_id: "ws", message: "TOKEN=super-secret", source_text: "secret" });
    expect(JSON.stringify(log)).not.toContain("super-secret");
    expect(JSON.stringify(log)).not.toContain("source_text");
  });

  it("redacts structured credentials and relative source paths from safe logs", () => {
    const log = safeLogEvent({ event_code: "security:structured", message: '{"AWS_SECRET_ACCESS_KEY":"aws-structured-secret","Authorization":"Bearer bearer-token","nested":{"password":"nested-password-value"}} source src/private.ts', artifact_path: "src/private.ts" });
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain("aws-structured-secret");
    expect(serialized).not.toContain("bearer-token");
    expect(serialized).not.toContain("nested-password-value");
    expect(serialized).not.toContain("src/private.ts");
    expect(log.artifact_path).toBeUndefined();
  });

  it("recursively redacts non-string structured credential values", () => {
    const log = safeLogEvent({ event_code: "security:numeric-credential", message: { token: 123456789, nested: { password: 42 }, safe: "ok" } as never });
    expect(log.message).not.toContain("123456789");
    expect(log.message).not.toContain(":42");
    expect(log.message).toContain("REDACTED_CREDENTIAL");
  });

  it("recursively redacts array and object credentials in JSON log strings", () => {
    const log = safeLogEvent({ event_code: "security:json-array-credential", message: '{"outer":{"token":["array-secret",{"password":123456789}]},"safe":"ok"}' });
    expect(log.message).not.toContain("array-secret");
    expect(log.message).not.toContain("123456789");
    expect(log.message).toContain("REDACTED_CREDENTIAL");
  });

  it("recursively redacts credential JSON fragments embedded in arbitrary log text", () => {
    const log = safeLogEvent({ event_code: "security:embedded-json-credential", message: 'prefix {"context":{"token":["embedded-array-secret"],"metadata":{"password":{"value":"embedded-object-secret"}}}} suffix' });
    expect(log.message).not.toContain("embedded-array-secret");
    expect(log.message).not.toContain("embedded-object-secret");
    expect(log.message).toContain("prefix");
    expect(log.message).toContain("suffix");
  });

  it("rejects unsafe IPC endpoint permissions", () => {
    expect(() => checkIpcPeerPermissions({ mode: 0o644, owner_uid: 1, current_uid: 1 })).toThrow("security:ipc_permissions_unsafe");
    expect(checkIpcPeerPermissions({ mode: 0o600, owner_uid: 1, current_uid: 1 }).allowed).toBe(true);
    expect(() => checkIpcPeerPermissions({ mode: 0o600, owner_uid: 2, current_uid: 1 })).toThrow("security:ipc_permissions_unsafe");
    expect(checkIpcPeerPermissions({ mode: 0, owner_uid: 1, current_uid: 1, platform: "windows", acl_owner_only: true }).allowed).toBe(true);
    expect(() => checkIpcPeerPermissions({ mode: 0, owner_uid: 1, current_uid: 1, platform: "windows", acl_owner_only: false })).toThrow("security:ipc_permissions_unsafe");
  });

  it("inspects packages without executing them and catches traversal", () => {
    const result = inspectPluginPackage({ package_format_id: "core:plugin", package_format_version: 1, plugin_id: "plugin:test", plugin_version: "1.0.0", package_files: [{ normalized_relative_path: "../run", content_digest: "sha256:" + "0".repeat(64), byte_length: 1, executable: true }] }, new Map([["../run", Buffer.from("x")]]));
    expect(result.issues.map((issue) => issue.code)).toContain("security:package_path_invalid");
  });

  it("rejects model-pack digest mismatch and archive bombs", () => {
    const manifest = { manifest_schema_version: "1", model_pack_id: "core:test", model_pack_version: "1.0.0", embedding_profiles: [], assets: [{ content_digest: "sha256:" + "0".repeat(64), decoded_byte_length: 3, media_type: "application/octet-stream", semantic_role: "weights" }], required_runtime_components: [], manifest_digest: "sha256:" + "1".repeat(64) };
    const result = inspectModelPack(manifest, new Map([["sha256:" + "0".repeat(64), Buffer.from("too-long")]]), { max_asset_bytes: 4 });
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["security:model_asset_length_mismatch", "security:model_manifest_digest_mismatch"]));
    const ratioResult = inspectModelPack(manifest, new Map([["sha256:" + "0".repeat(64), Buffer.from("too-long")]]), { compressed_total_bytes: 1, max_compression_ratio: 2 });
    expect(ratioResult.issues.map((issue) => issue.code)).toContain("security:download_limit_exceeded");
  });

  it("reserves plugin coordinates by digest", async () => {
    const bytes = Buffer.from("plugin");
    const digest = digestBytes(bytes);
    const manager = new PluginPackageLifecycleManager();
    const first = { package_format_id: "core:plugin", package_format_version: 1, plugin_id: "plugin:test", plugin_version: "1.0.0", package_files: [{ normalized_relative_path: "worker.js", content_digest: digest, byte_length: bytes.byteLength, executable: true }] };
    const firstInstall = await manager.install(first, new Map([["worker.js", bytes]]));
    const secondBytes = Buffer.from("other");
    const entry = first.package_files[0]!;
    const second = { ...first, package_files: [{ normalized_relative_path: entry.normalized_relative_path, executable: entry.executable, content_digest: digestBytes(secondBytes), byte_length: secondBytes.byteLength }] };
    expect(firstInstall).toMatchObject({ plugin_id: "plugin:test" });
    await expect(manager.install(second, new Map([["worker.js", secondBytes]]))).rejects.toThrow("security:package_coordinate_collision");
  });

  it.skipIf(process.platform === "win32")("creates owner-only mutable storage roots with POSIX modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-phase6-storage-"));
    const capabilities = await ensureOwnerOnlyDirectory(join(root, "data"));
    expect(capabilities.owner_only).toBe(true);
    expect(capabilities.mode).toBe(0o700);
    await expect(inspectStorageRoot(join(root, "missing"))).rejects.toThrow("security:ipc_permissions_unsafe");
    await expect(inspectStorageRoot(join(root, "data"), -1)).rejects.toThrow("security:ipc_permissions_unsafe");
  });

  it("recovers staged installation state without publishing partial data", async () => {
    const store = new InMemoryStagingStore();
    await store.stage("operation-1", [{ path: "blob", bytes: Buffer.from("safe") }]);
    await store.markInterrupted("operation-1");
    expect(await store.recover("operation-1")).toEqual({ state: "discarded", removed_paths: ["blob"] });
  });

  it("keeps the network adapter explicit and digest-bound", async () => {
    const downloader = new AdministrativeModelPackDownloader({
      fetch: async () => ({ status: 200, headers: {}, body: Buffer.from("bytes") }),
    });
    await expect(downloader.download({ authorized_manifest_digest: "sha256:" + "0".repeat(64), manifest_locator: "http://example.test/manifest", blob_locators: {} })).rejects.toThrow("security:download_scheme_forbidden");
    const redirecting = new AdministrativeModelPackDownloader({ fetch: async () => ({ status: 302, headers: {}, body: new Uint8Array(), final_locator: "http://example.test/redirect" }) });
    await expect(redirecting.download({ authorized_manifest_digest: "sha256:" + "0".repeat(64), manifest_locator: "https://example.test/manifest", blob_locators: {}, allow_redirects: true })).rejects.toThrow("security:download_redirect_forbidden");
    const crossOriginAfterSuccess = new AdministrativeModelPackDownloader({ fetch: async () => ({ status: 200, headers: {}, body: Buffer.from("manifest"), final_locator: "https://evil.example/manifest" }) });
    await expect(crossOriginAfterSuccess.download({ authorized_manifest_digest: digestBytes(Buffer.from("manifest")), manifest_locator: "https://example.test/manifest", blob_locators: {}, allow_redirects: true })).rejects.toThrow("security:download_redirect_forbidden");
    const manifestBytes = Buffer.from("manifest");
    const blobBytes = Buffer.from("blob");
    const good = new AdministrativeModelPackDownloader({ fetch: async (locator) => locator.includes("manifest") ? { status: 200, headers: {}, body: manifestBytes } : { status: 200, headers: {}, body: blobBytes } });
    await expect(good.download({ authorized_manifest_digest: digestBytes(manifestBytes), manifest_locator: "file:///tmp/manifest", blob_locators: { [digestBytes(blobBytes)]: "file:///tmp/blob" } })).resolves.toMatchObject({ blobs: new Map([[digestBytes(blobBytes), blobBytes]]) });
    const tooLarge = new AdministrativeModelPackDownloader({ fetch: async () => ({ status: 200, headers: {}, body: Buffer.from("large") }) });
    await expect(tooLarge.download({ authorized_manifest_digest: digestBytes(Buffer.from("large")), manifest_locator: "file:///tmp/manifest", blob_locators: {}, max_bytes: 1 })).rejects.toThrow("security:download_limit_exceeded");
  });
});
