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
//! [`std::os::unix::fs::FileExt::write_all_at`], never the single-shot
//! [`std::os::unix::fs::FileExt::write_at`]. `write_at` wraps exactly one
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
use crate::row::{Dictionaries, NONE_U32, PendingSiteKey, RecordRow};
use crate::xxh;
use memmap2::Mmap;
use rayon::prelude::*;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::sync::Arc;

pub const N_NIBBLES: usize = 16;

pub fn nibble_of(record_id: &[u8; 32]) -> usize {
    (record_id[0] >> 4) as usize
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

/// P2-2m: force REAL (non-sparse) block allocation for every byte of a
/// freshly `create_sized` file, single-threaded, before this function's
/// caller hands the same `File` to several threads/rayon tasks that will
/// each `write_all_at` a DISJOINT byte range of it CONCURRENTLY.
///
/// `create_sized` above is `set_len`-only (a pure `ftruncate`): on most
/// filesystems this creates a SPARSE hole, with no real disk blocks
/// allocated yet -- allocation happens lazily, on first write into a given
/// range. This crate's writer then routinely hands that one sparse file to
/// `N_NIBBLES` (or `n_threads`) independent workers, each writing its own
/// disjoint slice concurrently. Root-caused live against the real n8n
/// corpus (see this task's evidence doc): under load, a rare filesystem-
/// level race in concurrent lazy block allocation for a single sparse file
/// can leave ONE worker's own bytes unmaterialized -- silently reverted to
/// the pre-`set_len` hole (all-zero) -- even though that worker's own
/// `write_at`/`write_all_at` call reported success. The signature this bug
/// produces (a field decoding as all-zero bytes of the CORRECT length,
/// silently, no error) is indistinguishable from a real all-zero value
/// without independent knowledge of what should have been there, which is
/// exactly what made it so hard to pin down.
///
/// Writing real content across the WHOLE file exactly ONCE, single-
/// threaded, before any concurrent writer starts, forces every block to
/// be genuinely allocated up front. Every later `write_at` call then only
/// OVERWRITES already-allocated blocks -- ordinary in-place overwrites,
/// which (unlike extending a sparse file) never need to update any
/// allocation/extent metadata, so there is no allocation race left for
/// concurrent writers to lose. This closes the bug regardless of the exact
/// kernel/filesystem mechanism behind it (not root-caused deeper than
/// "concurrent sparse-file allocation" -- doing so would require
/// instrumenting the kernel/filesystem itself, out of this crate's reach).
fn materialize_real(file: &File, len: u64) -> std::io::Result<()> {
    const CHUNK: usize = 8 * 1024 * 1024;
    if len == 0 {
        return Ok(());
    }
    let zeros = vec![0u8; CHUNK.min(len as usize)];
    let mut written = 0u64;
    while written < len {
        let take = CHUNK.min((len - written) as usize);
        file.write_all_at(&zeros[..take], written)?;
        written += take as u64;
    }
    Ok(())
}

/// P2-2m: [`create_sized`] + [`materialize_real`] for exactly the five
/// `records.*` hot files this module's two writers (`write_hot_and_
/// secondary_files`/`_partitioned`) both build, with materialization done
/// in PARALLEL across the five (independent) files rather than serially --
/// each file's own materialization is single-threaded internally (that is
/// what closes the race), but nothing prevents the five different files
/// from being materialized at the same time as each other.
fn create_sized_hot_files(specs: [(&Path, u64); 5]) -> Result<[Arc<File>; 5]> {
    let files: Vec<Arc<File>> = specs
        .par_iter()
        .map(|(path, len)| -> Result<Arc<File>> {
            let file = create_sized(path, *len)?;
            materialize_real(&file, *len)?;
            Ok(Arc::new(file))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(files.try_into().unwrap_or_else(|_| unreachable!()))
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
        f.sync_all()?;
    }
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
    let mut layouts = vec![IDENTITY_LAYOUT_RAW; n];
    for (k, layout) in layouts.iter_mut().enumerate() {
        let row = &rows[order[k] as usize];
        *layout = identity_codec::classify_identity_layout(row, dicts, &resolve_identity);
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

    let n_threads = n_threads.max(1);
    let mut partitions_per_thread: Vec<Vec<usize>> = vec![Vec::new(); n_threads];
    for nib in 0..N_NIBBLES {
        partitions_per_thread[nib % n_threads].push(nib);
    }

    type NibbleBuffers = (usize, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>);
    enum Work {
        Hot(Vec<NibbleBuffers>),
        Secondary(&'static str, u64, u64),
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
            let nibble_start = nibble_start;

            handles.push(scope.spawn(move || -> Result<Work> {
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
                Ok(Work::Hot(out))
            }));
        }

        handles.push(scope.spawn(|| -> Result<Work> {
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
            Ok(Work::Secondary("records.by_owner", bytes, xxh3))
        }));

        handles.push(scope.spawn(|| -> Result<Work> {
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
            Ok(Work::Secondary("records.by_name", bytes, xxh3))
        }));

        handles.push(scope.spawn(|| -> Result<Work> {
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
            Ok(Work::Secondary("records.by_kind", bytes, xxh3))
        }));

        handles.push(scope.spawn(|| -> Result<Work> {
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
            Ok(Work::Secondary("records.by_identity", bytes, xxh3))
        }));

        handles.push(scope.spawn(|| -> Result<Work> {
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
            Ok(Work::Secondary("adj.out", bytes, xxh3))
        }));

        handles.push(scope.spawn(|| -> Result<Work> {
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
            Ok(Work::Secondary("adj.in", bytes, xxh3))
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
    for outcome in outcomes {
        match outcome? {
            Work::Hot(mut v) => nibble_buffers.append(&mut v),
            Work::Secondary(name, bytes, xxh3) => {
                secondary.insert(name.to_string(), (bytes, xxh3));
            }
        }
    }
    nibble_buffers.sort_unstable_by_key(|(nib, ..)| *nib);
    let ordered = nibble_buffers;

    let mut bytes = std::collections::BTreeMap::new();
    let mut xxh3s = std::collections::BTreeMap::new();
    let header_jobs: [(&'static str, &Arc<File>, u64); 5] = [
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
                    let mut hasher = xxhash_rust::xxh3::Xxh3::new();
                    for entry in ordered {
                        let buf: &Vec<u8> = match slot {
                            0 => &entry.1,
                            1 => &entry.2,
                            2 => &entry.3,
                            3 => &entry.4,
                            _ => &entry.5,
                        };
                        hasher.update(buf);
                    }
                    let hash = hasher.digest();
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

    Ok(HotAndSecondaryResult {
        hot: HotFilesResult { bytes, xxh3: xxh3s },
        secondary,
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
) -> Result<HotAndSecondaryResult> {
    assert_eq!(
        partitions.len(),
        N_NIBBLES,
        "write_hot_and_secondary_files_partitioned requires exactly N_NIBBLES partitions"
    );

    // A3a: the batch index (`record_id -> identity_key bytes`, spanning
    // EVERY partition) must exist before any per-partition work starts --
    // a relation in partition N may point at an entity in partition M != N
    // -- so it's built here, once, and shared by reference into the
    // `par_iter` below (never rebuilt per partition).
    let batch_index = BatchIndex::from_partitions(partitions);
    let resolve_identity = |id: &[u8; 32]| batch_index.get(id);
    // `layouts[nib][local]` mirrors `partitions[nib][local]`, classified
    // once here (single pass, still cheap relative to the I/O this
    // function does) and reused by both this prefix-sum loop and the
    // per-partition write loop below -- never re-classified per row.
    let layouts: Vec<Vec<u8>> = partitions
        .iter()
        .map(|part| {
            part.iter()
                .map(|row| identity_codec::classify_identity_layout(row, dicts, &resolve_identity))
                .collect()
        })
        .collect();

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

    // P2-2j item 4 (RSS): unlike `write_hot_and_secondary_files`'s own
    // `nibble_buffers` (which keeps every nibble's FULL encoded buffers
    // alive until a final header-hash pass re-walks them, doubling live
    // memory for the whole `records.*` byte volume -- confirmed live as a
    // meaningful share of this task's own measured RSS at n8n scale, see
    // the evidence doc), each partition's buffers here are written to disk
    // and then DROPPED immediately (end of this closure's scope) -- never
    // returned, never kept alive past their own `write_at` calls. The
    // whole-file xxh3 hash is computed afterward straight off the just-
    // written FILE via `mmap_file` (`write_and_hash_hot_files`, below,
    // called after this closure and `secondary_work` both finish) instead
    // of a second in-memory copy: `write_at`'s pages are already resident
    // in this process's page cache, so the mmap read is not a real disk
    // read, just a different view onto memory this process already holds
    // ONE copy of instead of two.
    let hot_files_work = || -> Result<()> {
        partitions
            .par_iter()
            .enumerate()
            .map(|(nib, part)| -> Result<()> {
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

                // `keys_buf`/`meta_buf`/`digests_buf`/`body_buf`/`ident_buf`
                // drop here, at the end of this partition's own closure
                // call -- never propagated out.
                Ok(())
            })
            .collect()
    };

    let secondary_work = || -> Result<std::collections::BTreeMap<String, (u64, u64)>> {
        let mut secondary = std::collections::BTreeMap::new();

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

        Ok(secondary)
    };

    // P2-2l item 4: profile `hot_files_work`/`secondary_work`/the header-
    // hash pass separately (this task's own brief: "per-file share: keys/
    // meta/digests/body heap/secondary arrays/xxh3/write_at"), gated
    // behind the same `URDIRA_DEBUG_TIMING` env var `writer.rs`'s own
    // `write_base_partitioned` and `write_delta_with_reader` already use.
    let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();
    let hot_and_secondary_started = std::time::Instant::now();
    let (hot_result, secondary_result) = rayon::join(hot_files_work, secondary_work);
    let hot_and_secondary_elapsed = hot_and_secondary_started.elapsed();
    hot_result?;
    let secondary = secondary_result?;

    // P2-2j item 4 (RSS): hash each hot file's DATA region straight off an
    // mmap of the file this function itself just wrote (`write_hot_and_
    // secondary_files`'s own header-hash pass keeps every nibble's encoded
    // buffer alive in a `Vec` for exactly this purpose -- see this
    // function's own module-level doc comment for the measured RSS cost).
    // The pages are already resident in this process's page cache (they
    // were just written via `write_at`, not fsynced -- no real disk I/O
    // happens here), so this is a second VIEW onto memory already held,
    // not a second in-memory COPY. One `rayon` task per file (five total).
    let header_jobs: Vec<(&'static str, &Path, &Arc<File>, u64)> = vec![
        (
            "records.keys",
            &keys_path,
            &keys_file,
            (n * KEYS_STRIDE) as u64,
        ),
        (
            "records.meta",
            &meta_path,
            &meta_file,
            (n * META_STRIDE) as u64,
        ),
        (
            "records.digests",
            &digests_path,
            &digests_file,
            (n * DIGESTS_STRIDE) as u64,
        ),
        ("records.body", &body_path, &body_file, total_body),
        ("records.ident", &ident_path, &ident_file, total_ident),
    ];
    let header_hash_started = std::time::Instant::now();
    let mut per_file_hash_ms: Vec<(&'static str, f64)> = Vec::new();
    let results: Vec<Result<(&'static str, u64, u64, f64)>> = header_jobs
        .into_par_iter()
        .map(
            |(name, path, file, data_len)| -> Result<(&'static str, u64, u64, f64)> {
                let file_started = std::time::Instant::now();
                let hash = if data_len == 0 {
                    xxh::hash(&[])
                } else {
                    let mapped = mmap_file(path)?;
                    let data_start = HEADER_LEN;
                    let data_end = data_start + data_len as usize;
                    xxh::hash(&mapped[data_start..data_end])
                };
                let header = FileHeader {
                    table_id: TableId::Records as u16,
                    row_count: n as u64,
                    generation,
                    body_xxh3: hash,
                }
                .encode();
                file.write_all_at(&header, 0)?;
                Ok((
                    name,
                    HEADER_LEN as u64 + data_len,
                    hash,
                    file_started.elapsed().as_secs_f64() * 1_000.0,
                ))
            },
        )
        .collect();
    let header_hash_elapsed = header_hash_started.elapsed();

    let mut bytes = std::collections::BTreeMap::new();
    let mut xxh3s = std::collections::BTreeMap::new();
    for r in results {
        let (name, total, hash, hash_ms) = r?;
        bytes.insert(name, total);
        xxh3s.insert(name, hash);
        per_file_hash_ms.push((name, hash_ms));
    }

    if debug_timing {
        let per_file: String = per_file_hash_ms
            .iter()
            .map(|(name, ms)| format!("{name}={ms:.1}ms"))
            .collect::<Vec<_>>()
            .join(" ");
        eprintln!(
            "[urdira-structural-store] write_hot_and_secondary_files_partitioned: hot_and_secondary(parallel)={:.3}s header_hash(parallel)={:.3}s [{per_file}] n={n} total_body_bytes={total_body} total_ident_bytes={total_ident}",
            hot_and_secondary_elapsed.as_secs_f64(),
            header_hash_elapsed.as_secs_f64(),
        );
    }

    Ok(HotAndSecondaryResult {
        hot: HotFilesResult { bytes, xxh3: xxh3s },
        secondary,
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
pub enum SectionSource {
    File(Mmap),
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
