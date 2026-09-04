//! `artifact_dependencies` scratch cache. Small (30,838 rows in the n8n
//! corpus) relative to `record_occurrences`, so it gets a much simpler
//! fixed-width format than `row.rs`'s Store: no variable-length fields.
//!
//! Fields dropped versus the v3 table (`dependency_role`, `producer_id`,
//! `producer_version`, the full `dependency_entry_id` text) are noted as a
//! deliberate simplification in the evidence doc -- this table is 30.8K
//! rows against 3.19M `record_occurrences` rows and isn't what the
//! store-floor decision hinges on; it's carried through the replays purely
//! so their directory/byte-total numbers aren't missing a real v3 table.

use crate::bin_io::*;
use std::io::{self, BufReader, BufWriter};

pub struct DepRow {
    pub dependency_entry_id: [u8; 32], // sha256 of the full v3 text id
    pub record_id: [u8; 32],
    pub owner_artifact: u32,
    pub dependency_artifact: u32,
    pub valid_from: u32,
    pub valid_to: u32,
    pub content_digest: [u8; 32],
}

const MAGIC: u32 = 0x5634_4432; // "V4D2"

pub fn save_deps(path: &std::path::Path, rows: &[DepRow]) -> io::Result<()> {
    let f = std::fs::File::create(path)?;
    let mut w = BufWriter::new(f);
    write_u32(&mut w, MAGIC)?;
    write_u64(&mut w, rows.len() as u64)?;
    for d in rows {
        write_bytes32(&mut w, &d.dependency_entry_id)?;
        write_bytes32(&mut w, &d.record_id)?;
        write_u32(&mut w, d.owner_artifact)?;
        write_u32(&mut w, d.dependency_artifact)?;
        write_u32(&mut w, d.valid_from)?;
        write_u32(&mut w, d.valid_to)?;
        write_bytes32(&mut w, &d.content_digest)?;
    }
    Ok(())
}

pub fn load_deps(path: &std::path::Path) -> io::Result<Vec<DepRow>> {
    let f = std::fs::File::open(path)?;
    let mut r = BufReader::new(f);
    let magic = read_u32(&mut r)?;
    if magic != MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bad deps cache magic",
        ));
    }
    let n = read_u64(&mut r)? as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(DepRow {
            dependency_entry_id: read_bytes32(&mut r)?,
            record_id: read_bytes32(&mut r)?,
            owner_artifact: read_u32(&mut r)?,
            dependency_artifact: read_u32(&mut r)?,
            valid_from: read_u32(&mut r)?,
            valid_to: read_u32(&mut r)?,
            content_digest: read_bytes32(&mut r)?,
        });
    }
    Ok(out)
}
