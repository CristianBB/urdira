//! Low-level file I/O shared by the writer and the reader: the common
//! 64-byte header, a generic "small framed file" writer (single buffer,
//! header + body, tmp+rename), the specialized parallel writer for the
//! five large per-row `records.*` files (keys/meta/digests/body/ident,
//! partitioned by the top nibble of `record_id` -- `urdira-v4-spike`'s
//! fix for the naive per-row `write_at` cost), and the binary-search
//! primitives the reader uses against mmap'd sorted arrays.
//!
//! P2-2m: every positional write into a `create_sized` (pre-`set_len`,
//! hence zero-filled/sparse) file below MUST go through
//! the platform's positional-write primitive, never a single-shot write.
//! Unix uses `write_at`; Windows uses `seek_write`. Each wraps exactly one
//! `pwrite(2)` call and is explicitly allowed by POSIX to write fewer
//! bytes than requested (a "short write") even for a plain regular file
//! and even without returning an error; Rust's std does not retry a short
//! write for you the way it does for `Write::write_all`. Before this fix,
//! every one of this function's large per-partition `write_at` calls
//! (`records.body`/`records.ident` in particular, often tens-to-hundreds
//! of MB in a single call at n8n scale) silently left the UNWRITTEN TAIL
//! of that call's own byte range at its pre-`set_len` value: zero. That
//! reproduced, non-deterministically and only at real-corpus scale
//! (never on a small fixture), as the exact signature this task's own
//! evidence doc records: a record whose `identity_key` bytes decode as
//! all-zero of the CORRECT length (the length itself lives in a separate,
//! unaffected `records.meta` field, so it was never wrong) while its
//! `record_digest` (a different file, `records.digests`, written by its
//! own separate `write_at` call) stayed intact -- and it was never scoped
//! to any one producer or relation kind, because the bug lived entirely
//! in this shared writer, below every producer. `write_all_at` loops
//! until the requested byte range is fully written (or a real error
//! occurs), closing the gap.

use crate::error::{Result, store_err};
use crate::identity_codec::{self, BatchIndex, IDENTITY_LAYOUT_RAW};
use crate::layout::*;
use crate::row::{CATEGORY_ENTITY, Dictionaries, NONE_U32, PendingSiteKey, RecordRow};
use crate::xxh;
use fs2::FileExt as Fs2FileExt;
use memmap2::Mmap;
use rayon::prelude::*;
use std::fs::{File, OpenOptions};
use std::io::Write;
#[cfg(windows)]
use std::io::{Seek, SeekFrom};
#[cfg(unix)]
use std::os::unix::fs::FileExt as UnixFileExt;
use std::path::Path;
#[cfg(windows)]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};

#[cfg(windows)]
static WINDOWS_POSITIONAL_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub const N_NIBBLES: usize = 16;

pub fn nibble_of(record_id: &[u8; 32]) -> usize {
    (record_id[0] >> 4) as usize
}

/// A1/A2 (2026-09-05, Frente A): `true` when `URDIRA_V4_DIAG_SKIP_ENTITIES_INDEX`
/// is set -- a DIAGNOSTIC-ONLY escape hatch used solely to measure `entities.
/// index`'s own marginal write cost in isolation (bench comparison, see this
/// task's evidence doc). When set, every `entities.index` builder in this
/// crate (flat, partitioned, delta) skips its sort/serialize work entirely
/// and writes an empty framed section (header + zero-length body, `row_count
/// = 0`) instead of the real triples. **The resulting store's `entities.
/// index` section is then WRONG** (empty, not just smaller) -- any query that
/// resolves through it (`StoreReader::entity_by_owner_and_start`, and hence
/// `urdira-indexing-worker`'s v4 residual `collect()`) would silently return
/// nothing. A store built with this flag set must never be used for anything
/// but this bench comparison, and never published/queried afterward.
pub fn diag_skip_entities_index() -> bool {
    std::env::var_os("URDIRA_V4_DIAG_SKIP_ENTITIES_INDEX").is_some()
}

/// Maps a file read-only. The only `unsafe` in this crate beyond this
/// function's callers: `memmap2::Mmap::map` is unsafe because the mapped
/// file could be mutated concurrently by another process, which would
/// violate Rust's aliasing rules for the `&[u8]` view it hands out. Every
/// file this crate maps is written once (tmp + rename) and never mutated
/// in place after being published in a `MANIFEST` (compaction/`write_slots`
/// write to files not yet referenced by a published manifest, or to
/// spans that concurrent readers do not read), so this is sound in
/// practice for this crate's own read/write protocol.
pub fn mmap_file(path: &Path) -> Result<Mmap> {
    let f = File::open(path).map_err(|e| store_err!("open {}: {e}", path.display()))?;
    let m = unsafe { Mmap::map(&f) }.map_err(|e| store_err!("mmap {}: {e}", path.display()))?;
    Ok(m)
}

/// Returns the file's header and the byte slice after it (the "data" the
/// header's `xxh3` covers). Takes a plain `&[u8]` (not `&Mmap`) so it works
/// identically over a whole-file mmap (base segments, and pre-P3-6 delta
/// directories) and over a byte-range VIEW into a shared delta-container
/// mmap ([`SectionSource`]) -- deref coercion means every existing call
/// site passing `&some_mmap` keeps compiling unchanged.
pub fn header_and_data(bytes: &[u8]) -> Result<(FileHeader, &[u8])> {
    if bytes.len() < HEADER_LEN {
        return Err(store_err!("segment file shorter than header"));
    }
    let header = FileHeader::decode(bytes)?;
    Ok((header, &bytes[HEADER_LEN..]))
}

/// `label` identifies the section/file for the error message only (a path
/// for a real file, or a synthetic `"<container>/<section>"` string for a
/// delta-container section that has no file path of its own).
pub fn verify_xxh3(bytes: &[u8], label: &str) -> Result<()> {
    let (header, data) = header_and_data(bytes)?;
    let actual = xxh::hash(data);
    if actual != header.body_xxh3 {
        return Err(store_err!(
            "xxh3 mismatch in {}: header {:016x} != computed {:016x}",
            label,
            header.body_xxh3,
            actual
        ));
    }
    Ok(())
}

/// A2 (2026-09-05): combines the 16 per-nibble-partition xxh3 hashes of one
/// hot `records.*` file into that file's header `body_xxh3` -- `xxh3` of
/// the 16 hashes' little-endian bytes, concatenated in nibble order. An
/// EMPTY partition's slot is `xxh::hash(&[])` (the exact value hashing
/// that partition's own empty byte range would produce) and is NEVER
/// skipped -- required for a store with fewer than 16 populated nibbles
/// (every store under ~16 rows, including most unit-test fixtures) to
/// combine deterministically and identically regardless of which writer
/// path produced it. See `identity_codec`-adjacent module docs: this is
/// the "hash each partition once, while its buffer is still in hand"
/// replacement for re-`mmap`-ing a just-written file to hash it whole
/// (measured 300-455 MB/s on the real pipeline vs 4.85-9.2 GB/s for the
/// same xxh3 run in isolation -- `docs/evidence/2026-09-02-v4-p2-2b-cold-
/// pipeline.md` §18.4).
pub fn hash_of_partition_hashes(parts: &[u64; N_NIBBLES]) -> u64 {
    let mut buf = [0u8; N_NIBBLES * 8];
    for (i, h) in parts.iter().enumerate() {
        buf[i * 8..i * 8 + 8].copy_from_slice(&h.to_le_bytes());
    }
    xxh::hash(&buf)
}

/// A2: derives the 16 nibble ROW-INDEX boundaries (`[b0=0, b1, ..., b15,
/// bN=n]`) from `records.keys`' own DATA bytes (post-header) -- sorted by
/// `record_id`, hence by nibble (`record_id[0] >> 4`), by construction
/// (every writer in this crate sorts hot rows this way). Used by [`verify_
/// xxh3_partitioned_stride`]/[`nibble_byte_boundaries`] to re-derive
/// exactly the boundaries the writer used, straight from what's actually
/// on disk -- self-verifying: a corrupted `records.keys` fails its OWN
/// partitioned verify using these same boundaries, so trusting them here
/// is not a soft spot.
pub fn nibble_row_boundaries(keys_data: &[u8]) -> [usize; N_NIBBLES + 1] {
    let n = keys_data.len() / KEYS_STRIDE;
    let mut b = [0usize; N_NIBBLES + 1];
    for (nib, slot) in b.iter_mut().enumerate().take(N_NIBBLES) {
        *slot = lower_bound(n, |i| {
            let byte0 = keys_data[i * KEYS_STRIDE];
            ((byte0 >> 4) as usize).cmp(&nib)
        });
    }
    b[N_NIBBLES] = n;
    b
}

/// A2: verifies a FIXED-STRIDE hot section (`records.keys`/`records.meta`/
/// `records.digests`) against its header's `body_xxh3`, using the SAME
/// `hash_of_partition_hashes` formula the writer computes it with.
/// `row_boundaries` (from [`nibble_row_boundaries`]) gives the 16 nibbles'
/// row-index ranges; `stride` turns each into a byte range.
pub fn verify_xxh3_partitioned_stride(
    bytes: &[u8],
    row_boundaries: &[usize; N_NIBBLES + 1],
    stride: usize,
    label: &str,
) -> Result<()> {
    let (header, data) = header_and_data(bytes)?;
    let mut parts = [0u64; N_NIBBLES];
    for nib in 0..N_NIBBLES {
        let start = row_boundaries[nib] * stride;
        let end = row_boundaries[nib + 1] * stride;
        parts[nib] = xxh::hash(&data[start..end]);
    }
    let actual = hash_of_partition_hashes(&parts);
    if actual != header.body_xxh3 {
        return Err(store_err!(
            "xxh3 mismatch in {}: header {:016x} != computed {:016x}",
            label,
            header.body_xxh3,
            actual
        ));
    }
    Ok(())
}

/// A2: derives the 16 nibbles' BYTE boundaries for a variable-length hot
/// section (`records.body`/`records.ident`) from `records.meta`'s own
/// `off_field` (`meta::BODY_OFF` or `meta::IDENT_OFF`) at each nibble's
/// first row. A nibble whose row index is `>=` the row count (every
/// remaining nibble is empty, past the last real row) resolves to `total`
/// -- there is no row left to read an offset from, and `total` is exactly
/// the byte offset one past the last row's own data, the correct boundary
/// for an empty trailing gap.
pub fn nibble_byte_boundaries(
    meta_data: &[u8],
    row_boundaries: &[usize; N_NIBBLES + 1],
    off_field: usize,
    total: u64,
) -> [u64; N_NIBBLES + 1] {
    let n_rows = meta_data.len() / META_STRIDE;
    let mut b = [0u64; N_NIBBLES + 1];
    for (nib, slot) in b.iter_mut().enumerate().take(N_NIBBLES) {
        let row = row_boundaries[nib];
        *slot = if row < n_rows {
            let m = &meta_data[row * META_STRIDE..(row + 1) * META_STRIDE];
            u64le(m, off_field)
        } else {
            total
        };
    }
    b[N_NIBBLES] = total;
    b
}

/// A2: verifies a VARIABLE-LENGTH hot section (`records.body`/`records.
/// ident`) against its header's `body_xxh3`, using the SAME `hash_of_
/// partition_hashes` formula the writer computes it with. `byte_
/// boundaries` (from [`nibble_byte_boundaries`]) gives the 16 nibbles'
/// byte ranges directly.
pub fn verify_xxh3_partitioned_bytes(
    bytes: &[u8],
    byte_boundaries: &[u64; N_NIBBLES + 1],
    label: &str,
) -> Result<()> {
    let (header, data) = header_and_data(bytes)?;
    let mut parts = [0u64; N_NIBBLES];
    for nib in 0..N_NIBBLES {
        let start = byte_boundaries[nib] as usize;
        let end = byte_boundaries[nib + 1] as usize;
        parts[nib] = xxh::hash(&data[start..end]);
    }
    let actual = hash_of_partition_hashes(&parts);
    if actual != header.body_xxh3 {
        return Err(store_err!(
            "xxh3 mismatch in {}: header {:016x} != computed {:016x}",
            label,
            header.body_xxh3,
            actual
        ));
    }
    Ok(())
}

/// A2: verifies all five hot `records.*` sections of one segment in one
/// call -- derives `row_boundaries` from `keys` once, reuses it for
/// `meta`/`digests` (fixed stride) and (via `nibble_byte_boundaries`) for
/// `body`/`ident` (variable length). `keys`/`meta` must be the section's
/// FULL bytes (header + data), matching every other `verify_xxh3*`
/// function's own convention.
#[allow(clippy::too_many_arguments)]
pub fn verify_records_hot_partitioned(
    keys: &[u8],
    meta: &[u8],
    digests: &[u8],
    body: &[u8],
    ident: &[u8],
    label_prefix: &str,
) -> Result<()> {
    let (_, keys_data) = header_and_data(keys)?;
    let (_, meta_data) = header_and_data(meta)?;
    let row_boundaries = nibble_row_boundaries(keys_data);
    verify_xxh3_partitioned_stride(
        keys,
        &row_boundaries,
        KEYS_STRIDE,
        &format!("{label_prefix}/records.keys"),
    )?;
    verify_xxh3_partitioned_stride(
        meta,
        &row_boundaries,
        META_STRIDE,
        &format!("{label_prefix}/records.meta"),
    )?;
    verify_xxh3_partitioned_stride(
        digests,
        &row_boundaries,
        DIGESTS_STRIDE,
        &format!("{label_prefix}/records.digests"),
    )?;
    let (_, body_data) = header_and_data(body)?;
    let (_, ident_data) = header_and_data(ident)?;
    let body_boundaries = nibble_byte_boundaries(
        meta_data,
        &row_boundaries,
        meta::BODY_OFF,
        body_data.len() as u64,
    );
    let ident_boundaries = nibble_byte_boundaries(
        meta_data,
        &row_boundaries,
        meta::IDENT_OFF,
        ident_data.len() as u64,
    );
    verify_xxh3_partitioned_bytes(
        body,
        &body_boundaries,
        &format!("{label_prefix}/records.body"),
    )?;
    verify_xxh3_partitioned_bytes(
        ident,
        &ident_boundaries,
        &format!("{label_prefix}/records.ident"),
    )?;
    Ok(())
}

fn create_sized(path: &Path, len: u64) -> std::io::Result<File> {
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    f.set_len(len)?;
    Ok(f)
}

/// Initializes a file with real zero writes when physical reservation is
/// unavailable. Neither allocation nor initialization is used as permission
/// for concurrent writes: `HotFile` serializes each file's positional writes
/// because disjoint partitions can share a physical boundary block.
fn materialize_real(file: &File, len: u64) -> std::io::Result<()> {
    const CHUNK: usize = 8 * 1024 * 1024;
    if len == 0 {
        return Ok(());
    }
    let zeros = vec![0u8; CHUNK.min(len as usize)];
    let mut written = 0u64;
    while written < len {
        let take = CHUNK.min((len - written) as usize);
        write_all_at(file, &zeros[..take], written)?;
        written += take as u64;
    }
    Ok(())
}

/// Writes every byte at a fixed offset. Unix uses retrying `write_at` calls;
/// Windows seeks a cloned synchronous handle and writes the complete buffer.
/// The caller serializes writes per file, so each platform preserves the same
/// positional semantics while rayon tasks continue to operate independently.
fn write_all_at(file: &File, bytes: &[u8], offset: u64) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        // `FileExt::seek_write` is not reliable for the synchronous handles
        // created by `OpenOptions` on the hosted Windows runners (it returns
        // ERROR_ACCESS_DENIED even though the handle is writable).  The
        // caller serializes writes for each file, so a cloned handle with an
        // explicit seek preserves positional semantics without sharing a
        // mutable cursor between rayon tasks.
        // Windows duplicated handles share the underlying file pointer.  A
        // seek followed by a write is therefore not atomic across threads:
        // another writer can move the cursor between those two operations.
        // Serialize this small critical section so the helper retains true
        // positional-write semantics even for callers that intentionally
        // issue disjoint writes concurrently (as the portability test does).
        let _guard = WINDOWS_POSITIONAL_WRITE_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("Windows positional-write lock is not poisoned");
        let mut sequential = file.try_clone()?;
        sequential.seek(SeekFrom::Start(offset))?;
        sequential.write_all(bytes)?;
        return Ok(());
    }

    #[cfg(unix)]
    {
        let mut written = 0usize;
        let mut offset = offset;
        while written < bytes.len() {
            let count = UnixFileExt::write_at(file, &bytes[written..], offset)?;
            if count == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "positional write made no progress",
                ));
            }
            written += count;
            offset += count as u64;
        }
    }
    Ok(())
}

/// Reserves physical blocks without writing a full zero image when the host
/// exposes a real allocation primitive. The zero-write path remains the
/// correctness fallback. Reservation is an allocation optimization, not a
/// guarantee that partially shared boundary blocks are initialized.
fn physical_preallocate_or_materialize(file: &File, len: u64) -> std::io::Result<()> {
    if len == 0 {
        return Ok(());
    }
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "freebsd",
        target_os = "android"
    ))]
    {
        if Fs2FileExt::allocate(file, len).is_ok() {
            return Ok(());
        }
    }
    materialize_real(file, len)
}

// Logical partitions can share a physical boundary block even when their
// byte ranges are disjoint. Allocation alone does not initialize those blocks.
// Keep the complete positional write (including short-write retries) exclusive
// per file; independent files, encoding and hashing remain parallel.
struct HotFile {
    file: Mutex<File>,
}

impl HotFile {
    fn write_all_at(&self, bytes: &[u8], offset: u64) -> std::io::Result<()> {
        let file = self
            .file
            .lock()
            .map_err(|_| std::io::Error::other("hot-file write lock poisoned"))?;
        write_all_at(&file, bytes, offset)
    }
}

fn create_sized_hot_files(specs: [(&Path, u64); 5]) -> Result<[Arc<HotFile>; 5]> {
    let files: Vec<Arc<HotFile>> = specs
        .par_iter()
        .map(|(path, len)| -> Result<Arc<HotFile>> {
            let file = create_sized(path, *len)?;
            physical_preallocate_or_materialize(&file, *len)?;
            Ok(Arc::new(HotFile {
                file: Mutex::new(file),
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(files.try_into().unwrap_or_else(|_| unreachable!()))
}

#[cfg(test)]
mod physical_preallocation_tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn hot_file_unaligned_partition_writes_preserve_every_byte() {
        assert_unaligned_hot_writes(8 * 1024 * 1024, 8);
    }

    #[test]
    #[ignore = "large filesystem boundary stress; writes 10 GiB"]
    fn hot_file_unaligned_partition_writes_large_stress() {
        assert_unaligned_hot_writes(80 * 1024 * 1024, 8);
    }

    fn assert_unaligned_hot_writes(partition_bytes: usize, rounds: usize) {
        let dir = std::env::temp_dir().join(format!(
            "urdira-hot-boundaries-{}-{partition_bytes}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let paths: Vec<_> = (0..5).map(|i| dir.join(format!("hot-{i}"))).collect();
        // Disjoint logical ranges share physical boundary blocks. Checking
        // only the first byte of aligned writes misses lost boundary tails.
        let lengths: Vec<usize> = (0..16).map(|i| partition_bytes + i * 160 + 32).collect();
        let mut offsets = vec![64u64];
        for len in &lengths {
            offsets.push(offsets.last().unwrap() + *len as u64);
        }
        for _ in 0..rounds {
            let files = create_sized_hot_files([
                (&paths[0], 64),
                (&paths[1], 64),
                (&paths[2], *offsets.last().unwrap()),
                (&paths[3], 64),
                (&paths[4], 64),
            ])
            .unwrap();
            let barrier = std::sync::Barrier::new(16);
            std::thread::scope(|scope| {
                for i in 0..16 {
                    let file = &files[2];
                    let barrier = &barrier;
                    let offset = offsets[i];
                    let len = lengths[i];
                    scope.spawn(move || {
                        let bytes = vec![i as u8 + 1; len];
                        barrier.wait();
                        file.write_all_at(&bytes, offset).unwrap();
                    });
                }
            });
            let bytes = std::fs::read(&paths[2]).unwrap();
            for i in 0..16 {
                let start = offsets[i] as usize;
                let end = offsets[i + 1] as usize;
                assert!(
                    bytes[start..end].iter().all(|b| *b == i as u8 + 1),
                    "partition {i} lost bytes"
                );
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn physical_preallocation_supports_parallel_disjoint_overwrites() {
        let thread_name = std::thread::current()
            .name()
            .unwrap_or("test")
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || character == '-' {
                    character
                } else {
                    '_'
                }
            })
            .collect::<String>();
        let path = std::env::temp_dir().join(format!(
            "urdira-physical-preallocation-{}-{}",
            std::process::id(),
            thread_name
        ));
        let _ = std::fs::remove_file(&path);
        let file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
            .expect("create preallocation fixture");
        physical_preallocate_or_materialize(&file, 16 * 1024 * 1024)
            .expect("physical preallocation succeeds");
        assert_eq!(file.metadata().unwrap().len(), 16 * 1024 * 1024);

        std::thread::scope(|scope| {
            for index in 0..16u64 {
                let file = &file;
                scope.spawn(move || {
                    write_all_at(file, &[index as u8 + 1; 4096], index * 1024 * 1024)
                        .expect("disjoint overwrite succeeds");
                });
            }
        });

        let mut reader = File::open(&path).unwrap();
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        for index in 0..16usize {
            assert_eq!(bytes[index * 1024 * 1024], index as u8 + 1);
        }
        std::fs::remove_file(path).unwrap();
    }
}

/// Encodes a section's full byte blob (64-byte header + `body`) entirely
/// in memory -- the shared core of [`write_framed_file`] (which writes the
/// blob straight to its own file) and P3-6's delta-container encoder
/// (`writer::build_delta_sections`), which concatenates many such blobs
/// into one container file instead of one file each. Returns `(blob,
/// body_xxh3)`.
pub fn encode_framed(
    table_id: TableId,
    generation: u64,
    row_count: u64,
    body: &[u8],
) -> (Vec<u8>, u64) {
    let hash = xxh::hash(body);
    let header = FileHeader {
        table_id: table_id as u16,
        row_count,
        generation,
        body_xxh3: hash,
    }
    .encode();
    let mut blob = Vec::with_capacity(HEADER_LEN + body.len());
    blob.extend_from_slice(&header);
    blob.extend_from_slice(body);
    (blob, hash)
}

/// A2: partitioned sibling of [`encode_framed`] for the five hot delta
/// sections (`writer::build_delta_sections`) -- `body_xxh3` is `hash_of_
/// partition_hashes` over `boundaries` (nibble BYTE ranges within `body`,
/// `[N_NIBBLES + 1]` entries) instead of one plain xxh3 of the whole
/// `body`, matching `write_base`/`write_base_partitioned`'s own hot-file
/// header formula so a compaction (base <- delta) and a fresh cold write
/// of the same logical rows produce identical headers.
pub fn encode_framed_partitioned(
    table_id: TableId,
    generation: u64,
    row_count: u64,
    body: &[u8],
    boundaries: &[usize; N_NIBBLES + 1],
) -> (Vec<u8>, u64) {
    let mut parts = [0u64; N_NIBBLES];
    for nib in 0..N_NIBBLES {
        parts[nib] = xxh::hash(&body[boundaries[nib]..boundaries[nib + 1]]);
    }
    let hash = hash_of_partition_hashes(&parts);
    let header = FileHeader {
        table_id: table_id as u16,
        row_count,
        generation,
        body_xxh3: hash,
    }
    .encode();
    let mut blob = Vec::with_capacity(HEADER_LEN + body.len());
    blob.extend_from_slice(&header);
    blob.extend_from_slice(body);
    (blob, hash)
}

/// Writes a small file in one shot: 64-byte header (xxh3 computed over
/// `body`, already in memory) followed by `body`. Used for every segment
/// file except the five large per-row `records.*` arrays, which go
/// through [`write_hot_and_secondary_files`] (`write_base`'s N-threaded
/// cold path) instead. Returns `(total_bytes, xxh3)`.
pub fn write_framed_file(
    path: &Path,
    table_id: TableId,
    generation: u64,
    row_count: u64,
    body: &[u8],
) -> std::io::Result<(u64, u64)> {
    let (blob, hash) = encode_framed(table_id, generation, row_count, body);
    let mut tmp_name = path.file_name().unwrap().to_os_string();
    tmp_name.push(".tmp");
    let tmp_path = path.with_file_name(tmp_name);
    {
        let mut f = File::create(&tmp_path)?;
        f.write_all(&blob)?;
        #[cfg(not(windows))]
        f.sync_all()?;
    }
    // Windows does not allow `rename` to replace an existing destination.
    // Delta rewrites can legitimately target an already-published index
    // file, so make the replacement explicit there while retaining the
    // atomic replace semantics on Unix.
    #[cfg(windows)]
    let _ = std::fs::remove_file(path);
    std::fs::rename(&tmp_path, path)?;
    Ok((blob.len() as u64, hash))
}

/// Result of writing the five hot `records.*` files: byte counts (data
/// only, header excluded) keyed by logical file name.
pub struct HotFilesResult {
    pub bytes: std::collections::BTreeMap<&'static str, u64>,
    pub xxh3: std::collections::BTreeMap<&'static str, u64>,
}

/// Result of [`write_hot_and_secondary_files`]: the five hot `records.*`
/// files plus the six secondary sorted-index arrays (`records.by_owner`,
/// `records.by_name`, `records.by_kind`, `records.by_identity`,
/// `adj.out`, `adj.in`), all written by threads spawned into one
/// `std::thread::scope`.
pub struct HotAndSecondaryResult {
    pub hot: HotFilesResult,
    pub secondary: std::collections::BTreeMap<String, (u64, u64)>,
    /// A1 (2026-09-05, Frente A): wall time of the five hot `records.*`
    /// files' own write work (per-nibble buffer fill + `write_all_at`),
    /// measured around the closure(s) that do it -- may overlap with
    /// `secondary_elapsed_ms`'s own wall time (both run concurrently, see
    /// each writer's own doc comment), so this is "how long the hot-file
    /// phase itself took", not a component of an additive total.
    pub hot_elapsed_ms: u64,
    /// A1: per-secondary-array wall time (`records.by_owner`, `records.
    /// by_name`, `records.by_kind`, `records.by_identity`, `adj.out`,
    /// `adj.in`, `entities.index`), keyed by the same names `secondary`
    /// uses. Measured around each array's own sort+serialize+`write_
    /// framed_file` work.
    pub secondary_elapsed_ms: std::collections::BTreeMap<String, u64>,
}

/// Like [`write_hot_records_files`], but also builds the six secondary
/// sorted-index arrays that `writer::build_secondary_arrays` used to build
/// in a second, sequential `std::thread::scope` call after this one
/// finished. That sequencing wasted wall-clock time cold-writing the
/// NODIAG bench: the secondary arrays are a full-set comparison sort (CPU
/// plus a small write), largely independent of the hot files' partitioned
/// `write_at` calls, so nothing requires them to run one after the other.
/// This function issues both sets of `scope.spawn` calls into the *same*
/// scope so the OS can interleave them across the available cores, then
/// does the hot files' header/hash pass afterward (unchanged from
/// [`write_hot_records_files`]). Bytes on disk are identical either way;
/// only the wall-clock scheduling changes.
#[allow(clippy::too_many_arguments)]
pub fn write_hot_and_secondary_files(
    dir: &Path,
    rows: &[RecordRow],
    order: &[u32],
    dicts: &Dictionaries,
    generation: u64,
    n_threads: usize,
    by_owner_path: &Path,
    by_name_path: &Path,
    by_kind_path: &Path,
    by_identity_path: &Path,
    adj_out_path: &Path,
    adj_in_path: &Path,
    entities_index_path: &Path,
) -> Result<HotAndSecondaryResult> {
    let n = order.len();

    let mut nibble_start = [n; N_NIBBLES + 1];
    {
        let mut cur = 0usize;
        for (nib, slot) in nibble_start.iter_mut().enumerate().take(N_NIBBLES) {
            *slot = cur;
            while cur < n && nibble_of(&rows[order[cur] as usize].record_id) == nib {
                cur += 1;
            }
        }
        nibble_start[N_NIBBLES] = n;
    }

    // A3a: classify every row's identity storage layout ONCE, up front,
    // single-threaded (the batch index below must exist before any
    // per-nibble parallel work starts -- resolving a relation's endpoint
    // may need ANY entity in the batch, not just ones in the same nibble
    // partition). `layouts[k]` aligns with `order[k]`, reused directly by
    // the per-nibble write loop below so `classify_identity_layout` never
    // runs twice for the same row.
    let batch_index = BatchIndex::from_rows(rows);
    let resolve_identity = |id: &[u8; 32]| batch_index.get(id);
    // A3a-fix: `dicts.entity_kinds` is already complete (the caller
    // extended it with this batch's new words before calling this
    // function -- see `SegmentWriter::write_base_with_pending`'s own doc
    // comment) -- built once here, shared by the loop below.
    let entity_kinds = identity_codec::EntityKindIndex::from_dicts(dicts);
    let mut layouts = vec![IDENTITY_LAYOUT_RAW; n];
    let mut entity_kind_bytes = vec![identity_codec::ENTITY_KIND_NONE; n];
    for k in 0..n {
        let row = &rows[order[k] as usize];
        let (layout, entity_kind_byte) =
            identity_codec::classify_identity_layout(row, dicts, &resolve_identity, &entity_kinds);
        layouts[k] = layout;
        entity_kind_bytes[k] = entity_kind_byte;
    }

    let mut body_off = vec![0u64; n];
    let mut ident_off = vec![0u64; n];
    let mut cur_body = 0u64;
    let mut cur_ident = 0u64;
    for k in 0..n {
        let row = &rows[order[k] as usize];
        body_off[k] = cur_body;
        cur_body += row.body.len() as u64;
        ident_off[k] = cur_ident;
        if layouts[k] == IDENTITY_LAYOUT_RAW {
            cur_ident += row.identity_key.len() as u64;
        }
    }
    let total_body = cur_body;
    let total_ident = cur_ident;

    let keys_path = dir.join("records.keys");
    let meta_path = dir.join("records.meta");
    let digests_path = dir.join("records.digests");
    let body_path = dir.join("records.body");
    let ident_path = dir.join("records.ident");

    let [keys_file, meta_file, digests_file, body_file, ident_file] = create_sized_hot_files([
        (&keys_path, HEADER_LEN as u64 + (n * KEYS_STRIDE) as u64),
        (&meta_path, HEADER_LEN as u64 + (n * META_STRIDE) as u64),
        (
            &digests_path,
            HEADER_LEN as u64 + (n * DIGESTS_STRIDE) as u64,
        ),
        (&body_path, HEADER_LEN as u64 + total_body),
        (&ident_path, HEADER_LEN as u64 + total_ident),
    ])?;

    // Windows hosted runners reject concurrent positional overwrites with
    // `ERROR_ACCESS_DENIED`; serialize the nibble workers there while
    // retaining the normal parallel path on Unix.
    let n_threads = if cfg!(windows) { 1 } else { n_threads.max(1) };
    let mut partitions_per_thread: Vec<Vec<usize>> = vec![Vec::new(); n_threads];
    for nib in 0..N_NIBBLES {
        partitions_per_thread[nib % n_threads].push(nib);
    }

    type NibbleBuffers = (usize, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>);
    enum Work {
        // A1: `elapsed_ms` = wall time of this thread's own per-nibble
        // loop (buffer fill + `write_all_at`), one entry per spawned
        // thread group (up to `n_threads`).
        Hot(Vec<NibbleBuffers>, u64),
        // A1: name, bytes, xxh3, elapsed_ms.
        Secondary(&'static str, u64, u64, u64),
    }

    let outcomes: Vec<Result<Work>> = std::thread::scope(|scope| {
        let mut handles: Vec<std::thread::ScopedJoinHandle<Result<Work>>> = Vec::new();

        for nibs in partitions_per_thread {
            if nibs.is_empty() {
                continue;
            }
            let keys_file = Arc::clone(&keys_file);
            let meta_file = Arc::clone(&meta_file);
            let digests_file = Arc::clone(&digests_file);
            let body_file = Arc::clone(&body_file);
            let ident_file = Arc::clone(&ident_file);
            let rows = &rows;
            let order = &order;
            let body_off = &body_off;
            let ident_off = &ident_off;
            let layouts = &layouts;
            let entity_kind_bytes = &entity_kind_bytes;
            let nibble_start = nibble_start;

            handles.push(scope.spawn(move || -> Result<Work> {
                let hot_started = std::time::Instant::now();
                let mut out = Vec::with_capacity(nibs.len());
                for nib in nibs {
                    let start = nibble_start[nib];
                    let end = nibble_start[nib + 1];
                    if start == end {
                        continue;
                    }
                    let mut keys_buf = vec![0u8; (end - start) * KEYS_STRIDE];
                    let mut meta_buf = vec![0u8; (end - start) * META_STRIDE];
                    let mut digests_buf = vec![0u8; (end - start) * DIGESTS_STRIDE];
                    let mut body_buf =
                        Vec::with_capacity((body_off[end - 1] - body_off[start]) as usize + 64);
                    let mut ident_buf =
                        Vec::with_capacity((ident_off[end - 1] - ident_off[start]) as usize + 64);

                    for (local, k) in (start..end).enumerate() {
                        let row = &rows[order[k] as usize];
                        keys_buf[local * KEYS_STRIDE..local * KEYS_STRIDE + 32]
                            .copy_from_slice(&row.record_id);

                        let m = &mut meta_buf[local * META_STRIDE..(local + 1) * META_STRIDE];
                        put_u32le(m, meta::OWNER_ARTIFACT, row.owner_artifact);
                        put_u32le(m, meta::OWNER_VERSION, row.owner_version);
                        put_u32le(m, meta::VALID_FROM, row.valid_from);
                        put_u32le(m, meta::VALID_TO, row.valid_to);
                        m[meta::CATEGORY] = row.category;
                        put_u16le(m, meta::KIND_ID, row.kind_id);
                        put_u16le(m, meta::UNIVERSAL_KIND_ID, row.universal_kind_id);
                        put_u64le(m, meta::FACETS, row.facets);
                        put_u32le(m, meta::SPAN_ARTIFACT_VERSION, row.span_artifact_version);
                        put_u32le(m, meta::SPAN_START_BYTE, row.span_start_byte);
                        put_u32le(m, meta::SPAN_END_BYTE, row.span_end_byte);
                        put_u32le(m, meta::SPAN_START_LINE, row.span_start_line);
                        put_u32le(m, meta::SPAN_END_LINE, row.span_end_line);
                        m[meta::IDENTITY_TYPE] = row.identity_type;
                        m[meta::ASSIGNMENT_KIND] = row.assignment_kind;
                        put_u32le(m, meta::NAME_ID, row.name_id);
                        put_u32le(
                            m,
                            meta::SOURCE_SUBJECT,
                            row.source_subject.unwrap_or(NONE_U32),
                        );
                        put_u32le(
                            m,
                            meta::TARGET_SUBJECT,
                            row.target_subject.unwrap_or(NONE_U32),
                        );
                        put_u16le(m, meta::RELATION_KIND_ID, row.relation_kind_id);
                        put_u64le(m, meta::BODY_OFF, body_off[k]);
                        put_u32le(m, meta::BODY_LEN, row.body.len() as u32);
                        put_u64le(m, meta::IDENT_OFF, ident_off[k]);
                        let layout = layouts[k];
                        m[meta::IDENTITY_LAYOUT] = layout;
                        m[meta::ENTITY_KIND] = entity_kind_bytes[k];
                        let ident_len = if layout == IDENTITY_LAYOUT_RAW {
                            row.identity_key.len() as u32
                        } else {
                            0
                        };
                        put_u32le(m, meta::IDENT_LEN, ident_len);

                        let d =
                            &mut digests_buf[local * DIGESTS_STRIDE..(local + 1) * DIGESTS_STRIDE];
                        d[digests::RECORD_DIGEST..digests::RECORD_DIGEST + 32]
                            .copy_from_slice(&row.record_digest);
                        d[digests::BODY_DIGEST..digests::BODY_DIGEST + 32]
                            .copy_from_slice(&row.body_digest);
                        d[digests::IDENTITY_ID..digests::IDENTITY_ID + 32]
                            .copy_from_slice(&row.identity_id);
                        d[digests::IDENTITY_KEY_DIGEST..digests::IDENTITY_KEY_DIGEST + 32]
                            .copy_from_slice(&row.identity_key_digest);
                        d[digests::PREVIOUS_RECORD_ID..digests::PREVIOUS_RECORD_ID + 32]
                            .copy_from_slice(&row.previous_record_id);

                        body_buf.extend_from_slice(&row.body);
                        if layout == IDENTITY_LAYOUT_RAW {
                            ident_buf.extend_from_slice(&row.identity_key);
                        }
                    }

                    keys_file.write_all_at(
                        &keys_buf,
                        HEADER_LEN as u64 + (start * KEYS_STRIDE) as u64,
                    )?;
                    meta_file.write_all_at(
                        &meta_buf,
                        HEADER_LEN as u64 + (start * META_STRIDE) as u64,
                    )?;
                    digests_file.write_all_at(
                        &digests_buf,
                        HEADER_LEN as u64 + (start * DIGESTS_STRIDE) as u64,
                    )?;
                    body_file.write_all_at(&body_buf, HEADER_LEN as u64 + body_off[start])?;
                    ident_file.write_all_at(&ident_buf, HEADER_LEN as u64 + ident_off[start])?;
                    out.push((nib, keys_buf, meta_buf, digests_buf, body_buf, ident_buf));
                }
                Ok(Work::Hot(out, hot_started.elapsed().as_millis() as u64))
            }));
        }

        handles.push(scope.spawn(|| -> Result<Work> {
            let t = std::time::Instant::now();
            let mut quads: Vec<(u32, u32, u32, u32)> = order
                .iter()
                .enumerate()
                .map(|(k, &i)| {
                    let r = &rows[i as usize];
                    (r.owner_artifact, r.valid_from, r.valid_to, k as u32)
                })
                .collect();
            quads.sort_unstable();
            let mut buf = Vec::with_capacity(quads.len() * VALIDITY_QUAD_STRIDE);
            for (a, b, c, d) in &quads {
                buf.extend_from_slice(&a.to_le_bytes());
                buf.extend_from_slice(&b.to_le_bytes());
                buf.extend_from_slice(&c.to_le_bytes());
                buf.extend_from_slice(&d.to_le_bytes());
            }
            let (bytes, xxh3) = write_framed_file(
                by_owner_path,
                TableId::Records,
                generation,
                quads.len() as u64,
                &buf,
            )?;
            Ok(Work::Secondary(
                "records.by_owner",
                bytes,
                xxh3,
                t.elapsed().as_millis() as u64,
            ))
        }));

        handles.push(scope.spawn(|| -> Result<Work> {
            let t = std::time::Instant::now();
            let mut pairs: Vec<(u32, u32)> = order
                .iter()
                .enumerate()
                .filter_map(|(k, &i)| rows[i as usize].name_id_opt().map(|nm| (nm, k as u32)))
                .collect();
            pairs.sort_unstable();
            let mut buf = Vec::with_capacity(pairs.len() * PAIR2_STRIDE);
            for (a, b) in &pairs {
                buf.extend_from_slice(&a.to_le_bytes());
                buf.extend_from_slice(&b.to_le_bytes());
            }
            let (bytes, xxh3) = write_framed_file(
                by_name_path,
                TableId::Records,
                generation,
                pairs.len() as u64,
                &buf,
            )?;
            Ok(Work::Secondary(
                "records.by_name",
                bytes,
                xxh3,
                t.elapsed().as_millis() as u64,
            ))
        }));

        handles.push(scope.spawn(|| -> Result<Work> {
            let t = std::time::Instant::now();
            let mut keys: Vec<(u16, u8, u16, u32)> = order
                .iter()
                .enumerate()
                .map(|(k, &i)| {
                    let r = &rows[i as usize];
                    (r.universal_kind_id, r.category, r.kind_id, k as u32)
                })
                .collect();
            keys.sort_unstable();
            let mut buf = Vec::with_capacity(keys.len() * BY_KIND_STRIDE);
            for (u, c, kd, k) in &keys {
                buf.extend_from_slice(&u.to_le_bytes());
                buf.push(*c);
                buf.extend_from_slice(&kd.to_le_bytes());
                buf.extend_from_slice(&k.to_le_bytes());
            }
            let (bytes, xxh3) = write_framed_file(
                by_kind_path,
                TableId::Records,
                generation,
                keys.len() as u64,
                &buf,
            )?;
            Ok(Work::Secondary(
                "records.by_kind",
                bytes,
                xxh3,
                t.elapsed().as_millis() as u64,
            ))
        }));

        handles.push(scope.spawn(|| -> Result<Work> {
            let t = std::time::Instant::now();
            let mut keys: Vec<([u8; 32], u32)> = order
                .iter()
                .enumerate()
                .map(|(k, &i)| (rows[i as usize].identity_key_digest, k as u32))
                .collect();
            keys.sort_unstable();
            let mut buf = Vec::with_capacity(keys.len() * BY_IDENTITY_STRIDE);
            for (digest, k) in &keys {
                buf.extend_from_slice(digest);
                buf.extend_from_slice(&k.to_le_bytes());
            }
            let (bytes, xxh3) = write_framed_file(
                by_identity_path,
                TableId::Records,
                generation,
                keys.len() as u64,
                &buf,
            )?;
            Ok(Work::Secondary(
                "records.by_identity",
                bytes,
                xxh3,
                t.elapsed().as_millis() as u64,
            ))
        }));

        handles.push(scope.spawn(|| -> Result<Work> {
            let t = std::time::Instant::now();
            let mut quads: Vec<(u32, u32, u32, u32)> = order
                .iter()
                .enumerate()
                .filter_map(|(k, &i)| {
                    let r = &rows[i as usize];
                    r.source_subject
                        .map(|s| (s, r.valid_from, r.valid_to, k as u32))
                })
                .collect();
            quads.sort_unstable();
            let mut buf = Vec::with_capacity(quads.len() * VALIDITY_QUAD_STRIDE);
            for (a, b, c, d) in &quads {
                buf.extend_from_slice(&a.to_le_bytes());
                buf.extend_from_slice(&b.to_le_bytes());
                buf.extend_from_slice(&c.to_le_bytes());
                buf.extend_from_slice(&d.to_le_bytes());
            }
            let (bytes, xxh3) = write_framed_file(
                adj_out_path,
                TableId::Records,
                generation,
                quads.len() as u64,
                &buf,
            )?;
            Ok(Work::Secondary(
                "adj.out",
                bytes,
                xxh3,
                t.elapsed().as_millis() as u64,
            ))
        }));

        handles.push(scope.spawn(|| -> Result<Work> {
            let t = std::time::Instant::now();
            let mut quads: Vec<(u32, u32, u32, u32)> = order
                .iter()
                .enumerate()
                .filter_map(|(k, &i)| {
                    let r = &rows[i as usize];
                    r.target_subject
                        .map(|s| (s, r.valid_from, r.valid_to, k as u32))
                })
                .collect();
            quads.sort_unstable();
            let mut buf = Vec::with_capacity(quads.len() * VALIDITY_QUAD_STRIDE);
            for (a, b, c, d) in &quads {
                buf.extend_from_slice(&a.to_le_bytes());
                buf.extend_from_slice(&b.to_le_bytes());
                buf.extend_from_slice(&c.to_le_bytes());
                buf.extend_from_slice(&d.to_le_bytes());
            }
            let (bytes, xxh3) = write_framed_file(
                adj_in_path,
                TableId::Records,
                generation,
                quads.len() as u64,
                &buf,
            )?;
            Ok(Work::Secondary(
                "adj.in",
                bytes,
                xxh3,
                t.elapsed().as_millis() as u64,
            ))
        }));

        handles.push(scope.spawn(|| -> Result<Work> {
            let t = std::time::Instant::now();
            let (row_count, buf) = if diag_skip_entities_index() {
                (0u64, Vec::new())
            } else {
                let inferred_type_kind_id = inferred_type_kind_id(dicts);
                let mut triples: Vec<(u32, u32, u32)> = order
                    .iter()
                    .enumerate()
                    .filter_map(|(k, &i)| {
                        let r = &rows[i as usize];
                        is_entities_index_row(r.category, r.kind_id, inferred_type_kind_id)
                            .then(|| (r.owner_artifact, entities_index_key_start(r), k as u32))
                    })
                    .collect();
                // A2 (2026-09-05): pack `(owner_artifact, span_start)` into
                // one `u64` for the primary comparison -- a single 64-bit
                // compare instead of two sequential 32-bit field compares
                // -- with `ordinal` kept as an explicit secondary key so
                // this produces EXACTLY the same total order as the old
                // `sort_unstable()` over the full 3-tuple (ordinals are
                // always distinct within one batch, so the old sort was
                // already a total order; dropping ordinal from the key
                // entirely, as a plain packed-key-only sort would, makes
                // ties unstable and was measured to break `write_base_
                // partitioned_matches_write_base_byte_for_byte` whenever
                // the fixture has a real `(owner, span_start)` collision --
                // this keeps the byte-for-byte guarantee while still
                // shrinking the primary comparison to 8 bytes).
                triples.sort_unstable_by_key(|t| (((t.0 as u64) << 32) | t.1 as u64, t.2));
                let mut buf = Vec::with_capacity(triples.len() * TRIPLE_STRIDE);
                for (a, b, c) in &triples {
                    let mut rec = [0u8; TRIPLE_STRIDE];
                    rec[0..4].copy_from_slice(&a.to_le_bytes());
                    rec[4..8].copy_from_slice(&b.to_le_bytes());
                    rec[8..12].copy_from_slice(&c.to_le_bytes());
                    buf.extend_from_slice(&rec);
                }
                (triples.len() as u64, buf)
            };
            let (bytes, xxh3) = write_framed_file(
                entities_index_path,
                TableId::Records,
                generation,
                row_count,
                &buf,
            )?;
            Ok(Work::Secondary(
                "entities.index",
                bytes,
                xxh3,
                t.elapsed().as_millis() as u64,
            ))
        }));

        handles
            .into_iter()
            .map(|h| {
                h.join()
                    .map_err(|_| store_err!("hot/secondary writer thread panicked"))?
            })
            .collect()
    });

    let mut nibble_buffers: Vec<NibbleBuffers> = Vec::new();
    let mut secondary: std::collections::BTreeMap<String, (u64, u64)> =
        std::collections::BTreeMap::new();
    let mut secondary_elapsed_ms: std::collections::BTreeMap<String, u64> =
        std::collections::BTreeMap::new();
    // A1: several `Work::Hot` entries may exist (one per spawned thread
    // group) -- they run CONCURRENTLY, so "how long did the hot-file phase
    // take" is the SLOWEST one, not their sum.
    let mut hot_elapsed_ms = 0u64;
    for outcome in outcomes {
        match outcome? {
            Work::Hot(mut v, elapsed_ms) => {
                nibble_buffers.append(&mut v);
                hot_elapsed_ms = hot_elapsed_ms.max(elapsed_ms);
            }
            Work::Secondary(name, bytes, xxh3, elapsed_ms) => {
                secondary.insert(name.to_string(), (bytes, xxh3));
                secondary_elapsed_ms.insert(name.to_string(), elapsed_ms);
            }
        }
    }
    nibble_buffers.sort_unstable_by_key(|(nib, ..)| *nib);
    let ordered = nibble_buffers;

    let mut bytes = std::collections::BTreeMap::new();
    let mut xxh3s = std::collections::BTreeMap::new();
    let header_jobs: [(&'static str, &Arc<HotFile>, u64); 5] = [
        ("records.keys", &keys_file, (n * KEYS_STRIDE) as u64),
        ("records.meta", &meta_file, (n * META_STRIDE) as u64),
        (
            "records.digests",
            &digests_file,
            (n * DIGESTS_STRIDE) as u64,
        ),
        ("records.body", &body_file, total_body),
        ("records.ident", &ident_file, total_ident),
    ];
    let results: Vec<Result<(&'static str, u64, u64)>> = std::thread::scope(|scope| {
        header_jobs
            .into_iter()
            .enumerate()
            .map(|(slot, (name, file, data_len))| {
                let ordered = &ordered;
                scope.spawn(move || -> Result<(&'static str, u64, u64)> {
                    // A2: per-nibble hash, combined via `hash_of_partition_
                    // hashes` -- the SAME formula `write_hot_and_secondary_
                    // files_partitioned` uses, so both writers produce
                    // identical headers for the same logical rows
                    // (`write_base_partitioned_test.rs`'s byte-for-byte
                    // oracle). An absent nibble (no entry in `ordered`,
                    // i.e. an empty partition -- `nibble_buffers` only ever
                    // gets an entry for a nibble with `start != end`) is
                    // NEVER skipped: its slot stays `xxh::hash(&[])`,
                    // exactly what hashing its own (empty) buffer would
                    // have produced.
                    let mut parts = [xxh::hash(&[]); N_NIBBLES];
                    for entry in ordered {
                        let nib = entry.0;
                        let buf: &Vec<u8> = match slot {
                            0 => &entry.1,
                            1 => &entry.2,
                            2 => &entry.3,
                            3 => &entry.4,
                            _ => &entry.5,
                        };
                        parts[nib] = xxh::hash(buf);
                    }
                    let hash = hash_of_partition_hashes(&parts);
                    let header = FileHeader {
                        table_id: TableId::Records as u16,
                        row_count: n as u64,
                        generation,
                        body_xxh3: hash,
                    }
                    .encode();
                    file.write_all_at(&header, 0)?;
                    Ok((name, HEADER_LEN as u64 + data_len, hash))
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| {
                h.join()
                    .map_err(|_| store_err!("header/hash thread panicked"))?
            })
            .collect()
    });
    for r in results {
        let (name, total, hash) = r?;
        bytes.insert(name, total);
        xxh3s.insert(name, hash);
    }

    // A1 (2026-09-05, Frente A): per-secondary-file timing is aggregated
    // here (`hot_elapsed_ms`/`secondary_elapsed_ms` below) but PRINTED by
    // the caller (`writer::SegmentWriter::write_base_with_pending`), which
    // also knows this generation's `fsync` time -- one combined grep-able
    // line, not two separate ones from two different call depths.
    Ok(HotAndSecondaryResult {
        hot: HotFilesResult { bytes, xxh3: xxh3s },
        secondary,
        hot_elapsed_ms,
        secondary_elapsed_ms,
    })
}

/// `row_base[nib] + local` -- the global row ordinal a partitioned row
/// lands at once every earlier partition's rows are counted. A plain `fn`
/// (not a closure) so every secondary-array builder below can call it
/// without fighting rayon's closure-capture rules.
fn global_k(row_base: &[usize; N_NIBBLES + 1], nib: usize, local: usize) -> u32 {
    (row_base[nib] + local) as u32
}

/// P2-2j item 2: partition-native counterpart of
/// [`write_hot_and_secondary_files`]. `partitions[nib]` must hold exactly
/// the rows for which `nibble_of(&row.record_id) == nib`, already sorted
/// ascending by `record_id` WITHIN each partition (`urdira-indexing-
/// worker`'s v4 `materialize::materialize_cold_partitioned` builds these
/// directly via a rayon `fold`/`reduce` over owners, instead of assembling
/// one flat `Vec<RecordRow>` and then computing a GLOBAL sort order the way
/// [`write_hot_and_secondary_files`]'s `compute_order` does).
///
/// Concatenating `partitions[0..N_NIBBLES]` in order is byte-for-byte the
/// same total order `compute_order`'s global sort produces (nibble 0 holds
/// the smallest `record_id`s, nibble 15 the largest, and each partition is
/// itself sorted ascending) -- this function exploits that to avoid both
/// the global sort AND the single `Vec<u32>` "order" indirection: each of
/// the `N_NIBBLES` partitions is encoded by its own `rayon` task, computing
/// its own LOCAL body/ident byte-offset prefix sum (previously one
/// single-threaded O(total records) loop over the WHOLE row set,
/// `write_hot_and_secondary_files`'s `body_off`/`ident_off` arrays) against
/// a small per-partition base offset from one cheap, purely-arithmetic
/// prefix sum over just the `N_NIBBLES` partition totals. The six secondary
/// sorted-index arrays are built the same way as before (one full-set
/// comparison sort each) except each array's own sort now runs on
/// `rayon`'s parallel `par_sort_unstable` instead of a single dedicated OS
/// thread's `[T]::sort_unstable`, and the six arrays' own construction plus
/// the five hot files run concurrently via one `rayon::join` (mirroring
/// `write_hot_and_secondary_files`'s "same scope, no artificial
/// sequencing" rationale) -- see the evidence doc's "P2-2j round 6" section
/// for the measured effect. `write_base` (unchanged) still calls the
/// original, non-partitioned function; this is purely additive.
#[allow(clippy::too_many_arguments)]
pub fn write_hot_and_secondary_files_partitioned(
    dir: &Path,
    partitions: &[Vec<RecordRow>],
    dicts: &Dictionaries,
    generation: u64,
    by_owner_path: &Path,
    by_name_path: &Path,
    by_kind_path: &Path,
    by_identity_path: &Path,
    adj_out_path: &Path,
    adj_in_path: &Path,
    entities_index_path: &Path,
) -> Result<HotAndSecondaryResult> {
    assert_eq!(
        partitions.len(),
        N_NIBBLES,
        "write_hot_and_secondary_files_partitioned requires exactly N_NIBBLES partitions"
    );

    let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();

    // A3a: the batch index (`record_id -> identity_key bytes`, spanning
    // EVERY partition) must exist before any per-partition work starts --
    // a relation in partition N may point at an entity in partition M != N
    // -- so it's built here, once, and shared by reference into the
    // `par_iter` below (never rebuilt per partition).
    let batch_index_started = std::time::Instant::now();
    let batch_index = BatchIndex::from_partitions(partitions);
    let batch_index_elapsed = batch_index_started.elapsed();
    let resolve_identity = |id: &[u8; 32]| batch_index.get(id);
    // A3a-fix: `dicts.entity_kinds` is already complete (the caller
    // extended it with this batch's new words before calling this
    // function, over EVERY partition -- see `SegmentWriter::write_base_
    // partitioned_with_pending`'s own doc comment).
    let entity_kinds = identity_codec::EntityKindIndex::from_dicts(dicts);
    // `layouts[nib][local]`/`entity_kind_bytes[nib][local]` mirror
    // `partitions[nib][local]`, classified once here across the independent
    // partitions and reused by both
    // this prefix-sum loop and the per-partition write loop below -- never
    // re-classified per row.
    let layouts_started = std::time::Instant::now();
    let (layouts, entity_kind_bytes): (Vec<Vec<u8>>, Vec<Vec<u8>>) = partitions
        .par_iter()
        .map(|part| {
            part.iter()
                .map(|row| {
                    identity_codec::classify_identity_layout(
                        row,
                        dicts,
                        &resolve_identity,
                        &entity_kinds,
                    )
                })
                .unzip()
        })
        .unzip();
    let layouts_elapsed = layouts_started.elapsed();

    let prefix_started = std::time::Instant::now();
    let mut row_base = [0usize; N_NIBBLES + 1];
    let mut body_base = [0u64; N_NIBBLES + 1];
    let mut ident_base = [0u64; N_NIBBLES + 1];
    for nib in 0..N_NIBBLES {
        let (body_len, ident_len) = partitions[nib].iter().zip(layouts[nib].iter()).fold(
            (0u64, 0u64),
            |(b, id), (row, &layout)| {
                let ident_add = if layout == IDENTITY_LAYOUT_RAW {
                    row.identity_key.len() as u64
                } else {
                    0
                };
                (b + row.body.len() as u64, id + ident_add)
            },
        );
        row_base[nib + 1] = row_base[nib] + partitions[nib].len();
        body_base[nib + 1] = body_base[nib] + body_len;
        ident_base[nib + 1] = ident_base[nib] + ident_len;
    }
    let n = row_base[N_NIBBLES];
    let total_body = body_base[N_NIBBLES];
    let total_ident = ident_base[N_NIBBLES];
    let prefix_elapsed = prefix_started.elapsed();

    let keys_path = dir.join("records.keys");
    let meta_path = dir.join("records.meta");
    let digests_path = dir.join("records.digests");
    let body_path = dir.join("records.body");
    let ident_path = dir.join("records.ident");

    let preallocate_started = std::time::Instant::now();
    let [keys_file, meta_file, digests_file, body_file, ident_file] = create_sized_hot_files([
        (&keys_path, HEADER_LEN as u64 + (n * KEYS_STRIDE) as u64),
        (&meta_path, HEADER_LEN as u64 + (n * META_STRIDE) as u64),
        (
            &digests_path,
            HEADER_LEN as u64 + (n * DIGESTS_STRIDE) as u64,
        ),
        (&body_path, HEADER_LEN as u64 + total_body),
        (&ident_path, HEADER_LEN as u64 + total_ident),
    ])?;
    let preallocate_elapsed = preallocate_started.elapsed();
    if debug_timing {
        eprintln!(
            "[urdira-structural-store] partitioned prepare: batch_index={:.3}s layouts={:.3}s prefix={:.3}s physical_preallocate={:.3}s total={:.3}s",
            batch_index_elapsed.as_secs_f64(),
            layouts_elapsed.as_secs_f64(),
            prefix_elapsed.as_secs_f64(),
            preallocate_elapsed.as_secs_f64(),
            (batch_index_elapsed + layouts_elapsed + prefix_elapsed + preallocate_elapsed)
                .as_secs_f64(),
        );
    }

    // P2-2j item 4 (RSS): unlike `write_hot_and_secondary_files`'s own
    // `nibble_buffers` (which keeps every nibble's FULL encoded buffers
    // alive until a final header-hash pass re-walks them, doubling live
    // memory for the whole `records.*` byte volume -- confirmed live as a
    // meaningful share of this task's own measured RSS at n8n scale, see
    // the evidence doc), each partition's buffers here are written to disk
    // and then DROPPED immediately (end of this closure's scope) -- never
    // returned, never kept alive past their own `write_at` calls.
    //
    // A2 (2026-09-05): the per-file whole-data xxh3 used to be computed
    // AFTER this closure returned, by re-`mmap_file`-ing each just-written
    // file and hashing it whole (measured 300-455 MB/s on the real
    // pipeline vs 4.85-9.2 GB/s for the same xxh3 run in isolation --
    // `docs/evidence/2026-09-02-v4-p2-2b-cold-pipeline.md` §18.4 -- the gap
    // being the re-read: the five files' worth of data crossing the
    // mmap/page-cache boundary a second time, competing for bandwidth
    // across 5 concurrent rayon tasks). Now each partition hashes its OWN
    // five buffers right here, immediately after (never before) writing
    // them, while they're still in hand -- no re-read of anything. Returns
    // `[u64; 5]` per partition (keys/meta/digests/body/ident, same order
    // `header_jobs` below indexes); the caller combines each file's 16
    // partition hashes via `hash_of_partition_hashes` into that file's
    // header `body_xxh3` -- the SAME formula the non-partitioned `write_
    // hot_and_secondary_files` above now also uses, so both writers
    // produce byte-identical headers for the same logical rows.
    // A1 (2026-09-05, Frente A): `elapsed_ms` = wall time of this whole
    // closure (every partition's buffer fill + `write_all_at` + own hash,
    // all run concurrently via `par_iter` below) -- runs concurrently with
    // `secondary_work` (see the `rayon::join` below), so this is "how long
    // the hot-file phase itself took", not a component of an additive
    // total together with `secondary_work`'s own elapsed times.
    let hot_files_work = || -> Result<(Vec<[u64; 5]>, u64)> {
        let hot_started = std::time::Instant::now();
        let result: Result<Vec<[u64; 5]>> = partitions
            .par_iter()
            .enumerate()
            .map(|(nib, part)| -> Result<[u64; 5]> {
                let count = part.len();
                let mut keys_buf = vec![0u8; count * KEYS_STRIDE];
                let mut meta_buf = vec![0u8; count * META_STRIDE];
                let mut digests_buf = vec![0u8; count * DIGESTS_STRIDE];
                let mut body_buf =
                    Vec::with_capacity((body_base[nib + 1] - body_base[nib]) as usize);
                let mut ident_buf =
                    Vec::with_capacity((ident_base[nib + 1] - ident_base[nib]) as usize);
                let mut local_body_off = 0u64;
                let mut local_ident_off = 0u64;

                for (local, row) in part.iter().enumerate() {
                    debug_assert_eq!(
                        nibble_of(&row.record_id),
                        nib,
                        "write_hot_and_secondary_files_partitioned: partition/nibble mismatch"
                    );
                    let layout = layouts[nib][local];
                    keys_buf[local * KEYS_STRIDE..local * KEYS_STRIDE + 32]
                        .copy_from_slice(&row.record_id);

                    let m = &mut meta_buf[local * META_STRIDE..(local + 1) * META_STRIDE];
                    put_u32le(m, meta::OWNER_ARTIFACT, row.owner_artifact);
                    put_u32le(m, meta::OWNER_VERSION, row.owner_version);
                    put_u32le(m, meta::VALID_FROM, row.valid_from);
                    put_u32le(m, meta::VALID_TO, row.valid_to);
                    m[meta::CATEGORY] = row.category;
                    put_u16le(m, meta::KIND_ID, row.kind_id);
                    put_u16le(m, meta::UNIVERSAL_KIND_ID, row.universal_kind_id);
                    put_u64le(m, meta::FACETS, row.facets);
                    put_u32le(m, meta::SPAN_ARTIFACT_VERSION, row.span_artifact_version);
                    put_u32le(m, meta::SPAN_START_BYTE, row.span_start_byte);
                    put_u32le(m, meta::SPAN_END_BYTE, row.span_end_byte);
                    put_u32le(m, meta::SPAN_START_LINE, row.span_start_line);
                    put_u32le(m, meta::SPAN_END_LINE, row.span_end_line);
                    m[meta::IDENTITY_TYPE] = row.identity_type;
                    m[meta::ASSIGNMENT_KIND] = row.assignment_kind;
                    put_u32le(m, meta::NAME_ID, row.name_id);
                    put_u32le(
                        m,
                        meta::SOURCE_SUBJECT,
                        row.source_subject.unwrap_or(NONE_U32),
                    );
                    put_u32le(
                        m,
                        meta::TARGET_SUBJECT,
                        row.target_subject.unwrap_or(NONE_U32),
                    );
                    put_u16le(m, meta::RELATION_KIND_ID, row.relation_kind_id);
                    put_u64le(m, meta::BODY_OFF, body_base[nib] + local_body_off);
                    put_u32le(m, meta::BODY_LEN, row.body.len() as u32);
                    put_u64le(m, meta::IDENT_OFF, ident_base[nib] + local_ident_off);
                    m[meta::IDENTITY_LAYOUT] = layout;
                    m[meta::ENTITY_KIND] = entity_kind_bytes[nib][local];
                    let ident_len = if layout == IDENTITY_LAYOUT_RAW {
                        row.identity_key.len() as u32
                    } else {
                        0
                    };
                    put_u32le(m, meta::IDENT_LEN, ident_len);

                    let d = &mut digests_buf[local * DIGESTS_STRIDE..(local + 1) * DIGESTS_STRIDE];
                    d[digests::RECORD_DIGEST..digests::RECORD_DIGEST + 32]
                        .copy_from_slice(&row.record_digest);
                    d[digests::BODY_DIGEST..digests::BODY_DIGEST + 32]
                        .copy_from_slice(&row.body_digest);
                    d[digests::IDENTITY_ID..digests::IDENTITY_ID + 32]
                        .copy_from_slice(&row.identity_id);
                    d[digests::IDENTITY_KEY_DIGEST..digests::IDENTITY_KEY_DIGEST + 32]
                        .copy_from_slice(&row.identity_key_digest);
                    d[digests::PREVIOUS_RECORD_ID..digests::PREVIOUS_RECORD_ID + 32]
                        .copy_from_slice(&row.previous_record_id);

                    body_buf.extend_from_slice(&row.body);
                    if layout == IDENTITY_LAYOUT_RAW {
                        ident_buf.extend_from_slice(&row.identity_key);
                        local_ident_off += row.identity_key.len() as u64;
                    }
                    local_body_off += row.body.len() as u64;
                }

                keys_file.write_all_at(
                    &keys_buf,
                    HEADER_LEN as u64 + (row_base[nib] * KEYS_STRIDE) as u64,
                )?;
                meta_file.write_all_at(
                    &meta_buf,
                    HEADER_LEN as u64 + (row_base[nib] * META_STRIDE) as u64,
                )?;
                digests_file.write_all_at(
                    &digests_buf,
                    HEADER_LEN as u64 + (row_base[nib] * DIGESTS_STRIDE) as u64,
                )?;
                body_file.write_all_at(&body_buf, HEADER_LEN as u64 + body_base[nib])?;
                ident_file.write_all_at(&ident_buf, HEADER_LEN as u64 + ident_base[nib])?;

                // A2: hash each buffer HERE, while still owned by this
                // partition's own stack frame -- immediately before
                // `keys_buf`/`meta_buf`/`digests_buf`/`body_buf`/
                // `ident_buf` drop at the end of this closure call (never
                // propagated out, never re-read from disk).
                let part_hashes = [
                    xxh::hash(&keys_buf),
                    xxh::hash(&meta_buf),
                    xxh::hash(&digests_buf),
                    xxh::hash(&body_buf),
                    xxh::hash(&ident_buf),
                ];
                Ok(part_hashes)
            })
            .collect();
        Ok((result?, hot_started.elapsed().as_millis() as u64))
    };

    // A2 (2026-09-05, Frente A.2 lever 1): `entities.index`'s own build
    // (sort + serialize + `write_framed_file`) used to run SEQUENTIALLY
    // after the other six secondary arrays inside this same closure --
    // pure queueing, since it has no data dependency on any of them. Now a
    // sibling `rayon::join` branch of `secondary_work_rest` below, so its
    // sort runs OVERLAPPED with `by_owner`/`by_name`/etc instead of after.
    let secondary_work_entities_index = || -> Result<((u64, u64), u64)> {
        let t = std::time::Instant::now();
        let (row_count, buf) = if diag_skip_entities_index() {
            (0u64, Vec::new())
        } else {
            let inferred_type_kind_id = inferred_type_kind_id(dicts);
            let mut entities_index: Vec<(u32, u32, u32)> = partitions
                .par_iter()
                .enumerate()
                .flat_map_iter(|(nib, part)| {
                    part.iter().enumerate().filter_map(move |(local, r)| {
                        is_entities_index_row(r.category, r.kind_id, inferred_type_kind_id)
                            .then_some((
                                r.owner_artifact,
                                entities_index_key_start(r),
                                global_k(&row_base, nib, local),
                            ))
                    })
                })
                .collect();
            // A2: see the flat writer's identical comment above -- packed
            // `(owner, start)` primary key, `ordinal` kept as an explicit
            // secondary key so the total order stays identical to the old
            // `par_sort_unstable()` over the full 3-tuple.
            entities_index.par_sort_unstable_by_key(|t| (((t.0 as u64) << 32) | t.1 as u64, t.2));
            let mut buf = Vec::with_capacity(entities_index.len() * TRIPLE_STRIDE);
            for (a, b, c) in &entities_index {
                let mut rec = [0u8; TRIPLE_STRIDE];
                rec[0..4].copy_from_slice(&a.to_le_bytes());
                rec[4..8].copy_from_slice(&b.to_le_bytes());
                rec[8..12].copy_from_slice(&c.to_le_bytes());
                buf.extend_from_slice(&rec);
            }
            (entities_index.len() as u64, buf)
        };
        let (bytes, xxh3) = write_framed_file(
            entities_index_path,
            TableId::Records,
            generation,
            row_count,
            &buf,
        )?;
        Ok(((bytes, xxh3), t.elapsed().as_millis() as u64))
    };

    // A1: `(secondary files' bytes/xxh3, secondary files' elapsed_ms)`.
    type SecondaryWorkResult = (
        std::collections::BTreeMap<String, (u64, u64)>,
        std::collections::BTreeMap<String, u64>,
    );
    let secondary_work_rest = || -> Result<SecondaryWorkResult> {
        let mut secondary = std::collections::BTreeMap::new();
        let mut secondary_elapsed_ms = std::collections::BTreeMap::new();

        let t = std::time::Instant::now();
        let mut by_owner: Vec<(u32, u32, u32, u32)> = partitions
            .par_iter()
            .enumerate()
            .flat_map_iter(|(nib, part)| {
                part.iter().enumerate().map(move |(local, r)| {
                    (
                        r.owner_artifact,
                        r.valid_from,
                        r.valid_to,
                        global_k(&row_base, nib, local),
                    )
                })
            })
            .collect();
        by_owner.par_sort_unstable();
        let mut buf = Vec::with_capacity(by_owner.len() * VALIDITY_QUAD_STRIDE);
        for (a, b, c, d) in &by_owner {
            buf.extend_from_slice(&a.to_le_bytes());
            buf.extend_from_slice(&b.to_le_bytes());
            buf.extend_from_slice(&c.to_le_bytes());
            buf.extend_from_slice(&d.to_le_bytes());
        }
        let (bytes, xxh3) = write_framed_file(
            by_owner_path,
            TableId::Records,
            generation,
            by_owner.len() as u64,
            &buf,
        )?;
        secondary.insert("records.by_owner".to_string(), (bytes, xxh3));
        secondary_elapsed_ms.insert(
            "records.by_owner".to_string(),
            t.elapsed().as_millis() as u64,
        );

        let t = std::time::Instant::now();
        let mut by_name: Vec<(u32, u32)> = partitions
            .par_iter()
            .enumerate()
            .flat_map_iter(|(nib, part)| {
                part.iter().enumerate().filter_map(move |(local, r)| {
                    r.name_id_opt()
                        .map(|nm| (nm, global_k(&row_base, nib, local)))
                })
            })
            .collect();
        by_name.par_sort_unstable();
        let mut buf = Vec::with_capacity(by_name.len() * PAIR2_STRIDE);
        for (a, b) in &by_name {
            buf.extend_from_slice(&a.to_le_bytes());
            buf.extend_from_slice(&b.to_le_bytes());
        }
        let (bytes, xxh3) = write_framed_file(
            by_name_path,
            TableId::Records,
            generation,
            by_name.len() as u64,
            &buf,
        )?;
        secondary.insert("records.by_name".to_string(), (bytes, xxh3));
        secondary_elapsed_ms.insert(
            "records.by_name".to_string(),
            t.elapsed().as_millis() as u64,
        );

        let t = std::time::Instant::now();
        let mut by_kind: Vec<(u16, u8, u16, u32)> = partitions
            .par_iter()
            .enumerate()
            .flat_map_iter(|(nib, part)| {
                part.iter().enumerate().map(move |(local, r)| {
                    (
                        r.universal_kind_id,
                        r.category,
                        r.kind_id,
                        global_k(&row_base, nib, local),
                    )
                })
            })
            .collect();
        by_kind.par_sort_unstable();
        let mut buf = Vec::with_capacity(by_kind.len() * BY_KIND_STRIDE);
        for (u, c, kd, k) in &by_kind {
            buf.extend_from_slice(&u.to_le_bytes());
            buf.push(*c);
            buf.extend_from_slice(&kd.to_le_bytes());
            buf.extend_from_slice(&k.to_le_bytes());
        }
        let (bytes, xxh3) = write_framed_file(
            by_kind_path,
            TableId::Records,
            generation,
            by_kind.len() as u64,
            &buf,
        )?;
        secondary.insert("records.by_kind".to_string(), (bytes, xxh3));
        secondary_elapsed_ms.insert(
            "records.by_kind".to_string(),
            t.elapsed().as_millis() as u64,
        );

        let t = std::time::Instant::now();
        let mut by_identity: Vec<([u8; 32], u32)> = partitions
            .par_iter()
            .enumerate()
            .flat_map_iter(|(nib, part)| {
                part.iter()
                    .enumerate()
                    .map(move |(local, r)| (r.identity_key_digest, global_k(&row_base, nib, local)))
            })
            .collect();
        by_identity.par_sort_unstable();
        let mut buf = Vec::with_capacity(by_identity.len() * BY_IDENTITY_STRIDE);
        for (digest, k) in &by_identity {
            buf.extend_from_slice(digest);
            buf.extend_from_slice(&k.to_le_bytes());
        }
        let (bytes, xxh3) = write_framed_file(
            by_identity_path,
            TableId::Records,
            generation,
            by_identity.len() as u64,
            &buf,
        )?;
        secondary.insert("records.by_identity".to_string(), (bytes, xxh3));
        secondary_elapsed_ms.insert(
            "records.by_identity".to_string(),
            t.elapsed().as_millis() as u64,
        );

        let t = std::time::Instant::now();
        let mut adj_out: Vec<(u32, u32, u32, u32)> = partitions
            .par_iter()
            .enumerate()
            .flat_map_iter(|(nib, part)| {
                part.iter().enumerate().filter_map(move |(local, r)| {
                    r.source_subject
                        .map(|s| (s, r.valid_from, r.valid_to, global_k(&row_base, nib, local)))
                })
            })
            .collect();
        adj_out.par_sort_unstable();
        let mut buf = Vec::with_capacity(adj_out.len() * VALIDITY_QUAD_STRIDE);
        for (a, b, c, d) in &adj_out {
            buf.extend_from_slice(&a.to_le_bytes());
            buf.extend_from_slice(&b.to_le_bytes());
            buf.extend_from_slice(&c.to_le_bytes());
            buf.extend_from_slice(&d.to_le_bytes());
        }
        let (bytes, xxh3) = write_framed_file(
            adj_out_path,
            TableId::Records,
            generation,
            adj_out.len() as u64,
            &buf,
        )?;
        secondary.insert("adj.out".to_string(), (bytes, xxh3));
        secondary_elapsed_ms.insert("adj.out".to_string(), t.elapsed().as_millis() as u64);

        let t = std::time::Instant::now();
        let mut adj_in: Vec<(u32, u32, u32, u32)> = partitions
            .par_iter()
            .enumerate()
            .flat_map_iter(|(nib, part)| {
                part.iter().enumerate().filter_map(move |(local, r)| {
                    r.target_subject
                        .map(|s| (s, r.valid_from, r.valid_to, global_k(&row_base, nib, local)))
                })
            })
            .collect();
        adj_in.par_sort_unstable();
        let mut buf = Vec::with_capacity(adj_in.len() * VALIDITY_QUAD_STRIDE);
        for (a, b, c, d) in &adj_in {
            buf.extend_from_slice(&a.to_le_bytes());
            buf.extend_from_slice(&b.to_le_bytes());
            buf.extend_from_slice(&c.to_le_bytes());
            buf.extend_from_slice(&d.to_le_bytes());
        }
        let (bytes, xxh3) = write_framed_file(
            adj_in_path,
            TableId::Records,
            generation,
            adj_in.len() as u64,
            &buf,
        )?;
        secondary.insert("adj.in".to_string(), (bytes, xxh3));
        secondary_elapsed_ms.insert("adj.in".to_string(), t.elapsed().as_millis() as u64);

        Ok((secondary, secondary_elapsed_ms))
    };

    // P2-2l item 4: profile `hot_files_work`/`secondary_work`/the header-
    // hash pass separately (this task's own brief: "per-file share: keys/
    // meta/digests/body heap/secondary arrays/xxh3/write_at"), gated
    // behind the same `URDIRA_DEBUG_TIMING` env var `writer.rs`'s own
    // `write_base_partitioned` and `write_delta_with_reader` already use.
    let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();
    let hot_and_secondary_started = std::time::Instant::now();
    // A2 (2026-09-05, Frente A.2 lever 1): three-way overlap -- the five hot
    // files, the six "plain" secondary arrays, and `entities.index` all run
    // concurrently (a `rayon::join` nested inside a `rayon::join`; rayon's
    // work-stealing scheduler treats this exactly like a flat three-way
    // fork, there is no added synchronization cost from the nesting).
    let (hot_result, (secondary_rest_result, entities_index_result)) =
        rayon::join(hot_files_work, || {
            rayon::join(secondary_work_rest, secondary_work_entities_index)
        });
    let hot_and_secondary_elapsed = hot_and_secondary_started.elapsed();
    let (per_partition_hashes, hot_elapsed_ms) = hot_result?;
    let (mut secondary, mut secondary_elapsed_ms) = secondary_rest_result?;
    let ((entities_index_bytes, entities_index_xxh3), entities_index_elapsed_ms) =
        entities_index_result?;
    secondary.insert(
        "entities.index".to_string(),
        (entities_index_bytes, entities_index_xxh3),
    );
    secondary_elapsed_ms.insert("entities.index".to_string(), entities_index_elapsed_ms);
    debug_assert_eq!(per_partition_hashes.len(), N_NIBBLES);

    // A2: combine each file's 16 per-partition hashes (computed inline,
    // above, right after that partition wrote its own buffers -- never a
    // re-read of the file) into that file's header `body_xxh3`, via
    // `hash_of_partition_hashes` -- no `mmap_file`/re-read of anything
    // here at all, closing the gap `hot_files_work`'s own doc comment
    // describes. One `rayon` task per file (five total) purely to write
    // the five headers concurrently; the hash itself is already computed.
    let header_hash_started = std::time::Instant::now();
    let header_jobs: Vec<(&'static str, &Arc<HotFile>, u64, usize)> = vec![
        ("records.keys", &keys_file, (n * KEYS_STRIDE) as u64, 0),
        ("records.meta", &meta_file, (n * META_STRIDE) as u64, 1),
        (
            "records.digests",
            &digests_file,
            (n * DIGESTS_STRIDE) as u64,
            2,
        ),
        ("records.body", &body_file, total_body, 3),
        ("records.ident", &ident_file, total_ident, 4),
    ];
    let results: Vec<Result<(&'static str, u64, u64)>> = header_jobs
        .into_par_iter()
        .map(
            |(name, file, data_len, slot)| -> Result<(&'static str, u64, u64)> {
                let mut parts = [0u64; N_NIBBLES];
                for (nib, part_hashes) in per_partition_hashes.iter().enumerate() {
                    parts[nib] = part_hashes[slot];
                }
                let hash = hash_of_partition_hashes(&parts);
                let header = FileHeader {
                    table_id: TableId::Records as u16,
                    row_count: n as u64,
                    generation,
                    body_xxh3: hash,
                }
                .encode();
                file.write_all_at(&header, 0)?;
                Ok((name, HEADER_LEN as u64 + data_len, hash))
            },
        )
        .collect();
    let header_hash_elapsed = header_hash_started.elapsed();

    let mut bytes = std::collections::BTreeMap::new();
    let mut xxh3s = std::collections::BTreeMap::new();
    for r in results {
        let (name, total, hash) = r?;
        bytes.insert(name, total);
        xxh3s.insert(name, hash);
    }

    if debug_timing {
        eprintln!(
            "[urdira-structural-store] write_hot_and_secondary_files_partitioned: hot_and_secondary(parallel)={:.3}s header_hash(parallel, no re-read)={:.3}s n={n} total_body_bytes={total_body} total_ident_bytes={total_ident}",
            hot_and_secondary_elapsed.as_secs_f64(),
            header_hash_elapsed.as_secs_f64(),
        );
    }
    // A1: per-secondary-file timing is aggregated here but PRINTED by the
    // caller (`writer::SegmentWriter::write_base_partitioned_with_pending`),
    // which also knows this generation's `fsync` time -- see the flat
    // writer's matching comment above.

    Ok(HotAndSecondaryResult {
        hot: HotFilesResult { bytes, xxh3: xxh3s },
        secondary,
        hot_elapsed_ms,
        secondary_elapsed_ms,
    })
}

// ---------------------------------------------------------------------
// Binary-search primitives over mmap'd sorted arrays (reader side).
// ---------------------------------------------------------------------

pub fn binary_search_exact32(
    n: usize,
    stride: usize,
    arr: &[u8],
    target: &[u8; 32],
) -> Option<usize> {
    let key_of = |i: usize| -> &[u8] { &arr[i * stride..i * stride + 32] };
    let mut lo = 0usize;
    let mut hi = n;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        match key_of(mid).cmp(target.as_slice()) {
            std::cmp::Ordering::Less => lo = mid + 1,
            std::cmp::Ordering::Greater => hi = mid,
            std::cmp::Ordering::Equal => return Some(mid),
        }
    }
    None
}

/// Range over a `VALIDITY_QUAD_STRIDE` array `(u32 key, u32, u32, u32)`
/// sorted by the first field. Returns `[lo, hi)` row indices.
pub fn quad_key_range(arr: &[u8], target: u32) -> (usize, usize) {
    let n = arr.len() / VALIDITY_QUAD_STRIDE;
    let key_of = |i: usize| u32le(arr, i * VALIDITY_QUAD_STRIDE);
    let lo = lower_bound(n, |i| key_of(i).cmp(&target));
    let hi = upper_bound(n, |i| key_of(i).cmp(&target));
    (lo, hi)
}

pub fn quad_at(arr: &[u8], i: usize) -> (u32, u32, u32, u32) {
    let base = i * VALIDITY_QUAD_STRIDE;
    (
        u32le(arr, base),
        u32le(arr, base + 4),
        u32le(arr, base + 8),
        u32le(arr, base + 12),
    )
}

pub fn pair2_key_range(arr: &[u8], target: u32) -> (usize, usize) {
    let n = arr.len() / PAIR2_STRIDE;
    let key_of = |i: usize| u32le(arr, i * PAIR2_STRIDE);
    let lo = lower_bound(n, |i| key_of(i).cmp(&target));
    let hi = upper_bound(n, |i| key_of(i).cmp(&target));
    (lo, hi)
}

pub fn pair2_at(arr: &[u8], i: usize) -> (u32, u32) {
    let base = i * PAIR2_STRIDE;
    (u32le(arr, base), u32le(arr, base + 4))
}

pub fn by_kind_range(
    arr: &[u8],
    universal_kind_id: u16,
    category: u8,
    kind_id: u16,
) -> (usize, usize) {
    let n = arr.len() / BY_KIND_STRIDE;
    let key_of = |i: usize| -> (u16, u8, u16) {
        let rec = &arr[i * BY_KIND_STRIDE..(i + 1) * BY_KIND_STRIDE];
        (u16le(rec, 0), rec[2], u16le(rec, 3))
    };
    let target = (universal_kind_id, category, kind_id);
    let lo = lower_bound(n, |i| key_of(i).cmp(&target));
    let hi = upper_bound(n, |i| key_of(i).cmp(&target));
    (lo, hi)
}

pub fn by_kind_ordinal_at(arr: &[u8], i: usize) -> u32 {
    u32le(arr, i * BY_KIND_STRIDE + 5)
}

/// Frente Q-3 (2026-09-08): `by_kind`'s rows are sorted by the exact
/// `(universal_kind_id, category, kind_id)` triple, so every row sharing
/// one `(universal_kind_id, category)` prefix -- regardless of `kind_id` --
/// is CONTIGUOUS in this array. `core:inspect_architecture`'s pushdown
/// (`tryInspectArchitecturePushdown`, `packages/engine/src/canonical-query-
/// data-port.ts`) wants "every entity of universal_kind X", not one exact
/// `kind`, and the language-neutral engine layer has no registry mapping a
/// universal_kind to its own producer-specific `kind` strings to enumerate
/// (that mapping is plugin-local, e.g. `packages/plugin-javascript-
/// typescript/src/registry-contribution.ts`'s `recordKind` calls) -- so
/// `NativeCanonicalQuerySnapshotPort.records_by_selector`'s existing
/// "kinds omitted" default (`dicts.kinds`, EVERY kind string in the WHOLE
/// store, not scoped to the requested universal_kind) blew its own
/// `SELECTOR_COMBO_CAP` and silently fell back to a full-corpus
/// `scanAll` -- measured live on n8n (2,198,601 records): 26.4-30.1s for
/// two such calls (`core:container`/`core:type`), the exact "full scan
/// disguised as a bounded call" shape `records_by_selector`'s own decline-
/// to-scan fallback was supposed to make rare, not routine. This prefix
/// range lets the TS port answer "any kind" directly from the index
/// instead, in one O(log n + result size) lookup per segment.
pub fn by_kind_universal_range(arr: &[u8], universal_kind_id: u16, category: u8) -> (usize, usize) {
    let n = arr.len() / BY_KIND_STRIDE;
    let key_of = |i: usize| -> (u16, u8) {
        let rec = &arr[i * BY_KIND_STRIDE..(i + 1) * BY_KIND_STRIDE];
        (u16le(rec, 0), rec[2])
    };
    let target = (universal_kind_id, category);
    let lo = lower_bound(n, |i| key_of(i).cmp(&target));
    let hi = upper_bound(n, |i| key_of(i).cmp(&target));
    (lo, hi)
}

/// F4 4.3: range over an `entities.index` array `(owner_artifact u32,
/// span_start u32, ordinal u32)` sorted by `(owner_artifact, span_start)`.
/// Returns `[lo, hi)` row indices -- ordinarily 0 or 1 wide (an owner's
/// entity producer never emits two live `CATEGORY_ENTITY` rows starting at
/// the same byte within one generation; see `entities_index_triples`'s own
/// doc comment for the one exclusion this relies on), never assumed to be
/// exactly 1 by the caller.
pub fn triple_key_range(arr: &[u8], owner_artifact: u32, span_start: u32) -> (usize, usize) {
    let n = arr.len() / TRIPLE_STRIDE;
    let key_of = |i: usize| -> (u32, u32) {
        let base = i * TRIPLE_STRIDE;
        (u32le(arr, base), u32le(arr, base + 4))
    };
    let target = (owner_artifact, span_start);
    let lo = lower_bound(n, |i| key_of(i).cmp(&target));
    let hi = upper_bound(n, |i| key_of(i).cmp(&target));
    (lo, hi)
}

pub fn triple_ordinal_at(arr: &[u8], i: usize) -> u32 {
    u32le(arr, i * TRIPLE_STRIDE + 8)
}

/// F4 4.3: `dicts.kinds`' ordinal for `"jsts:entity_inferred_type"`, if this
/// batch's dictionaries have interned it at all. Shared by every
/// `entities.index` builder ([`write_hot_and_secondary_files`],
/// [`write_hot_and_secondary_files_partitioned`], and `writer::
/// build_delta_sections`) so the exclusion rule (an inferred-type row
/// deliberately shares its declaration's own `(owner, start)` key, and must
/// never win that slot in the index -- see `crate::identity_codec`'s A3a-fix
/// note, and `urdira-indexing-worker`'s `v4::residual::collect`, whose
/// identical exclusion this section replaces at read time) lives in exactly
/// one place instead of three copies of the same string comparison.
pub fn inferred_type_kind_id(dicts: &Dictionaries) -> Option<u16> {
    dicts
        .kinds
        .iter()
        .position(|k| k == "jsts:entity_inferred_type")
        .map(|i| i as u16)
}

/// Frente E-P0j (2026-09-07): the `entities.index` sort/lookup key for one
/// entity row -- the record's own NAME-IDENTIFIER start, recovered from its
/// `identity_key` text (see `identity_codec::entity_identity_name_start`'s
/// doc comment for why this crate no longer uses `RecordRow::span_start_
/// byte` here: that field moved to the WHOLE DECLARATION's span this task,
/// but `entities.index`/`StoreReader::entity_by_owner_and_start` -- and,
/// through it, `urdira-indexing-worker::v4::residual`'s checker-site
/// correlation -- both still need the identifier's own position). Falls
/// back to `r.span_start_byte` when the identity text has no parseable
/// start segment (`jsts:external_module:*`/`jsts:external_symbol:*`, whose
/// `span_start_byte` is always `0` anyway -- see that function's own doc
/// comment) so every entity row still gets SOME deterministic key, matching
/// this index's pre-existing behavior for those two kinds exactly.
#[inline]
fn entities_index_key_start(row: &RecordRow) -> u32 {
    identity_codec::entity_identity_name_start(&row.identity_key).unwrap_or(row.span_start_byte)
}

/// F4 4.3: `true` for exactly the rows `entities.index` carries -- a
/// `CATEGORY_ENTITY` row whose `kind_id` is not `inferred_type_kind_id`.
#[inline]
pub fn is_entities_index_row(
    category: u8,
    kind_id: u16,
    inferred_type_kind_id: Option<u16>,
) -> bool {
    category == CATEGORY_ENTITY && Some(kind_id) != inferred_type_kind_id
}

pub fn by_identity_range(arr: &[u8], digest: &[u8; 32]) -> (usize, usize) {
    let n = arr.len() / BY_IDENTITY_STRIDE;
    let key_of = |i: usize| -> &[u8] { &arr[i * BY_IDENTITY_STRIDE..i * BY_IDENTITY_STRIDE + 32] };
    let lo = lower_bound(n, |i| key_of(i).cmp(digest.as_slice()));
    let hi = upper_bound(n, |i| key_of(i).cmp(digest.as_slice()));
    (lo, hi)
}

pub fn by_identity_ordinal_at(arr: &[u8], i: usize) -> u32 {
    u32le(arr, i * BY_IDENTITY_STRIDE + 32)
}

pub fn deps_reverse_range(arr: &[u8], dep_artifact: u32) -> (usize, usize) {
    let n = arr.len() / DEPS_REVERSE_STRIDE;
    let key_of = |i: usize| u32le(arr, i * DEPS_REVERSE_STRIDE);
    let lo = lower_bound(n, |i| key_of(i).cmp(&dep_artifact));
    let hi = upper_bound(n, |i| key_of(i).cmp(&dep_artifact));
    (lo, hi)
}

pub fn deps_reverse_ordinal_at(arr: &[u8], i: usize) -> u32 {
    u32le(arr, i * DEPS_REVERSE_STRIDE + 4)
}

/// Range over `pending.sites`' sorted `(owner_artifact, start, end,
/// site_kind)` array, by `owner_artifact` alone. Since `owner_artifact` is
/// the PRIMARY sort key (not a secondary index the way `records.by_owner`
/// is over `records.*`), every row for one owner is already a contiguous
/// range in the base array itself -- no separate index file is needed.
pub fn pending_site_owner_range(arr: &[u8], owner_artifact: u32) -> (usize, usize) {
    let n = arr.len() / PENDING_SITE_STRIDE;
    let key_of = |i: usize| u32le(arr, i * PENDING_SITE_STRIDE + pending_sites::OWNER_ARTIFACT);
    let lo = lower_bound(n, |i| key_of(i).cmp(&owner_artifact));
    let hi = upper_bound(n, |i| key_of(i).cmp(&owner_artifact));
    (lo, hi)
}

/// Range over `pending.sites` by the FULL identity key `(owner_artifact,
/// start, end, site_kind)` -- at most one row per segment (duplicate keys
/// within one segment are rejected at write time), but returns a range
/// rather than an `Option<usize>` so callers can use the same `lo..hi`
/// idiom every other range lookup in this module uses.
pub fn pending_site_key_range(arr: &[u8], key: &PendingSiteKey) -> (usize, usize) {
    let n = arr.len() / PENDING_SITE_STRIDE;
    let key_of = |i: usize| -> (u32, u32, u32, u8) {
        let base = i * PENDING_SITE_STRIDE;
        (
            u32le(arr, base + pending_sites::OWNER_ARTIFACT),
            u32le(arr, base + pending_sites::START),
            u32le(arr, base + pending_sites::END),
            arr[base + pending_sites::SITE_KIND],
        )
    };
    let target = (key.owner_artifact, key.start, key.end, key.site_kind);
    let lo = lower_bound(n, |i| key_of(i).cmp(&target));
    let hi = upper_bound(n, |i| key_of(i).cmp(&target));
    (lo, hi)
}

pub fn pending_site_key_at(arr: &[u8], i: usize) -> PendingSiteKey {
    let base = i * PENDING_SITE_STRIDE;
    PendingSiteKey {
        owner_artifact: u32le(arr, base + pending_sites::OWNER_ARTIFACT),
        start: u32le(arr, base + pending_sites::START),
        end: u32le(arr, base + pending_sites::END),
        site_kind: arr[base + pending_sites::SITE_KIND],
    }
}

/// P3-6: one segment "file" as seen by [`crate::reader::Segment`] --
/// either a whole-file mmap (base segments, still one file per logical
/// name, unchanged) or a byte-range view into a shared delta-container
/// mmap (`crate::container`), which packs every logical section of one
/// delta generation into a single `delta-<g>.seg` file. Every existing
/// accessor in this crate indexes its segment fields as plain byte slices
/// (`&self.keys[HEADER_LEN..]`, `header_and_data(&self.keys)`, ...); since
/// `SectionSource` derefs to `[u8]` exactly like `Mmap` already did, none
/// of that decoding code needed to change -- only the field type.
///
/// F1 1.2: `File` wraps an `Arc<Mmap>` (not a bare `Mmap`) so the whole
/// type is cheaply `Clone` (an `Arc` bump either way) -- `StoreInner::
/// extend`'s incremental reopen reconstructs every PREVIOUS segment with
/// freshly fused closures maps by cloning its `SectionSource` fields
/// rather than re-mmapping/re-scanning them, and that clone needs to work
/// for a base (`Dir`-backed, `File`) segment exactly as cheaply as for a
/// delta (`Container`-backed) one.
#[derive(Clone)]
pub enum SectionSource {
    File(Arc<Mmap>),
    Container {
        mmap: Arc<Mmap>,
        start: usize,
        end: usize,
    },
}

impl std::ops::Deref for SectionSource {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        match self {
            SectionSource::File(m) => m,
            SectionSource::Container { mmap, start, end } => &mmap[*start..*end],
        }
    }
}
