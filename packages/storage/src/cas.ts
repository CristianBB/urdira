import { mkdir, open, readFile, stat, unlink, link } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digestBytes } from "@urdira/canonical";
import type { ContentBlob } from "@urdira/contracts";
import { timed } from "./debug-timing.js";
import { StorageError } from "./errors.js";

export interface CasPutOptions {
  readonly content_hash?: string;
  readonly media_type?: string;
}

export type BlobReference =
  | { readonly storage: "inline"; readonly content_hash: string; readonly byte_length: number; readonly bytes: Uint8Array }
  | { readonly storage: "cas"; readonly content_hash: string; readonly byte_length: number; readonly storage_reference: string };

export type CasMetadataWriter = (blob: ContentBlob, mediaType?: string) => Promise<void>;
export type CasMetadataBatchWriter = (entries: readonly { readonly blob: ContentBlob; readonly media_type?: string }[]) => Promise<void>;

export interface CasFilesystemHooks {
  readonly sync_directory?: (directory: string) => Promise<void>;
  readonly sync_file?: (path: string) => Promise<void>;
  readonly platform?: NodeJS.Platform;
}

export interface CasPutManyEntry {
  readonly bytes: Uint8Array;
  readonly options?: CasPutOptions;
}

// Bounded concurrency for `putMany`'s per-blob filesystem work (temp-file
// write+fsync, link, namespace flush): each blob's own write/fsync/link
// sequence is unchanged from `put` (see `putMany` below for why that
// ordering is still exactly preserved per blob), so this only lets multiple
// blobs' independent fsync syscalls be in flight at once instead of strictly
// serialized -- matching the read-side concurrency default used elsewhere
// (`DEFAULT_READ_CONCURRENCY` in `packages/engine/src/source-indexer.ts`).
const DEFAULT_PUT_CONCURRENCY = 16;

/**
 * Maps `items` through `fn` with at most `limit` calls in flight at once,
 * preserving `items`' order in the returned array. Local, minimal copy of
 * `packages/engine/src/concurrency.ts`'s `mapWithConcurrency`: `@urdira/storage`
 * is a lower architecture layer than `@urdira/engine`
 * (`architecture/manifest.json`) and cannot depend on it.
 */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: boundedLimit }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class ContentAddressedStore {
  readonly rootDir: string;
  private readonly writeMetadata: CasMetadataWriter | undefined;
  private readonly writeMetadataBatch: CasMetadataBatchWriter | undefined;
  private readonly syncDirectoryHook: (directory: string) => Promise<void>;
  private readonly syncFileHook: (path: string) => Promise<void>;
  private readonly platform: NodeJS.Platform;

  constructor(rootDir: string, writeMetadata?: CasMetadataWriter, hooks: CasFilesystemHooks = {}, writeMetadataBatch?: CasMetadataBatchWriter) {
    this.rootDir = rootDir;
    this.writeMetadata = writeMetadata;
    this.writeMetadataBatch = writeMetadataBatch;
    this.syncDirectoryHook = hooks.sync_directory ?? ((directory) => this.syncDirectory(directory));
    this.syncFileHook = hooks.sync_file ?? ((path) => this.syncFile(path));
    this.platform = hooks.platform ?? process.platform;
  }

  async put(bytes: Uint8Array, options: CasPutOptions = {}): Promise<ContentBlob> {
    const [blob] = await this.putMany([{ bytes, options }]);
    return blob as ContentBlob;
  }

  /**
   * Writes many blobs, each through the exact same durable per-blob sequence
   * `put` uses (private temp file -> write -> fsync the file -> atomically
   * link into place -> durably flush the installed namespace entry -- see
   * the class doc
   * above and docs/decisions/05-storage-projection-architecture.md's
   * "Content-addressed storage" section for why that per-blob ordering is
   * required), but with two differences that only change *when* work
   * happens, never the durability ordering a caller can observe once this
   * resolves:
   *
   * 1. Different blobs' write/fsync/link sequences run concurrently
   *    (bounded by `DEFAULT_PUT_CONCURRENCY`) instead of strictly
   *    serialized. This is safe because each blob's own sequence is
   *    self-contained (a private temp file, then a link into a path
   *    determined only by that blob's own digest); two different blobs
   *    never touch the same temp file or destination path, and two equal
   *    blobs (duplicate content within one call) safely race the same way
   *    concurrent `put` calls already would (whichever links first wins,
   *    the other observes EEXIST and verifies the winner's bytes).
   *    POSIX directory fsyncs are additionally coalesced: every blob that
   *    actually created a new directory entry (a fresh `link`, not an
   *    EEXIST hit against already-durable content) contributes its
   *    destination directory to a per-batch set, deduplicated and fsync'd
   *    once each afterward -- not once per blob -- since a directory's
   *    fsync only needs to happen once to make every entry linked into it
   *    so far durable, and a blob that hit EEXIST added no new entry for
   *    this directory to begin with.
   * 2. The installation-catalog metadata write (`writeMetadata`, one row
   *    per blob) is coalesced into a single batched call
   *    (`writeMetadataBatch`, when the caller supplied one) after every
   *    blob's file and namespace flush has completed, instead of one
   *    metadata write per blob interleaved with its own fsyncs. This is
   *    still ordered correctly with respect to durability: every blob's
   *    bytes and installed namespace entry are flushed *before* any metadata row
   *    referencing it is written, exactly as `put` guarantees for a single
   *    blob -- only the metadata commit itself is now one write covering
   *    the whole batch instead of N separate commits.
   *
   * This is safe under this system's crash-recovery contract
   * (docs/decisions/04-workspace-snapshot-incremental-indexing.md's
   * "Interrupted indexing recovery"): a scan interrupted anywhere in this
   * batch is never left half-visible to a reader, because nothing in the
   * batch is referenced by the workspace's SQLite source-catalog transaction
   * until that transaction's own commit, which the caller (`WorkspaceSourceIndexRepository.commitInternal`)
   * only issues after this whole call resolves. Any temp files or linked-but-
   * unreferenced CAS objects left by a crash mid-batch are harmless orphans:
   * CAS is content-addressed, so they are either reused (identical digest)
   * or garbage-collected, never treated as authoritative on their own.
   */
  async putMany(entries: readonly CasPutManyEntry[]): Promise<ContentBlob[]> {
    if (entries.length === 0) return [];
    const prepared = entries.map((entry) => {
      const copy = new Uint8Array(entry.bytes);
      const actualHash = digestBytes(copy);
      if (entry.options?.content_hash !== undefined && entry.options.content_hash !== actualHash) {
        throw new StorageError("storage:cas_collision", "The supplied CAS digest does not match the bytes.", { expected: entry.options.content_hash, actual: actualHash });
      }
      return { copy, actualHash, media_type: entry.options?.media_type, destination: this.objectPath(actualHash) };
    });
    const linkedNew = await mapWithConcurrency(prepared, DEFAULT_PUT_CONCURRENCY, async (item) => {
      await mkdir(dirname(item.destination), { recursive: true });
      const temporary = join(this.rootDir, ".tmp", `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      await mkdir(dirname(temporary), { recursive: true });
      const handle = await open(temporary, "wx", 0o600);
      try {
        await timed("cas_file_write", () => handle.write(item.copy));
        await timed("cas_file_fsync", () => handle.sync());
      } finally {
        await handle.close();
      }
      let isNew = true;
      try {
        await timed("cas_link", () => link(temporary, item.destination));
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        isNew = false;
        await unlink(temporary).catch(() => undefined);
        await timed("cas_verify_existing", () => this.verifyExisting(item.destination, item.actualHash, item.copy.byteLength));
      }
      await unlink(temporary).catch(() => undefined);
      return isNew;
    });
    const freshDestinations = [...new Set(prepared.filter((_item, index) => linkedNew[index]).map((item) => item.destination))];
    if (this.platform === "win32") {
      // Node opens Windows directories without the FILE_FLAG_BACKUP_SEMANTICS
      // handle required for FlushFileBuffers, so FileHandle.sync() returns
      // EPERM. Reopen each newly installed hard link with write access and
      // flush that file handle instead; Windows associates the link metadata
      // with the file and FlushFileBuffers durably commits its cached metadata.
      await mapWithConcurrency(freshDestinations, DEFAULT_PUT_CONCURRENCY, async (path) => {
        try {
          await timed("cas_file_fsync", () => this.syncFileHook(path));
        } catch (error) {
          throw new StorageError("storage:cas_directory_sync_failed", "The installed CAS object could not be durably synchronized.", { directory: dirname(path), cause: error instanceof Error ? error.message : String(error) });
        }
      });
    } else {
      // Coalesced directory durability: only directories that received at
      // least one fresh link this batch need fsyncing, and each needs it only
      // once regardless of how many of this batch's blobs landed in it.
      const dirtyDirectories = [...new Set(freshDestinations.map((destination) => dirname(destination)))];
      await mapWithConcurrency(dirtyDirectories, DEFAULT_PUT_CONCURRENCY, async (directory) => {
        try {
          await timed("cas_dir_fsync", () => this.syncDirectoryHook(directory));
        } catch (error) {
          throw new StorageError("storage:cas_directory_sync_failed", "The CAS directory could not be durably synchronized.", { directory, cause: error instanceof Error ? error.message : String(error) });
        }
      });
    }
    const blobs = prepared.map((item): ContentBlob => ({
      content_blob_id: item.actualHash,
      content_hash: item.actualHash,
      byte_length: item.copy.byteLength,
      storage_reference: `cas:${item.actualHash}`,
    }));
    if (this.writeMetadataBatch) {
      await timed("cas_metadata_batch", () => this.writeMetadataBatch!(blobs.map((blob, index) => {
        const mediaType = prepared[index]?.media_type;
        return mediaType === undefined ? { blob } : { blob, media_type: mediaType };
      })));
    } else if (this.writeMetadata) {
      for (let index = 0; index < blobs.length; index += 1) await this.writeMetadata(blobs[index] as ContentBlob, prepared[index]?.media_type);
    }
    return blobs;
  }

  async read(contentHash: string): Promise<Uint8Array> {
    const destination = this.objectPath(contentHash);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(destination));
    } catch (error) {
      throw new StorageError("storage:cas_missing", `CAS object ${contentHash} is missing.`, { content_hash: contentHash, cause: error instanceof Error ? error.message : String(error) });
    }
    const actual = digestBytes(bytes);
    if (actual !== contentHash) throw new StorageError("storage:cas_corrupt", `CAS object ${contentHash} failed digest verification.`, { content_hash: contentHash, actual });
    return bytes;
  }

  async has(contentHash: string): Promise<boolean> {
    try {
      await this.verifyExisting(this.objectPath(contentHash), contentHash);
      return true;
    } catch (error) {
      if (error instanceof StorageError && error.code === "storage:cas_missing") return false;
      throw error;
    }
  }

  objectPath(contentHash: string): string {
    if (!/^sha256:[0-9a-f]{64}$/.test(contentHash)) throw new StorageError("storage:invalid_digest", "CAS paths require a lowercase SHA-256 digest.", { content_hash: contentHash });
    const hex = contentHash.slice("sha256:".length);
    return join(this.rootDir, "sha256", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  }

  private async verifyExisting(destination: string, expectedHash: string, expectedLength?: number): Promise<void> {
    let metadata;
    try {
      metadata = await stat(destination);
    } catch (error) {
      throw new StorageError("storage:cas_missing", `CAS object ${expectedHash} is missing.`, { content_hash: expectedHash, cause: error instanceof Error ? error.message : String(error) });
    }
    if (expectedLength !== undefined && metadata.size !== expectedLength) throw new StorageError("storage:cas_collision", `CAS object ${expectedHash} has a conflicting length.`, { content_hash: expectedHash, expected_length: expectedLength, actual_length: metadata.size });
    const bytes = new Uint8Array(await readFile(destination));
    const actual = digestBytes(bytes);
    if (actual !== expectedHash) throw new StorageError("storage:cas_collision", `CAS object ${expectedHash} contains conflicting bytes.`, { content_hash: expectedHash, actual });
  }

  private async syncDirectory(directory: string): Promise<void> {
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  }

  private async syncFile(path: string): Promise<void> {
    const fileHandle = await open(path, "r+");
    try { await fileHandle.sync(); } finally { await fileHandle.close(); }
  }
}

export class BlobStore {
  readonly inlineThresholdBytes: number;
  readonly cas: ContentAddressedStore;

  constructor(cas: ContentAddressedStore, inlineThresholdBytes: number) {
    if (!Number.isSafeInteger(inlineThresholdBytes) || inlineThresholdBytes < 0) throw new StorageError("storage:invalid_inline_threshold", "Inline threshold must be a non-negative safe integer.");
    this.cas = cas;
    this.inlineThresholdBytes = inlineThresholdBytes;
  }

  async place(bytes: Uint8Array, options: CasPutOptions = {}): Promise<BlobReference> {
    const copy = new Uint8Array(bytes);
    const contentHash = digestBytes(copy);
    if (options.content_hash !== undefined && options.content_hash !== contentHash) throw new StorageError("storage:cas_collision", "The supplied blob digest does not match the bytes.", { expected: options.content_hash, actual: contentHash });
    if (copy.byteLength <= this.inlineThresholdBytes) return { storage: "inline", content_hash: contentHash, byte_length: copy.byteLength, bytes: copy };
    const blob = await this.cas.put(copy, options);
    return { storage: "cas", content_hash: blob.content_hash, byte_length: blob.byte_length, storage_reference: blob.storage_reference };
  }

  async read(reference: BlobReference): Promise<Uint8Array> {
    if (reference.storage === "inline") {
      const actual = digestBytes(reference.bytes);
      if (actual !== reference.content_hash || reference.byte_length !== reference.bytes.byteLength) throw new StorageError("storage:blob_corrupt", "Inline blob metadata does not match its bytes.");
      return new Uint8Array(reference.bytes);
    }
    if (reference.storage_reference !== `cas:${reference.content_hash}`) throw new StorageError("storage:invalid_storage_reference", "Blob storage reference does not match its content digest.");
    return await this.cas.read(reference.content_hash);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
