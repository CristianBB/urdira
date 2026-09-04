//! The v4-shaped in-memory row (per the task brief's field list) plus the
//! whole-corpus `Store` and its scratch cache format, so `load` only needs
//! to run once against the 13.9 GB v3 file and every replay/query/delta
//! subcommand can rehydrate in a couple of seconds instead.

use crate::bin_io::*;
use std::io::{self, BufReader, BufWriter, Read, Write};

pub const NONE_U32: u32 = u32::MAX;
pub const NONE_U16: u16 = u16::MAX;

pub const CATEGORY_ENTITY: u8 = 0;
#[allow(dead_code)] // documents the category encoding alongside ENTITY/DIAGNOSTIC
pub const CATEGORY_RELATION: u8 = 1;
pub const CATEGORY_DIAGNOSTIC: u8 = 2;

#[derive(Clone)]
pub struct Row {
    pub record_id: [u8; 32],
    pub owner_artifact: u32,
    pub owner_version: u32,
    pub valid_from: u32,
    pub valid_to: u32, // 0 == open (v3 NULL)
    pub category: u8,
    pub kind_id: u16,
    pub universal_kind_id: u16,
    pub facets: u32,
    pub span_artifact_version: u32,
    pub span_start_byte: u32,
    pub span_end_byte: u32,
    pub span_start_line: u32,
    pub span_end_line: u32,
    pub identity_type: u8,
    pub assignment_kind: u8,
    pub name_id: u32,
    pub identity_key: Vec<u8>,
    pub record_digest: [u8; 32],
    pub body_digest: [u8; 32],
    pub identity_id: [u8; 32],
    pub identity_key_digest: [u8; 32],
    pub previous_record_id: [u8; 32], // zero == none
    pub body_payload: Vec<u8>,
    pub source_subject: u32, // NONE_U32 if not a relation
    pub target_subject: u32,
    pub relation_kind_id: u16, // NONE_U16 if not a relation
}

#[derive(Default)]
pub struct Dictionaries {
    pub artifacts: Vec<String>,
    pub versions: Vec<String>,
    pub kinds: Vec<String>,
    pub universal_kinds: Vec<String>,
    pub identity_types: Vec<String>,
    pub assignment_kinds: Vec<String>,
    pub facets: Vec<String>,
    pub names: Vec<String>,
    pub subjects: Vec<[u8; 32]>,
}

#[derive(Default)]
pub struct Store {
    pub rows: Vec<Row>,
    pub dict: Dictionaries,
}

const MAGIC: u32 = 0x5634_5031; // "V4P1"

pub fn save_store(path: &std::path::Path, store: &Store) -> io::Result<()> {
    let f = std::fs::File::create(path)?;
    let mut w = BufWriter::with_capacity(1 << 20, f);

    write_u32(&mut w, MAGIC)?;
    write_u64(&mut w, store.rows.len() as u64)?;

    write_str_dict(&mut w, &store.dict.artifacts)?;
    write_str_dict(&mut w, &store.dict.versions)?;
    write_str_dict(&mut w, &store.dict.kinds)?;
    write_str_dict(&mut w, &store.dict.universal_kinds)?;
    write_str_dict(&mut w, &store.dict.identity_types)?;
    write_str_dict(&mut w, &store.dict.assignment_kinds)?;
    write_str_dict(&mut w, &store.dict.facets)?;
    write_str_dict(&mut w, &store.dict.names)?;

    write_u32(&mut w, store.dict.subjects.len() as u32)?;
    for s in &store.dict.subjects {
        write_bytes32(&mut w, s)?;
    }

    // Fixed section.
    for row in &store.rows {
        write_bytes32(&mut w, &row.record_id)?;
        write_u32(&mut w, row.owner_artifact)?;
        write_u32(&mut w, row.owner_version)?;
        write_u32(&mut w, row.valid_from)?;
        write_u32(&mut w, row.valid_to)?;
        write_u8(&mut w, row.category)?;
        write_u16(&mut w, row.kind_id)?;
        write_u16(&mut w, row.universal_kind_id)?;
        write_u32(&mut w, row.facets)?;
        write_u32(&mut w, row.span_artifact_version)?;
        write_u32(&mut w, row.span_start_byte)?;
        write_u32(&mut w, row.span_end_byte)?;
        write_u32(&mut w, row.span_start_line)?;
        write_u32(&mut w, row.span_end_line)?;
        write_u8(&mut w, row.identity_type)?;
        write_u8(&mut w, row.assignment_kind)?;
        write_u32(&mut w, row.name_id)?;
        write_bytes32(&mut w, &row.record_digest)?;
        write_bytes32(&mut w, &row.body_digest)?;
        write_bytes32(&mut w, &row.identity_id)?;
        write_bytes32(&mut w, &row.identity_key_digest)?;
        write_bytes32(&mut w, &row.previous_record_id)?;
        write_u32(&mut w, row.source_subject)?;
        write_u32(&mut w, row.target_subject)?;
        write_u16(&mut w, row.relation_kind_id)?;
        write_lp_bytes(&mut w, &row.identity_key)?;
        write_lp_bytes(&mut w, &row.body_payload)?;
    }
    w.flush()
}

fn write_str_dict(w: &mut impl Write, values: &[String]) -> io::Result<()> {
    write_u32(w, values.len() as u32)?;
    for v in values {
        write_lp_str(w, v)?;
    }
    Ok(())
}

fn read_str_dict(r: &mut impl Read) -> io::Result<Vec<String>> {
    let n = read_u32(r)? as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(read_lp_string(r)?);
    }
    Ok(out)
}

pub fn load_store(path: &std::path::Path) -> io::Result<Store> {
    let f = std::fs::File::open(path)?;
    let mut r = BufReader::with_capacity(1 << 20, f);

    let magic = read_u32(&mut r)?;
    if magic != MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bad cache magic",
        ));
    }
    let row_count = read_u64(&mut r)? as usize;

    let mut dict = Dictionaries {
        artifacts: read_str_dict(&mut r)?,
        versions: read_str_dict(&mut r)?,
        kinds: read_str_dict(&mut r)?,
        universal_kinds: read_str_dict(&mut r)?,
        identity_types: read_str_dict(&mut r)?,
        assignment_kinds: read_str_dict(&mut r)?,
        facets: read_str_dict(&mut r)?,
        names: read_str_dict(&mut r)?,
        subjects: Vec::new(),
    };
    let n_subjects = read_u32(&mut r)? as usize;
    dict.subjects.reserve(n_subjects);
    for _ in 0..n_subjects {
        dict.subjects.push(read_bytes32(&mut r)?);
    }

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
        rows.push(Row {
            record_id,
            owner_artifact,
            owner_version,
            valid_from,
            valid_to,
            category,
            kind_id,
            universal_kind_id,
            facets,
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
            body_payload,
            source_subject,
            target_subject,
            relation_kind_id,
        });
    }

    Ok(Store { rows, dict })
}
