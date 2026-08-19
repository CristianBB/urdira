import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DaemonError } from "./errors.js";

export interface DaemonPaths { readonly data_root: string; readonly endpoint: string; readonly endpoint_descriptor: string; readonly process_lock: string; readonly last_known_good: string; }
export interface EndpointDescriptor { readonly protocol_version: number; readonly endpoint: string; readonly pid: number; readonly owner_uid: number; readonly engine_build_id: string; readonly started_at: string; readonly descriptor_digest?: string; }
export interface LastKnownGood { readonly engine_build_id: string; readonly checkpoint_id: string; readonly workspaces: ReadonlyArray<string>; readonly cursors: ReadonlyArray<string>; readonly written_at: string; readonly state_digest?: string; }

function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function currentUid(): number { return process.getuid?.() ?? 0; }
async function ownerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700);
  const stat = await import("node:fs/promises").then(({ lstat }) => lstat(path));
  if (!stat.isDirectory() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0) || (process.platform !== "win32" && stat.uid !== currentUid())) throw new DaemonError("core:daemon_recovery_failed", "Daemon data root must be an owner-only directory.");
}

export async function daemonPaths(dataRoot: string): Promise<DaemonPaths> {
  if (!dataRoot || dataRoot.includes("\0")) throw new DaemonError("core:daemon_recovery_failed", "Daemon data root is invalid.");
  await ownerOnlyDirectory(dataRoot);
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\urdira-${digest(dataRoot).slice(-24)}` : join(dataRoot, "daemon.sock");
  return { data_root: dataRoot, endpoint, endpoint_descriptor: join(dataRoot, "endpoint.json"), process_lock: join(dataRoot, "daemon.lock"), last_known_good: join(dataRoot, "last-known-good.json") };
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await ownerOnlyDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, path); await chmod(path, 0o600);
}
async function readJson(path: string): Promise<unknown | undefined> { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined; throw new DaemonError("core:daemon_recovery_failed", `Cannot read ${path}.`); } }

export class EndpointDescriptorStore {
  constructor(private readonly paths: DaemonPaths) {}
  async write(descriptor: Omit<EndpointDescriptor, "descriptor_digest">): Promise<EndpointDescriptor> { const value = { ...descriptor, descriptor_digest: digest(descriptor) }; await atomicJson(this.paths.endpoint_descriptor, value); return value; }
  async read(): Promise<EndpointDescriptor | undefined> { const value = await readJson(this.paths.endpoint_descriptor); if (value === undefined) return undefined; if (!value || typeof value !== "object" || typeof (value as { descriptor_digest?: unknown }).descriptor_digest !== "string") throw new DaemonError("core:daemon_recovery_failed", "Endpoint descriptor is incomplete."); const descriptor = value as EndpointDescriptor; if (descriptor.protocol_version !== 1 || typeof descriptor.endpoint !== "string" || typeof descriptor.pid !== "number" || !Number.isSafeInteger(descriptor.pid) || typeof descriptor.owner_uid !== "number" || typeof descriptor.engine_build_id !== "string" || typeof descriptor.started_at !== "string") throw new DaemonError("core:daemon_recovery_failed", "Endpoint descriptor fields are invalid."); const { descriptor_digest, ...unsigned } = descriptor; if (descriptor_digest !== digest(unsigned)) throw new DaemonError("core:daemon_recovery_failed", "Endpoint descriptor digest does not verify."); return descriptor; }
  async remove(): Promise<void> { await rm(this.paths.endpoint_descriptor, { force: true }); }
}

export class ProcessLock {
  private constructor(private readonly path: string, private readonly token: string) {}
  static async acquire(path: string, owner: { readonly pid: number; readonly started_at: string }): Promise<ProcessLock> {
    await ownerOnlyDirectory(dirname(path));
    const token = randomUUID();
    try { const handle = await open(path, "wx", 0o600); await handle.writeFile(`${JSON.stringify({ ...owner, token })}\n`); await handle.close(); return new ProcessLock(path, token); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      const existing = await readJson(path);
      const pid = existing && typeof existing === "object" && typeof (existing as { pid?: unknown }).pid === "number" ? (existing as { pid: number }).pid : undefined;
      if (pid !== undefined && isProcessAlive(pid)) throw new DaemonError("core:daemon_already_running", `Daemon process ${pid} already owns the lock.`);
      await rm(path, { force: true });
      return ProcessLock.acquire(path, owner);
    }
  }
  async release(): Promise<void> { const current = await readJson(this.path); if (current && typeof current === "object" && (current as { token?: unknown }).token === this.token) await rm(this.path, { force: true }); }
}

function isProcessAlive(pid: number): boolean { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return !(error && typeof error === "object" && "code" in error && (error.code === "ESRCH" || error.code === "EINVAL")); } }

export class LastKnownGoodStore {
  constructor(private readonly paths: DaemonPaths) {}
  async write(state: Omit<LastKnownGood, "state_digest">): Promise<LastKnownGood> { const value = { ...state, state_digest: digest(state) }; await atomicJson(this.paths.last_known_good, value); return value; }
  async read(): Promise<LastKnownGood | undefined> { const value = await readJson(this.paths.last_known_good); if (value === undefined) return undefined; if (!value || typeof value !== "object" || typeof (value as { state_digest?: unknown }).state_digest !== "string") throw new DaemonError("core:daemon_recovery_failed", "Last-known-good checkpoint is incomplete."); const { state_digest, ...unsigned } = value as LastKnownGood; if (state_digest !== digest(unsigned)) throw new DaemonError("core:daemon_recovery_failed", "Last-known-good checkpoint digest does not verify."); return value as LastKnownGood; }
  async verify(expected: { readonly engine_build_id: string }): Promise<LastKnownGood | undefined> { const state = await this.read(); if (state && state.engine_build_id !== expected.engine_build_id) throw new DaemonError("core:daemon_restart_required", `Checkpoint requires engine build ${state.engine_build_id}, not ${expected.engine_build_id}.`); return state; }
}
