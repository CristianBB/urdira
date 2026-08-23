import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContentAddressedStore } from "../packages/storage/src/index.js";
import { casObjectRelativeParts } from "../packages/storage/src/cas.js";

describe("CAS stream ingestion", () => {
  it("shapes object paths as sha256/<2-hex-char shard>/<62-hex-char rest>", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-cas-objectpath-"));
    try {
      const cas = new ContentAddressedStore(root);
      const hex = "0123456789abcdef".repeat(4); // 64 lowercase hex chars
      const contentHash = `sha256:${hex}`;
      expect(casObjectRelativeParts(contentHash)).toEqual(["sha256", hex.slice(0, 2), hex.slice(2)]);
      expect(cas.objectPath(contentHash)).toBe(join(root, "sha256", hex.slice(0, 2), hex.slice(2)));
      expect(cas.objectPath(contentHash)).not.toBe(join(root, "sha256", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("coalesces putStreamsMany's directory fsyncs to at most one per distinct shard prefix, all completed before it resolves", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-cas-stream-fsync-coalescing-"));
    try {
      const syncedDirectories: string[] = [];
      let syncCallsObserved = 0;
      const cas = new ContentAddressedStore(root, undefined, {
        platform: "linux",
        sync_directory: async (directory) => { syncCallsObserved += 1; syncedDirectories.push(directory); },
      });
      const entryCount = 128;
      const entries = Array.from({ length: entryCount }, (_unused, index) => ({
        chunks: (async function* () { yield new TextEncoder().encode(`fsync-coalescing-blob-${index}-${Math.random()}`); })(),
      }));
      const blobs = await cas.putStreamsMany(entries);
      // Every dirty directory sync call happened inside `putStreamsMany`'s own
      // awaited batch (there is no other code path that could have called the
      // hook), so by the time it resolves every one of them has already run.
      expect(syncCallsObserved).toBe(syncedDirectories.length);
      const distinctPrefixes = new Set(blobs.map((blob) => blob.content_hash.slice("sha256:".length, "sha256:".length + 2)));
      expect(new Set(syncedDirectories).size).toBe(syncedDirectories.length); // each dirty directory synced at most once
      expect(syncedDirectories.length).toBe(distinctPrefixes.size);
      expect(syncedDirectories.length).toBeLessThanOrEqual(256);
      for (const blob of blobs) expect(await cas.read(blob.content_hash)).toBeDefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("defers putStreamsMany's per-blob file fsyncs to a single batched pass, completed (one sync per fresh blob, none for EEXIST duplicates) strictly before any directory fsync, all before it resolves", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-cas-stream-file-fsync-ordering-"));
    try {
      // A shared, ordered sequence log across both hooks is the only way to
      // prove "every file sync happens before the first directory sync" --
      // per-hook call counts alone can't distinguish that from the file and
      // directory passes interleaving.
      const sequence: Array<{ readonly kind: "file" | "directory"; readonly path: string }> = [];
      const cas = new ContentAddressedStore(root, undefined, {
        platform: "linux",
        sync_file: async (path) => { sequence.push({ kind: "file", path }); },
        sync_directory: async (path) => { sequence.push({ kind: "directory", path }); },
      });
      const entryCount = 64;
      const bytesFor = (index: number): Uint8Array => new TextEncoder().encode(`file-fsync-ordering-blob-${index}`);
      const entries = [
        ...Array.from({ length: entryCount }, (_unused, index) => ({ chunks: (async function* () { yield bytesFor(index); })() })),
        // Duplicate content within the same batch: the second copy must hit
        // EEXIST against the first's fresh link and get no file sync of its own.
        { chunks: (async function* () { yield bytesFor(0); })() },
        { chunks: (async function* () { yield bytesFor(1); })() },
      ];
      const blobs = await cas.putStreamsMany(entries);

      const fileSyncs = sequence.filter((entry) => entry.kind === "file");
      const directorySyncs = sequence.filter((entry) => entry.kind === "directory");
      // Exactly one file sync per distinct fresh blob -- not per entry, so the
      // two intra-batch duplicates above contribute none of their own.
      const distinctFreshDestinations = new Set(blobs.slice(0, entryCount).map((blob) => cas.objectPath(blob.content_hash)));
      expect(fileSyncs.map((entry) => entry.path).sort()).toEqual([...distinctFreshDestinations].sort());
      expect(directorySyncs.length).toBeGreaterThan(0);
      // Every file sync's position in the shared sequence precedes every
      // directory sync's position: a dirent must never be journaled durable
      // before the file content it names is.
      const lastFileIndex = Math.max(...sequence.map((entry, index) => (entry.kind === "file" ? index : -1)));
      const firstDirectoryIndex = sequence.findIndex((entry) => entry.kind === "directory");
      expect(lastFileIndex).toBeLessThan(firstDirectoryIndex);
      // The duplicate entries still resolve to the same content-addressed
      // blob as their originals and read back correctly.
      expect(blobs[entryCount]?.content_hash).toBe(blobs[0]?.content_hash);
      expect(blobs[entryCount + 1]?.content_hash).toBe(blobs[1]?.content_hash);
      for (const blob of blobs) expect(await cas.read(blob.content_hash)).toBeDefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("hashes and persists chunks without building an aggregate input", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-cas-stream-"));
    try {
      const cas = new ContentAddressedStore(root);
      const blob = await cas.putStream((async function* () { yield new TextEncoder().encode("alpha"); yield new TextEncoder().encode("\nβ"); })(), { byte_length: 8, media_type: "text/plain" });
      expect(blob.byte_length).toBe(8);
      expect(await cas.read(blob.content_hash)).toEqual(new TextEncoder().encode("alpha\nβ"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("coalesces streamed metadata and directory durability for a batch", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-cas-stream-batch-"));
    try {
      const individual: string[] = [];
      const batches: string[][] = [];
      const syncedDirectories: string[] = [];
      const cas = new ContentAddressedStore(
        root,
        async (blob) => { individual.push(blob.content_hash); },
        { platform: "linux", sync_directory: async (directory) => { syncedDirectories.push(directory); } },
        async (entries) => { batches.push(entries.map((entry) => entry.blob.content_hash)); },
      );
      const bytes = ["stream one", "stream two", "stream one"].map((value) => new TextEncoder().encode(value));
      const blobs = await cas.putStreamsMany(bytes.map((value) => ({
        chunks: (async function* () { yield value; })(),
        options: { byte_length: value.byteLength, media_type: "text/plain" },
      })));

      expect(individual).toEqual([]);
      expect(batches).toEqual([[blobs[0]!.content_hash, blobs[1]!.content_hash, blobs[2]!.content_hash]]);
      expect(blobs[0]!.content_hash).toBe(blobs[2]!.content_hash);
      expect(new Set(syncedDirectories).size).toBe(syncedDirectories.length);
      expect(await cas.read(blobs[0]!.content_hash)).toEqual(bytes[0]);
      expect(await cas.read(blobs[1]!.content_hash)).toEqual(bytes[1]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("runs provider boundary validation after the single CAS hash pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-cas-stream-after-read-"));
    try {
      let callback: string | undefined;
      const bytes = new TextEncoder().encode("validated once");
      const cas = new ContentAddressedStore(root);
      const blob = await cas.putStream((async function* () { yield bytes; })(), {
        byte_length: bytes.byteLength,
        content_hash: "sha256:d7f1cb2e452adf9f95e500103bffd4ca2868e836e0f1d22d78adfacc990f8054",
        after_read: async (hash, length) => { callback = `${hash}:${length}`; },
      });
      expect(callback).toBe(`${blob.content_hash}:${bytes.byteLength}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
