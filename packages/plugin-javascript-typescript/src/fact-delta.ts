import { createHash, type Hash } from "node:crypto";
import type { FactDelta, FactDeltaStreamHeader, ProposedRecord, ProposedRecordDependency, ReplacementScope } from "@urdira/contracts";
import { FACT_DELTA_STREAM_MAX_ROWS, buildFactDeltaStreamBatch, buildProjectedSealedFactDeltaStreamBatch, canonicalJson, canonicalSha256, factDeltaStreamCanonicalRow, factDeltaStreamHeaderDigest, type FactDeltaStream, type SealedStructuralProjectionOwner } from "@urdira/plugin-sdk";
import { JAVASCRIPT_TYPESCRIPT_NAMESPACE, type JsTsAnalysisResult } from "./analyzer.js";
import { javascriptTypescriptProposedDependencyId, javascriptTypescriptProposalRecordKey } from "./proposal-identity.js";

export interface JavascriptTypescriptFactDeltaInput {
  readonly analysis: JsTsAnalysisResult;
  readonly work_item: Readonly<Record<string, unknown>>;
  readonly accepted_manifest: Readonly<Record<string, unknown>>;
  readonly analysis_digest: string;
  readonly analysis_configuration_digest: string;
  readonly analysis_input_digest: string;
  readonly created_at: string;
  readonly publication_stage_id?: string;
  readonly included_publication_stage_ids?: readonly string[];
  readonly owner_path?: string;
  readonly files?: readonly Readonly<{
    path: string;
    artifact_id?: string;
    artifact_version_id?: string;
    content_hash?: string;
  }>[];
}

export type JavascriptTypescriptNativeFactDeltaInput = Omit<JavascriptTypescriptFactDeltaInput, "analysis"> & {
  readonly owner_path: string;
  /** Stage-one records are constructed by the verified Rust worker. */
  readonly records: readonly ProposedRecord[];
  /** Cross-artifact dependencies are constructed by the verified Rust worker. */
  readonly dependencies: readonly ProposedRecordDependency[];
  /** Canonical rows already produced by the structural core, when available. */
  readonly canonical_records?: readonly string[];
  readonly canonical_dependencies?: readonly string[];
  readonly diagnostic_codes: readonly string[];
};

export type JavascriptTypescriptProjectedFactDeltaInput = Omit<JavascriptTypescriptFactDeltaInput, "analysis"> & {
  readonly owner_path: string;
  readonly projection: SealedStructuralProjectionOwner;
};

/** Owner-local logical rows prepared by a language adapter but not yet
 * framed. The generic core may preseal several such owners in one bounded
 * Rust call; `seal()` still creates an independent header and stream. */
export interface PreparedJavascriptTypescriptFactDeltaStream {
  readonly records: readonly ProposedRecord[];
  readonly dependencies: readonly ProposedRecordDependency[];
  seal(): FactDeltaStream;
}

export const JAVASCRIPT_TYPESCRIPT_NATIVE_PROJECTION_PROFILE = "urdira:jsts-semantic-observations:v1" as const;

/** Compact, language-owned observations accepted by the registered native
 * projector. The core sees only the resulting language-neutral rows. */
export function javascriptTypescriptNativeProjectionOwner(input: JavascriptTypescriptFactDeltaInput): Readonly<Record<string, unknown>> {
  const path = ownerPath(input);
  const scopes = parseReplacementScopes(input.work_item["expected_replacement_scopes"]);
  const allowedRecordKinds = [...new Set(scopes.flatMap((scope) => scope.record_kinds))]
    .filter((kind) => stageAllowsRecord(input.publication_stage_id, kind, input.included_publication_stage_ids));
  return Object.freeze({
    language: input.analysis.language,
    owner_path: path,
    entities: input.analysis.entities,
    relations: input.analysis.relations,
    diagnostics: input.analysis.diagnostics,
    files: (input.files ?? []).map((file) => ({
      path: file.path,
      ...(file.artifact_id === undefined ? {} : { artifact_id: file.artifact_id }),
      ...(file.artifact_version_id === undefined ? {} : { artifact_version_id: file.artifact_version_id }),
      ...(file.content_hash === undefined ? {} : { content_hash: file.content_hash }),
    })),
    allowed_record_kinds: allowedRecordKinds,
  });
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`FactDelta work item field ${field} is required.`);
  return value;
}

// A full-workspace scan builds one delta per owner artifact against the same
// analysis result and file list; these per-object memos turn the per-owner
// full scans of all entities/relations/diagnostics into single index builds.
interface AnalysisIndexes {
  readonly entitiesByPath: ReadonlyMap<string, readonly JsTsAnalysisResult["entities"][number][]>;
  readonly relationsByPath: ReadonlyMap<string, readonly JsTsAnalysisResult["relations"][number][]>;
  readonly diagnosticsByPath: ReadonlyMap<string, readonly JsTsAnalysisResult["diagnostics"][number][]>;
  readonly entityById: ReadonlyMap<string, JsTsAnalysisResult["entities"][number]>;
}

const analysisIndexMemo = new WeakMap<JsTsAnalysisResult, AnalysisIndexes>();
const filesIndexMemo = new WeakMap<object, ReadonlyMap<string, NonNullable<JavascriptTypescriptFactDeltaInput["files"]>[number]>>();
const manifestVersionIdsMemo = new WeakMap<object, readonly string[]>();

function groupByPath<T extends { readonly path: string }>(values: readonly T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const bucket = result.get(value.path);
    if (bucket === undefined) result.set(value.path, [value]);
    else bucket.push(value);
  }
  return result;
}

function analysisIndexes(analysis: JsTsAnalysisResult): AnalysisIndexes {
  const cached = analysisIndexMemo.get(analysis);
  if (cached !== undefined) return cached;
  const indexes: AnalysisIndexes = {
    entitiesByPath: groupByPath(analysis.entities),
    relationsByPath: groupByPath(analysis.relations),
    diagnosticsByPath: groupByPath(analysis.diagnostics),
    entityById: new Map(analysis.entities.map((entity) => [entity.id, entity])),
  };
  analysisIndexMemo.set(analysis, indexes);
  return indexes;
}

function fileIndex(files: JavascriptTypescriptFactDeltaInput["files"]): ReadonlyMap<string, NonNullable<JavascriptTypescriptFactDeltaInput["files"]>[number]> {
  if (files === undefined) return new Map();
  const cached = filesIndexMemo.get(files);
  if (cached !== undefined) return cached;
  const index = new Map(files.map((file) => [file.path, file]));
  filesIndexMemo.set(files, index);
  return index;
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`FactDelta work item field ${field} must be an array.`);
  return value;
}

function parseReplacementScopes(value: unknown): readonly ReplacementScope[] {
  return array(value, "expected_replacement_scopes").map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError(`expected_replacement_scopes[${index}] must be an object.`);
    const scope = entry as Record<string, unknown>;
    for (const field of ["replacement_scope_id", "owner_artifact_id", "owner_artifact_version_id", "capability", "base_record_set_digest", "output_completeness"]) text(scope[field], `expected_replacement_scopes[${index}].${field}`);
    for (const field of ["record_categories", "record_kinds"]) {
      const values = array(scope[field], `expected_replacement_scopes[${index}].${field}`);
      if (values.some((item) => typeof item !== "string" || item.length === 0)) throw new TypeError(`expected_replacement_scopes[${index}].${field} must contain non-empty strings.`);
    }
    return scope as unknown as ReplacementScope;
  });
}

function manifestArray(manifest: Readonly<Record<string, unknown>>, field: string): readonly Record<string, unknown>[] {
  return array(manifest[field], `accepted_manifest.${field}`).map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`accepted_manifest.${field}[${index}] must be an object.`);
    }
    return entry as Record<string, unknown>;
  });
}

function proposalRecord(entity: JsTsAnalysisResult["entities"][number], analysis: JsTsAnalysisResult): ProposedRecord {
  const kind = entity.universal_kind === "core:type" ? "jsts:entity_type" : entity.universal_kind === "core:callable" ? "jsts:entity_callable" : entity.universal_kind === "core:container" ? "jsts:entity_container" : entity.universal_kind === "core:parameter" ? "jsts:entity_parameter" : "jsts:entity_variable";
  const body = { name: entity.name, kind: entity.kind, language: analysis.language, path: entity.path, start: entity.start, end: entity.end, ...(entity.parent_id === undefined ? {} : { parent_id: entity.parent_id }), ...(entity.qualified_name === undefined ? {} : { qualified_name: entity.qualified_name }), ...(entity.type === undefined ? {} : { type: entity.type }), ...(entity.is_test === undefined ? {} : { is_test: entity.is_test }) };
  return {
    proposal_record_key: javascriptTypescriptProposalRecordKey(entity.id),
    category: "entity",
    kind,
    universal_kind: entity.universal_kind,
    facets: canonicalJson(entity.parent_id === undefined ? ["core:declaration", "core:definition"] : ["core:declaration", "core:definition", "core:member"]),
    schema_version: 1,
    source_span: canonicalJson({ path: entity.path, start: entity.start, end: entity.end }),
    identity_key: entity.id,
    body,
    evidence_references: canonicalJson([{ path: entity.path, start: entity.start, end: entity.end }]),
  };
}

function semanticTypeRecords(entity: JsTsAnalysisResult["entities"][number], analysis: JsTsAnalysisResult): readonly ProposedRecord[] {
  if (entity.type === undefined) return [];
  const typeIdentity = `${JAVASCRIPT_TYPESCRIPT_NAMESPACE}:inferred-type:${entity.id}:${canonicalSha256(entity.type).slice("sha256:".length)}`;
  const span = canonicalJson({ path: entity.path, start: entity.start, end: entity.end });
  const evidence = canonicalJson([{ path: entity.path, start: entity.start, end: entity.end }]);
  return [{
    proposal_record_key: javascriptTypescriptProposalRecordKey(typeIdentity),
    category: "entity",
    kind: "jsts:entity_inferred_type",
    universal_kind: "core:type",
    facets: canonicalJson([]),
    schema_version: 1,
    source_span: span,
    identity_key: typeIdentity,
    body: {
      name: `inferred type of ${entity.qualified_name ?? entity.name}`,
      kind: "inferred_type",
      type: entity.type,
      language: analysis.language,
      path: entity.path,
      start: entity.start,
      end: entity.end,
    },
    evidence_references: evidence,
  }, {
    proposal_record_key: javascriptTypescriptProposalRecordKey(`${JAVASCRIPT_TYPESCRIPT_NAMESPACE}:type-of:${entity.id}:${typeIdentity}`),
    category: "relation",
    kind: "jsts:relation_type_of",
    universal_kind: "core:type_of",
    facets: canonicalJson(["core:reference_relation"]),
    schema_version: 1,
    source_span: span,
    identity_key: `${JAVASCRIPT_TYPESCRIPT_NAMESPACE}:type-of:${entity.id}:${typeIdentity}`,
    body: { source_id: entity.id, target_id: typeIdentity, classification: "confirmed", path: entity.path, start: entity.start, end: entity.end },
    evidence_references: evidence,
  }];
}

function proposalRelationRecord(relation: JsTsAnalysisResult["relations"][number]): ProposedRecord {
  const kind = `jsts:relation_${relation.kind.slice("core:".length)}`;
  return {
    proposal_record_key: javascriptTypescriptProposalRecordKey(relation.id),
    category: "relation",
    kind,
    universal_kind: relation.kind,
    facets: canonicalJson(relation.kind === "core:contains" ? ["core:structural_relation"] : ["core:reference_relation", ...(relation.classification === "possible" ? ["core:indirect"] : [])]),
    schema_version: 1,
    source_span: canonicalJson({ path: relation.path, start: relation.start, end: relation.end }),
    identity_key: relation.id,
    body: { source_id: relation.source_id, ...(relation.target_id === undefined ? {} : { target_id: relation.target_id }), classification: relation.classification, path: relation.path, start: relation.start, end: relation.end },
    evidence_references: canonicalJson([{ path: relation.path, start: relation.start, end: relation.end }]),
  };
}

function proposalDiagnosticRecord(diagnostic: JsTsAnalysisResult["diagnostics"][number], index: number): ProposedRecord {
  const key = `jsts:diagnostic:${diagnostic.path}:${diagnostic.start ?? 0}:${diagnostic.code}:${index}`;
  return {
    proposal_record_key: javascriptTypescriptProposalRecordKey(key),
    category: "diagnostic",
    kind: "jsts:diagnostic",
    universal_kind: "core:construct",
    facets: canonicalJson([]),
    schema_version: 1,
    source_span: canonicalJson({ path: diagnostic.path, ...(diagnostic.start === undefined ? {} : { start: diagnostic.start }), ...(diagnostic.end === undefined ? {} : { end: diagnostic.end }) }),
    identity_key: key,
    body: { code: diagnostic.code, ...(diagnostic.compiler_code === undefined ? {} : { compiler_code: diagnostic.compiler_code }), message: diagnostic.message, path: diagnostic.path, ...(diagnostic.start === undefined ? {} : { start: diagnostic.start }), ...(diagnostic.end === undefined ? {} : { end: diagnostic.end }) },
    evidence_references: canonicalJson([{ path: diagnostic.path, ...(diagnostic.start === undefined ? {} : { start: diagnostic.start }), ...(diagnostic.end === undefined ? {} : { end: diagnostic.end }) }]),
  };
}

function ownerPath(input: JavascriptTypescriptFactDeltaInput): string {
  if (input.owner_path !== undefined) return input.owner_path;
  const paths = new Set([...input.analysis.entities.map((entity) => entity.path), ...input.analysis.relations.map((relation) => relation.path), ...input.analysis.diagnostics.map((diagnostic) => diagnostic.path)]);
  if (paths.size !== 1) throw new TypeError("FactDelta analysis spanning several artifacts requires owner_path.");
  const path = [...paths][0];
  if (path === undefined) throw new TypeError("FactDelta owner_path is required for empty artifact output.");
  return path;
}

function crossArtifactDependencies(
  records: readonly ProposedRecord[],
  analysis: JsTsAnalysisResult,
  files: JavascriptTypescriptFactDeltaInput["files"],
  path: string,
): readonly ProposedRecordDependency[] {
  const { entityById, relationsByPath } = analysisIndexes(analysis);
  const fileByPath = fileIndex(files);
  const recordByIdentity = new Map(records.map((record) => [record.identity_key, record]));
  const result: ProposedRecordDependency[] = [];
  for (const relation of (relationsByPath.get(path) ?? []).filter((entry) => entry.target_id !== undefined)) {
    const target = entityById.get(relation.target_id!);
    if (target === undefined || target.path === path) continue;
    const targetFile = fileByPath.get(target.path);
    const proposal = recordByIdentity.get(relation.id);
    if (proposal === undefined || targetFile?.artifact_id === undefined || targetFile.artifact_version_id === undefined) continue;
    result.push({
      proposed_dependency_id: javascriptTypescriptProposedDependencyId(relation.id, targetFile.artifact_version_id),
      proposal_record_key: proposal.proposal_record_key,
      dependency_artifact_id: targetFile.artifact_id,
      dependency_artifact_version_id: targetFile.artifact_version_id,
      dependency_role: "jsts:resolution_input",
      dependency_basis: "checker_resolution",
      source_reference: { reference_type: "local_proposal", proposal_record_key: proposal.proposal_record_key, ...(targetFile.content_hash === undefined ? {} : { content_hash: targetFile.content_hash }) },
    });
  }
  // Relations are already ordered by their stable relation identity. Preserve
  // that order after replacing the formerly prefixed dependency identity with
  // a digest so FactDelta@1 and streaming output remain byte-equivalent.
  return result;
}

function* proposedRecords(input: JavascriptTypescriptFactDeltaInput, path: string, scopes: readonly ReplacementScope[]): Generator<ProposedRecord> {
  const plannedKinds = new Set(scopes.flatMap((scope) => scope.record_kinds));
  const indexes = analysisIndexes(input.analysis);
  for (const entity of indexes.entitiesByPath.get(path) ?? []) {
    const record = proposalRecord(entity, input.analysis);
    if (plannedKinds.has(record.kind) && stageAllowsRecord(input.publication_stage_id, record.kind, input.included_publication_stage_ids)) yield record;
    for (const semanticRecord of semanticTypeRecords(entity, input.analysis)) {
      if (plannedKinds.has(semanticRecord.kind) && stageAllowsRecord(input.publication_stage_id, semanticRecord.kind, input.included_publication_stage_ids)) yield semanticRecord;
    }
  }
  for (const relation of indexes.relationsByPath.get(path) ?? []) {
    const record = proposalRelationRecord(relation);
    if (plannedKinds.has(record.kind) && stageAllowsRecord(input.publication_stage_id, record.kind, input.included_publication_stage_ids)) yield record;
  }
  let diagnosticIndex = 0;
  for (const diagnostic of indexes.diagnosticsByPath.get(path) ?? []) {
    const record = proposalDiagnosticRecord(diagnostic, diagnosticIndex);
    diagnosticIndex += 1;
    if (plannedKinds.has(record.kind) && stageAllowsRecord(input.publication_stage_id, record.kind, input.included_publication_stage_ids)) yield record;
  }
}

function* proposedDependencies(input: JavascriptTypescriptFactDeltaInput, path: string, scopes: readonly ReplacementScope[]): Generator<ProposedRecordDependency> {
  const { entityById, relationsByPath } = analysisIndexes(input.analysis);
  const fileByPath = fileIndex(input.files);
  const plannedKinds = new Set(scopes.flatMap((scope) => scope.record_kinds));
  // Analyzer relations are already sorted by stable relation id. Preserve
  // that semantic order even though the bounded dependency id is now opaque.
  for (const relation of relationsByPath.get(path) ?? []) {
    if (relation.target_id === undefined) continue;
    const relationRecord = proposalRelationRecord(relation);
    if (!plannedKinds.has(relationRecord.kind) || !stageAllowsRecord(input.publication_stage_id, relationRecord.kind, input.included_publication_stage_ids)) continue;
    const target = entityById.get(relation.target_id);
    if (target === undefined || target.path === path) continue;
    const targetFile = fileByPath.get(target.path);
    if (targetFile?.artifact_id === undefined || targetFile.artifact_version_id === undefined) continue;
    yield {
      proposed_dependency_id: javascriptTypescriptProposedDependencyId(relation.id, targetFile.artifact_version_id),
      proposal_record_key: relationRecord.proposal_record_key,
      dependency_artifact_id: targetFile.artifact_id,
      dependency_artifact_version_id: targetFile.artifact_version_id,
      dependency_role: "jsts:resolution_input",
      dependency_basis: "checker_resolution",
      source_reference: { reference_type: "local_proposal", proposal_record_key: relationRecord.proposal_record_key, ...(targetFile.content_hash === undefined ? {} : { content_hash: targetFile.content_hash }) },
    };
  }
}

function updateCanonicalArray(hash: Hash, values: Iterable<ProposedRecord | ProposedRecordDependency>, aggregate: Hash): number {
  hash.update("[", "utf8");
  aggregate.update("[", "utf8");
  let count = 0;
  for (const value of values) {
    if (count > 0) {
      hash.update(",", "utf8");
      aggregate.update(",", "utf8");
    }
    // A configured structural kernel owns this encoding before sealing. The
    // immutable row cache avoids running JSON canonicalization again while
    // constructing the owner header and delta digest.
    const encoded = factDeltaStreamCanonicalRow(value);
    hash.update(encoded, "utf8");
    aggregate.update(encoded, "utf8");
    count += 1;
  }
  hash.update("]", "utf8");
  aggregate.update("]", "utf8");
  return count;
}

function streamDigestMetrics(
  core: Readonly<Record<string, unknown>>,
  records: () => Iterable<ProposedRecord>,
  dependencies: () => Iterable<ProposedRecordDependency>,
): { readonly delta_digest: string; readonly record_count: number; readonly records_digest: string; readonly dependency_count: number; readonly dependencies_digest: string } {
  const delta = createHash("sha256");
  const recordDigest = createHash("sha256");
  const dependencyDigest = createHash("sha256");
  const keys = [...Object.keys(core), "proposed_records", "proposed_dependencies"]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  delta.update("{", "utf8");
  let recordCount = 0;
  let dependencyCount = 0;
  for (const [index, key] of keys.entries()) {
    if (index > 0) delta.update(",", "utf8");
    delta.update(`${JSON.stringify(key)}:`, "utf8");
    if (key === "proposed_records") recordCount = updateCanonicalArray(delta, records(), recordDigest);
    else if (key === "proposed_dependencies") dependencyCount = updateCanonicalArray(delta, dependencies(), dependencyDigest);
    else delta.update(canonicalJson(core[key]), "utf8");
  }
  delta.update("}", "utf8");
  return {
    delta_digest: `sha256:${delta.digest("hex")}`,
    record_count: recordCount,
    records_digest: `sha256:${recordDigest.digest("hex")}`,
    dependency_count: dependencyCount,
    dependencies_digest: `sha256:${dependencyDigest.digest("hex")}`,
  };
}

function streamDigestMetricsCanonical(
  core: Readonly<Record<string, unknown>>,
  records: readonly string[],
  dependencies: readonly string[],
): { readonly delta_digest: string; readonly record_count: number; readonly records_digest: string; readonly dependency_count: number; readonly dependencies_digest: string } {
  const arrayDigest = (rows: readonly string[]): string => {
    const hash = createHash("sha256");
    hash.update("[", "utf8");
    rows.forEach((row, index) => { if (index > 0) hash.update(",", "utf8"); hash.update(row, "utf8"); });
    hash.update("]", "utf8");
    return `sha256:${hash.digest("hex")}`;
  };
  const delta = createHash("sha256");
  const keys = [...Object.keys(core), "proposed_records", "proposed_dependencies"].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  delta.update("{", "utf8");
  keys.forEach((key, index) => {
    if (index > 0) delta.update(",", "utf8");
    delta.update(`${JSON.stringify(key)}:`, "utf8");
    if (key === "proposed_records" || key === "proposed_dependencies") {
      const rows = key === "proposed_records" ? records : dependencies;
      delta.update("[", "utf8");
      rows.forEach((row, rowIndex) => { if (rowIndex > 0) delta.update(",", "utf8"); delta.update(row, "utf8"); });
      delta.update("]", "utf8");
    } else delta.update(canonicalJson(core[key]), "utf8");
  });
  delta.update("}", "utf8");
  return { delta_digest: `sha256:${delta.digest("hex")}`, record_count: records.length, records_digest: arrayDigest(records), dependency_count: dependencies.length, dependencies_digest: arrayDigest(dependencies) };
}

function commonFactDelta(
  input: Omit<JavascriptTypescriptFactDeltaInput, "analysis">,
  path: string,
  diagnosticKeys: readonly string[],
  reasonCodes: readonly string[],
): {
  readonly path: string;
  readonly scopes: readonly ReplacementScope[];
  readonly core: Readonly<Record<string, unknown>>;
} {
  const workItem = input.work_item;
  const manifest = input.accepted_manifest;
  const scopes = parseReplacementScopes(workItem["expected_replacement_scopes"]);
  if (scopes.length === 0) throw new TypeError("FactDelta requires at least one planned replacement scope.");
  const rawVersionEntries = manifest["artifact_version_entries"];
  const memoizedVersionIds = Array.isArray(rawVersionEntries) ? manifestVersionIdsMemo.get(rawVersionEntries) : undefined;
  const inputArtifactVersionIds = memoizedVersionIds ?? [...new Set(manifestArray(manifest, "artifact_version_entries").map((entry) => text(entry["artifact_version_id"], "artifact_version_id")))].sort();
  if (memoizedVersionIds === undefined && Array.isArray(rawVersionEntries)) manifestVersionIdsMemo.set(rawVersionEntries, inputArtifactVersionIds);
  const inputRecordIds = [...new Set(manifestArray(manifest, "record_entries").filter((entry) => entry["input_type"] === "base_record").map((entry) => text(entry["record_id"], "record_id")))].sort();
  const workItemId = text(workItem["work_item_id"], "work_item_id");
  const completenessClaims = scopes.map((scope, index) => ({
    completeness_claim_id: `jsts:completeness:${workItemId}:${index}`,
    capability: scope.capability,
    replacement_scope_ids: scope.replacement_scope_id,
    status: reasonCodes.length === 0 ? "complete" : "partial",
    reason_codes: canonicalJson(reasonCodes),
    affected_artifact_ids: canonicalJson(reasonCodes.length === 0 ? [] : [text(workItem["artifact_id"], "artifact_id")]),
    diagnostic_proposal_keys: canonicalJson(diagnosticKeys),
  }));
  return {
    path,
    scopes,
    core: {
      candidate_generation_id: text(workItem["candidate_generation_id"], "candidate_generation_id"),
      workspace_id: text(workItem["workspace_id"], "workspace_id"),
      ...(typeof workItem["base_snapshot_id"] === "string" ? { base_snapshot_id: workItem["base_snapshot_id"] } : {}),
      work_item_id: workItemId,
      plugin_id: text(workItem["plugin_id"], "plugin_id"),
      plugin_version: text(workItem["plugin_version"], "plugin_version"),
      analysis_digest: input.analysis_digest,
      analysis_configuration_digest: input.analysis_configuration_digest,
      ...(input.publication_stage_id === undefined ? {} : { publication_stage_id: input.publication_stage_id }),
      owner_artifact_id: text(workItem["artifact_id"], "artifact_id"),
      owner_artifact_version_id: text(workItem["target_artifact_version_id"], "target_artifact_version_id"),
      replacement_scopes: scopes,
      input_artifact_version_ids: inputArtifactVersionIds,
      input_record_ids: inputRecordIds,
      plugin_input_access_manifest_id: text(manifest["plugin_input_access_manifest_id"], "plugin_input_access_manifest_id"),
      plugin_input_access_manifest_digest: text(manifest["manifest_digest"], "manifest_digest"),
      analysis_input_digest: input.analysis_input_digest,
      completeness_claims: completenessClaims,
    },
  };
}

type StreamRowGroup = { readonly records: readonly ProposedRecord[]; readonly dependencies: readonly ProposedRecordDependency[] };
type StreamRow = { readonly kind: "record"; readonly value: ProposedRecord } | { readonly kind: "dependency"; readonly value: ProposedRecordDependency };

function* boundedRowGroups(factDeltaId: string, rows: Iterable<StreamRow>): Generator<StreamRowGroup> {
  const split = function* (records: readonly ProposedRecord[], dependencies: readonly ProposedRecordDependency[]): Generator<StreamRowGroup> {
    try {
      buildFactDeltaStreamBatch({ fact_delta_id: factDeltaId, sequence: 0, final: false, records, dependencies });
      yield { records, dependencies };
    } catch (error) {
      const size = records.length + dependencies.length;
      if (size <= 1) throw error;
      const all: StreamRow[] = [...records.map((value): StreamRow => ({ kind: "record", value })), ...dependencies.map((value): StreamRow => ({ kind: "dependency", value }))];
      const midpoint = Math.floor(all.length / 2);
      for (const half of [all.slice(0, midpoint), all.slice(midpoint)]) {
        yield* split(half.flatMap((entry) => entry.kind === "record" ? [entry.value] : []), half.flatMap((entry) => entry.kind === "dependency" ? [entry.value] : []));
      }
    }
  };
  let buffered: StreamRow[] = [];
  for (const row of rows) {
    buffered.push(row);
    if (buffered.length < FACT_DELTA_STREAM_MAX_ROWS) continue;
    yield* split(buffered.flatMap((entry) => entry.kind === "record" ? [entry.value] : []), buffered.flatMap((entry) => entry.kind === "dependency" ? [entry.value] : []));
    buffered = [];
  }
  if (buffered.length > 0) yield* split(buffered.flatMap((entry) => entry.kind === "record" ? [entry.value] : []), buffered.flatMap((entry) => entry.kind === "dependency" ? [entry.value] : []));
}

/** Direct built-in output. It computes aggregate commitments in one bounded
 * pass, then recreates rows into acknowledged batches without constructing a
 * corpus-sized FactDelta@1 proposal array. */
export function prepareJavascriptTypescriptFactDeltaStream(input: JavascriptTypescriptFactDeltaInput, options: { readonly cancellation_id: string }): PreparedJavascriptTypescriptFactDeltaStream {
  if (options.cancellation_id.length === 0) throw new TypeError("FactDeltaStream cancellation identity is required.");
  const path = ownerPath(input);
  const scopes = parseReplacementScopes(input.work_item["expected_replacement_scopes"]);
  const ownerDiagnostics = analysisIndexes(input.analysis).diagnosticsByPath.get(path) ?? [];
  // Keep one owner-local immutable row set. Previously the semantic process
  // rebuilt every record once for diagnostics, once for aggregate digests and
  // once for streaming. The owner boundary is already the protocol's bounded
  // release unit, so retaining only this owner's rows removes two complete
  // TypeScript construction walks without widening corpus residency.
  const records = Object.freeze([...proposedRecords(input, path, scopes)]);
  const dependencies = Object.freeze([...proposedDependencies(input, path, scopes)]);
  const diagnosticKeys = records.filter((record) => record.category === "diagnostic").map((record) => record.proposal_record_key);
  const reasonCodes = [...new Set(ownerDiagnostics.map((diagnostic) => diagnostic.code))].sort();
  const prepared = commonFactDelta(input, path, diagnosticKeys, reasonCodes);
  return Object.freeze({ records, dependencies, seal: () => buildPreparedFactDeltaStream(input, prepared, records, dependencies, options) });
}

/** Direct built-in output for scalar callers. Grouped callers should prepare
 * all owners, invoke the generic structural group preseal, and then seal each
 * owner in canonical order. */
export function buildJavascriptTypescriptFactDeltaStream(input: JavascriptTypescriptFactDeltaInput, options: { readonly cancellation_id: string }): FactDeltaStream {
  return prepareJavascriptTypescriptFactDeltaStream(input, options).seal();
}

function buildPreparedFactDeltaStream(
  input: Omit<JavascriptTypescriptFactDeltaInput, "analysis">,
  prepared: ReturnType<typeof commonFactDelta>,
  records: readonly ProposedRecord[],
  dependencies: readonly ProposedRecordDependency[],
  options: { readonly cancellation_id: string },
): FactDeltaStream {
  const factDeltaId = `jsts:delta:${String(input.work_item["candidate_generation_id"])}:${String(input.work_item["work_item_id"])}`;
  // Budgeting builds provisional native-backed groups first. That primes the
  // kernel's canonical-row cache, after which header/delta sealing and final
  // batch framing reuse the exact Rust-owned bytes.
  const rowGroups = Object.freeze([...boundedRowGroups(factDeltaId, (function* () {
    for (const value of records) yield { kind: "record" as const, value };
    for (const value of dependencies) yield { kind: "dependency" as const, value };
  })())]);
  const metrics = streamDigestMetrics(prepared.core, () => records, () => dependencies);
  const headerPayload: Omit<FactDeltaStreamHeader, "stream_digest"> = {
    protocol_version: 2,
    schema_id: "core:FactDeltaStream",
    fact_delta_id: factDeltaId,
    candidate_generation_id: prepared.core["candidate_generation_id"] as string,
    workspace_id: prepared.core["workspace_id"] as string,
    ...(prepared.core["base_snapshot_id"] === undefined ? {} : { base_snapshot_id: prepared.core["base_snapshot_id"] as string }),
    work_item_id: prepared.core["work_item_id"] as string,
    plugin_id: prepared.core["plugin_id"] as string,
    plugin_version: prepared.core["plugin_version"] as string,
    analysis_digest: prepared.core["analysis_digest"] as string,
    analysis_configuration_digest: prepared.core["analysis_configuration_digest"] as string,
    ...(prepared.core["publication_stage_id"] === undefined ? {} : { publication_stage_id: prepared.core["publication_stage_id"] as string }),
    owner_artifact_id: prepared.core["owner_artifact_id"] as string,
    owner_artifact_version_id: prepared.core["owner_artifact_version_id"] as string,
    replacement_scopes: prepared.scopes,
    replacement_scope_count: prepared.scopes.length,
    replacement_scopes_digest: canonicalSha256(prepared.scopes),
    input_artifact_version_ids: prepared.core["input_artifact_version_ids"] as readonly string[],
    input_artifact_version_count: (prepared.core["input_artifact_version_ids"] as readonly string[]).length,
    input_artifact_versions_digest: canonicalSha256(prepared.core["input_artifact_version_ids"]),
    input_record_ids: prepared.core["input_record_ids"] as readonly string[],
    input_record_count: (prepared.core["input_record_ids"] as readonly string[]).length,
    input_records_digest: canonicalSha256(prepared.core["input_record_ids"]),
    plugin_input_access_manifest_id: prepared.core["plugin_input_access_manifest_id"] as string,
    plugin_input_access_manifest_digest: prepared.core["plugin_input_access_manifest_digest"] as string,
    analysis_input_digest: prepared.core["analysis_input_digest"] as string,
    completeness_claims: prepared.core["completeness_claims"] as FactDeltaStreamHeader["completeness_claims"],
    completeness_claim_count: (prepared.core["completeness_claims"] as readonly unknown[]).length,
    completeness_claims_digest: canonicalSha256(prepared.core["completeness_claims"]),
    proposed_record_count: metrics.record_count,
    proposed_records_digest: metrics.records_digest,
    proposed_dependency_count: metrics.dependency_count,
    proposed_dependencies_digest: metrics.dependencies_digest,
    created_at: input.created_at,
    delta_digest: metrics.delta_digest,
    cancellation_id: options.cancellation_id,
    backpressure: { acknowledgement_mode: "per_batch", max_in_flight_batches: 1 },
  };
  const header = Object.freeze({ ...headerPayload, stream_digest: factDeltaStreamHeaderDigest(headerPayload) });
  const batches = (async function* () {
    let pending: StreamRowGroup | undefined;
    let sequence = 0;
    for (const group of rowGroups) {
      if (pending !== undefined) {
        yield buildFactDeltaStreamBatch({ fact_delta_id: factDeltaId, sequence, final: false, ...pending });
        sequence += 1;
      }
      pending = group;
    }
    yield buildFactDeltaStreamBatch({ fact_delta_id: factDeltaId, sequence, final: true, records: pending?.records ?? [], dependencies: pending?.dependencies ?? [] });
  })();
  return { header, batches };
}

/** Build a validated stream around rows already constructed by the exclusive
 * Rust stage-one owner. TypeScript does not recreate analyzer entities,
 * relations, bodies, facets, evidence, or dependency rows on this path. */
export function buildJavascriptTypescriptNativeFactDeltaStream(
  input: JavascriptTypescriptNativeFactDeltaInput,
  options: { readonly cancellation_id: string },
): FactDeltaStream {
  return prepareJavascriptTypescriptNativeFactDeltaStream(input, options).seal();
}

/**
 * Builds only the stable owner header for a native observation. Unlike the
 * stream builder this never allocates row groups or batch envelopes; the Rust
 * indexing core has already validated and staged those rows. It is used for
 * the private receipt/materialization envelope on the cutover path.
 */
export function buildJavascriptTypescriptNativeFactDeltaHeader(
  input: JavascriptTypescriptNativeFactDeltaInput,
  options: { readonly cancellation_id: string },
): FactDeltaStreamHeader {
  if (options.cancellation_id.length === 0) throw new TypeError("FactDeltaStream cancellation identity is required.");
  const reasonCodes = [...new Set(input.diagnostic_codes)].sort();
  const diagnosticKeys = input.records.filter((record) => record.category === "diagnostic").map((record) => record.proposal_record_key);
  const prepared = commonFactDelta(input, input.owner_path, diagnosticKeys, reasonCodes);
  const canonicalRecords = input.canonical_records ?? input.records.map((record) => canonicalJson(record));
  const canonicalDependencies = input.canonical_dependencies ?? input.dependencies.map((dependency) => canonicalJson(dependency));
  const factDeltaId = `jsts:delta:${String(input.work_item["candidate_generation_id"])}:${String(input.work_item["work_item_id"])}`;
  const metrics = streamDigestMetricsCanonical(prepared.core, canonicalRecords, canonicalDependencies);
  const headerPayload: Omit<FactDeltaStreamHeader, "stream_digest"> = {
    protocol_version: 2,
    schema_id: "core:FactDeltaStream",
    fact_delta_id: factDeltaId,
    candidate_generation_id: prepared.core["candidate_generation_id"] as string,
    workspace_id: prepared.core["workspace_id"] as string,
    ...(prepared.core["base_snapshot_id"] === undefined ? {} : { base_snapshot_id: prepared.core["base_snapshot_id"] as string }),
    work_item_id: prepared.core["work_item_id"] as string,
    plugin_id: prepared.core["plugin_id"] as string,
    plugin_version: prepared.core["plugin_version"] as string,
    analysis_digest: prepared.core["analysis_digest"] as string,
    analysis_configuration_digest: prepared.core["analysis_configuration_digest"] as string,
    ...(prepared.core["publication_stage_id"] === undefined ? {} : { publication_stage_id: prepared.core["publication_stage_id"] as string }),
    owner_artifact_id: prepared.core["owner_artifact_id"] as string,
    owner_artifact_version_id: prepared.core["owner_artifact_version_id"] as string,
    replacement_scopes: prepared.scopes,
    replacement_scope_count: prepared.scopes.length,
    replacement_scopes_digest: canonicalSha256(prepared.scopes),
    input_artifact_version_ids: prepared.core["input_artifact_version_ids"] as readonly string[],
    input_artifact_version_count: (prepared.core["input_artifact_version_ids"] as readonly string[]).length,
    input_artifact_versions_digest: canonicalSha256(prepared.core["input_artifact_version_ids"]),
    input_record_ids: prepared.core["input_record_ids"] as readonly string[],
    input_record_count: (prepared.core["input_record_ids"] as readonly string[]).length,
    input_records_digest: canonicalSha256(prepared.core["input_record_ids"]),
    plugin_input_access_manifest_id: prepared.core["plugin_input_access_manifest_id"] as string,
    plugin_input_access_manifest_digest: prepared.core["plugin_input_access_manifest_digest"] as string,
    analysis_input_digest: prepared.core["analysis_input_digest"] as string,
    completeness_claims: prepared.core["completeness_claims"] as FactDeltaStreamHeader["completeness_claims"],
    completeness_claim_count: (prepared.core["completeness_claims"] as readonly unknown[]).length,
    completeness_claims_digest: canonicalSha256(prepared.core["completeness_claims"]),
    proposed_record_count: metrics.record_count,
    proposed_records_digest: metrics.records_digest,
    proposed_dependency_count: metrics.dependency_count,
    proposed_dependencies_digest: metrics.dependencies_digest,
    created_at: input.created_at,
    delta_digest: metrics.delta_digest,
    cancellation_id: options.cancellation_id,
    backpressure: { acknowledgement_mode: "per_batch", max_in_flight_batches: 1 },
  };
  return Object.freeze({ ...headerPayload, stream_digest: factDeltaStreamHeaderDigest(headerPayload) });
}

/** Prepare rows already projected and presealed by a registered native
 * language profile. Cold and incremental semantic routes use this identical
 * owner boundary. */
export function prepareJavascriptTypescriptNativeFactDeltaStream(
  input: JavascriptTypescriptNativeFactDeltaInput,
  options: { readonly cancellation_id: string },
): PreparedJavascriptTypescriptFactDeltaStream {
  if (options.cancellation_id.length === 0) throw new TypeError("FactDeltaStream cancellation identity is required.");
  const reasonCodes = [...new Set(input.diagnostic_codes)].sort();
  const diagnosticKeys = input.records.filter((record) => record.category === "diagnostic").map((record) => record.proposal_record_key);
  const prepared = commonFactDelta(input, input.owner_path, diagnosticKeys, reasonCodes);
  return Object.freeze({
    records: input.records,
    dependencies: input.dependencies,
    seal: () => buildPreparedFactDeltaStream(input, prepared, input.records, input.dependencies, options),
  });
}

/** Build an owner stream directly from native canonical rows. No full logical
 * record or dependency object is created in V8 on this route. */
export function prepareJavascriptTypescriptProjectedFactDeltaStream(
  input: JavascriptTypescriptProjectedFactDeltaInput,
  options: { readonly cancellation_id: string },
): PreparedJavascriptTypescriptFactDeltaStream {
  if (options.cancellation_id.length === 0) throw new TypeError("FactDeltaStream cancellation identity is required.");
  const projection = input.projection;
  const reasonCodes = [...new Set(projection.diagnostic_codes)].sort();
  const diagnosticKeys = projection.record_headers.filter((record) => record.category === "diagnostic").map((record) => record.proposal_record_key);
  const prepared = commonFactDelta(input, input.owner_path, diagnosticKeys, reasonCodes);
  const factDeltaId = `jsts:delta:${String(input.work_item["candidate_generation_id"])}:${String(input.work_item["work_item_id"])}`;
  const metrics = streamDigestMetricsCanonical(prepared.core, projection.canonical_records, projection.canonical_dependencies);
  const headerPayload: Omit<FactDeltaStreamHeader, "stream_digest"> = {
    protocol_version: 2, schema_id: "core:FactDeltaStream", fact_delta_id: factDeltaId,
    candidate_generation_id: prepared.core["candidate_generation_id"] as string, workspace_id: prepared.core["workspace_id"] as string,
    ...(prepared.core["base_snapshot_id"] === undefined ? {} : { base_snapshot_id: prepared.core["base_snapshot_id"] as string }),
    work_item_id: prepared.core["work_item_id"] as string, plugin_id: prepared.core["plugin_id"] as string, plugin_version: prepared.core["plugin_version"] as string,
    analysis_digest: prepared.core["analysis_digest"] as string, analysis_configuration_digest: prepared.core["analysis_configuration_digest"] as string,
    ...(prepared.core["publication_stage_id"] === undefined ? {} : { publication_stage_id: prepared.core["publication_stage_id"] as string }),
    owner_artifact_id: prepared.core["owner_artifact_id"] as string, owner_artifact_version_id: prepared.core["owner_artifact_version_id"] as string,
    replacement_scopes: prepared.scopes, replacement_scope_count: prepared.scopes.length, replacement_scopes_digest: canonicalSha256(prepared.scopes),
    input_artifact_version_ids: prepared.core["input_artifact_version_ids"] as readonly string[], input_artifact_version_count: (prepared.core["input_artifact_version_ids"] as readonly string[]).length, input_artifact_versions_digest: canonicalSha256(prepared.core["input_artifact_version_ids"]),
    input_record_ids: prepared.core["input_record_ids"] as readonly string[], input_record_count: (prepared.core["input_record_ids"] as readonly string[]).length, input_records_digest: canonicalSha256(prepared.core["input_record_ids"]),
    plugin_input_access_manifest_id: prepared.core["plugin_input_access_manifest_id"] as string, plugin_input_access_manifest_digest: prepared.core["plugin_input_access_manifest_digest"] as string,
    analysis_input_digest: prepared.core["analysis_input_digest"] as string,
    completeness_claims: prepared.core["completeness_claims"] as FactDeltaStreamHeader["completeness_claims"], completeness_claim_count: (prepared.core["completeness_claims"] as readonly unknown[]).length, completeness_claims_digest: canonicalSha256(prepared.core["completeness_claims"]),
    proposed_record_count: metrics.record_count, proposed_records_digest: metrics.records_digest, proposed_dependency_count: metrics.dependency_count, proposed_dependencies_digest: metrics.dependencies_digest,
    created_at: input.created_at, delta_digest: metrics.delta_digest, cancellation_id: options.cancellation_id, backpressure: { acknowledgement_mode: "per_batch", max_in_flight_batches: 1 },
  };
  const header = Object.freeze({ ...headerPayload, stream_digest: factDeltaStreamHeaderDigest(headerPayload) });
  type CanonicalGroup = Pick<SealedStructuralProjectionOwner, "canonical_records" | "canonical_dependencies" | "record_headers" | "dependency_headers">;
  const split = (group: CanonicalGroup): CanonicalGroup[] => {
    try { buildProjectedSealedFactDeltaStreamBatch({ fact_delta_id: factDeltaId, sequence: 0, final: false, ...group }); return [group]; }
    catch (error) {
      const rows = [
        ...group.canonical_records.map((canonical, index) => ({ kind: "record" as const, canonical, header: group.record_headers[index]! })),
        ...group.canonical_dependencies.map((canonical, index) => ({ kind: "dependency" as const, canonical, header: group.dependency_headers[index]! })),
      ];
      if (rows.length <= 1) throw error;
      return [rows.slice(0, Math.floor(rows.length / 2)), rows.slice(Math.floor(rows.length / 2))].flatMap((half) => split({
        canonical_records: half.flatMap((row) => row.kind === "record" ? [row.canonical] : []),
        canonical_dependencies: half.flatMap((row) => row.kind === "dependency" ? [row.canonical] : []),
        record_headers: half.flatMap((row) => row.kind === "record" ? [row.header] : []),
        dependency_headers: half.flatMap((row) => row.kind === "dependency" ? [row.header] : []),
      }));
    }
  };
  const groups = split(projection);
  return Object.freeze({
    records: Object.freeze([]), dependencies: Object.freeze([]),
    seal: () => ({ header, batches: (async function* () {
      for (const [sequence, group] of groups.entries()) yield buildProjectedSealedFactDeltaStreamBatch({ fact_delta_id: factDeltaId, sequence, final: sequence === groups.length - 1, ...group });
    })() }),
  });
}

/** Build the exact core-facing FactDelta shape; core validation remains authoritative. */
export function buildJavascriptTypescriptFactDelta(input: JavascriptTypescriptFactDeltaInput): FactDelta {
  const workItem = input.work_item;
  const manifest = input.accepted_manifest;
  const path = ownerPath(input);
  const scopes = parseReplacementScopes(workItem["expected_replacement_scopes"]);
  if (scopes.length === 0) throw new TypeError("FactDelta requires at least one planned replacement scope.");
  const workspaceId = text(workItem["workspace_id"], "workspace_id");
  const candidateGenerationId = text(workItem["candidate_generation_id"], "candidate_generation_id");
  const workItemId = text(workItem["work_item_id"], "work_item_id");
  const pluginVersion = text(workItem["plugin_version"], "plugin_version");
  const pluginInputManifestId = text(manifest["plugin_input_access_manifest_id"], "plugin_input_access_manifest_id");
  const pluginInputManifestDigest = text(manifest["manifest_digest"], "manifest_digest");
  // Preserve the accepted manifest's canonical order byte-for-byte. Core compares
  // these bindings against the observed manifest during FactDelta acceptance.
  // Memoized per entry-array: every owner in a scan shares one prebuilt entry list.
  const rawVersionEntries = manifest["artifact_version_entries"];
  const memoizedVersionIds = Array.isArray(rawVersionEntries) ? manifestVersionIdsMemo.get(rawVersionEntries) : undefined;
  const inputArtifactVersionIds = memoizedVersionIds ?? [...new Set(manifestArray(manifest, "artifact_version_entries").map((entry) => text(entry["artifact_version_id"], "artifact_version_id")))].sort();
  if (memoizedVersionIds === undefined && Array.isArray(rawVersionEntries)) manifestVersionIdsMemo.set(rawVersionEntries, inputArtifactVersionIds);
  const inputRecordIds = [...new Set(manifestArray(manifest, "record_entries").filter((entry) => entry["input_type"] === "base_record").map((entry) => text(entry["record_id"], "record_id")))].sort();
  const plannedKinds = new Set(scopes.flatMap((scope) => scope.record_kinds));
  const indexes = analysisIndexes(input.analysis);
  const ownerDiagnostics = indexes.diagnosticsByPath.get(path) ?? [];
  const records = [
    ...(indexes.entitiesByPath.get(path) ?? []).map((entity) => proposalRecord(entity, input.analysis)),
    ...(indexes.entitiesByPath.get(path) ?? []).flatMap((entity) => semanticTypeRecords(entity, input.analysis)),
    ...(indexes.relationsByPath.get(path) ?? []).map((relation) => proposalRelationRecord(relation)),
    ...ownerDiagnostics.map((diagnostic, index) => proposalDiagnosticRecord(diagnostic, index)),
  ].filter((record) => plannedKinds.has(record.kind) && stageAllowsRecord(input.publication_stage_id, record.kind, input.included_publication_stage_ids));
  // Replacement scopes are planned by the core and must be echoed byte-for-byte;
  // the plugin cannot widen or rewrite their registered record-kind coverage.
  const replacementScopes = scopes;
  const diagnosticKeys = records.filter((record) => record.category === "diagnostic").map((record) => record.proposal_record_key);
  const reasonCodes = [...new Set(ownerDiagnostics.map((diagnostic) => diagnostic.code))].sort();
  const completenessClaims = replacementScopes.map((scope, index) => ({
    completeness_claim_id: `jsts:completeness:${workItemId}:${index}`,
    capability: scope.capability,
    replacement_scope_ids: scope.replacement_scope_id,
    status: reasonCodes.length === 0 ? "complete" : "partial",
    reason_codes: canonicalJson(reasonCodes),
    affected_artifact_ids: canonicalJson(reasonCodes.length === 0 ? [] : [text(workItem["artifact_id"], "artifact_id")]),
    diagnostic_proposal_keys: canonicalJson(diagnosticKeys),
  }));
  const core = {
    candidate_generation_id: candidateGenerationId,
    workspace_id: workspaceId,
    ...(typeof workItem["base_snapshot_id"] === "string" ? { base_snapshot_id: workItem["base_snapshot_id"] } : {}),
    work_item_id: workItemId,
    plugin_id: text(workItem["plugin_id"], "plugin_id"),
    plugin_version: pluginVersion,
    analysis_digest: input.analysis_digest,
    analysis_configuration_digest: input.analysis_configuration_digest,
    ...(input.publication_stage_id === undefined ? {} : { publication_stage_id: input.publication_stage_id }),
    owner_artifact_id: text(workItem["artifact_id"], "artifact_id"),
    owner_artifact_version_id: text(workItem["target_artifact_version_id"], "target_artifact_version_id"),
    replacement_scopes: replacementScopes,
    input_artifact_version_ids: inputArtifactVersionIds,
    input_record_ids: inputRecordIds,
    plugin_input_access_manifest_id: pluginInputManifestId,
    plugin_input_access_manifest_digest: pluginInputManifestDigest,
    analysis_input_digest: input.analysis_input_digest,
    proposed_records: records,
    proposed_dependencies: crossArtifactDependencies(records, input.analysis, input.files, path),
    completeness_claims: completenessClaims,
  };
  return {
    ...core,
    // A FactDelta is candidate-scoped immutable output. Including the
    // generation prevents a later incremental scan from colliding with an
    // already published receipt for the same artifact work-item identity.
    fact_delta_id: `jsts:delta:${String(input.work_item["candidate_generation_id"])}:${workItemId}`,
    created_at: input.created_at,
    delta_digest: canonicalSha256(core),
  } as unknown as FactDelta;
}

function stageAllowsRecord(stageId: string | undefined, kind: string, includedStageIds?: readonly string[]): boolean {
  if (includedStageIds !== undefined) {
    if (includedStageIds.length < 2 || includedStageIds.at(-1) !== stageId || new Set(includedStageIds).size !== includedStageIds.length) throw new TypeError("The accumulated JavaScript/TypeScript publication stages are invalid.");
    return includedStageIds.some((includedStageId) => stageAllowsRecord(includedStageId, kind));
  }
  if (stageId === undefined) return true;
  const syntaxEntity = ["jsts:entity_type", "jsts:entity_callable", "jsts:entity_variable", "jsts:entity_parameter", "jsts:entity_container"].includes(kind);
  if (stageId === "jsts:structural_stage_1") return syntaxEntity || ["jsts:relation_contains", "jsts:relation_import", "jsts:relation_export"].includes(kind);
  if (stageId === "jsts:structural_stage_2") return ["jsts:relation_call", "jsts:relation_references", "jsts:relation_inherits", "jsts:relation_implements"].includes(kind);
  if (stageId === "jsts:structural_stage_3") return ["jsts:entity_inferred_type", "jsts:relation_type_of", "jsts:relation_covers", "jsts:diagnostic"].includes(kind);
  throw new TypeError(`Unknown JavaScript/TypeScript publication stage ${stageId}.`);
}
