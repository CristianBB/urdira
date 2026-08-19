import { canonicalBytes, digestBytes } from "@urdira/canonical";
import type { PackageFileEntry, PluginPackageManifest } from "@urdira/contracts";
import { SecurityError, issue, type SecurityIssue } from "./errors.js";
import { InMemoryStagingStore, type StagingStore } from "./staging.js";

export interface PackageInspection { readonly valid: boolean; readonly issues: readonly SecurityIssue[]; readonly package_digest?: string; }
export interface PackageInspectionLimits { readonly max_file_bytes?: number; readonly max_total_bytes?: number; }

function validRelativePath(path: string): boolean {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.split("/");
  return !parts.includes("..") && !parts.includes("") && parts.every((part) => part !== ".");
}

function validNamespacedIdentifier(value: string): boolean { return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value); }
function validSemVer(value: string): boolean { return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value); }

function withoutPackageDigest(manifest: PluginPackageManifest): unknown {
  return { package_format_id: manifest.package_format_id, package_format_version: manifest.package_format_version, plugin_id: manifest.plugin_id, plugin_version: manifest.plugin_version, package_files: manifest.package_files };
}

export function inspectPluginPackage(manifest: PluginPackageManifest, files: ReadonlyMap<string, Uint8Array>, limits: PackageInspectionLimits = {}): PackageInspection {
  const issues: SecurityIssue[] = [];
  const manifestKeys = new Set(["package_format_id", "package_format_version", "plugin_id", "plugin_version", "package_files"]);
  if (manifest === null || typeof manifest !== "object" || Object.keys(manifest).some((key) => !manifestKeys.has(key))) issues.push(issue("security:package_manifest_invalid", "Plugin package manifest is not a closed manifest."));
  if (manifest === null || typeof manifest !== "object" || !Array.isArray(manifest.package_files)) return { valid: false, issues };
  if (manifest.package_format_id !== "core:plugin" || manifest.package_format_version !== 1) issues.push(issue("security:package_manifest_invalid", "Plugin package format is unsupported."));
  if (!validNamespacedIdentifier(manifest.plugin_id)) issues.push(issue("security:package_plugin_id_invalid", `Plugin ID ${manifest.plugin_id} is not a valid namespaced identifier.`));
  if (!validSemVer(manifest.plugin_version)) issues.push(issue("security:package_version_invalid", `Plugin version ${manifest.plugin_version} is not SemVer 2.0.0.`));
  if (manifest.package_files.length === 0) issues.push(issue("security:package_manifest_invalid", "Plugin package manifest must declare at least one file."));
  const seen = new Set<string>();
  let total = 0;
  for (const entry of manifest.package_files) {
    if (entry === null || typeof entry !== "object" || !Object.keys(entry).every((key) => ["normalized_relative_path", "content_digest", "byte_length", "executable"].includes(key)) || typeof entry.normalized_relative_path !== "string" || typeof entry.content_digest !== "string" || !Number.isSafeInteger(entry.byte_length) || entry.byte_length < 0 || typeof entry.executable !== "boolean") {
      issues.push(issue("security:package_manifest_invalid", "Plugin package file entry is not a complete typed entry."));
      continue;
    }
    if (!validRelativePath(entry.normalized_relative_path)) issues.push(issue("security:package_path_invalid", `Package path ${entry.normalized_relative_path} is not a normalized relative path.`));
    if (seen.has(entry.normalized_relative_path)) issues.push(issue("security:package_duplicate_path", `Package path ${entry.normalized_relative_path} is duplicated.`));
    seen.add(entry.normalized_relative_path);
    const bytes = files.get(entry.normalized_relative_path);
    if (!bytes) { issues.push(issue("security:package_digest_mismatch", `Package file ${entry.normalized_relative_path} is missing.`)); continue; }
    total += bytes.byteLength;
    if (limits.max_file_bytes !== undefined && bytes.byteLength > limits.max_file_bytes) issues.push(issue("security:package_length_mismatch", `Package file ${entry.normalized_relative_path} exceeds the byte limit.`));
    if (bytes.byteLength !== entry.byte_length) issues.push(issue("security:package_length_mismatch", `Package file ${entry.normalized_relative_path} has an unexpected length.`));
    if (digestBytes(bytes) !== entry.content_digest) issues.push(issue("security:package_digest_mismatch", `Package file ${entry.normalized_relative_path} has an unexpected digest.`));
  }
  for (const path of files.keys()) if (!seen.has(path)) issues.push(issue("security:package_extra_file", `Package contains file ${path} outside its manifest closure.`));
  if (limits.max_total_bytes !== undefined && total > limits.max_total_bytes) issues.push(issue("security:package_length_mismatch", "Package exceeds the total byte limit."));
  let packageDigest: string | undefined;
  try { packageDigest = digestBytes(canonicalBytes(withoutPackageDigest(manifest))); } catch { issues.push(issue("security:package_path_invalid", "Package manifest is not canonically encodable.")); }
  return { valid: issues.length === 0, issues, ...(packageDigest ? { package_digest: packageDigest } : {}) };
}

export interface PluginPackageRecord { readonly plugin_id: string; readonly plugin_version: string; readonly package_digest: string; readonly state: "installed" | "active" | "removed"; }
interface PluginLifecycleState { readonly state_version: 1; readonly staging_occurrence: number; readonly records: readonly PluginPackageRecord[]; }

export class PluginPackageLifecycleManager {
  private readonly records = new Map<string, PluginPackageRecord>();
  private readonly manifests = new Map<string, PluginPackageManifest>();
  private readonly files = new Map<string, ReadonlyMap<string, Uint8Array>>();
  private readonly staging: StagingStore;
  private stagingOccurrence = 0;

  constructor(staging: StagingStore = new InMemoryStagingStore()) {
    this.staging = staging;
    this.restoreState(this.staging.readStateSync?.());
  }

  private persistState(): void {
    this.staging.persistStateSync?.({ state_version: 1, staging_occurrence: this.stagingOccurrence, records: [...this.records.values()] } satisfies PluginLifecycleState);
  }

  private restoreState(value: unknown): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const state = value as Partial<PluginLifecycleState>;
    if (state.state_version !== 1 || !Number.isSafeInteger(state.staging_occurrence) || (state.staging_occurrence as number) < 0 || !Array.isArray(state.records)) return false;
    for (const record of state.records) {
      if (record === null || typeof record !== "object" || typeof record.plugin_id !== "string" || typeof record.plugin_version !== "string" || typeof record.package_digest !== "string" || !["installed", "active", "removed"].includes(record.state)) return false;
    }
    const stagingOccurrence = state.staging_occurrence as number;
    this.records.clear();
    this.stagingOccurrence = stagingOccurrence;
    for (const record of state.records) this.records.set(`${record.plugin_id}@${record.plugin_version}`, record);
    return true;
  }

  async install(manifest: PluginPackageManifest, files: ReadonlyMap<string, Uint8Array>, limits: PackageInspectionLimits = {}): Promise<PluginPackageRecord> {
    const inspection = inspectPluginPackage(manifest, files, limits);
    if (!inspection.valid || !inspection.package_digest) throw new SecurityError(inspection.issues[0]?.code ?? "security:package_digest_mismatch", inspection.issues[0]?.message ?? "Plugin package inspection failed.");
    const key = `${manifest.plugin_id}@${manifest.plugin_version}`;
    const existing = this.records.get(key);
    if (existing && existing.package_digest !== inspection.package_digest) throw new SecurityError("security:package_coordinate_collision", `Plugin coordinate ${key} is already reserved for another package digest.`);
    if (existing && existing.package_digest === inspection.package_digest && existing.state !== "removed") return existing;
    const safeDigest = inspection.package_digest.replace(/[^A-Za-z0-9_-]/g, "_");
    const operationId = `plugin-package-${safeDigest}-${Date.now()}-${++this.stagingOccurrence}`;
    await this.staging.stage(operationId, [...files].map(([path, bytes]) => ({ path, bytes })));
    const record: PluginPackageRecord = { plugin_id: manifest.plugin_id, plugin_version: manifest.plugin_version, package_digest: inspection.package_digest, state: "installed" };
    if (this.staging.publish) await this.staging.publish(operationId, { kind: "plugin-package-installation", value: { coordinate: key, record } }); else await this.staging.commit(operationId);
    this.records.set(key, record);
    this.manifests.set(key, manifest);
    this.files.set(key, new Map([...files].map(([path, bytes]) => [path, new Uint8Array(bytes)])));
    this.persistState();
    return record;
  }

  activate(pluginId: string, pluginVersion: string, packageDigest: string): PluginPackageRecord {
    const key = `${pluginId}@${pluginVersion}`;
    const existing = this.records.get(key);
    if (!existing || existing.state === "removed" || existing.package_digest !== packageDigest) throw new SecurityError("security:package_activation_invalid", `Plugin package ${key} cannot be activated with the requested digest.`);
    const active: PluginPackageRecord = { ...existing, state: "active" };
    this.records.set(key, active);
    this.persistState();
    return active;
  }

  async repair(pluginId: string, pluginVersion: string, manifest: PluginPackageManifest, files: ReadonlyMap<string, Uint8Array>, limits: PackageInspectionLimits = {}): Promise<PluginPackageRecord> {
    const key = `${pluginId}@${pluginVersion}`;
    const existing = this.records.get(key);
    const inspection = inspectPluginPackage(manifest, files, limits);
    if (!existing || !inspection.valid || !inspection.package_digest) throw new SecurityError(inspection.issues[0]?.code ?? "security:package_digest_mismatch", inspection.issues[0]?.message ?? `Plugin package ${key} cannot be repaired.`);
    if (existing.package_digest !== inspection.package_digest) throw new SecurityError("security:package_coordinate_collision", `Repair changes the approved plugin package digest for ${key}.`);
    const operationId = `plugin-package-repair-${inspection.package_digest.replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now()}-${++this.stagingOccurrence}`;
    await this.staging.stage(operationId, [...files].map(([path, bytes]) => ({ path, bytes })));
    if (this.staging.publish) await this.staging.publish(operationId, { kind: "plugin-package-repair", value: { coordinate: key, package_digest: inspection.package_digest } }); else await this.staging.commit(operationId);
    this.manifests.set(key, manifest);
    this.files.set(key, new Map([...files].map(([path, bytes]) => [path, new Uint8Array(bytes)])));
    this.persistState();
    return existing;
  }

  remove(pluginId: string, pluginVersion: string): PluginPackageRecord {
    const key = `${pluginId}@${pluginVersion}`;
    const existing = this.records.get(key);
    if (!existing) throw new SecurityError("security:package_digest_mismatch", `Plugin package ${key} is not installed.`);
    const removed: PluginPackageRecord = { ...existing, state: "removed" };
    this.records.set(key, removed);
    this.persistState();
    return removed;
  }

  list(): readonly PluginPackageRecord[] { return [...this.records.values()].sort((left, right) => left.plugin_id.localeCompare(right.plugin_id) || left.plugin_version.localeCompare(right.plugin_version)); }

  async recover(): Promise<void> {
    await this.staging.recoverAll?.();
    this.restoreState(await this.staging.readState?.());
    for (const publication of await this.staging.listPublications?.() ?? []) {
      if (publication.kind !== "plugin-package-installation" || publication.value === null || typeof publication.value !== "object") continue;
      const value = publication.value as { coordinate?: unknown; record?: unknown };
      if (typeof value.coordinate !== "string" || value.record === null || typeof value.record !== "object") continue;
      const record = value.record as PluginPackageRecord;
      if (typeof record.plugin_id === "string" && typeof record.plugin_version === "string" && typeof record.package_digest === "string" && ["installed", "active", "removed"].includes(record.state) && !this.records.has(value.coordinate)) this.records.set(value.coordinate, record);
    }
    this.persistState();
  }
}
