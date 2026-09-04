//! Compaction (plan §2.3): merges base+deltas into a fresh base and
//! publishes a manifest with an empty delta list.
//!
//! Scope note: rows closed before the retained generation are dropped
//! entirely rather than kept as a 36-byte `by_identity` stub for
//! identity-chain continuity across the compaction boundary (plan
//! §2.3's "salvo las necesarias para la cadena de identidad"). That stub
//! representation is a real structural addition (a `by_identity` entry
//! with no backing `records.*` row) out of scope for this deliverable;
//! documented as a deviation in the evidence doc. `by_identity_last`
//! therefore only sees identity history back to the last compaction.

use crate::error::Result;
use crate::reader::{DependencyView, RecordView, StoreReader};
use crate::refcount;
use crate::row::{DependencyRow, NONE_U16, NONE_U32, RecordRow};
use crate::writer::{SegmentSummary, SegmentWriter};
use std::path::Path;

fn view_to_row(v: &RecordView) -> RecordRow {
    RecordRow {
        record_id: v.record_id(),
        owner_artifact: v.owner_artifact(),
        owner_version: v.owner_version(),
        valid_from: v.valid_from(),
        valid_to: v.valid_to_effective(),
        category: v.category(),
        kind_id: v.kind_id(),
        universal_kind_id: v.universal_kind_id(),
        facets: v.facets(),
        span_artifact_version: v.span_artifact_version(),
        span_start_byte: v.span_start_byte(),
        span_end_byte: v.span_end_byte(),
        span_start_line: v.span_start_line(),
        span_end_line: v.span_end_line(),
        identity_type: v.identity_type(),
        assignment_kind: v.assignment_kind(),
        name_id: v.name_id().unwrap_or(NONE_U32),
        identity_key: v.identity_key().to_vec(),
        record_digest: v.record_digest(),
        body_digest: v.body_digest(),
        identity_id: v.identity_id(),
        identity_key_digest: v.identity_key_digest(),
        previous_record_id: v.previous_record_id(),
        source_subject: v.source_subject(),
        target_subject: v.target_subject(),
        relation_kind_id: v.relation_kind_id().unwrap_or(NONE_U16),
        body: v.body().to_vec(),
    }
}

fn dep_view_to_row(v: &DependencyView) -> DependencyRow {
    DependencyRow {
        dependency_id: v.dependency_id(),
        record: v.record(),
        owner_artifact: v.owner_artifact(),
        owner_version: v.owner_version(),
        dep_artifact: v.dep_artifact(),
        dep_version: v.dep_version(),
        role: v.role(),
        valid_from: v.valid_from(),
        valid_to: v.valid_to_effective(),
    }
}

/// Rewrites `dir`'s base+deltas into a single new base at
/// `new_generation` and publishes the new manifest. Old base/delta
/// directories are deleted afterward unless a live process still
/// references them (`refcount::segments_in_use`).
pub fn compact(dir: &Path, new_generation: u64) -> Result<SegmentSummary> {
    let reader = StoreReader::open(dir)?;
    let old_manifest = reader.manifest();

    let rows: Vec<RecordRow> = reader
        .iter_visible(new_generation)
        .map(|v| view_to_row(&v))
        .collect();
    let deps: Vec<DependencyRow> = reader
        .iter_visible_deps(new_generation)
        .into_iter()
        .map(|v| dep_view_to_row(&v))
        .collect();
    let dicts = reader.dictionaries();

    let summary = SegmentWriter::new().write_base(dir, &rows, &deps, &dicts, new_generation)?;

    let in_use = refcount::segments_in_use(dir)?;
    let mut old_names = vec![old_manifest.base.clone()];
    old_names.extend(old_manifest.deltas.iter().cloned());
    for name in old_names {
        if in_use.contains(&name) {
            continue;
        }
        // P3-6 item 1: a base segment is a directory (`base-<g>/`,
        // unchanged); a delta generation is now a single container file
        // (`delta-<g>.seg`) -- `remove_dir_all` errors on a plain file, so
        // dispatch on which one this name actually is rather than
        // assuming (this loop pre-dates delta containers and used to
        // remove directories unconditionally).
        let path = dir.join(&name);
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }

    Ok(summary)
}
