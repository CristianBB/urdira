//! replay-c: the v4 segment store. A directory of fixed-width files written
//! in parallel (10 threads for the top-nibble-partitioned records.* files;
//! a handful more for the secondary sorted index arrays, since those need a
//! full-set sort and don't partition cleanly by nibble), read back via
//! `memmap2` + binary search.

use crate::AnyResult;
use crate::layout::*;
use crate::order::pk_order;
use crate::row::{NONE_U32, Row, Store};
use crate::util::{Timings, dir_size, fsync_path, remove_if_exists};
use memmap2::{Mmap, MmapOptions};
use std::fs::{File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::FileExt as UnixFileExt;
#[cfg(windows)]
use std::os::windows::fs::FileExt as WindowsFileExt;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

const N_PARTITION_THREADS: usize = 10;
const N_NIBBLES: usize = 16;

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

fn nibble_of(record_id: &[u8; 32]) -> usize {
    (record_id[0] >> 4) as usize
}

fn write_str_dict(w: &mut impl Write, values: &[String]) -> std::io::Result<()> {
    w.write_all(&(values.len() as u32).to_le_bytes())?;
    for v in values {
        let b = v.as_bytes();
        w.write_all(&(b.len() as u32).to_le_bytes())?;
        w.write_all(b)?;
    }
    Ok(())
}

/// Writes all bytes at a fixed offset using the platform's positional API.
/// The Windows and Unix implementations both permit short writes, so retry
/// until the complete buffer is durable or a real error occurs.
fn write_all_at(file: &File, bytes: &[u8], mut offset: u64) -> std::io::Result<()> {
    let mut written = 0usize;
    while written < bytes.len() {
        #[cfg(unix)]
        let count = UnixFileExt::write_at(file, &bytes[written..], offset)?;
        #[cfg(windows)]
        let count = WindowsFileExt::seek_write(file, &bytes[written..], offset)?;
        if count == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "positional write made no progress",
            ));
        }
        written += count;
        offset += count as u64;
    }
    Ok(())
}

pub fn run(store: &Store, out_dir: &Path) -> AnyResult<Timings> {
    remove_if_exists(out_dir);
    std::fs::create_dir_all(out_dir)?;

    let t0 = Instant::now();
    let order = pk_order(&store.rows); // order[k] = original row index at sorted position k
    let n = order.len();

    // Partition boundaries by top nibble of record_id (contiguous, since
    // `order` is sorted by record_id and the nibble is the top 4 bits).
    let mut nibble_start = [n; N_NIBBLES + 1];
    {
        let mut cur = 0usize;
        for (nib, slot) in nibble_start.iter_mut().enumerate().take(N_NIBBLES) {
            *slot = cur;
            while cur < n && nibble_of(&store.rows[order[cur] as usize].record_id) == nib {
                cur += 1;
            }
        }
        nibble_start[N_NIBBLES] = n;
    }

    // Precompute per-row heap offsets for body_payload and identity_key
    // (global prefix sum over sorted order).
    let mut body_off = vec![0u64; n];
    let mut ident_off = vec![0u64; n];
    let mut cur_body = 0u64;
    let mut cur_ident = 0u64;
    for k in 0..n {
        let row = &store.rows[order[k] as usize];
        body_off[k] = cur_body;
        cur_body += row.body_payload.len() as u64;
        ident_off[k] = cur_ident;
        cur_ident += row.identity_key.len() as u64;
    }
    let total_body = cur_body;
    let total_ident = cur_ident;

    let keys_file = Arc::new(create_sized(
        &out_dir.join("records.keys"),
        (n * KEYS_STRIDE) as u64,
    )?);
    let meta_file = Arc::new(create_sized(
        &out_dir.join("records.meta"),
        (n * META_STRIDE) as u64,
    )?);
    let digests_file = Arc::new(create_sized(
        &out_dir.join("records.digests"),
        (n * DIGESTS_STRIDE) as u64,
    )?);
    let body_file = Arc::new(create_sized(&out_dir.join("records.body"), total_body)?);
    let ident_file = Arc::new(create_sized(&out_dir.join("records.ident"), total_ident)?);

    // Assign the 16 nibble-partitions round-robin across N_PARTITION_THREADS.
    let mut partitions_per_thread: Vec<Vec<usize>> = vec![Vec::new(); N_PARTITION_THREADS];
    for nib in 0..N_NIBBLES {
        partitions_per_thread[nib % N_PARTITION_THREADS].push(nib);
    }

    struct SendPtr<T>(*const T);
    unsafe impl<T> Send for SendPtr<T> {}
    impl<T> SendPtr<T> {
        fn get(&self) -> *const T {
            self.0
        }
    }
    let rows_ptr = SendPtr(&store.rows as *const Vec<Row>);
    let order_ptr = SendPtr(&order as *const Vec<u32>);
    let body_off_ptr = SendPtr(body_off.as_ptr());
    let ident_off_ptr = SendPtr(ident_off.as_ptr());

    let mut handles = Vec::new();
    for nibs in partitions_per_thread {
        if nibs.is_empty() {
            continue;
        }
        let keys_file = Arc::clone(&keys_file);
        let meta_file = Arc::clone(&meta_file);
        let digests_file = Arc::clone(&digests_file);
        let body_file = Arc::clone(&body_file);
        let ident_file = Arc::clone(&ident_file);
        let nibble_start = nibble_start;
        let rows_ptr = SendPtr(rows_ptr.0);
        let order_ptr = SendPtr(order_ptr.0);
        let body_off_ptr = SendPtr(body_off_ptr.0);
        let ident_off_ptr = SendPtr(ident_off_ptr.0);

        handles.push(std::thread::spawn(move || -> std::io::Result<()> {
            let rows: &Vec<Row> = unsafe { &*rows_ptr.get() };
            let order: &Vec<u32> = unsafe { &*order_ptr.get() };
            let body_off: &[u64] =
                unsafe { std::slice::from_raw_parts(body_off_ptr.get(), order.len()) };
            let ident_off: &[u64] =
                unsafe { std::slice::from_raw_parts(ident_off_ptr.get(), order.len()) };

            for nib in nibs {
                let start = nibble_start[nib];
                let end = nibble_start[nib + 1];
                if start == end {
                    continue;
                }
                let mut keys_buf = vec![0u8; (end - start) * KEYS_STRIDE];
                let mut meta_buf = vec![0u8; (end - start) * META_STRIDE];
                let mut digests_buf = vec![0u8; (end - start) * DIGESTS_STRIDE];
                // body_off/ident_off are a global prefix sum over the whole
                // sorted row order, so this partition's rows occupy one
                // contiguous byte range in records.body/records.ident.
                // Build each partition's heap bytes in one buffer and issue
                // a single write_at per file instead of one per row --
                // 2 syscalls per partition instead of ~2 per row.
                let mut body_buf = Vec::with_capacity(
                    (body_off[end - 1] - body_off[start]) as usize
                        + rows[order[end - 1] as usize].body_payload.len(),
                );
                let mut ident_buf = Vec::with_capacity(
                    (ident_off[end - 1] - ident_off[start]) as usize
                        + rows[order[end - 1] as usize].identity_key.len(),
                );

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
                    put_u32le(m, meta::FACETS, row.facets);
                    put_u32le(m, meta::SPAN_ARTIFACT_VERSION, row.span_artifact_version);
                    put_u32le(m, meta::SPAN_START_BYTE, row.span_start_byte);
                    put_u32le(m, meta::SPAN_END_BYTE, row.span_end_byte);
                    put_u32le(m, meta::SPAN_START_LINE, row.span_start_line);
                    put_u32le(m, meta::SPAN_END_LINE, row.span_end_line);
                    m[meta::IDENTITY_TYPE] = row.identity_type;
                    m[meta::ASSIGNMENT_KIND] = row.assignment_kind;
                    put_u32le(m, meta::NAME_ID, row.name_id);
                    put_u32le(m, meta::SOURCE_SUBJECT, row.source_subject);
                    put_u32le(m, meta::TARGET_SUBJECT, row.target_subject);
                    put_u16le(m, meta::RELATION_KIND_ID, row.relation_kind_id);
                    put_u64le(m, meta::BODY_OFF, body_off[k]);
                    put_u32le(m, meta::BODY_LEN, row.body_payload.len() as u32);
                    put_u64le(m, meta::IDENT_OFF, ident_off[k]);
                    put_u32le(m, meta::IDENT_LEN, row.identity_key.len() as u32);

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

                    body_buf.extend_from_slice(&row.body_payload);
                    ident_buf.extend_from_slice(&row.identity_key);
                }

                write_all_at(&keys_file, &keys_buf, (start * KEYS_STRIDE) as u64)?;
                write_all_at(&meta_file, &meta_buf, (start * META_STRIDE) as u64)?;
                write_all_at(&digests_file, &digests_buf, (start * DIGESTS_STRIDE) as u64)?;
                write_all_at(&body_file, &body_buf, body_off[start])?;
                write_all_at(&ident_file, &ident_buf, ident_off[start])?;
            }
            Ok(())
        }));
    }

    // Secondary sorted index arrays: each needs a full-set sort, built
    // concurrently with (not partitioned like) the records.* writers above.
    let by_owner_path = out_dir.join("records.by_owner");
    let by_name_path = out_dir.join("records.by_name");
    let by_kind_path = out_dir.join("records.by_kind");
    let by_identity_path = out_dir.join("records.by_identity");
    let adj_out_path = out_dir.join("adj.out");
    let adj_in_path = out_dir.join("adj.in");
    let subjects_path = out_dir.join("subjects.keys");
    let dict_path = out_dir.join("dictionaries.bin");

    handles.push(std::thread::spawn({
        let rows_ptr = SendPtr(rows_ptr.0);
        let order_ptr = SendPtr(order_ptr.0);
        let path = by_owner_path.clone();
        move || -> std::io::Result<()> {
            let rows: &Vec<Row> = unsafe { &*rows_ptr.get() };
            let order: &Vec<u32> = unsafe { &*order_ptr.get() };
            let mut pairs: Vec<(u32, u32)> = order
                .iter()
                .enumerate()
                .map(|(k, &i)| (rows[i as usize].owner_artifact, k as u32))
                .collect();
            pairs.sort_unstable();
            write_pairs(&path, &pairs)
        }
    }));

    handles.push(std::thread::spawn({
        let rows_ptr = SendPtr(rows_ptr.0);
        let order_ptr = SendPtr(order_ptr.0);
        let path = by_name_path.clone();
        move || -> std::io::Result<()> {
            let rows: &Vec<Row> = unsafe { &*rows_ptr.get() };
            let order: &Vec<u32> = unsafe { &*order_ptr.get() };
            let mut pairs: Vec<(u32, u32)> = order
                .iter()
                .enumerate()
                .filter_map(|(k, &i)| {
                    let name = rows[i as usize].name_id;
                    (name != NONE_U32).then_some((name, k as u32))
                })
                .collect();
            pairs.sort_unstable();
            write_pairs(&path, &pairs)
        }
    }));

    handles.push(std::thread::spawn({
        let rows_ptr = SendPtr(rows_ptr.0);
        let order_ptr = SendPtr(order_ptr.0);
        let path = by_kind_path.clone();
        move || -> std::io::Result<()> {
            let rows: &Vec<Row> = unsafe { &*rows_ptr.get() };
            let order: &Vec<u32> = unsafe { &*order_ptr.get() };
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
            for (u, c, kd, k) in keys {
                buf.extend_from_slice(&u.to_le_bytes());
                buf.push(c);
                buf.extend_from_slice(&kd.to_le_bytes());
                buf.extend_from_slice(&k.to_le_bytes());
            }
            std::fs::write(&path, buf)
        }
    }));

    handles.push(std::thread::spawn({
        let rows_ptr = SendPtr(rows_ptr.0);
        let order_ptr = SendPtr(order_ptr.0);
        let path = by_identity_path.clone();
        move || -> std::io::Result<()> {
            let rows: &Vec<Row> = unsafe { &*rows_ptr.get() };
            let order: &Vec<u32> = unsafe { &*order_ptr.get() };
            let mut keys: Vec<([u8; 32], u32)> = order
                .iter()
                .enumerate()
                .map(|(k, &i)| (rows[i as usize].identity_key_digest, k as u32))
                .collect();
            keys.sort_unstable();
            let mut buf = Vec::with_capacity(keys.len() * BY_IDENTITY_STRIDE);
            for (digest, k) in keys {
                buf.extend_from_slice(&digest);
                buf.extend_from_slice(&k.to_le_bytes());
            }
            std::fs::write(&path, buf)
        }
    }));

    handles.push(std::thread::spawn({
        let rows_ptr = SendPtr(rows_ptr.0);
        let order_ptr = SendPtr(order_ptr.0);
        let path = adj_out_path.clone();
        move || -> std::io::Result<()> {
            let rows: &Vec<Row> = unsafe { &*rows_ptr.get() };
            let order: &Vec<u32> = unsafe { &*order_ptr.get() };
            let mut pairs: Vec<(u32, u32)> = order
                .iter()
                .enumerate()
                .filter_map(|(k, &i)| {
                    let s = rows[i as usize].source_subject;
                    (s != NONE_U32).then_some((s, k as u32))
                })
                .collect();
            pairs.sort_unstable();
            write_pairs(&path, &pairs)
        }
    }));

    handles.push(std::thread::spawn({
        let rows_ptr = SendPtr(rows_ptr.0);
        let order_ptr = SendPtr(order_ptr.0);
        let path = adj_in_path.clone();
        move || -> std::io::Result<()> {
            let rows: &Vec<Row> = unsafe { &*rows_ptr.get() };
            let order: &Vec<u32> = unsafe { &*order_ptr.get() };
            let mut pairs: Vec<(u32, u32)> = order
                .iter()
                .enumerate()
                .filter_map(|(k, &i)| {
                    let t = rows[i as usize].target_subject;
                    (t != NONE_U32).then_some((t, k as u32))
                })
                .collect();
            pairs.sort_unstable();
            write_pairs(&path, &pairs)
        }
    }));

    // subjects.keys + dictionaries.bin: cheap, one thread.
    {
        let subjects = store.dict.subjects.clone();
        let dict_artifacts = store.dict.artifacts.clone();
        let dict_versions = store.dict.versions.clone();
        let dict_kinds = store.dict.kinds.clone();
        let dict_universal_kinds = store.dict.universal_kinds.clone();
        let dict_identity_types = store.dict.identity_types.clone();
        let dict_assignment_kinds = store.dict.assignment_kinds.clone();
        let dict_facets = store.dict.facets.clone();
        let dict_names = store.dict.names.clone();
        let subjects_path = subjects_path.clone();
        let dict_path = dict_path.clone();
        handles.push(std::thread::spawn(move || -> std::io::Result<()> {
            let mut sbuf = Vec::with_capacity(subjects.len() * SUBJECT_STRIDE);
            for s in &subjects {
                sbuf.extend_from_slice(s);
            }
            std::fs::write(&subjects_path, sbuf)?;

            let mut dbuf = Vec::new();
            write_str_dict(&mut dbuf, &dict_artifacts)?;
            write_str_dict(&mut dbuf, &dict_versions)?;
            write_str_dict(&mut dbuf, &dict_kinds)?;
            write_str_dict(&mut dbuf, &dict_universal_kinds)?;
            write_str_dict(&mut dbuf, &dict_identity_types)?;
            write_str_dict(&mut dbuf, &dict_assignment_kinds)?;
            write_str_dict(&mut dbuf, &dict_facets)?;
            write_str_dict(&mut dbuf, &dict_names)?;
            std::fs::write(&dict_path, dbuf)
        }));
    }

    for h in handles {
        h.join().expect("replay-c worker thread panicked")?;
    }

    let to_page_cache = t0.elapsed();

    fsync_path(out_dir)?;
    let durable = t0.elapsed();

    let bytes_written = dir_size(out_dir)?;

    Ok(Timings {
        to_page_cache,
        durable,
        bytes_written,
    })
}

fn write_pairs(path: &Path, pairs: &[(u32, u32)]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(pairs.len() * PAIR_STRIDE);
    for (a, b) in pairs {
        buf.extend_from_slice(&a.to_le_bytes());
        buf.extend_from_slice(&b.to_le_bytes());
    }
    std::fs::write(path, buf)
}

// --------------------------------------------------------------------------
// Reader side: memmap2 + binary search, shared by `query` and `delta`.
// --------------------------------------------------------------------------

// Some fields (digests/ident/by_identity/subjects) round out the v4
// segment-store shape for schema fidelity but aren't read by the fixed
// query workload in query.rs (no `by_identity` or `two_hop`-via-subjects.keys
// case is in the measured set) -- kept mapped so their presence still
// counts toward `dir_size`/fsync and so a future workload can use them.
#[allow(dead_code)]
pub struct CStore {
    pub keys: Mmap,
    pub meta: Mmap,
    pub digests: Mmap,
    pub body: Mmap,
    pub ident: Mmap,
    pub by_owner: Mmap,
    pub by_name: Mmap,
    pub by_kind: Mmap,
    pub by_identity: Mmap,
    pub adj_out: Mmap,
    pub adj_in: Mmap,
    pub subjects: Mmap,
    pub n: usize,
}

fn mmap_file(path: &Path) -> AnyResult<Mmap> {
    let f = File::open(path)?;
    let m = unsafe { MmapOptions::new().map(&f)? };
    Ok(m)
}

impl CStore {
    pub fn open(dir: &Path) -> AnyResult<Self> {
        let keys = mmap_file(&dir.join("records.keys"))?;
        let n = keys.len() / KEYS_STRIDE;
        Ok(Self {
            meta: mmap_file(&dir.join("records.meta"))?,
            digests: mmap_file(&dir.join("records.digests"))?,
            body: mmap_file(&dir.join("records.body"))?,
            ident: mmap_file(&dir.join("records.ident"))?,
            by_owner: mmap_file(&dir.join("records.by_owner"))?,
            by_name: mmap_file(&dir.join("records.by_name"))?,
            by_kind: mmap_file(&dir.join("records.by_kind"))?,
            by_identity: mmap_file(&dir.join("records.by_identity"))?,
            adj_out: mmap_file(&dir.join("adj.out"))?,
            adj_in: mmap_file(&dir.join("adj.in"))?,
            subjects: mmap_file(&dir.join("subjects.keys"))?,
            keys,
            n,
        })
    }

    #[allow(dead_code)]
    pub fn key_at(&self, k: usize) -> &[u8] {
        &self.keys[k * KEYS_STRIDE..(k + 1) * KEYS_STRIDE]
    }

    pub fn meta_at(&self, k: usize) -> &[u8] {
        &self.meta[k * META_STRIDE..(k + 1) * META_STRIDE]
    }

    #[allow(dead_code)]
    pub fn digests_at(&self, k: usize) -> &[u8] {
        &self.digests[k * DIGESTS_STRIDE..(k + 1) * DIGESTS_STRIDE]
    }

    pub fn body_at(&self, k: usize) -> &[u8] {
        let m = self.meta_at(k);
        let off = u64le(m, meta::BODY_OFF) as usize;
        let len = u32le(m, meta::BODY_LEN) as usize;
        &self.body[off..off + len]
    }

    /// Binary search records.keys for an exact record_id; returns row_ordinal.
    pub fn find_record(&self, record_id: &[u8; 32]) -> Option<usize> {
        binary_search_exact(self.n, KEYS_STRIDE, &self.keys, record_id)
    }

    pub fn range_by_owner(&self, owner: u32) -> Vec<u32> {
        u32_prefix_range(&self.by_owner, owner)
    }

    pub fn range_by_name(&self, name: u32) -> Vec<u32> {
        u32_prefix_range(&self.by_name, name)
    }

    pub fn range_adj_out(&self, subject: u32) -> Vec<u32> {
        u32_prefix_range(&self.adj_out, subject)
    }

    pub fn range_adj_in(&self, subject: u32) -> Vec<u32> {
        u32_prefix_range(&self.adj_in, subject)
    }

    pub fn range_by_kind(&self, universal_kind_id: u16, category: u8, kind_id: u16) -> Vec<u32> {
        let n = self.by_kind.len() / BY_KIND_STRIDE;
        let key_of = |i: usize| -> (u16, u8, u16) {
            let rec = &self.by_kind[i * BY_KIND_STRIDE..(i + 1) * BY_KIND_STRIDE];
            (u16le(rec, 0), rec[2], u16le(rec, 3))
        };
        let target = (universal_kind_id, category, kind_id);
        let lo = lower_bound(n, |i| key_of(i).cmp(&target));
        let hi = upper_bound(n, |i| key_of(i).cmp(&target));
        (lo..hi)
            .map(|i| u32le(&self.by_kind[i * BY_KIND_STRIDE..], 5))
            .collect()
    }
}

fn u32_prefix_range(arr: &[u8], target: u32) -> Vec<u32> {
    let n = arr.len() / PAIR_STRIDE;
    let key_of = |i: usize| u32le(arr, i * PAIR_STRIDE);
    let lo = lower_bound(n, |i| key_of(i).cmp(&target));
    let hi = upper_bound(n, |i| key_of(i).cmp(&target));
    (lo..hi).map(|i| u32le(arr, i * PAIR_STRIDE + 4)).collect()
}

fn binary_search_exact(n: usize, stride: usize, arr: &[u8], target: &[u8]) -> Option<usize> {
    let key_of = |i: usize| &arr[i * stride..i * stride + target.len()];
    let mut lo = 0usize;
    let mut hi = n;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        match key_of(mid).cmp(target) {
            std::cmp::Ordering::Less => lo = mid + 1,
            std::cmp::Ordering::Greater => hi = mid,
            std::cmp::Ordering::Equal => return Some(mid),
        }
    }
    None
}

pub fn lower_bound(n: usize, cmp: impl Fn(usize) -> std::cmp::Ordering) -> usize {
    let mut lo = 0usize;
    let mut hi = n;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if cmp(mid) == std::cmp::Ordering::Less {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

pub fn upper_bound(n: usize, cmp: impl Fn(usize) -> std::cmp::Ordering) -> usize {
    let mut lo = 0usize;
    let mut hi = n;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if cmp(mid) != std::cmp::Ordering::Greater {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}
