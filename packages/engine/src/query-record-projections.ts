import type { CanonicalQueryRecord } from "./canonical-query-data-port.js";

/** Converts an indexed record into the stable public subject representation. */
export function recordValue(record: CanonicalQueryRecord, classification: "confirmed" | "possible" = "confirmed"): Readonly<Record<string, unknown>> {
  if (record.category === "artifact_subject") {
    return {
      subject_type: "artifact",
      artifact_id: record.owner_artifact_id,
      artifact_version_id: record.owner_artifact_version_id,
      path: record.body["path"],
      universal_kind: record.universal_kind,
      kind: record.kind,
      classification,
      ...(record.primary_source_span === undefined ? {} : { source_span: record.primary_source_span }),
      body: record.body,
    };
  }
  const subjectType = record.category === "relation" ? "relation" : record.category === "diagnostic" ? "diagnostic" : "entity";
  return {
    subject_type: subjectType,
    record_id: record.record_id,
    ...(record.identity_id === undefined ? {} : { [`${subjectType}_id`]: record.identity_id }),
    ...(record.identity_key === undefined ? {} : { identity_key: record.identity_key }),
    universal_kind: record.universal_kind,
    kind: record.kind,
    classification,
    ...(record.facets === undefined ? {} : { facets: record.facets }),
    ...(record.primary_source_span === undefined ? {} : { source_span: record.primary_source_span }),
    body: record.body,
  };
}

/** Extracts code-shaped identifiers from a task without treating prose as symbols. */
export function contextIdentifierCandidates(task: string, queryClass: unknown): readonly string[] {
  const tokens = task.match(/[$_\p{L}][$_\p{L}\p{N}]*/gu) ?? [];
  const identifiers = tokens.filter((token) => token.includes("_") || token.includes("$") || /[\p{Ll}\p{N}][\p{Lu}]/u.test(token));
  if ((queryClass === "identifier" || queryClass === "source_code") && tokens.length === 1) identifiers.push(tokens[0]!);
  return [...new Set(identifiers)];
}

export function sourceArtifactRecord(workspaceId: string, row: { readonly artifact_id: string; readonly artifact_version_id: string; readonly normalized_uri: string; readonly normalized_path: string | null }): CanonicalQueryRecord {
  return {
    record_id: `artifact-record:${row.artifact_version_id}`,
    workspace_id: workspaceId,
    category: "artifact_subject",
    kind: "core:source_file",
    universal_kind: "core:artifact",
    owner_artifact_id: row.artifact_id,
    owner_artifact_version_id: row.artifact_version_id,
    facets: [],
    body: { path: row.normalized_path ?? row.normalized_uri, artifact_id: row.artifact_id, artifact_version_id: row.artifact_version_id },
  };
}
