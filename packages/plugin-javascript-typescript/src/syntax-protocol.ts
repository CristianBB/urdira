import { isAbsolute } from "node:path";
import type { ProposedRecord, ProposedRecordDependency } from "@urdira/contracts";
import { canonicalJson, compareUtf8Bytes } from "@urdira/plugin-sdk";
import { MAX_RUST_WORKER_FRAME_CHUNK_BYTES, MAX_RUST_WORKER_MESSAGE_BYTES, RUST_WORKER_PROTOCOL_IDENTITY, RUST_WORKER_PROTOCOL_VERSION } from "./rust-protocol.js";

export const JSTS_RUST_SYNTAX_BUILD_IDENTITY = "urdira:jsts-syntax-worker:0.3.0+oxc-0.142.0.fact-groups-v1.protobuf-v3.authoritative-changes-v1.bounded-row-identities-v1.definition-syntax-v1" as const;
export const RUST_SYNTAX_FACT_PAGE_MAX_BYTES = 4 * 1024 * 1024;
export const RUST_SYNTAX_FACT_PAGE_MAX_ROWS = 4096;
export const RUST_SYNTAX_FACT_GROUP_MAX_BYTES = 16 * 1024 * 1024;
export const RUST_SYNTAX_FACT_GROUP_MAX_OWNERS = 64;

export interface RustSyntaxSourceInput {
  readonly path: string;
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly content_digest: string;
  /** Exact immutable CAS/blob path selected by the host; never a checkout path. */
  readonly source_blob_path: string;
  readonly byte_length: number;
}

export interface RustSyntaxAnalyzeInput {
  readonly request_id: string;
  readonly cancellation_id: string;
  readonly project_key: string;
  readonly configuration_digest: string;
  readonly root_names: readonly string[];
  readonly files: readonly RustSyntaxSourceInput[];
  /**
   * Exact planner-owned transition set. Omit only when no incremental basis is
   * valid (first scan or a coordinated full reset).
   */
  readonly changed_artifact_ids?: readonly string[];
  readonly max_output_bytes: number;
  readonly max_files: number;
  readonly max_source_bytes: number;
}

export type RustSyntaxAuthoritativeChangeSet =
  | { readonly kind: "full" }
  | { readonly kind: "exact"; readonly changed_artifact_ids: readonly string[] };

export interface RustSyntaxAnalyzeRequest {
  readonly kind: "analyze";
  readonly request_id: string;
  readonly cancellation_id: string;
  readonly project_key: string;
  readonly configuration_digest: string;
  readonly root_names: readonly string[];
  readonly files: readonly { readonly path: string; readonly artifact_id: string; readonly artifact_version_id: string; readonly content_digest: string; readonly source_blob_path: string; readonly byte_length: number }[];
  readonly change_set: RustSyntaxAuthoritativeChangeSet;
  readonly budgets: { readonly max_output_bytes: number; readonly max_files: number; readonly max_source_bytes: number };
}

export interface RustSyntaxFactsRequest {
  readonly kind: "read_facts";
  readonly request_id: string;
  readonly cancellation_id: string;
  readonly project_key: string;
  readonly path: string;
  readonly cursor?: RustSyntaxFactCursor;
  readonly max_output_bytes: number;
  readonly max_rows: number;
}

export interface RustSyntaxFactsGroupRequest {
  readonly kind: "read_facts_group";
  readonly request_id: string;
  readonly cancellation_id: string;
  readonly project_key: string;
  readonly entries: readonly { readonly path: string; readonly cursor?: RustSyntaxFactCursor }[];
  readonly max_output_bytes: number;
  readonly max_rows: number;
}

export interface RustSyntaxFactCursor {
  readonly imports_offset: number;
  readonly records_offset: number;
  readonly dependencies_offset: number;
}

export interface RustSyntaxCommitAnalysisRequest {
  readonly kind: "commit_analysis";
  readonly request_id: string;
  readonly project_key: string;
  readonly analysis_token: string;
}

export type RustSyntaxHostMessage =
  | { readonly kind: "handshake"; readonly request_id: string; readonly protocol_identity: typeof RUST_WORKER_PROTOCOL_IDENTITY; readonly protocol_version: typeof RUST_WORKER_PROTOCOL_VERSION; readonly expected_worker_build_identity: string; readonly max_frame_chunk_bytes: number; readonly max_message_bytes: number }
  | RustSyntaxAnalyzeRequest
  | RustSyntaxFactsRequest
  | RustSyntaxFactsGroupRequest
  | RustSyntaxCommitAnalysisRequest
  | { readonly kind: "cancel"; readonly request_id: string; readonly cancellation_id: string }
  | { readonly kind: "reset"; readonly request_id: string; readonly project_key?: string }
  | { readonly kind: "shutdown"; readonly request_id: string };

export interface RustSyntaxDirectImport {
  readonly specifier: string;
  readonly target_path?: string;
  readonly kind: "import" | "export" | "dynamic_import" | "require";
  readonly start: number;
  readonly end: number;
}

export interface RustSyntaxAnalysisResult {
  readonly kind: "analysis_result";
  readonly request_id: string;
  readonly cancellation_id: string;
  readonly project_key: string;
  readonly analysis_token: string;
  readonly build: "full" | "incremental" | "unchanged";
  readonly reset_reason?: "initial" | "root_set_changed" | "configuration_changed" | "file_set_changed";
  readonly changed_files: readonly string[];
  readonly affected_files: readonly string[];
  readonly metrics: { readonly bytes_read: number; readonly bytes_transferred: number; readonly bytes_copied: number; readonly bytes_decoded: number; readonly bytes_retained: number };
}

/**
 * Transport representation emitted by the Rust syntax worker.
 *
 * The worker carries a few additive, indexing-only fields alongside the
 * public `ProposedRecord` contract. Keeping that distinction explicit lets
 * the wire validator remain closed while downstream fact-delta code continues
 * to consume the contract-shaped portion of each record.
 */
export type RustSyntaxProposedRecord = ProposedRecord & {
  readonly span_start_line: number;
  readonly span_end_line: number;
  readonly source_id: string | null;
  readonly target_id: string | null;
  readonly facets_list: readonly string[];
};

/** Additive transport field carried by Rust for stable cross-scan dependency identity. */
export type RustSyntaxProposedRecordDependency = ProposedRecordDependency & {
  readonly dependency_target_path: string;
};

export interface RustSyntaxFactsResult {
  readonly kind: "facts_result";
  readonly request_id: string;
  readonly cancellation_id: string;
  readonly project_key: string;
  readonly path: string;
  readonly content_digest: string;
  readonly language: "javascript" | "typescript";
  readonly script_kind: "js" | "jsx" | "ts" | "tsx";
  readonly byte_length: number;
  readonly parsed: boolean;
  readonly direct_imports: readonly RustSyntaxDirectImport[];
  readonly records: readonly RustSyntaxProposedRecord[];
  readonly dependencies: readonly RustSyntaxProposedRecordDependency[];
  readonly diagnostics: readonly { readonly message: string; readonly start: number; readonly end: number }[];
  readonly next_cursor?: RustSyntaxFactCursor;
  readonly metrics: { readonly bytes_transferred: number; readonly bytes_copied: number };
}

export interface RustSyntaxFactsGroupResult {
  readonly kind: "facts_group_result";
  readonly request_id: string;
  readonly cancellation_id: string;
  readonly project_key: string;
  readonly pages: readonly RustSyntaxFactsResult[];
  readonly next_request_index?: number;
  readonly metrics: { readonly bytes_transferred: number; readonly bytes_copied: number };
}

export type RustSyntaxWorkerMessage =
  | { readonly kind: "handshake_ack"; readonly request_id: string; readonly protocol_identity: typeof RUST_WORKER_PROTOCOL_IDENTITY; readonly protocol_version: typeof RUST_WORKER_PROTOCOL_VERSION; readonly worker_build_identity: string; readonly max_frame_chunk_bytes: number; readonly max_message_bytes: number }
  | RustSyntaxAnalysisResult
  | RustSyntaxFactsResult
  | RustSyntaxFactsGroupResult
  | { readonly kind: "commit_analysis_ack"; readonly request_id: string; readonly project_key: string; readonly analysis_token: string }
  | { readonly kind: "cancel_ack"; readonly request_id: string; readonly cancellation_id: string }
  | { readonly kind: "cancelled"; readonly request_id: string; readonly cancellation_id: string }
  | { readonly kind: "reset_ack"; readonly request_id: string; readonly reset_projects: number }
  | { readonly kind: "shutdown_ack"; readonly request_id: string }
  | { readonly kind: "error"; readonly request_id: string; readonly code: "protocol_invalid" | "handshake_required" | "build_identity_mismatch" | "worker_busy" | "resource_exhausted" | "source_digest_mismatch" | "unsupported_source" | "analysis_failed"; readonly message: string };

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Rust syntax protocol expects a closed object.");
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("Rust syntax protocol contains an unknown or missing field.");
  return record;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || /[\0\r\n\t]/u.test(value)) throw new Error(`${field} is invalid.`);
  return value;
}

function boundedText(value: unknown, field: string, maximum = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\0\r\n\t]/u.test(value)) throw new Error(`${field} is invalid.`);
  return value;
}

function span(record: Record<string, unknown>, field: string): void {
  const start = record["start"];
  const end = record["end"];
  if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error(`Rust syntax ${field} span is invalid.`);
}

function digest(value: unknown, field: string): string {
  const result = identifier(value, field);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return result;
}

function relativePath(value: unknown): string {
  const path = identifier(value, "path");
  if (path.startsWith("/") || path.startsWith("\\") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("Source path must be normalized and relative.");
  return path;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) throw new Error(`${field} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`${field} must be a non-negative integer.`);
  return value;
}

function canonicalJsonText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > RUST_SYNTAX_FACT_PAGE_MAX_BYTES) throw new Error(`${field} is invalid.`);
  let decoded: unknown;
  try { decoded = JSON.parse(value); }
  catch { throw new Error(`${field} is not valid canonical JSON.`); }
  if (canonicalJson(decoded) !== value) throw new Error(`${field} is not canonical JSON.`);
  return value;
}

function jsonObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Readonly<Record<string, unknown>>;
}

function validateProposedRecord(value: unknown): void {
  const record = exactObject(value, ["proposal_record_key", "category", "kind", "universal_kind", "facets", "schema_version", "source_span", "span_start_line", "span_end_line", "identity_key", "body", "source_id", "target_id", "evidence_references", "facets_list"]);
  for (const field of ["proposal_record_key", "kind", "universal_kind", "identity_key"] as const) boundedText(record[field], `record ${field}`);
  if (!["entity", "relation", "diagnostic"].includes(String(record["category"]))) throw new Error("Rust syntax record category is invalid.");
  if (record["schema_version"] !== 1) throw new Error("Rust syntax record schema_version is invalid.");
  nonNegativeInteger(record["span_start_line"], "record span_start_line");
  nonNegativeInteger(record["span_end_line"], "record span_end_line");
  if ((record["source_id"] !== null && record["source_id"] !== undefined) || (record["target_id"] !== null && record["target_id"] !== undefined)) {
    if (record["source_id"] !== null) boundedText(record["source_id"], "record source_id");
    if (record["target_id"] !== null) boundedText(record["target_id"], "record target_id");
  }
  canonicalJsonText(record["facets"], "record facets");
  canonicalJsonText(record["source_span"], "record source_span");
  canonicalJsonText(record["evidence_references"], "record evidence_references");
  if (!Array.isArray(record["facets_list"])) throw new Error("record facets_list is invalid.");
  for (const facet of record["facets_list"] as unknown[]) boundedText(facet, "record facet");
  jsonObject(record["body"], "record body");
}

function validateProposedDependency(value: unknown): void {
  const dependency = exactObject(value, ["proposed_dependency_id", "proposal_record_key", "dependency_artifact_id", "dependency_artifact_version_id", "dependency_target_path", "dependency_role", "dependency_basis", "source_reference"]);
  for (const field of ["proposed_dependency_id", "proposal_record_key", "dependency_artifact_id", "dependency_artifact_version_id", "dependency_role", "dependency_basis"] as const) boundedText(dependency[field], `dependency ${field}`);
  boundedText(dependency["dependency_target_path"], "dependency dependency_target_path");
  const source = dependency["source_reference"];
  const hasContentHash = source !== null && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, "content_hash");
  const reference = exactObject(source, ["reference_type", "proposal_record_key", ...(hasContentHash ? ["content_hash"] : [])]);
  if (reference["reference_type"] !== "local_proposal") throw new Error("Rust syntax dependency source reference is invalid.");
  boundedText(reference["proposal_record_key"], "dependency source proposal_record_key");
  if (hasContentHash) digest(reference["content_hash"], "dependency source content_hash");
}

export function createRustSyntaxAnalyzeRequest(input: RustSyntaxAnalyzeInput): RustSyntaxAnalyzeRequest {
  const paths = new Set<string>();
  const artifactIds = new Set<string>();
  let sourceBytes = 0;
  const files = input.files.map((file) => {
    const path = relativePath(file.path);
    if (paths.has(path)) throw new Error(`Duplicate source path ${path}.`);
    paths.add(path);
    const artifactId = identifier(file.artifact_id, "artifact_id");
    if (artifactIds.has(artifactId)) throw new Error(`Duplicate source artifact_id ${artifactId}.`);
    artifactIds.add(artifactId);
    const artifactVersionId = identifier(file.artifact_version_id, "artifact_version_id");
    const contentDigest = digest(file.content_digest, "content_digest");
    if (typeof file.source_blob_path !== "string" || !isAbsolute(file.source_blob_path) || /[\0\r\n]/u.test(file.source_blob_path)) throw new Error(`Source blob path is invalid for ${path}.`);
    const byteLength = nonNegativeInteger(file.byte_length, "byte_length");
    sourceBytes += byteLength;
    return Object.freeze({ path, artifact_id: artifactId, artifact_version_id: artifactVersionId, content_digest: contentDigest, source_blob_path: file.source_blob_path, byte_length: byteLength });
  });
  const maxFiles = positiveInteger(input.max_files, "max_files");
  const maxSourceBytes = positiveInteger(input.max_source_bytes, "max_source_bytes");
  if (files.length > maxFiles || sourceBytes > maxSourceBytes) throw new Error("Source input exceeds its declared budget.");
  const roots = [...input.root_names].map(relativePath);
  if (new Set(roots).size !== roots.length || roots.some((path) => !paths.has(path))) throw new Error("root_names must be duplicate-free members of files.");
  const changeSet: RustSyntaxAuthoritativeChangeSet = input.changed_artifact_ids === undefined
    ? Object.freeze({ kind: "full" })
    : (() => {
      const changedArtifactIds = input.changed_artifact_ids.map((artifactId) => identifier(artifactId, "changed_artifact_id"));
      if (new Set(changedArtifactIds).size !== changedArtifactIds.length) throw new Error("changed_artifact_ids must be duplicate-free.");
      return Object.freeze({
        kind: "exact" as const,
        changed_artifact_ids: Object.freeze(changedArtifactIds.sort(compareUtf8Bytes)),
      });
    })();
  return Object.freeze({
    kind: "analyze",
    request_id: identifier(input.request_id, "request_id"),
    cancellation_id: identifier(input.cancellation_id, "cancellation_id"),
    project_key: identifier(input.project_key, "project_key"),
    configuration_digest: digest(input.configuration_digest, "configuration_digest"),
    root_names: Object.freeze(roots.sort()),
    files: Object.freeze(files.sort((left, right) => compareUtf8Bytes(left.path, right.path))),
    change_set: changeSet,
    budgets: Object.freeze({
      max_output_bytes: positiveInteger(input.max_output_bytes, "max_output_bytes"),
      max_files: maxFiles,
      max_source_bytes: maxSourceBytes,
    }),
  });
}

export function createRustSyntaxFactsRequest(input: Omit<RustSyntaxFactsRequest, "kind">): RustSyntaxFactsRequest {
  const maxOutputBytes = positiveInteger(input.max_output_bytes, "max_output_bytes");
  const maxRows = positiveInteger(input.max_rows, "max_rows");
  if (maxOutputBytes > RUST_SYNTAX_FACT_PAGE_MAX_BYTES) throw new Error("Rust syntax fact page exceeds the 4 MiB response budget.");
  if (maxRows > RUST_SYNTAX_FACT_PAGE_MAX_ROWS) throw new Error("Rust syntax fact page exceeds the 4096-row budget.");
  const cursor = input.cursor === undefined ? undefined : validateFactCursor(input.cursor);
  return Object.freeze({
    kind: "read_facts",
    request_id: identifier(input.request_id, "request_id"),
    cancellation_id: identifier(input.cancellation_id, "cancellation_id"),
    project_key: identifier(input.project_key, "project_key"),
    path: relativePath(input.path),
    ...(cursor === undefined ? {} : { cursor }),
    max_output_bytes: maxOutputBytes,
    max_rows: maxRows,
  });
}

export function createRustSyntaxFactsGroupRequest(input: Omit<RustSyntaxFactsGroupRequest, "kind">): RustSyntaxFactsGroupRequest {
  const maxOutputBytes = positiveInteger(input.max_output_bytes, "max_output_bytes");
  const maxRows = positiveInteger(input.max_rows, "max_rows");
  if (maxOutputBytes > RUST_SYNTAX_FACT_GROUP_MAX_BYTES) throw new Error("Rust syntax fact group exceeds the 16 MiB response budget.");
  if (maxRows > RUST_SYNTAX_FACT_PAGE_MAX_ROWS) throw new Error("Rust syntax fact group exceeds the 4096-row budget.");
  if (!Array.isArray(input.entries) || input.entries.length === 0 || input.entries.length > RUST_SYNTAX_FACT_GROUP_MAX_OWNERS) throw new Error("Rust syntax fact group must contain between 1 and 64 owners.");
  const paths = new Set<string>();
  const entries = input.entries.map((entry) => {
    const path = relativePath(entry.path);
    if (paths.has(path)) throw new Error(`Rust syntax fact group repeats ${path}.`);
    paths.add(path);
    const cursor = entry.cursor === undefined ? undefined : validateFactCursor(entry.cursor);
    return Object.freeze({ path, ...(cursor === undefined ? {} : { cursor }) });
  });
  return Object.freeze({
    kind: "read_facts_group",
    request_id: identifier(input.request_id, "request_id"),
    cancellation_id: identifier(input.cancellation_id, "cancellation_id"),
    project_key: identifier(input.project_key, "project_key"),
    entries: Object.freeze(entries),
    max_output_bytes: maxOutputBytes,
    max_rows: maxRows,
  });
}

function validateFactCursor(value: RustSyntaxFactCursor): RustSyntaxFactCursor {
  const record = exactObject(value, ["imports_offset", "records_offset", "dependencies_offset"]);
  return Object.freeze({
    imports_offset: nonNegativeInteger(record["imports_offset"], "imports_offset"),
    records_offset: nonNegativeInteger(record["records_offset"], "records_offset"),
    dependencies_offset: nonNegativeInteger(record["dependencies_offset"], "dependencies_offset"),
  });
}

export function createRustSyntaxCommitAnalysisRequest(input: Omit<RustSyntaxCommitAnalysisRequest, "kind">): RustSyntaxCommitAnalysisRequest {
  return Object.freeze({
    kind: "commit_analysis",
    request_id: identifier(input.request_id, "request_id"),
    project_key: identifier(input.project_key, "project_key"),
    analysis_token: identifier(input.analysis_token, "analysis_token"),
  });
}

export function createRustSyntaxHandshake(requestId: string, expectedBuildIdentity: string): RustSyntaxHostMessage {
  return Object.freeze({
    kind: "handshake",
    request_id: identifier(requestId, "request_id"),
    protocol_identity: RUST_WORKER_PROTOCOL_IDENTITY,
    protocol_version: RUST_WORKER_PROTOCOL_VERSION,
    expected_worker_build_identity: identifier(expectedBuildIdentity, "expected_worker_build_identity"),
    max_frame_chunk_bytes: MAX_RUST_WORKER_FRAME_CHUNK_BYTES,
    max_message_bytes: MAX_RUST_WORKER_MESSAGE_BYTES,
  });
}

/** Validate the closed outer response shape before request-specific checks. */
export function validateRustSyntaxWorkerMessage(value: unknown): RustSyntaxWorkerMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Rust syntax worker message must be a closed object.");
  const kind = (value as Record<string, unknown>)["kind"];
  if (kind === "handshake_ack") {
    const message = exactObject(value, ["kind", "request_id", "protocol_identity", "protocol_version", "worker_build_identity", "max_frame_chunk_bytes", "max_message_bytes"]);
    identifier(message["request_id"], "request_id"); identifier(message["worker_build_identity"], "worker_build_identity");
    if (message["protocol_identity"] !== RUST_WORKER_PROTOCOL_IDENTITY || message["protocol_version"] !== RUST_WORKER_PROTOCOL_VERSION) throw new Error("Rust syntax worker protocol identity is invalid.");
    positiveInteger(message["max_frame_chunk_bytes"], "max_frame_chunk_bytes"); positiveInteger(message["max_message_bytes"], "max_message_bytes");
  } else if (kind === "cancel_ack" || kind === "cancelled") {
    const message = exactObject(value, ["kind", "request_id", "cancellation_id"]); identifier(message["request_id"], "request_id"); identifier(message["cancellation_id"], "cancellation_id");
  } else if (kind === "reset_ack") {
    const message = exactObject(value, ["kind", "request_id", "reset_projects"]); identifier(message["request_id"], "request_id");
    if (typeof message["reset_projects"] !== "number" || !Number.isSafeInteger(message["reset_projects"]) || message["reset_projects"] < 0) throw new Error("reset_projects is invalid.");
  } else if (kind === "shutdown_ack") {
    const message = exactObject(value, ["kind", "request_id"]); identifier(message["request_id"], "request_id");
  } else if (kind === "commit_analysis_ack") {
    const message = exactObject(value, ["kind", "request_id", "project_key", "analysis_token"]);
    identifier(message["request_id"], "request_id"); identifier(message["project_key"], "project_key"); identifier(message["analysis_token"], "analysis_token");
  } else if (kind === "error") {
    const message = exactObject(value, ["kind", "request_id", "code", "message"]); identifier(message["request_id"], "request_id"); identifier(message["message"], "message");
    if (!["protocol_invalid", "handshake_required", "build_identity_mismatch", "worker_busy", "resource_exhausted", "source_digest_mismatch", "unsupported_source", "analysis_failed"].includes(String(message["code"]))) throw new Error("Rust syntax worker error code is invalid.");
  } else if (kind === "facts_group_result") {
    const hasNext = Object.prototype.hasOwnProperty.call(value, "next_request_index");
    const message = exactObject(value, ["kind", "request_id", "cancellation_id", "project_key", "pages", ...(hasNext ? ["next_request_index"] : []), "metrics"]);
    identifier(message["request_id"], "request_id"); identifier(message["cancellation_id"], "cancellation_id"); identifier(message["project_key"], "project_key");
    if (!Array.isArray(message["pages"]) || message["pages"].length === 0 || message["pages"].length > RUST_SYNTAX_FACT_GROUP_MAX_OWNERS) throw new Error("Rust syntax fact group pages are invalid.");
    const paths = new Set<string>();
    let rows = 0;
    for (const pageValue of message["pages"] as unknown[]) {
      const page = validateRustSyntaxWorkerMessage(pageValue);
      if (page.kind !== "facts_result" || page.request_id !== message["request_id"] || page.cancellation_id !== message["cancellation_id"] || page.project_key !== message["project_key"]) throw new Error("Rust syntax fact group page identity is invalid.");
      if (paths.has(page.path)) throw new Error("Rust syntax fact group repeats an owner page.");
      paths.add(page.path);
      rows += page.direct_imports.length + page.records.length + page.dependencies.length;
    }
    if (rows > RUST_SYNTAX_FACT_PAGE_MAX_ROWS) throw new Error("Rust syntax fact group exceeds its row budget.");
    if (hasNext) {
      const next = positiveInteger(message["next_request_index"], "next_request_index");
      if (next < (message["pages"] as unknown[]).length || next > RUST_SYNTAX_FACT_GROUP_MAX_OWNERS) throw new Error("Rust syntax fact group continuation is invalid.");
    }
    const metrics = exactObject(message["metrics"], ["bytes_transferred", "bytes_copied"]);
    for (const metric of Object.values(metrics)) nonNegativeInteger(metric, "fact group metric");
  } else if (kind === "facts_result") {
    const hasCursor = Object.prototype.hasOwnProperty.call(value, "next_cursor");
    const message = exactObject(value, ["kind", "request_id", "cancellation_id", "project_key", "path", "content_digest", "language", "script_kind", "byte_length", "parsed", "direct_imports", "records", "dependencies", "diagnostics", ...(hasCursor ? ["next_cursor"] : []), "metrics"]);
    identifier(message["request_id"], "request_id"); identifier(message["cancellation_id"], "cancellation_id"); identifier(message["project_key"], "project_key");
    relativePath(message["path"]); digest(message["content_digest"], "content_digest");
    if (!["javascript", "typescript"].includes(String(message["language"])) || !["js", "jsx", "ts", "tsx"].includes(String(message["script_kind"])) || typeof message["parsed"] !== "boolean") throw new Error("Rust syntax facts metadata is invalid.");
    nonNegativeInteger(message["byte_length"], "byte_length");
    if (!Array.isArray(message["direct_imports"]) || !Array.isArray(message["records"]) || !Array.isArray(message["dependencies"]) || !Array.isArray(message["diagnostics"])) throw new Error("Rust syntax facts rows are invalid.");
    if ((message["direct_imports"] as unknown[]).length + (message["records"] as unknown[]).length + (message["dependencies"] as unknown[]).length > RUST_SYNTAX_FACT_PAGE_MAX_ROWS) throw new Error("Rust syntax facts page exceeds its row budget.");
    for (const edgeCandidate of message["direct_imports"] as unknown[]) {
      const hasTarget = edgeCandidate !== null && typeof edgeCandidate === "object" && Object.prototype.hasOwnProperty.call(edgeCandidate, "target_path");
      const edge = exactObject(edgeCandidate, ["specifier", "kind", "start", "end", ...(hasTarget ? ["target_path"] : [])]);
      identifier(edge["specifier"], "specifier"); if (hasTarget) relativePath(edge["target_path"]);
      if (!["import", "export", "dynamic_import", "require"].includes(String(edge["kind"]))) throw new Error("Rust syntax import kind is invalid.");
      span(edge, "import");
    }
    for (const record of message["records"] as unknown[]) validateProposedRecord(record);
    for (const dependency of message["dependencies"] as unknown[]) validateProposedDependency(dependency);
    for (const diagnosticCandidate of message["diagnostics"] as unknown[]) {
      const diagnostic = exactObject(diagnosticCandidate, ["message", "start", "end"]);
      identifier(diagnostic["message"], "diagnostic message"); span(diagnostic, "diagnostic");
    }
    if (hasCursor) validateFactCursor(message["next_cursor"] as RustSyntaxFactCursor);
    const metrics = exactObject(message["metrics"], ["bytes_transferred", "bytes_copied"]);
    for (const metric of Object.values(metrics)) nonNegativeInteger(metric, "fact page metric");
  } else if (kind === "analysis_result") {
    const message = exactObject(value, ["kind", "request_id", "cancellation_id", "project_key", "analysis_token", "build", "changed_files", "affected_files", "metrics", ...(Object.prototype.hasOwnProperty.call(value, "reset_reason") ? ["reset_reason"] : [])]);
    identifier(message["request_id"], "request_id"); identifier(message["cancellation_id"], "cancellation_id"); identifier(message["project_key"], "project_key"); identifier(message["analysis_token"], "analysis_token");
    if (!["full", "incremental", "unchanged"].includes(String(message["build"])) || !Array.isArray(message["changed_files"]) || !Array.isArray(message["affected_files"])) throw new Error("Rust syntax analysis result is invalid.");
    if (Object.prototype.hasOwnProperty.call(message, "reset_reason") && !["initial", "root_set_changed", "configuration_changed", "file_set_changed"].includes(String(message["reset_reason"]))) throw new Error("Rust syntax reset reason is invalid.");
    for (const field of ["changed_files", "affected_files"] as const) {
      const paths = message[field] as unknown[];
      const validated = paths.map(relativePath);
      if (new Set(validated).size !== validated.length || validated.some((path, index) => index > 0 && compareUtf8Bytes(path, validated[index - 1]!) <= 0)) throw new Error(`${field} must be sorted and duplicate-free.`);
    }
    const metrics = exactObject(message["metrics"], ["bytes_read", "bytes_transferred", "bytes_copied", "bytes_decoded", "bytes_retained"]);
    for (const value of Object.values(metrics)) if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Rust syntax boundary metric is invalid.");
  } else {
    // Also provides the closed-host-message assertion used by protocol tests.
    if (kind === "reset") {
      const hasProject = Object.prototype.hasOwnProperty.call(value, "project_key");
      exactObject(value, ["kind", "request_id", ...(hasProject ? ["project_key"] : [])]);
    } else {
      throw new Error("Rust syntax protocol contains an unknown message variant.");
    }
  }
  return value as RustSyntaxWorkerMessage;
}
