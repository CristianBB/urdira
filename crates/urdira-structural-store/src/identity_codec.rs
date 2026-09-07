//! A3a / A3a-fix (2026-09-05): reconstructs a canonical `identity_key`
//! string from the typed fields a [`RecordRow`] already carries, instead of
//! storing the full string in `records.ident` for every row. Every producer
//! in this pipeline mints an identity key of one of three fixed shapes
//! (verified against the producers directly, not just the plan doc):
//!
//! - Entity: `jsts:{kind}:{path}:{start}:{name}` (`declaration_id`/
//!   `stable_entity_id` in `urdira-jsts-syntax-worker`).
//! - Relation (spanned): `jsts:{rel}:{path}:{start}:{end}:
//!   {source_identity_key}:{target_identity_key}` (`call_proposed_record`/
//!   `heritage_proposed_record`/`reference_proposed_record`/... in the same
//!   crate; `residual.rs`'s own Rust-resolved relation rows use the
//!   identical shape).
//! - Relation (no span, e.g. `contains`): `jsts:{rel}:
//!   {source_identity_key}:{target_identity_key}`.
//!
//! [`classify_identity`] tries to rebuild the exact string from the row's
//! OWN typed fields (never by parsing the original string apart to recover
//! `path`/`start`/`end`/`name` -- only the entity `{kind}` word, see the
//! A3a-fix section below, is ever extracted from the original string) and
//! compares the candidate to `row.identity_key` BYTE FOR BYTE. Only an exact
//! match gets tagged (`IDENTITY_LAYOUT_ENTITY`/`_RELATION`/
//! `_RELATION_NO_SPAN`, nothing stored in `records.ident`); anything else --
//! a non-canonical identity (`jsts:external_module:*`, `jsts:type-of:*`, a
//! residual diagnostic, a v3-converted store's key, a test fixture's own
//! key), a relation whose endpoint isn't resolvable, or genuine producer
//! drift -- falls back to `IDENTITY_LAYOUT_RAW` (the pre-A3a behavior: the
//! real bytes are stored verbatim). This makes the whole scheme self-
//! correcting: a producer bug or an unanticipated shape can only ever cost
//! space (that row's bytes get stored after all), never correctness.
//!
//! # A3a-fix (this revision)
//!
//! The original A3a landed with two bugs, both diagnosed against a real
//! n8n cold scan (`records.ident` measured 611MB, essentially unchanged
//! from pre-A3a, i.e. EVERY row fell back to Raw):
//!
//! 1. **`{path}` was never recoverable.** The original [`artifact_path`]
//!    assumed `dicts.artifacts[owner_artifact].0` was always the fixed-
//!    prefix text `"artifact:{path}"` (true only in this crate's own test
//!    fixtures). In production the real `artifact_id`
//!    (`urdira-source-frontier::ids::digest_logical_value`) is a content
//!    digest with no path embedded in it at all -- there was no way to ever
//!    strip a path back out of it. Fixed by adding a dedicated
//!    `dicts.artifact_paths` dictionary (`row.rs`), populated by the ONLY
//!    party that actually knows a real owner path (`urdira-indexing-
//!    worker`'s materialize pass, from `OwnerKernelRows::owner_path`) and
//!    aligned 1:1 by ordinal with `dicts.artifacts` -- exactly the same
//!    convention `dicts.subject_text` already uses relative to `dicts.
//!    subjects`. [`artifact_path`] below now reads this new dictionary
//!    directly, no string-prefix stripping at all.
//! 2. **An entity's `{kind}` segment was never recoverable either.** A real
//!    entity row's `kind_id` dictionary text is always one of five COARSE
//!    `UniversalKind`-bucketed words (`"jsts:entity_container"`/
//!    `"_callable"`/`"_type"`/`"_variable"`/`"_parameter"` --
//!    `urdira-jsts-syntax-worker::proposal_entity_record`'s only
//!    vocabulary), never the FINE per-declaration word (`"function"`/
//!    `"class"`/`"method"`/`"getter"`/... -- `EntityKind::identity_name()`)
//!    the identity string's `{kind}` segment actually uses. No `RecordRow`
//!    field carries the fine word at all (`body` does, but decoding a
//!    row's body to reconstruct its own identity would defeat the point of
//!    this task). Fixed by adding a SECOND new dictionary, `dicts.
//!    entity_kinds` -- but unlike `artifact_paths`, this one is populated
//!    ENTIRELY INSIDE this crate: [`collect_new_entity_kinds`] parses the
//!    fine word straight out of each entity row's own `identity_key` bytes
//!    (`jsts:{word}:...` -- the ONE deliberate exception to "never parse
//!    the string apart" this module makes, and it is safe precisely
//!    because the byte-for-byte comparison below still independently
//!    verifies every OTHER segment: `{path}`/`{start}`/`{name}`). New words
//!    are interned in SORTED order (never row-iteration order) so
//!    `write_base`/`write_base_partitioned` -- which see the same logical
//!    rows bucketed differently across nibble partitions -- always assign
//!    IDENTICAL ordinals to a given word, keeping the two paths' `dict.bin`
//!    output byte-identical (`write_base_partitioned_test.rs`'s oracle).
//!
//! Also added in this revision: `IDENTITY_LAYOUT_RELATION_NO_SPAN`, for
//! relations whose identity carries no span at all (`jsts:contains:
//! {source_key}:{target_key}` in particular -- ~400k rows on n8n, a
//! meaningful share of pre-fix `records.ident`).

use crate::row::{CATEGORY_ENTITY, CATEGORY_RELATION, Dictionaries, RecordRow};
use std::collections::{BTreeSet, HashMap};

pub const IDENTITY_LAYOUT_RAW: u8 = crate::layout::meta::IDENTITY_LAYOUT_RAW;
pub const IDENTITY_LAYOUT_ENTITY: u8 = crate::layout::meta::IDENTITY_LAYOUT_ENTITY;
pub const IDENTITY_LAYOUT_RELATION: u8 = crate::layout::meta::IDENTITY_LAYOUT_RELATION;
pub const IDENTITY_LAYOUT_RELATION_NO_SPAN: u8 =
    crate::layout::meta::IDENTITY_LAYOUT_RELATION_NO_SPAN;
pub const ENTITY_KIND_NONE: u8 = crate::layout::meta::ENTITY_KIND_NONE;

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

/// Frente E-P0j (2026-09-07): recovers an entity record's own NAME-
/// IDENTIFIER start offset from its `identity_key` text -- `entities.
/// index`'s own build key (`segment_io::is_entities_index_row`'s call
/// sites) needs this, not `RecordRow::span_start_byte` any more.
///
/// Before this task, `entities.index` was keyed directly off `RecordRow::
/// span_start_byte`, because every entity producer published that field as
/// the identifier's own span. This task moves the PUBLISHED `start`/`end`
/// (`span_start_byte`/`span_end_byte`) to the WHOLE DECLARATION's span for
/// fidelity (a real function/variable/class/... is now byte-sliceable from
/// its own record) -- but `urdira-indexing-worker::v4::residual`'s checker-
/// site correlation, and `entities.index` itself, both still need "which
/// entity record starts at THIS identifier position" (a tsgo-reported
/// `name_start_utf16`), never "which entity's declaration CONTAINS this
/// position". Rather than adding a new stored column (a store-format bump
/// touching `urdira-native-core`'s kernel row shape, this crate's row/
/// segment/layout modules, AND `urdira-indexing-worker`'s materialize pass
/// -- out of proportion to what is, in the end, already-stored information),
/// this recovers the identifier start from the SAME text every entity
/// identity already carries: every producer's `jsts:{kind}:{path}:
/// {name_start}:{name}` recipe (`stable_entity_id`/`declaration_id` in
/// `urdira-jsts-syntax-worker`, unaffected by this task -- identity stays
/// anchored to the identifier, decision 11) -- so this is a PARSE of
/// already-durable bytes, not a new fact.
///
/// Parses the SECOND-TO-LAST `:`-delimited segment as a decimal `u32`
/// (`name` is the last segment, mirroring `urdira-indexing-worker::v4::
/// materialize::identity_key_name`'s own `rsplit(':').next()` convention
/// and sharing its same known limitation: a `name`/`path` containing a
/// literal `:` is not handled -- workspace paths never do, by this
/// codebase's own established convention, e.g. `confirmed_relation_kind`'s
/// identical assumption). Returns `None` for a shape with no such segment
/// at all (`jsts:external_module:{specifier}`/`jsts:external_symbol:
/// {specifier}`, which have no per-file span -- `start`/`end` are always
/// `0` for those two kinds, see `external_module_entity`/`external_symbol_
/// entity`'s own doc comments) or one whose candidate segment does not
/// parse as a plain `u32` -- callers fall back to `0` in both cases,
/// matching those two kinds' own always-`0` span.
pub fn entity_identity_name_start(identity_key: &[u8]) -> Option<u32> {
    let text = std::str::from_utf8(identity_key).ok()?;
    let mut parts: Vec<&str> = text.split(':').collect();
    if parts.len() < 2 {
        return None;
    }
    parts.pop(); // name
    let start_text = parts.pop()?;
    start_text.parse::<u32>().ok()
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

/// A3a-fix: `jsts:{rel}:{source_identity_key}:{target_identity_key}` -- the
/// no-span relation shape (`jsts:contains:*` in particular).
pub fn reconstruct_relation_no_span(rel: &str, source_key: &[u8], target_key: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + rel.len() + 1 + source_key.len() + 1 + target_key.len());
    out.extend_from_slice(b"jsts:");
    out.extend_from_slice(rel.as_bytes());
    out.push(b':');
    out.extend_from_slice(source_key);
    out.push(b':');
    out.extend_from_slice(target_key);
    out
}

/// `dicts.artifact_paths[owner_artifact]` -- `None` (falling the caller
/// back to Raw) for an out-of-range ordinal: either a store written before
/// A3a-fix (whose `artifact_paths` is empty), or a v3-converted store
/// (which never populates this field at all, since it has no real
/// `owner_path` to offer -- see `structural_store_napi.rs`'s conversion
/// path).
fn artifact_path(dicts: &Dictionaries, owner_artifact: u32) -> Option<&str> {
    dicts
        .artifact_paths
        .get(owner_artifact as usize)
        .map(String::as_str)
}

/// Parses the FINE entity-kind word out of `identity_key`'s OWN
/// `jsts:{word}:...` prefix -- the one deliberate string-parse this module
/// performs (see this module's doc comment for why it's safe). `None` if
/// `identity_key` doesn't start with `jsts:` or has no second `:` at all
/// (an empty/malformed identity, never produced in practice but handled
/// without panicking regardless).
fn parse_entity_kind_word(identity_key: &[u8]) -> Option<&str> {
    let after = identity_key.strip_prefix(b"jsts:")?;
    let colon = after.iter().position(|&b| b == b':')?;
    std::str::from_utf8(&after[..colon]).ok()
}

/// Scans `rows` for `CATEGORY_ENTITY` rows whose `identity_key` parses as
/// `jsts:{word}:...` and returns the distinct words NOT already present in
/// `existing` (typically `dicts.entity_kinds` before this batch), in
/// LEXICOGRAPHIC order -- deliberately independent of row iteration order
/// or nibble-partition grouping, so `write_base` and `write_base_
/// partitioned` (which bucket the SAME logical rows differently) assign
/// IDENTICAL ordinals to a given word and so produce byte-identical
/// `dict.bin` output for the same logical input. Callers extend `dicts.
/// entity_kinds` with the returned list (in order) before writing rows.
pub fn collect_new_entity_kinds<'a>(
    rows: impl IntoIterator<Item = &'a RecordRow>,
    existing: &[String],
) -> Vec<String> {
    let existing_set: std::collections::HashSet<&str> =
        existing.iter().map(String::as_str).collect();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for row in rows {
        if row.category != CATEGORY_ENTITY {
            continue;
        }
        if let Some(word) = parse_entity_kind_word(&row.identity_key)
            && !existing_set.contains(word)
        {
            seen.insert(word.to_string());
        }
    }
    seen.into_iter().collect()
}

/// Ordinal lookup by fine entity-kind word text, built ONCE per write call
/// from `dicts.entity_kinds` (already extended with every new word this
/// batch's entity rows need, via [`collect_new_entity_kinds`]) and shared
/// by reference across the (possibly parallel) per-row classify loop --
/// same reason [`BatchIndex`] is built once and shared, not rebuilt per
/// row.
pub struct EntityKindIndex<'a> {
    by_word: HashMap<&'a str, u32>,
}

impl<'a> EntityKindIndex<'a> {
    pub fn from_dicts(dicts: &'a Dictionaries) -> Self {
        let by_word = dicts
            .entity_kinds
            .iter()
            .enumerate()
            .map(|(i, s)| (s.as_str(), i as u32))
            .collect();
        EntityKindIndex { by_word }
    }

    fn get(&self, word: &str) -> Option<u32> {
        self.by_word.get(word).copied()
    }
}

/// Attempts the ENTITY candidate for `row`: `None` on any field this row
/// doesn't carry (out-of-range dictionary ordinal, no `name_id`, wrong
/// category, unparseable/un-interned fine kind word, or an interned
/// ordinal that would not fit in the `records.meta` `ENTITY_KIND` byte) --
/// never panics, never guesses. Returns the candidate bytes AND the entity-
/// kind ordinal to record in `meta::ENTITY_KIND` on a match.
fn try_entity(
    row: &RecordRow,
    dicts: &Dictionaries,
    entity_kinds: &EntityKindIndex,
) -> Option<(Vec<u8>, u32)> {
    if row.category != CATEGORY_ENTITY {
        return None;
    }
    let path = artifact_path(dicts, row.owner_artifact)?;
    let name_id = row.name_id_opt()?;
    let name = dicts.names.get(name_id as usize)?;
    let word = parse_entity_kind_word(&row.identity_key)?;
    let ord = entity_kinds.get(word)?;
    if ord >= ENTITY_KIND_NONE as u32 {
        // Never happens in practice (the real vocabulary is under 20
        // words), but the `records.meta` byte can only hold 0..254.
        return None;
    }
    let candidate = reconstruct_entity(word, path, row.span_start_byte, name);
    (candidate == row.identity_key).then_some((candidate, ord))
}

/// Attempts the RELATION (spanned) candidate for `row`: both `source_
/// subject`/`target_subject` must be present AND resolvable via `resolve_
/// identity` (the caller's batch-plus-store lookup, `record_id ->
/// identity_key bytes`) -- `None` otherwise, same never-guess discipline as
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

/// A3a-fix: attempts the RELATION (no span) candidate for `row` -- same
/// endpoint-resolution discipline as [`try_relation`], but without a path
/// or span at all (`jsts:contains:*` and any other relation kind whose
/// identity never carried one).
fn try_relation_no_span(
    row: &RecordRow,
    dicts: &Dictionaries,
    resolve_identity: &dyn Fn(&[u8; 32]) -> Option<Vec<u8>>,
) -> Option<Vec<u8>> {
    if row.category != CATEGORY_RELATION {
        return None;
    }
    let kind_text = dicts.kinds.get(row.kind_id as usize)?;
    let rel = kind_text.strip_prefix("jsts:relation_")?;
    let source_ord = row.source_subject?;
    let target_ord = row.target_subject?;
    let source_record_id = dicts.subjects.get(source_ord as usize)?;
    let target_record_id = dicts.subjects.get(target_ord as usize)?;
    let source_key = resolve_identity(source_record_id)?;
    let target_key = resolve_identity(target_record_id)?;
    Some(reconstruct_relation_no_span(rel, &source_key, &target_key))
}

/// Classifies one row's identity storage layout tag AND (for
/// `IDENTITY_LAYOUT_ENTITY` only) its entity-kind ordinal, without
/// allocating a `Vec` for the `RAW` case the way [`classify_identity`]
/// does (it additionally clones `row.identity_key`). Used by the hot
/// per-row write loops (`segment_io.rs`), which already have `row.
/// identity_key` directly at hand when they later decide whether to push
/// its bytes. Returns `(layout, entity_kind_byte)`; `entity_kind_byte` is
/// [`ENTITY_KIND_NONE`] unless `layout == IDENTITY_LAYOUT_ENTITY`.
pub fn classify_identity_layout(
    row: &RecordRow,
    dicts: &Dictionaries,
    resolve_identity: &dyn Fn(&[u8; 32]) -> Option<Vec<u8>>,
    entity_kinds: &EntityKindIndex,
) -> (u8, u8) {
    match row.category {
        CATEGORY_ENTITY => {
            if let Some((candidate, ord)) = try_entity(row, dicts, entity_kinds)
                && candidate == row.identity_key
            {
                return (IDENTITY_LAYOUT_ENTITY, ord as u8);
            }
        }
        CATEGORY_RELATION => {
            if let Some(candidate) = try_relation(row, dicts, resolve_identity)
                && candidate == row.identity_key
            {
                return (IDENTITY_LAYOUT_RELATION, ENTITY_KIND_NONE);
            }
            if let Some(candidate) = try_relation_no_span(row, dicts, resolve_identity)
                && candidate == row.identity_key
            {
                return (IDENTITY_LAYOUT_RELATION_NO_SPAN, ENTITY_KIND_NONE);
            }
        }
        _ => {}
    }
    (IDENTITY_LAYOUT_RAW, ENTITY_KIND_NONE)
}

/// Classifies one row's identity storage layout: `(layout_tag,
/// entity_kind_byte, ident_bytes_to_write)`. `ident_bytes_to_write` is
/// EMPTY for a tagged layout (`ENTITY`/`RELATION`/`RELATION_NO_SPAN` --
/// nothing is stored, the reader reconstructs it) and `row.identity_key.
/// clone()` for `RAW` (stored verbatim, exactly the pre-A3a behavior).
/// Never parses `row.identity_key` apart to recover `path`/`start`/`end`/
/// `name` (only the entity `{kind}` word, see this module's doc comment) --
/// only ever builds a candidate from `row`'s own typed fields and compares
/// the two whole strings byte for byte. Prefer [`classify_identity_layout`]
/// in a hot per-row loop that already has `row.identity_key` at hand.
pub fn classify_identity(
    row: &RecordRow,
    dicts: &Dictionaries,
    resolve_identity: &dyn Fn(&[u8; 32]) -> Option<Vec<u8>>,
    entity_kinds: &EntityKindIndex,
) -> (u8, u8, Vec<u8>) {
    let (layout, entity_kind_byte) =
        classify_identity_layout(row, dicts, resolve_identity, entity_kinds);
    let bytes = if layout == IDENTITY_LAYOUT_RAW {
        row.identity_key.clone()
    } else {
        Vec::new()
    };
    (layout, entity_kind_byte, bytes)
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

    fn dicts_with(kinds: &[&str], artifact_paths: &[&str], names: &[&str]) -> Dictionaries {
        Dictionaries {
            kinds: kinds.iter().map(|s| s.to_string()).collect(),
            universal_kinds: Vec::new(),
            relation_kinds: Vec::new(),
            names: names.iter().map(|s| s.to_string()).collect(),
            subjects: Vec::new(),
            artifacts: artifact_paths
                .iter()
                .map(|_| ("artifact:digest".to_string(), String::new()))
                .collect(),
            facet_names: Vec::new(),
            subject_text: Vec::new(),
            artifact_paths: artifact_paths.iter().map(|s| s.to_string()).collect(),
            entity_kinds: Vec::new(),
        }
    }

    fn no_resolve(_: &[u8; 32]) -> Option<Vec<u8>> {
        None
    }

    /// Interns every distinct entity-kind word `rows` needs into a fresh
    /// `Dictionaries` clone and returns `(dicts, index)` -- the two-step
    /// dance every real writer does (`collect_new_entity_kinds` then
    /// `EntityKindIndex::from_dicts`), collapsed into one helper for tests.
    fn with_interned_entity_kinds(mut dicts: Dictionaries, rows: &[RecordRow]) -> Dictionaries {
        let new_words = collect_new_entity_kinds(rows, &dicts.entity_kinds);
        dicts.entity_kinds.extend(new_words);
        dicts
    }

    #[test]
    fn canonical_entity_tags_and_stores_nothing() {
        let dicts = dicts_with(&["unused"], &["src/a.ts"], &["greet"]);
        let mut row = base_row();
        row.owner_artifact = 0;
        row.name_id = 0;
        row.identity_key = b"jsts:function:src/a.ts:100:greet".to_vec();
        let dicts = with_interned_entity_kinds(dicts, std::slice::from_ref(&row));
        let entity_kinds = EntityKindIndex::from_dicts(&dicts);
        let (layout, entity_kind_byte, bytes) =
            classify_identity(&row, &dicts, &no_resolve, &entity_kinds);
        assert_eq!(layout, IDENTITY_LAYOUT_ENTITY);
        assert!(bytes.is_empty());
        assert_eq!(dicts.entity_kinds[entity_kind_byte as usize], "function");
    }

    #[test]
    fn canonical_relation_with_both_endpoints_resolved_tags() {
        let dicts = dicts_with(&["jsts:relation_call"], &["src/a.ts"], &["callee"]);
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
        let entity_kinds = EntityKindIndex::from_dicts(&dicts);
        let (layout, entity_kind_byte, bytes) =
            classify_identity(&row, &dicts, &resolve, &entity_kinds);
        assert_eq!(layout, IDENTITY_LAYOUT_RELATION);
        assert_eq!(entity_kind_byte, ENTITY_KIND_NONE);
        assert!(bytes.is_empty());
    }

    /// A3a-fix: `jsts:contains:*` and any other relation kind whose
    /// identity carries no path/span at all still tags, under the NEW
    /// `RELATION_NO_SPAN` layout.
    #[test]
    fn contains_relation_without_span_tags_as_relation_no_span() {
        let dicts = dicts_with(&["jsts:relation_contains"], &[], &[]);
        let mut dicts = dicts;
        dicts.subjects = vec![[7u8; 32], [8u8; 32]];
        let mut row = base_row();
        row.category = CATEGORY_RELATION;
        row.kind_id = 0;
        row.span_start_byte = 0;
        row.span_end_byte = 0;
        row.source_subject = Some(0);
        row.target_subject = Some(1);
        row.identity_key = b"jsts:contains:src-key:target-key".to_vec();
        let resolve = |id: &[u8; 32]| -> Option<Vec<u8>> {
            if *id == [7u8; 32] {
                Some(b"src-key".to_vec())
            } else if *id == [8u8; 32] {
                Some(b"target-key".to_vec())
            } else {
                None
            }
        };
        let entity_kinds = EntityKindIndex::from_dicts(&dicts);
        let (layout, entity_kind_byte, bytes) =
            classify_identity(&row, &dicts, &resolve, &entity_kinds);
        assert_eq!(layout, IDENTITY_LAYOUT_RELATION_NO_SPAN);
        assert_eq!(entity_kind_byte, ENTITY_KIND_NONE);
        assert!(bytes.is_empty());
    }

    /// A spanned relation candidate is tried FIRST: a row whose identity
    /// happens to also look like it could match the no-span shape (it
    /// can't, in practice -- span-bearing relation kinds are a fixed,
    /// disjoint vocabulary from no-span ones -- but this pins the ordering
    /// contract explicitly) still tags as the ordinary spanned `RELATION`.
    #[test]
    fn spanned_relation_is_tried_before_no_span() {
        let dicts = dicts_with(&["jsts:relation_call"], &["src/a.ts"], &[]);
        let mut dicts = dicts;
        dicts.subjects = vec![[7u8; 32], [8u8; 32]];
        let mut row = base_row();
        row.category = CATEGORY_RELATION;
        row.kind_id = 0;
        row.span_start_byte = 10;
        row.span_end_byte = 20;
        row.source_subject = Some(0);
        row.target_subject = Some(1);
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
        let entity_kinds = EntityKindIndex::from_dicts(&dicts);
        let (layout, _, _) = classify_identity(&row, &dicts, &resolve, &entity_kinds);
        assert_eq!(layout, IDENTITY_LAYOUT_RELATION);
    }

    #[test]
    fn external_module_identity_falls_back_to_raw() {
        let dicts = dicts_with(&["jsts:entity_container"], &["src/a.ts"], &[]);
        let mut row = base_row();
        row.kind_id = 0;
        row.name_id = NONE_U32;
        row.identity_key = b"jsts:external_module:lodash".to_vec();
        let entity_kinds = EntityKindIndex::from_dicts(&dicts);
        let (layout, entity_kind_byte, bytes) =
            classify_identity(&row, &dicts, &no_resolve, &entity_kinds);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(entity_kind_byte, ENTITY_KIND_NONE);
        assert_eq!(bytes, row.identity_key);
    }

    #[test]
    fn type_of_identity_falls_back_to_raw() {
        let dicts = dicts_with(&["jsts:entity_type"], &["src/a.ts"], &["Foo"]);
        let mut row = base_row();
        row.kind_id = 0;
        row.name_id = 0;
        row.identity_key = b"jsts:type-of:some-entity-id:Foo".to_vec();
        let entity_kinds = EntityKindIndex::from_dicts(&dicts);
        let (layout, _, bytes) = classify_identity(&row, &dicts, &no_resolve, &entity_kinds);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(bytes, row.identity_key);
    }

    #[test]
    fn arbitrary_string_falls_back_to_raw() {
        let dicts = dicts_with(&["function"], &["src/a.ts"], &["greet"]);
        let mut row = base_row();
        row.kind_id = 0;
        row.name_id = 0;
        row.identity_key = b"not-even-close-to-canonical".to_vec();
        let entity_kinds = EntityKindIndex::from_dicts(&dicts);
        let (layout, _, bytes) = classify_identity(&row, &dicts, &no_resolve, &entity_kinds);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(bytes, row.identity_key);
    }

    #[test]
    fn relation_with_missing_target_subject_falls_back_to_raw() {
        let dicts = dicts_with(&["jsts:relation_call"], &["src/a.ts"], &[]);
        let mut row = base_row();
        row.category = CATEGORY_RELATION;
        row.kind_id = 0;
        row.source_subject = Some(0);
        row.target_subject = None;
        row.identity_key = b"jsts:call:src/a.ts:10:20:src-key:target-key".to_vec();
        let entity_kinds = EntityKindIndex::from_dicts(&dicts);
        let (layout, _, bytes) = classify_identity(&row, &dicts, &no_resolve, &entity_kinds);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(bytes, row.identity_key);
    }

    #[test]
    fn relation_with_unresolvable_endpoint_falls_back_to_raw() {
        let mut dicts = dicts_with(&["jsts:relation_call"], &["src/a.ts"], &[]);
        dicts.subjects = vec![[7u8; 32], [8u8; 32]];
        let mut row = base_row();
        row.category = CATEGORY_RELATION;
        row.kind_id = 0;
        row.source_subject = Some(0);
        row.target_subject = Some(1);
        row.identity_key = b"jsts:call:src/a.ts:10:20:src-key:target-key".to_vec();
        // resolve_identity never resolves anything -- simulates an
        // endpoint not present in this batch nor the live store.
        let entity_kinds = EntityKindIndex::from_dicts(&dicts);
        let (layout, _, bytes) = classify_identity(&row, &dicts, &no_resolve, &entity_kinds);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(bytes, row.identity_key);
    }

    #[test]
    fn out_of_range_kind_id_falls_back_to_raw_without_panicking() {
        // No `artifact_paths` entry at ordinal 0 (path absent) -- must fall
        // back to Raw without panicking, regardless of `kind_id`.
        let dicts = dicts_with(&[], &[], &["greet"]);
        let mut row = base_row();
        row.kind_id = 5; // out of range: `dicts.kinds` is empty
        row.name_id = 0;
        row.identity_key = b"jsts:function:src/a.ts:100:greet".to_vec();
        let dicts = with_interned_entity_kinds(dicts, std::slice::from_ref(&row));
        let entity_kinds = EntityKindIndex::from_dicts(&dicts);
        let (layout, _, bytes) = classify_identity(&row, &dicts, &no_resolve, &entity_kinds);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(bytes, row.identity_key);
    }

    /// A3a-fix: an entity whose `owner_artifact` ordinal has no
    /// `artifact_paths` entry (a store written before A3a-fix, or a
    /// v3-converted store) falls back to Raw -- the exact scenario this
    /// fix's own diagnosis (`records.ident` unchanged pre-fix) reproduces.
    #[test]
    fn entity_with_no_artifact_path_falls_back_to_raw() {
        let dicts = dicts_with(&[], &[], &["greet"]); // artifact_paths EMPTY
        let mut row = base_row();
        row.name_id = 0;
        row.identity_key = b"jsts:function:src/a.ts:100:greet".to_vec();
        let dicts = with_interned_entity_kinds(dicts, std::slice::from_ref(&row));
        let entity_kinds = EntityKindIndex::from_dicts(&dicts);
        let (layout, entity_kind_byte, bytes) =
            classify_identity(&row, &dicts, &no_resolve, &entity_kinds);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(entity_kind_byte, ENTITY_KIND_NONE);
        assert_eq!(bytes, row.identity_key);
    }

    /// A3a-fix: an entity-kind ordinal that would not fit the `records.
    /// meta` byte (>= `ENTITY_KIND_NONE` == 255) falls back to Raw --
    /// exercised by pre-seeding `entity_kinds` with 255 dummy words so the
    /// real word this row needs lands at ordinal 255.
    #[test]
    fn entity_kind_ordinal_overflowing_u8_falls_back_to_raw() {
        let mut dicts = dicts_with(&[], &["src/a.ts"], &["greet"]);
        // 255 filler words at ordinals 0..255, then `function` itself at
        // ordinal 255 -- exactly `ENTITY_KIND_NONE`, which does not fit.
        dicts.entity_kinds = (0..255).map(|i| format!("filler-{i}")).collect();
        dicts.entity_kinds.push("function".to_string());
        assert_eq!(dicts.entity_kinds.len(), 256);
        let mut row = base_row();
        row.name_id = 0;
        row.identity_key = b"jsts:function:src/a.ts:100:greet".to_vec();
        let entity_kinds = EntityKindIndex::from_dicts(&dicts);
        let (layout, entity_kind_byte, bytes) =
            classify_identity(&row, &dicts, &no_resolve, &entity_kinds);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(entity_kind_byte, ENTITY_KIND_NONE);
        assert_eq!(bytes, row.identity_key);
    }

    #[test]
    fn diagnostic_category_always_falls_back_to_raw() {
        let dicts = dicts_with(&["jsts:diagnostic"], &["src/a.ts"], &[]);
        let mut row = base_row();
        row.category = CATEGORY_DIAGNOSTIC;
        row.kind_id = 0;
        row.identity_key = b"jsts:diagnostic:src/a.ts:1:2:some-code".to_vec();
        let entity_kinds = EntityKindIndex::from_dicts(&dicts);
        let (layout, _, bytes) = classify_identity(&row, &dicts, &no_resolve, &entity_kinds);
        assert_eq!(layout, IDENTITY_LAYOUT_RAW);
        assert_eq!(bytes, row.identity_key);
    }

    /// A name (the LAST identity segment) containing a literal `:` (e.g. a
    /// path segment `a:b/c.ts` embedded upstream, or a name that itself
    /// contains a colon) must not confuse reconstruction -- this module
    /// never parses `path`/`start`/`name` apart, only ever builds one from
    /// typed fields and compares wholesale, so an embedded `:` anywhere in
    /// those segments is inert.
    #[test]
    fn colon_inside_path_still_reconstructs_correctly() {
        let dicts = dicts_with(&["unused"], &["a:b/c.ts"], &["greet"]);
        let mut row = base_row();
        row.owner_artifact = 0;
        row.name_id = 0;
        row.identity_key = b"jsts:function:a:b/c.ts:100:greet".to_vec();
        let dicts = with_interned_entity_kinds(dicts, std::slice::from_ref(&row));
        let entity_kinds = EntityKindIndex::from_dicts(&dicts);
        let (layout, _, bytes) = classify_identity(&row, &dicts, &no_resolve, &entity_kinds);
        assert_eq!(layout, IDENTITY_LAYOUT_ENTITY);
        assert!(bytes.is_empty());
    }

    /// [`collect_new_entity_kinds`] assigns ordinals in SORTED order among
    /// only the NEW words a batch needs, independent of row order --
    /// pins the determinism contract `write_base`/`write_base_partitioned`
    /// rely on to agree on ordinals despite bucketing rows differently.
    #[test]
    fn collect_new_entity_kinds_is_sorted_and_excludes_existing() {
        let mut a = base_row();
        a.identity_key = b"jsts:variable:p:1:x".to_vec();
        let mut b = base_row();
        b.identity_key = b"jsts:function:p:2:y".to_vec();
        let mut c = base_row();
        c.identity_key = b"jsts:class:p:3:z".to_vec();
        // Row order is variable, function, class -- output must still be
        // sorted, and must exclude "function" (already `existing`).
        let existing = vec!["function".to_string()];
        let new_words = collect_new_entity_kinds(&[a, b, c], &existing);
        assert_eq!(new_words, vec!["class".to_string(), "variable".to_string()]);
    }

    /// [`collect_new_entity_kinds`] ignores non-entity rows and rows whose
    /// identity doesn't parse as `jsts:{word}:...`.
    #[test]
    fn collect_new_entity_kinds_ignores_non_entities_and_unparseable_rows() {
        let mut relation = base_row();
        relation.category = CATEGORY_RELATION;
        relation.identity_key = b"jsts:call:p:1:2:a:b".to_vec();
        let mut malformed = base_row();
        malformed.identity_key = b"not-jsts-shaped".to_vec();
        let new_words = collect_new_entity_kinds(&[relation, malformed], &[]);
        assert!(new_words.is_empty());
    }
}
