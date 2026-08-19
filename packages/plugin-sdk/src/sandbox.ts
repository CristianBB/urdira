import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { deepFreeze, hasExactKeys } from "./canonical.js";
import { sdkError } from "./errors.js";
import { materializePortResult, type PortMaterializationLimits } from "./port-boundary.js";
import type { RestrictedWorkerLaunch, WorkerSandboxPort, WorkerTransport } from "./supervisor.js";

export interface TrustedWorkerBuildMetadata {
  readonly worker_key: RestrictedWorkerLaunch["worker_key"];
  readonly package_read_root: string;
  readonly package_entrypoint: string;
  readonly scratch_private_root: string;
  readonly scratch_root: string;
  readonly workspace_root: string;
  readonly home_root: string;
  readonly credential_roots: readonly string[];
}

export interface TrustedWorkerBuildAuthorityPort {
  resolve(worker_key: RestrictedWorkerLaunch["worker_key"]): Promise<TrustedWorkerBuildMetadata>;
}

export interface PlatformIsolationRequest {
  readonly package_read_root: string;
  readonly scratch_root: string;
  readonly deny_network: true;
  readonly hide_workspace: true;
}

export type PlatformIsolationAttestation =
  | { readonly supported: false; readonly reason_code: string }
  | {
    readonly supported: true;
    readonly network_isolated: true;
    readonly workspace_hidden: true;
    readonly isolation_handle: string;
  };

export interface PlatformIsolationAdapter {
  attest(request: PlatformIsolationRequest): Promise<PlatformIsolationAttestation>;
}

export interface RestrictedNodeProcessSpec {
  readonly runtime: "node";
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly shell: false;
  readonly cwd: string;
  readonly environment: Readonly<{
    NODE_ENV: "production";
    LANG: "C";
    TZ: "UTC";
    URDIRA_WORKER_PROTOCOL_VERSION: string;
  }>;
  readonly package_read_roots: readonly string[];
  readonly scratch_write_root: string;
  readonly permissions: Readonly<{
    child_process: false;
    native_addons: false;
    worker_threads: false;
  }>;
  readonly isolation: Readonly<{
    network_isolated: true;
    workspace_hidden: true;
    isolation_handle: string;
  }>;
}

export interface RestrictedNodeProcessPort {
  readonly node_executable: string;
  launch(specification: RestrictedNodeProcessSpec): Promise<WorkerTransport>;
}

function unsupported(): never {
  throw sdkError("plugin-sdk:sandbox_unsupported", "Mandatory worker sandbox isolation is unavailable.");
}

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}

function validPlainPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && isAbsolute(value) && !/[\0\r\n]/u.test(value);
}

async function resolvedDirectory(path: unknown): Promise<string> {
  if (!validPlainPath(path)) return unsupported();
  try {
    const resolved = await realpath(path);
    if (!(await stat(resolved)).isDirectory()) return unsupported();
    return resolved;
  } catch {
    return unsupported();
  }
}

async function resolvedFile(path: unknown): Promise<string> {
  if (!validPlainPath(path)) return unsupported();
  try {
    const resolved = await realpath(path);
    if (!(await stat(resolved)).isFile()) return unsupported();
    return resolved;
  } catch {
    return unsupported();
  }
}

function validateWorkerKey(value: unknown): { readonly package_digest: string; readonly runtime_contract_version: number; readonly executable_build_digest: string } {
  if (!hasExactKeys(value, ["package_digest", "runtime_contract_version", "executable_build_digest"])
    || typeof value["package_digest"] !== "string"
    || value["package_digest"].length === 0
    || !Number.isSafeInteger(value["runtime_contract_version"])
    || (value["runtime_contract_version"] as number) <= 0
    || typeof value["executable_build_digest"] !== "string"
    || value["executable_build_digest"].length === 0) return unsupported();
  return {
    package_digest: value["package_digest"],
    runtime_contract_version: value["runtime_contract_version"] as number,
    executable_build_digest: value["executable_build_digest"],
  };
}

function sameWorkerKey(left: RestrictedWorkerLaunch["worker_key"], right: RestrictedWorkerLaunch["worker_key"]): boolean {
  return left.package_digest === right.package_digest
    && left.runtime_contract_version === right.runtime_contract_version
    && left.executable_build_digest === right.executable_build_digest;
}

function validateMetadata(value: unknown, requestedKey: RestrictedWorkerLaunch["worker_key"]): TrustedWorkerBuildMetadata {
  if (!hasExactKeys(value, [
    "worker_key",
    "package_read_root",
    "package_entrypoint",
    "scratch_private_root",
    "scratch_root",
    "workspace_root",
    "home_root",
    "credential_roots",
  ]) || !Array.isArray(value["credential_roots"])) return unsupported();
  const workerKey = validateWorkerKey(value["worker_key"]);
  if (!sameWorkerKey(workerKey, requestedKey)
    || !validPlainPath(value["package_read_root"])
    || !validPlainPath(value["package_entrypoint"])
    || !validPlainPath(value["scratch_private_root"])
    || !validPlainPath(value["scratch_root"])
    || !validPlainPath(value["workspace_root"])
    || !validPlainPath(value["home_root"])
    || value["credential_roots"].some((root) => !validPlainPath(root))) return unsupported();
  return {
    worker_key: workerKey,
    package_read_root: value["package_read_root"],
    package_entrypoint: value["package_entrypoint"],
    scratch_private_root: value["scratch_private_root"],
    scratch_root: value["scratch_root"],
    workspace_root: value["workspace_root"],
    home_root: value["home_root"],
    credential_roots: [...value["credential_roots"]] as string[],
  };
}

function validateAttestation(value: unknown): Extract<PlatformIsolationAttestation, { readonly supported: true }> {
  if (!hasExactKeys(value, ["supported", "network_isolated", "workspace_hidden", "isolation_handle"])
    || value["supported"] !== true
    || value["network_isolated"] !== true
    || value["workspace_hidden"] !== true
    || typeof value["isolation_handle"] !== "string"
    || value["isolation_handle"].length === 0
    || value["isolation_handle"].length > 240
    || /[\0\r\n]/u.test(value["isolation_handle"])) return unsupported();
  return {
    supported: true,
    network_isolated: true,
    workspace_hidden: true,
    isolation_handle: value["isolation_handle"],
  };
}

export class RestrictedNodeSandbox implements WorkerSandboxPort {
  constructor(
    private readonly process_port: RestrictedNodeProcessPort,
    private readonly isolation: PlatformIsolationAdapter,
    private readonly authority: TrustedWorkerBuildAuthorityPort,
    private readonly metadata_materialization_limits: PortMaterializationLimits,
  ) {}

  async launch(foreignInput: RestrictedWorkerLaunch): Promise<WorkerTransport> {
    if (!hasExactKeys(foreignInput, ["worker_key"])) return unsupported();
    const key = validateWorkerKey(foreignInput["worker_key"]);
    if (!validPlainPath(this.process_port.node_executable)) return unsupported();
    let metadata: TrustedWorkerBuildMetadata;
    try {
      metadata = validateMetadata(materializePortResult(
        await this.authority.resolve(key),
        this.metadata_materialization_limits,
      ), key);
    } catch {
      return unsupported();
    }
    const packageRoot = await resolvedDirectory(metadata.package_read_root);
    const entrypoint = await resolvedFile(metadata.package_entrypoint);
    const scratchPrivateRoot = await resolvedDirectory(metadata.scratch_private_root);
    const scratchRoot = await resolvedDirectory(metadata.scratch_root);
    const workspaceRoot = await resolvedDirectory(metadata.workspace_root);
    const homeRoot = await resolvedDirectory(metadata.home_root);
    const credentialRoots = await Promise.all(metadata.credential_roots.map(async (root) => resolvedDirectory(root)));
    const protectedRoots = [workspaceRoot, homeRoot, ...credentialRoots];
    if (dirname(packageRoot) === packageRoot
      || dirname(scratchPrivateRoot) === scratchPrivateRoot
      || !contains(packageRoot, entrypoint)
      || !contains(scratchPrivateRoot, scratchRoot)
      || overlaps(packageRoot, scratchPrivateRoot)
      || overlaps(packageRoot, scratchRoot)
      || protectedRoots.some((root) => overlaps(packageRoot, root) || overlaps(scratchPrivateRoot, root) || overlaps(scratchRoot, root))) return unsupported();

    const isolationRequest = deepFreeze<PlatformIsolationRequest>({
      package_read_root: packageRoot,
      scratch_root: scratchRoot,
      deny_network: true,
      hide_workspace: true,
    });
    let attestation: PlatformIsolationAttestation;
    try {
      attestation = await this.isolation.attest(isolationRequest);
    } catch {
      return unsupported();
    }
    const verified = validateAttestation(attestation);
    const specification = deepFreeze<RestrictedNodeProcessSpec>({
      runtime: "node",
      executable: this.process_port.node_executable,
      arguments: [
        "--permission",
        `--allow-fs-read=${packageRoot}`,
        `--allow-fs-write=${scratchRoot}`,
        entrypoint,
      ],
      shell: false,
      cwd: scratchRoot,
      environment: {
        NODE_ENV: "production",
        LANG: "C",
        TZ: "UTC",
        URDIRA_WORKER_PROTOCOL_VERSION: String(key.runtime_contract_version),
      },
      package_read_roots: [packageRoot],
      scratch_write_root: scratchRoot,
      permissions: {
        child_process: false,
        native_addons: false,
        worker_threads: false,
      },
      isolation: {
        network_isolated: true,
        workspace_hidden: true,
        isolation_handle: verified.isolation_handle,
      },
    });
    try {
      return await this.process_port.launch(specification);
    } catch {
      return unsupported();
    }
  }
}
