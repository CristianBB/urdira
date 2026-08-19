import { canonicalBytes, decodeCanonical, digestBytes, encodeCanonical } from "@urdira/canonical";
import { StorageError } from "./errors.js";
import type { SqliteDatabase, SqliteValue } from "./sqlite.js";

export interface WorkspaceProjectionOccurrence {
  readonly projection_record_id: string;
  readonly projection_kind: string;
  readonly projection_key: string;
  readonly workspace_id: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly source_artifact_version_ids: readonly string[];
  readonly source_record_ids: readonly string[];
  readonly source_projection_record_ids: readonly string[];
  readonly generator: string;
  readonly generator_version: string;
  readonly generator_configuration_digest: string;
  readonly valid_from_generation: number;
  readonly valid_to_generation?: number;
  readonly content_digest?: string;
  readonly payload: unknown;
}

export interface ProjectionOccurrenceDependency {
  readonly projection_record_id: string;
  readonly valid_from_generation: number;
  readonly source_type: "artifact_version" | "record" | "projection";
  readonly source_id: string;
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new StorageError("storage:invalid_blob", "SQLite returned a non-binary payload.");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]); }
function nullable(value: number | undefined): SqliteValue { return value ?? null; }
function canonicalSha256(value: unknown): string { return digestBytes(canonicalBytes(value)); }

// See `repositories.ts`'s identical constant/comment (`OWNER_ID_CHUNK_SIZE`):
// duplicated here rather than imported because there is no existing shared
// utility module in this package, and it is four lines.
const OWNER_ID_CHUNK_SIZE = 500;

function chunkOwnerIds(ownerArtifactIds: readonly string[]): readonly string[][] {
  const unique = [...new Set(ownerArtifactIds)];
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += OWNER_ID_CHUNK_SIZE) chunks.push(unique.slice(index, index + OWNER_ID_CHUNK_SIZE));
  return chunks;
}

function compareProjectionRecordId(left: { readonly projection_record_id: string }, right: { readonly projection_record_id: string }): number {
  return left.projection_record_id < right.projection_record_id ? -1 : left.projection_record_id > right.projection_record_id ? 1 : 0;
}

/**
 * The structural shape `CandidateMaterializationInput.base_projections`
 * (`packages/engine/src/candidate-planning.ts`'s `BaseCandidateProjection`)
 * needs -- deliberately excludes `payload`, which no seal-time consumer
 * reads (`candidate-materialization.ts`'s `projectionTemplates` only reads
 * `content_digest` and the identity/source-binding columns below). Defined
 * here rather than imported for the same reason as `WorkspaceVisibleRecord`
 * in `repositories.ts`: `packages/storage` must not depend on `@urdira/engine`.
 */
export interface WorkspaceVisibleProjection {
  readonly projection_record_id: string;
  readonly projection_kind: string;
  readonly projection_key: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly content_digest: string;
  readonly source_artifact_version_ids: readonly string[];
  readonly source_record_ids: readonly string[];
  readonly source_projection_record_ids: readonly string[];
  readonly generator: string;
  readonly generator_version: string;
  readonly generator_configuration_digest: string;
}

interface SlimProjectionRow extends Record<string, unknown> {
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
  readonly content_digest: string;
}

function decodeSlim(row: SlimProjectionRow): WorkspaceVisibleProjection {
  return {
    projection_record_id: row.projection_record_id,
    projection_kind: row.projection_kind,
    projection_key: row.projection_key,
    owner_artifact_id: row.owner_artifact_id,
    owner_artifact_version_id: row.owner_artifact_version_id,
    content_digest: row.content_digest,
    source_artifact_version_ids: JSON.parse(row.source_artifact_version_ids) as string[],
    source_record_ids: JSON.parse(row.source_record_ids) as string[],
    source_projection_record_ids: JSON.parse(row.source_projection_record_ids) as string[],
    generator: row.generator,
    generator_version: row.generator_version,
    generator_configuration_digest: row.generator_configuration_digest,
  };
}

const SLIM_PROJECTION_COLUMNS = "projection_record_id, projection_kind, projection_key, owner_artifact_id, owner_artifact_version_id, source_artifact_version_ids, source_record_ids, source_projection_record_ids, generator, generator_version, generator_configuration_digest, content_digest";

export class WorkspaceProjectionOccurrenceRepository {
  constructor(private readonly database: SqliteDatabase, private readonly workspaceId: string) {}

  async put(value: WorkspaceProjectionOccurrence): Promise<"inserted" | "already_present"> {
    if (value.workspace_id !== this.workspaceId) throw new StorageError("storage:workspace_mismatch", "Projection occurrence workspace does not match the workspace database.");
    const { content_digest: suppliedDigest, ...digestInput } = value;
    const contentDigest = suppliedDigest ?? canonicalSha256(digestInput);
    const payload = encodeCanonical(value.payload);
    const existing = await this.database.get<{ content_digest: string; projection_payload: unknown }>("SELECT content_digest, projection_payload FROM projection_occurrences WHERE workspace_id = ? AND projection_record_id = ? AND valid_from_generation = ?", [this.workspaceId, value.projection_record_id, value.valid_from_generation]);
    if (existing) {
      if (existing.content_digest !== contentDigest || !sameBytes(bytes(existing.projection_payload), payload)) throw new StorageError("storage:candidate_digest_conflict", `Projection occurrence ${value.projection_record_id} was written with a different digest.`);
      return "already_present";
    }
    await this.database.run("INSERT INTO projection_occurrences (projection_record_id, workspace_id, projection_kind, projection_key, owner_artifact_id, owner_artifact_version_id, source_artifact_version_ids, source_record_ids, source_projection_record_ids, generator, generator_version, generator_configuration_digest, valid_from_generation, valid_to_generation, content_digest, projection_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [value.projection_record_id, this.workspaceId, value.projection_kind, value.projection_key, value.owner_artifact_id, value.owner_artifact_version_id, JSON.stringify(value.source_artifact_version_ids), JSON.stringify(value.source_record_ids), JSON.stringify(value.source_projection_record_ids), value.generator, value.generator_version, value.generator_configuration_digest, value.valid_from_generation, nullable(value.valid_to_generation), contentDigest, payload]);
    return "inserted";
  }

  async get(projectionRecordId: string, validFromGeneration?: number): Promise<WorkspaceProjectionOccurrence | undefined> {
    const row = await this.database.get<Record<string, unknown> & { projection_payload: unknown }>(validFromGeneration === undefined
      ? "SELECT * FROM projection_occurrences WHERE workspace_id = ? AND projection_record_id = ? ORDER BY valid_from_generation DESC LIMIT 1"
      : "SELECT * FROM projection_occurrences WHERE workspace_id = ? AND projection_record_id = ? AND valid_from_generation = ?", validFromGeneration === undefined ? [this.workspaceId, projectionRecordId] : [this.workspaceId, projectionRecordId, validFromGeneration]);
    if (!row) return undefined;
    return this.decode(row);
  }

  async listByOwner(ownerArtifactId: string, ownerArtifactVersionId?: string): Promise<readonly WorkspaceProjectionOccurrence[]> {
    const rows = await this.database.all<Record<string, unknown> & { projection_payload: unknown }>(ownerArtifactVersionId === undefined
      ? "SELECT * FROM projection_occurrences WHERE workspace_id = ? AND owner_artifact_id = ? ORDER BY valid_from_generation, projection_record_id"
      : "SELECT * FROM projection_occurrences WHERE workspace_id = ? AND owner_artifact_id = ? AND owner_artifact_version_id = ? ORDER BY valid_from_generation, projection_record_id", ownerArtifactVersionId === undefined ? [this.workspaceId, ownerArtifactId] : [this.workspaceId, ownerArtifactId, ownerArtifactVersionId]);
    return rows.map((row) => this.decode(row));
  }

  async putDependency(value: ProjectionOccurrenceDependency): Promise<"inserted" | "already_present"> {
    const payload = encodeCanonical(value);
    const existing = await this.database.get<{ dependency_payload: unknown }>("SELECT dependency_payload FROM projection_occurrence_dependencies WHERE workspace_id = ? AND projection_record_id = ? AND valid_from_generation = ? AND source_type = ? AND source_id = ?", [this.workspaceId, value.projection_record_id, value.valid_from_generation, value.source_type, value.source_id]);
    if (existing) {
      if (!sameBytes(bytes(existing.dependency_payload), payload)) throw new StorageError("storage:candidate_digest_conflict", `Projection dependency ${value.projection_record_id}/${value.source_id} conflicts.`);
      return "already_present";
    }
    await this.database.run("INSERT INTO projection_occurrence_dependencies (workspace_id, projection_record_id, valid_from_generation, source_type, source_id, dependency_payload) VALUES (?, ?, ?, ?, ?, ?)", [this.workspaceId, value.projection_record_id, value.valid_from_generation, value.source_type, value.source_id, payload]);
    return "inserted";
  }

  /**
   * Every `projection_occurrences` row visible at `generation` (same
   * `valid_from_generation <= generation AND (valid_to_generation IS NULL OR
   * valid_to_generation > generation)` predicate as
   * `CanonicalOccurrenceRepository.currentlyVisible`, above), feeding
   * `CandidateMaterializationInput.base_projections`
   * (`packages/engine/src/candidate-materialization.ts`) so an unchanged
   * projection's `content_digest` can be matched and reused instead of
   * closed and reopened on every scan.
   */
  async currentlyVisible(generation: number): Promise<readonly WorkspaceProjectionOccurrence[]> {
    const rows = await this.database.all<Record<string, unknown> & { projection_payload: unknown }>(
      "SELECT * FROM projection_occurrences WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?) ORDER BY projection_record_id",
      [this.workspaceId, generation, generation],
    );
    return rows.map((row) => this.decode(row));
  }

  /**
   * `currentlyVisible`, but (a) narrowed to the given owner artifact ids
   * (`projection_occurrences_owner_idx`, `schema.ts`, chunked at
   * `OWNER_ID_CHUNK_SIZE` -- same rationale as `CanonicalOccurrenceRepository.currentlyVisibleForOwners`,
   * `repositories.ts`) and (b) never decodes `projection_payload`: every
   * seal-time consumer of `CandidateMaterializationInput.base_projections`
   * (`candidate-materialization.ts`'s `projectionTemplates`) reads only
   * `content_digest` plus the identity/source-binding columns, never the
   * payload itself, so skipping that CBOR decode (and not even selecting the
   * column) is free. Chunk results are merged and re-sorted by
   * `projection_record_id` for the same reason `currentlyVisibleForOwners`
   * re-sorts: each chunk is independently ordered, their concatenation is
   * not.
   */
  async currentlyVisibleForOwnersSlim(generation: number, ownerArtifactIds: readonly string[]): Promise<readonly WorkspaceVisibleProjection[]> {
    const chunks = chunkOwnerIds(ownerArtifactIds);
    if (chunks.length === 0) return [];
    const rows: SlimProjectionRow[] = [];
    for (const chunk of chunks) {
      const placeholders = chunk.map(() => "?").join(", ");
      // Explicit-loop append, never `push(...rows)` -- a spread passes every
      // row as a call argument and overflows the stack on large chunks (same
      // hazard as `CanonicalOccurrenceRepository.currentlyVisibleForOwners`).
      const chunkRows = await this.database.all<SlimProjectionRow>(
        `SELECT ${SLIM_PROJECTION_COLUMNS} FROM projection_occurrences
         WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)
           AND owner_artifact_id IN (${placeholders})`,
        [this.workspaceId, generation, generation, ...chunk],
      );
      for (const row of chunkRows) rows.push(row);
    }
    return rows.map(decodeSlim).sort(compareProjectionRecordId);
  }

  async dependencies(projectionRecordId: string, validFromGeneration?: number): Promise<readonly ProjectionOccurrenceDependency[]> {
    const rows = await this.database.all<Record<string, unknown>>(validFromGeneration === undefined
      ? "SELECT projection_record_id, valid_from_generation, source_type, source_id FROM projection_occurrence_dependencies WHERE workspace_id = ? AND projection_record_id = ? ORDER BY valid_from_generation, source_type, source_id"
      : "SELECT projection_record_id, valid_from_generation, source_type, source_id FROM projection_occurrence_dependencies WHERE workspace_id = ? AND projection_record_id = ? AND valid_from_generation = ? ORDER BY source_type, source_id", validFromGeneration === undefined ? [this.workspaceId, projectionRecordId] : [this.workspaceId, projectionRecordId, validFromGeneration]);
    return rows.map((row) => ({ projection_record_id: String(row["projection_record_id"]), valid_from_generation: Number(row["valid_from_generation"]), source_type: String(row["source_type"]) as ProjectionOccurrenceDependency["source_type"], source_id: String(row["source_id"]) }));
  }

  private decode(row: Record<string, unknown> & { projection_payload: unknown }): WorkspaceProjectionOccurrence {
    return {
      projection_record_id: String(row["projection_record_id"]),
      projection_kind: String(row["projection_kind"]),
      projection_key: String(row["projection_key"]),
      workspace_id: String(row["workspace_id"]),
      owner_artifact_id: String(row["owner_artifact_id"]),
      owner_artifact_version_id: String(row["owner_artifact_version_id"]),
      source_artifact_version_ids: JSON.parse(String(row["source_artifact_version_ids"])) as string[],
      source_record_ids: JSON.parse(String(row["source_record_ids"])) as string[],
      source_projection_record_ids: JSON.parse(String(row["source_projection_record_ids"])) as string[],
      generator: String(row["generator"]),
      generator_version: String(row["generator_version"]),
      generator_configuration_digest: String(row["generator_configuration_digest"]),
      valid_from_generation: Number(row["valid_from_generation"]),
      ...(row["valid_to_generation"] === null ? {} : { valid_to_generation: Number(row["valid_to_generation"]) }),
      content_digest: String(row["content_digest"]),
      payload: decodeCanonical(bytes(row["projection_payload"])),
    };
  }
}
