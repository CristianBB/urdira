import { disambiguateChoices, visibleArtifactChoices } from "./presentation.js";

export interface QueryChoice {
  readonly value: string;
  readonly label: string;
  readonly context?: string;
  readonly name?: string;
  readonly qualifiedName?: string;
  readonly kind?: string;
  readonly path?: string;
  readonly line?: number;
  readonly startByte?: number;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/u.test(value)) return Number(value);
  }
  return undefined;
}

export function queryChoices(result: unknown, kind: "artifact" | "symbol"): readonly QueryChoice[] {
  const page = record(record(result)["structuredContent"])["page"];
  const choices = new Map<string, QueryChoice>();
  for (const setValue of Array.isArray(record(page)["result_sets"]) ? record(page)["result_sets"] as unknown[] : []) {
    const set = record(setValue);
    for (const classification of ["confirmed", "possible"] as const) {
      const bundles = record(set[classification])["result_bundles"];
      for (const bundleValue of Array.isArray(bundles) ? bundles : []) {
        const primary = record(record(bundleValue)["primary_result"]);
        const body = record(primary["body"]);
        if (kind === "artifact") {
          const path = firstString(primary["path"], body["path"]);
          if (path !== undefined) choices.set(path, { value: path, label: path });
        } else {
          const name = firstString(body["name"], primary["name"]);
          const qualifiedName = firstString(body["qualified_name"], primary["qualified_name"]);
          if (name !== undefined) {
            const detail = firstString(body["kind"], primary["universal_kind"]);
            const path = firstString(primary["path"], body["path"]);
            const span = record(primary["source_span"]);
            const line = firstNumber(span["start_line"], body["start_line"]);
            const startByte = firstNumber(span["start_byte"], body["start_byte"], body["start"]);
            const location = path === undefined ? undefined : `${path}${line !== undefined ? `:${line}` : startByte !== undefined ? ` · byte ${startByte}` : ""}`;
            const identity = qualifiedName ?? name;
            const value = `${identity}@${path ?? "workspace"}:${startByte ?? line ?? choices.size}`;
            const context = location ?? qualifiedName;
            choices.set(value, {
              value,
              label: detail === undefined ? name : `${name} · ${detail}`,
              ...(context === undefined ? {} : { context }),
              name,
              ...(qualifiedName === undefined ? {} : { qualifiedName }),
              ...(detail === undefined ? {} : { kind: detail }),
              ...(path === undefined ? {} : { path }),
              ...(line === undefined ? {} : { line }),
              ...(startByte === undefined ? {} : { startByte }),
            });
          }
        }
      }
    }
  }
  const sorted = [...choices.values()].sort((left, right) => left.label.localeCompare(right.label));
  return disambiguateChoices(kind === "artifact" ? visibleArtifactChoices(sorted) : sorted);
}

export function nextQueryCursor(result: unknown): string | undefined {
  const page = record(record(result)["structuredContent"])["page"];
  for (const setValue of Array.isArray(record(page)["result_sets"]) ? record(page)["result_sets"] as unknown[] : []) {
    const set = record(setValue);
    for (const classification of ["confirmed", "possible"] as const) {
      const stream = record(set[classification]);
      if (stream["has_next"] === true && typeof stream["next_cursor"] === "string") return stream["next_cursor"];
    }
  }
  return undefined;
}
