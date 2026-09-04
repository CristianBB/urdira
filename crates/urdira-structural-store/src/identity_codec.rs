//! A3a (2026-09-05): reconstructs a canonical `identity_key` string from
//! the typed fields a [`RecordRow`] already carries, instead of storing the
//! full string in `records.ident` for every row. Every producer in this
//! pipeline mints an identity key of one of two fixed shapes (verified
//! against the producers directly, not just the plan doc -- see the
//! deviation notes below):
//!
//! - Entity: `jsts:{kind}:{path}:{start}:{name}` (`declaration_id`/
//!   `stable_entity_id` in `urdira-jsts-syntax-worker`).
//! - Relation: `jsts:{rel}:{path}:{start}:{end}:{source_identity_key}:
//!   {target_identity_key}` (`call_proposed_record`/`heritage_proposed_
//!   record`/`reference_proposed_record`/... in the same crate; `residual.
//!   rs`'s own Rust-resolved relation rows use the identical shape).
//!
//! [`classify_identity`] tries to rebuild that exact string from the row's
//! OWN typed fields (never by parsing the original string) and compares
//! the candidate to `row.identity_key` BYTE FOR BYTE. Only an exact match
//! gets tagged (`IDENTITY_LAYOUT_ENTITY`/`_RELATION`, nothing stored in
//! `records.ident`); anything else -- a non-canonical identity (`jsts:
//! external_module:*`, `jsts:type-of:*`, a residual diagnostic, a
//! v3-converted store's key, a test fixture's own key), a relation whose
//! endpoint isn't resolvable, or genuine producer drift -- falls back to
//! `IDENTITY_LAYOUT_RAW` (the pre-A3a behavior: the real bytes are stored
//! verbatim). This makes the whole scheme self-correcting: a producer bug
//! or an unanticipated shape can only ever cost space (that row's bytes
//! get stored after all), never correctness.
//!
//! **Deviation found while implementing this** (worth flagging up front,
//! not just in the evidence doc): the design brief this module implements
//! assumes an ENTITY row's `{kind}` segment is recoverable as `dicts.
//! kinds[kind_id]` directly, mirroring how a RELATION row's `dicts.
//! kinds[kind_id]` is exactly `"jsts:relation_{rel}"` (a fixed 14-byte
//! prefix in front of the SAME word the identity string uses -- confirmed
//! live, `try_relation` below strips it and matches). That symmetry does
//! NOT hold for entities: `urdira-jsts-syntax-worker::proposal_entity_
//! record` (the entity `ProposedRecord`'s only producer) always stamps
//! `RecordRow.kind`'s dictionary text as one of five COARSE `UniversalKind`
//! -bucketed words (`"jsts:entity_container"`/`"_callable"`/`"_type"`/
//! `"_variable"`/`"_parameter"`), never the FINE per-declaration word
//! (`"function"`/`"class"`/`"method"`/`"getter"`/... -- `EntityKind::
//! identity_name()`) the identity string's `{kind}` segment actually uses;
//! `urdira-indexing-worker::v4::residual::try_synthesize_member_entity`
//! (the other entity producer) stamps the same two coarse words for its own
//! synthesized rows. No `RecordRow` field carries the fine word (`body`
//! does, but decoding a row's body to reconstruct its own identity would
//! defeat the point of this task, and is out of scope regardless -- see
//! A3b). Net effect: `try_entity` below, implemented exactly as the design
//! brief specifies (`dicts.kinds[kind_id]` verbatim, no extra guessing),
//! essentially NEVER matches for a real entity row -- entities fall back to
//! `IDENTITY_LAYOUT_RAW` universally. This costs nothing in correctness
//! (the byte-compare guard is exactly what makes this safe) and nothing in
//! implementation complexity (no special-casing needed), only some of the
//! space savings a working entity reconstruction would have bought;
//! relations (which embed two entities' full identity strings each, and so
//! carry the bulk of `records.ident`'s bytes at real-corpus scale) still
//! canonicalize correctly and are unaffected by this. See `identity_codec_
//! test.rs`'s `entity_kind_dict_text_is_the_coarse_universal_bucket_not_the_
//! fine_word` test for a reproduction against the real producer shapes.

use crate::row::{CATEGORY_ENTITY, CATEGORY_RELATION, Dictionaries, RecordRow};

pub const IDENTITY_LAYOUT_RAW: u8 = crate::layout::meta::IDENTITY_LAYOUT_RAW;
pub const IDENTITY_LAYOUT_ENTITY: u8 = crate::layout::meta::IDENTITY_LAYOUT_ENTITY;
pub const IDENTITY_LAYOUT_RELATION: u8 = crate::layout::meta::IDENTITY_LAYOUT_RELATION;

/// `jsts:{kind}:{path}:{start}:{name}` -- byte concatenation, not string
/// formatting of the segments themselves, so a `name`/`path` that happens
/// to contain a literal `:` is handled correctly (this is never parsed
/// back apart, only ever compared whole against the producer's own
/// string).
pub fn reconstruct_entity(kind: &str, path: &str, start: u32, name: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        5 + kind.len() + 1 + path.len() + 1 + 10 + 1 + name.len(), // "jsts:" is 5 bytes; 10 is a generous digit-count guess for `start`
    );
    out.extend_from_slice(b"jsts:");
    out.extend_from_slice(kind.as_bytes());
    out.push(b':');
    out.extend_from_slice(path.as_bytes());
    out.push(b':');
    out.extend_from_slice(start.to_string().as_bytes());
    out.push(b':');
    out.extend_from_slice(name.as_bytes());
    out
}

/// `jsts:{rel}:{path}:{start}:{end}:{source_identity_key}:
/// {target_identity_key}` -- `source_key`/`target_key` are the two
/// endpoints' own (possibly themselves reconstructed) identity key BYTES,
/// spliced in directly, never re-parsed.
pub fn reconstruct_relation(
    rel: &str,
    path: &str,
    start: u32,
    end: u32,
    source_key: &[u8],
    target_key: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        5 + rel.len()
            + 1
            + path.len()
            + 1
            + 10
            + 1
            + 10
            + 1
            + source_key.len()
            + 1
            + target_key.len(),
    );
    out.extend_from_slice(b"jsts:");
    out.extend_from_slice(rel.as_bytes());
    out.push(b':');
    out.extend_from_slice(path.as_bytes());
    out.push(b':');
    out.extend_from_slice(start.to_string().as_bytes());
    out.push(b':');
    out.extend_from_slice(end.to_string().as_bytes());
    out.push(b':');
    out.extend_from_slice(source_key);
    out.push(b':');
    out.extend_from_slice(target_key);
    out
}

/// `"artifact:{path}"` -> `{path}` -- the fixed shape every owner-artifact
/// text this pipeline mints uses (`analyze.rs`/`typeflow.rs`/`main.rs`/
/// `indexing-core::lib`/`syntax-worker::lib` all agree, per the task
/// brief). Returns `None` (falling the caller back to Raw) for anything
/// else -- a v3-converted store's artifact text, in particular, is not
/// guaranteed to follow this convention.
fn artifact_path(dicts: &Dictionaries, owner_artifact: u32) -> Option<&str> {
    let (text, _version) = dicts.artifacts.get(owner_artifact as usize)?;
    text.strip_prefix("artifact:")
}

/// Attempts the ENTITY candidate for `row`. `None` on any field this row
/// doesn't carry (out-of-range dictionary ordinal, no `name_id`, wrong
/// category) -- never panics, never guesses.
fn try_entity(row: &RecordRow, dicts: &Dictionaries) -> Option<Vec<u8>> {
    if row.category != CATEGORY_ENTITY {
        return None;
    }
    let kind = dicts.kinds.get(row.kind_id as usize)?;
    let path = artifact_path(dicts, row.owner_artifact)?;
    let name_id = row.name_id_opt()?;
    let name = dicts.names.get(name_id as usize)?;
    Some(reconstruct_entity(kind, path, row.span_start_byte, name))
}

/// Attempts the RELATION candidate for `row`: both `source_subject`/
/// `target_subject` must be present AND resolvable via `resolve_identity`
/// (the caller's batch-plus-store lookup, `record_id -> identity_key
/// bytes`) -- `None` otherwise, same never-guess discipline as
/// [`try_entity`].
fn try_relation(
    row: &RecordRow,
    dicts: &Dictionaries,
    resolve_identity: &dyn Fn(&[u8; 32]) -> Option<Vec<u8>>,
) -> Option<Vec<u8>> {
    if row.category != CATEGORY_RELATION {
        return None;
    }
    let kind_text = dicts.kinds.get(row.kind_id as usize)?;
    let rel = kind_text.strip_prefix("jsts:relation_")?;
    let path = artifact_path(dicts, row.owner_artifact)?;
    let source_ord = row.source_subject?;
    let target_ord = row.target_subject?;
    let source_record_id = dicts.subjects.get(source_ord as usize)?;
    let target_record_id = dicts.subjects.get(target_ord as usize)?;
    let source_key = resolve_identity(source_record_id)?;
    let target_key = resolve_identity(target_record_id)?;
    Some(reconstruct_relation(
        rel,
        path,
        row.span_start_byte,
        row.span_end_byte,
        &source_key,
        &target_key,
    ))
}

/// Classifies one row's identity storage layout tag only -- no allocation
/// beyond the (cheap, short-lived) candidate strings themselves, unlike
/// [`classify_identity`], which additionally clones `row.identity_key` for
/// the `RAW` case. Used by the hot per-row write loops (`segment_io.rs`),
/// which already have `row.identity_key` directly at hand when they later
/// decide whether to push its bytes, so paying for a clone here (once per
/// row, at real-corpus scale a large fraction of `records.ident`'s own
/// 533MB) would be pure waste.
pub fn classify_identity_layout(
    row: &RecordRow,
    dicts: &Dictionaries,
    resolve_identity: &dyn Fn(&[u8; 32]) -> Option<Vec<u8>>,
) -> u8 {
    match row.category {
        CATEGORY_ENTITY => {
            if let Some(candidate) = try_entity(row, dicts)
                && candidate == row.identity_key
            {
                return IDENTITY_LAYOUT_ENTITY;
            }
        }
        CATEGORY_RELATION => {
            if let Some(candidate) = try_relation(row, dicts, resolve_identity)
                && candidate == row.identity_key
            {
                return IDENTITY_LAYOUT_RELATION;
            }
        }
        _ => {}
    }
    IDENTITY_LAYOUT_RAW
}

/// Classifies one row's identity storage layout: `(layout_tag, ident_
/// bytes_to_write)`. `ident_bytes_to_write` is EMPTY for a tagged layout
/// (`ENTITY`/`RELATION` -- nothing is stored, the reader reconstructs it)
/// and `row.identity_key.clone()` for `RAW` (stored verbatim, exactly the
/// pre-A3a behavior). Never parses `row.identity_key` -- only ever builds
/// a candidate from `row`'s own typed fields and compares the two whole
/// strings byte for byte. Prefer [`classify_identity_layout`] in a hot
/// per-row loop that already has `row.identity_key` at hand.
pub fn classify_identity(
    row: &RecordRow,
    dicts: &Dictionaries,
    resolve_identity: &dyn Fn(&[u8; 32]) -> Option<Vec<u8>>,
) -> (u8, Vec<u8>) {
    let layout = classify_identity_layout(row, dicts, resolve_identity);
    let bytes = if layout == IDENTITY_LAYOUT_RAW {
        row.identity_key.clone()
    } else {
        Vec::new()
    };
    (layout, bytes)
}

/// A batch's `record_id -> identity_key bytes` lookup, built once up front
/// (never inside a `par_iter`/per-row loop -- see `writer.rs`'s and
/// `segment_io.rs`'s own doc comments on where each caller builds one of
/// these) and shared by reference. Every entity a relation in the SAME
/// batch points at is looked up here; a delta writer additionally falls
/// back to the live store (`StoreReader::get(id).identity_key()`) for an
/// endpoint minted in an earlier generation -- that fallback lives in
/// `writer.rs`, not here, since this module has no dependency on `reader`.
pub struct BatchIndex<'a> {
    by_record_id: std::collections::HashMap<[u8; 32], &'a [u8]>,
}

impl<'a> BatchIndex<'a> {
    pub fn from_rows(rows: &'a [RecordRow]) -> Self {
        let mut by_record_id = std::collections::HashMap::with_capacity(rows.len());
        for row in rows {
            by_record_id.insert(row.record_id, row.identity_key.as_slice());
        }
        BatchIndex { by_record_id }
    }

    pub fn from_partitions(partitions: &'a [Vec<RecordRow>]) -> Self {
        let total: usize = partitions.iter().map(Vec::len).sum();
        let mut by_record_id = std::collections::HashMap::with_capacity(total);
        for part in partitions {
            for row in part {
                by_record_id.insert(row.record_id, row.identity_key.as_slice());
            }
        }
        BatchIndex { by_record_id }
    }

    pub fn get(&self, record_id: &[u8; 32]) -> Option<Vec<u8>> {
        self.by_record_id.get(record_id).map(|s| s.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::{CATEGORY_DIAGNOSTIC, NONE_U16, NONE_U32};

    fn base_row() -> RecordRow {
        RecordRow {
            record_id: [1u8; 32],
            owner_artifact: 0,
            owner_version: 0,
            valid_from: 1,
            valid_to: 0,
            category: CATEGORY_ENTITY,
            kind_id: 0,
            universal_kind_id: 0,
            facets: 0,
            span_artifact_version: 0,
            span_start_byte: 100,
            span_end_byte: 0,
            span_start_line: 0,
            span_end_line: 0,
            identity_type: 0,
            assignment_kind: 0,
            name_id: NONE_U32,
            identity_key: Vec::new(),
            record_digest: [0u8; 32],
            body_digest: [0u8; 32],
            identity_id: [0u8; 32],
            identity_key_digest: [0u8; 32],
            previous_record_id: [0u8; 32],
            source_subject: None,
            target_subject: None,
            relation_kind_id: NONE_U16,
            body: Vec::new(),
        }
    }

    fn dicts_with(kinds: &[&str], artifacts: &[&str], names: &[&str]) -> Dictionaries {
        Dictionaries {
            kinds: kinds.iter().map(|s| s.to_string()).collect(),
            universal_kinds: Vec::new(),
            relation_kinds: Vec::new(),
            names: names.iter().map(|s| s.to_string()).collect(),
            subjects: Vec::new(),
            artifacts: artifacts
                .iter()
                .map(|s| (s.to_string(), String::new()))
                .collect(),
            facet_names: Vec::new(),
            subject_text: Vec::new(),
        }
    }

    fn no_resolve(_: &[u8; 32]) -> Option<Vec<u8>> {
        None
    }

    #[test]
    fn canonical_entity_tags_and_stores_nothing() {
        let dicts = dicts_with(&["function"], &["artifact:src/a.ts"], &["greet"]);
        let mut row = base_row();
        row.kind_id = 0;
        row.owner_artifact = 0;
        row.name_id = 0;
        row.identity_key = b"jsts:function:src/a.ts:100:greet".to_vec();
        let (layout, bytes) = classify_identity(&row, &dicts, &no_resolve);
        assert_eq!(layout, IDENTITY_LAYOUT_ENTITY);
        assert!(bytes.is_empty());
    }

    #[test]
    fn canonical_relation_with_both_endpoints_resolved_tags() {
        let dicts = dicts_with(&["jsts:relation_call"], &["artifact:src/a.ts"], &["callee"]);
        let mut row = base_row();
        row.category = CATEGORY_RELATION;
        row.kind_id = 0;
        row.owner_artifact = 0;
        row.span_start_byte = 10;
        row.span_end_byte = 20;
        row.source_subject = Some(0);
        row.target_subject = Some(1);
        // `dicts.subjects` isn't populated in `dicts_with`; patch it in.
        let mut dicts = dicts;
        dicts.subjects = vec![[7u8; 32], [8u8; 32]];
        row.identity_key = b"jsts:call:src/a.ts:10:20:src-key:target-key".to_vec();
        let resolve = |id: &[u8; 32]| -> Option<Vec<u8>> {
            if *id == [7u8; 32] {
                Some(b"src-key".to_vec())
            } else if *id == [8u8; 32] {
                Some(b"target-key".to_vec())
            } else {
                None
            }
        };
        let (layout, bytes) = classify_identity(&row, &dicts, &resolve);
        assert_eq!(layout, IDENTITY_LAYOUT_RELATION);
        assert!(bytes.is_empty());
    }

    #[test]
    fn external_module_identity_falls_back_to_raw() {
        let dicts = dicts_with(&["jsts:entity_container"], &["artifact:src/a.ts"], &[]);
        let mut row = base_row();
        row.kind_id = 0;
        row.name_id = NONE_U32;
        row.identity_key = b"jsts:external_module:lodash".to_vec();
        let (layout, bytes) = classify_identity(&row, &dicts, &no_resolve);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(bytes, row.identity_key);
    }

    #[test]
    fn type_of_identity_falls_back_to_raw() {
        let dicts = dicts_with(&["jsts:entity_type"], &["artifact:src/a.ts"], &["Foo"]);
        let mut row = base_row();
        row.kind_id = 0;
        row.name_id = 0;
        row.identity_key = b"jsts:type-of:some-entity-id:Foo".to_vec();
        let (layout, bytes) = classify_identity(&row, &dicts, &no_resolve);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(bytes, row.identity_key);
    }

    #[test]
    fn arbitrary_string_falls_back_to_raw() {
        let dicts = dicts_with(&["function"], &["artifact:src/a.ts"], &["greet"]);
        let mut row = base_row();
        row.kind_id = 0;
        row.name_id = 0;
        row.identity_key = b"not-even-close-to-canonical".to_vec();
        let (layout, bytes) = classify_identity(&row, &dicts, &no_resolve);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(bytes, row.identity_key);
    }

    #[test]
    fn relation_with_missing_target_subject_falls_back_to_raw() {
        let dicts = dicts_with(&["jsts:relation_call"], &["artifact:src/a.ts"], &[]);
        let mut row = base_row();
        row.category = CATEGORY_RELATION;
        row.kind_id = 0;
        row.source_subject = Some(0);
        row.target_subject = None;
        row.identity_key = b"jsts:call:src/a.ts:10:20:src-key:target-key".to_vec();
        let (layout, bytes) = classify_identity(&row, &dicts, &no_resolve);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(bytes, row.identity_key);
    }

    #[test]
    fn relation_with_unresolvable_endpoint_falls_back_to_raw() {
        let mut dicts = dicts_with(&["jsts:relation_call"], &["artifact:src/a.ts"], &[]);
        dicts.subjects = vec![[7u8; 32], [8u8; 32]];
        let mut row = base_row();
        row.category = CATEGORY_RELATION;
        row.kind_id = 0;
        row.source_subject = Some(0);
        row.target_subject = Some(1);
        row.identity_key = b"jsts:call:src/a.ts:10:20:src-key:target-key".to_vec();
        // resolve_identity never resolves anything -- simulates an
        // endpoint not present in this batch nor the live store.
        let (layout, bytes) = classify_identity(&row, &dicts, &no_resolve);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(bytes, row.identity_key);
    }

    #[test]
    fn out_of_range_kind_id_falls_back_to_raw_without_panicking() {
        let dicts = dicts_with(&[], &["artifact:src/a.ts"], &["greet"]);
        let mut row = base_row();
        row.kind_id = 5; // out of range: `dicts.kinds` is empty
        row.name_id = 0;
        row.identity_key = b"jsts:function:src/a.ts:100:greet".to_vec();
        let (layout, bytes) = classify_identity(&row, &dicts, &no_resolve);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(bytes, row.identity_key);
    }

    #[test]
    fn diagnostic_category_always_falls_back_to_raw() {
        let dicts = dicts_with(&["jsts:diagnostic"], &["artifact:src/a.ts"], &[]);
        let mut row = base_row();
        row.category = CATEGORY_DIAGNOSTIC;
        row.kind_id = 0;
        row.identity_key = b"jsts:diagnostic:src/a.ts:1:2:some-code".to_vec();
        let (layout, bytes) = classify_identity(&row, &dicts, &no_resolve);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(bytes, row.identity_key);
    }

    /// A name (the LAST identity segment) containing a literal `:` (e.g. a
    /// path segment `a:b/c.ts` embedded upstream, or a name that itself
    /// contains a colon) must not confuse reconstruction -- this module
    /// never parses the string apart, only ever builds one from typed
    /// fields and compares wholesale, so an embedded `:` anywhere is inert.
    #[test]
    fn colon_inside_path_still_reconstructs_correctly() {
        let dicts = dicts_with(&["function"], &["artifact:a:b/c.ts"], &["greet"]);
        let mut row = base_row();
        row.kind_id = 0;
        row.owner_artifact = 0;
        row.name_id = 0;
        row.identity_key = b"jsts:function:a:b/c.ts:100:greet".to_vec();
        let (layout, bytes) = classify_identity(&row, &dicts, &no_resolve);
        assert_eq!(layout, IDENTITY_LAYOUT_ENTITY);
        assert!(bytes.is_empty());
    }

    /// Documents the deviation from the design brief described in this
    /// module's own doc comment: a REAL entity row's `kind` dictionary
    /// text is always one of the five coarse `UniversalKind`-bucketed
    /// words (`proposal_entity_record`'s only vocabulary), never the fine
    /// per-declaration word (`EntityKind::identity_name()`) the identity
    /// string's `{kind}` segment actually uses -- so `try_entity`,
    /// implemented exactly as specified (`dicts.kinds[kind_id]` verbatim),
    /// never matches a real entity and every real entity row ends up Raw.
    #[test]
    fn entity_kind_dict_text_is_the_coarse_universal_bucket_not_the_fine_word() {
        let dicts = dicts_with(&["jsts:entity_variable"], &["artifact:src/a.ts"], &["x"]);
        let mut row = base_row();
        row.kind_id = 0;
        row.owner_artifact = 0;
        row.name_id = 0;
        // The REAL identity a producer would mint for a `variable` entity
        // (`EntityKind::Variable::identity_name() == "variable"`).
        row.identity_key = b"jsts:variable:src/a.ts:100:x".to_vec();
        let (layout, bytes) = classify_identity(&row, &dicts, &no_resolve);
        // `try_entity` builds "jsts:jsts:entity_variable:src/a.ts:100:x"
        // (the dict text used verbatim), which does not match -- Raw,
        // exactly as this test's own name documents.
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(bytes, row.identity_key);
    }
}
