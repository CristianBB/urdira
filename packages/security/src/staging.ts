import { SecurityError } from "./errors.js";
import { mkdir, readdir, readFile, rename, rm, writeFile, open, lstat } from "node:fs/promises";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { digestBytes } from "@urdira/canonical";

export interface StagedFile { readonly path: string; readonly bytes: Uint8Array; }
export interface RecoveryResult { readonly state: "discarded" | "committed"; readonly removed_paths: readonly string[]; }
export interface StagingPublication { readonly kind: string; readonly value: unknown; }
export interface FileStagingStoreOptions {
  readonly fault_injector?: (point: string) => void | Promise<void>;
  readonly fault_injector_sync?: (point: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly sync_directory?: (directory: string) => void;
  readonly sync_file?: (path: string) => void;
}
export interface StagingStore { stage(operationId: string, files: readonly StagedFile[]): Promise<void>; markInterrupted(operationId: string): Promise<void>; commit(operationId: string): Promise<void>; publish?(operationId: string, publication: StagingPublication): Promise<void>; listPublications?(): Promise<readonly StagingPublication[]>; readPublishedFile?(operationId: string, path: string): Promise<Uint8Array | undefined>; persistStateSync?(state: unknown): void; readState?(): Promise<unknown>; readStateSync?(): unknown; recover(operationId: string): Promise<RecoveryResult>; recoverAll?(): Promise<readonly (RecoveryResult & { readonly operation_id: string })[]>; }

export class InMemoryStagingStore implements StagingStore {
  private readonly operations = new Map<string, { state: "staged" | "interrupted" | "committed"; files: Map<string, Uint8Array> }>();
  readonly publications = new Map<string, StagingPublication>();
  private state: unknown;

  persistStateSync(state: unknown): void { this.state = state; }
  async readState(): Promise<unknown> { return this.state; }
  readStateSync(): unknown { return this.state; }

  async stage(operationId: string, files: readonly StagedFile[]): Promise<void> {
    if (this.operations.has(operationId)) throw new SecurityError("security:staging_recovery_required", `Staging operation ${operationId} already exists.`);
    const staged = new Map<string, Uint8Array>();
    for (const file of files) {
      if (!file.path || file.path.includes("..") || file.path.startsWith("/") || file.path.includes("\\")) throw new SecurityError("security:path_invalid", `Staged path ${file.path} is invalid.`);
      if (staged.has(file.path)) throw new SecurityError("security:package_duplicate_path", `Staged path ${file.path} is duplicated.`);
      staged.set(file.path, new Uint8Array(file.bytes));
    }
    this.operations.set(operationId, { state: "staged", files: staged });
  }

  async markInterrupted(operationId: string): Promise<void> {
    const operation = this.operations.get(operationId);
    if (!operation) throw new SecurityError("security:staging_recovery_required", `Staging operation ${operationId} is missing.`);
    operation.state = "interrupted";
  }

  async commit(operationId: string): Promise<void> {
    const operation = this.operations.get(operationId);
    if (!operation || operation.state === "interrupted") throw new SecurityError("security:staging_recovery_required", `Staging operation ${operationId} is not safely committable.`);
    operation.state = "committed";
  }

  async publish(operationId: string, publication: StagingPublication): Promise<void> {
    const operation = this.operations.get(operationId);
    if (!operation || operation.state !== "staged") throw new SecurityError("security:staging_recovery_required", `Staging operation ${operationId} is not safely publishable.`);
    this.publications.set(operationId, publication);
    operation.state = "committed";
  }

  async listPublications(): Promise<readonly StagingPublication[]> {
    return [...this.publications.values()];
  }

  async readPublishedFile(operationId: string, path: string): Promise<Uint8Array | undefined> {
    const operation = this.operations.get(operationId);
    return operation?.state === "committed" ? operation.files.get(path) : undefined;
  }

  async recover(operationId: string): Promise<RecoveryResult> {
    const operation = this.operations.get(operationId);
    if (!operation) return { state: "discarded", removed_paths: [] };
    if (operation.state === "committed") return { state: "committed", removed_paths: [] };
    const removedPaths = [...operation.files.keys()].sort();
    this.operations.delete(operationId);
    return { state: "discarded", removed_paths: removedPaths };
  }
}

interface CatalogOperation { readonly state: "staged" | "publishing" | "interrupted" | "committed"; readonly paths: readonly string[]; readonly publication?: StagingPublication; }
interface StagingCatalog { readonly operations: Readonly<Record<string, CatalogOperation>>; readonly state?: unknown; }

function validateOperationId(operationId: string): void {
  if (!operationId || operationId.includes("/") || operationId.includes("\\") || operationId.includes("..")) throw new SecurityError("security:path_invalid", `Staging operation ${operationId} is invalid.`);
}

function validateStagedPath(path: string): void {
  if (!path || path.includes("..") || path.startsWith("/") || path.includes("\\")) throw new SecurityError("security:path_invalid", `Staged path ${path} is invalid.`);
}

export function stagingOperationEntryName(operationId: string): string {
  validateOperationId(operationId);
  return `operation-${digestBytes(new TextEncoder().encode(operationId)).slice("sha256:".length)}`;
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, "r+");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export class FileStagingStore implements StagingStore {
  private readonly root: string;
  private readonly stagingRoot: string;
  private readonly publishedRoot: string;
  private readonly catalogPath: string;
  private readonly options: FileStagingStoreOptions;
  private readonly platform: NodeJS.Platform;
  private readonly syncDirectoryHook: (directory: string) => void;
  private readonly syncFileHook: (path: string) => void;

  constructor(root: string, options: FileStagingStoreOptions = {}) {
    this.root = resolve(root);
    this.stagingRoot = join(this.root, "staging");
    this.publishedRoot = join(this.root, "published");
    this.catalogPath = join(this.root, "catalog.json");
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.syncDirectoryHook = options.sync_directory ?? fsyncDirectory;
    this.syncFileHook = options.sync_file ?? fsyncFile;
  }

  private async fault(point: string): Promise<void> { await this.options.fault_injector?.(point); }

  private syncNamespace(directory: string, installedFile?: string): void {
    if (this.platform === "win32") {
      if (installedFile) this.syncFileHook(installedFile);
      return;
    }
    this.syncDirectoryHook(directory);
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.publishedRoot, { recursive: true, mode: 0o700 });
  }

  private async readCatalog(): Promise<StagingCatalog> {
    try { return JSON.parse(await readFile(this.catalogPath, "utf8")) as StagingCatalog; } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { operations: {} };
      throw new SecurityError("security:staging_recovery_required", "Staging catalog is not valid JSON.");
    }
  }

  private async writeCatalog(catalog: StagingCatalog): Promise<void> {
    await mkdir(dirname(this.catalogPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.catalogPath}.tmp-${process.pid}-${Date.now()}`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(catalog)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.catalogPath);
    this.syncNamespace(dirname(this.catalogPath), this.catalogPath);
  }

  private readCatalogSync(): StagingCatalog {
    try { return JSON.parse(readFileSync(this.catalogPath, "utf8")) as StagingCatalog; } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { operations: {} };
      throw new SecurityError("security:staging_recovery_required", "Staging catalog is not valid JSON.");
    }
  }

  private writeCatalogSync(catalog: StagingCatalog): void {
    mkdirSync(dirname(this.catalogPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.catalogPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try { writeFileSync(descriptor, JSON.stringify(catalog)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, this.catalogPath);
    this.options.fault_injector_sync?.("staging.catalog.before_directory_fsync");
    this.syncNamespace(dirname(this.catalogPath), this.catalogPath);
    this.options.fault_injector_sync?.("staging.catalog.after_directory_fsync");
  }

  persistStateSync(state: unknown): void {
    const catalog = this.readCatalogSync();
    this.writeCatalogSync({ ...catalog, state });
  }

  async readState(): Promise<unknown> { return (await this.readCatalog()).state; }
  readStateSync(): unknown { return this.readCatalogSync().state; }

  private operationPath(root: string, operationId: string): string {
    const path = join(root, stagingOperationEntryName(operationId));
    if (relative(this.root, path).startsWith("..")) throw new SecurityError("security:path_invalid", "Staging path escapes its root.");
    return path;
  }

  async stage(operationId: string, files: readonly StagedFile[]): Promise<void> {
    await this.ensureRoot();
    const catalog = await this.readCatalog();
    if (catalog.operations[operationId] || await lstat(this.operationPath(this.publishedRoot, operationId)).then(() => true).catch(() => false)) throw new SecurityError("security:staging_recovery_required", `Staging operation ${operationId} already exists.`);
    const operationPath = this.operationPath(this.stagingRoot, operationId);
    await mkdir(operationPath, { recursive: true, mode: 0o700 });
    const paths: string[] = [];
    try {
      for (const file of files) {
        validateStagedPath(file.path);
        if (paths.includes(file.path)) throw new SecurityError("security:package_duplicate_path", `Staged path ${file.path} is duplicated.`);
        paths.push(file.path);
        const destination = join(operationPath, file.path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const temporary = `${destination}.tmp-${process.pid}-${Date.now()}-${paths.length}`;
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(file.bytes); await handle.sync(); } finally { await handle.close(); }
        await this.fault("staging.stage.after_file_sync");
        await rename(temporary, destination);
        this.syncNamespace(dirname(destination), destination);
      }
      const firstInstalledFile = paths[0] ? join(operationPath, paths[0]) : undefined;
      this.syncNamespace(operationPath, firstInstalledFile);
      this.syncNamespace(this.stagingRoot, firstInstalledFile);
      await this.writeCatalog({ ...catalog, operations: { ...catalog.operations, [operationId]: { state: "staged", paths } } });
    } catch (error) {
      await rm(operationPath, { recursive: true, force: true });
      throw error;
    }
  }

  async markInterrupted(operationId: string): Promise<void> {
    const catalog = await this.readCatalog();
    const operation = catalog.operations[operationId];
    if (!operation) throw new SecurityError("security:staging_recovery_required", `Staging operation ${operationId} is missing.`);
    await this.writeCatalog({ ...catalog, operations: { ...catalog.operations, [operationId]: { ...operation, state: "interrupted" } } });
  }

  async commit(operationId: string): Promise<void> {
    const catalog = await this.readCatalog();
    const operation = catalog.operations[operationId];
    if (!operation || operation.state !== "staged") throw new SecurityError("security:staging_recovery_required", `Staging operation ${operationId} is not safely committable.`);
    const stagedPath = this.operationPath(this.stagingRoot, operationId);
    const stagedFile = operation.paths[0] ? join(stagedPath, operation.paths[0]) : undefined;
    this.syncNamespace(stagedPath, stagedFile);
    this.syncNamespace(this.stagingRoot, stagedFile);
    await this.writeCatalog({ ...catalog, operations: { ...catalog.operations, [operationId]: { ...operation, state: "publishing" } } });
    await this.fault("staging.commit.after_marker");
    const publishedPath = this.operationPath(this.publishedRoot, operationId);
    await rename(stagedPath, publishedPath);
    this.syncNamespace(this.publishedRoot, operation.paths[0] ? join(publishedPath, operation.paths[0]) : undefined);
    await this.fault("staging.commit.after_rename");
    await this.writeCatalog({ ...catalog, operations: { ...catalog.operations, [operationId]: { ...operation, state: "committed" } } });
  }

  async publish(operationId: string, publication: StagingPublication): Promise<void> {
    const catalog = await this.readCatalog();
    const operation = catalog.operations[operationId];
    if (!operation || operation.state !== "staged") throw new SecurityError("security:staging_recovery_required", `Staging operation ${operationId} is not safely publishable.`);
    const stagedPath = this.operationPath(this.stagingRoot, operationId);
    const stagedFile = operation.paths[0] ? join(stagedPath, operation.paths[0]) : undefined;
    this.syncNamespace(stagedPath, stagedFile);
    this.syncNamespace(this.stagingRoot, stagedFile);
    await this.writeCatalog({ ...catalog, operations: { ...catalog.operations, [operationId]: { ...operation, state: "publishing", publication } } });
    const publishedPath = this.operationPath(this.publishedRoot, operationId);
    await rename(stagedPath, publishedPath);
    this.syncNamespace(this.publishedRoot, operation.paths[0] ? join(publishedPath, operation.paths[0]) : undefined);
    await this.writeCatalog({ ...catalog, operations: { ...catalog.operations, [operationId]: { ...operation, state: "committed", publication } } });
  }

  async listPublications(): Promise<readonly StagingPublication[]> {
    const catalog = await this.readCatalog();
    return Object.values(catalog.operations).filter((operation) => operation.state === "committed" && operation.publication).map((operation) => operation.publication!);
  }

  async readPublishedFile(operationId: string, path: string): Promise<Uint8Array | undefined> {
    validateOperationId(operationId);
    validateStagedPath(path);
    try { return new Uint8Array(await readFile(join(this.operationPath(this.publishedRoot, operationId), path))); } catch { return undefined; }
  }

  async recover(operationId: string): Promise<RecoveryResult> {
    const catalog = await this.readCatalog();
    const operation = catalog.operations[operationId];
    if (!operation) return { state: "discarded", removed_paths: [] };
    if (operation.state === "committed") return { state: "committed", removed_paths: [] };
    if (operation.state === "publishing") {
      const publishedPath = this.operationPath(this.publishedRoot, operationId);
      if (await lstat(publishedPath).then(() => true).catch(() => false)) {
        await this.writeCatalog({ ...catalog, operations: { ...catalog.operations, [operationId]: { ...operation, state: "committed" } } });
        return { state: "committed", removed_paths: [] };
      }
    }
    await rm(this.operationPath(this.stagingRoot, operationId), { recursive: true, force: true });
    const operations = { ...catalog.operations };
    delete operations[operationId];
    await this.writeCatalog({ ...catalog, operations });
    return { state: "discarded", removed_paths: [...operation.paths].sort() };
  }

  async recoverAll(): Promise<readonly (RecoveryResult & { readonly operation_id: string })[]> {
    const catalog = await this.readCatalog();
    const remainingOperations: Record<string, CatalogOperation> = { ...catalog.operations };
    const results: Array<RecoveryResult & { readonly operation_id: string }> = [];
    for (const [operationId, operation] of Object.entries(catalog.operations)) if (operation.state !== "committed") {
      const result = await this.recover(operationId);
      results.push({ operation_id: operationId, ...result });
      if (result.state === "discarded") delete remainingOperations[operationId];
    }
    await this.ensureRoot();
    const retainedEntryNames = new Set(Object.keys(remainingOperations).map(stagingOperationEntryName));
    for (const entry of await readdir(this.stagingRoot, { withFileTypes: true })) if (entry.isDirectory() && !retainedEntryNames.has(entry.name)) await rm(join(this.stagingRoot, entry.name), { recursive: true, force: true });
    for (const entry of await readdir(this.publishedRoot, { withFileTypes: true })) if (entry.isDirectory() && !retainedEntryNames.has(entry.name)) await rm(join(this.publishedRoot, entry.name), { recursive: true, force: true });
    return results.sort((left, right) => left.operation_id.localeCompare(right.operation_id));
  }
}
