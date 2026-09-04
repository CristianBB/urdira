//! Ignored bench: loads the P0-S1 spike's cached NODIAG row set (real n8n
//! generation-1 data, 2,494,896 rows) if present, and reports
//! `write_base` page-cache/durable time plus p50/p95 for
//! get/by_owner/by_name/adjacency/visible_count/first-query-after-open.
//!
//! Run with:
//!
//! ```text
//! cargo test -p urdira-structural-store --release --test bench_nodiag -- --ignored --nocapture
//! ```
//!
//! Reuses the spike's tiny binary cache format (`crates/urdira-v4-spike/src/bin_io.rs`
//! and `row.rs`'s `save_store`/`load_store`) via a standalone decoder
//! copied here rather than depending on the throwaway spike crate.

mod common;

use std::io::{self, BufReader, Read};
use std::path::Path;
use std::time::Instant;
use urdira_structural_store::{Dictionaries, Direction, RecordRow, SegmentWriter, StoreReader};

const CACHE_PATH: &str = "/Users/Cristian/Proyectos/urdira-benchmark/v4-p0/spike/nodiag.bin";
const MAGIC: u32 = 0x5634_5031;

fn read_u8(r: &mut impl Read) -> io::Result<u8> {
    let mut b = [0u8; 1];
    r.read_exact(&mut b)?;
    Ok(b[0])
}
fn read_u16(r: &mut impl Read) -> io::Result<u16> {
    let mut b = [0u8; 2];
    r.read_exact(&mut b)?;
    Ok(u16::from_le_bytes(b))
}
fn read_u32(r: &mut impl Read) -> io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}
fn read_u64(r: &mut impl Read) -> io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}
fn read_bytes32(r: &mut impl Read) -> io::Result<[u8; 32]> {
    let mut b = [0u8; 32];
    r.read_exact(&mut b)?;
    Ok(b)
}
fn read_lp_bytes(r: &mut impl Read) -> io::Result<Vec<u8>> {
    let len = read_u32(r)? as usize;
    let mut b = vec![0u8; len];
    r.read_exact(&mut b)?;
    Ok(b)
}
fn read_lp_string(r: &mut impl Read) -> io::Result<String> {
    String::from_utf8(read_lp_bytes(r)?).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}
fn read_str_dict(r: &mut impl Read) -> io::Result<Vec<String>> {
    let n = read_u32(r)? as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(read_lp_string(r)?);
    }
    Ok(out)
}

const NONE_U32: u32 = u32::MAX;
const NONE_U16: u16 = u16::MAX;

/// Decodes the spike's `save_store` cache format directly into this
/// crate's `RecordRow` + `Dictionaries`. Field-for-field port of
/// `urdira-v4-spike/src/row.rs::load_store`; `facets` widens u32->u64 and
/// `source_subject`/`target_subject`/`relation_kind_id` become
/// `Option`/`Option<u16>` per this crate's shape.
fn load_spike_cache(path: &Path) -> io::Result<(Vec<RecordRow>, Dictionaries)> {
    let f = std::fs::File::open(path)?;
    let mut r = BufReader::with_capacity(1 << 20, f);

    let magic = read_u32(&mut r)?;
    if magic != MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bad spike cache magic",
        ));
    }
    let row_count = read_u64(&mut r)? as usize;

    let artifacts = read_str_dict(&mut r)?;
    let _versions = read_str_dict(&mut r)?;
    let kinds = read_str_dict(&mut r)?;
    let universal_kinds = read_str_dict(&mut r)?;
    let _identity_types = read_str_dict(&mut r)?;
    let _assignment_kinds = read_str_dict(&mut r)?;
    let _facets_dict = read_str_dict(&mut r)?;
    let names = read_str_dict(&mut r)?;

    let n_subjects = read_u32(&mut r)? as usize;
    let mut subjects = Vec::with_capacity(n_subjects);
    for _ in 0..n_subjects {
        subjects.push(read_bytes32(&mut r)?);
    }

    let dicts = Dictionaries {
        kinds,
        universal_kinds,
        relation_kinds: Vec::new(), // spike reuses kind_id for relation kind; no separate dict
        names,
        subjects,
        artifacts: artifacts.into_iter().map(|a| (a, String::new())).collect(),
        facet_names: Vec::new(),
        subject_text: Vec::new(),
    };

    let mut rows = Vec::with_capacity(row_count);
    for _ in 0..row_count {
        let record_id = read_bytes32(&mut r)?;
        let owner_artifact = read_u32(&mut r)?;
        let owner_version = read_u32(&mut r)?;
        let valid_from = read_u32(&mut r)?;
        let valid_to = read_u32(&mut r)?;
        let category = read_u8(&mut r)?;
        let kind_id = read_u16(&mut r)?;
        let universal_kind_id = read_u16(&mut r)?;
        let facets = read_u32(&mut r)?;
        let span_artifact_version = read_u32(&mut r)?;
        let span_start_byte = read_u32(&mut r)?;
        let span_end_byte = read_u32(&mut r)?;
        let span_start_line = read_u32(&mut r)?;
        let span_end_line = read_u32(&mut r)?;
        let identity_type = read_u8(&mut r)?;
        let assignment_kind = read_u8(&mut r)?;
        let name_id = read_u32(&mut r)?;
        let record_digest = read_bytes32(&mut r)?;
        let body_digest = read_bytes32(&mut r)?;
        let identity_id = read_bytes32(&mut r)?;
        let identity_key_digest = read_bytes32(&mut r)?;
        let previous_record_id = read_bytes32(&mut r)?;
        let source_subject = read_u32(&mut r)?;
        let target_subject = read_u32(&mut r)?;
        let relation_kind_id = read_u16(&mut r)?;
        let identity_key = read_lp_bytes(&mut r)?;
        let body_payload = read_lp_bytes(&mut r)?;

        rows.push(RecordRow {
            record_id,
            owner_artifact,
            owner_version,
            valid_from,
            valid_to,
            category,
            kind_id,
            universal_kind_id,
            facets: u64::from(facets),
            span_artifact_version,
            span_start_byte,
            span_end_byte,
            span_start_line,
            span_end_line,
            identity_type,
            assignment_kind,
            name_id,
            identity_key,
            record_digest,
            body_digest,
            identity_id,
            identity_key_digest,
            previous_record_id,
            source_subject: (source_subject != NONE_U32).then_some(source_subject),
            target_subject: (target_subject != NONE_U32).then_some(target_subject),
            relation_kind_id: if relation_kind_id == NONE_U16 {
                urdira_structural_store::NONE_U16
            } else {
                relation_kind_id
            },
            body: body_payload,
        });
    }

    Ok((rows, dicts))
}

fn percentile(sorted_micros: &[f64], p: f64) -> f64 {
    if sorted_micros.is_empty() {
        return 0.0;
    }
    let idx = ((sorted_micros.len() as f64 - 1.0) * p).round() as usize;
    sorted_micros[idx]
}

fn timed<T>(mut f: impl FnMut() -> T) -> (T, f64) {
    let t0 = Instant::now();
    let out = f();
    (out, t0.elapsed().as_secs_f64() * 1e6)
}

fn machine_is_idle() -> bool {
    std::process::Command::new("pgrep")
        .args(["-f", "urdira-indexing-worker|n8n-incremental-preflight"])
        .output()
        .map(|o| o.stdout.is_empty())
        .unwrap_or(true)
}

#[test]
#[ignore]
fn bench_write_base_and_queries_on_real_nodiag_rows() {
    let path = Path::new(CACHE_PATH);
    if !path.exists() {
        eprintln!("skipping: {CACHE_PATH} not present (run the P0-S1 spike's `load` step first)");
        return;
    }
    if !machine_is_idle() {
        eprintln!(
            "WARNING: urdira-indexing-worker or n8n-incremental-preflight is running -- \
             numbers below may be contended, not a clean measurement"
        );
    }

    eprintln!("loading spike cache from {CACHE_PATH} ...");
    let (mut rows, dicts) = load_spike_cache(path).expect("load spike cache");
    eprintln!(
        "loaded {} rows, {} subjects, {} names",
        rows.len(),
        dicts.subjects.len(),
        dicts.names.len()
    );
    rows.sort_unstable_by_key(|r| r.record_id);

    let dir = common::tmp_dir("bench-nodiag");
    let writer = SegmentWriter::new();
    let summary = writer
        .write_base(&dir, &rows, &[], &dicts, 1)
        .expect("write_base");
    eprintln!(
        "write_base: page_cache={:.3}s durable={:.3}s ({} files, {} bytes total)",
        summary.to_page_cache.as_secs_f64(),
        summary.durable.as_secs_f64(),
        summary.files.len(),
        summary.files.values().map(|(b, _)| b).sum::<u64>()
    );

    let reader = StoreReader::open(&dir).expect("open");
    let (_, first_query_before_wait_us) = timed(|| reader.get(&rows[0].record_id));
    reader.wait_prefault();
    let (_, first_query_after_wait_us) = timed(|| reader.get(&rows[1].record_id));
    eprintln!(
        "first query: {first_query_before_wait_us:.1} us (racing prefault) / {first_query_after_wait_us:.1} us (after wait_prefault)"
    );

    // Deterministic sample of 200 keys/owners/names/subjects for repeatable p50/p95.
    let mut rng = common::Rng::new(0xB5C4);
    let n = rows.len();
    let sample_keys: Vec<[u8; 32]> = (0..200)
        .map(|_| rows[rng.below(n as u32) as usize].record_id)
        .collect();
    let sample_owners: Vec<u32> = (0..200)
        .map(|_| rows[rng.below(n as u32) as usize].owner_artifact)
        .collect();
    let sample_names: Vec<u32> = rows
        .iter()
        .filter_map(|r| r.name_id_opt())
        .take(200)
        .collect();
    let sample_subjects: Vec<[u8; 32]> = (0..200.min(dicts.subjects.len()))
        .map(|_| dicts.subjects[rng.below(dicts.subjects.len() as u32) as usize])
        .collect();

    let mut get_us = Vec::new();
    for k in &sample_keys {
        let (_, us) = timed(|| reader.get(k));
        get_us.push(us);
    }
    let mut by_owner_us = Vec::new();
    for o in &sample_owners {
        let (_, us) = timed(|| reader.by_owner(*o, 1));
        by_owner_us.push(us);
    }
    let mut by_name_us = Vec::new();
    for nm in &sample_names {
        let (_, us) = timed(|| reader.by_name(*nm, 1));
        by_name_us.push(us);
    }
    let mut adjacency_us = Vec::new();
    for s in &sample_subjects {
        let (_, us) = timed(|| reader.adjacency(s, Direction::Out, 1));
        adjacency_us.push(us);
    }
    let mut visible_count_us = Vec::new();
    for _ in 0..200 {
        let (_, us) = timed(|| reader.visible_count(1));
        visible_count_us.push(us);
    }

    for (name, mut v) in [
        ("get", get_us),
        ("by_owner", by_owner_us),
        ("by_name", by_name_us),
        ("adjacency_out", adjacency_us),
        ("visible_count", visible_count_us),
    ] {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        eprintln!(
            "{name}: p50={:.1}us p95={:.1}us (n={})",
            percentile(&v, 0.50),
            percentile(&v, 0.95),
            v.len()
        );
    }

    eprintln!(
        "targets: build <=1.2s page-cache / <=2s durable; by_owner p95 <=2ms; \
         first query <=5ms after prefault; visible_count <=0.1ms"
    );
}
