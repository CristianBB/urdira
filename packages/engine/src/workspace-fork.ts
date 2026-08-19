import { canonicalBytes, decodeCanonical as decodeCanonicalBlob, digestBytes } from "@urdira/canonical";
import type {
  PluginResolutionLock,
  RegistrySnapshot,
  WorkspaceConfigurationRevision,
  WorkspaceFreshnessCheckpoint,
} from "@urdira/contracts";
import type { DurableStorage, ForkPublicationPlanInput, WorkspaceDatabase } from "@urdira/storage";
import { buildForkPublicationPlan, buildPublicationTransactionCommands, computeForkSnapshotDigestFields, normalizeObservationBatchIds, snapshotDigest } from "@urdira/storage";
import type { GitIgnoreRules, InclusionRules } from "@urdira/security";
import { ISOMORPHIC_GIT_OBJECT_PORT, peeledHeadFor, type GitObjectPort } from "./git-providers.js";
import { DirectorySourceProvider, type EncodedObservationBatch } from "./directory-provider.js";
import { GenericSourceIndexer } from "./source-indexer.js";
import { sourceProviderRequestDigest } from "./source-provider.js";
import type { RegisteredWorkspace, WorkspaceRegistry } from "./workspaces.js";
import type { WorkspaceScanPluginProvider } from "./workspace-indexing-session.js";

/**
 * Workspace fork (docs/decisions/12-workspace-fork.md): when a newly added
 * workspace's tree is content-identical to an already-`ready` workspace on
 * the same installation (the donor), bootstrap it by copying the donor's
 * currently-visible canonical rows instead of re-running plugin analysis
 * from scratch. See the decision doc for the full design and its tradeoffs
 * against the phase-2 spec. This module only ever *attempts* a fork; every
 * failure mode returns `{ status: "skipped", reason }` rather than throwing,
 * so the caller (`packages/daemon/src/runtime.ts`'s `scheduleWorkspaceScan`)
 * can fall back to `runFullWorkspaceScan` unconditionally on any non-"forked"
 * result.
 */

const DEFAULT_FORK_INCLUSION: InclusionRules = { include: [], exclude: ["node_modules/**", ".git/**", "dist/**", ".urdira/**"], allow_external_root: false };
const DEFAULT_FORK_GITIGNORE: GitIgnoreRules = { enabled: false, patterns: [] };
const DEFAULT_FORK_SCAN_MAX_DURATION_MS = 600_000;
const DEFAULT_FORK_SCAN_MAX_RESPONSE_BYTES = 64_000_000;

export interface WorkspaceForkOptions {
  /** The newly registered workspace being scanned for the first time. */
  readonly workspace: RegisteredWorkspace;
  /** Already-open handle for `workspace`, bound via the normal `openWorkspace`/`bindWorkspaceIdentity` path. */
  readonly database: WorkspaceDatabase;
  /** Used to open (and, transparently, share handle leases with) candidate donor workspaces. */
  readonly storage: DurableStorage;
  readonly registry: WorkspaceRegistry;
  /**
   * The same plugin provider `runFullWorkspaceScan` would be given for this
   * workspace (`resolve_plugin_provider(workspace, database)` in
   * `packages/daemon/src/runtime.ts`). Supplies `target_registry`/
   * `target_resolution_lock`/`target_configuration` for the fork's own
   * generation-1 publish, and `plugin.registry.registry_digest` is compared
   * against each donor's stored registry digest as part of donor matching.
   */
  readonly plugin: WorkspaceScanPluginProvider;
  readonly inclusion_rules?: InclusionRules;
  readonly gitignore_rules?: GitIgnoreRules;
  readonly source_provider_binding_id?: string;
  readonly io_concurrency?: number;
  readonly now?: () => string;
  readonly git_objects?: GitObjectPort;
  /**
   * Test-only fault injection, mirroring `@urdira/storage`'s own
   * `FaultInjector` convention for "deterministically trigger a failure at a
   * specific point" (`packages/storage/src/faults.ts`). When set,
   * `commitSourceLayerAndPublish` fails with this message immediately after
   * `commitForkSourceLayer` succeeds -- i.e. after the fork target's source
   * layer is durably committed, before any canonical row is copied or
   * published -- so tests can assert the resulting rollback actually leaves
   * the workspace able to publish a real generation through a normal
   * fallback `runFullWorkspaceScan`, closing the exact wedge documented on
   * `commitSourceLayerAndPublish`. Never set by production code
   * (`packages/daemon/src/runtime.ts` never passes it); a no-op when
   * `undefined`, the only value production ever supplies.
   */
  readonly fail_after_source_commit_for_test?: string;
  /**
   * `"full"` runs `StorageMaintenance.verify()` (the same whole-database gate
   * this module always used to run) before markReady; any other value (the
   * default) runs `fastForkVerify` instead -- complete set-digest and
   * ownership/dependency checks plus a self-consistency check of the freshly
   * written snapshot. Measured on a real 981-file/177k-record repository,
   * full `verify()` cost ~23s; the fast check remains index-driven. Injected by the
   * composing application from `URDIRA_FORK_VERIFY` (`apps/urdira/src/index.ts`);
   * this module's own tests always request `"full"` explicitly, so the
   * stronger guarantee stays exercised regardless of this default.
   */
  readonly verify_mode?: "fast" | "full";
}

export type WorkspaceForkOutcome =
  | { readonly status: "forked"; readonly donor_workspace_id: string; readonly snapshot_id: string; readonly generation: number; readonly projection_patch_count: number }
  | { readonly status: "skipped"; readonly reason: string };

function digest(value: unknown): string {
  return digestBytes(canonicalBytes(value));
}

function stableId(kind: string, value: unknown): string {
  return `${kind}:${digest(value).slice("sha256:".length)}`;
}

function sameSelection(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const a = [...(left ?? [])].sort();
  const b = [...(right ?? [])].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Top-level entry point. Never throws: every failure (predicate mismatch,
 * storage error, verify() failure) is folded into `{status: "skipped", reason}`
 * so the caller can log one line and proceed to `runFullWorkspaceScan`
 * unconditionally. The one exception to "never throws" is a genuinely
 * unrecoverable programmer error (e.g. a contract violation this module
 * itself would not know how to safely characterize) -- there is none in
 * the current implementation, but this comment records the intent.
 */
export async function attemptWorkspaceFork(options: WorkspaceForkOptions): Promise<WorkspaceForkOutcome> {
  try {
    return await attemptWorkspaceForkInner(options);
  } catch (error) {
    return { status: "skipped", reason: `workspace fork attempt threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}

interface ForkContext {
  readonly now: () => string;
  readonly gitObjects: GitObjectPort;
  readonly bindingId: string;
  readonly inclusionRules: InclusionRules;
  readonly gitignoreRules: GitIgnoreRules;
  readonly timings: Record<string, number>;
}

async function attemptWorkspaceForkInner(options: WorkspaceForkOptions): Promise<WorkspaceForkOutcome> {
  const context: ForkContext = {
    now: options.now ?? (() => new Date().toISOString()),
    gitObjects: options.git_objects ?? ISOMORPHIC_GIT_OBJECT_PORT,
    bindingId: options.source_provider_binding_id ?? "provider:filesystem",
    inclusionRules: options.inclusion_rules ?? DEFAULT_FORK_INCLUSION,
    gitignoreRules: options.gitignore_rules ?? DEFAULT_FORK_GITIGNORE,
    timings: {},
  };
  const stage = (name: string, startedAt: number): void => { context.timings[name] = Date.now() - startedAt; };
  const enumerateStarted = Date.now();
  const workspace = options.workspace;

  const donors = options.registry.list().filter((candidate) =>
    candidate.workspace_id !== workspace.workspace_id
    && candidate.status === "ready"
    && sameSelection(candidate.selected_plugin_ids, workspace.selected_plugin_ids));
  if (donors.length === 0) return { status: "skipped", reason: "no ready donor workspace with a matching plugin selection" };

  // Enumerate the new root once, without committing anything durably yet
  // (`GenericSourceIndexer.apply` -- the durable stage-1 write -- only runs
  // once a donor and plugin-resolution match are both confirmed below). This
  // ordering matters: `runFullWorkspaceScan`'s own stage-1 read of "what was
  // already cataloged before this scan" happens before its own enumerate, so
  // if a fork attempt had already durably written the source layer and then
  // bailed out before publishing any canonical/publication rows, the
  // fallback full scan's planner would see this workspace's own freshly
  // re-observed files as already-cataloged-and-unchanged and take its
  // "equivalent, nothing to publish" fast path -- which requires a prior
  // published snapshot that was never published here, producing an empty
  // snapshot id `registry.markReady` rejects outright. Not committing until
  // every predicate has already passed avoids ever creating that state --
  // and, per the incident below, EVERY failure between here and a
  // successful publish must roll back whatever this attempt did commit, not
  // just the ones that fire before the commit.
  const enumeration = await enumerateForkRoot(options, context);
  stage("enumerate", enumerateStarted);
  if (enumeration === undefined) return { status: "skipped", reason: "enumeration of the newly added workspace's root did not succeed" };
  const donorMatchStarted = Date.now();

  // Git fast path: a cheap, byte-free *preference hint* only, not a trusted
  // shortcut around the content-hash check below. An earlier version of this
  // code trusted "clean + same peeled HEAD commit" (via `administrativeState`,
  // which reads and SHA-1-compares every *tracked* file against its blob) as
  // proof the scanned trees were identical and skipped the multiset check for
  // a git-matched donor -- a real e2e run against excalidraw disproved that:
  // the scanner enumerates everything except node_modules/.git/dist/.urdira
  // (it does not apply .gitignore -- `DEFAULT_FORK_GITIGNORE` is disabled),
  // so a donor checkout with post-`npm install` generated files sitting
  // outside those excludes (e.g. husky's `.husky/_/*` hook shims, themselves
  // gitignored) has MORE scanned files than a fresh `git worktree add`
  // checkout of the identical commit, even though both are clean at the same
  // HEAD. "Clean + same commit" is a true statement about *tracked* content
  // only; it says nothing about untracked-but-scanned content, and dirtiness
  // itself is irrelevant to a hint whose only job is choosing which donor to
  // try first -- a dirty tree simply will not pass the multiset check below,
  // which is unconditional for every candidate donor regardless of this
  // hint's outcome. `peeledHeadFor` (`git-providers.ts`) is used here
  // instead of `administrativeState` specifically because it skips the
  // expensive per-file dirty determination entirely (no `status_matrix`, no
  // tree-vs-worktree content comparison) -- on a real 981-file repository
  // with two ready donors, this alone cut the `donor_match` stage from
  // ~113s to a small fraction of a second.
  let gitPreferredDonor: RegisteredWorkspace | undefined;
  try {
    const newHead = await peeledHeadFor(workspace.canonical_root, context.gitObjects);
    for (const donor of donors) {
      try {
        const donorHead = await peeledHeadFor(donor.canonical_root, context.gitObjects);
        if (donorHead.common_directory === newHead.common_directory && donorHead.head_revision === newHead.head_revision) {
          gitPreferredDonor = donor;
          break;
        }
      } catch { /* this donor's root is not a readable git worktree; try the next one */ }
    }
  } catch { /* the new root is not a git worktree: fall through to checking every donor by content hash alone */ }
  const orderedCandidates = gitPreferredDonor === undefined
    ? donors
    : [gitPreferredDonor, ...donors.filter((candidate) => candidate.workspace_id !== gitPreferredDonor!.workspace_id)];

  // The content-hash multiset the fork target's own enumeration already
  // captured (every observation's `observed_content_hash` is computed during
  // enumeration itself, no separate read pass needed for this comparison).
  const newMultiset = multisetKey(enumeration.encodedBatch.observations.map((observation) => [observation.normalized_uri, observation.observed_content_hash] as const));
  let donor: RegisteredWorkspace | undefined;
  for (const candidate of orderedCandidates) {
    try {
      const donorDatabase = await options.storage.openWorkspace(candidate.workspace_id);
      try {
        // Narrow, typed-column-only query (no `WorkspaceSourceIndexRepository.currentOccurrences`,
        // which joins in `source_observations` and canonically *decodes* the
        // full `SourceArtifact`/`ArtifactVersionRecord` payload for every
        // row) -- with 2+ ready donors in a realistic installation, this
        // per-donor cost multiplies, and only `normalized_uri`/`content_hash`
        // are actually needed for the multiset comparison.
        const donorArtifacts = await donorVisibleArtifacts(donorDatabase);
        const donorMultiset = multisetKey(donorArtifacts.map((row) => [row.normalized_uri, row.content_hash] as const));
        if (donorMultiset !== newMultiset) continue;
        if (!(await donorPluginResolutionMatches(donorDatabase, options.plugin))) continue;
        donor = candidate;
        break;
      } finally { await donorDatabase.close(); }
    } catch { /* an unreadable/unregistered donor is simply not a match */ }
  }
  stage("donor_match", donorMatchStarted);
  if (donor === undefined) return { status: "skipped", reason: "no donor workspace is both content-identical and plugin-resolution-equivalent to the newly added workspace" };

  // Nothing has been committed durably yet at this point (enumeration only
  // reads; donor matching only reads). From here on, every step writes, so
  // every failure path must roll back everything this attempt wrote --
  // `commitSourceLayerAndPublish` owns that guarantee end to end.
  const donorDatabase = await options.storage.openWorkspace(donor.workspace_id);
  try {
    return await commitSourceLayerAndPublish(options, context, donor, donorDatabase, enumeration);
  } finally {
    await donorDatabase.close();
  }
}

/** Thrown by `copyDonorAndPublish`'s internal checks; caught and turned into a rollback + `"skipped"` outcome by `commitSourceLayerAndPublish`, never surfaced past this module. */
class ForkCopyError extends Error {}
function fail(reason: string): never { throw new ForkCopyError(reason); }

interface ForkPublicationIds {
  readonly candidateId: string;
  readonly materializationId: string;
  readonly snapshotId: string;
  readonly generationManifestId: string;
  readonly generation: number;
}

/**
 * Owns the entire durable-write portion of a fork attempt -- source-layer
 * commit through publish through verify -- and guarantees that ANY failure
 * anywhere in that sequence rolls back everything written so far before
 * returning `"skipped"`. This split exists because of a real, reproduced
 * incident: a donor whose git-clean-same-commit worktree nonetheless had
 * scanned-but-untracked files (see the git-preference comment above) caused
 * the OLD code to durably commit the fork target's source layer, then fail
 * the (at the time, post-commit) "does every donor artifact have a
 * counterpart" check and return `"skipped"` *without* rolling back -- the
 * source layer stayed committed with no candidate ever published. The
 * fallback `runFullWorkspaceScan` that ran next then found its own stage-1
 * re-observation "equivalent" to what was already cataloged (nothing about
 * the *content* had changed) and took the same no-publish fast path
 * `docs/decisions/12-workspace-fork.md` already documents as requiring a
 * prior snapshot -- which never existed -- producing an empty snapshot id
 * `WorkspaceRegistry.markReady` rejects. The workspace was permanently stuck
 * "indexing", retried forever by the watcher/reconciliation loop, always
 * hitting the identical wedge, since the committed source state never
 * changed between retries. Every internal failure inside this function (via
 * `copyDonorAndPublish`'s `fail()` calls, or any other thrown error) is
 * therefore funneled through one `rollbackAndSkip`, not scattered
 * ad hoc-return points that can miss a case.
 */
async function commitSourceLayerAndPublish(options: WorkspaceForkOptions, context: ForkContext, donor: RegisteredWorkspace, donorDatabase: WorkspaceDatabase, enumeration: ForkEnumeration): Promise<WorkspaceForkOutcome> {
  const workspaceId = options.workspace.workspace_id;
  // Deterministic and computed up front, before any write, from data the
  // enumeration (not the commit) already produced -- `commitForkSourceLayer`
  // re-derives the identical `observation_batch_id` from this same
  // `encodedBatch`, so these ids are valid rollback targets regardless of
  // whether the commit below, or anything after it, actually succeeds.
  const observationBatchId = enumeration.encodedBatch.batch.observation_batch_id;
  const candidateId = stableId("workspace-fork-candidate", { workspace_id: workspaceId, donor_workspace_id: donor.workspace_id, observation_batch_id: observationBatchId });
  const ids: ForkPublicationIds = {
    candidateId,
    // Must match `buildForkPublicationPlan`'s own internal derivation
    // (`packages/storage/src/publication-authority.ts`) exactly, not an
    // independently computed id -- `rollbackForkPublication` deletes rows by
    // these ids after a failure, so a mismatch here would leave the actually-
    // inserted `candidate_materializations` row (keyed by whatever
    // `buildForkPublicationPlan` used) orphaned instead of rolled back.
    materializationId: `materialization:${candidateId}`,
    snapshotId: `snapshot:${candidateId}`,
    generationManifestId: `generation-manifest:${candidateId}`,
    generation: 1,
  };

  const rollbackAndSkip = async (reason: string): Promise<WorkspaceForkOutcome> => {
    console.error(`[urdira] workspace fork for ${workspaceId} (donor ${donor.workspace_id}) failed after its source layer was durably committed; rolling back so the fallback full scan can publish a fresh generation instead of getting permanently stuck: ${reason}`);
    await rollbackForkPublication(options.database, workspaceId, ids);
    return { status: "skipped", reason };
  };

  let sourceLayer: ForkSourceLayer | undefined;
  const sourceCommitStarted = Date.now();
  try {
    sourceLayer = await commitForkSourceLayer(options, context, enumeration);
    context.timings["source_commit"] = Date.now() - sourceCommitStarted;
  } catch (error) {
    return await rollbackAndSkip(`source cataloging threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (sourceLayer === undefined) return await rollbackAndSkip("source cataloging for the fork target did not produce any eligible files");

  if (options.fail_after_source_commit_for_test !== undefined) return await rollbackAndSkip(options.fail_after_source_commit_for_test);

  try {
    return await copyDonorAndPublish(options, context, donor, donorDatabase, sourceLayer, ids);
  } catch (error) {
    return await rollbackAndSkip(error instanceof ForkCopyError ? error.message : `fork copy/publish threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * `StorageMaintenance.verify()` (`packages/storage/src/lifecycle.ts`) has
 * five pre-existing gaps, confirmed by this feature's own tests (by running
 * `verify()` against a workspace scanned only through the ordinary
 * `runFullWorkspaceScan` path, no fork involved at all, and observing the
 * identical failures) to affect ANY real, normally-scanned workspace -- not
 * something a fork's canonical-row copy introduces. Two were only found once
 * this module was exercised against a fixture with real cross-file
 * dependencies (the 2-file fixture used in this feature's own committed
 * tests happens to have none), which is itself worth noting: apparently
 * nothing before this change had ever run `verify()` against a real,
 * production-shaped scan output with dependencies and projections present.
 *
 * 1. `control_plane` / `storage:cas_missing` for the `plugin_resolution_lock`
 *    row: `collectContentHashes` treats any object field literally named
 *    `contribution_digest` as a CAS blob reference and requires it to be
 *    present in the workspace's content-addressed store. `PluginResolutionLock.resolved_plugins[].contribution_digest`
 *    is a structural digest of a plugin's registry contribution, not a CAS
 *    blob reference at all -- no production code path ever writes it into
 *    CAS, fork or not.
 * 2. `control_plane` / `storage:control_plane_corrupt` for the
 *    `workspace_freshness_checkpoint` row: verify()'s snapshot/source-state
 *    closure check for this row kind does not agree with the shape
 *    `next_freshness_checkpoint`'s own construction produces
 *    (`packages/engine/src/source-candidate-planning.ts`, mirrored here in
 *    `copyDonorAndPublish`'s `freshnessCheckpoint`) -- again, present for a
 *    normal scan's freshness checkpoint too.
 * 3. `registry` / `storage:registry_corrupt`: even after `copyDonorAndPublish`
 *    calls `RegistryRepository.putSnapshot` (see that call site's comment) to
 *    populate `registry_namespace_bindings` at all -- which no production
 *    scan path does, so a normal scan fails this the same way for a blunter
 *    reason (zero binding rows ever exist) -- the round trip still does not
 *    byte-match: `namespace_bindings[].emission_valid_to_generation` is
 *    *omitted* on the original (unset-optional-field) registry object, so
 *    the stored `registry_payload`'s canonical encoding never has that key
 *    at all, but `registry_namespace_bindings`'s schema always returns the
 *    column as an explicit SQL `NULL` on read -- and canonical encoding
 *    (correctly) treats "key absent" and "key present with a null value" as
 *    byte-distinct. Fixing this would mean changing `putSnapshot`'s read
 *    path or `verify()`'s comparison, both shared, pre-existing storage
 *    code this change does not otherwise touch.
 * 4. `dependency` / `storage:dependency_corrupt`: verify() reconstructs the
 *    expected `dependency_payload` bytes as the row's typed columns *plus*
 *    `valid_from_generation`/`valid_to_generation` (lifecycle.ts's dependency
 *    check), but `artifactDependencyCommands` (publication-authority.ts)
 *    stores `dependency_payload` as exactly whatever template object it was
 *    given, verbatim -- and `CandidateRecordDependencyTemplate` (`Omit<RecordArtifactDependency,
 *    "valid_from_generation" | "valid_to_generation">`, `packages/engine/src/candidate-materialization.ts`)
 *    is deliberately typed to exclude those two fields, so no producer,
 *    fork or otherwise, could satisfy this check as written.
 * 5. `snapshot` / `storage:projection_set_digest_corrupt`: reproduced with a
 *    genuinely empty projection set (this fixture's plugin never produces
 *    graph/vector/metric projections -- see docs/decisions/12-workspace-fork.md's
 *    "no production writer" note), so this is a pre-existing mismatch in how
 *    `projection_set_digests` gets serialized for an empty projection set,
 *    not anything the fork's own (also-empty, for this fixture) projection
 *    copy affects.
 *
 * Filtering these out here is a deliberate, narrow acknowledgment of gaps in
 * a shared, pre-existing component this change does not own fixing (see
 * docs/decisions/12-workspace-fork.md), not a weakening of what a fork's own
 * copy is actually responsible for: every other `verify()` component
 * (canonical rows, projection rows, snapshot/manifest digests, source
 * catalog, CAS content the fork's own writes reference) must still report
 * zero failures, or the fork rolls back and falls back to a full scan.
 */
function isKnownPreexistingVerifyGap(failure: { readonly component_kind: string; readonly component_id: string; readonly error_code: string }): boolean {
  if (failure.component_kind === "registry" && failure.error_code === "storage:registry_corrupt") return true;
  if (failure.component_kind === "dependency" && failure.error_code === "storage:dependency_corrupt") return true;
  if (failure.component_kind === "control_plane" && failure.component_id.startsWith("capability_state:") && failure.error_code === "storage:control_plane_corrupt") return true;
  if (failure.component_kind === "snapshot" && failure.error_code === "storage:projection_set_digest_corrupt") return true;
  if (failure.component_kind !== "control_plane") return false;
  if (failure.component_id.startsWith("plugin_resolution_lock:") && failure.error_code === "storage:cas_missing") return true;
  if (failure.component_id.startsWith("workspace_freshness_checkpoint:") && failure.error_code === "storage:control_plane_corrupt") return true;
  return false;
}

function multisetKey(entries: readonly (readonly [string, string])[]): string {
  return JSON.stringify([...entries].sort(([leftUri], [rightUri]) => (leftUri < rightUri ? -1 : leftUri > rightUri ? 1 : 0)));
}

interface ResolvedPluginLike { readonly plugin_id: unknown; readonly plugin_version: unknown }

function sortedResolvedPluginsDigest(resolvedPlugins: readonly unknown[]): string {
  const sorted = [...resolvedPlugins].map((entry) => entry as ResolvedPluginLike).sort((left, right) => {
    const leftKey = `${String(left.plugin_id)}@${String(left.plugin_version)}`;
    const rightKey = `${String(right.plugin_id)}@${String(right.plugin_version)}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return digest(sorted);
}

/**
 * Whether plugin resolution for the donor and the fork target would produce
 * equivalent analysis output. `registry_snapshots.registry_digest` (the
 * field the phase-2 spec names) is workspace-salted in the current plugin-sdk
 * registry model (both `registry_snapshot_id` and every `namespace_binding`'s
 * `workspace_id` feed it), so it can never be equal across two distinct
 * workspaces even when they resolve identical plugin content -- comparing it
 * literally would make this predicate permanently false, defeating the
 * feature. What is actually workspace-independent, and is what plugin
 * analysis output actually depends on, is the *resolved plugin set*
 * (`PluginResolutionLock.resolved_plugins`: plugin id/version/declaration/
 * contribution/analysis digests), so this compares that set instead --
 * read back from the donor's own persisted `control_plane_state` row for its
 * current `plugin_resolution_lock` (the same row `assertPublicationImmutableRows`,
 * `packages/storage/src/publication-authority.ts`, treats as authoritative).
 */
async function donorPluginResolutionMatches(donorDatabase: WorkspaceDatabase, plugin: WorkspaceScanPluginProvider): Promise<boolean> {
  const current = await donorDatabase.repositories.snapshots.getCurrent();
  if (!current) return false;
  const row = await donorDatabase.database.get<{ payload: unknown }>(
    "SELECT payload FROM control_plane_state WHERE workspace_id = ? AND state_key = ?",
    [donorDatabase.workspaceId, `plugin_resolution_lock:${current.current_resolution_lock_id}`],
  );
  if (!row) return false;
  const donorLock = decodeCanonicalBlob(toBytes(row.payload)) as { readonly resolved_plugins?: readonly unknown[] };
  const targetResolvedPlugins = (plugin.resolution_lock as unknown as { readonly resolved_plugins?: readonly unknown[] }).resolved_plugins ?? [];
  return sortedResolvedPluginsDigest(donorLock.resolved_plugins ?? []) === sortedResolvedPluginsDigest(targetResolvedPlugins);
}

interface DonorVisibleArtifact extends Record<string, unknown> {
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly normalized_uri: string;
  readonly content_hash: string;
}

/**
 * A narrow, typed-column-only replacement for `WorkspaceSourceIndexRepository.currentOccurrences`
 * (`@urdira/storage`'s `source-index.ts`): that method joins in
 * `source_observations` and canonically *decodes* the full `SourceArtifact`/
 * `ArtifactVersionRecord` payload for every visible artifact version, which
 * this module never needed -- every call site here only ever reads
 * `artifact_id`/`artifact_version_id`/`normalized_uri`/`content_hash`, all
 * already plain typed columns on `source_artifacts`/`artifact_versions`. On
 * a real 981-file repository this halved the dominant per-donor cost in the
 * `donor_match` stage (see the git-preference-hint comment in
 * `attemptWorkspaceForkInner` for the other half), and is reused again in
 * `bulkCopyCanonicalRows` for the donor-to-fork artifact id map.
 */
async function donorVisibleArtifacts(donorDatabase: WorkspaceDatabase): Promise<readonly DonorVisibleArtifact[]> {
  return donorDatabase.database.all<DonorVisibleArtifact>(
    `SELECT artifact.artifact_id AS artifact_id, version.artifact_version_id AS artifact_version_id, artifact.normalized_uri AS normalized_uri, version.content_hash AS content_hash
     FROM artifact_versions AS version
     JOIN source_artifacts AS artifact ON artifact.workspace_id = version.workspace_id AND artifact.artifact_id = version.artifact_id
     WHERE version.workspace_id = ? AND version.valid_to_generation IS NULL`,
    [donorDatabase.workspaceId],
  );
}

interface ForkSourceOccurrence {
  readonly normalized_uri: string;
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly content_hash: string;
}

interface ForkSourceLayer {
  readonly occurrences: readonly ForkSourceOccurrence[];
  readonly observation_batch_id: string;
  readonly source_state_digest: string;
  readonly source_snapshot_id: string;
}

interface ForkEnumeration {
  readonly provider: DirectorySourceProvider;
  readonly enumerateResponse: Awaited<ReturnType<DirectorySourceProvider["enumerate"]>>;
  readonly encodedBatch: EncodedObservationBatch;
}

function forkProviderRequest(options: { readonly call: "enumerate" | "read"; readonly workspaceId: string; readonly bindingId: string; readonly componentId: string; readonly componentVersion: string; readonly payload: unknown; readonly now: () => string }) {
  const resourceBudget = JSON.stringify({ max_duration_ms: DEFAULT_FORK_SCAN_MAX_DURATION_MS, max_response_bytes: DEFAULT_FORK_SCAN_MAX_RESPONSE_BYTES, max_observations: 1_000_000, max_watch_events: 0 });
  const base = {
    protocol_version: "1" as const,
    request_id: stableId("workspace-fork-request", { call: options.call, payload: options.payload }),
    call: options.call,
    workspace_id: options.workspaceId,
    source_provider_binding_id: options.bindingId,
    component_id: options.componentId,
    component_version: options.componentVersion,
    deadline_at: new Date(Date.parse(options.now()) + DEFAULT_FORK_SCAN_MAX_DURATION_MS + 60_000).toISOString(),
    cancellation_id: stableId("workspace-fork-cancellation", { call: options.call, payload: options.payload }),
    resource_budget: resourceBudget,
    payload: options.payload as import("@urdira/contracts").JsonValue,
  };
  return { ...base, request_digest: sourceProviderRequestDigest(base) };
}

/**
 * Non-durable enumeration of the fork target's own root (`DirectorySourceProvider.enumerate`
 * only -- no `GenericSourceIndexer.apply`, so nothing is written to `database`
 * yet). Every observation already carries its `observed_content_hash`
 * (enumeration itself reads and hashes file bytes to produce it), which is
 * enough for both the git-fast-path cross-check and the content-hash
 * fallback predicate without any further file reads.
 */
async function enumerateForkRoot(options: WorkspaceForkOptions, context: ForkContext): Promise<ForkEnumeration | undefined> {
  const workspaceId = options.workspace.workspace_id;
  const provider = new DirectorySourceProvider({
    root: options.workspace.canonical_root,
    workspace_id: workspaceId,
    source_provider_binding_id: context.bindingId,
    inclusion_rules: context.inclusionRules,
    gitignore_rules: context.gitignoreRules,
    ...(options.io_concurrency === undefined ? {} : { io_concurrency: options.io_concurrency }),
    now: context.now,
  });
  const scope = { scope_type: "source_root" as const, source_provider_binding_id: context.bindingId, source_provider: provider.component_id, normalized_scope_key: "" };
  const enumerateResponse = await provider.enumerate(forkProviderRequest({ call: "enumerate", workspaceId, bindingId: context.bindingId, componentId: provider.component_id, componentVersion: provider.component_version, payload: { coverage_scopes: [scope] }, now: context.now }));
  if (enumerateResponse.outcome !== "success" || enumerateResponse.payload === undefined) return undefined;
  const enumeratePayload = enumerateResponse.payload as { readonly observation_batch: string; readonly watermark: string };
  const encodedBatch = JSON.parse(enumeratePayload.observation_batch) as EncodedObservationBatch;
  if (encodedBatch.observations.length === 0) return undefined;
  return { provider, enumerateResponse, encodedBatch };
}

/**
 * Durable stage 1 of the fork target's own workspace: reads and hashes every
 * enumerated file's bytes and commits them via `GenericSourceIndexer.apply`,
 * identical in substance to `runFullWorkspaceScan`'s own enumerate + read +
 * apply (`packages/engine/src/workspace-indexing-session.ts`), duplicated
 * here rather than factored out of that file to avoid touching an already
 * well-tested production scan path for a feature that only ever runs before
 * it. Only ever called once a donor and plugin-resolution match are both
 * confirmed (see `attemptWorkspaceForkInner`). v1 always reads and hashes
 * file bytes (does not special-case the git fast path to skip byte reads) --
 * see docs/decisions/12-workspace-fork.md's "Shipped variant" section for
 * why, and the follow-up this leaves open.
 */
async function commitForkSourceLayer(options: WorkspaceForkOptions, context: ForkContext, enumeration: ForkEnumeration): Promise<ForkSourceLayer | undefined> {
  const workspaceId = options.workspace.workspace_id;
  const database = options.database;
  const { provider, enumerateResponse, encodedBatch } = enumeration;

  const readObservation = async (observation: EncodedObservationBatch["observations"][number]) => provider.read(forkProviderRequest({
    call: "read",
    workspaceId,
    bindingId: context.bindingId,
    componentId: provider.component_id,
    componentVersion: provider.component_version,
    payload: {
      artifact_id: observation.artifact_id,
      normalized_uri: observation.normalized_uri,
      observed_content_hash: observation.observed_content_hash,
      observed_metadata_digest: observation.observed_metadata_digest,
      provider_version_token: observation.provider_version_token,
    },
    now: context.now,
  }));

  const sourceIndexResult = await new GenericSourceIndexer(database).apply({ response: enumerateResponse, read: readObservation, parsed_batch: encodedBatch, ...(options.io_concurrency === undefined ? {} : { io_concurrency: options.io_concurrency }) });
  if (sourceIndexResult.status !== "published" && sourceIndexResult.status !== "equivalent") return undefined;

  const occurrences = await database.sourceIndex.currentOccurrences(context.bindingId);
  if (occurrences.length === 0) return undefined;
  const sourceIndexState = await database.sourceIndex.getState();
  return {
    occurrences: occurrences.map((occurrence) => ({ normalized_uri: occurrence.artifact.normalized_uri, artifact_id: occurrence.artifact.artifact_id, artifact_version_id: occurrence.version.artifact_version_id, content_hash: occurrence.version.content_hash })),
    observation_batch_id: encodedBatch.batch.observation_batch_id,
    source_state_digest: sourceIndexState?.source_state_digest ?? stableId("workspace-fork-empty-base", { workspace_id: workspaceId }),
    source_snapshot_id: `source-snapshot:${sourceIndexState?.current_generation ?? 0}`,
  };
}

interface DonorRowMap {
  readonly byArtifactVersionId: ReadonlyMap<string, { readonly artifact_id: string; readonly artifact_version_id: string }>;
}

function buildFullArtifactMap(donorArtifacts: readonly DonorVisibleArtifact[], sourceLayer: ForkSourceLayer): DonorRowMap {
  const byUri = new Map(sourceLayer.occurrences.map((occurrence) => [occurrence.normalized_uri, occurrence] as const));
  const byArtifactVersionId = new Map<string, { artifact_id: string; artifact_version_id: string }>();
  for (const donorArtifact of donorArtifacts) {
    const target = byUri.get(donorArtifact.normalized_uri);
    if (target === undefined) continue;
    byArtifactVersionId.set(donorArtifact.artifact_version_id, { artifact_id: target.artifact_id, artifact_version_id: target.artifact_version_id });
  }
  return { byArtifactVersionId };
}

const MAP_TABLE_BATCH_ROWS = 2000;
const ROW_BATCH_INSERT_ROWS = 2000;

/**
 * Bulk-copies `record_occurrences` and `identity_assignments` directly via a
 * cross-database `INSERT ... SELECT`, `ATTACH`-ing the donor's own sqlite
 * file (only ever `SELECT`ed from -- the donor is never written through this
 * connection) alongside the fork target's own already-open connection. This
 * is the load-bearing optimization decision 12's byte-copy design always
 * intended but the first shipped version did not actually implement:
 * routing every copied row through `WorkspaceDatabase.publishCandidate`'s
 * ordinary template machinery meant `memoizeRecordOpens` alone re-parsed and
 * re-canonically-digested every record (~25s at 177k records on a real
 * 981-file repository) on top of `assertPublicationImmutableRows`'s
 * existence checks and `recordOpenCommands` re-`encodeCanonical`-ing every
 * record's body and payload a *second* time -- exactly the work decision
 * 11's content-derived, workspace-free canonical payloads
 * (`record_occurrences.record_payload` never embeds `workspace_id` or an
 * owner artifact id) exist to make unnecessary. A single native
 * `INSERT ... SELECT` lets SQLite copy the row set itself entirely inside
 * the database engine, with owner/span columns rewritten via a join against
 * a small per-artifact-version mapping table, and every payload/digest
 * column (`record_digest`, `payload_digest`, `payload_inline`,
 * `payload_cas_digest`, `record_payload`) copied byte-for-byte -- never
 * decoded or re-encoded in JS at all.
 *
 * `identity_assignments.assignment_payload` is copied byte-for-byte too,
 * even though it still embeds the *donor's* owner ids inside afterward
 * (unlike `record_payload`, decision 11 does not require this table's
 * payload to be workspace-free, and this module is the one that originally
 * chose to embed owner ids in it). Verified safe by search: nothing in this
 * codebase ever decodes `assignment_payload` for query purposes or in
 * `StorageMaintenance.verify()` -- only the plain typed columns
 * (`identity_type`/`identity_id`/`identity_key`) are ever read back.
 */
async function bulkCopyRecordsAndIdentities(target: WorkspaceDatabase, donorDatabase: WorkspaceDatabase, donorGeneration: number, workspaceId: string, map: DonorRowMap): Promise<void> {
  const donorPath = donorDatabase.database.filename;
  const mapEntries = [...map.byArtifactVersionId.entries()];

  await target.database.run("ATTACH DATABASE ? AS fork_donor_db", [donorPath]);
  try {
    await target.database.exec("CREATE TEMP TABLE fork_artifact_map (donor_artifact_version_id TEXT PRIMARY KEY, new_artifact_id TEXT NOT NULL, new_artifact_version_id TEXT NOT NULL)");
    for (let start = 0; start < mapEntries.length; start += MAP_TABLE_BATCH_ROWS) {
      const chunk = mapEntries.slice(start, start + MAP_TABLE_BATCH_ROWS);
      const params: (string | number)[] = [];
      for (const [donorArtifactVersionId, mapped] of chunk) params.push(donorArtifactVersionId, mapped.artifact_id, mapped.artifact_version_id);
      await target.database.run(`INSERT INTO fork_artifact_map (donor_artifact_version_id, new_artifact_id, new_artifact_version_id) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`, params);
    }

    const donorVisible = "d.valid_from_generation <= ? AND (d.valid_to_generation IS NULL OR d.valid_to_generation > ?)";
    await target.database.transaction([
      {
        kind: "run",
        sql: `INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, payload_digest, payload_byte_length, payload_inline, payload_cas_digest, record_payload)
          SELECT d.record_id, ?, d.category, d.kind, d.universal_kind, d.schema_version, d.producer_id, d.producer_version,
            owner_map.new_artifact_id, owner_map.new_artifact_version_id,
            span_map.new_artifact_version_id, d.primary_source_span_start_byte, d.primary_source_span_end_byte, d.primary_source_span_start_line, d.primary_source_span_end_line,
            1, NULL,
            d.record_digest, d.payload_digest, d.payload_byte_length, d.payload_inline, d.payload_cas_digest, d.record_payload
          FROM fork_donor_db.record_occurrences AS d
          JOIN fork_artifact_map AS owner_map ON owner_map.donor_artifact_version_id = d.owner_artifact_version_id
          LEFT JOIN fork_artifact_map AS span_map ON span_map.donor_artifact_version_id = d.primary_source_span_artifact_version_id
          WHERE d.workspace_id = ? AND ${donorVisible}`,
        params: [workspaceId, donorDatabase.workspaceId, donorGeneration, donorGeneration],
      },
      {
        kind: "run",
        sql: `INSERT INTO identity_assignments (identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, previous_record_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation, assignment_payload)
          SELECT d.identity_assignment_id, ?, d.identity_type, d.identity_id, 'created', d.identity_key, d.identity_key_digest, d.record_id, NULL,
            owner_map.new_artifact_id, owner_map.new_artifact_version_id,
            1, NULL,
            d.assignment_payload
          FROM fork_donor_db.identity_assignments AS d
          JOIN fork_artifact_map AS owner_map ON owner_map.donor_artifact_version_id = d.owner_artifact_version_id
          WHERE d.workspace_id = ? AND ${donorVisible}`,
        params: [workspaceId, donorDatabase.workspaceId, donorGeneration, donorGeneration],
      },
    ]);
  } finally {
    await target.database.run("DETACH DATABASE fork_donor_db").catch((error) => console.error(`[urdira] workspace fork DETACH DATABASE fork_donor_db failed for ${workspaceId} (leaked attach, non-fatal -- the connection closes at the end of this scan attempt regardless):`, error));
  }
}

interface DonorDependencyRow extends Record<string, unknown> {
  readonly record_id: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly dependency_artifact_id: string;
  readonly dependency_artifact_version_id: string;
  readonly dependency_role: string;
  readonly producer_id: string;
  readonly producer_version: string;
}

/**
 * `artifact_dependencies` rows are small (nine scalar columns, no record
 * body) and `dependency_payload` -- unlike `record_payload`/`assignment_payload`
 * -- *is* read back for real query answers (`WorkspaceProjectionRepository.dependenciesForArtifact`-
 * style reads, `packages/storage/src/projections.ts`), so it must actually
 * reflect the fork's rewritten owner/dependency ids, not the donor's. That
 * requires re-`encodeCanonical`-ing it in JS (no SQL canonical encoder
 * exists), but only for this table's typically-modest row count -- via the
 * donor's already-open connection (no `ATTACH` needed, no cross-database
 * join), batched into large multi-row `INSERT`s rather than the
 * per-row-checkpointed `checkedPublicationCommand` pattern
 * `artifactDependencyCommands` (`publication-authority.ts`) uses for an
 * ordinary scan's candidate publish.
 */
async function bulkCopyDependencies(target: WorkspaceDatabase, donorDatabase: WorkspaceDatabase, donorGeneration: number, workspaceId: string, map: DonorRowMap): Promise<void> {
  const donorVisible = "valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)";
  const donorRows = await donorDatabase.database.all<DonorDependencyRow>(
    `SELECT record_id, owner_artifact_id, owner_artifact_version_id, dependency_artifact_id, dependency_artifact_version_id, dependency_role, producer_id, producer_version FROM artifact_dependencies WHERE workspace_id = ? AND ${donorVisible}`,
    [donorDatabase.workspaceId, donorGeneration, donorGeneration],
  );
  if (donorRows.length === 0) return;
  const rows: (readonly unknown[])[] = [];
  for (const row of donorRows) {
    const owner = map.byArtifactVersionId.get(row.owner_artifact_version_id);
    const dependency = map.byArtifactVersionId.get(row.dependency_artifact_version_id);
    if (owner === undefined || dependency === undefined) continue;
    const dependencyEntryId = stableId("workspace-fork-dependency", { record_id: row.record_id, owner_artifact_id: owner.artifact_id, owner_artifact_version_id: owner.artifact_version_id, dependency_artifact_id: dependency.artifact_id, dependency_artifact_version_id: dependency.artifact_version_id, dependency_role: row.dependency_role });
    const payload = { dependency_entry_id: dependencyEntryId, record_id: row.record_id, owner_artifact_id: owner.artifact_id, owner_artifact_version_id: owner.artifact_version_id, dependency_artifact_id: dependency.artifact_id, dependency_artifact_version_id: dependency.artifact_version_id, dependency_role: row.dependency_role, producer_id: row.producer_id, producer_version: row.producer_version };
    const payloadBytes = canonicalBytes(payload);
    // `content_digest` is `digestBytes(payloadBytes)` computed once here at
    // copy time -- the same leaf recipe `projectionSetDigestEntries` uses --
    // so `computeForkSnapshotDigestFields`'s `{ digest_source: "stored" }`
    // read never has to re-hash this row's BLOB.
    rows.push([dependencyEntryId, workspaceId, row.record_id, owner.artifact_id, owner.artifact_version_id, dependency.artifact_id, dependency.artifact_version_id, row.dependency_role, row.producer_id, row.producer_version, payloadBytes, digestBytes(payloadBytes)]);
  }
  for (let start = 0; start < rows.length; start += ROW_BATCH_INSERT_ROWS) {
    const chunk = rows.slice(start, start + ROW_BATCH_INSERT_ROWS);
    await target.database.run(
      `INSERT INTO artifact_dependencies (dependency_entry_id, workspace_id, record_id, owner_artifact_id, owner_artifact_version_id, dependency_artifact_id, dependency_artifact_version_id, dependency_role, producer_id, producer_version, valid_from_generation, valid_to_generation, dependency_payload, content_digest) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)").join(", ")}`,
      chunk.flat() as (string | number | Uint8Array)[],
    );
  }
}

interface DonorProjectionRow extends Record<string, unknown> {
  readonly projection_record_id: string;
  readonly projection_kind: string;
  readonly projection_key: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly source_artifact_version_ids: string;
  readonly source_record_ids: string;
  readonly source_projection_record_ids: string;
  readonly generator: string;
  readonly generator_version: string;
  readonly generator_configuration_digest: string;
  readonly projection_payload: unknown;
}

/**
 * `projection_occurrences` rows require re-minting `projection_record_id`
 * (see the decision doc: a donor's id may itself be salted by its own
 * `owner_artifact_version_id`, which never survives a fork unchanged) and
 * rewriting `source_artifact_version_ids`/self-referential
 * `source_projection_record_ids`, so -- like dependencies -- this stays a JS
 * loop over the donor's already-open connection rather than an `ATTACH`
 * join, batched into multi-row `INSERT`s. In every real installation this
 * codebase currently indexes, this table is empty (the only production
 * plugin, JS/TS, emits no projections -- see docs/decisions/12-workspace-fork.md's
 * "no production writer" note), so this path is exercised by this module's
 * own tests but not yet by real workloads.
 */
async function bulkCopyProjections(target: WorkspaceDatabase, donorDatabase: WorkspaceDatabase, donorGeneration: number, workspaceId: string, map: DonorRowMap): Promise<number> {
  const donorVisible = "valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)";
  const donorRows = await donorDatabase.database.all<DonorProjectionRow>(
    `SELECT projection_record_id, projection_kind, projection_key, owner_artifact_id, owner_artifact_version_id, source_artifact_version_ids, source_record_ids, source_projection_record_ids, generator, generator_version, generator_configuration_digest, projection_payload FROM projection_occurrences WHERE workspace_id = ? AND ${donorVisible}`,
    [donorDatabase.workspaceId, donorGeneration, donorGeneration],
  );
  if (donorRows.length === 0) return 0;

  const projectionIdRemap = new Map<string, string>();
  for (const row of donorRows) {
    const owner = map.byArtifactVersionId.get(row.owner_artifact_version_id);
    if (owner === undefined) continue;
    projectionIdRemap.set(row.projection_record_id, stableId("workspace-fork-projection", { projection_kind: row.projection_kind, projection_key: row.projection_key, owner_artifact_id: owner.artifact_id, owner_artifact_version_id: owner.artifact_version_id, generator: row.generator, generator_version: row.generator_version, generator_configuration_digest: row.generator_configuration_digest }));
  }

  let patchCount = 0;
  const projectionRows: (readonly unknown[])[] = [];
  const dependencyRows: (readonly unknown[])[] = [];
  for (const row of donorRows) {
    const owner = map.byArtifactVersionId.get(row.owner_artifact_version_id);
    const newProjectionRecordId = projectionIdRemap.get(row.projection_record_id);
    if (owner === undefined || newProjectionRecordId === undefined) continue;
    const sourceArtifactVersionIds = parseJsonArray(row.source_artifact_version_ids).flatMap((id) => { const mapped = map.byArtifactVersionId.get(String(id)); return mapped === undefined ? [] : [mapped.artifact_version_id]; });
    const sourceRecordIds = parseJsonArray(row.source_record_ids).map(String);
    const sourceProjectionRecordIds = parseJsonArray(row.source_projection_record_ids).map((id) => projectionIdRemap.get(String(id)) ?? String(id));
    if (sourceArtifactVersionIds.length === 0 && sourceRecordIds.length === 0 && sourceProjectionRecordIds.length === 0) continue;
    patchCount += 1;
    const contentDigestInput = {
      projection_record_id: newProjectionRecordId, projection_kind: row.projection_kind, projection_key: row.projection_key,
      owner_artifact_id: owner.artifact_id, owner_artifact_version_id: owner.artifact_version_id,
      source_artifact_version_ids: sourceArtifactVersionIds, source_record_ids: sourceRecordIds, source_projection_record_ids: sourceProjectionRecordIds,
      generator: row.generator, generator_version: row.generator_version, generator_configuration_digest: row.generator_configuration_digest,
      payload: decodeJsonBlob(row.projection_payload),
    };
    const contentDigest = digest(contentDigestInput);
    projectionRows.push([newProjectionRecordId, workspaceId, row.projection_kind, row.projection_key, owner.artifact_id, owner.artifact_version_id, JSON.stringify(sourceArtifactVersionIds), JSON.stringify(sourceRecordIds), JSON.stringify(sourceProjectionRecordIds), row.generator, row.generator_version, row.generator_configuration_digest, contentDigest, row.projection_payload]);
    for (const [sourceType, sourceValues] of [["artifact_version", sourceArtifactVersionIds], ["record", sourceRecordIds], ["projection", sourceProjectionRecordIds]] as const) {
      for (const sourceId of sourceValues) dependencyRows.push([workspaceId, newProjectionRecordId, sourceType, String(sourceId), canonicalBytes({ projection_record_id: newProjectionRecordId, valid_from_generation: 1, source_type: sourceType, source_id: String(sourceId) })]);
    }
  }
  if (projectionRows.length === 0) return 0;
  for (let start = 0; start < projectionRows.length; start += ROW_BATCH_INSERT_ROWS) {
    const chunk = projectionRows.slice(start, start + ROW_BATCH_INSERT_ROWS);
    await target.database.run(`INSERT INTO projection_occurrences (projection_record_id, workspace_id, projection_kind, projection_key, owner_artifact_id, owner_artifact_version_id, source_artifact_version_ids, source_record_ids, source_projection_record_ids, generator, generator_version, generator_configuration_digest, valid_from_generation, valid_to_generation, content_digest, projection_payload) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)").join(", ")}`, chunk.flat() as (string | number | Uint8Array)[]);
  }
  for (let start = 0; start < dependencyRows.length; start += ROW_BATCH_INSERT_ROWS) {
    const chunk = dependencyRows.slice(start, start + ROW_BATCH_INSERT_ROWS);
    await target.database.run(`INSERT INTO projection_occurrence_dependencies (workspace_id, projection_record_id, valid_from_generation, source_type, source_id, dependency_payload) VALUES ${chunk.map(() => "(?, ?, 1, ?, ?, ?)").join(", ")}`, chunk.flat() as (string | number | Uint8Array)[]);
  }
  return patchCount;
}

function decodeJsonBlob(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const bytes = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : undefined;
  if (bytes === undefined) return null;
  // record_payload/projection_payload/assignment_payload/dependency_payload are
  // written via `@urdira/canonical`'s `encodeCanonical` everywhere in
  // publication-authority.ts; decode with the same codec here.
  return decodeCanonicalBlob(bytes);
}

function parseJsonArray(value: unknown): readonly unknown[] {
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

async function visibleCapabilityStateEntries(database: WorkspaceDatabase, candidateId: string): Promise<readonly unknown[]> {
  const rows = await database.database.all<{ payload: unknown }>(
    "SELECT payload FROM control_plane_state WHERE workspace_id = ? AND state_kind = 'capability_state' AND state_key LIKE ? ORDER BY state_key",
    [database.workspaceId, `capability_state:${candidateId}:%`],
  );
  return rows.map((row) => decodeCanonicalBlob(toBytes(row.payload)));
}

/**
 * The default, fast verify path (`WorkspaceForkOptions.verify_mode` unset or
 * `"fast"`) still avoids re-decoding every payload, but is deterministic and
 * complete: it compares the donor and fork's canonical/projection/capability
 * set digests, verifies row counts for every copied table, checks every
 * remapped owner/dependency reference, and validates the new snapshot's own
 * digest. It deliberately has no probabilistic sampling, so a fork can never
 * be accepted with an unverified corrupted row.
 */
async function fastForkVerify(target: WorkspaceDatabase, workspaceId: string, donorDatabase: WorkspaceDatabase, donorGeneration: number, ids: ForkPublicationIds): Promise<{ readonly ok: boolean; readonly failures: readonly string[] }> {
  const failures: string[] = [];
  const donorVisible = "valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)";
  const forkVisible = "valid_from_generation = ? AND valid_to_generation IS NULL";
  const tables = ["record_occurrences", "identity_assignments", "artifact_dependencies", "projection_occurrences"] as const;
  for (const table of tables) {
    const donorCount = (await donorDatabase.database.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE workspace_id = ? AND ${donorVisible}`, [donorDatabase.workspaceId, donorGeneration, donorGeneration]))?.c ?? 0;
    const forkCount = (await target.database.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE workspace_id = ? AND ${forkVisible}`, [workspaceId, ids.generation]))?.c ?? 0;
    if (donorCount !== forkCount) failures.push(`${table} row count mismatch: donor=${donorCount} fork=${forkCount}`);
  }

  const donorCurrent = await donorDatabase.repositories.snapshots.getCurrent();
  const donorSnapshot = donorCurrent === undefined ? undefined : await donorDatabase.repositories.snapshots.get(donorCurrent.current_snapshot_id);
  const forkSnapshot = await target.repositories.snapshots.get(ids.snapshotId);
  if (!donorSnapshot || !forkSnapshot) failures.push("snapshot row missing from donor or fork");
  else {
    const recomputedFork = await computeForkSnapshotDigestFields(target.database, workspaceId, ids.generation);
    if (forkSnapshot.canonical_record_set_digest !== recomputedFork.canonical_record_set_digest) failures.push("fork canonical record-set digest is not self-consistent");
    if (forkSnapshot.projection_set_digests !== recomputedFork.projection_set_digests) failures.push("fork projection-set digests are not self-consistent");
    if (forkSnapshot.canonical_record_set_digest !== donorSnapshot.canonical_record_set_digest) failures.push("canonical record-set digest differs from donor");
    if (forkSnapshot.capability_state_digest !== donorSnapshot.capability_state_digest) failures.push("capability-state digest differs from donor");
  }
  const ownerMismatches = await target.database.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM record_occurrences WHERE workspace_id = ? AND ${forkVisible} AND (owner_artifact_id IS NULL OR owner_artifact_version_id IS NULL)`,
    [workspaceId, ids.generation],
  );
  if ((ownerMismatches?.c ?? 0) !== 0) failures.push("fork contains records with incomplete remapped ownership");
  const dependencyMismatches = await target.database.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM artifact_dependencies WHERE workspace_id = ? AND ${forkVisible} AND (owner_artifact_id IS NULL OR owner_artifact_version_id IS NULL OR dependency_artifact_id IS NULL OR dependency_artifact_version_id IS NULL)`,
    [workspaceId, ids.generation],
  );
  if ((dependencyMismatches?.c ?? 0) !== 0) failures.push("fork contains dependencies with incomplete remapped ownership");

  const snapshotRow = await target.database.get<{ snapshot_digest: string; snapshot_payload: unknown }>("SELECT snapshot_digest, snapshot_payload FROM snapshots WHERE workspace_id = ? AND snapshot_id = ?", [workspaceId, ids.snapshotId]);
  if (!snapshotRow) failures.push("snapshot row missing after publish");
  else {
    const decoded = decodeCanonicalBlob(toBytes(snapshotRow.snapshot_payload)) as Record<string, unknown>;
    if (snapshotDigest(decoded) !== snapshotRow.snapshot_digest) failures.push("snapshot_digest is not self-consistent with its own stored payload");
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Bulk-copies the donor's currently-visible canonical rows directly (SQL,
 * not through any candidate template array -- see `bulkCopyRecordsAndIdentities`'s
 * doc comment for why), then mints the fork's O(1) publication layer
 * (candidate_state, registry, control plane, materialization, generation
 * manifest, snapshot, journal, current-state swap) through
 * `buildForkPublicationPlan` (`@urdira/storage`'s `publication-authority.ts`)
 * -- the same CAS-guarded `workspace_current_state` swap and
 * `assert_transaction_changes` checks any real scan's publication uses, with
 * no bypass of those invariants, just a different (and much smaller) set of
 * rows flowing through them. See docs/decisions/12-workspace-fork.md.
 */
async function copyDonorAndPublish(options: WorkspaceForkOptions, context: ForkContext, donor: RegisteredWorkspace, donorDatabase: WorkspaceDatabase, sourceLayer: ForkSourceLayer, ids: ForkPublicationIds): Promise<WorkspaceForkOutcome> {
  const target = options.database;
  const workspaceId = options.workspace.workspace_id;
  const copyStarted = Date.now();
  const donorCurrent = await donorDatabase.repositories.snapshots.getCurrent();
  if (!donorCurrent) fail(`donor ${donor.workspace_id} has no published generation`);
  const donorGeneration = donorCurrent.current_generation;
  const donorSnapshot = await donorDatabase.repositories.snapshots.get(donorCurrent.current_snapshot_id);
  const donorManifest = await donorDatabase.database.get<{ candidate_generation_id: string }>(
    "SELECT candidate_generation_id FROM generation_manifests WHERE workspace_id = ? AND generation_manifest_id = ?",
    [donorDatabase.workspaceId, donorSnapshot?.generation_manifest_id ?? ""],
  );

  const donorArtifacts = await donorVisibleArtifacts(donorDatabase);
  const map = buildFullArtifactMap(donorArtifacts, sourceLayer);
  // The content-hash multiset check in `attemptWorkspaceForkInner` (run
  // before ANY durable write, unconditionally, since the git-vs-multiset
  // incident documented on `commitSourceLayerAndPublish`) means every donor
  // artifact must already have a fork-target counterpart by the time this
  // code runs. This is now a defensive invariant check, not a normal skip
  // path: if it ever fires, something upstream is broken, not merely "no
  // match today" -- `fail()` routes it through the same rollback as any
  // other post-commit failure regardless.
  for (const artifact of donorArtifacts) if (!map.byArtifactVersionId.has(artifact.artifact_version_id)) fail(`invariant violation: donor artifact ${artifact.normalized_uri} has no counterpart in the fork target's fresh source layer despite a passed content-hash multiset check`);

  await bulkCopyRecordsAndIdentities(target, donorDatabase, donorGeneration, workspaceId, map);
  await bulkCopyDependencies(target, donorDatabase, donorGeneration, workspaceId, map);
  const projectionPatchCount = await bulkCopyProjections(target, donorDatabase, donorGeneration, workspaceId, map);
  context.timings["copy_build"] = Date.now() - copyStarted;

  const publishStarted = Date.now();
  const { candidateId, generation } = ids;
  const publishedAt = context.now();

  // Computed by a single SQL pass over the rows just copied (`record_id`,
  // `record_digest` pairs, plus `projectionSetDigestEntries`'s own queries --
  // which also cover `artifact_dependencies`, see that function's own
  // "dependency" projection-kind bucket) -- never a re-digest of payloads.
  const digestFields = await computeForkSnapshotDigestFields(target.database, workspaceId, generation);
  const identityIdRows = await target.database.all<{ identity_assignment_id: string }>("SELECT identity_assignment_id FROM identity_assignments WHERE workspace_id = ? AND valid_from_generation = ? AND valid_to_generation IS NULL", [workspaceId, generation]);

  const capabilityStateEntries = donorManifest === undefined ? [] : await visibleCapabilityStateEntries(donorDatabase, donorManifest.candidate_generation_id);
  const targetRegistry = options.plugin.registry as unknown as RegistrySnapshot;
  const targetResolutionLock = options.plugin.resolution_lock as unknown as PluginResolutionLock;
  const targetConfiguration = options.plugin.configuration as unknown as WorkspaceConfigurationRevision;

  const checkpointPayload = {
    workspace_id: workspaceId,
    source_state_digest: sourceLayer.source_state_digest,
    provider_watermarks: JSON.stringify({}),
    verification_status: "equivalent",
    unavailable_artifact_ids: "[]",
    verified_at: publishedAt,
  };
  const freshnessCheckpoint = {
    freshness_checkpoint_id: stableId("workspace-fork-freshness-checkpoint", { ...checkpointPayload, candidateId }),
    ...checkpointPayload,
    checkpoint_digest: digestBytes(canonicalBytes(checkpointPayload)),
  } as unknown as WorkspaceFreshnessCheckpoint;

  // `buildForkPublicationPlan`'s own `targetControls` phase writes the
  // `registry_snapshots` row but never populates the separate
  // `registry_namespace_bindings` table (that is `RegistryRepository.putSnapshot`'s
  // job, `packages/storage/src/repositories.ts`) -- and nothing in the
  // production scan pipeline (`runFullWorkspaceScan`/`CandidateIndexer`) ever
  // calls `putSnapshot` either, so `registry_namespace_bindings` is never
  // populated by any existing production path. Calling it here, scoped to
  // the fork's own registry snapshot only, is a genuine correctness
  // improvement regardless of `verify()`: without it, nothing could ever
  // query this workspace's namespace closure back out through
  // `RegistryRepository.getSnapshot`'s sibling reads. It does **not** fully
  // satisfy `StorageMaintenance.verify()`'s registry check, though -- see
  // `isKnownPreexistingVerifyGap`'s doc comment for the specific remaining
  // storage-layer bug this surfaced (a `null`-vs-omitted-key mismatch on
  // `namespace_bindings[].emission_valid_to_generation`), which this change
  // does not fix, only documents precisely.
  await target.repositories.registries.putSnapshot(targetRegistry);

  const planInput: ForkPublicationPlanInput = {
    workspaceId,
    candidateId,
    generation,
    publishedAt,
    sourceObservationBatchIds: normalizeObservationBatchIds([sourceLayer.observation_batch_id]),
    sourceStateDigest: sourceLayer.source_state_digest,
    canonicalRecordSetDigest: digestFields.canonical_record_set_digest,
    projectionSetDigests: digestFields.projection_set_digests,
    recordOpenSetEntries: digestFields.visible_records,
    identityAssignmentSetEntries: identityIdRows,
    targetRegistry,
    targetResolutionLock,
    targetConfiguration,
    freshnessCheckpoint,
    capabilityStateEntries,
    sourceSnapshotId: sourceLayer.source_snapshot_id,
    ...(donorSnapshot?.publication_stage_id === undefined || donorSnapshot.publication_stage_ordinal === undefined || donorSnapshot.publication_stage_count === undefined ? {} : {
      publicationStageId: donorSnapshot.publication_stage_id,
      publicationStageOrdinal: donorSnapshot.publication_stage_ordinal,
      publicationStageCount: donorSnapshot.publication_stage_count,
    }),
  };
  const plan = buildForkPublicationPlan(planInput);
  try {
    await target.database.transaction(Array.from(buildPublicationTransactionCommands(plan)));
  } catch (error) {
    fail(`fork publication failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  context.timings["publish"] = Date.now() - publishStarted;

  const verifyStarted = Date.now();
  const verifyMode = options.verify_mode ?? "fast";
  let verifyOk: boolean;
  let verifyFailureDetail: unknown;
  if (verifyMode === "full") {
    const verification = await target.maintenance.verify();
    verifyFailureDetail = verification.failures;
    verifyOk = verification.failures.filter((failure) => !isKnownPreexistingVerifyGap(failure)).length === 0;
  } else {
    const fast = await fastForkVerify(target, workspaceId, donorDatabase, donorGeneration, ids);
    verifyOk = fast.ok;
    verifyFailureDetail = fast.failures;
  }
  context.timings["verify"] = Date.now() - verifyStarted;
  if (!verifyOk) {
    // The detailed failure list is logged here, where it is still in scope,
    // even though the actual rollback happens one level up in
    // `commitSourceLayerAndPublish`'s single `rollbackAndSkip` -- centralizing
    // the rollback call itself (not the diagnostic detail) is what closes the
    // gap this function's callers used to have.
    console.error(`[urdira] workspace fork verify() (${verifyMode}) failed for ${workspaceId} (donor ${donor.workspace_id}):`, JSON.stringify(verifyFailureDetail));
    fail(`verify() (${verifyMode}) failed after fork publication`);
  }

  console.error(`[urdira] workspace fork succeeded for ${workspaceId} donor=${donor.workspace_id} ms=${JSON.stringify(context.timings)}`);
  return { status: "forked", donor_workspace_id: donor.workspace_id, snapshot_id: ids.snapshotId, generation, projection_patch_count: projectionPatchCount };
}

/**
 * Rolls back EVERYTHING a fork attempt may have durably written -- source
 * layer, canonical rows, and publication rows -- back to the empty state a
 * genuine first scan expects to find. Called from exactly one place,
 * `commitSourceLayerAndPublish`'s `rollbackAndSkip`, for every failure after
 * the source-layer commit, not just a `verify()` failure: an earlier version
 * of this function was only ever invoked from the `verify()`-failure branch,
 * which is why a real incident (a donor artifact silently missing its
 * fork-target counterpart, detected several steps after the source commit)
 * skipped without ever calling this at all, leaving the workspace's source
 * state "equivalent" with no published snapshot -- permanently stuck
 * "indexing" (see `commitSourceLayerAndPublish`'s doc comment for the full
 * incident). `ids` is always the deterministic, precomputed set from
 * `commitSourceLayerAndPublish` -- valid rollback targets whether or not
 * `publishCandidate` (or even `candidates.insert`) ever actually ran, since
 * every `DELETE ... WHERE` here is a no-op for a row that was never written.
 * The fork target is a brand-new workspace database with nothing else
 * concurrently reading or writing it at this point (its status is still
 * "indexing": `registry.markReady` is only ever called by the caller after
 * this module returns `"forked"`). A failure here is logged but never
 * thrown: the workspace is left with a published-but-unverified generation
 * 1 (or a partially committed one), which is strictly worse than a clean
 * rollback but no worse than skipping this cleanup step entirely, and must
 * never prevent the fallback full scan from being attempted.
 */
async function rollbackForkPublication(target: WorkspaceDatabase, workspaceId: string, ids: ForkPublicationIds): Promise<void> {
  const { candidateId, materializationId, snapshotId, generationManifestId, generation } = ids;
  try {
    await target.database.transaction([
      { kind: "run", sql: "DELETE FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation = ?", params: [workspaceId, generation] },
      { kind: "run", sql: "DELETE FROM identity_assignments WHERE workspace_id = ? AND valid_from_generation = ?", params: [workspaceId, generation] },
      { kind: "run", sql: "DELETE FROM artifact_dependencies WHERE workspace_id = ? AND valid_from_generation = ?", params: [workspaceId, generation] },
      { kind: "run", sql: "DELETE FROM projection_occurrence_dependencies WHERE workspace_id = ? AND valid_from_generation = ?", params: [workspaceId, generation] },
      { kind: "run", sql: "DELETE FROM projection_occurrences WHERE workspace_id = ? AND valid_from_generation = ?", params: [workspaceId, generation] },
      { kind: "run", sql: "DELETE FROM candidate_publication_journal WHERE workspace_id = ? AND candidate_generation_id = ?", params: [workspaceId, candidateId] },
      { kind: "run", sql: "DELETE FROM generation_manifests WHERE workspace_id = ? AND generation_manifest_id = ?", params: [workspaceId, generationManifestId] },
      // `workspace_current_state` (FOREIGN KEY ... REFERENCES snapshots) must
      // be deleted before `snapshots` itself, not after -- deleting the
      // referenced snapshot row first trips this schema's foreign-key check.
      { kind: "run", sql: "DELETE FROM workspace_current_state WHERE workspace_id = ? AND current_snapshot_id = ?", params: [workspaceId, snapshotId] },
      { kind: "run", sql: "DELETE FROM snapshots WHERE workspace_id = ? AND snapshot_id = ?", params: [workspaceId, snapshotId] },
      { kind: "run", sql: "DELETE FROM candidate_template_segments WHERE workspace_id = ? AND candidate_materialization_id = ?", params: [workspaceId, materializationId] },
      { kind: "run", sql: "DELETE FROM candidate_materializations WHERE workspace_id = ? AND candidate_generation_id = ?", params: [workspaceId, candidateId] },
      { kind: "run", sql: "DELETE FROM candidate_state WHERE workspace_id = ? AND candidate_generation_id = ?", params: [workspaceId, candidateId] },
      // Also purge the source layer this fork attempt durably committed
      // (`commitForkSourceLayer`, always the fork target's own generation-1
      // source cataloging, since a fork only ever runs on a genuine first
      // scan): a rollback that leaves the source layer behind but removes
      // every canonical/publication row would leave the fallback full scan's
      // own stage-1 read believing this workspace's files are already
      // cataloged with nothing to publish (the same "equivalent, no prior
      // snapshot" hazard `attemptWorkspaceForkInner`'s enumerate-before-commit
      // ordering exists to avoid in the first place). Deleted child-tables
      // first to satisfy this schema's foreign keys.
      { kind: "run", sql: "DELETE FROM artifact_tombstones WHERE workspace_id = ?", params: [workspaceId] },
      { kind: "run", sql: "DELETE FROM artifact_versions WHERE workspace_id = ?", params: [workspaceId] },
      { kind: "run", sql: "DELETE FROM source_observations WHERE workspace_id = ?", params: [workspaceId] },
      { kind: "run", sql: "DELETE FROM source_observation_batches WHERE workspace_id = ?", params: [workspaceId] },
      { kind: "run", sql: "DELETE FROM source_artifacts WHERE workspace_id = ?", params: [workspaceId] },
      { kind: "run", sql: "DELETE FROM source_index_state WHERE workspace_id = ?", params: [workspaceId] },
    ]);
  } catch (error) {
    console.error(`[urdira] workspace fork rollback for ${workspaceId} failed; the workspace database may retain an unverified generation ${generation}:`, error);
  }
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("Expected a binary row payload.");
}
