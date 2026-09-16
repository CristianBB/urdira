import { facetRegistry, languageRegistry, universalEntityKinds, universalRelationKinds } from "@urdira/contracts";
import type { QueryStreamItem } from "./query-operators.js";

type DefinitionEntry = { readonly definition_type: string; readonly definition_id: string };

/**
 * Resolves registry definitions, deliberately separate from workspace-record
 * queries. Registry names are a closed inventory; this function never scans or
 * hydrates source records.
 */
export function discoverDefinitions(args: Record<string, unknown>): Readonly<Record<string, readonly QueryStreamItem[]>> {
  const matcher = asObject(args["matcher"]);
  const text = String(matcher["text"] ?? "");
  const mode = String(matcher["mode"] ?? "exact");
  const matcherTypes = asStrings(matcher["definition_types"]);
  const selectorTypes = asStrings(asObject(args["selector"])["definition_types"]);
  const allowedTypes = selectorTypes.length > 0 ? new Set(selectorTypes) : matcherTypes.length > 0 ? new Set(matcherTypes) : undefined;
  const inventory: readonly DefinitionEntry[] = [
    ...universalEntityKinds.map((kind) => ({ definition_type: "record_kind", definition_id: kind })),
    ...universalRelationKinds.map((kind) => ({ definition_type: "record_kind", definition_id: kind })),
    ...facetRegistry.map((facet) => ({ definition_type: "facet", definition_id: facet })),
    ...languageRegistry.map((language) => ({ definition_type: "language", definition_id: language.id })),
  ];
  const matches = (id: string): boolean => {
    const local = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
    if (mode === "exact") return id === text || local === text;
    if (mode === "prefix") return id.startsWith(text) || local.startsWith(text);
    return id.includes(text) || local.includes(text);
  };
  const matched = inventory.filter((definition) => (allowedTypes === undefined || allowedTypes.has(definition.definition_type)) && (text.length === 0 || matches(definition.definition_id)));
  const definitions: QueryStreamItem[] = matched.map((definition, index) => ({
    value: { subject_type: "definition", definition_type: definition.definition_type, definition_id: definition.definition_id, match_class: mode === "exact" ? "exact" : "lexical", match_terms: [text] },
    stable_sort_key: `confirmed\0${String(index).padStart(6, "0")}\0${definition.definition_id}`,
  }));
  const definitionSet: QueryStreamItem[] = matched.length === 0 ? [] : [{ value: { definitions: matched }, stable_sort_key: "0" }];
  return { definitions, definition_set: definitionSet };
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
