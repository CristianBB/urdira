import { decodeCanonical, digestBytes, encodeCanonical } from "@urdira/canonical";
import type { BlobStore } from "./cas.js";
import { StorageError } from "./errors.js";
import type { SqliteDatabase, SqliteValue } from "./sqlite.js";

export interface GraphEdge {
  readonly edge_id: string;
  readonly source_subject_id: string;
  readonly target_subject_id: string;
  readonly relation_record_id: string;
  readonly relation_kind: string;
  readonly role: string;
  readonly evidence_class: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly valid_from_generation: number;
  readonly valid_to_generation?: number;
}

export interface LexicalDocumentInput {
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly text: string;
  readonly valid_from_generation?: number;
  readonly valid_to_generation?: number;
}

export interface LexicalMatch {
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly offsets: ReadonlyArray<number>;
}

/**
 * The async post-ready semantic maintenance marker's shape (`semantic_index_state`,
 * schema.ts) -- mirrors the lexical marker (`lexicalCompletedGeneration`/
 * `markLexicalComplete`, below) except it also pins the embedding provider
 * identity. `completed_generation` alone cannot tell a caller whether the
 * embedded vectors were produced by the CURRENTLY configured provider or a
 * since-replaced one (different model, different runtime binding): a
 * provider swap invalidates every previously-embedded vector even though the
 * generation number the reconciler last caught up to hasn't moved, so
 * `profile_id`/`executable_binding_id` must be compared alongside
 * `completed_generation` before trusting the marker.
 */
export interface SemanticIndexState {
  readonly completed_generation: number;
  readonly profile_id: string;
  readonly executable_binding_id: string;
  /**
   * Decision 17: which document grains `completed_generation` is complete
   * for -- `["artifact", "entity"]` once the reconciler's entity pass has
   * also completed cleanly at this generation/provider identity, `undefined`
   * for a marker written before the entity pass existed (or read back before
   * one has ever completed). Absent (not `["artifact"]`) for the pre-entity
   * case rather than defaulted, so callers can tell "artifact-only, honestly"
   * apart from "this marker predates grain tracking entirely" if that
   * distinction ever matters -- today both read the same way (entity
   * coverage incomplete).
   */
  readonly document_grains?: readonly ("artifact" | "entity")[];
  /**
   * Decision 17: digest of the entity-eligibility policy the entity pass ran
   * under when this marker was written (see `entityEligibilityPolicyDigest`,
   * `@urdira/engine`'s `semantic-reconciler.ts`). `undefined` for a marker
   * written before policy tracking existed. The reconciler treats a marker as
   * entity-complete only when this matches its OWN current policy digest, so
   * a predicate/knob change backfills already-"complete" workspaces; the
   * query side ignores it entirely.
   */
  readonly entity_policy_digest?: string;
}

export interface ArtifactDependency {
  readonly dependency_entry_id: string;
  readonly record_id: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly dependency_artifact_id: string;
  readonly dependency_artifact_version_id: string;
  readonly dependency_role: string;
  readonly producer_id: string;
  readonly producer_version: string;
  readonly valid_from_generation: number;
  readonly valid_to_generation?: number;
}

export interface MetricProjection {
  readonly metric_id: string;
  readonly projection_record_id: string;
  readonly metric_kind: string;
  readonly metric_value: number;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly valid_from_generation: number;
  readonly valid_to_generation?: number;
}

export interface VectorProjectionInput {
  readonly projection_record_id: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly profile_id: string;
  readonly executable_binding_id: string;
  readonly dimensions: number;
  readonly element_type: string;
  readonly vector: Uint8Array;
  readonly vector_encoding?: "float32-le" | "float64-le";
  readonly normalization?: "none" | "l2";
  readonly distance_metric?: "squared_l2" | "cosine";
  readonly valid_from_generation?: number;
  readonly valid_to_generation?: number;
  /**
   * Decision 17: which document grain this row belongs to. Omitted (not
   * `"artifact"`) for every artifact-grain row, matching the column's
   * NULL-means-artifact convention (`schema.ts`) -- only the reconciler's
   * entity pass ever passes `"entity"`, alongside `document_ref`.
   */
  readonly document_grain?: "artifact" | "entity";
  /** The owning entity record_id for an entity-grain row. Must be set iff `document_grain === "entity"` -- see `putVectors`'s own validation. */
  readonly document_ref?: string;
}

export type VectorBatchInput = VectorProjectionInput;

export interface VectorMatch {
  readonly projection_record_id: string;
  readonly distance: number;
  readonly vector_digest: string;
}

interface StoredGraphEdge extends Record<string, unknown> { readonly edge_payload: unknown; }
interface StoredDependency extends Record<string, unknown> { readonly dependency_payload: unknown; }
interface StoredMetric extends Record<string, unknown> { readonly metric_payload: unknown; }

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new StorageError("storage:invalid_blob", "SQLite returned a non-binary payload.");
}

function nullable(value: number | undefined): SqliteValue { return value ?? null; }
// Decision 17: `semantic_index_state.document_grains` is stored as a plain
// JSON array (not canonical-CBOR like every other payload column in this
// file) -- it is a small, human-inspectable marker field read directly by
// SQL-adjacent tooling, not a content-addressed/digested payload, so the
// heavier canonical encoding buys nothing here. A NULL, unparseable, or
// non-array value all read back as "no grains recorded" (`undefined`),
// matching the "predates grain tracking" meaning `SemanticIndexState.document_grains`'s
// doc comment describes -- this is a read of the reconciler's OWN prior
// write, never externally supplied, so silently treating anything malformed
// as absent (rather than throwing) is the same defensive-but-permissive
// posture `decodeCanonical` callers elsewhere in this file are not, because
// those callers decode payloads this repository itself wrote atomically.
function decodeDocumentGrains(value: string | null): readonly ("artifact" | "entity")[] | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const grains = parsed.filter((entry): entry is "artifact" | "entity" => entry === "artifact" || entry === "entity");
    return grains.length === parsed.length && grains.length > 0 ? grains : undefined;
  } catch {
    return undefined;
  }
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]); }
function decodePayload<T>(value: unknown): T { return decodeCanonical(bytes(value)) as T; }
function normalizedTerm(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("en-US"); }
// Trigrams are computed over normalizedTerm(text), not the raw string: this
// makes every document's trigram set a case/normalization-insensitive
// superset of any substring it contains, so a single trigram prefilter
// (also built from normalizedTerm(pattern)) is a valid candidate filter for
// BOTH case-sensitive and case-insensitive searchLiteral verification (see
// searchLiteral below) -- normalization only folds case/compatibility forms,
// it never removes byte sequences that survive into the normalized form.
export function lexicalTrigrams(text: string): ReadonlyArray<string> {
  const source = new TextEncoder().encode(normalizedTerm(text));
  const result = new Set<string>();
  for (let index = 0; index + 3 <= source.length; index += 1) result.add(Array.from(source.slice(index, index + 3), (value) => value.toString(16).padStart(2, "0")).join(""));
  return [...result].sort();
}

interface VectorConfig {
  readonly element_type: "float32" | "float64";
  readonly vector_encoding: "float32-le" | "float64-le";
  readonly normalization: "none" | "l2";
  readonly distance_metric: "squared_l2" | "cosine";
}

function vectorConfig(value: VectorProjectionInput): VectorConfig {
  if (value.element_type !== "float32" && value.element_type !== "float64") throw new StorageError("storage:unsupported_vector_encoding", `Vector element type ${value.element_type} is not supported.`);
  const vectorEncoding = value.vector_encoding ?? (value.element_type === "float32" ? "float32-le" : "float64-le");
  if ((value.element_type === "float32" && vectorEncoding !== "float32-le") || (value.element_type === "float64" && vectorEncoding !== "float64-le")) throw new StorageError("storage:unsupported_vector_encoding", `Vector encoding ${vectorEncoding} does not match ${value.element_type}.`);
  const normalization = value.normalization ?? "none";
  const distanceMetric = value.distance_metric ?? "squared_l2";
  if (normalization !== "none" && normalization !== "l2") throw new StorageError("storage:unsupported_vector_profile", `Vector normalization ${normalization} is not supported.`);
  if (distanceMetric !== "squared_l2" && distanceMetric !== "cosine") throw new StorageError("storage:unsupported_vector_profile", `Vector distance metric ${distanceMetric} is not supported.`);
  return { element_type: value.element_type, vector_encoding: vectorEncoding, normalization, distance_metric: distanceMetric };
}

function decodeVectorValues(vector: Uint8Array, config: VectorConfig): number[] {
  const view = new DataView(vector.buffer, vector.byteOffset, vector.byteLength);
  const width = config.element_type === "float32" ? 4 : 8;
  const values: number[] = [];
  for (let offset = 0; offset < vector.byteLength; offset += width) values.push(config.element_type === "float32" ? view.getFloat32(offset, true) : view.getFloat64(offset, true));
  if (values.some((value) => !Number.isFinite(value))) throw new StorageError("storage:invalid_vector", "Vector values must be finite.");
  return values;
}

function encodeVectorValues(values: readonly number[], config: VectorConfig): Uint8Array {
  const width = config.element_type === "float32" ? 4 : 8;
  const bytes = new Uint8Array(values.length * width);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => { if (!Number.isFinite(value)) throw new StorageError("storage:invalid_vector", "Vector values must be finite."); if (config.element_type === "float32") view.setFloat32(index * width, Object.is(value, -0) ? 0 : value, true); else view.setFloat64(index * width, Object.is(value, -0) ? 0 : value, true); });
  return bytes;
}

function canonicalVectorBytes(vector: Uint8Array, dimensions: number, config: VectorConfig): Uint8Array {
  const width = config.element_type === "float32" ? 4 : 8;
  if (vector.byteLength !== dimensions * width) throw new StorageError("storage:invalid_vector", "Vector byte length does not match its declared dimensions.");
  let values = decodeVectorValues(vector, config);
  if (config.normalization === "l2") {
    const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
    if (norm === 0) throw new StorageError("storage:invalid_vector", "L2 normalization cannot normalize a zero vector.");
    values = values.map((value) => value / norm);
  }
  return encodeVectorValues(values, config);
}

export class WorkspaceProjectionRepository {
  constructor(private readonly database: SqliteDatabase, private readonly blobs: BlobStore, private readonly workspaceId: string) {}

  private async requireArtifactVersion(artifactId: string, artifactVersionId: string): Promise<{ content_hash: string; byte_length: number }> {
    const row = await this.database.get<{ content_hash: string; byte_length: number }>("SELECT version.content_hash, version.byte_length FROM artifact_versions AS version WHERE version.workspace_id = ? AND version.artifact_id = ? AND version.artifact_version_id = ? AND EXISTS (SELECT 1 FROM source_artifacts AS artifact WHERE artifact.workspace_id = version.workspace_id AND artifact.artifact_id = version.artifact_id)", [this.workspaceId, artifactId, artifactVersionId]);
    if (!row) throw new StorageError("storage:projection_owner_missing", `Projection owner ${artifactId}/${artifactVersionId} is not retained in this workspace.`);
    return row;
  }

  private visibleClause(generation: number, alias: string): { sql: string; params: SqliteValue[] } {
    return { sql: ` AND ${alias}.valid_from_generation <= ? AND (${alias}.valid_to_generation IS NULL OR ${alias}.valid_to_generation > ?)`, params: [generation, generation] };
  }

  private async resolveGeneration(generation: number | undefined): Promise<number> {
    if (generation !== undefined) {
      if (!Number.isSafeInteger(generation) || generation < 0) throw new StorageError("storage:invalid_generation", "Projection generation must be a non-negative safe integer.");
      return generation;
    }
    const current = await this.database.get<{ current_generation: number }>("SELECT current_generation FROM workspace_current_state WHERE workspace_id = ?", [this.workspaceId]);
    if (current) return current.current_generation;
    const sourceIndex = await this.database.get<{ current_generation: number }>("SELECT current_generation FROM source_index_state WHERE workspace_id = ?", [this.workspaceId]);
    if (sourceIndex) return sourceIndex.current_generation;
    const latest = await this.database.get<{ generation: number | null }>(`SELECT MAX(generation) AS generation FROM (
      SELECT generation FROM snapshots WHERE workspace_id = ?
      UNION ALL SELECT valid_from_generation AS generation FROM graph_edges WHERE workspace_id = ?
      UNION ALL SELECT valid_from_generation FROM lexical_documents WHERE workspace_id = ?
      UNION ALL SELECT valid_from_generation FROM artifact_dependencies WHERE workspace_id = ?
      UNION ALL SELECT valid_from_generation FROM metric_projections WHERE workspace_id = ?
      UNION ALL SELECT valid_from_generation FROM vector_projection_rows WHERE workspace_id = ?
    )`, [this.workspaceId, this.workspaceId, this.workspaceId, this.workspaceId, this.workspaceId, this.workspaceId]);
    if (latest?.generation !== null && latest?.generation !== undefined) return latest.generation;
    return 0;
  }

  async putGraphEdge(value: GraphEdge): Promise<void> {
    await this.requireArtifactVersion(value.owner_artifact_id, value.owner_artifact_version_id);
    const payload = encodeCanonical(value);
    const existing = await this.database.get<{ edge_payload: unknown }>("SELECT edge_payload FROM graph_edges WHERE workspace_id = ? AND edge_id = ? AND valid_from_generation = ?", [this.workspaceId, value.edge_id, value.valid_from_generation]);
    if (existing) {
      if (!sameBytes(bytes(existing.edge_payload), payload)) throw new StorageError("storage:projection_immutable", `Graph edge ${value.edge_id} conflicts with its immutable payload.`);
      return;
    }
    // `content_digest` is `digestBytes(payload)` computed once here at write
    // time -- the exact leaf recipe `projectionSetDigestEntries` uses -- so
    // its "stored" read path never has to re-hash this row's BLOB.
    await this.database.run(`INSERT INTO graph_edges (edge_id, workspace_id, source_subject_id, target_subject_id, relation_record_id, relation_kind, role, evidence_class, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation, edge_payload, content_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [value.edge_id, this.workspaceId, value.source_subject_id, value.target_subject_id, value.relation_record_id, value.relation_kind, value.role, value.evidence_class, value.owner_artifact_id, value.owner_artifact_version_id, value.valid_from_generation, nullable(value.valid_to_generation), payload, digestBytes(payload)]);
  }

  async neighbors(subjectId: string, direction: "inbound" | "outbound" | "both" = "outbound", options: { readonly generation?: number } = {}): Promise<readonly GraphEdge[]> {
    const clauses: string[] = [];
    const params: SqliteValue[] = [this.workspaceId];
    if (direction === "outbound" || direction === "both") { clauses.push("source_subject_id = ?"); params.push(subjectId); }
    if (direction === "inbound" || direction === "both") { clauses.push("target_subject_id = ?"); params.push(subjectId); }
    const visibility = this.visibleClause(await this.resolveGeneration(options.generation), "graph_edges");
    const rows = await this.database.all<StoredGraphEdge>(`SELECT edge_payload FROM graph_edges WHERE workspace_id = ? AND (${clauses.join(" OR ")})${visibility.sql} ORDER BY relation_kind, role, target_subject_id, edge_id, valid_from_generation`, [...params, ...visibility.params]);
    return rows.map((row) => decodePayload<GraphEdge>(row.edge_payload));
  }

  async putLexicalDocument(value: LexicalDocumentInput): Promise<void> {
    const sourceBytes = new TextEncoder().encode(value.text);
    const contentHash = digestBytes(sourceBytes);
    const owner = await this.requireArtifactVersion(value.artifact_id, value.artifact_version_id);
    if (owner.content_hash !== contentHash || owner.byte_length !== sourceBytes.byteLength) throw new StorageError("storage:projection_source_mismatch", `Lexical bytes do not match artifact version ${value.artifact_version_id}.`);
    const validFromGeneration = value.valid_from_generation ?? 0;
    const normalizedValue = { ...value, valid_from_generation: validFromGeneration, ...(value.valid_to_generation === undefined ? {} : { valid_to_generation: value.valid_to_generation }) };
    const existing = await this.database.get<{ content_hash: string; document_payload: unknown }>("SELECT content_hash, document_payload FROM lexical_documents WHERE workspace_id = ? AND artifact_id = ? AND artifact_version_id = ?", [this.workspaceId, value.artifact_id, value.artifact_version_id]);
    if (existing) {
      if (existing.content_hash !== contentHash || !sameBytes(bytes(existing.document_payload), encodeCanonical(normalizedValue))) throw new StorageError("storage:projection_immutable", `Lexical document ${value.artifact_id} conflicts with its immutable payload.`);
      return;
    }
    const blob = await this.blobs.cas.put(sourceBytes, { media_type: "text/plain; charset=utf-8" });
    const documentPayload = encodeCanonical(normalizedValue);
    const documentTrigrams = lexicalTrigrams(value.text);
    // Trigram rows are ordered BEFORE the `lexical_documents` row itself
    // (not after), so that the "already inserted" existence check at the top
    // of this method (`SELECT ... FROM lexical_documents WHERE ...`) can
    // never observe a document as present before every one of its trigrams
    // is durably committed alongside it. `transactionChunked` (see
    // `packages/storage/src/sqlite.ts`) drives the whole set through ONE
    // atomic `BEGIN IMMEDIATE` ... `COMMIT` no matter how many `batch_chunk`
    // messages it takes to get there -- chunking only bounds the size of
    // each individual postMessage structured clone (this call used to ship
    // 1+N commands, N = this document's trigram count, in a single message,
    // which is the actual cost the daemon's cross-thread lexical worker
    // needs bounded -- see `packages/daemon/src/lexical-worker-thread.ts`),
    // it does not weaken atomicity or allow a partial commit. This ordering
    // is therefore defense-in-depth against a future change to that
    // guarantee, not a requirement for correctness today.
    const commands = [
      ...documentTrigrams.map((trigram) => ({ kind: "run" as const, sql: "INSERT INTO lexical_trigrams (workspace_id, trigram, artifact_id, artifact_version_id, trigram_payload) VALUES (?, ?, ?, ?, ?)", params: [this.workspaceId, trigram, value.artifact_id, value.artifact_version_id, encodeCanonical({ trigram })] as readonly SqliteValue[] })),
      { kind: "run" as const, sql: "INSERT INTO lexical_documents (artifact_id, workspace_id, artifact_version_id, content_hash, byte_length, storage_reference, valid_from_generation, valid_to_generation, document_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", params: [value.artifact_id, this.workspaceId, value.artifact_version_id, contentHash, sourceBytes.byteLength, blob.storage_reference, validFromGeneration, nullable(value.valid_to_generation), documentPayload] as readonly SqliteValue[] },
    ];
    // Both commands above are `run`, so this stream qualifies for
    // `discard_results` -- see `TransactionChunkedOptions.discard_results`
    // (packages/storage/src/sqlite.ts); this call has never read the
    // return value.
    await this.database.transactionChunked(commands, undefined, { discard_results: true });
  }

  async searchLiteral(pattern: string, options: { readonly case_sensitive?: boolean; readonly generation?: number } = {}): Promise<readonly LexicalMatch[]> {
    const normalizedPattern = normalizedTerm(pattern);
    const visibility = this.visibleClause(await this.resolveGeneration(options.generation), "lexical_documents");
    // Prefilter with trigrams of normalizedTerm(pattern) in BOTH case modes:
    // document trigrams are normalized (see lexicalTrigrams), so the pattern's
    // normalized trigrams are a valid superset filter regardless of which
    // case mode verification below uses. Patterns whose normalized UTF-8 form
    // is under 3 bytes can't form a whole trigram, so every visible doc is a
    // candidate (existing behavior, unchanged by this normalization).
    const candidateRows = new TextEncoder().encode(normalizedPattern).byteLength >= 3
      ? await this.database.all<{ artifact_id: string; artifact_version_id: string }>(`SELECT DISTINCT lexical_trigrams.artifact_id, lexical_trigrams.artifact_version_id FROM lexical_trigrams JOIN lexical_documents ON lexical_documents.workspace_id = lexical_trigrams.workspace_id AND lexical_documents.artifact_id = lexical_trigrams.artifact_id AND lexical_documents.artifact_version_id = lexical_trigrams.artifact_version_id WHERE lexical_trigrams.workspace_id = ? AND lexical_trigrams.trigram IN (SELECT value FROM json_each(?))${visibility.sql} ORDER BY lexical_trigrams.artifact_id, lexical_trigrams.artifact_version_id`, [this.workspaceId, JSON.stringify(lexicalTrigrams(pattern)), ...visibility.params])
      : await this.database.all<{ artifact_id: string; artifact_version_id: string }>(`SELECT artifact_id, artifact_version_id FROM lexical_documents WHERE workspace_id = ?${visibility.sql} ORDER BY artifact_id, artifact_version_id`, [this.workspaceId, ...visibility.params]);
    const matches: LexicalMatch[] = [];
    for (const candidate of candidateRows) {
      const row = await this.database.get<{ content_hash: string; storage_reference: string }>("SELECT content_hash, storage_reference FROM lexical_documents WHERE workspace_id = ? AND artifact_id = ? AND artifact_version_id = ?", [this.workspaceId, candidate.artifact_id, candidate.artifact_version_id]);
      if (!row) continue;
      const source = new TextDecoder().decode(await this.blobs.cas.read(row.content_hash));
      // Case-insensitive verification runs against normalizedTerm(source),
      // so returned offsets are indices into the normalized string, not the
      // raw source -- this caveat predates this change. Case-sensitive
      // verification runs against the exact raw source and raw pattern.
      const comparable = options.case_sensitive ? source : normalizedTerm(source);
      const needle = options.case_sensitive ? pattern : normalizedPattern;
      const offsets: number[] = [];
      let start = 0;
      while (true) {
        const offset = comparable.indexOf(needle, start);
        if (offset < 0) break;
        offsets.push(offset);
        start = offset + Math.max(1, needle.length);
      }
      if (offsets.length > 0) matches.push({ artifact_id: candidate.artifact_id, artifact_version_id: candidate.artifact_version_id, offsets });
    }
    return matches;
  }

  /** Generation through which the async post-ready lexical maintenance job has fully reconciled documents+trigrams, or undefined if it has never completed. */
  async lexicalCompletedGeneration(): Promise<number | undefined> {
    const row = await this.database.get<{ completed_generation: number }>("SELECT completed_generation FROM lexical_index_state WHERE workspace_id = ?", [this.workspaceId]);
    return row?.completed_generation;
  }

  /** Records that lexical maintenance has fully reconciled through `generation`; one row per workspace, replaced wholesale. */
  async markLexicalComplete(generation: number): Promise<void> {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new StorageError("storage:invalid_generation", "Lexical completion generation must be a non-negative safe integer.");
    await this.database.run("INSERT INTO lexical_index_state (workspace_id, completed_generation) VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET completed_generation = excluded.completed_generation", [this.workspaceId, generation]);
  }

  /** The async post-ready semantic maintenance job's last fully-reconciled generation and the embedding provider identity it reconciled under, or undefined if it has never completed. */
  async semanticIndexState(): Promise<SemanticIndexState | undefined> {
    const row = await this.database.get<{ completed_generation: number; profile_id: string; executable_binding_id: string; document_grains: string | null; entity_policy_digest: string | null }>("SELECT completed_generation, profile_id, executable_binding_id, document_grains, entity_policy_digest FROM semantic_index_state WHERE workspace_id = ?", [this.workspaceId]);
    if (row === undefined) return undefined;
    const documentGrains = decodeDocumentGrains(row.document_grains);
    return { completed_generation: row.completed_generation, profile_id: row.profile_id, executable_binding_id: row.executable_binding_id, ...(documentGrains === undefined ? {} : { document_grains: documentGrains }), ...(row.entity_policy_digest === null ? {} : { entity_policy_digest: row.entity_policy_digest }) };
  }

  /** Records that semantic maintenance has fully reconciled through `state.completed_generation` under `state`'s embedding provider identity; one row per workspace, replaced wholesale. `state.document_grains` (decision 17), when given, is stored as a canonical-JSON array; omitted (not an empty array) leaves `document_grains` NULL, read back as "predates grain tracking" -- see `SemanticIndexState.document_grains`'s own doc comment. */
  async markSemanticComplete(state: SemanticIndexState): Promise<void> {
    if (!Number.isSafeInteger(state.completed_generation) || state.completed_generation < 0) throw new StorageError("storage:invalid_generation", "Semantic completion generation must be a non-negative safe integer.");
    if (state.profile_id.length === 0 || state.executable_binding_id.length === 0) throw new StorageError("storage:invalid_semantic_index_state", "Semantic completion requires a non-empty profile_id and executable_binding_id.");
    const documentGrains = state.document_grains === undefined ? null : JSON.stringify(state.document_grains);
    await this.database.run("INSERT INTO semantic_index_state (workspace_id, completed_generation, profile_id, executable_binding_id, document_grains, entity_policy_digest) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET completed_generation = excluded.completed_generation, profile_id = excluded.profile_id, executable_binding_id = excluded.executable_binding_id, document_grains = excluded.document_grains, entity_policy_digest = excluded.entity_policy_digest", [this.workspaceId, state.completed_generation, state.profile_id, state.executable_binding_id, documentGrains, state.entity_policy_digest ?? null]);
  }

  async putDependency(value: ArtifactDependency): Promise<void> {
    await this.requireArtifactVersion(value.owner_artifact_id, value.owner_artifact_version_id);
    await this.requireArtifactVersion(value.dependency_artifact_id, value.dependency_artifact_version_id);
    const payload = encodeCanonical(value);
    const existing = await this.database.get<{ dependency_payload: unknown }>("SELECT dependency_payload FROM artifact_dependencies WHERE workspace_id = ? AND dependency_entry_id = ? AND valid_from_generation = ?", [this.workspaceId, value.dependency_entry_id, value.valid_from_generation]);
    if (existing) {
      if (!sameBytes(bytes(existing.dependency_payload), payload)) throw new StorageError("storage:projection_immutable", `Dependency ${value.dependency_entry_id} conflicts with its immutable payload.`);
      return;
    }
    // `content_digest` is `digestBytes(payload)` computed once here at write
    // time -- the exact leaf recipe `projectionSetDigestEntries` uses -- so
    // its "stored" read path never has to re-hash this row's BLOB.
    await this.database.run(`INSERT INTO artifact_dependencies (dependency_entry_id, workspace_id, record_id, owner_artifact_id, owner_artifact_version_id, dependency_artifact_id, dependency_artifact_version_id, dependency_role, producer_id, producer_version, valid_from_generation, valid_to_generation, dependency_payload, content_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [value.dependency_entry_id, this.workspaceId, value.record_id, value.owner_artifact_id, value.owner_artifact_version_id, value.dependency_artifact_id, value.dependency_artifact_version_id, value.dependency_role, value.producer_id, value.producer_version, value.valid_from_generation, nullable(value.valid_to_generation), payload, digestBytes(payload)]);
  }

  async dependents(artifactId: string, artifactVersionId?: string, options: { readonly generation?: number } = {}): Promise<readonly ArtifactDependency[]> {
    const visibility = this.visibleClause(await this.resolveGeneration(options.generation), "artifact_dependencies");
    const rows = artifactVersionId === undefined
      ? await this.database.all<StoredDependency>(`SELECT dependency_payload FROM artifact_dependencies WHERE workspace_id = ? AND dependency_artifact_id = ?${visibility.sql} ORDER BY dependency_artifact_version_id, dependency_role, record_id, dependency_entry_id, valid_from_generation`, [this.workspaceId, artifactId, ...visibility.params])
      : await this.database.all<StoredDependency>(`SELECT dependency_payload FROM artifact_dependencies WHERE workspace_id = ? AND dependency_artifact_id = ? AND dependency_artifact_version_id = ?${visibility.sql} ORDER BY dependency_role, record_id, dependency_entry_id, valid_from_generation`, [this.workspaceId, artifactId, artifactVersionId, ...visibility.params]);
    return rows.map((row) => decodePayload<ArtifactDependency>(row.dependency_payload));
  }

  async putMetric(value: MetricProjection): Promise<void> {
    await this.requireArtifactVersion(value.owner_artifact_id, value.owner_artifact_version_id);
    if (!Number.isFinite(value.metric_value)) throw new StorageError("storage:invalid_metric", "Metric projections require a finite numeric value.");
    const payload = encodeCanonical(value);
    const existing = await this.database.get<{ metric_payload: unknown }>("SELECT metric_payload FROM metric_projections WHERE workspace_id = ? AND metric_id = ? AND valid_from_generation = ?", [this.workspaceId, value.metric_id, value.valid_from_generation]);
    if (existing) {
      if (!sameBytes(bytes(existing.metric_payload), payload)) throw new StorageError("storage:projection_immutable", `Metric ${value.metric_id} conflicts with its immutable payload.`);
      return;
    }
    // `content_digest` is `digestBytes(payload)` computed once here at write
    // time -- the exact leaf recipe `projectionSetDigestEntries` uses -- so
    // its "stored" read path never has to re-hash this row's BLOB.
    await this.database.run("INSERT INTO metric_projections (metric_id, workspace_id, projection_record_id, metric_kind, metric_value, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation, metric_payload, content_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [value.metric_id, this.workspaceId, value.projection_record_id, value.metric_kind, value.metric_value, value.owner_artifact_id, value.owner_artifact_version_id, value.valid_from_generation, nullable(value.valid_to_generation), payload, digestBytes(payload)]);
  }

  async getMetric(metricId: string, generation?: number): Promise<MetricProjection | undefined> {
    const visibility = this.visibleClause(await this.resolveGeneration(generation), "metric_projections");
    const row = await this.database.get<StoredMetric>(`SELECT metric_payload FROM metric_projections WHERE workspace_id = ? AND metric_id = ?${visibility.sql} ORDER BY valid_from_generation DESC LIMIT 1`, [this.workspaceId, metricId, ...visibility.params]);
    return row ? decodePayload<MetricProjection>(row.metric_payload) : undefined;
  }

  async putVector(value: VectorProjectionInput): Promise<void> { await this.putVectors([value]); }

  async putVectors(values: ReadonlyArray<VectorProjectionInput>): Promise<void> {
    if (values.length === 0) throw new StorageError("storage:invalid_vector_batch", "A vector shard batch must contain at least one vector.");
    const ordered = [...values].sort((left, right) => left.projection_record_id.localeCompare(right.projection_record_id));
    if (new Set(ordered.map((value) => value.projection_record_id)).size !== ordered.length) throw new StorageError("storage:vector_batch_conflict", "A packed vector batch cannot contain duplicate projection identities.");
    const first = ordered[0];
    if (!first || !Number.isSafeInteger(first.dimensions) || first.dimensions <= 0) throw new StorageError("storage:invalid_vector", "Vector dimensions must be a positive safe integer.");
    const config = vectorConfig(first);
    const normalizedValues: Array<{ input: VectorProjectionInput; config: VectorConfig; vector: Uint8Array; payload: Uint8Array; digest: string; offset: number; valid_from_generation: number; valid_to_generation: number | undefined; key: string }> = [];
    let offset = 0;
    for (const input of ordered) {
      if (input.dimensions !== first.dimensions || input.profile_id !== first.profile_id || input.executable_binding_id !== first.executable_binding_id) throw new StorageError("storage:vector_profile_mismatch", "All vectors in a packed shard must share one vector space.");
      const inputConfig = vectorConfig(input);
      if (JSON.stringify(inputConfig) !== JSON.stringify(config)) throw new StorageError("storage:vector_profile_mismatch", "All vectors in a packed shard must share one encoding, normalization, and metric.");
      // Decision 17: `document_ref` is required exactly when `document_grain`
      // is `"entity"` -- an artifact row (grain omitted/`"artifact"`) must
      // never carry a dangling entity reference, and an entity row must
      // always be traceable back to the record that produced it.
      if ((input.document_grain === "entity") !== (typeof input.document_ref === "string" && input.document_ref.length > 0)) throw new StorageError("storage:invalid_vector_document_ref", "document_ref must be set if and only if document_grain is \"entity\".");
      await this.requireArtifactVersion(input.owner_artifact_id, input.owner_artifact_version_id);
      const vector = canonicalVectorBytes(input.vector, input.dimensions, config);
      const validFromGeneration = input.valid_from_generation ?? 0;
      if (!Number.isSafeInteger(validFromGeneration) || validFromGeneration < 0 || (input.valid_to_generation !== undefined && (!Number.isSafeInteger(input.valid_to_generation) || input.valid_to_generation <= validFromGeneration))) throw new StorageError("storage:invalid_vector_interval", "Vector validity intervals must be ordered safe generation integers.");
      const payload = encodeCanonical({ ...input, vector, vector_encoding: config.vector_encoding, normalization: config.normalization, distance_metric: config.distance_metric, valid_from_generation: validFromGeneration, ...(input.valid_to_generation === undefined ? {} : { valid_to_generation: input.valid_to_generation }) });
      normalizedValues.push({ input, config, vector, payload, digest: digestBytes(vector), offset, valid_from_generation: validFromGeneration, valid_to_generation: input.valid_to_generation, key: `${input.projection_record_id}@${validFromGeneration}` });
      offset += vector.byteLength;
    }
    const packed = new Uint8Array(offset);
    for (const item of normalizedValues) packed.set(item.vector, item.offset);
    const existingRows = await this.database.all<{ projection_record_id: string; valid_from_generation: number; vector_payload: unknown }>(`SELECT projection_record_id, valid_from_generation, vector_payload FROM vector_projection_rows WHERE workspace_id = ? AND projection_record_id IN (${ordered.map(() => "?").join(",")})`, [this.workspaceId, ...ordered.map((value) => value.projection_record_id)]);
    const existingById = new Map(existingRows.map((row) => [`${row.projection_record_id}@${row.valid_from_generation}`, row]));
    for (const item of normalizedValues) {
      const existing = existingById.get(item.key);
      if (existing && !sameBytes(bytes(existing.vector_payload), item.payload)) throw new StorageError("storage:projection_immutable", `Vector ${item.input.projection_record_id} conflicts with its immutable payload.`);
    }
    if (normalizedValues.every((item) => existingById.has(item.key))) return;
    const shard = await this.blobs.cas.put(packed, { media_type: "application/octet-stream" });
    const shardId = `shard:${shard.content_hash}`;
    const shardPayload = encodeCanonical({ shard_id: shardId, content_hash: shard.content_hash, dimensions: first.dimensions, element_type: config.element_type, vector_encoding: config.vector_encoding, normalization: config.normalization, distance_metric: config.distance_metric });
    const existingShard = await this.database.get<{ shard_id: string }>("SELECT shard_id FROM vector_shards WHERE workspace_id = ? AND content_hash = ?", [this.workspaceId, shard.content_hash]);
    const commands: Array<{ kind: "run"; sql: string; params: readonly SqliteValue[] }> = [];
    if (!existingShard) commands.push({ kind: "run", sql: "INSERT INTO vector_shards (shard_id, workspace_id, profile_id, executable_binding_id, dimensions, element_type, vector_encoding, normalization, distance_metric, byte_length, content_hash, storage_reference, created_at, shard_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", params: [shardId, this.workspaceId, first.profile_id, first.executable_binding_id, first.dimensions, config.element_type, config.vector_encoding, config.normalization, config.distance_metric, packed.byteLength, shard.content_hash, shard.storage_reference, new Date().toISOString(), shardPayload] });
    for (const item of normalizedValues) if (!existingById.has(item.key)) commands.push({ kind: "run", sql: "INSERT INTO vector_projection_rows (projection_record_id, workspace_id, shard_id, shard_offset, byte_length, vector_digest, owner_artifact_id, owner_artifact_version_id, profile_id, executable_binding_id, dimensions, element_type, vector_encoding, normalization, distance_metric, valid_from_generation, valid_to_generation, vector_payload, document_grain, document_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", params: [item.input.projection_record_id, this.workspaceId, existingShard?.shard_id ?? shardId, item.offset, item.vector.byteLength, item.digest, item.input.owner_artifact_id, item.input.owner_artifact_version_id, item.input.profile_id, item.input.executable_binding_id, item.input.dimensions, config.element_type, config.vector_encoding, config.normalization, config.distance_metric, item.valid_from_generation, nullable(item.valid_to_generation), item.payload, item.input.document_grain ?? null, item.input.document_ref ?? null] });
    await this.database.transaction(commands);
  }

  async readVector(projectionRecordId: string, options: { readonly generation?: number } = {}): Promise<Uint8Array> {
    const resolvedGeneration = await this.resolveGeneration(options.generation);
    const visibility = this.visibleClause(resolvedGeneration, "vector_projection_rows");
    const row = await this.database.get<{ shard_id: string; shard_offset: number; byte_length: number; vector_digest: string }>(`SELECT shard_id, shard_offset, byte_length, vector_digest FROM vector_projection_rows WHERE workspace_id = ? AND projection_record_id = ?${visibility.sql} ORDER BY valid_from_generation DESC LIMIT 1`, [this.workspaceId, projectionRecordId, ...visibility.params]);
    if (!row) return Promise.reject(new StorageError("storage:vector_not_found", `Vector ${projectionRecordId} is not retained.`));
    const shard = await this.database.get<{ content_hash: string }>("SELECT content_hash FROM vector_shards WHERE workspace_id = ? AND shard_id = ?", [this.workspaceId, row.shard_id]);
    if (!shard) throw new StorageError("storage:vector_shard_missing", `Vector shard ${row.shard_id} is not retained.`);
    const source = await this.blobs.cas.read(shard.content_hash);
    const vector = source.slice(row.shard_offset, row.shard_offset + row.byte_length);
    if (digestBytes(vector) !== row.vector_digest) throw new StorageError("storage:vector_corrupt", `Vector ${projectionRecordId} failed digest verification.`);
    return vector;
  }

  async exactVectorSearch(query: Uint8Array, options: { readonly profile_id: string; readonly executable_binding_id: string; readonly dimensions: number; readonly element_type?: "float32" | "float64"; readonly vector_encoding?: "float32-le" | "float64-le"; readonly normalization?: "none" | "l2"; readonly distance_metric?: "squared_l2" | "cosine"; readonly generation?: number; readonly limit?: number }): Promise<readonly VectorMatch[]> {
    const queryInput: VectorProjectionInput = { projection_record_id: "query", owner_artifact_id: "query", owner_artifact_version_id: "query", profile_id: options.profile_id, executable_binding_id: options.executable_binding_id, dimensions: options.dimensions, element_type: options.element_type ?? "float32", vector: query, ...(options.vector_encoding === undefined ? {} : { vector_encoding: options.vector_encoding }), ...(options.normalization === undefined ? {} : { normalization: options.normalization }), ...(options.distance_metric === undefined ? {} : { distance_metric: options.distance_metric }) };
    const config = vectorConfig(queryInput);
    const canonicalQuery = canonicalVectorBytes(query, options.dimensions, config);
    const queryValues = decodeVectorValues(canonicalQuery, config);
    const resolvedGeneration = await this.resolveGeneration(options.generation);
    const visibility = this.visibleClause(resolvedGeneration, "vector_projection_rows");
    const visibleRows = await this.database.all<{ projection_record_id: string; vector_digest: string; valid_from_generation: number }>(`SELECT projection_record_id, vector_digest, valid_from_generation FROM vector_projection_rows WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ? AND dimensions = ? AND element_type = ? AND vector_encoding = ? AND normalization = ? AND distance_metric = ?${visibility.sql} ORDER BY projection_record_id, valid_from_generation DESC`, [this.workspaceId, options.profile_id, options.executable_binding_id, options.dimensions, config.element_type, config.vector_encoding, config.normalization, config.distance_metric, ...visibility.params]);
    const rows = visibleRows.filter((row, index) => index === 0 || row.projection_record_id !== visibleRows[index - 1]?.projection_record_id);
    const matches: VectorMatch[] = [];
    for (const row of rows) {
      const visibleVector = await this.readVector(row.projection_record_id, { generation: resolvedGeneration });
      const vectorValues = decodeVectorValues(visibleVector, config);
      let distance = 0;
      if (config.distance_metric === "cosine") {
        let dot = 0; let queryNorm = 0; let vectorNorm = 0;
        for (let index = 0; index < options.dimensions; index += 1) { const queryValue = queryValues[index] ?? 0; const vectorValue = vectorValues[index] ?? 0; dot += queryValue * vectorValue; queryNorm += queryValue * queryValue; vectorNorm += vectorValue * vectorValue; }
        distance = queryNorm === 0 || vectorNorm === 0 ? 1 : 1 - dot / Math.sqrt(queryNorm * vectorNorm);
      } else {
        for (let index = 0; index < options.dimensions; index += 1) { const difference = (queryValues[index] ?? 0) - (vectorValues[index] ?? 0); distance += difference * difference; }
      }
      matches.push({ projection_record_id: row.projection_record_id, distance, vector_digest: row.vector_digest });
    }
    matches.sort((left, right) => left.distance - right.distance || left.projection_record_id.localeCompare(right.projection_record_id));
    return matches.slice(0, options.limit ?? matches.length);
  }
}
