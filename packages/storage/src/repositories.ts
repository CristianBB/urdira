import { decodeCanonical, digestBytes, encodeCanonical } from "@urdira/canonical";
import type {
  ArtifactVersion,
  ArtifactTombstone,
  ContentBlob,
  RecordEnvelope,
  RegistryNamespaceBindingEntry,
  RegistrySnapshot,
  Snapshot,
  SourceArtifact,
  SourceObservationBatch,
  SourceObservation,
  PluginResolutionLock,
  WorkspaceConfigurationRevision,
  WorkspaceCurrentState,
  WorkspaceFreshnessCheckpoint,
} from "@urdira/contracts";
import type { BlobReference, BlobStore } from "./cas.js";
import { StorageError } from "./errors.js";
import type { SqliteCommand, SqliteDatabase, SqliteValue } from "./sqlite.js";

function canonicalSha256(value: unknown): string { return digestBytes(encodeCanonical(value)); }

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new StorageError("storage:invalid_blob", "SQLite returned a non-binary payload.");
}

function optionalText(value: string | undefined): SqliteValue { return value ?? null; }
function optionalNumber(value: number | undefined): SqliteValue { return value ?? null; }
function now(): string { return `${new Date().toISOString().replace(/Z$/, "")}${"0".repeat(6)}Z`; }

function assertWorkspace(expected: string, actual: string): void {
  if (expected !== actual) throw new StorageError("storage:workspace_mismatch", `Object workspace ${actual} does not match database workspace ${expected}.`);
}

// SQLite's compiled-in default `SQLITE_MAX_VARIABLE_NUMBER` is 32766 (modern
// builds); 500 leaves enormous headroom per chunk while keeping each chunk's
// `IN (...)` list a cheap, single index probe per id rather than one giant
// multi-thousand-way OR.
const OWNER_ID_CHUNK_SIZE = 500;

function chunkOwnerIds(ownerArtifactIds: readonly string[]): readonly string[][] {
  const unique = [...new Set(ownerArtifactIds)];
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += OWNER_ID_CHUNK_SIZE) chunks.push(unique.slice(index, index + OWNER_ID_CHUNK_SIZE));
  return chunks;
}

// Plain code-unit comparison -- matches SQLite's default BINARY collation, so
// this reproduces `ORDER BY record_id` exactly once results from several
// owner-id chunks (each independently already in `record_id` order from its
// own query) are concatenated and need a single merge sort back into one
// total order.
function compareRecordId(left: { readonly record_id: string }, right: { readonly record_id: string }): number {
  return left.record_id < right.record_id ? -1 : left.record_id > right.record_id ? 1 : 0;
}

async function requireControlReference(database: SqliteDatabase, workspaceId: string, stateKind: string, referenceId: string): Promise<void> {
  const stateKey = `${stateKind}:${referenceId}`;
  const row = await database.get<{ workspace_id: string; state_kind: string }>("SELECT workspace_id, state_kind FROM control_plane_state WHERE state_key = ?", [stateKey]);
  if (!row || row.state_kind !== stateKind) throw new StorageError("storage:control_reference_missing", `Control reference ${stateKey} is not retained.`);
  assertWorkspace(workspaceId, row.workspace_id);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function canonicalWithoutFields(value: unknown, fields: readonly string[]): Uint8Array {
  if (!value || typeof value !== "object" || Array.isArray(value)) return encodeCanonical(value);
  const copy = { ...(value as Record<string, unknown>) };
  for (const field of fields) delete copy[field];
  return encodeCanonical(copy);
}

export type ArtifactVersionRecord = Omit<ArtifactVersion, "language_hint" | "valid_to_generation"> & {
  readonly language_hint?: string;
  readonly valid_to_generation?: number;
};
export type SourceObservationRecord = Omit<SourceObservation, "observed_content_hash" | "observed_metadata_digest" | "provider_event_token" | "provider_sequence"> & {
  readonly observed_content_hash?: string;
  readonly observed_metadata_digest?: string;
  readonly provider_event_token?: string;
  readonly provider_sequence?: string;
};
export type SourceObservationBatchRecord = Omit<SourceObservationBatch, "provider_cursor_before" | "provider_cursor_after"> & {
  readonly provider_cursor_before?: string;
  readonly provider_cursor_after?: string;
};
export type ArtifactTombstoneRecord = Omit<ArtifactTombstone, "valid_to_generation" | "closing_artifact_change_id" | "replacement_artifact_version_id"> & {
  readonly valid_to_generation?: number;
  readonly closing_artifact_change_id?: string;
  readonly replacement_artifact_version_id?: string;
};
export type SnapshotRecord = Omit<Snapshot, "parent_snapshot_id"> & { readonly parent_snapshot_id?: string };

export class SourceCatalogRepository {
  constructor(private readonly database: SqliteDatabase, private readonly workspaceId: string) {}

  async putArtifact(value: SourceArtifact): Promise<void> {
    assertWorkspace(this.workspaceId, value.workspace_id);
    const encoded = encodeCanonical(value);
    const existing = await this.database.get<{
      workspace_id: string;
      normalized_uri: string;
      normalized_path: string | null;
      display_path: string | null;
      artifact_kind: string;
      artifact_payload: unknown;
    }>("SELECT workspace_id, normalized_uri, normalized_path, display_path, artifact_kind, artifact_payload FROM source_artifacts WHERE artifact_id = ?", [value.artifact_id]);
    if (existing) {
      const projectionMatches = existing.workspace_id === value.workspace_id
        && existing.normalized_uri === value.normalized_uri
        && (existing.normalized_path ?? undefined) === (value.normalized_path ?? undefined)
        && (existing.display_path ?? undefined) === (value.display_path ?? undefined)
        && existing.artifact_kind === value.artifact_kind;
      if (!projectionMatches || !sameBytes(bytes(existing.artifact_payload), encoded)) {
        throw new StorageError("storage:immutable_artifact", `Artifact ${value.artifact_id} is immutable and cannot be rewritten.`);
      }
      return;
    }
    await this.database.run(
      `INSERT INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind, artifact_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [value.artifact_id, value.workspace_id, value.normalized_uri, optionalText(value.normalized_path), optionalText(value.display_path), value.artifact_kind, encoded],
    );
  }

  async getArtifact(artifactId: string): Promise<SourceArtifact | undefined> {
    const row = await this.database.get<{ artifact_payload: unknown }>("SELECT artifact_payload FROM source_artifacts WHERE workspace_id = ? AND artifact_id = ?", [this.workspaceId, artifactId]);
    return row ? decodeCanonical(bytes(row.artifact_payload)) as SourceArtifact : undefined;
  }

  async listArtifacts(): Promise<readonly SourceArtifact[]> {
    const rows = await this.database.all<{ artifact_payload: unknown }>("SELECT artifact_payload FROM source_artifacts WHERE workspace_id = ? ORDER BY artifact_id", [this.workspaceId]);
    return rows.map((row) => decodeCanonical(bytes(row.artifact_payload)) as SourceArtifact);
  }

  async putContentBlob(value: ContentBlob): Promise<void> {
    const existing = await this.database.get<{ content_hash: string; byte_length: number; storage_reference: string }>("SELECT content_hash, byte_length, storage_reference FROM content_blobs WHERE content_blob_id = ?", [value.content_blob_id]);
    if (existing) {
      if (existing.content_hash !== value.content_hash || existing.byte_length !== value.byte_length || existing.storage_reference !== value.storage_reference) throw new StorageError("storage:immutable_content_blob", `Content blob ${value.content_blob_id} is immutable and cannot be replaced.`);
      return;
    }
    await this.database.run(
      `INSERT INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)`,
      [value.content_blob_id, value.content_hash, value.byte_length, value.storage_reference],
    );
  }

  async getContentBlob(contentBlobId: string): Promise<ContentBlob | undefined> {
    const row = await this.database.get<{ content_blob_id: string; content_hash: string; byte_length: number; storage_reference: string }>("SELECT content_blob_id, content_hash, byte_length, storage_reference FROM content_blobs WHERE content_blob_id = ?", [contentBlobId]);
    return row;
  }

  async putObservationBatch(value: SourceObservationBatchRecord): Promise<void> {
    assertWorkspace(this.workspaceId, value.workspace_id);
    const result = await this.database.run(
      `INSERT INTO source_observation_batches (observation_batch_id, workspace_id, source_provider_binding_id, source_provider,
       source_provider_version, ordering_domain, observation_mode, coverage_scopes, coverage_completeness, deletion_authority,
       provider_cursor_before, provider_cursor_after, started_at, completed_at, observation_count, unavailable_count, batch_digest,
       observation_batch_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(observation_batch_id) DO UPDATE SET workspace_id = excluded.workspace_id,
       source_provider_binding_id = excluded.source_provider_binding_id, source_provider = excluded.source_provider,
       source_provider_version = excluded.source_provider_version, ordering_domain = excluded.ordering_domain,
       observation_mode = excluded.observation_mode, coverage_scopes = excluded.coverage_scopes,
       coverage_completeness = excluded.coverage_completeness, deletion_authority = excluded.deletion_authority,
       provider_cursor_before = excluded.provider_cursor_before, provider_cursor_after = excluded.provider_cursor_after,
       started_at = excluded.started_at, completed_at = excluded.completed_at, observation_count = excluded.observation_count,
       unavailable_count = excluded.unavailable_count, batch_digest = excluded.batch_digest,
       observation_batch_payload = excluded.observation_batch_payload
       WHERE source_observation_batches.workspace_id IS excluded.workspace_id
         AND source_observation_batches.source_provider_binding_id IS excluded.source_provider_binding_id
         AND source_observation_batches.source_provider IS excluded.source_provider
         AND source_observation_batches.source_provider_version IS excluded.source_provider_version
         AND source_observation_batches.ordering_domain IS excluded.ordering_domain
         AND source_observation_batches.observation_mode IS excluded.observation_mode
         AND source_observation_batches.coverage_scopes IS excluded.coverage_scopes
         AND source_observation_batches.coverage_completeness IS excluded.coverage_completeness
         AND source_observation_batches.deletion_authority IS excluded.deletion_authority
         AND source_observation_batches.provider_cursor_before IS excluded.provider_cursor_before
         AND source_observation_batches.provider_cursor_after IS excluded.provider_cursor_after
         AND source_observation_batches.started_at IS excluded.started_at
         AND source_observation_batches.completed_at IS excluded.completed_at
       AND source_observation_batches.observation_count IS excluded.observation_count
       AND source_observation_batches.unavailable_count IS excluded.unavailable_count
       AND source_observation_batches.batch_digest IS excluded.batch_digest
       AND source_observation_batches.observation_batch_payload IS excluded.observation_batch_payload`,
      [value.observation_batch_id, value.workspace_id, value.source_provider_binding_id, value.source_provider, value.source_provider_version,
        value.ordering_domain, value.observation_mode, value.coverage_scopes, value.coverage_completeness, value.deletion_authority,
        optionalText(value.provider_cursor_before), optionalText(value.provider_cursor_after), value.started_at, value.completed_at,
        value.observation_count, value.unavailable_count, value.batch_digest, encodeCanonical(value)],
    );
    if (result.changes !== 1) throw new StorageError("storage:source_observation_batch_immutable", `Observation batch ${value.observation_batch_id} conflicts with its retained typed projection.`);
  }

  async getObservationBatch(batchId: string): Promise<SourceObservationBatchRecord | undefined> {
    const row = await this.database.get<{ observation_batch_payload: unknown }>("SELECT observation_batch_payload FROM source_observation_batches WHERE workspace_id = ? AND observation_batch_id = ?", [this.workspaceId, batchId]);
    return row ? decodeCanonical(bytes(row.observation_batch_payload)) as SourceObservationBatchRecord : undefined;
  }

  async putArtifactVersion(value: ArtifactVersionRecord): Promise<void> {
    assertWorkspace(this.workspaceId, value.workspace_id);
    const contentBlob = await this.database.get<{ content_hash: string; byte_length: number }>("SELECT content_hash, byte_length FROM content_blobs WHERE content_blob_id = ?", [value.content_blob_id]);
    if (!contentBlob || contentBlob.content_hash !== value.content_hash || contentBlob.byte_length !== value.byte_length) {
      throw new StorageError("storage:artifact_version_content_blob_mismatch", `Artifact version ${value.artifact_version_id} does not match content blob ${value.content_blob_id}.`);
    }
    const encoded = encodeCanonical(value);
    const existingPayload = await this.database.get<{ valid_to_generation: number | null; artifact_version_payload: unknown }>("SELECT valid_to_generation, artifact_version_payload FROM artifact_versions WHERE workspace_id = ? AND artifact_version_id = ?", [this.workspaceId, value.artifact_version_id]);
    if (existingPayload && existingPayload.valid_to_generation === null && value.valid_to_generation !== undefined
      && !sameBytes(canonicalWithoutFields(decodeCanonical(bytes(existingPayload.artifact_version_payload)), ["valid_to_generation"]), canonicalWithoutFields(value, ["valid_to_generation"]))) {
      throw new StorageError("storage:artifact_version_immutable", `Artifact version ${value.artifact_version_id} has a conflicting canonical payload.`);
    }
    const result = await this.database.run(
      `INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint,
       analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(artifact_version_id) DO UPDATE SET workspace_id = excluded.workspace_id, artifact_id = excluded.artifact_id,
       content_blob_id = excluded.content_blob_id, content_hash = excluded.content_hash, byte_length = excluded.byte_length,
       encoding = excluded.encoding, language_hint = excluded.language_hint, analysis_metadata_digest = excluded.analysis_metadata_digest,
       created_from_observation_id = excluded.created_from_observation_id, valid_from_generation = excluded.valid_from_generation,
       valid_to_generation = excluded.valid_to_generation, artifact_version_payload = excluded.artifact_version_payload
       WHERE artifact_versions.workspace_id IS excluded.workspace_id
         AND artifact_versions.artifact_id IS excluded.artifact_id
         AND artifact_versions.content_blob_id IS excluded.content_blob_id
         AND artifact_versions.content_hash IS excluded.content_hash
         AND artifact_versions.byte_length IS excluded.byte_length
         AND artifact_versions.encoding IS excluded.encoding
         AND artifact_versions.language_hint IS excluded.language_hint
         AND artifact_versions.analysis_metadata_digest IS excluded.analysis_metadata_digest
         AND artifact_versions.created_from_observation_id IS excluded.created_from_observation_id
         AND artifact_versions.valid_from_generation IS excluded.valid_from_generation
         AND ((artifact_versions.valid_to_generation IS NULL AND (excluded.valid_to_generation IS NOT NULL OR artifact_versions.artifact_version_payload IS excluded.artifact_version_payload)
           AND (excluded.valid_to_generation IS NULL OR excluded.valid_to_generation > artifact_versions.valid_from_generation))
           OR (artifact_versions.valid_to_generation IS NOT NULL AND excluded.valid_to_generation IS artifact_versions.valid_to_generation
             AND artifact_versions.artifact_version_payload IS excluded.artifact_version_payload))`,
      [value.artifact_version_id, value.workspace_id, value.artifact_id, value.content_blob_id, value.content_hash, value.byte_length, value.encoding, optionalText(value.language_hint), value.analysis_metadata_digest, value.created_from_observation_id, value.valid_from_generation, optionalNumber(value.valid_to_generation), encoded],
    );
    if (result.changes !== 1) {
      const existing = await this.database.get<{ valid_to_generation: number | null }>("SELECT valid_to_generation FROM artifact_versions WHERE workspace_id = ? AND artifact_version_id = ?", [this.workspaceId, value.artifact_version_id]);
      throw new StorageError(existing !== undefined && existing.valid_to_generation !== null && value.valid_to_generation === undefined ? "storage:artifact_version_lifecycle" : "storage:artifact_version_immutable", `Artifact version ${value.artifact_version_id} conflicts with its retained lifecycle or typed projection.`);
    }
  }

  async getArtifactVersion(artifactVersionId: string): Promise<ArtifactVersionRecord | undefined> {
    const row = await this.database.get<{ artifact_version_payload: unknown }>("SELECT artifact_version_payload FROM artifact_versions WHERE workspace_id = ? AND artifact_version_id = ?", [this.workspaceId, artifactVersionId]);
    return row ? decodeCanonical(bytes(row.artifact_version_payload)) as ArtifactVersionRecord : undefined;
  }

  async putTombstone(value: ArtifactTombstoneRecord): Promise<void> {
    assertWorkspace(this.workspaceId, value.workspace_id);
    if (value.valid_to_generation !== undefined
      && (!Number.isSafeInteger(value.valid_to_generation)
        || value.valid_to_generation <= value.valid_from_generation
        || typeof value.closing_artifact_change_id !== "string"
        || value.closing_artifact_change_id.length === 0
        || typeof value.replacement_artifact_version_id !== "string"
        || value.replacement_artifact_version_id.length === 0)) {
      throw new StorageError("storage:tombstone_closure_metadata", `Closed tombstone ${value.artifact_tombstone_id} requires a valid closure generation, closing change, and replacement artifact version.`);
    }
    const existingPayload = await this.database.get<{ valid_to_generation: number | null; artifact_tombstone_payload: unknown }>("SELECT valid_to_generation, artifact_tombstone_payload FROM artifact_tombstones WHERE workspace_id = ? AND artifact_tombstone_id = ?", [this.workspaceId, value.artifact_tombstone_id]);
    if (existingPayload && existingPayload.valid_to_generation === null && value.valid_to_generation !== undefined
      && !sameBytes(canonicalWithoutFields(decodeCanonical(bytes(existingPayload.artifact_tombstone_payload)), ["valid_to_generation", "closing_artifact_change_id", "replacement_artifact_version_id"]), canonicalWithoutFields(value, ["valid_to_generation", "closing_artifact_change_id", "replacement_artifact_version_id"]))) {
      throw new StorageError("storage:tombstone_immutable", `Artifact tombstone ${value.artifact_tombstone_id} has a conflicting canonical payload.`);
    }
    const encoded = encodeCanonical(value);
    const result = await this.database.run(
      `INSERT INTO artifact_tombstones (artifact_tombstone_id, workspace_id, artifact_id, absence_kind, absence_reason_code,
       last_artifact_version_id, valid_from_generation, valid_to_generation, opening_artifact_change_id, closing_artifact_change_id,
       replacement_artifact_version_id, cause_references, lineage_evidence_record_ids, artifact_tombstone_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(artifact_tombstone_id) DO UPDATE SET workspace_id = excluded.workspace_id, artifact_id = excluded.artifact_id,
       absence_kind = excluded.absence_kind, absence_reason_code = excluded.absence_reason_code,
       last_artifact_version_id = excluded.last_artifact_version_id, valid_from_generation = excluded.valid_from_generation,
       valid_to_generation = excluded.valid_to_generation, opening_artifact_change_id = excluded.opening_artifact_change_id,
       closing_artifact_change_id = excluded.closing_artifact_change_id, replacement_artifact_version_id = excluded.replacement_artifact_version_id,
       cause_references = excluded.cause_references, lineage_evidence_record_ids = excluded.lineage_evidence_record_ids,
       artifact_tombstone_payload = excluded.artifact_tombstone_payload
       WHERE artifact_tombstones.workspace_id IS excluded.workspace_id
         AND artifact_tombstones.artifact_id IS excluded.artifact_id
         AND artifact_tombstones.absence_kind IS excluded.absence_kind
         AND artifact_tombstones.absence_reason_code IS excluded.absence_reason_code
         AND artifact_tombstones.last_artifact_version_id IS excluded.last_artifact_version_id
         AND artifact_tombstones.valid_from_generation IS excluded.valid_from_generation
         AND artifact_tombstones.opening_artifact_change_id IS excluded.opening_artifact_change_id
         AND artifact_tombstones.cause_references IS excluded.cause_references
         AND artifact_tombstones.lineage_evidence_record_ids IS excluded.lineage_evidence_record_ids
         AND ((artifact_tombstones.valid_to_generation IS NULL AND (excluded.valid_to_generation IS NOT NULL OR artifact_tombstones.artifact_tombstone_payload IS excluded.artifact_tombstone_payload)
           AND (excluded.valid_to_generation IS NULL OR excluded.valid_to_generation > artifact_tombstones.valid_from_generation))
           OR (artifact_tombstones.valid_to_generation IS NOT NULL
             AND excluded.valid_to_generation IS artifact_tombstones.valid_to_generation
             AND excluded.closing_artifact_change_id IS artifact_tombstones.closing_artifact_change_id
             AND excluded.replacement_artifact_version_id IS artifact_tombstones.replacement_artifact_version_id
             AND artifact_tombstones.artifact_tombstone_payload IS excluded.artifact_tombstone_payload))`,
      [value.artifact_tombstone_id, value.workspace_id, value.artifact_id, value.absence_kind, value.absence_reason_code,
        value.last_artifact_version_id, value.valid_from_generation, optionalNumber(value.valid_to_generation), value.opening_artifact_change_id,
        optionalText(value.closing_artifact_change_id || undefined), optionalText(value.replacement_artifact_version_id || undefined), value.cause_references,
        value.lineage_evidence_record_ids, encoded],
    );
    if (result.changes !== 1) {
      const existing = await this.database.get<{ valid_to_generation: number | null }>("SELECT valid_to_generation FROM artifact_tombstones WHERE workspace_id = ? AND artifact_tombstone_id = ?", [this.workspaceId, value.artifact_tombstone_id]);
      throw new StorageError(existing !== undefined && existing.valid_to_generation !== null && value.valid_to_generation === undefined ? "storage:tombstone_lifecycle" : "storage:tombstone_immutable", `Artifact tombstone ${value.artifact_tombstone_id} conflicts with its retained lifecycle or typed projection.`);
    }
  }

  async getTombstone(tombstoneId: string): Promise<ArtifactTombstoneRecord | undefined> {
    const row = await this.database.get<{ artifact_tombstone_payload: unknown }>("SELECT artifact_tombstone_payload FROM artifact_tombstones WHERE workspace_id = ? AND artifact_tombstone_id = ?", [this.workspaceId, tombstoneId]);
    return row ? decodeCanonical(bytes(row.artifact_tombstone_payload)) as ArtifactTombstoneRecord : undefined;
  }

  async putObservation(value: SourceObservationRecord): Promise<void> {
    assertWorkspace(this.workspaceId, value.workspace_id);
    const batch = await this.database.get<{
      workspace_id: string;
      source_provider_binding_id: string;
      source_provider: string;
      source_provider_version: string;
      ordering_domain: string;
      observation_mode: string;
    }>("SELECT workspace_id, source_provider_binding_id, source_provider, source_provider_version, ordering_domain, observation_mode FROM source_observation_batches WHERE observation_batch_id = ?", [value.observation_batch_id]);
    if (!batch) throw new StorageError("storage:observation_batch_missing", `Observation batch ${value.observation_batch_id} is not retained.`);
    if (batch.workspace_id !== value.workspace_id
      || batch.source_provider_binding_id !== value.source_provider_binding_id
      || batch.source_provider !== value.source_provider
      || batch.source_provider_version !== value.source_provider_version
      || batch.ordering_domain !== value.ordering_domain
      || batch.observation_mode !== value.observation_mode) {
      throw new StorageError("storage:observation_batch_mismatch", `Observation ${value.source_observation_id} does not agree with authoritative batch ${value.observation_batch_id}.`);
    }
    const encoded = encodeCanonical(value);
    const existing = await this.database.get<{
      observation_batch_id: string;
      workspace_id: string;
      artifact_id: string;
      source_provider_binding_id: string;
      source_provider: string;
      source_provider_version: string;
      ordering_domain: string;
      observation_mode: string;
      observed_state: string;
      observed_content_hash: string | null;
      observed_metadata_digest: string | null;
      provider_event_token: string | null;
      provider_sequence: string | null;
      observed_at: string;
      received_at: string;
      observation_payload: unknown;
    }>(`SELECT observation_batch_id, workspace_id, artifact_id, source_provider_binding_id, source_provider,
       source_provider_version, ordering_domain, observation_mode, observed_state, observed_content_hash,
       observed_metadata_digest, provider_event_token, provider_sequence, observed_at, received_at, observation_payload
       FROM source_observations WHERE workspace_id = ? AND source_observation_id = ?`, [this.workspaceId, value.source_observation_id]);
    if (existing) {
      const sameProjection = existing.observation_batch_id === value.observation_batch_id
        && existing.workspace_id === value.workspace_id
        && existing.artifact_id === value.artifact_id
        && existing.source_provider_binding_id === value.source_provider_binding_id
        && existing.source_provider === value.source_provider
        && existing.source_provider_version === value.source_provider_version
        && existing.ordering_domain === value.ordering_domain
        && existing.observation_mode === value.observation_mode
        && existing.observed_state === value.observed_state
        && (existing.observed_content_hash ?? undefined) === (value.observed_content_hash ?? undefined)
        && (existing.observed_metadata_digest ?? undefined) === (value.observed_metadata_digest ?? undefined)
        && (existing.provider_event_token ?? undefined) === (value.provider_event_token ?? undefined)
        && (existing.provider_sequence ?? undefined) === (value.provider_sequence ?? undefined)
        && existing.observed_at === value.observed_at
        && existing.received_at === value.received_at
        && sameBytes(bytes(existing.observation_payload), encoded);
      if (!sameProjection) throw new StorageError("storage:immutable_observation", `Observation ${value.source_observation_id} is immutable and cannot be rewritten.`);
      return;
    }
    await this.database.run(
      `INSERT INTO source_observations (source_observation_id, observation_batch_id, workspace_id, artifact_id, source_provider_binding_id,
       source_provider, source_provider_version, ordering_domain, observation_mode, observed_state, observed_content_hash,
       observed_metadata_digest, provider_event_token, provider_sequence, observed_at, received_at, observation_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [value.source_observation_id, value.observation_batch_id, value.workspace_id, value.artifact_id, value.source_provider_binding_id, value.source_provider, value.source_provider_version, value.ordering_domain, value.observation_mode, value.observed_state, optionalText(value.observed_content_hash), optionalText(value.observed_metadata_digest), optionalText(value.provider_event_token), optionalText(value.provider_sequence), value.observed_at, value.received_at, encoded],
    );
  }

  async getObservation(observationId: string): Promise<SourceObservationRecord | undefined> {
    const row = await this.database.get<{ observation_payload: unknown }>("SELECT observation_payload FROM source_observations WHERE workspace_id = ? AND source_observation_id = ?", [this.workspaceId, observationId]);
    return row ? decodeCanonical(bytes(row.observation_payload)) as SourceObservationRecord : undefined;
  }
}

export class CanonicalOccurrenceRepository {
  constructor(private readonly database: SqliteDatabase, private readonly blobs: BlobStore, private readonly workspaceId: string) {}

  async put(value: RecordEnvelope): Promise<void> {
    assertWorkspace(this.workspaceId, value.workspace_id);
    const encodedRecord = encodeCanonical(value);
    const encodedPayload = encodeCanonical(value.payload);
    const payloadDigest = digestBytes(encodedPayload);
    const expectedPayloadInline = encodedPayload.byteLength <= this.blobs.inlineThresholdBytes ? encodedPayload : null;
    const expectedPayloadCasDigest = expectedPayloadInline === null ? payloadDigest : null;
    const existing = await this.database.get<{
      workspace_id: string;
      category: string;
      kind: string;
      universal_kind: string;
      schema_version: number;
      producer_id: string;
      producer_version: string;
      owner_artifact_id: string;
      owner_artifact_version_id: string;
      primary_source_span_artifact_version_id: string | null;
      primary_source_span_start_byte: string | null;
      primary_source_span_end_byte: string | null;
      primary_source_span_start_line: string | null;
      primary_source_span_end_line: string | null;
      valid_from_generation: number;
      valid_to_generation: number | null;
      record_digest: string;
      payload_digest: string;
      payload_byte_length: number;
      payload_inline: unknown;
      payload_cas_digest: string | null;
      record_payload: unknown;
    }>(`SELECT workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version,
       owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id,
       primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line,
       primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest,
       payload_digest, payload_byte_length, payload_inline, payload_cas_digest, record_payload
       FROM record_occurrences WHERE workspace_id = ? AND record_id = ?`, [this.workspaceId, value.record_id]);
    if (existing) {
      const sameImmutableProjection = existing.workspace_id === value.workspace_id
        && existing.category === value.category
        && existing.kind === value.kind
        && existing.universal_kind === value.universal_kind
        && existing.schema_version === value.schema_version
        && existing.producer_id === value.producer_id
        && existing.producer_version === value.producer_version
        && existing.owner_artifact_id === value.owner_artifact_id
        && existing.owner_artifact_version_id === value.owner_artifact_version_id
        && (existing.primary_source_span_artifact_version_id ?? undefined) === (value.primary_source_span?.artifact_version_id ?? undefined)
        && String(existing.primary_source_span_start_byte ?? "") === String(value.primary_source_span?.start_byte ?? "")
        && String(existing.primary_source_span_end_byte ?? "") === String(value.primary_source_span?.end_byte ?? "")
        && String(existing.primary_source_span_start_line ?? "") === String(value.primary_source_span?.start_line ?? "")
        && String(existing.primary_source_span_end_line ?? "") === String(value.primary_source_span?.end_line ?? "")
        && existing.valid_from_generation === value.valid_from_generation
        && existing.record_digest === value.record_digest
        && existing.payload_digest === payloadDigest
        && existing.payload_byte_length === encodedPayload.byteLength
        && (existing.payload_cas_digest ?? null) === expectedPayloadCasDigest
        && (expectedPayloadInline === null
          ? existing.payload_inline === null || existing.payload_inline === undefined
          : sameBytes(bytes(existing.payload_inline), expectedPayloadInline))
        && sameBytes(canonicalWithoutFields(decodeCanonical(bytes(existing.record_payload)), ["valid_to_generation"]), canonicalWithoutFields(value, ["valid_to_generation"]));
      const sameLifecycle = (existing.valid_to_generation ?? undefined) === (value.valid_to_generation ?? undefined);
      if (sameImmutableProjection && sameLifecycle && sameBytes(bytes(existing.record_payload), encodedRecord)) return;
      if (sameImmutableProjection && existing.valid_to_generation === null && value.valid_to_generation !== undefined) {
        if (value.valid_to_generation <= value.valid_from_generation) {
          throw new StorageError("storage:occurrence_lifecycle", `Record ${value.record_id} has an invalid closing generation.`);
        }
        const result = await this.database.run(
          "UPDATE record_occurrences SET valid_to_generation = ?, record_payload = ? WHERE workspace_id = ? AND record_id = ? AND valid_to_generation IS NULL",
          [value.valid_to_generation, encodedRecord, this.workspaceId, value.record_id],
        );
        if (result.changes === 1) return;
      }
      if (existing.valid_to_generation !== null && value.valid_to_generation === undefined) {
        throw new StorageError("storage:occurrence_lifecycle", `Record ${value.record_id} is closed and cannot be reopened.`);
      }
      throw new StorageError("storage:immutable_occurrence", `Record ${value.record_id} is immutable and cannot be rewritten.`);
    }
    const payloadReference = await this.blobs.place(encodedPayload);
    const payloadInline = payloadReference.storage === "inline" ? payloadReference.bytes : null;
    const payloadCasDigest = payloadReference.storage === "cas" ? payloadReference.content_hash : null;
    await this.database.run(
      `INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, owner_artifact_id, owner_artifact_version_id,
       schema_version, producer_id, producer_version, primary_source_span_artifact_version_id, primary_source_span_start_byte,
       primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation,
       record_digest, payload_digest, payload_byte_length, payload_inline, payload_cas_digest, record_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [value.record_id, value.workspace_id, value.category, value.kind, value.universal_kind, value.owner_artifact_id, value.owner_artifact_version_id,
        value.schema_version, value.producer_id, value.producer_version, optionalText(value.primary_source_span?.artifact_version_id),
        optionalText(value.primary_source_span?.start_byte), optionalText(value.primary_source_span?.end_byte), optionalText(value.primary_source_span?.start_line),
        optionalText(value.primary_source_span?.end_line), value.valid_from_generation, optionalNumber(value.valid_to_generation), value.record_digest,
        payloadDigest, payloadReference.byte_length, payloadInline, payloadCasDigest, encodedRecord],
    );
  }

  async get(recordId: string): Promise<RecordEnvelope | undefined> {
    const row = await this.database.get<{ record_payload: unknown }>("SELECT record_payload FROM record_occurrences WHERE workspace_id = ? AND record_id = ?", [this.workspaceId, recordId]);
    return row ? decodeCanonical(bytes(row.record_payload)) as RecordEnvelope : undefined;
  }

  async listByOwner(ownerArtifactId: string): Promise<readonly RecordEnvelope[]> {
    const rows = await this.database.all<{ record_payload: unknown }>("SELECT record_payload FROM record_occurrences WHERE workspace_id = ? AND owner_artifact_id = ? ORDER BY record_id", [this.workspaceId, ownerArtifactId]);
    return rows.map((row) => decodeCanonical(bytes(row.record_payload)) as RecordEnvelope);
  }

  /**
   * Every `record_occurrences` row (attached to its currently-open
   * `identity_assignments` row, if any) visible at `generation` -- i.e. the
   * same `valid_from_generation <= generation AND (valid_to_generation IS
   * NULL OR valid_to_generation > generation)` predicate
   * `computeSnapshotDigestFields` (`packages/storage/src/publication-authority.ts`)
   * already uses to compute a publish's `canonical_record_set_digest`
   * (`oldGeneration`), and `record_occurrences_visible_idx` already indexes.
   * Feeds `CandidateMaterializationInput.base_records`
   * (`packages/engine/src/candidate-materialization.ts`) so an unchanged
   * record's `record_digest` can be matched and reused (no close+reopen)
   * instead of every scan re-materializing every record.
   *
   * Implemented as two plain queries plus a JS merge, not a single
   * correlated-subquery `LEFT JOIN`: the earlier single-query form ran, for
   * every visible `record_occurrences` row, a `MAX(valid_from_generation)`
   * subquery over `identity_assignments` filtered to that same record --
   * O(records * log assignments) of SQLite work that gets slower the more
   * generations `identity_assignments` has accumulated (measured ~2.2s on a
   * fresh database, ~8s once a workspace had accumulated 490k assignment
   * rows across many rescans). Reading both tables with one plain query each
   * (each a single sequential/index pass, no per-row subquery) and merging
   * in one JS pass over the smaller identity_assignments result is O(records
   * + assignments) instead. The merge keeps, per `record_id`, the assignment
   * with the greatest `valid_from_generation` -- mirroring the old MAX()
   * subquery exactly, even though by construction there is at most one open
   * (visible) assignment per `record_id`, so this never actually has to
   * choose between candidates in practice.
   */
  async currentlyVisible(generation: number): Promise<readonly WorkspaceVisibleRecord[]> {
    const records = await this.database.all<RecordVisibilityRow>(
      `SELECT r.record_id, r.record_digest, r.workspace_id, r.owner_artifact_id, r.owner_artifact_version_id,
              r.category, r.kind, r.universal_kind, r.valid_from_generation
       FROM record_occurrences r
       WHERE r.workspace_id = ? AND r.valid_from_generation <= ? AND (r.valid_to_generation IS NULL OR r.valid_to_generation > ?)
       ORDER BY r.record_id`,
      [this.workspaceId, generation, generation],
    );
    const assignments = await this.database.all<AssignmentVisibilityRow>(
      `SELECT record_id, identity_type, identity_id, identity_key, valid_from_generation
       FROM identity_assignments
       WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)`,
      [this.workspaceId, generation, generation],
    );
    return mergeVisibleRecords(records, assignments);
  }

  /**
   * `currentlyVisible`, narrowed to only the given owner artifact ids' rows.
   * Same two queries and merge, but with `owner_artifact_id IN (...)` added
   * to both (chunked at `OWNER_ID_CHUNK_SIZE` to stay well under SQLite's
   * bound-parameter limit) -- `record_occurrences_owner_idx` (`schema.ts`)
   * makes the record query an index seek per chunk instead of a full-table
   * scan, and the identity query gets the same predicate pushed into SQLite
   * even without a dedicated owner index on `identity_assignments`, so far
   * fewer rows of either table ever cross the SQLite-worker `postMessage`
   * boundary or get merged/allocated in JS. Used at candidate seal time
   * (`workspace-indexing-session.ts`), where the caller has already computed
   * exactly the owner set `CandidateMaterializer.seal`'s own
   * `matchingBaseRecords` filter (`candidate-materialization.ts`) would keep
   * -- so this narrowing changes nothing observable, only how much gets read
   * to produce it. Results are merged across chunks and re-sorted by
   * `record_id` to preserve `currentlyVisible`'s ordering guarantee, since
   * each chunk is independently ordered but the concatenation of several
   * chunks is not.
   */
  async currentlyVisibleForOwners(generation: number, ownerArtifactIds: readonly string[]): Promise<readonly WorkspaceVisibleRecord[]> {
    const chunks = chunkOwnerIds(ownerArtifactIds);
    if (chunks.length === 0) return [];
    const records: RecordVisibilityRow[] = [];
    const assignments: AssignmentVisibilityRow[] = [];
    for (const chunk of chunks) {
      const placeholders = chunk.map(() => "?").join(", ");
      // Appended with an explicit loop, never `push(...rows)`: a spread
      // passes every row as a call argument, and one chunk's owners can own
      // enough rows (tens of thousands on a hub-file edit's closure) to
      // overflow the call stack.
      const chunkRecords = await this.database.all<RecordVisibilityRow>(
        `SELECT r.record_id, r.record_digest, r.workspace_id, r.owner_artifact_id, r.owner_artifact_version_id,
                r.category, r.kind, r.universal_kind, r.valid_from_generation
         FROM record_occurrences r
         WHERE r.workspace_id = ? AND r.valid_from_generation <= ? AND (r.valid_to_generation IS NULL OR r.valid_to_generation > ?)
           AND r.owner_artifact_id IN (${placeholders})`,
        [this.workspaceId, generation, generation, ...chunk],
      );
      for (const row of chunkRecords) records.push(row);
      const chunkAssignments = await this.database.all<AssignmentVisibilityRow>(
        `SELECT record_id, identity_type, identity_id, identity_key, valid_from_generation
         FROM identity_assignments
         WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)
           AND owner_artifact_id IN (${placeholders})`,
        [this.workspaceId, generation, generation, ...chunk],
      );
      for (const row of chunkAssignments) assignments.push(row);
    }
    return mergeVisibleRecords(records, assignments).slice().sort(compareRecordId);
  }

  /**
   * Owner-narrowed visibility with the replacement category/kind boundary
   * pushed into SQLite. This is equivalent to loading all rows for the owners
   * and filtering in CandidateMaterializer, but avoids transferring later
   * stages' records when a stage only replaces one record family.
   */
  async currentlyVisibleForReplacementScopes(
    generation: number,
    scopes: readonly { readonly owner_artifact_id: string; readonly record_categories: readonly string[]; readonly record_kinds: readonly string[] }[],
  ): Promise<readonly WorkspaceVisibleRecord[]> {
    // Structural stages commonly replace the same small set of kinds for
    // hundreds of owners.  The old `(owner AND category AND kind) OR ...`
    // predicate produced thousands of disjuncts and made SQLite repeatedly
    // re-plan a broad scan. Group by category/kind and use the workspace
    // owner-kind index with bounded owner IN lists instead.
    const grouped = new Map<string, Set<string>>();
    for (const scope of scopes) {
      for (const category of scope.record_categories) for (const kind of scope.record_kinds) {
        const key = `${category}\0${kind}`;
        const owners = grouped.get(key) ?? new Set<string>();
        owners.add(scope.owner_artifact_id);
        grouped.set(key, owners);
      }
    }
    if (grouped.size === 0) return [];
    const records: RecordVisibilityRow[] = [];
    const assignments: AssignmentVisibilityRow[] = [];
    for (const [key, ownerSet] of grouped) {
      const [category, kind] = key.split("\0") as [string, string];
      const owners = [...ownerSet];
      for (let offset = 0; offset < owners.length; offset += 900) {
        const chunk = owners.slice(offset, offset + 900);
        const placeholders = chunk.map(() => "?").join(", ");
      const chunkRecords = await this.database.all<RecordVisibilityRow>(
        `SELECT r.record_id, r.record_digest, r.workspace_id, r.owner_artifact_id, r.owner_artifact_version_id,
                r.category, r.kind, r.universal_kind, r.valid_from_generation
         FROM record_occurrences r
         WHERE r.workspace_id = ? AND r.valid_from_generation <= ? AND (r.valid_to_generation IS NULL OR r.valid_to_generation > ?)
           AND r.category = ? AND r.kind = ? AND r.owner_artifact_id IN (${placeholders})`,
        [this.workspaceId, generation, generation, category, kind, ...chunk],
      );
      for (const row of chunkRecords) records.push(row);
      const chunkAssignments = await this.database.all<AssignmentVisibilityRow>(
        `SELECT a.record_id, a.identity_type, a.identity_id, a.identity_key, a.valid_from_generation
         FROM identity_assignments a
         JOIN record_occurrences r ON r.workspace_id = a.workspace_id AND r.record_id = a.record_id
          AND r.valid_from_generation <= ? AND (r.valid_to_generation IS NULL OR r.valid_to_generation > ?)
         WHERE a.workspace_id = ? AND a.valid_from_generation <= ? AND (a.valid_to_generation IS NULL OR a.valid_to_generation > ?)
           AND a.owner_artifact_id IN (${placeholders}) AND r.category = ? AND r.kind = ?`,
        [generation, generation, this.workspaceId, generation, generation, ...chunk, category, kind],
      );
      for (const row of chunkAssignments) assignments.push(row);
      }
    }
    return mergeVisibleRecords(records, assignments).slice().sort(compareRecordId);
  }

  /**
   * Returns active records for the requested exact identity keys, regardless
   * of owner artifact. This is deliberately keyed by the digest first so an
   * owner-narrowed candidate seal can detect an identity migration without
   * materializing the whole workspace. The exact key is checked again in JS
   * after the indexed lookup to keep digest collisions fail-closed.
   */
  async currentlyVisibleForIdentityKeys(generation: number, identities: readonly { readonly identity_type: string; readonly identity_key: string }[], options: { readonly exclude_owner_artifact_ids?: readonly string[] } = {}): Promise<readonly WorkspaceVisibleRecord[]> {
    const requested = new Map(identities.map((identity) => [`${identity.identity_type}\0${identity.identity_key}`, identity]));
    if (requested.size === 0) return [];
    const digestValues = [...new Set([...requested.values()].map((identity) => canonicalSha256(identity.identity_key)))];
    const rows: WorkspaceVisibleRecord[] = [];
    const excludedOwners = [...new Set(options.exclude_owner_artifact_ids ?? [])];
    for (const chunk of chunkOwnerIds(digestValues)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const ownerPredicate = excludedOwners.length === 0 ? "" : ` AND a.owner_artifact_id NOT IN (${excludedOwners.map(() => "?").join(", ")})`;
      const matches = await this.database.all<IdentityVisibleRow>(
        `SELECT r.record_id, r.record_digest, r.workspace_id, r.owner_artifact_id, r.owner_artifact_version_id,
                r.category, r.kind, r.universal_kind, r.valid_from_generation,
                a.identity_type, a.identity_id, a.identity_key, a.identity_key_digest
         FROM identity_assignments a
         JOIN record_occurrences r
           ON r.workspace_id = a.workspace_id AND r.record_id = a.record_id
          AND r.valid_from_generation <= ? AND (r.valid_to_generation IS NULL OR r.valid_to_generation > ?)
         WHERE a.workspace_id = ? AND a.valid_from_generation <= ?
           AND (a.valid_to_generation IS NULL OR a.valid_to_generation > ?)
           AND a.identity_key_digest IN (${placeholders})${ownerPredicate}
         ORDER BY a.identity_type, a.identity_key, a.valid_from_generation DESC, a.record_id`,
        [generation, generation, this.workspaceId, generation, generation, ...chunk, ...excludedOwners],
      );
      for (const row of matches) {
        const requestedIdentity = requested.get(`${row.identity_type}\0${row.identity_key}`);
        if (requestedIdentity === undefined || canonicalSha256(requestedIdentity.identity_key) !== row.identity_key_digest || requestedIdentity.identity_key !== row.identity_key) continue;
        if (!rows.some((existing) => existing.record_id === row.record_id)) {
          const { identity_key_digest: _identityKeyDigest, ...visible } = row;
          rows.push(visible);
        }
      }
    }
    return rows.sort((left, right) => compareRecordId(left, right));
  }

  /** Returns closed latest assignments for exact keys, including owners outside a replacement scope. */
  async closedIdentitiesForIdentityKeys(generation: number, identities: readonly { readonly identity_type: string; readonly identity_key: string }[]): Promise<readonly ClosedIdentityRecord[]> {
    const requested = new Map(identities.map((identity) => [`${identity.identity_type}\0${identity.identity_key}`, identity]));
    if (requested.size === 0) return [];
    const digests = [...new Set([...requested.values()].map((identity) => canonicalSha256(identity.identity_key)))];
    const latest = new Map<string, ClosedIdentityAssignmentRow>();
    for (const chunk of chunkOwnerIds(digests)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const assignments = await this.database.all<ClosedIdentityAssignmentRow>(
        `SELECT record_id, identity_type, identity_id, identity_key, valid_from_generation
         FROM identity_assignments WHERE workspace_id = ? AND valid_from_generation <= ? AND identity_key_digest IN (${placeholders})`,
        [this.workspaceId, generation, ...chunk],
      );
      for (const row of assignments) {
        const key = `${row.identity_type}\0${row.identity_key}`;
        if (!requested.has(key)) continue;
        const existing = latest.get(key);
        if (!existing || row.valid_from_generation > existing.valid_from_generation) latest.set(key, row);
      }
    }
    const visible = new Set((await this.database.all<{ readonly record_id: string }>(
      `SELECT record_id FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)`,
      [this.workspaceId, generation, generation],
    )).map((row) => row.record_id));
    return [...latest.values()].filter((row) => !visible.has(row.record_id)).map((row) => ({ identity_type: row.identity_type, identity_key: row.identity_key, closed_identity_id: row.identity_id }));
  }

  /**
   * For each `(identity_type, identity_key)` owned by one of
   * `ownerArtifactIds`, the most-recently-assigned `identity_assignments`
   * row as of `generation` (latest by `valid_from_generation`, restricted to
   * `valid_from_generation <= generation`), kept only when that row's OWN
   * `record_id` is NOT currently visible in `record_occurrences` (closed, or
   * simply absent). An identity_key whose latest assignment's record IS
   * currently visible never appears here -- by construction the two cases
   * are mutually exclusive, so callers never have to reconcile a barrier
   * against a simultaneously-visible base record for the same key.
   *
   * Deliberately does NOT use `identity_assignments.valid_to_generation` to
   * decide closure (unlike the otherwise-analogous
   * `currentlyVisibleForOwners`/`mergeVisibleRecords` above): nothing in
   * this codebase's write path ever sets that column (`recordTemplates`,
   * `packages/engine/src/candidate-materialization.ts`, pushes no
   * `identity_assignments` entry at all for a record that closes via
   * `core:record_removed` -- only `record_occurrences` gets a closure row --
   * and storage's own INSERT for `identity_assignments`,
   * `publication-authority.ts`, never issues a matching UPDATE either), so
   * every `identity_assignments` row's `valid_to_generation` is always NULL
   * in practice; relying on it here would silently never find a removed
   * (not replaced) identity closed at all. Instead, an identity's true
   * closure is derived transitively through whether ITS OWN `record_id` is
   * still visible -- the same derivation `mergeVisibleRecords` already
   * performs for the opposite (currently-visible) direction.
   *
   * Feeds `CandidateMaterializationInput.absence_barriers`
   * (`packages/engine/src/candidate-materialization.ts`) so a record whose
   * identity was closed by a prior generation (a deleted file, most
   * commonly) and is now being re-proposed under byte-identical content gets
   * its new `record_id` salted against the closed row's `identity_id` --
   * otherwise `recordTemplates`'s pure content digest re-mints the EXACT
   * `record_id` of that closed history row (the identity is invisible, so
   * the ordinary `previous_record_id` chain-salt never triggers either), and
   * `assertPublicationImmutableRows` (`publication-authority.ts`) rejects
   * the publish as a payload/generation mismatch against the closed row
   * (`storage:publication_conflict`) -- forever, since the next scan
   * re-derives the identical byte-for-byte state (see
   * docs/decisions/11-content-derived-record-identity.md).
   *
   * Reads full assignment history for the given owners (not narrowed to a
   * visibility window like `currentlyVisibleForOwners`'s own assignment
   * read), since a closed identity's assignment row is by definition never
   * "currently visible" itself; owners here are expected to be the same
   * narrow replacement-scope set the caller already computed for
   * `currentlyVisibleForOwners`, so this stays cheap in practice.
   */
  async closedIdentitiesForOwners(generation: number, ownerArtifactIds: readonly string[]): Promise<readonly ClosedIdentityRecord[]> {
    const chunks = chunkOwnerIds(ownerArtifactIds);
    if (chunks.length === 0) return [];
    const assignmentRows: ClosedIdentityAssignmentRow[] = [];
    const visibleRecordIds = new Set<string>();
    for (const chunk of chunks) {
      const placeholders = chunk.map(() => "?").join(", ");
      const chunkAssignments = await this.database.all<ClosedIdentityAssignmentRow>(
        `SELECT record_id, identity_type, identity_id, identity_key, valid_from_generation
         FROM identity_assignments
         WHERE workspace_id = ? AND valid_from_generation <= ?
           AND owner_artifact_id IN (${placeholders})`,
        [this.workspaceId, generation, ...chunk],
      );
      for (const row of chunkAssignments) assignmentRows.push(row);
      const chunkVisibleRecords = await this.database.all<{ readonly record_id: string }>(
        `SELECT record_id FROM record_occurrences
         WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)
           AND owner_artifact_id IN (${placeholders})`,
        [this.workspaceId, generation, generation, ...chunk],
      );
      for (const row of chunkVisibleRecords) visibleRecordIds.add(row.record_id);
    }
    const latestByKey = new Map<string, ClosedIdentityAssignmentRow>();
    for (const row of assignmentRows) {
      const key = `${row.identity_type}\0${row.identity_key}`;
      const existing = latestByKey.get(key);
      if (!existing || row.valid_from_generation > existing.valid_from_generation) latestByKey.set(key, row);
    }
    const barriers: ClosedIdentityRecord[] = [];
    for (const row of latestByKey.values()) {
      if (visibleRecordIds.has(row.record_id)) continue;
      barriers.push({ identity_type: row.identity_type, identity_key: row.identity_key, closed_identity_id: row.identity_id });
    }
    return barriers;
  }
}

interface ClosedIdentityAssignmentRow extends Record<string, unknown> {
  readonly record_id: string;
  readonly identity_type: "entity" | "relation" | "diagnostic";
  readonly identity_id: string;
  readonly identity_key: string;
  readonly valid_from_generation: number;
}

interface IdentityVisibleRow extends Record<string, unknown> {
  readonly record_id: string;
  readonly record_digest: string;
  readonly workspace_id: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly category: string;
  readonly kind: string;
  readonly universal_kind: string;
  readonly valid_from_generation: number;
  readonly identity_type: "entity" | "relation" | "diagnostic";
  readonly identity_id: string;
  readonly identity_key: string;
  readonly identity_key_digest: string;
}

/**
 * The structural shape `CandidateMaterializationInput.absence_barriers`
 * (`packages/engine/src/candidate-materialization.ts`'s
 * `CandidateAbsenceBarrier`) needs. Defined here (not imported from
 * `@urdira/engine`) for the same layering reason as `WorkspaceVisibleRecord`
 * below -- `packages/storage` must not depend on `@urdira/engine`.
 */
export interface ClosedIdentityRecord {
  readonly identity_type: string;
  readonly identity_key: string;
  readonly closed_identity_id: string;
}

interface RecordVisibilityRow extends Record<string, unknown> {
  readonly record_id: string;
  readonly record_digest: string;
  readonly workspace_id: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly category: string;
  readonly kind: string;
  readonly universal_kind: string;
  readonly valid_from_generation: number;
}

interface AssignmentVisibilityRow extends Record<string, unknown> {
  readonly record_id: string;
  readonly identity_type: string;
  readonly identity_id: string;
  readonly identity_key: string;
  readonly valid_from_generation: number;
}

// Shared by `currentlyVisible` and `currentlyVisibleForOwners`: keeps, per
// `record_id`, the assignment with the greatest `valid_from_generation`
// (mirroring the `MAX(valid_from_generation)` correlated subquery both
// replace -- see `currentlyVisible`'s doc comment for why), even though by
// construction there is at most one open (visible) assignment per
// `record_id` in practice.
function mergeVisibleRecords(records: readonly RecordVisibilityRow[], assignments: readonly AssignmentVisibilityRow[]): readonly WorkspaceVisibleRecord[] {
  const latestAssignmentByRecordId = new Map<string, AssignmentVisibilityRow>();
  for (const assignment of assignments) {
    const existing = latestAssignmentByRecordId.get(assignment.record_id);
    if (!existing || assignment.valid_from_generation > existing.valid_from_generation) latestAssignmentByRecordId.set(assignment.record_id, assignment);
  }
  return records.map((row) => {
    const assignment = latestAssignmentByRecordId.get(row.record_id);
    return {
      record_id: row.record_id,
      record_digest: row.record_digest,
      workspace_id: row.workspace_id,
      owner_artifact_id: row.owner_artifact_id,
      owner_artifact_version_id: row.owner_artifact_version_id,
      category: row.category,
      kind: row.kind,
      universal_kind: row.universal_kind,
      valid_from_generation: row.valid_from_generation,
      ...(assignment === undefined ? {} : { identity_type: assignment.identity_type as "entity" | "relation" | "diagnostic", identity_id: assignment.identity_id, identity_key: assignment.identity_key }),
    };
  });
}

/**
 * The structural shape `CandidateMaterializationInput.base_records`
 * (`packages/engine/src/fact-delta.ts`'s `BaseCandidateRecord`) needs.
 * Defined here (not imported from `@urdira/engine`) because
 * `packages/storage` must not depend on `@urdira/engine`
 * (`architecture/manifest.json`); TypeScript's structural typing makes this
 * assignable to `BaseCandidateRecord` without a shared import.
 */
export interface WorkspaceVisibleRecord {
  readonly record_id: string;
  readonly record_digest: string;
  readonly workspace_id: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly category: string;
  readonly kind: string;
  readonly universal_kind: string;
  readonly identity_type?: "entity" | "relation" | "diagnostic";
  readonly identity_id?: string;
  readonly identity_key?: string;
  readonly valid_from_generation: number;
}

export class RegistryRepository {
  constructor(private readonly database: SqliteDatabase, private readonly workspaceId: string) {}

  async putSnapshot(value: RegistrySnapshot): Promise<void> {
    const declaredWorkspace = (value as RegistrySnapshot & { readonly workspace_id?: unknown }).workspace_id;
    if (declaredWorkspace !== undefined) {
      if (typeof declaredWorkspace !== "string") throw new StorageError("storage:workspace_mismatch", "Registry snapshot workspace identity is invalid.");
      assertWorkspace(this.workspaceId, declaredWorkspace);
    }
    const encoded = encodeCanonical(value);
    for (const binding of value.namespace_bindings) assertWorkspace(this.workspaceId, binding.workspace_id);
    const existing = await this.database.get<{
      workspace_id: string;
      registry_contract_version: string;
      core_registry_digest: string;
      resolution_lock_id: string;
      registry_digest: string;
      registry_payload: unknown;
    }>("SELECT workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest, registry_payload FROM registry_snapshots WHERE workspace_id = ? AND registry_snapshot_id = ?", [this.workspaceId, value.registry_snapshot_id]);
    if (existing) {
      const storedBindings = await this.database.all<{
        namespace_binding_id: string;
        workspace_id: string;
        namespace: string;
        plugin_id: string;
        plugin_version: string;
        contribution_digest: string;
        emission_valid_from_generation: string;
        emission_valid_to_generation: string | null;
      }>(`SELECT namespace_binding_id, workspace_id, namespace, plugin_id, plugin_version, contribution_digest,
         emission_valid_from_generation, emission_valid_to_generation
         FROM registry_namespace_bindings WHERE workspace_id = ? AND registry_snapshot_id = ? ORDER BY namespace_binding_id`, [this.workspaceId, value.registry_snapshot_id]);
      const expectedBindings = [...value.namespace_bindings].sort((left, right) => left.namespace_binding_id.localeCompare(right.namespace_binding_id));
      const bindingsMatch = storedBindings.length === expectedBindings.length && storedBindings.every((stored, index) => {
        const expected = expectedBindings[index];
        if (!expected) return false;
        return stored.namespace_binding_id === expected.namespace_binding_id
          && stored.workspace_id === expected.workspace_id
          && stored.namespace === expected.namespace
          && stored.plugin_id === expected.plugin_id
          && stored.plugin_version === expected.plugin_version
          && stored.contribution_digest === expected.contribution_digest
          && stored.emission_valid_from_generation === expected.emission_valid_from_generation
          && (stored.emission_valid_to_generation ?? undefined) === (expected.emission_valid_to_generation ?? undefined);
      });
      const projectionMatches = existing.workspace_id === this.workspaceId
        && existing.registry_contract_version === value.registry_contract_version
        && existing.core_registry_digest === value.core_registry_digest
        && existing.resolution_lock_id === value.resolution_lock_id
        && existing.registry_digest === value.registry_digest
        && sameBytes(bytes(existing.registry_payload), encoded)
        && bindingsMatch;
      if (!projectionMatches) throw new StorageError("storage:immutable_registry_snapshot", `Registry snapshot ${value.registry_snapshot_id} is immutable and cannot be rewritten.`);
      return;
    }
    const commands: SqliteCommand[] = [{
      kind: "run",
      sql: `INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest, registry_payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [value.registry_snapshot_id, this.workspaceId, value.registry_contract_version, value.core_registry_digest, value.resolution_lock_id, value.registry_digest, encoded],
    }];
    for (const binding of value.namespace_bindings) commands.push({ kind: "run", sql: `INSERT INTO registry_namespace_bindings
      (namespace_binding_id, registry_snapshot_id, workspace_id, namespace, plugin_id, plugin_version, contribution_digest,
       emission_valid_from_generation, emission_valid_to_generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [binding.namespace_binding_id, value.registry_snapshot_id, binding.workspace_id, binding.namespace, binding.plugin_id, binding.plugin_version, binding.contribution_digest, binding.emission_valid_from_generation, optionalText(binding.emission_valid_to_generation)] });
    await this.database.transaction(commands);
  }

  async getSnapshot(snapshotId: string): Promise<RegistrySnapshot | undefined> {
    const row = await this.database.get<{ registry_payload: unknown }>("SELECT registry_payload FROM registry_snapshots WHERE workspace_id = ? AND registry_snapshot_id = ?", [this.workspaceId, snapshotId]);
    return row ? decodeCanonical(bytes(row.registry_payload)) as RegistrySnapshot : undefined;
  }
}

export class SnapshotRepository {
  constructor(private readonly database: SqliteDatabase, private readonly workspaceId: string) {}

  async put(value: SnapshotRecord): Promise<void> {
    assertWorkspace(this.workspaceId, value.workspace_id);
    await requireControlReference(this.database, this.workspaceId, "plugin_resolution_lock", value.resolution_lock_id);
    await requireControlReference(this.database, this.workspaceId, "workspace_configuration_revision", value.configuration_revision_id);
    const encoded = encodeCanonical(value);
    const existing = await this.database.get<{
      workspace_id: string;
      generation: number;
      parent_snapshot_id: string | null;
      generation_manifest_id: string;
      registry_snapshot_id: string;
      resolution_lock_id: string;
      configuration_revision_id: string;
      source_state_digest: string;
      source_observation_watermarks: string;
      canonical_record_set_digest: string;
      projection_set_digests: string;
      capability_state_digest: string;
      published_at: string;
      snapshot_digest: string;
      snapshot_payload: unknown;
    }>(`SELECT workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id,
       resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks,
       canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at,
       snapshot_digest, snapshot_payload FROM snapshots WHERE workspace_id = ? AND snapshot_id = ?`, [this.workspaceId, value.snapshot_id]);
    if (existing) {
      const projectionMatches = existing.workspace_id === value.workspace_id
        && existing.generation === value.generation
        && (existing.parent_snapshot_id ?? undefined) === (value.parent_snapshot_id ?? undefined)
        && existing.generation_manifest_id === value.generation_manifest_id
        && existing.registry_snapshot_id === value.registry_snapshot_id
        && existing.resolution_lock_id === value.resolution_lock_id
        && existing.configuration_revision_id === value.configuration_revision_id
        && existing.source_state_digest === value.source_state_digest
        && existing.source_observation_watermarks === value.source_observation_watermarks
        && existing.canonical_record_set_digest === value.canonical_record_set_digest
        && existing.projection_set_digests === value.projection_set_digests
        && existing.capability_state_digest === value.capability_state_digest
        && existing.published_at === value.published_at
        && existing.snapshot_digest === value.snapshot_digest
        && sameBytes(bytes(existing.snapshot_payload), encoded);
      if (!projectionMatches) throw new StorageError("storage:immutable_snapshot", `Snapshot ${value.snapshot_id} is immutable and cannot be rewritten.`);
      return;
    }
    await this.database.run(
      `INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id,
       resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest,
       projection_set_digests, capability_state_digest, published_at, snapshot_digest, snapshot_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
       [value.snapshot_id, value.workspace_id, value.generation, optionalText(value.parent_snapshot_id), value.generation_manifest_id, value.registry_snapshot_id, value.resolution_lock_id, value.configuration_revision_id, value.source_state_digest, value.source_observation_watermarks, value.canonical_record_set_digest, value.projection_set_digests, value.capability_state_digest, value.published_at, value.snapshot_digest, encoded],
    );
  }

  async get(snapshotId: string): Promise<SnapshotRecord | undefined> {
    const row = await this.database.get<{ snapshot_payload: unknown }>("SELECT snapshot_payload FROM snapshots WHERE workspace_id = ? AND snapshot_id = ?", [this.workspaceId, snapshotId]);
    return row ? decodeCanonical(bytes(row.snapshot_payload)) as SnapshotRecord : undefined;
  }

  async getCurrent(): Promise<WorkspaceCurrentState | undefined> {
    const row = await this.database.get<{ current_payload: unknown }>("SELECT current_payload FROM workspace_current_state WHERE workspace_id = ?", [this.workspaceId]);
    return row ? decodeCanonical(bytes(row.current_payload)) as WorkspaceCurrentState : undefined;
  }
}

export class ControlPlaneRepository {
  constructor(private readonly database: SqliteDatabase, private readonly workspaceId: string) {}

  async put<T>(stateKind: string, stateKey: string, value: T, conflictCode = "storage:immutable_control_state"): Promise<void> {
    const objectValue = value && typeof value === "object" ? value as { workspace_id?: unknown; snapshot_id?: unknown; source_state_digest?: unknown; freshness_checkpoint_id?: unknown } : undefined;
    if (objectValue && "workspace_id" in objectValue) {
      if (typeof objectValue.workspace_id !== "string") throw new StorageError("storage:workspace_mismatch", "Control-plane workspace identity is invalid.");
      assertWorkspace(this.workspaceId, objectValue.workspace_id);
    }
    const referenceWorkspaceId = objectValue && typeof objectValue.workspace_id === "string" ? objectValue.workspace_id : null;
    const referenceSnapshotId = stateKind === "workspace_freshness_checkpoint" && objectValue && typeof objectValue.snapshot_id === "string" ? objectValue.snapshot_id : null;
    const referenceSourceStateDigest = stateKind === "workspace_freshness_checkpoint" && objectValue && typeof objectValue.source_state_digest === "string" ? objectValue.source_state_digest : null;
    if (stateKind === "workspace_freshness_checkpoint" && (!objectValue || typeof objectValue.workspace_id !== "string" || typeof objectValue.freshness_checkpoint_id !== "string" || stateKey !== `workspace_freshness_checkpoint:${objectValue.freshness_checkpoint_id}` || typeof objectValue.snapshot_id !== "string" || typeof objectValue.source_state_digest !== "string")) {
      throw new StorageError("storage:control_reference_mismatch", "Freshness control state must carry workspace, snapshot, and source-state identity.");
    }
    const encoded = encodeCanonical(value);
    const result = await this.database.run(
      `INSERT INTO control_plane_state (state_key, workspace_id, state_kind, payload, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(state_key) DO UPDATE SET workspace_id = excluded.workspace_id, state_kind = excluded.state_kind, payload = excluded.payload,
       reference_workspace_id = excluded.reference_workspace_id, reference_snapshot_id = excluded.reference_snapshot_id,
       reference_source_state_digest = excluded.reference_source_state_digest, updated_at = excluded.updated_at
       WHERE control_plane_state.workspace_id IS excluded.workspace_id
         AND control_plane_state.state_kind IS excluded.state_kind
         AND control_plane_state.payload IS excluded.payload
         AND control_plane_state.reference_workspace_id IS excluded.reference_workspace_id
         AND control_plane_state.reference_snapshot_id IS excluded.reference_snapshot_id
         AND control_plane_state.reference_source_state_digest IS excluded.reference_source_state_digest`,
      [stateKey, this.workspaceId, stateKind, encoded, referenceWorkspaceId, referenceSnapshotId, referenceSourceStateDigest, now()],
    );
    if (result.changes === 1) return;
    const existing = await this.database.get<{ workspace_id: string }>("SELECT workspace_id FROM control_plane_state WHERE state_key = ?", [stateKey]);
    if (existing) assertWorkspace(this.workspaceId, existing.workspace_id);
    throw new StorageError(conflictCode, `Control-plane state ${stateKey} is immutable and cannot be rewritten.`);
  }

  async get<T>(stateKey: string): Promise<T | undefined> {
    const row = await this.database.get<{ payload: unknown }>("SELECT payload FROM control_plane_state WHERE workspace_id = ? AND state_key = ?", [this.workspaceId, stateKey]);
    return row ? decodeCanonical(bytes(row.payload)) as T : undefined;
  }

  async putConfiguration(value: WorkspaceConfigurationRevision): Promise<void> {
    assertWorkspace(this.workspaceId, value.workspace_id);
    if (value.parent_configuration_revision_id && !await this.getConfiguration(value.parent_configuration_revision_id)) throw new StorageError("storage:control_reference_missing", `Configuration parent ${value.parent_configuration_revision_id} is not retained.`);
    await this.put("workspace_configuration_revision", `workspace_configuration_revision:${value.configuration_revision_id}`, value, "storage:immutable_configuration");
  }

  async getConfiguration(configurationRevisionId: string): Promise<WorkspaceConfigurationRevision | undefined> {
    return await this.get<WorkspaceConfigurationRevision>(`workspace_configuration_revision:${configurationRevisionId}`);
  }

  async putFreshnessCheckpoint(value: WorkspaceFreshnessCheckpoint): Promise<void> {
    assertWorkspace(this.workspaceId, value.workspace_id);
    const snapshot = await this.database.get<{ workspace_id: string; source_state_digest: string }>("SELECT workspace_id, source_state_digest FROM snapshots WHERE snapshot_id = ?", [value.snapshot_id]);
    if (!snapshot) throw new StorageError("storage:control_reference_missing", `Snapshot ${value.snapshot_id} is not retained in this workspace.`);
    assertWorkspace(this.workspaceId, snapshot.workspace_id);
    if (snapshot.source_state_digest !== value.source_state_digest) throw new StorageError("storage:control_reference_mismatch", `Freshness checkpoint ${value.freshness_checkpoint_id} does not describe the referenced snapshot.`);
    await this.put("workspace_freshness_checkpoint", `workspace_freshness_checkpoint:${value.freshness_checkpoint_id}`, value, "storage:immutable_freshness_checkpoint");
  }

  async getFreshnessCheckpoint(freshnessCheckpointId: string): Promise<WorkspaceFreshnessCheckpoint | undefined> {
    return await this.get<WorkspaceFreshnessCheckpoint>(`workspace_freshness_checkpoint:${freshnessCheckpointId}`);
  }

  async putResolutionLock(value: PluginResolutionLock): Promise<void> {
    assertWorkspace(this.workspaceId, value.workspace_id);
    await this.put("plugin_resolution_lock", `plugin_resolution_lock:${value.resolution_lock_id}`, value, "storage:immutable_resolution_lock");
  }

  async getResolutionLock(resolutionLockId: string): Promise<PluginResolutionLock | undefined> {
    return await this.get<PluginResolutionLock>(`plugin_resolution_lock:${resolutionLockId}`);
  }

  async putConfigurationProposal<T extends { readonly workspace_id?: string; readonly proposal_id?: string }>(value: T): Promise<void> {
    if (value.workspace_id !== undefined) assertWorkspace(this.workspaceId, value.workspace_id);
    if (typeof value.proposal_id !== "string" || value.proposal_id.length === 0) throw new StorageError("storage:control_reference_mismatch", "Configuration proposals require a stable proposal id.");
    await this.put("workspace_configuration_proposal", `workspace_configuration_proposal:${value.proposal_id}`, value);
  }

  async getConfigurationProposal<T>(proposalId: string): Promise<T | undefined> {
    return await this.get<T>(`workspace_configuration_proposal:${proposalId}`);
  }

  async putConfigurationAttempt<T extends { readonly workspace_id?: string; readonly attempt_id?: string }>(value: T): Promise<void> {
    if (value.workspace_id !== undefined) assertWorkspace(this.workspaceId, value.workspace_id);
    if (typeof value.attempt_id !== "string" || value.attempt_id.length === 0) throw new StorageError("storage:control_reference_mismatch", "Configuration attempts require a stable attempt id.");
    await this.put("workspace_configuration_attempt", `workspace_configuration_attempt:${value.attempt_id}`, value);
  }

  async getConfigurationAttempt<T>(attemptId: string): Promise<T | undefined> {
    return await this.get<T>(`workspace_configuration_attempt:${attemptId}`);
  }
}

export interface WorkspaceRepositories {
  readonly sourceCatalog: SourceCatalogRepository;
  readonly canonicalOccurrences: CanonicalOccurrenceRepository;
  readonly registries: RegistryRepository;
  readonly snapshots: SnapshotRepository;
  readonly controlPlane: ControlPlaneRepository;
}

export function createWorkspaceRepositories(database: SqliteDatabase, blobs: BlobStore, workspaceId: string): WorkspaceRepositories {
  return {
    sourceCatalog: new SourceCatalogRepository(database, workspaceId),
    canonicalOccurrences: new CanonicalOccurrenceRepository(database, blobs, workspaceId),
    registries: new RegistryRepository(database, workspaceId),
    snapshots: new SnapshotRepository(database, workspaceId),
    controlPlane: new ControlPlaneRepository(database, workspaceId),
  };
}

export function blobReferenceBytes(reference: BlobReference): Uint8Array {
  return reference.storage === "inline" ? new Uint8Array(reference.bytes) : new Uint8Array();
}
