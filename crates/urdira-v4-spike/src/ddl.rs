//! Shared v4 DDL text and small helpers used by replay-a/b/c: the cold-load
//! pragma set, the `record_occurrences` table + its six indexes (created
//! after load, per the task brief), the small dictionary tables, and
//! `artifact_dependencies`.

use rusqlite::Connection;

pub const COLD_PRAGMAS: &[&str] = &[
    "PRAGMA journal_mode=OFF",
    "PRAGMA synchronous=OFF",
    "PRAGMA locking_mode=EXCLUSIVE",
    "PRAGMA cache_size=-1048576",
    "PRAGMA page_size=16384",
    "PRAGMA temp_store=MEMORY",
];

pub fn apply_cold_pragmas(conn: &Connection) -> rusqlite::Result<()> {
    for p in COLD_PRAGMAS {
        conn.execute_batch(p)?;
    }
    Ok(())
}

pub fn go_durable(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA journal_mode=WAL")?;
    conn.execute_batch("PRAGMA synchronous=NORMAL")?;
    Ok(())
}

pub const RECORD_OCCURRENCES_TABLE: &str = "
CREATE TABLE record_occurrences (
  record_id BLOB NOT NULL PRIMARY KEY,
  owner_artifact INTEGER NOT NULL,
  owner_version INTEGER NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER,
  category INTEGER NOT NULL,
  kind_id INTEGER NOT NULL,
  universal_kind_id INTEGER NOT NULL,
  facets INTEGER NOT NULL,
  span_artifact_version INTEGER,
  span_start_byte INTEGER,
  span_end_byte INTEGER,
  span_start_line INTEGER,
  span_end_line INTEGER,
  identity_type INTEGER,
  assignment_kind INTEGER,
  name_id INTEGER,
  identity_key TEXT,
  record_digest BLOB NOT NULL,
  body_digest BLOB NOT NULL,
  identity_id BLOB,
  identity_key_digest BLOB,
  previous_record_id BLOB,
  source_subject INTEGER,
  target_subject INTEGER,
  relation_kind_id INTEGER,
  body_payload BLOB NOT NULL
) STRICT, WITHOUT ROWID;
";

pub const RECORD_OCCURRENCES_INDEXES: &[&str] = &[
    "CREATE INDEX ro_owner ON record_occurrences(owner_artifact, valid_from_generation, valid_to_generation)",
    "CREATE INDEX ro_name ON record_occurrences(name_id, kind_id)",
    "CREATE INDEX ro_kind ON record_occurrences(universal_kind_id, category, kind_id, record_id)",
    "CREATE INDEX ro_ident ON record_occurrences(identity_key_digest, valid_from_generation)",
    "CREATE INDEX ro_out ON record_occurrences(source_subject, valid_from_generation, valid_to_generation, target_subject, relation_kind_id) WHERE source_subject IS NOT NULL",
    "CREATE INDEX ro_in ON record_occurrences(target_subject, valid_from_generation, valid_to_generation, source_subject, relation_kind_id) WHERE target_subject IS NOT NULL",
];

pub const DICTIONARY_TABLES: &str = "
CREATE TABLE dict_artifacts (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
CREATE TABLE dict_versions (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
CREATE TABLE dict_kinds (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
CREATE TABLE dict_universal_kinds (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
CREATE TABLE dict_identity_types (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
CREATE TABLE dict_assignment_kinds (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
CREATE TABLE dict_facets (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
CREATE TABLE dict_names (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
CREATE TABLE dict_subjects (id INTEGER PRIMARY KEY, subject_key BLOB NOT NULL) STRICT;
";

// --- replay-b: sharded table subsets -----------------------------------

pub const LOOKUP_TABLE: &str = "
CREATE TABLE record_occurrences (
  record_id BLOB NOT NULL PRIMARY KEY,
  name_id INTEGER,
  kind_id INTEGER NOT NULL,
  universal_kind_id INTEGER NOT NULL,
  category INTEGER NOT NULL,
  identity_key_digest BLOB,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER
) STRICT, WITHOUT ROWID;
";

pub const LOOKUP_INDEXES: &[&str] = &[
    "CREATE INDEX ro_name ON record_occurrences(name_id, kind_id)",
    "CREATE INDEX ro_kind ON record_occurrences(universal_kind_id, category, kind_id, record_id)",
    "CREATE INDEX ro_ident ON record_occurrences(identity_key_digest, valid_from_generation)",
];

pub const ADJACENCY_TABLE: &str = "
CREATE TABLE record_occurrences (
  record_id BLOB NOT NULL PRIMARY KEY,
  source_subject INTEGER,
  target_subject INTEGER,
  relation_kind_id INTEGER,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER
) STRICT, WITHOUT ROWID;
";

pub const ADJACENCY_INDEXES: &[&str] = &[
    "CREATE INDEX ro_out ON record_occurrences(source_subject, valid_from_generation, valid_to_generation, target_subject, relation_kind_id) WHERE source_subject IS NOT NULL",
    "CREATE INDEX ro_in ON record_occurrences(target_subject, valid_from_generation, valid_to_generation, source_subject, relation_kind_id) WHERE target_subject IS NOT NULL",
];

pub fn insert_lookup_pk_order<'a>(
    conn: &Connection,
    rows: impl Iterator<Item = &'a crate::row::Row>,
) -> AnyResult<()> {
    let mut stmt = conn.prepare(
        "INSERT INTO record_occurrences \
         (record_id, name_id, kind_id, universal_kind_id, category, identity_key_digest, \
          valid_from_generation, valid_to_generation) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
    )?;
    for row in rows {
        stmt.execute(rusqlite::params![
            row.record_id.as_slice(),
            opt_u32_param(row.name_id),
            row.kind_id,
            row.universal_kind_id,
            row.category,
            opt_bytes32(&row.identity_key_digest),
            row.valid_from,
            valid_to_param(row.valid_to),
        ])?;
    }
    Ok(())
}

pub fn insert_adjacency_pk_order<'a>(
    conn: &Connection,
    rows: impl Iterator<Item = &'a crate::row::Row>,
) -> AnyResult<()> {
    let mut stmt = conn.prepare(
        "INSERT INTO record_occurrences \
         (record_id, source_subject, target_subject, relation_kind_id, valid_from_generation, \
          valid_to_generation) VALUES (?1,?2,?3,?4,?5,?6)",
    )?;
    for row in rows {
        stmt.execute(rusqlite::params![
            row.record_id.as_slice(),
            opt_u32_param(row.source_subject),
            opt_u32_param(row.target_subject),
            opt_u16_param(row.relation_kind_id),
            row.valid_from,
            valid_to_param(row.valid_to),
        ])?;
    }
    Ok(())
}

pub const ARTIFACT_DEPENDENCIES_TABLE: &str = "
CREATE TABLE artifact_dependencies (
  dependency_entry_id BLOB NOT NULL PRIMARY KEY,
  record_id BLOB NOT NULL,
  owner_artifact INTEGER NOT NULL,
  dependency_artifact INTEGER NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER,
  content_digest BLOB NOT NULL
) STRICT;
";

use crate::AnyResult;
use crate::row::Dictionaries;

pub fn insert_dictionaries(conn: &Connection, dict: &Dictionaries) -> AnyResult<()> {
    fn insert_strs(conn: &Connection, table: &str, values: &[String]) -> AnyResult<()> {
        let sql = format!("INSERT INTO {table} (id, name) VALUES (?1, ?2)");
        let mut stmt = conn.prepare(&sql)?;
        for (id, v) in values.iter().enumerate() {
            stmt.execute(rusqlite::params![id as i64, v])?;
        }
        Ok(())
    }
    insert_strs(conn, "dict_artifacts", &dict.artifacts)?;
    insert_strs(conn, "dict_versions", &dict.versions)?;
    insert_strs(conn, "dict_kinds", &dict.kinds)?;
    insert_strs(conn, "dict_universal_kinds", &dict.universal_kinds)?;
    insert_strs(conn, "dict_identity_types", &dict.identity_types)?;
    insert_strs(conn, "dict_assignment_kinds", &dict.assignment_kinds)?;
    insert_strs(conn, "dict_facets", &dict.facets)?;
    insert_strs(conn, "dict_names", &dict.names)?;
    {
        let mut stmt =
            conn.prepare("INSERT INTO dict_subjects (id, subject_key) VALUES (?1, ?2)")?;
        for (id, key) in dict.subjects.iter().enumerate() {
            stmt.execute(rusqlite::params![id as i64, key.as_slice()])?;
        }
    }
    Ok(())
}

pub fn insert_artifact_dependencies(
    conn: &Connection,
    deps: &[crate::deps::DepRow],
) -> AnyResult<()> {
    let mut stmt = conn.prepare(
        "INSERT INTO artifact_dependencies \
         (dependency_entry_id, record_id, owner_artifact, dependency_artifact, \
          valid_from_generation, valid_to_generation, content_digest) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    for d in deps {
        let valid_to: Option<i64> = if d.valid_to == 0 {
            None
        } else {
            Some(d.valid_to as i64)
        };
        stmt.execute(rusqlite::params![
            d.dependency_entry_id.as_slice(),
            d.record_id.as_slice(),
            d.owner_artifact,
            d.dependency_artifact,
            d.valid_from,
            valid_to,
            d.content_digest.as_slice(),
        ])?;
    }
    Ok(())
}

fn valid_to_param(v: u32) -> Option<i64> {
    if v == 0 { None } else { Some(v as i64) }
}

fn opt_u32_param(v: u32) -> Option<i64> {
    if v == crate::row::NONE_U32 {
        None
    } else {
        Some(v as i64)
    }
}

fn opt_u16_param(v: u16) -> Option<i64> {
    if v == crate::row::NONE_U16 {
        None
    } else {
        Some(v as i64)
    }
}

fn opt_bytes32(v: &[u8; 32]) -> Option<&[u8]> {
    if *v == [0u8; 32] {
        None
    } else {
        Some(v.as_slice())
    }
}

/// Insert every row of `rows_in_pk_order` (already sorted by `record_id`)
/// into an already-created `record_occurrences` table, one transaction.
pub fn insert_records_pk_order<'a>(
    conn: &Connection,
    rows_in_pk_order: impl Iterator<Item = &'a crate::row::Row>,
) -> AnyResult<()> {
    let mut stmt = conn.prepare(
        "INSERT INTO record_occurrences \
         (record_id, owner_artifact, owner_version, valid_from_generation, valid_to_generation, \
          category, kind_id, universal_kind_id, facets, span_artifact_version, span_start_byte, \
          span_end_byte, span_start_line, span_end_line, identity_type, assignment_kind, name_id, \
          identity_key, record_digest, body_digest, identity_id, identity_key_digest, \
          previous_record_id, source_subject, target_subject, relation_kind_id, body_payload) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27)",
    )?;
    for row in rows_in_pk_order {
        stmt.execute(rusqlite::params![
            row.record_id.as_slice(),
            row.owner_artifact,
            row.owner_version,
            row.valid_from,
            valid_to_param(row.valid_to),
            row.category,
            row.kind_id,
            row.universal_kind_id,
            row.facets,
            opt_u32_param(row.span_artifact_version),
            row.span_start_byte,
            row.span_end_byte,
            row.span_start_line,
            row.span_end_line,
            row.identity_type,
            row.assignment_kind,
            opt_u32_param(row.name_id),
            String::from_utf8_lossy(&row.identity_key).to_string(),
            row.record_digest.as_slice(),
            row.body_digest.as_slice(),
            opt_bytes32(&row.identity_id),
            opt_bytes32(&row.identity_key_digest),
            opt_bytes32(&row.previous_record_id),
            opt_u32_param(row.source_subject),
            opt_u32_param(row.target_subject),
            opt_u16_param(row.relation_kind_id),
            row.body_payload.as_slice(),
        ])?;
    }
    Ok(())
}
