import { SecurityError } from "./errors.js";
import { chmod, lstat, mkdir } from "node:fs/promises";

export interface IpcPermissionObservation { readonly mode: number; readonly owner_uid: number; readonly current_uid: number; readonly platform?: "posix" | "windows"; readonly acl_owner_only?: boolean; }
export interface PermissionCheck { readonly allowed: true; readonly owner_only: true; }
export interface StorageRootCapabilities { readonly path: string; readonly owner_only: boolean; readonly directory: boolean; readonly mode?: number; readonly owner_uid?: number; }

export function checkIpcPeerPermissions(observation: IpcPermissionObservation): PermissionCheck {
  if (observation.owner_uid !== observation.current_uid) throw new SecurityError("security:ipc_permissions_unsafe", "IPC endpoint is not owned by the current user.");
  if (observation.platform === "windows") {
    if (observation.acl_owner_only !== true) throw new SecurityError("security:ipc_permissions_unsafe", "IPC endpoint ACL is not owner-only.");
    return { allowed: true, owner_only: true };
  }
  if ((observation.mode & 0o077) !== 0) throw new SecurityError("security:ipc_permissions_unsafe", "IPC endpoint is accessible by group or other users.");
  return { allowed: true, owner_only: true };
}

export async function ensureOwnerOnlyDirectory(path: string, ownerUid?: number): Promise<StorageRootCapabilities> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const stats = await lstat(path);
  const uid = typeof stats.uid === "number" ? stats.uid : undefined;
  const mode = stats.mode & 0o777;
  if (!stats.isDirectory() || (ownerUid !== undefined && uid !== ownerUid) || (mode & 0o077) !== 0) throw new SecurityError("security:ipc_permissions_unsafe", "Storage root is not an owner-only directory.");
  return { path, owner_only: true, directory: true, mode, ...(uid !== undefined ? { owner_uid: uid } : {}) };
}

export async function inspectStorageRoot(path: string, ownerUid?: number): Promise<StorageRootCapabilities> {
  const stats = await lstat(path).catch(() => undefined);
  if (!stats) throw new SecurityError("security:ipc_permissions_unsafe", "Storage root does not exist.");
  const uid = typeof stats.uid === "number" ? stats.uid : undefined;
  const mode = stats.mode & 0o777;
  const ownerOnly = stats.isDirectory() && (ownerUid === undefined || uid === ownerUid) && (mode & 0o077) === 0;
  if (!ownerOnly) throw new SecurityError("security:ipc_permissions_unsafe", "Storage root is writable by an untrusted principal.");
  return { path, owner_only: true, directory: stats.isDirectory(), mode, ...(uid !== undefined ? { owner_uid: uid } : {}) };
}
