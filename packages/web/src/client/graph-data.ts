import { humanizeKind } from "./result-presentation.js";

export interface GraphNode { readonly id: string; readonly label: string; readonly kind?: string; readonly path?: string; readonly line?: number }
export interface GraphEdge { readonly id: string; readonly source: string; readonly target: string; readonly sourceLabel: string; readonly targetLabel: string; readonly label: string; readonly classification?: string }
export interface GraphData { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] }

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const identifier = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  const valueRow = row(value);
  for (const key of ["entity_id", "record_id", "artifact_id", "subject_id", "id", "name"]) if (typeof valueRow[key] === "string") return valueRow[key] as string;
  return undefined;
};

const firstString = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === "string" && value.trim().length > 0);

function readableRelation(value: string): string {
  const token = (value.split(":").at(-1) ?? value).replace(/^relation_/u, "");
  if (token === "entity_container") return "Contains";
  if (token.startsWith("entity_")) return "Related";
  return token.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function fallbackLabel(id: string): string {
  if (/^(?:sha256|artifact-version|record|entity):[a-f\d-]{12,}$/iu.test(id)) return "Related code item";
  return id.split(/[/:.]/u).filter(Boolean).at(-1) ?? "Related code item";
}

function subjectNode(value: unknown, fallbackKind?: string): GraphNode | undefined {
  const id = identifier(value);
  if (id === undefined) return undefined;
  if (typeof value === "string") return { id, label: fallbackLabel(id), ...(fallbackKind === undefined ? {} : { kind: humanizeKind(fallbackKind) }) };
  const valueRow = row(value);
  const body = row(valueRow["body"]);
  const span = row(valueRow["source_span"]);
  const bodySpan = row(body["source_span"]);
  const path = firstString(valueRow["path"], body["path"], valueRow["artifact_path"], body["artifact_path"]);
  const qualifiedName = firstString(valueRow["qualified_name"], body["qualified_name"]);
  const label = firstString(valueRow["display_name"], valueRow["name"], body["display_name"], body["name"], qualifiedName === undefined ? undefined : qualifiedName.split(/[.:/]/u).filter(Boolean).at(-1), path === undefined ? undefined : path.split("/").at(-1)) ?? fallbackLabel(id);
  const rawKind = firstString(valueRow["kind"], body["kind"], valueRow["universal_kind"], fallbackKind);
  const lineValue = typeof span["start_line"] === "number" ? span["start_line"] : typeof bodySpan["start_line"] === "number" ? bodySpan["start_line"] : undefined;
  return { id, label, ...(rawKind === undefined ? {} : { kind: humanizeKind(rawKind) }), ...(path === undefined ? {} : { path }), ...(lineValue === undefined ? {} : { line: lineValue }) };
}

export function graphDataFromPage(pageValue: unknown, root: string): GraphData {
  const page = row(pageValue);
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const addNode = (value: unknown, kind?: string): GraphNode | undefined => {
    const next = subjectNode(value, kind);
    if (next === undefined) return undefined;
    const current = nodes.get(next.id);
    if (current === undefined || current.label === "Related code item" || next.path !== undefined) nodes.set(next.id, { ...current, ...next });
    return nodes.get(next.id);
  };
  const addEdge = (sourceValue: unknown, targetValue: unknown, relation: string, classification?: string): void => {
    const source = addNode(sourceValue); const target = addNode(targetValue);
    if (source === undefined || target === undefined) return;
    const label = readableRelation(relation);
    const id = `${source.id}\u0000${label.toLocaleLowerCase()}\u0000${target.id}`;
    if (!edges.has(id)) edges.set(id, { id, source: source.id, target: target.id, sourceLabel: source.label, targetLabel: target.label, label, ...(classification === undefined ? {} : { classification }) });
  };
  if (root.trim().length > 0) addNode(root.trim(), "root");
  for (const setValue of Array.isArray(page["result_sets"]) ? page["result_sets"] : []) {
    const set = row(setValue);
    for (const classification of ["confirmed", "possible"] as const) {
      const stream = row(set[classification]);
      for (const bundleValue of Array.isArray(stream["result_bundles"]) ? stream["result_bundles"] : []) {
        const primary = row(row(bundleValue)["primary_result"]);
        const body = row(primary["body"]);
        const value = Object.keys(body).length > 0 ? body : primary;
        const path = Array.isArray(value["subjects"]) ? value["subjects"] : [];
        const relationKinds = Array.isArray(value["relation_kinds"]) ? value["relation_kinds"].filter((entry): entry is string => typeof entry === "string") : [];
        if (path.length > 1) for (let index = 0; index < path.length - 1; index += 1) addEdge(path[index]!, path[index + 1]!, relationKinds[index] ?? "related", classification);
        const sourceValue = value["source"] ?? value["source_subject"] ?? value["source_id"] ?? value["source_subject_id"];
        const targetValue = value["target"] ?? value["target_subject"] ?? value["target_id"] ?? value["target_subject_id"];
        const source = identifier(sourceValue);
        const target = identifier(targetValue);
        const relation = typeof value["relation_kind"] === "string" ? value["relation_kind"] : typeof primary["kind"] === "string" ? primary["kind"] : "related";
        if (source !== undefined && target !== undefined) addEdge(sourceValue, targetValue, relation, classification);
        const subjectValue = value["subject"] ?? primary["subject"] ?? primary;
        const subject = identifier(subjectValue);
        if (subject !== undefined) {
          addNode(subjectValue, typeof primary["universal_kind"] === "string" ? primary["universal_kind"] : undefined);
          if (root.trim().length > 0 && subject !== root.trim() && source === undefined && path.length === 0) addEdge(root.trim(), subjectValue, relation, classification);
        }
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()].map((edge) => ({ ...edge, sourceLabel: nodes.get(edge.source)?.label ?? edge.sourceLabel, targetLabel: nodes.get(edge.target)?.label ?? edge.targetLabel })) };
}
