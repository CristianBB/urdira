use crate::row::Row;

/// Indices into `rows`, sorted by `record_id` ascending -- the PK order a
/// WITHOUT ROWID table wants for sequential-append inserts, and the order
/// every partitioned segment-store file in replay-c relies on (top-nibble
/// partitioning of an already-sorted key list is contiguous by construction).
pub fn pk_order(rows: &[Row]) -> Vec<u32> {
    let mut idx: Vec<u32> = (0..rows.len() as u32).collect();
    idx.sort_unstable_by(|&a, &b| rows[a as usize].record_id.cmp(&rows[b as usize].record_id));
    idx
}
