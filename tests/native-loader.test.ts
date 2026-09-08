import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NATIVE_API_VERSION,
  NativeBindingError,
  loadNativeBinding,
  resolveNativeClosure,
  resolveNativeWorkerPath,
} from "../packages/native/src/loader.js";
import { resolveNativeTarget, SUPPORTED_NATIVE_TARGETS } from "../packages/native/src/targets.js";
import type { NativeBinding } from "../packages/native/src/types.js";
import { createNativePlatformPublishManifest } from "../scripts/package-npm.mjs";

const expectedTargets = [
  ["darwin", "arm64", undefined, "aarch64-apple-darwin"],
  ["darwin", "x64", undefined, "x86_64-apple-darwin"],
  ["linux", "arm64", "glibc", "aarch64-unknown-linux-gnu"],
  ["linux", "x64", "glibc", "x86_64-unknown-linux-gnu"],
  ["win32", "x64", undefined, "x86_64-pc-windows-msvc"],
] as const;

function binding(target: string, version = NATIVE_API_VERSION): NativeBinding {
  return {
    nativeApiVersion: () => version,
    nativeTargetTriple: () => target,
    logicalDigestBatch: () => [],
    verifyLogicalRecordBatch: () => [],
    logicalValueDigestBatch: () => [],
    verifyLogicalValueBatch: () => [],
    structuralKernelBatch: () => ({ canonical_records: [], canonical_dependencies: [], record_facets: [], record_structural_attestations: [], record_digests: [], record_ids: [], publication_records: [], record_body_payload_hexes: [], publication_descriptor: { record_count: 0, body_byte_length: 0, first_record_id: null, last_record_id: null, sequence_digest: `sha256:${"0".repeat(64)}` }, records_digest: `sha256:${"0".repeat(64)}`, dependencies_digest: `sha256:${"0".repeat(64)}`, canonical_byte_length: 0 }),
    structuralKernelCanonicalBatch: () => ({ kernel: { canonical_records: [], canonical_dependencies: [], record_facets: [], record_structural_attestations: [], record_digests: [], record_ids: [], publication_records: [], record_body_payload_hexes: [], publication_descriptor: { record_count: 0, body_byte_length: 0, first_record_id: null, last_record_id: null, sequence_digest: `sha256:${"0".repeat(64)}` }, records_digest: `sha256:${"0".repeat(64)}`, dependencies_digest: `sha256:${"0".repeat(64)}`, canonical_byte_length: 0 }, records: [], dependencies: [], record_schema_attestations: [] }),
    structuralObservationBatch: () => ({ owners: [] }),
    exactVectorTopKBatch: () => [],
    registerVectorBuffer: () => undefined,
    exactTopKContiguous: () => [],
  };
}

describe("@urdira/native target loader", () => {
  it("maps exactly the five approved release targets", () => {
    expect(SUPPORTED_NATIVE_TARGETS).toHaveLength(5);
    for (const [platform, arch, libc, triple] of expectedTargets) {
      const resolved = resolveNativeTarget(platform, arch, libc);
      expect(resolved.triple).toBe(triple);
      expect(resolved.artifact_relative_path).toBe(`prebuilds/${triple}/urdira-native.node`);
    }
    expect(() => resolveNativeTarget("linux", "x64", "unsupported")).toThrow(/unsupported/iu);
    expect(() => resolveNativeTarget("win32", "arm64")).toThrow(/unsupported/iu);
  });

  it("fails closed when the target artifact is absent", () => {
    expect(() => loadNativeBinding({
      platform: "darwin",
      arch: "arm64",
      package_root: "/urdira-native-artifact-does-not-exist",
      exists: () => false,
    })).toThrowError(/native manifest is invalid.*package\.json/iu);
  });

  it("rejects wrong API versions, targets, and incomplete exports", () => {
    const base = { platform: "darwin", arch: "arm64", artifact_path: "/fixture/urdira-native.node", exists: () => true } as const;
    expect(() => loadNativeBinding({ ...base, load: () => binding("aarch64-apple-darwin", 9) })).toThrow(/API mismatch/iu);
    expect(() => loadNativeBinding({ ...base, load: () => binding("x86_64-apple-darwin") })).toThrow(/target mismatch/iu);
    expect(() => loadNativeBinding({ ...base, load: () => ({ nativeApiVersion() { return 10; } }) })).toThrow(/does not export/iu);
    expect(() => loadNativeBinding({ ...base, exists: () => false, load: () => binding("aarch64-apple-darwin") })).toThrow(/artifact is missing/iu);
    expect(() => loadNativeBinding({ ...base, load: () => { throw new Error("fixture dlopen failure"); } })).toThrow(/failed to load.*fixture dlopen failure/iu);
  });

  it("resolves only the exact platform package and verifies build identity and checksums", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-native-platform-loader-"));
    const genericRoot = join(root, "generic");
    const targetRoot = join(root, "target");
    const addon = Buffer.from("addon:darwin-arm64");
    const worker = Buffer.from("worker:darwin-arm64");
    const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    await mkdir(join(targetRoot, "native"), { recursive: true });
    await mkdir(genericRoot, { recursive: true });
    await writeFile(join(targetRoot, "native", "urdira-native.node"), addon);
    await writeFile(join(targetRoot, "native", "urdira-jsts-syntax-worker"), worker);
    const manifest = createNativePlatformPublishManifest({
      target: "darwin-arm64",
      version: "0.3.0",
      addonDigest: digest(addon),
      workerDigest: digest(worker),
    });
    const nativeMetadata = manifest["urdiraNative"] as { readonly build_id: string };
    await writeFile(join(targetRoot, "package.json"), JSON.stringify(manifest));
    await writeFile(join(genericRoot, "package.json"), JSON.stringify({ name: "@urdira/native", version: "0.3.0", optionalDependencies: { "@urdira/native-darwin-arm64": "0.3.0" } }));
    const options = {
      platform: "darwin",
      arch: "arm64",
      package_root: genericRoot,
      resolve_package: () => join(targetRoot, "package.json"),
    } as const;
    expect(() => loadNativeBinding({ ...options, resolve_package: () => { throw new Error("missing"); }, load: () => binding("aarch64-apple-darwin") })).toThrow(/platform package.*is missing/iu);
    expect(loadNativeBinding({ ...options, load: () => binding("aarch64-apple-darwin") })).toBeDefined();
    expect(resolveNativeClosure(options)).toEqual({
      target_id: "darwin-arm64",
      runtime_target_id: "aarch64-apple-darwin",
      runtime_component_build_id: nativeMetadata.build_id,
      addon_path: join(targetRoot, "native", "urdira-native.node"),
      addon_digest: digest(addon),
      worker_path: join(targetRoot, "native", "urdira-jsts-syntax-worker"),
      worker_digest: digest(worker),
    });
    expect(resolveNativeWorkerPath(options)).toBe(join(targetRoot, "native", "urdira-jsts-syntax-worker"));

    await writeFile(join(targetRoot, "native", "urdira-jsts-syntax-worker"), "corrupt");
    expect(() => resolveNativeWorkerPath(options)).toThrow(/checksum mismatch/iu);
    await writeFile(join(targetRoot, "native", "urdira-jsts-syntax-worker"), worker);
    const forged = JSON.parse(await readFile(join(targetRoot, "package.json"), "utf8"));
    forged.urdiraNative.node_api = 9;
    await writeFile(join(targetRoot, "package.json"), JSON.stringify(forged));
    expect(() => resolveNativeWorkerPath(options)).toThrow(/package API mismatch/iu);
    forged.urdiraNative.node_api = 10;
    forged.urdiraNative.build_id = `sha256:${"0".repeat(64)}`;
    await writeFile(join(targetRoot, "package.json"), JSON.stringify(forged));
    expect(() => resolveNativeWorkerPath(options)).toThrow(/build identity mismatch/iu);
  });

  it("activates an offline archive only from its verified target closure", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "urdira-native-offline-loader-"));
    const nativeRoot = join(archiveRoot, "native");
    const addonPath = join(nativeRoot, "urdira-native.node");
    const workerPath = join(nativeRoot, "urdira-jsts-syntax-worker");
    const addon = Buffer.from("offline-addon:darwin-arm64");
    const worker = Buffer.from("offline-worker:darwin-arm64");
    const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    await mkdir(nativeRoot, { recursive: true });
    await writeFile(addonPath, addon);
    await writeFile(workerPath, worker);
    const platformManifest = createNativePlatformPublishManifest({ target: "darwin-arm64", version: "0.3.0", addonDigest: digest(addon), workerDigest: digest(worker) });
    const platformMetadata = platformManifest["urdiraNative"] as { readonly binding_api: number; readonly build_id: string };
    await writeFile(join(nativeRoot, "manifest.json"), JSON.stringify({
      native_manifest_version: 1,
      target: "darwin-arm64",
      rust_target: "aarch64-apple-darwin",
      binding_api: platformMetadata.binding_api,
      node_api: 10,
      worker_protocol: "urdira.ipc.v2",
      build_id: platformMetadata.build_id,
      files: {
        addon: { path: "native/urdira-native.node", digest: digest(addon) },
        worker: { path: "native/urdira-jsts-syntax-worker", digest: digest(worker) },
      },
    }));

    const options = { platform: "darwin", arch: "arm64", prebuild_root: nativeRoot } as const;
    expect(loadNativeBinding({ ...options, load: () => binding("aarch64-apple-darwin") })).toBeDefined();
    expect(resolveNativeWorkerPath(options)).toBe(workerPath);
    expect(resolveNativeWorkerPath({ ...options, worker_path: workerPath })).toBe(workerPath);
    expect(() => resolveNativeWorkerPath({ ...options, worker_path: join(nativeRoot, "unverified-worker") })).toThrow(/does not match/iu);

    await writeFile(addonPath, "corrupt");
    expect(() => loadNativeBinding({ ...options, load: () => binding("aarch64-apple-darwin") })).toThrow(/addon checksum mismatch/iu);
    await writeFile(addonPath, addon);
    await rm(workerPath);
    expect(() => resolveNativeWorkerPath(options)).toThrow(/artifact cannot be read/iu);
    expect(() => resolveNativeWorkerPath({ ...options, prebuild_root: join(archiveRoot, "missing-native") })).toThrow(/manifest is invalid/iu);
  });
});
import { createHash } from "node:crypto";
