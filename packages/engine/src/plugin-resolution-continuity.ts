import type { WorkspaceDatabase } from "@urdira/storage";


/**
 * Reads back a `control_plane_state` row's typed JSON state, if one already
 * exists for `stateKey` -- used by a plugin provider's own resolution
 * (`apps/urdira/src/index.ts`'s `prepareJavascriptTypescriptRegistry`) to
 * make a workspace's `plugin_resolution_lock`/`workspace_configuration_revision`
 * genuinely stable across repeated resolutions of the same logical id,
 * instead of re-minting fresh content (with a fresh timestamp) under the
 * same deterministic key every time.
 *
 * Root cause this exists to close: `PluginResolutionLock.created_at` (and
 * this codebase's own `WorkspaceConfigurationRevision.created_at`
 * construction in `apps/urdira/src/index.ts`) are stamped from a `clock`
 * value that is fresh on every call -- but `resolution_lock_id`/
 * `configuration_revision_id` are pure functions of `workspace_id` alone,
 * with no content salt. `createResolveJavascriptTypescriptPluginProvider`'s
 * in-process `prepared` cache masks this within a single daemon process
 * lifetime (the same object is reused for every scan of a workspace while
 * the process stays up), but never persists it: a daemon restart between
 * two scans of the same, already-published workspace forces a fresh
 * resolution with a new `created_at`, under the *same* `state_key` a prior
 * scan already durably wrote -- `StorageMaintenance`'s
 * `assertPublicationImmutableRows` (`packages/storage/src/publication-authority.ts`)
 * then throws `storage:publication_conflict` on that row's very next
 * publish, since its stored payload permanently disagrees with what a fresh
 * resolution now computes. Confirmed via direct repro against a perfectly
 * ordinary (never-forked) workspace, restarting the daemon between its
 * first and second scan -- not fork-specific, though a fork's own
 * generation-1 publish (`workspace-fork.ts`'s `copyDonorAndPublish`) writes
 * these same rows too, so it surfaces there just as easily.
 */
export async function readPersistedControlState<T>(database: WorkspaceDatabase, workspaceId: string, stateKey: string): Promise<T | undefined> {
  const row = await database.database.get<{ readonly state_json: string }>("SELECT state_json FROM control_plane_state WHERE workspace_id = ? AND state_key = ?", [workspaceId, stateKey]);
  if (!row) return undefined;
  try { return JSON.parse(row.state_json) as T; } catch { return undefined; }
}

/** Same idea as {@link readPersistedControlState}, for `registry_snapshots` -- keyed by `registry_snapshot_id`, not `state_key`. */
export async function readPersistedRegistrySnapshot<T>(database: WorkspaceDatabase, workspaceId: string, registrySnapshotId: string): Promise<T | undefined> {
  const row = await database.repositories.registries.getSnapshot(registrySnapshotId);
  return row as T | undefined;
}
