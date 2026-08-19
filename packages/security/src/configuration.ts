import { canonicalBytes, digestBytes } from "@urdira/canonical";
import { SecurityError, issue, type SecurityIssue } from "./errors.js";
import { posix, win32 } from "node:path";

const minimumRecoveryRetentionHours = 24;

export interface SecurityConfiguration {
  readonly allow_network: boolean;
  readonly max_response_items: number;
  readonly allowed_external_roots: readonly string[];
  readonly expose_secret_snippets: boolean;
  readonly sandbox_strength: "required" | "standard";
  readonly retention_hours: number;
  readonly max_file_bytes: number;
}

export type ConfigurationLayer = Partial<SecurityConfiguration> & Readonly<Record<string, unknown>>;

export interface ConfigurationLayers {
  readonly installation?: ConfigurationLayer;
  readonly user?: ConfigurationLayer;
  readonly workspace?: ConfigurationLayer;
  readonly persisted_workspace_override?: ConfigurationLayer;
  readonly administrative_override?: ConfigurationLayer;
  readonly request?: ConfigurationLayer;
}

export interface ConfigurationResult {
  readonly effective: SecurityConfiguration;
  readonly issues: readonly SecurityIssue[];
  readonly layer_digests: Readonly<Record<string, string>>;
}

const defaults: SecurityConfiguration = {
  allow_network: false,
  max_response_items: 100,
  allowed_external_roots: [],
  expose_secret_snippets: false,
  sandbox_strength: "required",
  retention_hours: 24,
  max_file_bytes: 10 * 1024 * 1024,
};

const knownKeys = new Set<keyof SecurityConfiguration>([
  "allow_network", "max_response_items", "allowed_external_roots", "expose_secret_snippets", "sandbox_strength", "retention_hours", "max_file_bytes",
]);

function validateLayer(layer: ConfigurationLayer, layerName: string): void {
  for (const key of Object.keys(layer)) {
    if (!knownKeys.has(key as keyof SecurityConfiguration)) throw new SecurityError("security:configuration_unknown_field", `Unknown ${layerName} configuration field: ${key}.`);
  }
  if (layer.allow_network !== undefined && typeof layer.allow_network !== "boolean") throw new SecurityError("security:configuration_invalid", "allow_network must be boolean.");
  if (layer.expose_secret_snippets !== undefined && typeof layer.expose_secret_snippets !== "boolean") throw new SecurityError("security:configuration_invalid", "expose_secret_snippets must be boolean.");
  for (const key of ["max_response_items", "retention_hours", "max_file_bytes"] as const) {
    const value = layer[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new SecurityError("security:configuration_invalid", `${key} must be a non-negative safe integer.`);
    if (key === "retention_hours" && value !== undefined && value < minimumRecoveryRetentionHours) throw new SecurityError("security:configuration_invalid", `retention_hours cannot be less than ${minimumRecoveryRetentionHours}.`);
  }
  if (layer.allowed_external_roots !== undefined && (!Array.isArray(layer.allowed_external_roots) || !layer.allowed_external_roots.every((value) => typeof value === "string"))) throw new SecurityError("security:configuration_invalid", "allowed_external_roots must be a string array.");
  if (layer.sandbox_strength !== undefined && layer.sandbox_strength !== "required" && layer.sandbox_strength !== "standard") throw new SecurityError("security:configuration_invalid", "sandbox_strength is not supported.");
}

function normalizeConfiguredRoot(value: string): string {
  if (!value || value.includes("\0")) throw new SecurityError("security:configuration_invalid", "allowed_external_roots must contain non-empty absolute paths.");
  const portable = value.replaceAll("\\", "/").replace(/\/+/gu, "/").normalize("NFC");
  const windowsAbsolute = /^[A-Za-z]:\//u.test(portable);
  if (!portable.startsWith("/") && !windowsAbsolute) throw new SecurityError("security:configuration_invalid", "allowed_external_roots must contain absolute paths.");
  const normalized = (windowsAbsolute ? win32.normalize(portable) : posix.normalize(portable)).replaceAll("\\", "/");
  const stable = windowsAbsolute ? normalized.toLowerCase() : normalized;
  return stable.length > 1 && stable.endsWith("/") ? stable.slice(0, -1) : stable;
}

function normalizeLayer(layer: ConfigurationLayer, layerName: string): ConfigurationLayer {
  validateLayer(layer, layerName);
  return layer.allowed_external_roots === undefined ? layer : { ...layer, allowed_external_roots: layer.allowed_external_roots.map(normalizeConfiguredRoot) };
}

function parseStrictJson(text: string): unknown {
  const keys: string[] = [];
  const duplicateAware = text.replace(/"(?:\\.|[^"\\])*"\s*:/g, (match) => {
    const keyMatch = match.match(/^\s*"((?:\\.|[^"\\])*)"/);
    if (keyMatch?.[1] !== undefined) {
      const key = JSON.parse(`"${keyMatch[1]}"`) as string;
      if (keys.includes(key)) throw new SecurityError("security:configuration_duplicate_key", `Duplicate configuration key: ${key}.`);
      keys.push(key);
    }
    return match;
  });
  void duplicateAware;
  try {
    const value = JSON.parse(text) as unknown;
    assertUnicode(value);
    return value;
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    throw new SecurityError("security:configuration_invalid", "Configuration must be strict UTF-8 JSON.", { cause: error instanceof Error ? error.message : "parse" });
  }
}

function assertUnicode(value: unknown): void {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next < 0xdc00 || next > 0xdfff) throw new SecurityError("security:configuration_invalid", "Configuration contains invalid Unicode.");
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new SecurityError("security:configuration_invalid", "Configuration contains invalid Unicode.");
    }
  } else if (Array.isArray(value)) for (const item of value) assertUnicode(item);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) assertUnicode(item);
}

export function parseConfigurationLayer(text: string, layerName: string, schemaVersion = 1): ConfigurationLayer {
  const parsed = parseStrictJson(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SecurityError("security:configuration_invalid", "Configuration layer must be a JSON object.");
  const object = parsed as Record<string, unknown>;
  if (object["schema_version"] !== undefined && object["schema_version"] !== schemaVersion) throw new SecurityError("security:configuration_unsupported_schema", `Unsupported configuration schema version in ${layerName}.`);
  const withoutVersion = Object.fromEntries(Object.entries(object).filter(([key]) => key !== "schema_version"));
  validateLayer(withoutVersion, layerName);
  return withoutVersion;
}

function narrow(current: SecurityConfiguration, layer: ConfigurationLayer, layerName: string, issues: SecurityIssue[]): SecurityConfiguration {
  const normalizedLayer = normalizeLayer(layer, layerName);
  const next = { ...current };
  if (normalizedLayer.allow_network === true && !current.allow_network) issues.push(issue("security:configuration_authority_narrowed", `${layerName} attempted to enable network access outside installation policy.`));
  else if (normalizedLayer.allow_network !== undefined) next.allow_network = normalizedLayer.allow_network;
  if (normalizedLayer.max_response_items !== undefined) next.max_response_items = Math.min(current.max_response_items, normalizedLayer.max_response_items);
  if (normalizedLayer.allowed_external_roots !== undefined) {
    const allowed = new Set(current.allowed_external_roots);
    const narrowed = normalizedLayer.allowed_external_roots.filter((root) => allowed.has(root));
    if (narrowed.length !== normalizedLayer.allowed_external_roots.length) issues.push(issue("security:configuration_authority_narrowed", `${layerName} requested an external root outside installation policy.`));
    next.allowed_external_roots = narrowed;
  }
  if (normalizedLayer.expose_secret_snippets === true && !current.expose_secret_snippets) issues.push(issue("security:configuration_authority_narrowed", `${layerName} attempted to expose secret snippets.`));
  else if (normalizedLayer.expose_secret_snippets !== undefined) next.expose_secret_snippets = normalizedLayer.expose_secret_snippets;
  if (normalizedLayer.sandbox_strength === "standard" && current.sandbox_strength === "required") issues.push(issue("security:configuration_authority_narrowed", `${layerName} attempted to weaken sandboxing.`));
  else if (normalizedLayer.sandbox_strength !== undefined) next.sandbox_strength = normalizedLayer.sandbox_strength;
  if (normalizedLayer.retention_hours !== undefined) next.retention_hours = Math.min(current.retention_hours, normalizedLayer.retention_hours);
  if (normalizedLayer.max_file_bytes !== undefined) next.max_file_bytes = Math.min(current.max_file_bytes, normalizedLayer.max_file_bytes);
  return next;
}

export function mergeConfiguration(layers: ConfigurationLayers, installationPolicy: ConfigurationLayer, requestOptions?: ConfigurationLayer): ConfigurationResult {
  const issues: SecurityIssue[] = [];
  const layerDigests: Record<string, string> = {};
  let effective = { ...defaults } as SecurityConfiguration;
  const installation = normalizeLayer({ ...defaults, ...installationPolicy }, "installation");
  effective = {
    allow_network: installation.allow_network as boolean,
    max_response_items: installation.max_response_items as number,
    allowed_external_roots: [...(installation.allowed_external_roots as readonly string[])],
    expose_secret_snippets: installation.expose_secret_snippets as boolean,
    sandbox_strength: installation.sandbox_strength as "required" | "standard",
    retention_hours: installation.retention_hours as number,
    max_file_bytes: installation.max_file_bytes as number,
  };
  layerDigests["installation_policy"] = digestBytes(canonicalBytes(installation));
  for (const [name, layer] of [["installation", layers.installation], ["user", layers.user], ["workspace", layers.workspace], ["persisted_workspace_override", layers.persisted_workspace_override ?? layers.administrative_override], ["request", requestOptions ?? layers.request]] as const) {
    if (!layer) continue;
    const normalizedLayer = normalizeLayer(layer, name);
    effective = narrow(effective, normalizedLayer, name, issues);
    layerDigests[name] = digestBytes(canonicalBytes(normalizedLayer));
  }
  return { effective, issues, layer_digests: layerDigests };
}
