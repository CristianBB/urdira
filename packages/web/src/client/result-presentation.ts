import type { QueryChoice } from "./query-choices.js";
import { isGeneratedArtifactPath } from "./presentation.js";

type JsonRecord = Record<string, unknown>;

export interface PresentedResult {
  readonly classification: "Confirmed" | "Possible";
  readonly rawClassification: "confirmed" | "possible";
  readonly title: string;
  readonly kind: string;
  readonly path?: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly snippet?: string;
  readonly explanation?: string;
  readonly confidence?: string;
  readonly technicalIds: readonly string[];
  readonly raw: JsonRecord;
}

export interface PresentedResultGroup {
  readonly id: string;
  readonly label: string;
  readonly total: number;
  readonly items: readonly PresentedResult[];
}

export interface PresentedResultPage {
  readonly groups: readonly PresentedResultGroup[];
  readonly hiddenGenerated: number;
}

export interface PageNavigation {
  readonly total: number;
  readonly returned: number;
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
  readonly nextCursor?: string;
  readonly previousCursor?: string;
}

const record = (value: unknown): JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const firstString = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
const firstNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/u.test(value)) return Number(value);
  }
  return undefined;
};

const kindLabels: Readonly<Record<string, string>> = {
  artifact: "File",
  source_file: "File",
  callable: "Function",
  function: "Function",
  method: "Method",
  constructor: "Constructor",
  value: "Variable",
  variable: "Variable",
  constant: "Constant",
  type: "Type",
  class: "Class",
  interface: "Interface",
  enum: "Enum",
  module: "Module",
  container: "Module",
  relation: "Relationship",
  diagnostic: "Diagnostic",
  definition: "Definition",
};

const resultSetLabels: Readonly<Record<string, string>> = {
  artifacts: "Files",
  candidates: "Relevant code",
  declarations: "Declarations",
  definitions: "Registry definitions",
  definition_set: "Definition summary",
  entry_points: "Entry points",
  boundaries: "Boundaries",
  public_surfaces: "Public surfaces",
  extension_points: "Extension points",
  layers: "Layers",
  cycles: "Cycles",
  matches: "Exact matches",
  members: "Members",
  owners: "Files containing references",
  paths: "Relationship paths",
  references: "References",
  relations: "Relationships",
  sources: "Source",
  subjects: "Related symbols",
  tests: "Related tests",
  fixtures: "Fixtures",
  mocks: "Mocks",
  helpers: "Test helpers",
  will_break: "Will break",
  must_update: "Must update",
  may_be_affected: "May be affected",
  tests_to_run: "Tests to run",
  uncertain_dynamic_usage: "Uncertain dynamic usage",
};

function humanizeToken(value: string): string {
  const withoutNamespace = value.split(":").at(-1) ?? value;
  return withoutNamespace.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

export function humanizeKind(value: string | undefined): string {
  if (value === undefined) return "Code item";
  const token = (value.split(":").at(-1) ?? value).toLocaleLowerCase();
  return kindLabels[token] ?? humanizeToken(token);
}

export function humanizeResultSet(value: string): string {
  return resultSetLabels[value] ?? humanizeToken(value);
}

function sourceLocation(primary: JsonRecord, body: JsonRecord): { path?: string; line?: number; endLine?: number } {
  const source = record(primary["source"]);
  const artifact = record(primary["artifact"]);
  const recordValue = record(primary["record"]);
  const recordBody = record(recordValue["body"]);
  const span = record(primary["source_span"]);
  const bodySpan = record(body["source_span"]);
  const sourceSpan = record(source["span"]);
  const recordSpan = record(recordValue["source_span"]);
  const path = firstString(primary["path"], body["path"], source["path"], artifact["path"], body["artifact_path"], recordBody["path"], recordBody["artifact_path"]);
  const line = firstNumber(span["start_line"], bodySpan["start_line"], sourceSpan["start_line"], recordSpan["start_line"]);
  const endLine = firstNumber(span["end_line"], bodySpan["end_line"], sourceSpan["end_line"], recordSpan["end_line"]);
  return { ...(path === undefined ? {} : { path }), ...(line === undefined ? {} : { line }), ...(endLine === undefined ? {} : { endLine }) };
}

function sourceSnippet(bundle: JsonRecord, primary: JsonRecord, body: JsonRecord): string | undefined {
  const snippets = Array.isArray(bundle["optional_source_snippets"]) ? bundle["optional_source_snippets"] : [];
  for (const candidate of snippets) {
    const value = record(candidate);
    const snippet = record(value["snippet"]);
    const text = firstString(value["text"], snippet["text"]);
    if (text !== undefined) return text;
  }
  const source = record(primary["source"]);
  const nestedSnippet = record(source["snippet"]);
  return firstString(body["snippet"], primary["snippet"], nestedSnippet["text"], body["text"], primary["text"]);
}

function technicalIds(primary: JsonRecord, body: JsonRecord): readonly string[] {
  const values = new Set<string>();
  const visit = (value: JsonRecord): void => {
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "id" || key.endsWith("_id")) && typeof entry === "string" && entry.length > 0) values.add(entry);
    }
  };
  visit(primary); visit(body); visit(record(primary["subject"])); visit(record(primary["record"]));
  return [...values];
}

function titleFor(primary: JsonRecord, body: JsonRecord, path: string | undefined, kind: string): string {
  const qualifiedName = firstString(body["qualified_name"], primary["qualified_name"]);
  const explicit = firstString(body["display_name"], body["name"], primary["display_name"], primary["name"], body["symbol"]);
  if (explicit !== undefined) return explicit;
  if (qualifiedName !== undefined) return qualifiedName.split(/[.:/]/u).filter(Boolean).at(-1) ?? qualifiedName;
  if (path !== undefined) return path.split("/").at(-1) ?? path;
  return kind;
}

function presentBundle(bundle: JsonRecord, classification: "confirmed" | "possible"): PresentedResult {
  const primary = record(bundle["primary_result"]);
  const nestedRecord = record(primary["record"]);
  const body = Object.keys(record(primary["body"])).length > 0 ? record(primary["body"]) : record(nestedRecord["body"]);
  const location = sourceLocation(primary, body);
  const rawKind = firstString(body["kind"], primary["universal_kind"], primary["kind"], nestedRecord["kind"]);
  const kind = humanizeKind(rawKind);
  const assessment = record(bundle["assessment"]);
  const evidence = record(assessment["evidence_summary"]);
  const explanation = firstString(evidence["primary_derivation"], evidence["primary_basis"], body["summary"], primary["summary"]);
  const confidence = firstString(assessment["confidence_level"], assessment["confidence"]);
  const snippet = sourceSnippet(bundle, primary, body);
  return {
    classification: classification === "confirmed" ? "Confirmed" : "Possible",
    rawClassification: classification,
    title: titleFor(primary, body, location.path, kind),
    kind,
    ...location,
    ...(snippet === undefined ? {} : { snippet }),
    ...(explanation === undefined ? {} : { explanation }),
    ...(confidence === undefined ? {} : { confidence }),
    technicalIds: technicalIds(primary, body),
    raw: bundle,
  };
}

const generatedFilteredOperations = new Set(["core:find_artifacts", "core:inspect_architecture", "core:search_text", "core:search_semantic", "core:search_hybrid"]);

export function presentResultPage(pageValue: unknown, operation: string): PresentedResultPage {
  const page = record(pageValue);
  const groups: PresentedResultGroup[] = [];
  let hiddenGenerated = 0;
  for (const setValue of Array.isArray(page["result_sets"]) ? page["result_sets"] : []) {
    const set = record(setValue);
    const id = firstString(set["result_set"]) ?? "results";
    if (id === "semantic_coverage") continue;
    const items: PresentedResult[] = [];
    let total = 0;
    for (const classification of ["confirmed", "possible"] as const) {
      const stream = record(set[classification]);
      total += Number(stream["total"] ?? 0);
      for (const bundleValue of Array.isArray(stream["result_bundles"]) ? stream["result_bundles"] : []) {
        const item = presentBundle(record(bundleValue), classification);
        if (generatedFilteredOperations.has(operation) && item.path !== undefined && isGeneratedArtifactPath(item.path)) hiddenGenerated += 1;
        else items.push(item);
      }
    }
    if (items.length > 0 || total > 0) groups.push({ id, label: humanizeResultSet(id), total, items });
  }
  return { groups, hiddenGenerated };
}

export function pageNavigation(pageValue: unknown, hasLocalPrevious = false): PageNavigation {
  const page = record(pageValue);
  let total = 0;
  let nextCursor: string | undefined;
  let previousCursor: string | undefined;
  for (const setValue of Array.isArray(page["result_sets"]) ? page["result_sets"] : []) {
    const set = record(setValue);
    for (const classification of ["confirmed", "possible"] as const) {
      const stream = record(set[classification]);
      total += Number(stream["total"] ?? 0);
      if (nextCursor === undefined && stream["has_next"] === true && typeof stream["next_cursor"] === "string") nextCursor = stream["next_cursor"];
      if (previousCursor === undefined && stream["has_previous"] === true && typeof stream["previous_cursor"] === "string") previousCursor = stream["previous_cursor"];
    }
  }
  return {
    total,
    returned: Number(page["returned_items"] ?? 0),
    hasNext: nextCursor !== undefined,
    hasPrevious: previousCursor !== undefined || hasLocalPrevious,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(previousCursor === undefined ? {} : { previousCursor }),
  };
}

export function symbolSelectorForChoice(choice: QueryChoice | undefined, fallback = ""): JsonRecord {
  const name = choice?.name ?? choice?.qualifiedName ?? choice?.value ?? fallback.trim();
  return {
    subject_type: "symbol",
    name,
    ...(choice?.path === undefined ? {} : { context_artifact: choice.path }),
    ...(choice?.path === undefined || choice.startByte === undefined ? {} : { context_byte_offset: choice.startByte }),
  };
}
