import { decodeCanonical, digestBytes, encodeCanonical } from "@urdira/canonical";
import type { ContentBlob, SourceArtifact } from "@urdira/contracts";
import type { BlobStore } from "./cas.js";
import { resetTimings, snapshotTimings, timed, timingEnabled } from "./debug-timing.js";
import { StorageError } from "./errors.js";
import type { FaultInjector } from "./faults.js";
import type { ArtifactTombstoneRecord, ArtifactVersionRecord, SourceObservationBatchRecord, SourceObservationRecord } from "./repositories.js";
import type { SqliteCommand, SqliteDatabase, SqliteValue } from "./sqlite.js";

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("SQLite returned a non-binary source-index payload.");
}

function optionalText(value: string | undefined): SqliteValue { return value ?? null; }
function optionalNumber(value: number | undefined): SqliteValue { return value ?? null; }

export interface SourceIndexState {
  readonly workspace_id: string;
  readonly current_generation: number;
  readonly state_revision: number;
  readonly checkpoint_id: string;
  readonly provider_watermarks: string;
  readonly source_state_digest: string;
  readonly updated_at: string;
}

export interface CurrentSourceOccurrence {
  readonly artifact: SourceArtifact;
  readonly version: ArtifactVersionRecord;
}

export interface CurrentSourceAbsence {
  readonly artifact: SourceArtifact;
  readonly tombstone: ArtifactTombstoneRecord;
}

export interface SourceIndexContentInput {
  readonly content_blob_id: string;
  readonly bytes: Uint8Array;
  readonly media_type: string;
}

export interface SourceIndexCommitInput {
  readonly expected_state_revision: number;
  readonly state: SourceIndexState;
  readonly batch: SourceObservationBatchRecord;
  readonly observations: readonly SourceObservationRecord[];
  readonly artifacts: readonly SourceArtifact[];
  readonly contents: readonly SourceIndexContentInput[];
  readonly version_closures: readonly ArtifactVersionRecord[];
  readonly versions: readonly ArtifactVersionRecord[];
  readonly tombstone_closures: readonly ArtifactTombstoneRecord[];
  readonly tombstones: readonly ArtifactTombstoneRecord[];
}

interface PresentRow extends Record<string, unknown> {
  readonly artifact_payload: unknown;
  readonly artifact_version_payload: unknown;
}

interface AbsentRow extends Record<string, unknown> {
  readonly artifact_payload: unknown;
  readonly artifact_tombstone_payload: unknown;
}

/**
 * Typed-column-only counterpart of `ArtifactVersionRecord` for the two
 * consumers of `currentOccurrencesSlim` (below): `SourceCandidatePlanner`
 * (`packages/engine/src/source-candidate-planning.ts`) reads only
 * `artifact_version_id`/`content_hash`/`analysis_metadata_digest` off a prior
 * occurrence's version, and `runFullWorkspaceScan`'s post-catalog read
 * (`workspace-indexing-session.ts`) additionally reads
 * `created_from_observation_id`/`content_blob_id`/`byte_length`/`encoding`/
 * `language_hint` to build its own `SourceCandidatePresentObservation`
 * fields -- neither ever reads `valid_from_generation`/`valid_to_generation`,
 * which is why this (unlike `ArtifactVersionRecord`) omits them entirely
 * rather than carrying them as unused fields.
 */
export interface SlimArtifactVersion {
  readonly artifact_version_id: string;
  readonly content_blob_id: string;
  readonly content_hash: string;
  readonly byte_length: number;
  readonly encoding: string;
  readonly language_hint?: string;
  readonly analysis_metadata_digest: string;
  readonly created_from_observation_id: string;
}

/**
 * `currentOccurrencesSlim`'s `artifact` field is the FULL `SourceArtifact`
 * shape (not narrowed further), even though `SourceCandidatePlanner` itself
 * only reads `artifact_id`/`normalized_uri` off it: `runFullWorkspaceScan`'s
 * post-catalog call site (`workspace-indexing-session.ts`) passes this
 * object through wholesale as `SourceCandidatePresentObservation.artifact`,
 * which requires every `SourceArtifact` field. This costs nothing extra to
 * produce either way -- every `SourceArtifact` field is already a plain
 * typed `source_artifacts` column, not something a CBOR decode would have
 * been needed for.
 */
export interface SlimSourceOccurrence {
  readonly artifact: SourceArtifact;
  readonly version: SlimArtifactVersion;
}

export interface SlimSourceArtifactIdentity {
  readonly artifact_id: string;
  readonly normalized_uri: string;
}

export interface SlimArtifactTombstone {
  readonly artifact_tombstone_id: string;
  readonly absence_kind: string;
}

export interface SlimSourceAbsence {
  readonly artifact: SlimSourceArtifactIdentity;
  readonly tombstone: SlimArtifactTombstone;
}

interface SlimPresentRow extends Record<string, unknown> {
  readonly artifact_id: string;
  readonly workspace_id: string;
  readonly normalized_uri: string;
  readonly normalized_path: string | null;
  readonly display_path: string | null;
  readonly artifact_kind: string;
  readonly artifact_version_id: string;
  readonly content_blob_id: string;
  readonly content_hash: string;
  readonly byte_length: number;
  readonly encoding: string;
  readonly language_hint: string | null;
  readonly analysis_metadata_digest: string;
  readonly created_from_observation_id: string;
}

interface SlimAbsentRow extends Record<string, unknown> {
  readonly artifact_id: string;
  readonly normalized_uri: string;
  readonly artifact_tombstone_id: string;
  readonly absence_kind: string;
}

export class WorkspaceSourceIndexRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly blobs: BlobStore,
    private readonly workspaceId: string,
    private readonly faults: FaultInjector,
  ) {}

  async getState(): Promise<SourceIndexState | undefined> {
    return await this.database.get<SourceIndexState & Record<string, unknown>>(
      "SELECT workspace_id, current_generation, state_revision, checkpoint_id, provider_watermarks, source_state_digest, updated_at FROM source_index_state WHERE workspace_id = ?",
      [this.workspaceId],
    );
  }

  async currentOccurrences(sourceProviderBindingId: string): Promise<readonly CurrentSourceOccurrence[]> {
    const rows = await this.database.all<PresentRow>(
      `SELECT artifact.artifact_payload, version.artifact_version_payload
       FROM artifact_versions AS version
       JOIN source_artifacts AS artifact ON artifact.workspace_id = version.workspace_id AND artifact.artifact_id = version.artifact_id
       JOIN source_observations AS observation ON observation.workspace_id = version.workspace_id
         AND observation.artifact_id = version.artifact_id AND observation.source_observation_id = version.created_from_observation_id
       WHERE version.workspace_id = ? AND observation.source_provider_binding_id = ? AND version.valid_to_generation IS NULL
       ORDER BY artifact.normalized_uri, artifact.artifact_id`,
      [this.workspaceId, sourceProviderBindingId],
    );
    return rows.map((row) => ({
      artifact: decodeCanonical(bytes(row.artifact_payload)) as SourceArtifact,
      version: decodeCanonical(bytes(row.artifact_version_payload)) as ArtifactVersionRecord,
    }));
  }

  async currentAbsences(sourceProviderBindingId: string): Promise<readonly CurrentSourceAbsence[]> {
    const rows = await this.database.all<AbsentRow>(
      `SELECT artifact.artifact_payload, tombstone.artifact_tombstone_payload
       FROM artifact_tombstones AS tombstone
       JOIN source_artifacts AS artifact ON artifact.workspace_id = tombstone.workspace_id AND artifact.artifact_id = tombstone.artifact_id
       JOIN artifact_versions AS version ON version.workspace_id = tombstone.workspace_id
         AND version.artifact_id = tombstone.artifact_id AND version.artifact_version_id = tombstone.last_artifact_version_id
       JOIN source_observations AS observation ON observation.workspace_id = version.workspace_id
         AND observation.artifact_id = version.artifact_id AND observation.source_observation_id = version.created_from_observation_id
       WHERE tombstone.workspace_id = ? AND observation.source_provider_binding_id = ? AND tombstone.valid_to_generation IS NULL
       ORDER BY artifact.normalized_uri, artifact.artifact_id`,
      [this.workspaceId, sourceProviderBindingId],
    );
    return rows.map((row) => ({
      artifact: decodeCanonical(bytes(row.artifact_payload)) as SourceArtifact,
      tombstone: decodeCanonical(bytes(row.artifact_tombstone_payload)) as ArtifactTombstoneRecord,
    }));
  }

  /**
   * `currentOccurrences`, but selecting only typed `source_artifacts`/
   * `artifact_versions` columns instead of joining in `source_observations`'
   * payload and canonically decoding the artifact/version payload for every
   * row -- see `SlimSourceOccurrence`'s doc comment for exactly which
   * columns each consumer needs and why nothing here reads
   * `valid_from_generation`/`valid_to_generation`. Same joins, predicates,
   * and ordering as `currentOccurrences`, so results agree on every shared
   * field; only the row shape and the decode step differ.
   */
  async currentOccurrencesSlim(sourceProviderBindingId: string): Promise<readonly SlimSourceOccurrence[]> {
    const rows = await this.database.all<SlimPresentRow>(
      `SELECT artifact.artifact_id, artifact.workspace_id, artifact.normalized_uri, artifact.normalized_path, artifact.display_path, artifact.artifact_kind,
              version.artifact_version_id, version.content_blob_id, version.content_hash, version.byte_length, version.encoding, version.language_hint,
              version.analysis_metadata_digest, version.created_from_observation_id
       FROM artifact_versions AS version
       JOIN source_artifacts AS artifact ON artifact.workspace_id = version.workspace_id AND artifact.artifact_id = version.artifact_id
       JOIN source_observations AS observation ON observation.workspace_id = version.workspace_id
         AND observation.artifact_id = version.artifact_id AND observation.source_observation_id = version.created_from_observation_id
       WHERE version.workspace_id = ? AND observation.source_provider_binding_id = ? AND version.valid_to_generation IS NULL
       ORDER BY artifact.normalized_uri, artifact.artifact_id`,
      [this.workspaceId, sourceProviderBindingId],
    );
    return rows.map((row) => ({
      artifact: {
        artifact_id: row.artifact_id,
        workspace_id: row.workspace_id,
        normalized_uri: row.normalized_uri,
        ...(row.normalized_path === null ? {} : { normalized_path: row.normalized_path }),
        ...(row.display_path === null ? {} : { display_path: row.display_path }),
        artifact_kind: row.artifact_kind,
      },
      version: {
        artifact_version_id: row.artifact_version_id,
        content_blob_id: row.content_blob_id,
        content_hash: row.content_hash,
        byte_length: row.byte_length,
        encoding: row.encoding,
        ...(row.language_hint === null ? {} : { language_hint: row.language_hint }),
        analysis_metadata_digest: row.analysis_metadata_digest,
        created_from_observation_id: row.created_from_observation_id,
      },
    }));
  }

  /**
   * Reads one already-catalogued source blob and verifies the durable CAS
   * bytes against the catalog metadata before returning them. Progressive
   * structural stages use this instead of retaining a second in-memory copy
   * of the provider capture between publications.
   */
  async readVerifiedContentBlob(contentBlobId: string, expectedHash: string, expectedByteLength: number): Promise<Uint8Array> {
    const row = await this.database.get<{ content_hash: string; byte_length: number; storage_reference: string }>(
      "SELECT content_hash, byte_length, storage_reference FROM content_blobs WHERE content_blob_id = ?",
      [contentBlobId],
    );
    if (row === undefined || !row.storage_reference.startsWith("cas:")) throw new StorageError("storage:captured_source_unavailable", `Captured source blob ${contentBlobId} is unavailable.`);
    if (row.content_hash !== expectedHash || row.byte_length !== expectedByteLength) throw new StorageError("storage:captured_source_integrity", `Captured source blob ${contentBlobId} metadata changed.`);
    const content = await this.blobs.cas.read(row.content_hash);
    if (content.byteLength !== expectedByteLength || digestBytes(content) !== expectedHash) throw new StorageError("storage:captured_source_integrity", `Captured source blob ${contentBlobId} failed digest verification.`);
    return content;
  }

  /**
   * Bulk variant used by progressive structural stages. Metadata is fetched
   * in bounded SQL batches, then CAS objects are verified with a bounded file
   * read fan-out. This avoids one SQLite round-trip per artifact while keeping
   * the integrity checks identical to `readVerifiedContentBlob`.
   */
  async readVerifiedContentBlobs(artifacts: readonly { readonly artifact_id: string; readonly content_blob_id: string; readonly content_hash: string; readonly byte_length: number }[]): Promise<ReadonlyMap<string, Uint8Array>> {
    if (artifacts.length === 0) return new Map();
    const rows: { content_blob_id: string; content_hash: string; byte_length: number; storage_reference: string }[] = [];
    for (let offset = 0; offset < artifacts.length; offset += 500) {
      const batch = artifacts.slice(offset, offset + 500);
      const placeholders = batch.map(() => "?").join(",");
      rows.push(...await this.database.all<{ content_blob_id: string; content_hash: string; byte_length: number; storage_reference: string }>(
        `SELECT content_blob_id, content_hash, byte_length, storage_reference FROM content_blobs WHERE content_blob_id IN (${placeholders})`,
        batch.map((artifact) => artifact.content_blob_id),
      ));
    }
    const byBlobId = new Map(rows.map((row) => [row.content_blob_id, row]));
    const verified = new Map<string, Uint8Array>();
    let cursor = 0;
    const readWorker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= artifacts.length) return;
        const artifact = artifacts[index]!;
        const row = byBlobId.get(artifact.content_blob_id);
        if (row === undefined || !row.storage_reference.startsWith("cas:")) throw new StorageError("storage:captured_source_unavailable", `Captured source blob ${artifact.content_blob_id} is unavailable.`);
        if (row.content_hash !== artifact.content_hash || row.byte_length !== artifact.byte_length) throw new StorageError("storage:captured_source_integrity", `Captured source blob ${artifact.content_blob_id} metadata changed.`);
        const content = await this.blobs.cas.read(row.content_hash);
        if (content.byteLength !== artifact.byte_length || digestBytes(content) !== artifact.content_hash) throw new StorageError("storage:captured_source_integrity", `Captured source blob ${artifact.content_blob_id} failed digest verification.`);
        verified.set(artifact.artifact_id, content);
      }
    };
    await Promise.all(Array.from({ length: Math.min(32, artifacts.length) }, () => readWorker()));
    return verified;
  }

  /**
   * `currentAbsences`, but selecting only the typed columns
   * `SourceCandidatePlanner` (`packages/engine/src/source-candidate-planning.ts`)
   * actually reads off a prior absence -- `artifact.{artifact_id,
   * normalized_uri}`, `tombstone.{artifact_tombstone_id, absence_kind}` --
   * instead of joining in `source_observations` and canonically decoding the
   * artifact/tombstone payload for every row.
   */
  async currentAbsencesSlim(sourceProviderBindingId: string): Promise<readonly SlimSourceAbsence[]> {
    const rows = await this.database.all<SlimAbsentRow>(
      `SELECT artifact.artifact_id, artifact.normalized_uri, tombstone.artifact_tombstone_id, tombstone.absence_kind
       FROM artifact_tombstones AS tombstone
       JOIN source_artifacts AS artifact ON artifact.workspace_id = tombstone.workspace_id AND artifact.artifact_id = tombstone.artifact_id
       JOIN artifact_versions AS version ON version.workspace_id = tombstone.workspace_id
         AND version.artifact_id = tombstone.artifact_id AND version.artifact_version_id = tombstone.last_artifact_version_id
       JOIN source_observations AS observation ON observation.workspace_id = version.workspace_id
         AND observation.artifact_id = version.artifact_id AND observation.source_observation_id = version.created_from_observation_id
       WHERE tombstone.workspace_id = ? AND observation.source_provider_binding_id = ? AND tombstone.valid_to_generation IS NULL
       ORDER BY artifact.normalized_uri, artifact.artifact_id`,
      [this.workspaceId, sourceProviderBindingId],
    );
    return rows.map((row) => ({
      artifact: { artifact_id: row.artifact_id, normalized_uri: row.normalized_uri },
      tombstone: { artifact_tombstone_id: row.artifact_tombstone_id, absence_kind: row.absence_kind },
    }));
  }

  /**
   * `currentOccurrencesSlim`, but "as of" a specific PUBLICATION generation
   * instead of the stage-1 catalog's own latest write. `commitInternal`
   * (below) durably lands stage-1 catalog rows (`artifact_versions`/
   * `artifact_tombstones`) synchronously, on every scan, strictly BEFORE that
   * same scan's stage-2 candidate materialization/seal/publish runs
   * (`runFullWorkspaceScan`, `packages/engine/src/workspace-indexing-session.ts`:
   * `GenericSourceIndexer.apply` at the `source_catalog` stage precedes
   * `indexer.stageSourceBatch`'s `publish` stage). If a scan dies in between
   * -- crash, OOM, SIGKILL, a native worker-thread fault -- the catalog's
   * `valid_to_generation IS NULL` row for a changed artifact can already
   * reflect content the workspace's last PUBLISHED generation
   * (`workspace_current_state.current_generation`) never saw. Reading
   * `currentOccurrencesSlim`'s "whatever is currently open-ended" view as the
   * PRIOR-PUBLISHED base for a later scan's diff (`SourceCandidatePlanner.plan`,
   * `packages/engine/src/source-candidate-planning.ts`) then silently adopts
   * that never-published mutation as if it were already published: if disk
   * has not changed further, the later scan's fresh observation matches this
   * already-mutated "prior" state byte-for-byte, so the diff finds zero
   * transitions and the scan short-circuits as `equivalent` -- leaving the
   * workspace's actual published generation (and everything that reads it:
   * `get_source`, `search_text`, ...) permanently stuck on the stale content
   * a crashed scan never got to publish (this was a real, reproduced
   * incident: a bulk `git checkout -- .` reversion landed in the catalog via
   * a scan that crashed between `source_catalog` and `publish`, and the next
   * daemon's startup catch-up scan reported `equivalent` and served the
   * pre-revert content indefinitely).
   *
   * The fix: reconstruct "what the workspace's last PUBLISHED generation
   * actually contained" with the same point-in-time interval query
   * `CanonicalOccurrenceRepository.currentlyVisibleForOwners`
   * (`packages/storage/src/repositories.ts`) already uses for records --
   * `valid_from_generation <= asOfGeneration AND (valid_to_generation IS NULL
   * OR valid_to_generation > asOfGeneration)` -- instead of the unconditional
   * "currently open-ended" predicate. `asOfGeneration` is always the CALLER's
   * `workspace_current_state.current_generation` (0 on a genuine first scan,
   * before anything has ever published; every row's `valid_from_generation`
   * starts at 1, so `<= 0` correctly yields nothing, matching the empty base
   * a first scan already used). A scan's own later stage-1 commit (this
   * same scan, not a crashed prior one) never affects this read: it is always
   * called BEFORE that commit runs (`runFullWorkspaceScan`'s `prior_state`
   * stage), so it only ever sees a PRIOR scan's already-durable rows, never
   * this scan's own pending writes.
   */
  async currentOccurrencesSlimAsOf(sourceProviderBindingId: string, asOfGeneration: number): Promise<readonly SlimSourceOccurrence[]> {
    const rows = await this.database.all<SlimPresentRow>(
      `SELECT artifact.artifact_id, artifact.workspace_id, artifact.normalized_uri, artifact.normalized_path, artifact.display_path, artifact.artifact_kind,
              version.artifact_version_id, version.content_blob_id, version.content_hash, version.byte_length, version.encoding, version.language_hint,
              version.analysis_metadata_digest, version.created_from_observation_id
       FROM artifact_versions AS version
       JOIN source_artifacts AS artifact ON artifact.workspace_id = version.workspace_id AND artifact.artifact_id = version.artifact_id
       JOIN source_observations AS observation ON observation.workspace_id = version.workspace_id
         AND observation.artifact_id = version.artifact_id AND observation.source_observation_id = version.created_from_observation_id
       WHERE version.workspace_id = ? AND observation.source_provider_binding_id = ?
         AND version.valid_from_generation <= ? AND (version.valid_to_generation IS NULL OR version.valid_to_generation > ?)
       ORDER BY artifact.normalized_uri, artifact.artifact_id`,
      [this.workspaceId, sourceProviderBindingId, asOfGeneration, asOfGeneration],
    );
    return rows.map((row) => ({
      artifact: {
        artifact_id: row.artifact_id,
        workspace_id: row.workspace_id,
        normalized_uri: row.normalized_uri,
        ...(row.normalized_path === null ? {} : { normalized_path: row.normalized_path }),
        ...(row.display_path === null ? {} : { display_path: row.display_path }),
        artifact_kind: row.artifact_kind,
      },
      version: {
        artifact_version_id: row.artifact_version_id,
        content_blob_id: row.content_blob_id,
        content_hash: row.content_hash,
        byte_length: row.byte_length,
        encoding: row.encoding,
        ...(row.language_hint === null ? {} : { language_hint: row.language_hint }),
        analysis_metadata_digest: row.analysis_metadata_digest,
        created_from_observation_id: row.created_from_observation_id,
      },
    }));
  }

  /** `currentAbsencesSlim`'s "as of a publication generation" counterpart -- see `currentOccurrencesSlimAsOf`'s doc comment for why this exists and how `asOfGeneration` must be sourced. */
  async currentAbsencesSlimAsOf(sourceProviderBindingId: string, asOfGeneration: number): Promise<readonly SlimSourceAbsence[]> {
    const rows = await this.database.all<SlimAbsentRow>(
      `SELECT artifact.artifact_id, artifact.normalized_uri, tombstone.artifact_tombstone_id, tombstone.absence_kind
       FROM artifact_tombstones AS tombstone
       JOIN source_artifacts AS artifact ON artifact.workspace_id = tombstone.workspace_id AND artifact.artifact_id = tombstone.artifact_id
       JOIN artifact_versions AS version ON version.workspace_id = tombstone.workspace_id
         AND version.artifact_id = tombstone.artifact_id AND version.artifact_version_id = tombstone.last_artifact_version_id
       JOIN source_observations AS observation ON observation.workspace_id = version.workspace_id
         AND observation.artifact_id = version.artifact_id AND observation.source_observation_id = version.created_from_observation_id
       WHERE tombstone.workspace_id = ? AND observation.source_provider_binding_id = ?
         AND tombstone.valid_from_generation <= ? AND (tombstone.valid_to_generation IS NULL OR tombstone.valid_to_generation > ?)
       ORDER BY artifact.normalized_uri, artifact.artifact_id`,
      [this.workspaceId, sourceProviderBindingId, asOfGeneration, asOfGeneration],
    );
    return rows.map((row) => ({
      artifact: { artifact_id: row.artifact_id, normalized_uri: row.normalized_uri },
      tombstone: { artifact_tombstone_id: row.artifact_tombstone_id, absence_kind: row.absence_kind },
    }));
  }

  async commit(input: SourceIndexCommitInput): Promise<void> {
    await this.commitInternal(input);
  }

  /** Used by the unified candidate publication entry point without exposing the legacy commit method. */
  async commitFromCandidate(input: SourceIndexCommitInput): Promise<void> {
    await this.commitInternal(input);
  }

  private async commitInternal(input: SourceIndexCommitInput): Promise<void> {
    if (input.state.workspace_id !== this.workspaceId || input.batch.workspace_id !== this.workspaceId) throw new TypeError("Source-index commit workspace mismatch.");
    resetTimings();
    const stagedContents = new Map<string, ContentBlob>();
    // `putMany` writes every content blob in this batch through the same
    // durable per-blob fsync sequence `cas.put` used one call at a time, but
    // with bounded concurrency across blobs and one coalesced
    // installation-catalog metadata write for the whole batch instead of one
    // per blob (see `ContentAddressedStore.putMany`'s doc comment,
    // `packages/storage/src/cas.ts`, for exactly what durability ordering
    // that does and does not change).
    await timed("source_index_cas_put_loop", async () => {
      const references = await this.blobs.cas.putMany(input.contents.map((content) => ({ bytes: content.bytes, options: { media_type: content.media_type } })));
      for (let index = 0; index < input.contents.length; index += 1) {
        const content = input.contents[index] as SourceIndexContentInput;
        const reference = references[index] as ContentBlob;
        stagedContents.set(content.content_blob_id, {
          content_blob_id: content.content_blob_id,
          content_hash: reference.content_hash,
          byte_length: reference.byte_length,
          storage_reference: reference.storage_reference,
        });
      }
    });
    await this.faults.hit("source_index.before_commit");
    // Commands are streamed to the SQLite worker in bounded chunks
    // (`SqliteDatabase.transactionChunked`) rather than materialized as one
    // array and structured-cloned to the worker in a single `postMessage`, so
    // this yields commands in the same exact order the array used to hold.
    // `commitCommands` yields only `run`/`transaction_checkpoint`/
    // `assert_transaction_changes` (verified against `DISCARD_ALLOWED_KINDS`
    // in packages/storage/src/sqlite.ts -- no `get`/`all` command ever
    // appears in this stream), so it qualifies for `discard_results`; this
    // call has never read the return value.
    await timed("source_index_sql_transaction", () => this.database.transactionChunked(this.commitCommands(input, stagedContents), undefined, { discard_results: true }));
    if (timingEnabled()) console.error(`[urdira] storage timings source_catalog workspace:${this.workspaceId} contents:${input.contents.length} ms=${JSON.stringify(snapshotTimings())}`);
  }

  private *commitCommands(input: SourceIndexCommitInput, stagedContents: ReadonlyMap<string, ContentBlob>): Generator<SqliteCommand> {
    yield this.batchCommand(input.batch);
    for (const artifact of input.artifacts) yield this.artifactCommand(artifact);
    for (const content of stagedContents.values()) yield this.contentCommand(content);
    for (const observation of input.observations) yield this.observationCommand(observation);
    for (const version of input.version_closures) yield this.closeVersionCommand(version);
    for (const version of input.versions) yield this.versionCommand(version);
    for (const tombstone of input.tombstone_closures) yield this.closeTombstoneCommand(tombstone);
    for (const tombstone of input.tombstones) yield this.tombstoneCommand(tombstone);
    yield { kind: "transaction_checkpoint" };
    yield* this.stateCommands(input.state, input.expected_state_revision);
    yield { kind: "assert_transaction_changes", expected: 1 };
  }

  private batchCommand(value: SourceObservationBatchRecord): SqliteCommand {
    return {
      kind: "run",
      sql: `INSERT OR IGNORE INTO source_observation_batches (observation_batch_id, workspace_id, source_provider_binding_id, source_provider,
        source_provider_version, ordering_domain, observation_mode, coverage_scopes, coverage_completeness, deletion_authority,
        provider_cursor_before, provider_cursor_after, started_at, completed_at, observation_count, unavailable_count, batch_digest,
        observation_batch_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [value.observation_batch_id, value.workspace_id, value.source_provider_binding_id, value.source_provider, value.source_provider_version,
        value.ordering_domain, value.observation_mode, value.coverage_scopes, value.coverage_completeness, value.deletion_authority,
        optionalText(value.provider_cursor_before), optionalText(value.provider_cursor_after), value.started_at, value.completed_at,
        value.observation_count, value.unavailable_count, value.batch_digest, encodeCanonical(value)],
    };
  }

  private artifactCommand(value: SourceArtifact): SqliteCommand {
    return {
      kind: "run",
      sql: "INSERT OR IGNORE INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind, artifact_payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      params: [value.artifact_id, value.workspace_id, value.normalized_uri, optionalText(value.normalized_path), optionalText(value.display_path), value.artifact_kind, encodeCanonical(value)],
    };
  }

  private contentCommand(value: ContentBlob): SqliteCommand {
    return {
      kind: "run",
      sql: "INSERT OR IGNORE INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)",
      params: [value.content_blob_id, value.content_hash, value.byte_length, value.storage_reference],
    };
  }

  private observationCommand(value: SourceObservationRecord): SqliteCommand {
    return {
      kind: "run",
      sql: `INSERT OR IGNORE INTO source_observations (source_observation_id, observation_batch_id, workspace_id, artifact_id,
        source_provider_binding_id, source_provider, source_provider_version, ordering_domain, observation_mode, observed_state,
        observed_content_hash, observed_metadata_digest, provider_event_token, provider_sequence, observed_at, received_at, observation_payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [value.source_observation_id, value.observation_batch_id, value.workspace_id, value.artifact_id, value.source_provider_binding_id,
        value.source_provider, value.source_provider_version, value.ordering_domain, value.observation_mode, value.observed_state,
        optionalText(value.observed_content_hash), optionalText(value.observed_metadata_digest), optionalText(value.provider_event_token),
        optionalText(value.provider_sequence), value.observed_at, value.received_at, encodeCanonical(value)],
    };
  }

  private versionCommand(value: ArtifactVersionRecord): SqliteCommand {
    return {
      kind: "run",
      sql: `INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length,
        encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation,
        artifact_version_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [value.artifact_version_id, value.workspace_id, value.artifact_id, value.content_blob_id, value.content_hash, value.byte_length,
        value.encoding, optionalText(value.language_hint), value.analysis_metadata_digest, value.created_from_observation_id,
        value.valid_from_generation, optionalNumber(value.valid_to_generation), encodeCanonical(value)],
    };
  }

  private closeVersionCommand(value: ArtifactVersionRecord): SqliteCommand {
    return {
      kind: "run",
      sql: "UPDATE artifact_versions SET valid_to_generation = ?, artifact_version_payload = ? WHERE workspace_id = ? AND artifact_version_id = ? AND valid_to_generation IS NULL",
      params: [optionalNumber(value.valid_to_generation), encodeCanonical(value), this.workspaceId, value.artifact_version_id],
    };
  }

  private tombstoneCommand(value: ArtifactTombstoneRecord): SqliteCommand {
    return {
      kind: "run",
      sql: `INSERT INTO artifact_tombstones (artifact_tombstone_id, workspace_id, artifact_id, absence_kind, absence_reason_code,
        last_artifact_version_id, valid_from_generation, valid_to_generation, opening_artifact_change_id, closing_artifact_change_id,
        replacement_artifact_version_id, cause_references, lineage_evidence_record_ids, artifact_tombstone_payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [value.artifact_tombstone_id, value.workspace_id, value.artifact_id, value.absence_kind, value.absence_reason_code,
        value.last_artifact_version_id, value.valid_from_generation, optionalNumber(value.valid_to_generation), value.opening_artifact_change_id,
        optionalText(value.closing_artifact_change_id), optionalText(value.replacement_artifact_version_id), value.cause_references,
        value.lineage_evidence_record_ids, encodeCanonical(value)],
    };
  }

  private closeTombstoneCommand(value: ArtifactTombstoneRecord): SqliteCommand {
    return {
      kind: "run",
      sql: `UPDATE artifact_tombstones SET valid_to_generation = ?, closing_artifact_change_id = ?, replacement_artifact_version_id = ?,
        artifact_tombstone_payload = ? WHERE workspace_id = ? AND artifact_tombstone_id = ? AND valid_to_generation IS NULL`,
      params: [optionalNumber(value.valid_to_generation), optionalText(value.closing_artifact_change_id), optionalText(value.replacement_artifact_version_id),
        encodeCanonical(value), this.workspaceId, value.artifact_tombstone_id],
    };
  }

  private stateCommands(value: SourceIndexState, expectedRevision: number): SqliteCommand[] {
    return [
      {
        kind: "run",
        sql: `UPDATE source_index_state SET current_generation = ?, state_revision = ?, checkpoint_id = ?, provider_watermarks = ?,
          source_state_digest = ?, updated_at = ? WHERE workspace_id = ? AND state_revision = ?`,
        params: [value.current_generation, value.state_revision, value.checkpoint_id, value.provider_watermarks,
          value.source_state_digest, value.updated_at, this.workspaceId, expectedRevision],
      },
      {
        kind: "run",
        sql: `INSERT INTO source_index_state (workspace_id, current_generation, state_revision, checkpoint_id, provider_watermarks, source_state_digest, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ? WHERE ? = 0 AND NOT EXISTS (SELECT 1 FROM source_index_state WHERE workspace_id = ?)`,
        params: [value.workspace_id, value.current_generation, value.state_revision, value.checkpoint_id, value.provider_watermarks,
          value.source_state_digest, value.updated_at, expectedRevision, this.workspaceId],
      },
    ];
  }
}
