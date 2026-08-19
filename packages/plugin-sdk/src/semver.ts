import { canonicalJson, deepFreeze, hasExactKeys } from "./canonical.js";
import { sdkError } from "./errors.js";
import { compareUtf8Bytes } from "./ordering.js";

export interface StructuredVersionInterval {
  readonly minimum?: string;
  readonly minimum_inclusive?: boolean;
  readonly maximum?: string;
  readonly maximum_inclusive?: boolean;
}

export interface StructuredVersionRequirement {
  readonly alternatives: readonly StructuredVersionInterval[];
  readonly allow_prerelease: boolean;
}

export interface ParsedSemVer {
  readonly normalized: string;
  readonly major: number | string;
  readonly minor: number | string;
  readonly patch: number | string;
  readonly prerelease: readonly string[];
  readonly build: readonly string[];
}

interface InternalSemVer extends ParsedSemVer {
  readonly core: readonly [string, string, string];
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const INTERVAL_KEYS = ["minimum", "minimum_inclusive", "maximum", "maximum_inclusive"] as const;

function publicNumeric(value: string): number | string {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : value;
}

function parseInternal(version: string): InternalSemVer {
  const match = SEMVER.exec(version);
  if (!match) throw sdkError("plugin-sdk:version_invalid", "Plugin version is not SemVer 2.0.0.");
  const core = [match[1]!, match[2]!, match[3]!] as const;
  const prerelease = match[4]?.split(".") ?? [];
  const build = match[5]?.split(".") ?? [];
  return deepFreeze({ normalized: `${core.join(".")}${prerelease.length ? `-${prerelease.join(".")}` : ""}${build.length ? `+${build.join(".")}` : ""}`, major: publicNumeric(core[0]), minor: publicNumeric(core[1]), patch: publicNumeric(core[2]), prerelease, build, core });
}

export function parseSemVer(version: string): ParsedSemVer {
  if (typeof version !== "string") throw sdkError("plugin-sdk:version_invalid", "Plugin version must be text.");
  const { core: _core, ...parsed } = parseInternal(version);
  return deepFreeze(parsed);
}

function compareNumeric(left: string, right: string): number {
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}

function compareParsed(left: InternalSemVer, right: InternalSemVer): number {
  for (let index = 0; index < 3; index += 1) {
    const order = compareNumeric(left.core[index]!, right.core[index]!);
    if (order !== 0) return order;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/u.test(a);
    const bNumeric = /^\d+$/u.test(b);
    if (aNumeric && bNumeric) return compareNumeric(a, b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function compareSemVerPrecedence(left: string, right: string): number {
  return compareParsed(parseInternal(left), parseInternal(right));
}

export function normalizeVersionRequirement(requirement: StructuredVersionRequirement): StructuredVersionRequirement {
  if (!hasExactKeys(requirement, ["alternatives", "allow_prerelease"]) || !Array.isArray(requirement.alternatives) || requirement.alternatives.length === 0 || typeof requirement.allow_prerelease !== "boolean") {
    throw sdkError("plugin-sdk:version_requirement_invalid", "Structured version requirement is invalid.");
  }
  const normalized: StructuredVersionInterval[] = [];
  for (const intervalValue of requirement.alternatives) {
    if (!hasExactKeys(intervalValue, [], INTERVAL_KEYS)) throw sdkError("plugin-sdk:version_requirement_invalid", "Structured version interval is invalid.");
    const minimum = intervalValue["minimum"];
    const minimumInclusive = intervalValue["minimum_inclusive"];
    const maximum = intervalValue["maximum"];
    const maximumInclusive = intervalValue["maximum_inclusive"];
    if ((minimum !== undefined && typeof minimum !== "string") || (maximum !== undefined && typeof maximum !== "string") ||
        (minimumInclusive !== undefined && minimum === undefined) || (maximumInclusive !== undefined && maximum === undefined) ||
        (minimumInclusive !== undefined && typeof minimumInclusive !== "boolean") ||
        (maximumInclusive !== undefined && typeof maximumInclusive !== "boolean")) {
      throw sdkError("plugin-sdk:version_requirement_invalid", "Structured version interval is invalid.");
    }
    const item: { minimum?: string; minimum_inclusive?: boolean; maximum?: string; maximum_inclusive?: boolean } = {};
    if (minimum !== undefined) {
      item.minimum = parseInternal(minimum).normalized;
      item.minimum_inclusive = minimumInclusive ?? true;
    }
    if (maximum !== undefined) {
      item.maximum = parseInternal(maximum).normalized;
      item.maximum_inclusive = maximumInclusive ?? true;
    }
    if (item.minimum !== undefined && item.maximum !== undefined) {
      const order = compareSemVerPrecedence(item.minimum, item.maximum);
      if (order > 0 || (order === 0 && (!item.minimum_inclusive || !item.maximum_inclusive))) throw sdkError("plugin-sdk:version_requirement_invalid", "Structured version interval has empty or inverted bounds.");
    }
    normalized.push(item);
  }
  const unique = new Map(normalized.map((item) => [canonicalJson(item), item]));
  return deepFreeze({ alternatives: [...unique.entries()].sort(([left], [right]) => compareUtf8Bytes(left, right)).map(([, item]) => item), allow_prerelease: requirement.allow_prerelease });
}

export function satisfiesVersionRequirement(version: string, requirement: StructuredVersionRequirement): boolean {
  const parsed = parseInternal(version);
  const normalized = normalizeVersionRequirement(requirement);
  if (parsed.prerelease.length > 0 && !normalized.allow_prerelease) return false;
  return normalized.alternatives.some((interval) => {
    if (interval.minimum !== undefined) {
      const order = compareSemVerPrecedence(version, interval.minimum);
      if (order < 0 || (order === 0 && interval.minimum_inclusive === false)) return false;
    }
    if (interval.maximum !== undefined) {
      const order = compareSemVerPrecedence(version, interval.maximum);
      if (order > 0 || (order === 0 && interval.maximum_inclusive === false)) return false;
    }
    return true;
  });
}

export function parseVersionRequirementText(value: string): StructuredVersionRequirement {
  if (typeof value !== "string" || value.trim().length === 0) throw sdkError("plugin-sdk:version_requirement_invalid", "Version requirement must be non-empty text.");
  let allowsPrerelease = false;
  const alternatives = value.split("||").map((item) => item.trim()).filter(Boolean).map((alternative) => {
    if (alternative === "*") return {};
    const single = (operator: "^" | "~") => {
      const parsed = parseInternal(alternative.slice(1));
      allowsPrerelease ||= parsed.prerelease.length > 0;
      const major = BigInt(parsed.core[0]); const minor = BigInt(parsed.core[1]); const patch = BigInt(parsed.core[2]);
      const maximum = operator === "^" ? major > 0n ? `${major + 1n}.0.0` : minor > 0n ? `0.${minor + 1n}.0` : `0.0.${patch + 1n}` : `${major}.${minor + 1n}.0`;
      return { minimum: parsed.normalized, minimum_inclusive: true, maximum, maximum_inclusive: false };
    };
    if (alternative.startsWith("^")) return single("^");
    if (alternative.startsWith("~")) return single("~");
    const comparators = alternative.split(/\s+/u);
    if (comparators.every((item) => /^(?:>=|>|<=|<)\d/u.test(item))) {
      const interval: { minimum?: string; minimum_inclusive?: boolean; maximum?: string; maximum_inclusive?: boolean } = {};
      for (const comparator of comparators) {
        const match = comparator.match(/^(>=|>|<=|<)(.+)$/u)!;
        const parsed = parseInternal(match[2]!); const version = parsed.normalized;
        allowsPrerelease ||= parsed.prerelease.length > 0;
        const lower = match[1]!.startsWith(">");
        const bound = lower ? interval.minimum : interval.maximum;
        const order = bound === undefined ? 0 : compareSemVerPrecedence(version, bound);
        const tighter = bound === undefined || (lower ? order > 0 : order < 0);
        const inclusive = match[1] === ">=" || match[1] === "<=";
        if (tighter) {
          if (lower) { interval.minimum = version; interval.minimum_inclusive = inclusive; }
          else { interval.maximum = version; interval.maximum_inclusive = inclusive; }
        } else if (order === 0) {
          if (lower) interval.minimum_inclusive = interval.minimum_inclusive === true && inclusive;
          else interval.maximum_inclusive = interval.maximum_inclusive === true && inclusive;
        }
      }
      return interval;
    }
    const parsed = parseInternal(alternative);
    allowsPrerelease ||= parsed.prerelease.length > 0;
    return { minimum: parsed.normalized, minimum_inclusive: true, maximum: parsed.normalized, maximum_inclusive: true };
  });
  return normalizeVersionRequirement({ alternatives, allow_prerelease: allowsPrerelease });
}
