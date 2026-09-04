//! `delta` subcommand: simulate one edit against an already-built target --
//! close one random owner's visible rows at generation 2 and insert the same
//! count of new rows at generation 2. A/B: one transaction (or one per
//! shard file for B) + fsync. C: a `delta-2/` directory holding the new
//! rows in the same file layout as the base segment store, plus a
//! `closures.records` file naming the closed record ids, then fsync.

use crate::AnyResult;
use crate::ddl::*;
use crate::layout::*;
use crate::row::{NONE_U32, Row, Store};
use crate::util::fsync_path;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Instant;

fn pick_owner_rows(store: &Store, seed: u64) -> (u32, Vec<usize>) {
    let mut rng = StdRng::seed_from_u64(seed);
    loop {
        let probe = &store.rows[rng.random_range(0..store.rows.len())];
        let owner = probe.owner_artifact;
        let members: Vec<usize> = store
            .rows
            .iter()
            .enumerate()
            .filter(|(_, r)| r.owner_artifact == owner && r.valid_to == 0)
            .map(|(i, _)| i)
            .collect();
        if !members.is_empty() {
            return (owner, members);
        }
    }
}

fn make_edited_row(old: &Row, rng: &mut StdRng) -> Row {
    let mut new_id = [0u8; 32];
    rng.fill(&mut new_id);
    let mut new_digest = [0u8; 32];
    new_digest.copy_from_slice(&Sha256::digest(
        [old.record_digest.as_slice(), b"edit"].concat(),
    ));
    let mut row = old.clone();
    row.record_id = new_id;
    row.valid_from = 2;
    row.valid_to = 0;
    row.record_digest = new_digest;
    row.previous_record_id = old.record_id;
    row
}

pub struct DeltaResult {
    pub owner: u32,
    pub rows_closed: usize,
    pub elapsed_ms: f64,
}

pub fn run_a(store: &Store, target_path: &Path) -> AnyResult<DeltaResult> {
    let (owner, member_idx) = pick_owner_rows(store, 1);
    let mut rng = StdRng::seed_from_u64(2);
    let new_rows: Vec<Row> = member_idx
        .iter()
        .map(|&i| make_edited_row(&store.rows[i], &mut rng))
        .collect();

    let t0 = Instant::now();
    let conn = Connection::open(target_path)?;
    conn.execute_batch("BEGIN")?;
    conn.execute(
        "UPDATE record_occurrences SET valid_to_generation = 2 \
         WHERE owner_artifact = ?1 AND valid_to_generation IS NULL",
        rusqlite::params![owner],
    )?;
    insert_records_pk_order(&conn, new_rows.iter())?;
    conn.execute_batch("COMMIT")?;
    drop(conn);
    fsync_path(target_path)?;
    let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;

    Ok(DeltaResult {
        owner,
        rows_closed: member_idx.len(),
        elapsed_ms,
    })
}

pub fn run_b(store: &Store, target_dir: &Path) -> AnyResult<DeltaResult> {
    let (owner, member_idx) = pick_owner_rows(store, 1);
    let mut rng = StdRng::seed_from_u64(2);
    let new_rows: Vec<Row> = member_idx
        .iter()
        .map(|&i| make_edited_row(&store.rows[i], &mut rng))
        .collect();

    let t0 = Instant::now();

    let records_path = target_dir.join("records.sqlite");
    let conn = Connection::open(&records_path)?;
    conn.execute_batch("BEGIN")?;
    conn.execute(
        "UPDATE record_occurrences SET valid_to_generation = 2 \
         WHERE owner_artifact = ?1 AND valid_to_generation IS NULL",
        rusqlite::params![owner],
    )?;
    insert_records_pk_order(&conn, new_rows.iter())?;
    conn.execute_batch("COMMIT")?;
    drop(conn);

    let lookup_path = target_dir.join("lookup.sqlite");
    let conn = Connection::open(&lookup_path)?;
    conn.execute_batch("BEGIN")?;
    let old_record_ids: Vec<[u8; 32]> = member_idx
        .iter()
        .map(|&i| store.rows[i].record_id)
        .collect();
    {
        let mut stmt = conn.prepare(
            "UPDATE record_occurrences SET valid_to_generation = 2 WHERE record_id = ?1",
        )?;
        for id in &old_record_ids {
            stmt.execute(rusqlite::params![id.as_slice()])?;
        }
    }
    insert_lookup_pk_order(&conn, new_rows.iter())?;
    conn.execute_batch("COMMIT")?;
    drop(conn);

    let adjacency_path = target_dir.join("adjacency.sqlite");
    let conn = Connection::open(&adjacency_path)?;
    conn.execute_batch("BEGIN")?;
    {
        let mut stmt = conn.prepare(
            "UPDATE record_occurrences SET valid_to_generation = 2 WHERE record_id = ?1",
        )?;
        for id in &old_record_ids {
            stmt.execute(rusqlite::params![id.as_slice()])?;
        }
    }
    insert_adjacency_pk_order(&conn, new_rows.iter())?;
    conn.execute_batch("COMMIT")?;
    drop(conn);

    fsync_path(&records_path)?;
    fsync_path(&lookup_path)?;
    fsync_path(&adjacency_path)?;

    let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
    Ok(DeltaResult {
        owner,
        rows_closed: member_idx.len(),
        elapsed_ms,
    })
}

/// Single-threaded writer for a small row set, producing the same file
/// layout replay-c's `run` produces for the whole corpus. Used for the
/// delta-2 segment (a few hundred rows), where 10-way partitioning would be
/// pure overhead.
fn write_small_segment(rows: &[Row], out_dir: &Path) -> AnyResult<()> {
    std::fs::create_dir_all(out_dir)?;
    let n = rows.len();

    // Sort by record_id for the same reasons the full store does.
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_unstable_by(|&a, &b| rows[a].record_id.cmp(&rows[b].record_id));

    let mut keys = vec![0u8; n * KEYS_STRIDE];
    let mut meta = vec![0u8; n * META_STRIDE];
    let mut digests = vec![0u8; n * DIGESTS_STRIDE];
    let mut body = Vec::new();
    let mut ident = Vec::new();

    let mut by_owner: Vec<(u32, u32)> = Vec::with_capacity(n);
    let mut by_name: Vec<(u32, u32)> = Vec::new();
    let mut by_kind: Vec<(u16, u8, u16, u32)> = Vec::with_capacity(n);
    let mut by_identity: Vec<([u8; 32], u32)> = Vec::with_capacity(n);
    let mut adj_out: Vec<(u32, u32)> = Vec::new();
    let mut adj_in: Vec<(u32, u32)> = Vec::new();

    for (k, &i) in order.iter().enumerate() {
        let row = &rows[i];
        keys[k * KEYS_STRIDE..k * KEYS_STRIDE + 32].copy_from_slice(&row.record_id);

        let body_off = body.len() as u64;
        body.extend_from_slice(&row.body_payload);
        let ident_off = ident.len() as u64;
        ident.extend_from_slice(&row.identity_key);

        let m = &mut meta[k * META_STRIDE..(k + 1) * META_STRIDE];
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
        put_u64le(m, meta::BODY_OFF, body_off);
        put_u32le(m, meta::BODY_LEN, row.body_payload.len() as u32);
        put_u64le(m, meta::IDENT_OFF, ident_off);
        put_u32le(m, meta::IDENT_LEN, row.identity_key.len() as u32);

        let d = &mut digests[k * DIGESTS_STRIDE..(k + 1) * DIGESTS_STRIDE];
        d[digests::RECORD_DIGEST..digests::RECORD_DIGEST + 32].copy_from_slice(&row.record_digest);
        d[digests::BODY_DIGEST..digests::BODY_DIGEST + 32].copy_from_slice(&row.body_digest);
        d[digests::IDENTITY_ID..digests::IDENTITY_ID + 32].copy_from_slice(&row.identity_id);
        d[digests::IDENTITY_KEY_DIGEST..digests::IDENTITY_KEY_DIGEST + 32]
            .copy_from_slice(&row.identity_key_digest);
        d[digests::PREVIOUS_RECORD_ID..digests::PREVIOUS_RECORD_ID + 32]
            .copy_from_slice(&row.previous_record_id);

        by_owner.push((row.owner_artifact, k as u32));
        if row.name_id != NONE_U32 {
            by_name.push((row.name_id, k as u32));
        }
        by_kind.push((row.universal_kind_id, row.category, row.kind_id, k as u32));
        by_identity.push((row.identity_key_digest, k as u32));
        if row.source_subject != NONE_U32 {
            adj_out.push((row.source_subject, k as u32));
        }
        if row.target_subject != NONE_U32 {
            adj_in.push((row.target_subject, k as u32));
        }
    }
    by_owner.sort_unstable();
    by_name.sort_unstable();
    by_kind.sort_unstable();
    by_identity.sort_unstable();
    adj_out.sort_unstable();
    adj_in.sort_unstable();

    std::fs::write(out_dir.join("records.keys"), &keys)?;
    std::fs::write(out_dir.join("records.meta"), &meta)?;
    std::fs::write(out_dir.join("records.digests"), &digests)?;
    std::fs::write(out_dir.join("records.body"), &body)?;
    std::fs::write(out_dir.join("records.ident"), &ident)?;

    let write_pairs = |path: &Path, pairs: &[(u32, u32)]| -> std::io::Result<()> {
        let mut buf = Vec::with_capacity(pairs.len() * PAIR_STRIDE);
        for (a, b) in pairs {
            buf.extend_from_slice(&a.to_le_bytes());
            buf.extend_from_slice(&b.to_le_bytes());
        }
        std::fs::write(path, buf)
    };
    write_pairs(&out_dir.join("records.by_owner"), &by_owner)?;
    write_pairs(&out_dir.join("records.by_name"), &by_name)?;
    write_pairs(&out_dir.join("adj.out"), &adj_out)?;
    write_pairs(&out_dir.join("adj.in"), &adj_in)?;

    let mut kbuf = Vec::with_capacity(by_kind.len() * BY_KIND_STRIDE);
    for (u, c, kd, k) in by_kind {
        kbuf.extend_from_slice(&u.to_le_bytes());
        kbuf.push(c);
        kbuf.extend_from_slice(&kd.to_le_bytes());
        kbuf.extend_from_slice(&k.to_le_bytes());
    }
    std::fs::write(out_dir.join("records.by_kind"), &kbuf)?;

    let mut ibuf = Vec::with_capacity(by_identity.len() * BY_IDENTITY_STRIDE);
    for (digest, k) in by_identity {
        ibuf.extend_from_slice(&digest);
        ibuf.extend_from_slice(&k.to_le_bytes());
    }
    std::fs::write(out_dir.join("records.by_identity"), &ibuf)?;

    Ok(())
}

pub fn run_c(store: &Store, base_dir: &Path) -> AnyResult<DeltaResult> {
    let (owner, member_idx) = pick_owner_rows(store, 1);
    let mut rng = StdRng::seed_from_u64(2);
    let new_rows: Vec<Row> = member_idx
        .iter()
        .map(|&i| make_edited_row(&store.rows[i], &mut rng))
        .collect();
    let closed_ids: Vec<[u8; 32]> = member_idx
        .iter()
        .map(|&i| store.rows[i].record_id)
        .collect();

    let t0 = Instant::now();
    let delta_dir = base_dir.join("delta-2");
    let _ = std::fs::remove_dir_all(&delta_dir);
    write_small_segment(&new_rows, &delta_dir)?;

    // closures.records: (record_id 32B, generation u32) for every row closed
    // by this edit.
    let mut closures = Vec::with_capacity(closed_ids.len() * 36);
    for id in &closed_ids {
        closures.extend_from_slice(id);
        closures.extend_from_slice(&2u32.to_le_bytes());
    }
    std::fs::write(delta_dir.join("closures.records"), &closures)?;

    crate::util::fsync_path(&delta_dir)?;
    let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;

    Ok(DeltaResult {
        owner,
        rows_closed: member_idx.len(),
        elapsed_ms,
    })
}
