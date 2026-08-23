import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContentAddressedStore } from "../packages/storage/src/index.js";

describe("CAS stream ingestion", () => {
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
