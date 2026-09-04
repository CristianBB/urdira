//! `load` subcommand: read the v3 workspace SQLite file once, plus the
//! Node-extracted relation subject file, and materialize the v4-shaped
//! FULL and NODIAG row sets to scratch cache files so the replay/query/delta
//! subcommands never have to touch the 13.9 GB source file again.

use crate::AnyResult;
use crate::bin_io::{hex64_after_prefix, read_lp_bytes, read_u32};
use crate::deps::{DepRow, save_deps};
use crate::dict::{BytesDict32, StringDict};
use crate::row::{CATEGORY_DIAGNOSTIC, Dictionaries, NONE_U16, NONE_U32, Row, Store, save_store};
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::BufReader;
use std::path::Path;
use std::time::Instant;

fn category_code(s: &str) -> u8 {
    match s {
        "entity" => 0,
        "relation" => 1,
        "diagnostic" => 2,
        "fact" => 3,
        "evidence" => 4,
        other => panic!("unexpected category {other}"),
    }
}

fn hex32(s: &str) -> [u8; 32] {
    hex64_after_prefix(s).unwrap_or_else(|| panic!("expected <prefix>:<64 hex> id, got {s}"))
}

fn opt_hex32(s: Option<&str>) -> [u8; 32] {
    s.and_then(hex64_after_prefix).unwrap_or([0u8; 32])
}

fn opt_u32_text(s: Option<&str>) -> u32 {
    s.and_then(|v| v.parse::<u32>().ok()).unwrap_or(0)
}

fn name_id_from_identity_key(key: &str) -> &str {
    key.rsplit(':').next().unwrap_or(key)
}

fn open_ro(path: &str) -> AnyResult<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    Ok(conn)
}

pub fn run(db_path: &str, relations_bin: &str, out_dir: &str) -> AnyResult<()> {
    let out_dir = Path::new(out_dir);
    std::fs::create_dir_all(out_dir)?;

    let t0 = Instant::now();
    let conn = open_ro(db_path)?;
    eprintln!("[load] opened {db_path} read-only in {:?}", t0.elapsed());

    let mut artifacts = StringDict::default();
    let mut versions = StringDict::default();
    let mut kinds = StringDict::default();
    let mut universal_kinds = StringDict::default();
    let mut identity_types = StringDict::default();
    let mut assignment_kinds = StringDict::default();
    let mut names = StringDict::default();

    // --- Pass 1: record_occurrences ---------------------------------------
    let t1 = Instant::now();
    let mut rows: Vec<Row> = Vec::with_capacity(3_300_000);
    let mut record_index: HashMap<[u8; 32], u32> = HashMap::with_capacity(3_300_000);
    {
        let mut stmt = conn.prepare(
            "SELECT record_id, category, kind, universal_kind, owner_artifact_id, \
                    owner_artifact_version_id, valid_from_generation, valid_to_generation, \
                    primary_source_span_artifact_version_id, primary_source_span_start_byte, \
                    primary_source_span_end_byte, primary_source_span_start_line, \
                    primary_source_span_end_line, record_digest, body_digest, body_payload \
             FROM record_occurrences",
        )?;
        let mut r = stmt.query([])?;
        let mut n = 0u64;
        while let Some(row) = r.next()? {
            let record_id_text: String = row.get(0)?;
            let category_text: String = row.get(1)?;
            let kind_text: String = row.get(2)?;
            let universal_kind_text: String = row.get(3)?;
            let owner_artifact_text: String = row.get(4)?;
            let owner_version_text: String = row.get(5)?;
            let valid_from: u32 = row.get(6)?;
            let valid_to: Option<u32> = row.get(7)?;
            let span_version_text: Option<String> = row.get(8)?;
            let span_start_byte_text: Option<String> = row.get(9)?;
            let span_end_byte_text: Option<String> = row.get(10)?;
            let span_start_line_text: Option<String> = row.get(11)?;
            let span_end_line_text: Option<String> = row.get(12)?;
            let record_digest_text: String = row.get(13)?;
            let body_digest_text: String = row.get(14)?;
            let body_payload: Vec<u8> = row.get(15)?;

            let record_id = hex32(&record_id_text);
            let owner_artifact = artifacts.intern(&owner_artifact_text);
            let owner_version = versions.intern(&owner_version_text);
            let span_artifact_version = span_version_text
                .as_deref()
                .map(|v| versions.intern(v))
                .unwrap_or(NONE_U32);

            record_index.insert(record_id, rows.len() as u32);
            rows.push(Row {
                record_id,
                owner_artifact,
                owner_version,
                valid_from,
                valid_to: valid_to.unwrap_or(0),
                category: category_code(&category_text),
                kind_id: kinds.intern(&kind_text) as u16,
                universal_kind_id: universal_kinds.intern(&universal_kind_text) as u16,
                facets: 0,
                span_artifact_version,
                span_start_byte: opt_u32_text(span_start_byte_text.as_deref()),
                span_end_byte: opt_u32_text(span_end_byte_text.as_deref()),
                span_start_line: opt_u32_text(span_start_line_text.as_deref()),
                span_end_line: opt_u32_text(span_end_line_text.as_deref()),
                identity_type: 0,
                assignment_kind: 0,
                name_id: NONE_U32,
                identity_key: Vec::new(),
                record_digest: hex32(&record_digest_text),
                body_digest: hex32(&body_digest_text),
                identity_id: [0u8; 32],
                identity_key_digest: [0u8; 32],
                previous_record_id: [0u8; 32],
                body_payload,
                source_subject: NONE_U32,
                target_subject: NONE_U32,
                relation_kind_id: NONE_U16,
            });
            n += 1;
            if n.is_multiple_of(500_000) {
                eprintln!("[load] record_occurrences {n} ({:?})", t1.elapsed());
            }
        }
    }
    eprintln!(
        "[load] record_occurrences: {} rows in {:?}",
        rows.len(),
        t1.elapsed()
    );

    // --- Pass 2: identity_assignments --------------------------------------
    let t2 = Instant::now();
    {
        let mut stmt = conn.prepare(
            "SELECT identity_type, identity_id, assignment_kind, identity_key, \
                    identity_key_digest, record_id, previous_record_id \
             FROM identity_assignments",
        )?;
        let mut r = stmt.query([])?;
        let mut n = 0u64;
        let mut misses = 0u64;
        while let Some(row) = r.next()? {
            let identity_type_text: String = row.get(0)?;
            let identity_id_text: String = row.get(1)?;
            let assignment_kind_text: String = row.get(2)?;
            let identity_key: String = row.get(3)?;
            let identity_key_digest_text: String = row.get(4)?;
            let record_id_text: String = row.get(5)?;
            let previous_record_id_text: Option<String> = row.get(6)?;

            let record_id = hex32(&record_id_text);
            let Some(&idx) = record_index.get(&record_id) else {
                misses += 1;
                continue;
            };
            let name_text = name_id_from_identity_key(&identity_key).to_string();
            let row_ref = &mut rows[idx as usize];
            row_ref.identity_type = identity_types.intern(&identity_type_text) as u8;
            row_ref.assignment_kind = assignment_kinds.intern(&assignment_kind_text) as u8;
            row_ref.name_id = names.intern(&name_text);
            row_ref.identity_id = hex32(&identity_id_text);
            row_ref.identity_key_digest = hex32(&identity_key_digest_text);
            row_ref.previous_record_id = opt_hex32(previous_record_id_text.as_deref());
            row_ref.identity_key = identity_key.into_bytes();

            n += 1;
            if n.is_multiple_of(500_000) {
                eprintln!("[load] identity_assignments {n} ({:?})", t2.elapsed());
            }
        }
        eprintln!(
            "[load] identity_assignments: {n} rows in {:?} ({misses} unmatched record_id)",
            t2.elapsed()
        );
    }

    // --- Pass 3: record_facets ----------------------------------------------
    let t3 = Instant::now();
    let mut facets = StringDict::default();
    {
        let mut stmt = conn.prepare("SELECT record_id, facet FROM record_facets")?;
        let mut r = stmt.query([])?;
        let mut n = 0u64;
        let mut misses = 0u64;
        while let Some(row) = r.next()? {
            let record_id_text: String = row.get(0)?;
            let facet_text: String = row.get(1)?;
            let record_id = hex32(&record_id_text);
            let Some(&idx) = record_index.get(&record_id) else {
                misses += 1;
                continue;
            };
            let bit = facets.intern(&facet_text);
            assert!(bit < 32, "facet dictionary exceeded 32 distinct values");
            rows[idx as usize].facets |= 1u32 << bit;
            n += 1;
        }
        eprintln!(
            "[load] record_facets: {n} rows in {:?} ({misses} unmatched)",
            t3.elapsed()
        );
    }

    // --- Pass 4: relation subjects (from the Node-extracted file) ----------
    let t4 = Instant::now();
    let mut subjects = BytesDict32::default();
    let mut relation_subject_hits: Vec<(u32, [u8; 32], [u8; 32])> = Vec::new();
    {
        let f = std::fs::File::open(relations_bin)?;
        let mut r = BufReader::with_capacity(1 << 20, f);
        let count = read_u32(&mut r)?;
        let mut misses = 0u64;
        for i in 0..count {
            let mut record_id = [0u8; 32];
            std::io::Read::read_exact(&mut r, &mut record_id)?;
            let source_bytes = read_lp_bytes(&mut r)?;
            let target_bytes = read_lp_bytes(&mut r)?;
            let source_key: [u8; 32] = Sha256::digest(&source_bytes).into();
            let target_key: [u8; 32] = Sha256::digest(&target_bytes).into();
            subjects.observe(source_key);
            subjects.observe(target_key);
            match record_index.get(&record_id) {
                Some(&idx) => relation_subject_hits.push((idx, source_key, target_key)),
                None => misses += 1,
            }
            if (i + 1) % 500_000 == 0 {
                eprintln!("[load] relations {} / {count} ({:?})", i + 1, t4.elapsed());
            }
        }
        eprintln!(
            "[load] relations file: {count} rows in {:?} ({misses} unmatched record_id)",
            t4.elapsed()
        );
    }
    subjects.finish();
    for (idx, source_key, target_key) in relation_subject_hits {
        let row = &mut rows[idx as usize];
        row.source_subject = subjects
            .ordinal(&source_key)
            .expect("subject key must resolve");
        row.target_subject = subjects
            .ordinal(&target_key)
            .expect("subject key must resolve");
        row.relation_kind_id = row.kind_id;
    }
    eprintln!(
        "[load] subject dictionary: {} distinct subjects",
        subjects.len()
    );

    // --- artifact_dependencies -----------------------------------------------
    let t5 = Instant::now();
    let mut dep_rows: Vec<DepRow> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT dependency_entry_id, record_id, owner_artifact_id, dependency_artifact_id, \
                    valid_from_generation, valid_to_generation, content_digest \
             FROM artifact_dependencies",
        )?;
        let mut r = stmt.query([])?;
        while let Some(row) = r.next()? {
            let dep_id_text: String = row.get(0)?;
            let record_id_text: String = row.get(1)?;
            let owner_artifact_text: String = row.get(2)?;
            let dependency_artifact_text: String = row.get(3)?;
            let valid_from: u32 = row.get(4)?;
            let valid_to: Option<u32> = row.get(5)?;
            let content_digest_text: String = row.get(6)?;

            // A small number of v3 artifact_dependencies rows (81 in the
            // n8n corpus) carry a bare "record:" sentinel with no hex
            // suffix -- a workspace/artifact-level dependency not tied to
            // one record. Treat those as a zero record_id rather than
            // treating malformed data as a hard error; every other table
            // in this loader has 0 unmatched/malformed rows, so this
            // leniency is scoped to this one column.
            dep_rows.push(DepRow {
                dependency_entry_id: Sha256::digest(dep_id_text.as_bytes()).into(),
                record_id: hex64_after_prefix(&record_id_text).unwrap_or([0u8; 32]),
                owner_artifact: artifacts.intern(&owner_artifact_text),
                dependency_artifact: artifacts.intern(&dependency_artifact_text),
                valid_from,
                valid_to: valid_to.unwrap_or(0),
                content_digest: hex32(&content_digest_text),
            });
        }
    }
    eprintln!(
        "[load] artifact_dependencies: {} rows in {:?}",
        dep_rows.len(),
        t5.elapsed()
    );

    let dict = Dictionaries {
        artifacts: artifacts.values,
        versions: versions.values,
        kinds: kinds.values,
        universal_kinds: universal_kinds.values,
        identity_types: identity_types.values,
        assignment_kinds: assignment_kinds.values,
        facets: facets.values,
        names: names.values,
        subjects: subjects.sorted,
    };

    let full_row_count = rows.len();
    let full = Store { rows, dict };

    let full_path = out_dir.join("full.bin");
    let t6 = Instant::now();
    save_store(&full_path, &full)?;
    eprintln!(
        "[load] wrote {} ({} rows) in {:?}",
        full_path.display(),
        full_row_count,
        t6.elapsed()
    );

    // NODIAG: same dictionaries (ordinal spaces stay comparable across sets),
    // rows filtered to drop category==diagnostic.
    let nodiag_rows: Vec<Row> = full
        .rows
        .iter()
        .filter(|r| r.category != CATEGORY_DIAGNOSTIC)
        .cloned()
        .collect();
    let nodiag_record_ids: std::collections::HashSet<[u8; 32]> =
        nodiag_rows.iter().map(|r| r.record_id).collect();
    let nodiag_count = nodiag_rows.len();
    let nodiag = Store {
        rows: nodiag_rows,
        dict: Dictionaries {
            artifacts: full.dict.artifacts.clone(),
            versions: full.dict.versions.clone(),
            kinds: full.dict.kinds.clone(),
            universal_kinds: full.dict.universal_kinds.clone(),
            identity_types: full.dict.identity_types.clone(),
            assignment_kinds: full.dict.assignment_kinds.clone(),
            facets: full.dict.facets.clone(),
            names: full.dict.names.clone(),
            subjects: full.dict.subjects.clone(),
        },
    };
    let nodiag_path = out_dir.join("nodiag.bin");
    let t7 = Instant::now();
    save_store(&nodiag_path, &nodiag)?;
    eprintln!(
        "[load] wrote {} ({} rows) in {:?}",
        nodiag_path.display(),
        nodiag_count,
        t7.elapsed()
    );

    let deps_full_path = out_dir.join("deps_full.bin");
    save_deps(&deps_full_path, &dep_rows)?;
    let deps_nodiag: Vec<DepRow> = dep_rows
        .into_iter()
        .filter(|d| nodiag_record_ids.contains(&d.record_id))
        .collect();
    eprintln!(
        "[load] deps: full={} nodiag={}",
        std::fs::metadata(&deps_full_path)?.len(),
        deps_nodiag.len()
    );
    save_deps(&out_dir.join("deps_nodiag.bin"), &deps_nodiag)?;

    eprintln!("[load] total wall time {:?}", t0.elapsed());
    Ok(())
}
