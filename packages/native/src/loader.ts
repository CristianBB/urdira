import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeTarget, type NativeLibc, type NativeTarget } from "./targets.js";
import type { NativeBinding } from "./types.js";

export const NATIVE_API_VERSION = 17;
export const NODE_API_VERSION = 10;
export const NATIVE_PACKAGE_MANIFEST_VERSION = 1;
export const NATIVE_WORKER_PROTOCOL = "urdira.ipc.v2";

export class NativeBindingError extends Error {
  override readonly name = "NativeBindingError";
}

export interface NativeLoaderOptions {
  readonly platform?: string;
  readonly arch?: string;
  readonly libc?: NativeLibc;
  /** Root of the generic @urdira/native package. */
  readonly package_root?: string;
  /** Explicit offline-release root containing manifest.json. */
  readonly prebuild_root?: string;
  /** Test-only seam for loading a freshly built addon before it is packaged. */
  readonly artifact_path?: string;
  /** Test-only seam matching artifact_path. */
  readonly worker_path?: string;
  readonly exists?: (path: string) => boolean;
  readonly load?: (path: string) => unknown;
  readonly resolve_package?: (specifier: string) => string;
}

interface NativeFileDeclaration {
  readonly path: string;
  readonly digest: string;
}

interface NativePlatformMetadata {
  readonly schema_version: number;
  readonly target: string;
  readonly rust_target: string;
  readonly binding_api: number;
  readonly node_api: number;
  readonly worker_protocol: string;
  readonly build_id: string;
  readonly files: {
    readonly addon: NativeFileDeclaration;
    readonly worker: NativeFileDeclaration;
  };
}

export interface ResolvedNativeClosure {
  readonly target_id: NativeTarget["id"];
  readonly runtime_target_id: NativeTarget["triple"];
  readonly runtime_component_build_id: string;
  readonly addon_path: string;
  readonly addon_digest: string;
  readonly worker_path: string;
  readonly worker_digest: string;
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

function bindingFunction(value: Partial<NativeBinding>, name: keyof NativeBinding): void {
  if (typeof value[name] !== "function") throw new NativeBindingError(`Urdira native artifact does not export ${name}.`);
}

function validateBinding(value: unknown, target: NativeTarget): NativeBinding {
  if (typeof value !== "object" || value === null) throw new NativeBindingError("Urdira native artifact did not export an object.");
  const binding = value as Partial<NativeBinding>;
  for (const name of ["nativeApiVersion", "nativeTargetTriple", "logicalDigestBatch", "verifyLogicalRecordBatch", "logicalValueDigestBatch", "verifyLogicalValueBatch", "structuralKernelBatch", "structuralKernelCanonicalBatch", "structuralObservationBatch", "exactVectorTopKBatch", "registerVectorBuffer", "exactTopKContiguous"] as const) bindingFunction(binding, name);
  const completeBinding = binding as NativeBinding;
  if (completeBinding.nativeApiVersion() !== NATIVE_API_VERSION) throw new NativeBindingError(`Urdira native API mismatch; expected ${NATIVE_API_VERSION}.`);
  const actualTarget = completeBinding.nativeTargetTriple();
  if (actualTarget !== target.triple) throw new NativeBindingError(`Urdira native target mismatch; expected ${target.triple}, received ${actualTarget}.`);
  return completeBinding;
}

function parseJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new NativeBindingError(`Required Urdira native manifest is invalid at ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function sha256File(path: string): string {
  try {
    return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  } catch (error) {
    throw new NativeBindingError(`Required Urdira native artifact cannot be read: ${path}`, { cause: error });
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}

function buildId(metadata: Omit<NativePlatformMetadata, "build_id">): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(metadata))).digest("hex")}`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw new NativeBindingError(`${field} has unknown or missing fields.`);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new NativeBindingError(`${field} must be a non-empty string.`);
  return value;
}

function digestField(value: unknown, field: string): string {
  const digest = stringField(value, field);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) throw new NativeBindingError(`${field} must be a SHA-256 digest.`);
  return digest;
}

function safeArtifactPath(root: string, declaredPath: unknown, expectedPath: string, field: string): string {
  const path = stringField(declaredPath, field);
  if (path !== expectedPath || isAbsolute(path) || normalize(path).startsWith("..")) throw new NativeBindingError(`${field} is not the exact target artifact path.`);
  return join(root, path);
}

function validateChecksums(closure: ResolvedNativeClosure): void {
  for (const [role, path, expected] of [["addon", closure.addon_path, closure.addon_digest], ["worker", closure.worker_path, closure.worker_digest]] as const) {
    const actual = sha256File(path);
    if (actual !== expected) throw new NativeBindingError(`Urdira native ${role} checksum mismatch; expected ${expected}, received ${actual}.`);
  }
}

function parsePlatformMetadata(value: unknown, target: NativeTarget): NativePlatformMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new NativeBindingError("urdiraNative must be an object.");
  const source = value as Record<string, unknown>;
  exactKeys(source, ["schema_version", "target", "rust_target", "binding_api", "node_api", "worker_protocol", "build_id", "files"], "urdiraNative");
  if (source["schema_version"] !== NATIVE_PACKAGE_MANIFEST_VERSION) throw new NativeBindingError("Urdira native package manifest version mismatch.");
  if (source["target"] !== target.id || source["rust_target"] !== target.triple) throw new NativeBindingError(`Urdira native package target mismatch for ${target.id}.`);
  if (source["binding_api"] !== NATIVE_API_VERSION || source["node_api"] !== NODE_API_VERSION) throw new NativeBindingError(`Urdira native package API mismatch for ${target.id}.`);
  if (source["worker_protocol"] !== NATIVE_WORKER_PROTOCOL) throw new NativeBindingError(`Urdira native worker protocol mismatch for ${target.id}.`);
  if (typeof source["files"] !== "object" || source["files"] === null || Array.isArray(source["files"])) throw new NativeBindingError("urdiraNative.files must be an object.");
  const files = source["files"] as Record<string, unknown>;
  exactKeys(files, ["addon", "worker"], "urdiraNative.files");
  const parseFile = (role: "addon" | "worker"): NativeFileDeclaration => {
    const entry = files[role];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new NativeBindingError(`urdiraNative.files.${role} must be an object.`);
    const record = entry as Record<string, unknown>;
    exactKeys(record, ["path", "digest"], `urdiraNative.files.${role}`);
    return { path: stringField(record["path"], `urdiraNative.files.${role}.path`), digest: digestField(record["digest"], `urdiraNative.files.${role}.digest`) };
  };
  const metadata: NativePlatformMetadata = {
    schema_version: NATIVE_PACKAGE_MANIFEST_VERSION,
    target: target.id,
    rust_target: target.triple,
    binding_api: NATIVE_API_VERSION,
    node_api: NODE_API_VERSION,
    worker_protocol: NATIVE_WORKER_PROTOCOL,
    build_id: digestField(source["build_id"], "urdiraNative.build_id"),
    files: { addon: parseFile("addon"), worker: parseFile("worker") },
  };
  const { build_id: declaredBuildId, ...buildIdentity } = metadata;
  const expectedBuildId = buildId(buildIdentity);
  if (declaredBuildId !== expectedBuildId) throw new NativeBindingError(`Urdira native build identity mismatch; expected ${expectedBuildId}, received ${declaredBuildId}.`);
  return metadata;
}

function resolveInstalledClosure(target: NativeTarget, options: NativeLoaderOptions): ResolvedNativeClosure {
  const genericManifest = parseJson(join(options.package_root ?? packageRoot, "package.json"));
  const optionalDependencies = genericManifest["optionalDependencies"];
  if (typeof optionalDependencies !== "object" || optionalDependencies === null || Array.isArray(optionalDependencies)) throw new NativeBindingError("@urdira/native does not declare its exact platform optional dependencies.");
  const expectedVersion = stringField((optionalDependencies as Record<string, unknown>)[target.package_name], `optionalDependencies.${target.package_name}`);
  let targetManifestPath: string;
  try {
    targetManifestPath = (options.resolve_package ?? ((specifier: string) => require.resolve(specifier)))(`${target.package_name}/package.json`);
  } catch (error) {
    throw new NativeBindingError(`Required Urdira native platform package ${target.package_name}@${expectedVersion} is missing.`, { cause: error });
  }
  const manifest = parseJson(targetManifestPath);
  if (manifest["name"] !== target.package_name || manifest["version"] !== expectedVersion) throw new NativeBindingError(`Urdira native platform package identity mismatch; expected ${target.package_name}@${expectedVersion}.`);
  if (JSON.stringify(manifest["os"]) !== JSON.stringify([target.platform]) || JSON.stringify(manifest["cpu"]) !== JSON.stringify([target.arch])) throw new NativeBindingError(`Urdira native platform constraints mismatch for ${target.package_name}.`);
  if (target.libc === "glibc" && JSON.stringify(manifest["libc"]) !== JSON.stringify(["glibc"])) throw new NativeBindingError(`Urdira native libc constraint mismatch for ${target.package_name}.`);
  if (target.libc === undefined && manifest["libc"] !== undefined) throw new NativeBindingError(`Urdira native platform package ${target.package_name} declares an unexpected libc constraint.`);
  const metadata = parsePlatformMetadata(manifest["urdiraNative"], target);
  const targetRoot = dirname(targetManifestPath);
  const workerName = target.platform === "win32" ? "urdira-jsts-syntax-worker.exe" : "urdira-jsts-syntax-worker";
  const closure = {
    target_id: target.id,
    runtime_target_id: target.triple,
    runtime_component_build_id: metadata.build_id,
    addon_path: safeArtifactPath(targetRoot, metadata.files.addon.path, "native/urdira-native.node", "urdiraNative.files.addon.path"),
    addon_digest: metadata.files.addon.digest,
    worker_path: safeArtifactPath(targetRoot, metadata.files.worker.path, `native/${workerName}`, "urdiraNative.files.worker.path"),
    worker_digest: metadata.files.worker.digest,
  };
  validateChecksums(closure);
  return closure;
}

function resolveOfflineClosure(root: string, target: NativeTarget): ResolvedNativeClosure {
  const manifest = parseJson(join(root, "manifest.json"));
  exactKeys(manifest, ["native_manifest_version", "target", "rust_target", "binding_api", "node_api", "worker_protocol", "build_id", "files"], "offline native manifest");
  if (manifest["native_manifest_version"] !== 1 || manifest["target"] !== target.id || manifest["rust_target"] !== target.triple) throw new NativeBindingError(`Offline Urdira native manifest target mismatch for ${target.id}.`);
  if (manifest["binding_api"] !== NATIVE_API_VERSION || manifest["node_api"] !== NODE_API_VERSION || manifest["worker_protocol"] !== NATIVE_WORKER_PROTOCOL) throw new NativeBindingError(`Offline Urdira native manifest API mismatch for ${target.id}.`);
  if (typeof manifest["files"] !== "object" || manifest["files"] === null || Array.isArray(manifest["files"])) throw new NativeBindingError("Offline Urdira native manifest files are invalid.");
  const files = manifest["files"] as Record<string, unknown>;
  if (!Object.hasOwn(files, "addon") || !Object.hasOwn(files, "worker") || Object.keys(files).some((key) => !["addon", "worker", "launcher", "node"].includes(key))) throw new NativeBindingError("Offline Urdira native manifest files have unknown or missing fields.");
  const readDeclaration = (role: "addon" | "worker"): NativeFileDeclaration => {
    const value = files[role];
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new NativeBindingError(`Offline Urdira native ${role} declaration is missing.`);
    const record = value as Record<string, unknown>;
    return { path: stringField(record["path"], `files.${role}.path`), digest: digestField(record["digest"], `files.${role}.digest`) };
  };
  const addon = readDeclaration("addon");
  const worker = readDeclaration("worker");
  const archiveRoot = basename(root) === "native" ? dirname(root) : root;
  const workerName = target.platform === "win32" ? "urdira-jsts-syntax-worker.exe" : "urdira-jsts-syntax-worker";
  const closure = {
    target_id: target.id,
    runtime_target_id: target.triple,
    runtime_component_build_id: digestField(manifest["build_id"], "build_id"),
    addon_path: safeArtifactPath(archiveRoot, addon.path, "native/urdira-native.node", "files.addon.path"),
    addon_digest: addon.digest,
    worker_path: safeArtifactPath(archiveRoot, worker.path, `native/${workerName}`, "files.worker.path"),
    worker_digest: worker.digest,
  };
  const expectedBuildId = buildId({ schema_version: 1, target: target.id, rust_target: target.triple, binding_api: NATIVE_API_VERSION, node_api: NODE_API_VERSION, worker_protocol: NATIVE_WORKER_PROTOCOL, files: { addon, worker } });
  if (closure.runtime_component_build_id !== expectedBuildId) throw new NativeBindingError(`Offline Urdira native build identity mismatch; expected ${expectedBuildId}, received ${closure.runtime_component_build_id}.`);
  validateChecksums(closure);
  return closure;
}

function resolvedClosure(target: NativeTarget, options: NativeLoaderOptions): ResolvedNativeClosure {
  const explicitRoot = options.prebuild_root ?? process.env["URDIRA_NATIVE_ROOT"];
  return explicitRoot === undefined ? resolveInstalledClosure(target, options) : resolveOfflineClosure(explicitRoot, target);
}

/** Resolve and checksum one exact addon+worker target closure. Callers pass
 * this immutable identity into plugin bundle construction; no artifact is
 * reselected by path or ambient state afterward. */
export function resolveNativeClosure(options: Omit<NativeLoaderOptions, "artifact_path" | "worker_path" | "load"> = {}): ResolvedNativeClosure {
  const target = resolveNativeTarget(options.platform, options.arch, options.libc);
  return Object.freeze(resolvedClosure(target, options));
}

export function loadNativeBinding(options: NativeLoaderOptions = {}): NativeBinding {
  const target = resolveNativeTarget(options.platform, options.arch, options.libc);
  const artifactPath = options.artifact_path ?? resolvedClosure(target, options).addon_path;
  if (!(options.exists ?? existsSync)(artifactPath)) throw new NativeBindingError(`Required Urdira native artifact is missing for ${target.triple}: ${artifactPath}`);
  try {
    return validateBinding((options.load ?? ((path: string) => require(path)))(artifactPath), target);
  } catch (error) {
    if (error instanceof NativeBindingError) throw error;
    throw new NativeBindingError(`Required Urdira native artifact failed to load for ${target.triple}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

let activeBinding: NativeBinding | undefined;

export function getNativeBinding(): NativeBinding {
  activeBinding ??= loadNativeBinding();
  return activeBinding;
}

/** Resolve and verify the Oxc worker from the same exact target closure as the addon. */
export function resolveNativeWorkerPath(options: Omit<NativeLoaderOptions, "artifact_path" | "load"> = {}): string {
  const target = resolveNativeTarget(options.platform, options.arch, options.libc);
  const closure = resolvedClosure(target, options);
  const explicit = options.worker_path ?? process.env["URDIRA_JSTS_WORKER_PATH"];
  if (explicit !== undefined && normalize(explicit) !== normalize(closure.worker_path)) throw new NativeBindingError(`Explicit Urdira syntax worker does not match the verified ${target.id} closure.`);
  const path = explicit ?? closure.worker_path;
  if (!(options.exists ?? existsSync)(path)) throw new NativeBindingError(`Required Urdira syntax worker is missing for ${target.triple}: ${path}`);
  return path;
}
