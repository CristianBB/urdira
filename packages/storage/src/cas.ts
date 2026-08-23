import { mkdir, open, readFile, rename, stat, unlink, link, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { digestBytes } from "@urdira/canonical";
import type { ContentBlob } from "@urdira/contracts";
import { timed } from "./debug-timing.js";
import { StorageError } from "./errors.js";
import type { ByteBoundaryTelemetry } from "./byte-telemetry.js";

export interface CasPutOptions {
  readonly content_hash?: string;
  readonly media_type?: string;
}

export interface CasPutStreamOptions extends CasPutOptions {
  readonly byte_length?: number;
  readonly telemetry?: ByteBoundaryTelemetry;
  /**
   * Optional provider-side boundary validation after CAS has computed the
   * authoritative digest. This lets a streaming provider avoid hashing the
   * same bytes a second time while retaining its post-read race check.
   */
  readonly after_read?: (contentHash: string, byteLength: number) => Promise<void>;
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
  readonly telemetry?: ByteBoundaryTelemetry;
  /** Maximum number of independent CAS writes in flight (default 16). */
  readonly put_concurrency?: number;
}

export interface CasPutManyEntry {
  readonly bytes: Uint8Array;
  readonly options?: CasPutOptions;
}

export interface CasPutStreamEntry {
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly options?: CasPutStreamOptions;
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

/**
 * A CAS object's path relative to its root, as individual join segments:
 * `["sha256", <2-hex-char shard>, <62-hex-char rest>]`. Single-level shard
 * (256 leaf directories) -- flattened from an earlier two-level layout
 * (65,536 leaf directories) because a from-zero index's `putStreamsMany`
 * batches dirty thousands of unique leaf directories at once, and the
 * per-batch directory-fsync dedup (see `putMany`/`putStreamsMany` above)
 * only coalesces well when a batch's blobs concentrate into few directories.
 * The only call site for this layout is `objectPath` below; every other
 * reader of a CAS path (including `packages/storage/src/lifecycle.ts`'s
 * backup/restore/repair paths) must go through `objectPath` or this helper
 * rather than reconstructing the shard math itself.
 */
export function casObjectRelativeParts(contentHash: string): readonly [string, string, string] {
  if (!/^sha256:[0-9a-f]{64}$/.test(contentHash)) throw new StorageError("storage:invalid_digest", "CAS paths require a lowercase SHA-256 digest.", { content_hash: contentHash });
  const hex = contentHash.slice("sha256:".length);
  return ["sha256", hex.slice(0, 2), hex.slice(2)];
}

/** Marker filename and content identifying a `cas/` directory's shard layout (docs/decisions/22's destructive-only migration policy: no in-place upgrade). */
export const CAS_LAYOUT_MARKER_FILENAME = ".layout";
export const CAS_LAYOUT_VERSION = "2";

/**
 * Atomically stamps a `cas/` directory (temp file + rename, so a concurrent
 * reader never observes a partially written marker) with the current shard
 * layout version. Called once for a fresh CAS root (`DurableStorage.open`)
 * and once per backup/restore staging `cas/` tree (`lifecycle.ts`), which is
 * always written in the current layout regardless of the source backup's age.
 */
export async function writeCasLayoutMarker(casDir: string): Promise<void> {
  const marker = join(casDir, CAS_LAYOUT_MARKER_FILENAME);
  const temporary = join(casDir, `.layout.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await writeFile(temporary, CAS_LAYOUT_VERSION, "utf8");
  await rename(temporary, marker);
}

export class ContentAddressedStore {
  readonly rootDir: string;
  private readonly writeMetadata: CasMetadataWriter | undefined;
  private readonly writeMetadataBatch: CasMetadataBatchWriter | undefined;
  private readonly syncDirectoryHook: (directory: string) => Promise<void>;
  private readonly syncFileHook: (path: string) => Promise<void>;
  private readonly platform: NodeJS.Platform;
  private readonly telemetry: ByteBoundaryTelemetry | undefined;
  private readonly putConcurrency: number;

  constructor(rootDir: string, writeMetadata?: CasMetadataWriter, hooks: CasFilesystemHooks = {}, writeMetadataBatch?: CasMetadataBatchWriter) {
    this.rootDir = rootDir;
    this.writeMetadata = writeMetadata;
    this.writeMetadataBatch = writeMetadataBatch;
    this.syncDirectoryHook = hooks.sync_directory ?? ((directory) => this.syncDirectory(directory));
    this.syncFileHook = hooks.sync_file ?? ((path) => this.syncFile(path));
    this.platform = hooks.platform ?? process.platform;
    this.telemetry = hooks.telemetry;
    this.putConcurrency = Math.max(1, Math.min(Math.trunc(hooks.put_concurrency ?? DEFAULT_PUT_CONCURRENCY) || DEFAULT_PUT_CONCURRENCY, 256));
  }

  async put(bytes: Uint8Array, options: CasPutOptions = {}): Promise<ContentBlob> {
    this.telemetry?.add("cas", { read: bytes.byteLength, copied: bytes.byteLength });
    const [blob] = await this.putMany([{ bytes, options }]);
    return blob as ContentBlob;
  }

  /** Consume a source stream once while hashing and writing the CAS object. */
  async putStream(chunks: AsyncIterable<Uint8Array>, options: CasPutStreamOptions = {}): Promise<ContentBlob> {
    const [blob] = await this.putStreamsMany([{ chunks, options }]);
    return blob as ContentBlob;
  }

  /**
   * Stream counterpart of `putMany`: every stream retains the same private
   * temp-file, hash, atomic-link, and collision-verification sequence as
   * `putStream`, while independent streams run with bounded concurrency. Each
   * blob's sequence is now write -> link -> (batched) fsync files ->
   * (batched) fsync directories -- see `putMany`'s doc comment for why the
   * per-blob file fsync moved out of this loop and into a batched pass, and
   * why that doesn't change the durability boundary a caller can observe.
   * Namespace fsyncs and installation-catalog metadata are coalesced only
   * after all stream bytes are durable, so a resolved call has the identical
   * crash boundary without one SQLite commit per source file.
   */
  async putStreamsMany(entries: readonly CasPutStreamEntry[]): Promise<ContentBlob[]> {
    if (entries.length === 0) return [];
    const installed = await mapWithConcurrency(entries, this.putConcurrency, async (entry) => {
      const options = entry.options ?? {};
      const temporary = join(this.rootDir, ".tmp", `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      await mkdir(dirname(temporary), { recursive: true });
      const hash = createHash("sha256");
      let byteLength = 0;
      const handle = await open(temporary, "wx", 0o600);
      try {
        for await (const chunk of entry.chunks) {
          if (!(chunk instanceof Uint8Array)) throw new StorageError("storage:cas_stream_invalid", "CAS streams must yield Uint8Array chunks.");
          hash.update(chunk); byteLength += chunk.byteLength;
          options.telemetry?.add("cas", { read: chunk.byteLength });
          this.telemetry?.add("cas", { read: chunk.byteLength });
          if (options.byte_length !== undefined && byteLength > options.byte_length) throw new StorageError("storage:cas_stream_length_mismatch", "CAS stream exceeded its declared length.", { expected_length: options.byte_length, actual_length: byteLength });
          await handle.write(chunk);
        }
        // No per-blob `handle.sync()` here anymore -- see the batched file-fsync
        // pass below (after this install loop resolves, before the directory-fsync
        // pass) and its doc comment for why deferring is both faster and still
        // durable by the time this whole call resolves.
        await handle.close();
        const actualHash = `sha256:${hash.digest("hex")}`;
        if (options.byte_length !== undefined && byteLength !== options.byte_length) throw new StorageError("storage:cas_stream_length_mismatch", "CAS stream length did not match its declaration.", { expected_length: options.byte_length, actual_length: byteLength });
        if (options.content_hash !== undefined && options.content_hash !== actualHash) throw new StorageError("storage:cas_collision", "The supplied CAS digest does not match the streamed bytes.", { expected: options.content_hash, actual: actualHash });
        if (options.after_read !== undefined) await options.after_read(actualHash, byteLength);
        const destination = this.objectPath(actualHash);
        await mkdir(dirname(destination), { recursive: true });
        let isNew = true;
        try { await link(temporary, destination); }
        catch (error) {
          if (!isAlreadyExists(error)) throw error;
          isNew = false;
          await this.verifyExisting(destination, actualHash, byteLength);
        }
        await unlink(temporary).catch(() => undefined);
        return {
          blob: { content_blob_id: actualHash, content_hash: actualHash, byte_length: byteLength, storage_reference: `cas:${actualHash}` } satisfies ContentBlob,
          destination,
          isNew,
          media_type: options.media_type,
        };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
    const freshDestinations = [...new Set(installed.filter((entry) => entry.isNew).map((entry) => entry.destination))];
    if (this.platform === "win32") {
      // Already a deferred, batched per-file sync pass (Windows has no
      // directory-fsync equivalent -- see `putMany`'s doc comment).
      await mapWithConcurrency(freshDestinations, this.putConcurrency, async (path) => {
        try { await timed("cas_file_fsync", () => this.syncFileHook(path)); }
        catch (error) { throw new StorageError("storage:cas_directory_sync_failed", "The installed CAS object could not be durably synchronized.", { directory: dirname(path), cause: error instanceof Error ? error.message : String(error) }); }
      });
    } else {
      // Batched file-fsync pass, deferred from the per-blob install loop
      // above -- see `putMany`'s doc comment for the measured win and why
      // this MUST run before the directory-fsync pass below (a dirent must
      // not be journaled durable before the file content it names is).
      await mapWithConcurrency(freshDestinations, this.putConcurrency, async (path) => {
        try { await timed("cas_file_fsync", () => this.syncFileHook(path)); }
        catch (error) { throw new StorageError("storage:cas_directory_sync_failed", "The installed CAS object could not be durably synchronized.", { directory: dirname(path), cause: error instanceof Error ? error.message : String(error) }); }
      });
      const dirtyDirectories = [...new Set(freshDestinations.map((destination) => dirname(destination)))];
      await mapWithConcurrency(dirtyDirectories, this.putConcurrency, async (directory) => {
        try { await timed("cas_dir_fsync", () => this.syncDirectoryHook(directory)); }
        catch (error) { throw new StorageError("storage:cas_directory_sync_failed", "The CAS directory could not be durably synchronized.", { directory, cause: error instanceof Error ? error.message : String(error) }); }
      });
    }
    const blobs = installed.map((entry) => entry.blob);
    if (this.writeMetadataBatch) {
      await timed("cas_metadata_batch", () => this.writeMetadataBatch!(installed.map((entry) => entry.media_type === undefined ? { blob: entry.blob } : { blob: entry.blob, media_type: entry.media_type })));
    } else if (this.writeMetadata) {
      for (const entry of installed) await this.writeMetadata(entry.blob, entry.media_type);
    }
    return blobs;
  }

  /**
   * Writes many blobs, each through the exact same durable per-blob sequence
   * `put` uses (private temp file -> write -> atomically link into place ->
   * durably flush the file -> durably flush the installed namespace entry --
   * see the class doc above and docs/decisions/05-storage-projection-architecture.md's
   * "Content-addressed storage" section for why that ordering is required),
   * but with three differences that only change *when* work happens, never
   * the durability ordering a caller can observe once this resolves:
   *
   * 1. Different blobs' write/link sequences run concurrently (bounded by
   *    `DEFAULT_PUT_CONCURRENCY`) instead of strictly serialized. This is
   *    safe because each blob's own sequence is self-contained (a private
   *    temp file, then a link into a path determined only by that blob's own
   *    digest); two different blobs never touch the same temp file or
   *    destination path, and two equal blobs (duplicate content within one
   *    call) safely race the same way concurrent `put` calls already would
   *    (whichever links first wins, the other observes EEXIST and verifies
   *    the winner's bytes).
   * 2. Each blob's own file fsync is DEFERRED out of the per-blob install
   *    loop and into a single batched pass afterward (still POSIX-only; see
   *    below), which runs BEFORE the directory-fsync pass so a dirent is
   *    never journaled durable before the file content it names is. This is
   *    purely a scheduling change, not a durability change: a resolved call
   *    still guarantees every fresh blob's bytes are fsync'd before the call
   *    returns, exactly as interleaved per-blob fsyncs did. It exists because
   *    a local measurement (2,000 x 12KB files, concurrency 16, APFS) found
   *    write+fsync interleaved per file costs ~11.6s, versus ~0.85s for
   *    write+close-all then a separate fsync pass over the same files
   *    afterward -- same number of fsync syscalls either way, but APFS's
   *    journal batches them ~12-25x more cheaply when they all arrive
   *    together instead of each serializing its own journal transaction
   *    between interleaved writes. POSIX directory fsyncs are additionally
   *    coalesced, same as before: every blob that actually created a new
   *    directory entry (a fresh `link`, not an EEXIST hit against
   *    already-durable content) contributes its destination directory to a
   *    per-batch set, deduplicated and fsync'd once each afterward -- not
   *    once per blob -- since a directory's fsync only needs to happen once
   *    to make every entry linked into it so far durable, and a blob that hit
   *    EEXIST added no new entry for this directory to begin with.
   * 3. The installation-catalog metadata write (`writeMetadata`, one row
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
   * only issues after this whole call resolves -- and that commit happens
   * strictly after this call's own batched file-fsync and directory-fsync
   * passes have both completed, so the deferral in (2) never lets an
   * unsynced blob become reachable. Any temp files or linked-but-
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
    // A source scan can contain the same bytes many times (generated files,
    // vendored declarations, or identical package fixtures).  The result
    // still has one reference per input, but only the first occurrence needs
    // a temp file, file fsync, link, and collision verification.  Previously
    // duplicate entries raced through the full durable path and were only
    // coalesced later for directory fsync/metadata, wasting the dominant CAS
    // work while preserving no additional durability.
    const uniquePrepared: typeof prepared = [];
    const uniqueByHash = new Set<string>();
    for (const item of prepared) {
      if (uniqueByHash.has(item.actualHash)) continue;
      uniqueByHash.add(item.actualHash);
      uniquePrepared.push(item);
    }
    const linkedNew = await mapWithConcurrency(uniquePrepared, this.putConcurrency, async (item) => {
      await mkdir(dirname(item.destination), { recursive: true });
      const temporary = join(this.rootDir, ".tmp", `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      await mkdir(dirname(temporary), { recursive: true });
      const handle = await open(temporary, "wx", 0o600);
      try {
        await timed("cas_file_write", () => handle.write(item.copy));
        // No per-blob `handle.sync()` here anymore -- see the batched
        // file-fsync pass below (point 2 in this method's doc comment).
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
    const freshDestinations = [...new Set(uniquePrepared.filter((_item, index) => linkedNew[index]).map((item) => item.destination))];
    if (this.platform === "win32") {
      // Node opens Windows directories without the FILE_FLAG_BACKUP_SEMANTICS
      // handle required for FlushFileBuffers, so FileHandle.sync() returns
      // EPERM. Reopen each newly installed hard link with write access and
      // flush that file handle instead; Windows associates the link metadata
      // with the file and FlushFileBuffers durably commits its cached metadata.
      await mapWithConcurrency(freshDestinations, this.putConcurrency, async (path) => {
        try {
          await timed("cas_file_fsync", () => this.syncFileHook(path));
        } catch (error) {
          throw new StorageError("storage:cas_directory_sync_failed", "The installed CAS object could not be durably synchronized.", { directory: dirname(path), cause: error instanceof Error ? error.message : String(error) });
        }
      });
    } else {
      // Batched file-fsync pass, deferred from the per-blob install loop
      // above (point 2 in this method's doc comment): every freshly linked
      // destination gets exactly one fsync here, all of them completing
      // before the directory-fsync pass below starts -- a dirent must not be
      // journaled durable before the file content it names is. EEXIST-hit
      // blobs (`isNew` false, so excluded from `freshDestinations`) need no
      // fsync here; their bytes were already made durable by whichever
      // earlier call first linked them.
      await mapWithConcurrency(freshDestinations, this.putConcurrency, async (path) => {
        try {
          await timed("cas_file_fsync", () => this.syncFileHook(path));
        } catch (error) {
          throw new StorageError("storage:cas_directory_sync_failed", "The installed CAS object could not be durably synchronized.", { directory: dirname(path), cause: error instanceof Error ? error.message : String(error) });
        }
      });
      // Coalesced directory durability: only directories that received at
      // least one fresh link this batch need fsyncing, and each needs it only
      // once regardless of how many of this batch's blobs landed in it.
      const dirtyDirectories = [...new Set(freshDestinations.map((destination) => dirname(destination)))];
      await mapWithConcurrency(dirtyDirectories, this.putConcurrency, async (directory) => {
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
    return join(this.rootDir, ...casObjectRelativeParts(contentHash));
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
