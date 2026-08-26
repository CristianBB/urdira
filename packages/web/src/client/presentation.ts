export interface ChoiceLike {
  readonly value: string;
  readonly label: string;
  readonly context?: string;
}

type JsonRecord = Record<string, unknown>;

const generatedSegments = new Set([
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".typecheck",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

export function isGeneratedArtifactPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  const segments = normalized.split("/");
  return segments.some((segment) => generatedSegments.has(segment.toLowerCase()))
    || /(?:^|\/)release\/artifacts(?:\/|$)/iu.test(normalized)
    || /(?:^|\/)(?:tmp-|temp-)/iu.test(normalized)
    || /\.(?:log|lock|map)$/iu.test(normalized);
}

export function visibleArtifactChoices<T extends ChoiceLike>(choices: readonly T[]): readonly T[] {
  return choices.filter((choice) => !isGeneratedArtifactPath(choice.value));
}

export function disambiguateChoices<T extends ChoiceLike>(choices: readonly T[]): readonly T[] {
  const labelCounts = new Map<string, number>();
  for (const choice of choices) labelCounts.set(choice.label, (labelCounts.get(choice.label) ?? 0) + 1);
  return choices.map((choice) => labelCounts.get(choice.label) === 1
    ? choice
    : { ...choice, label: `${choice.label} — ${choice.context ?? choice.value}` });
}

export function filterChoices<T extends ChoiceLike>(choices: readonly T[], query: string, limit = 80): readonly T[] {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const matching = tokens.length === 0 ? choices : choices.filter((choice) => {
    const haystack = `${choice.label} ${choice.value} ${choice.context ?? ""}`.toLocaleLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
  return matching.slice(0, limit);
}

export function structuredCollectionLayout(records: readonly JsonRecord[]): "table" | "cards" {
  const keys = new Set(records.flatMap((entry) => Object.keys(entry)));
  const hasNestedValue = records.some((entry) => Object.values(entry).some((value) => value !== null && typeof value === "object"));
  return keys.size > 4 || hasNestedValue ? "cards" : "table";
}

export function groupPresentationItems<T>(items: readonly T[], keyFor: (item: T) => string): readonly { readonly item: T; readonly count: number }[] {
  const groups = new Map<string, { item: T; count: number }>();
  for (const item of items) {
    const key = keyFor(item);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { item, count: 1 });
    else existing.count += 1;
  }
  return [...groups.values()];
}
