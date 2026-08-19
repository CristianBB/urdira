import type { FactDelta, ProposedRecord, ProposedRecordDependency, ReplacementScope } from "@urdira/contracts";
import { canonicalJson, canonicalSha256 } from "@urdira/plugin-sdk";
import type { JsTsAnalysisResult } from "./analyzer.js";

export interface JavascriptTypescriptFactDeltaInput {
  readonly analysis: JsTsAnalysisResult;
  readonly work_item: Readonly<Record<string, unknown>>;
  readonly accepted_manifest: Readonly<Record<string, unknown>>;
  readonly analysis_digest: string;
  readonly analysis_configuration_digest: string;
  readonly analysis_input_digest: string;
  readonly created_at: string;
  readonly publication_stage_id?: string;
  readonly owner_path?: string;
  readonly files?: readonly Readonly<{
    path: string;
    artifact_id?: string;
    artifact_version_id?: string;
    content_hash?: string;
  }>[];
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
    proposal_record_key: `jsts:record:${entity.id}`,
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

function proposalRelationRecord(relation: JsTsAnalysisResult["relations"][number]): ProposedRecord {
  const kind = `jsts:relation_${relation.kind.slice("core:".length)}`;
  return {
    proposal_record_key: `jsts:record:${relation.id}`,
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
    proposal_record_key: key,
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
      proposed_dependency_id: `jsts:dependency:${relation.id}:${targetFile.artifact_version_id}`,
      proposal_record_key: proposal.proposal_record_key,
      dependency_artifact_id: targetFile.artifact_id,
      dependency_artifact_version_id: targetFile.artifact_version_id,
      dependency_role: "jsts:resolution_input",
      dependency_basis: "checker_resolution",
      source_reference: { reference_type: "local_proposal", proposal_record_key: proposal.proposal_record_key, ...(targetFile.content_hash === undefined ? {} : { content_hash: targetFile.content_hash }) },
    });
  }
  return result.sort((left, right) => left.proposed_dependency_id.localeCompare(right.proposed_dependency_id));
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
    ...(indexes.relationsByPath.get(path) ?? []).map((relation) => proposalRelationRecord(relation)),
    ...ownerDiagnostics.map((diagnostic, index) => proposalDiagnosticRecord(diagnostic, index)),
  ].filter((record) => plannedKinds.has(record.kind) && stageAllowsRecord(input.publication_stage_id, record.kind));
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
    fact_delta_id: `jsts:delta:${workItemId}`,
    created_at: input.created_at,
    delta_digest: canonicalSha256(core),
  } as unknown as FactDelta;
}

function stageAllowsRecord(stageId: string | undefined, kind: string): boolean {
  if (stageId === undefined) return true;
  const entity = kind.startsWith("jsts:entity_");
  if (stageId === "jsts:structural_stage_1") return entity || ["jsts:relation_contains", "jsts:relation_import", "jsts:relation_export"].includes(kind);
  if (stageId === "jsts:structural_stage_2") return ["jsts:relation_call", "jsts:relation_references", "jsts:relation_inherits", "jsts:relation_implements"].includes(kind);
  if (stageId === "jsts:structural_stage_3") return entity || kind === "jsts:relation_covers" || kind === "jsts:diagnostic";
  throw new TypeError(`Unknown JavaScript/TypeScript publication stage ${stageId}.`);
}
