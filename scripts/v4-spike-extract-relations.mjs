#!/usr/bin/env node
// v4 P0-S1 spike helper: streams relation-record bodies out of a v3 workspace
// SQLite file, decodes each canonical UCE body_payload with
// @urdira/canonical's decodeCanonical, and writes a small binary file
// carrying just (record_id, source_id text, target_id text) for every
// relation record. The Rust spike (crates/urdira-v4-spike) has no canonical
// decoder available, so this is the documented fallback path from the task
// brief: "write a small Node preprocessing script ... that streams
// record_id, source_id, target_id, classification for relation records".
//
// classification is decoded but NOT written to the output file: nothing in
// the v4 DDL under test stores it, and the Rust side only needs the two
// subject-id strings to compute source_subject/target_subject ordinals
// (sha256 of the subject id text, per the task brief). Skipping it avoids
// widening every relation row for no consumer.
//
// Usage:
//   node scripts/v4-spike-extract-relations.mjs <db-path> <out-path>
//
// Output format (little-endian):
//   u32 row_count
//   repeated row_count times:
//     32 bytes   record_id (hex-decoded from the "record:<64 hex>" text form)
//     u32        source_id byte length, then that many UTF-8 bytes
//     u32        target_id byte length, then that many UTF-8 bytes

import { DatabaseSync } from "node:sqlite";
import { decodeCanonical } from "../packages/canonical/dist/index.js";
import { openSync, writeSync, closeSync, ftruncateSync } from "node:fs";
import { Buffer } from "node:buffer";

const [, , dbPath, outPath] = process.argv;
if (!dbPath || !outPath) {
  console.error("usage: v4-spike-extract-relations.mjs <db-path> <out-path>");
  process.exit(1);
}

function recordIdToBytes(recordId) {
  const prefix = "record:";
  if (!recordId.startsWith(prefix)) {
    throw new Error(`unexpected record_id shape: ${recordId}`);
  }
  const hex = recordId.slice(prefix.length);
  if (hex.length !== 64) {
    throw new Error(`unexpected record_id hex length ${hex.length}: ${recordId}`);
  }
  return Buffer.from(hex, "hex");
}

const started = Date.now();
const db = new DatabaseSync(dbPath, { readOnly: true });
const countRow = db.prepare("select count(*) c from record_occurrences where category = 'relation'").get();
const total = Number(countRow.c);
console.error(`[extract] relation rows to decode: ${total}`);

// Write to a scratch buffer we flush in chunks; avoids building one giant
// Buffer for ~2.2M rows in memory.
const fd = openSync(outPath, "w");
const header = Buffer.alloc(4);
header.writeUInt32LE(total, 0);
writeSync(fd, header);

const stmt = db.prepare(
  "select record_id, body_payload from record_occurrences where category = 'relation'",
);

let n = 0;
let bytesOut = 4;
const CHUNK_FLUSH = 1 << 20; // 1 MiB
let outBuf = Buffer.alloc(CHUNK_FLUSH + (1 << 16));
let outPos = 0;

function flush() {
  if (outPos > 0) {
    writeSync(fd, outBuf, 0, outPos);
    bytesOut += outPos;
    outPos = 0;
  }
}

function ensure(size) {
  if (outPos + size > outBuf.length) flush();
}

for (const row of stmt.iterate()) {
  const recBytes = recordIdToBytes(row.record_id);
  const payload = row.body_payload;
  const view = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  const decoded = decodeCanonical(view);
  const sourceId = String(decoded.source_id ?? "");
  const targetId = String(decoded.target_id ?? "");
  const sourceBytes = Buffer.from(sourceId, "utf8");
  const targetBytes = Buffer.from(targetId, "utf8");

  ensure(32 + 4 + sourceBytes.length + 4 + targetBytes.length);
  recBytes.copy(outBuf, outPos);
  outPos += 32;
  outBuf.writeUInt32LE(sourceBytes.length, outPos);
  outPos += 4;
  sourceBytes.copy(outBuf, outPos);
  outPos += sourceBytes.length;
  outBuf.writeUInt32LE(targetBytes.length, outPos);
  outPos += 4;
  targetBytes.copy(outBuf, outPos);
  outPos += targetBytes.length;

  n += 1;
  if (n % 250000 === 0) {
    console.error(`[extract] ${n}/${total} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  }
}
flush();
ftruncateSync(fd, bytesOut);
closeSync(fd);
db.close();

console.error(
  `[extract] done: ${n} rows, ${bytesOut} bytes, ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
if (n !== total) {
  console.error(`[extract] WARNING: decoded ${n} rows but count(*) reported ${total}`);
  process.exit(2);
}
