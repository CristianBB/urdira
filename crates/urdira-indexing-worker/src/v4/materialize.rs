//! v4 materialisation (plan §4.5): `ProposedRecord` -> `structural_kernel_
//! rows` (P2-2f's bytes-native kernel entrypoint,
//! `crates/urdira-native-core/src/lib.rs`, built through the SAME digest/
//! canonicalization primitives the N-API/JSON-shaped `structural_kernel_
//! batch_parts` uses -- `main.rs`'s v3 hybrid lane still calls that
//! original function unchanged, `main.rs:1146`) -> `urdira_structural_
//! store::RecordRow`.
//!
//! Record identity/digests are NOT reimplemented here: `record_id`,
//! `record_digest`, `body_digest`, `identity_id`, `identity_key_digest`,
//! `identity_assignment_id` all come straight out of one
//! `StructuralKernelRow` (native `[u8; 32]`/`Vec<u8>`, no hex/JSON text
//! anywhere on this path -- see P2-2f's evidence doc), computed by
//! `urdira_native_core::structural_kernel_rows`. Decision 11's "cold: no
//! predecessors, `record_id = sha256(record_digest)`" is that function's
//! ONLY behavior (it has no predecessor/chaining parameter at all --
//! confirmed by reading `crates/urdira-native-core/src/lib.rs`'s
//! `structural_kernel_row` body directly), so this module reproduces
//! decision 11's cold case for free, with zero risk of a hand-rewritten
//! recipe drifting from the authoritative one (verified byte-for-byte
//! against the original `structural_kernel_batch_parts` oracle by
//! `native_core_rows_match_batch_parts_oracle`, below).
//!
//! What IS new v4-only ground (no v3 equivalent exists to mirror -- see
//! this task's evidence doc for the research trail):
//! - The facets bitmask bit order ([`FACET_ORDER`]).
//! - `kind_id`/`universal_kind_id`/`relation_kind_id`/`name_id` dictionary
//!   ordinals (v3 stores these as TEXT; v4's fixed-width `records.meta`
//!   needs small integers, assigned in first-seen order per generation).
//! - `dicts.artifacts`: one ordinal per owner, shared by BOTH
//!   `RecordRow.owner_artifact` and `.owner_version` (they index the same
//!   `(artifact_id, artifact_version_id)` pair -- there is exactly one
//!   live version per artifact at any generation, so a single ordinal per
//!   owner is sufficient and avoids inventing a second, redundant index
//!   space).
//! - `source_subject`/`target_subject` resolution for relation rows: this
//!   module resolves a relation's `body.source_id`/`body.target_id` (the
//!   referenced entity's pre-record `identity_key`, the same convention
//!   `read_facts_group`'s entities and `urdira-jsts-native-projection`'s
//!   `record()` both use for a `ProposedRecord`'s own `identity`) against
//!   a same-generation `identity_key -> record ordinal` map, and stores
//!   the RESOLVED ENTITY'S `record_id` as the subject key in
//!   `dicts.subjects`. Interim, cold-scan-only choice: a cross-generation-
//!   stable choice (`identity_id`) is deferred to the P3 incremental work,
//!   where identity churn across generations first matters. An
//!   unresolved endpoint (external module, or a target this workspace
//!   never emitted a record for) leaves that side `None`.
//! - `span_start_line`/`span_end_line` are NOT computed (always 0): no
//!   producer in this pipeline emits line numbers (`ProposedRecord.
//!   source_span` only ever carries `{path, start, end}` byte offsets --
//!   confirmed by reading every `source_span` construction site in
//!   `urdira-jsts-syntax-worker`), and deriving them would require a
//!   byte/UTF-16-offset-aware scan of the owner's source text per record;
//!   deferred as a documented gap (span identity/determinism is
//!   unaffected: `structural_record_digest` hashes only `record.body`).

use super::ScanError;
use super::analyze::OwnerFacts;
use super::deps;
use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(test)]
use urdira_indexing_core::StructuralKernelRecord;
use urdira_jsts_syntax_worker::{ProposedRecord, ProposedRecordDependency};
use urdira_native_core::{
    StructuralKernelRecordRef, StructuralKernelRow, structural_kernel_rows_ref,
    structural_kernel_rows_typed,
};
use urdira_structural_store::row::{
    CATEGORY_DIAGNOSTIC, CATEGORY_ENTITY, CATEGORY_RELATION, NONE_U16,
};
use urdira_structural_store::{DependencyRow, Dictionaries, N_NIBBLES, RecordRow, nibble_of};

/// Bit order for the `facets` bitmask (new v4 recipe -- see module doc).
/// Source strings: `packages/plugin-javascript-typescript/src/registry-
/// contribution.ts` lines 152-153 (`entityFacets`/`relationFacets`), the
/// only two facet lists the JS/TS registry defines today. A facet string
/// not in this table is silently ignored rather than rejected, so a
/// future registry addition degrades to "not represented in the bitmask"
/// instead of failing the whole scan.
pub(super) const FACET_ORDER: [&str; 13] = [
    "core:declaration",
    "core:definition",
    "core:member",
    "core:constructible",
    "core:abstract",
    "core:async",
    "core:generator",
    "core:structural_relation",
    "core:reference_relation",
    "core:dependency_relation",
    "core:flow_relation",
    "core:binding_relation",
    "core:indirect",
];

/// P3-1: resolves an identity_key not present in the current incremental
/// batch against the live store (`delta.rs` wires this to `StoreReader::
/// by_identity_last`). Named as a type alias purely to satisfy
/// `clippy::type_complexity` -- no behavioral significance.
/// `+ Sync` (not just `Fn`): P2-2h item 4 resolves relation subjects with a
/// parallel `rayon` pass over `deferred_subjects`, so this lookup must be
/// callable concurrently from multiple worker threads. `delta.rs`'s only
/// caller closes over a `&StoreReader`, which is `Sync` (its interior
/// mutability is behind a `Mutex`), so this bound costs that call site
/// nothing.
pub(super) type ExternalSubjectLookup<'a> = &'a (dyn Fn(&str) -> Option<[u8; 32]> + Sync);

/// `(record_index, resolved_source_subject_key, resolved_target_subject_key)`
/// -- one parallel `resolve_subject_key` call's output (P2-2h item 4). Named
/// purely to satisfy `clippy::type_complexity`, same as `ExternalSubjectLookup`
/// above.
type ResolvedSubject = (usize, Option<[u8; 32]>, Option<[u8; 32]>);

/// P2-2j item 2: one relation record's resolved `(source, target)` endpoint
/// record_ids -- `None` if the record isn't a relation at all,
/// `Some((None, None))` etc. for a relation whose endpoint(s) didn't
/// resolve to any record in this batch. Named purely to satisfy
/// `clippy::type_complexity`, same rationale as `ResolvedSubject` above.
type ResolvedEndpoints = Option<(Option<[u8; 32]>, Option<[u8; 32]>)>;

/// Lowercase hex, no prefix -- `subject_text`'s own `"record:<hex>"` form
/// needs exactly this (unlike `urdira_indexing_core::merkle_bucket::
/// to_prefixed_hex`, which always prepends `"sha256:"`).
pub(super) fn hex_encode(bytes: &[u8; 32]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(64);
    for byte in bytes {
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

pub(super) fn facets_bitmask(facets: &[String]) -> u64 {
    let mut mask = 0u64;
    for facet in facets {
        if let Some(bit) = FACET_ORDER.iter().position(|candidate| candidate == facet) {
            mask |= 1u64 << bit;
        }
    }
    mask
}

/// Append-only ordinal assignment: returns `value`'s existing ordinal, or
/// appends it and returns the new one. Values are interned in the caller's
/// processing order (sorted by owner path below), so this is deterministic
/// across runs (plan's determinism gate) regardless of `HashMap` iteration
/// order.
pub(super) struct OrdinalDict<K: std::hash::Hash + Eq + Clone> {
    index: FxHashMap<K, u32>,
    values: Vec<K>,
}

impl<K: std::hash::Hash + Eq + Clone> OrdinalDict<K> {
    pub(super) fn new() -> Self {
        Self {
            index: FxHashMap::default(),
            values: Vec::new(),
        }
    }

    pub(super) fn intern(&mut self, value: &K) -> u32 {
        if let Some(ordinal) = self.index.get(value) {
            return *ordinal;
        }
        let ordinal = u32::try_from(self.values.len()).expect("dictionary ordinal overflowed u32");
        self.index.insert(value.clone(), ordinal);
        self.values.push(value.clone());
        ordinal
    }

    pub(super) fn into_values(self) -> Vec<K> {
        self.values
    }

    /// P2-2j item 2: read-only ordinal lookup, usable concurrently from
    /// multiple `rayon` worker threads via a shared `&OrdinalDict` (no
    /// mutation, so no synchronization needed beyond normal borrow rules --
    /// `FxHashMap<K, u32>` is `Sync` whenever `K: Sync`, which every key
    /// type this module uses -- `String`, `(String, String)`, `[u8; 32]` --
    /// already is). `materialize_cold_partitioned`'s final assembly pass
    /// calls this instead of `intern` for every field that used to force
    /// Pass 2's owner loop to run single-threaded: every dictionary is now
    /// fully populated (via `intern`, in sorted-key order) BEFORE that
    /// pass starts, so no caller needs mutable access to a dictionary
    /// while records are being assembled in parallel.
    pub(super) fn ordinal_of(&self, value: &K) -> Option<u32> {
        self.index.get(value).copied()
    }

    /// P3-1: seeds this dictionary with `existing`'s entries at their
    /// current ordinals (position == ordinal, matching how `into_values`
    /// is written back into `Dictionaries` -- an append-only vector,
    /// plan §2.2's "los ordinales son estables entre generaciones: un
    /// delta solo añade"), so a later `intern` call for a value already
    /// present in a prior generation returns that SAME ordinal instead of
    /// minting a new one. Used by `materialize_incremental` to seed every
    /// dictionary from the store's current `Dictionaries` before
    /// materializing an affected owner's rows.
    pub(super) fn from_existing(existing: &[K]) -> Self {
        let mut dict = Self::new();
        for value in existing {
            dict.intern(value);
        }
        dict
    }
}

/// P2-2g item 3: borrows `record`'s fields directly into a
/// [`StructuralKernelRecordRef`] instead of cloning them into an owned
/// `StructuralKernelRecord` (the pre-existing `to_structural_record` below,
/// kept `#[cfg(test)]`-only as the oracle-comparison test's input builder).
/// `canonicalize_owner` (below) is the only production caller: on n8n's
/// 1.5M records this removed 7 `String` clones + 1 `body: Value` tree clone
/// PER RECORD from materialize Pass 1 -- flagged as Pass 1's largest
/// remaining avoidable cost by P2-2f's evidence doc.
fn to_structural_record_ref(record: &ProposedRecord) -> StructuralKernelRecordRef<'_> {
    StructuralKernelRecordRef {
        proposal_record_key: &record.proposal_record_key,
        category: record.category,
        kind: &record.kind,
        universal_kind: &record.universal_kind,
        facets: &record.facets,
        schema_version: u32::from(record.schema_version),
        source_span: &record.source_span,
        identity_key: &record.identity_key,
        body: &record.body,
        evidence_references: &record.evidence_references,
    }
}

/// Owned counterpart of [`to_structural_record_ref`], used only by
/// `record_identity_matches_the_structural_kernel_oracle_exactly` below to
/// build an input `structural_kernel_batch_parts` (the owned-input N-API
/// oracle) can accept directly. No production caller needs this any more.
#[cfg(test)]
fn to_structural_record(record: &ProposedRecord) -> StructuralKernelRecord {
    StructuralKernelRecord {
        proposal_record_key: record.proposal_record_key.clone(),
        category: record.category.to_owned(),
        kind: record.kind.clone(),
        universal_kind: record.universal_kind.clone(),
        facets: record.facets.clone(),
        schema_version: u32::from(record.schema_version),
        source_span: record.source_span.clone(),
        identity_key: record.identity_key.clone(),
        body: record.body.clone(),
        evidence_references: record.evidence_references.clone(),
    }
}

/// Canonicalizes `records` through the bytes-native structural kernel
/// (P2-2f's [`structural_kernel_rows`]), respecting its per-call bounds
/// (`MAX_BATCH_RECORDS`/`MAX_BATCH_FRAMED_BYTES`) by bisecting on rejection
/// -- same strategy as `main.rs`'s `canonicalize_structural_chunk`
/// (main.rs:1139) and this module's own pre-P2-2f `kernel_batches`. Only
/// records are canonicalized here: `deps::materialize_dependencies` (below)
/// builds every `DependencyRow` straight from `ProposedRecordDependency`
/// and never reads a kernel-canonicalized dependency at all (confirmed by
/// reading `deps.rs`), so routing dependencies through the kernel here --
/// as the pre-P2-2f code did, in the SAME batch as records -- was pure
/// wasted canonical-JSON-text + depth-validation work with no consumer. A
/// single record whose lone presence still overflows `MAX_BATCH_FRAMED_
/// BYTES` surfaces the kernel's own error, matching prior behavior.
pub(super) fn kernel_rows_batches(
    records: &[StructuralKernelRecordRef<'_>],
) -> Result<Vec<urdira_native_core::StructuralKernelRows>, ScanError> {
    if records.is_empty() {
        return Ok(Vec::new());
    }
    match structural_kernel_rows_ref(records) {
        Ok(result) => Ok(vec![result]),
        // P2-2l item 1: the two halves are computed via `rayon::join`
        // instead of two sequential calls. This is the fix for "the
        // parallel unit is the owner, not the sub-batch": before this
        // change, an owner whose record count (or body-byte volume)
        // exceeds `MAX_BATCH_RECORDS`/`MAX_BATCH_FRAMED_BYTES` (n8n has at
        // least one owner needing 4+ bisections, i.e. tens of thousands of
        // records) ran its ENTIRE bisected recursion on the single rayon
        // worker thread that drew that owner from `materialize_cold_
        // partitioned`'s outer `into_par_iter().map(canonicalize_owner)` --
        // a long, single-threaded tail while every other, smaller owner's
        // thread sits idle. `rayon::join` lets an idle sibling thread steal
        // one half of a huge owner's own recursive split, so the tail is
        // shared across the whole pool instead of pinned to one thread.
        // Output order is unchanged: `left`/`right` are still concatenated
        // in the same left-then-right order as the prior sequential
        // version, so this is purely a scheduling change, not a semantic
        // one -- verified by the existing determinism/oracle tests plus
        // live n8n root reproduction (see this task's evidence entry).
        Err(_error) if records.len() > 1 => {
            let mid = records.len() / 2;
            let (left, right) = rayon::join(
                || kernel_rows_batches(&records[..mid]),
                || kernel_rows_batches(&records[mid..]),
            );
            let mut left = left?;
            let right = right?;
            left.extend(right);
            Ok(left)
        }
        Err(error) => Err(ScanError(format!(
            "v4 materialize: structural kernel rejected a single row: {error}"
        ))),
    }
}

/// P2-2l item 2: typed-facets sibling of [`kernel_rows_batches`], used only
/// by `canonicalize_owner`'s hot loop below (the ONLY production caller of
/// [`structural_kernel_rows_typed`] in this codebase -- residual.rs, out of
/// this task's crate-ownership scope, still calls the untyped
/// `kernel_rows_batches` above unchanged, since it does not have a
/// `ProposedRecord::facets_list` to hand in). Same bisection-on-rejection
/// strategy, same `rayon::join` parallel recursion (item 1), just calling
/// `structural_kernel_rows_typed` instead of `structural_kernel_rows_ref`
/// at the leaf.
fn kernel_rows_batches_typed(
    records: &[StructuralKernelRecordRef<'_>],
    typed_facets: &[&[String]],
) -> Result<Vec<urdira_native_core::StructuralKernelRows>, ScanError> {
    debug_assert_eq!(records.len(), typed_facets.len());
    if records.is_empty() {
        return Ok(Vec::new());
    }
    match structural_kernel_rows_typed(records, typed_facets) {
        Ok(result) => Ok(vec![result]),
        Err(_error) if records.len() > 1 => {
            let mid = records.len() / 2;
            let (left, right) = rayon::join(
                || kernel_rows_batches_typed(&records[..mid], &typed_facets[..mid]),
                || kernel_rows_batches_typed(&records[mid..], &typed_facets[mid..]),
            );
            let mut left = left?;
            let right = right?;
            left.extend(right);
            Ok(left)
        }
        Err(error) => Err(ScanError(format!(
            "v4 materialize: structural kernel rejected a single row: {error}"
        ))),
    }
}

pub struct MaterializedGeneration {
    pub records: Vec<RecordRow>,
    pub dependencies: Vec<DependencyRow>,
    pub dicts: Dictionaries,
    /// P3-1: `owner_path -> owner_artifact/owner_version ordinal` for every
    /// owner this call materialized. `delta.rs` needs this to find each
    /// affected owner's NEW ordinal (a content edit always interns a
    /// fresh `(artifact_id, artifact_version_id)` pair, so the ordinal
    /// itself is not derivable from the path alone without re-reading
    /// `dicts.artifacts`) -- unused by the cold path, which never needs to
    /// look an owner back up by path after this call returns.
    pub owner_ordinals: std::collections::HashMap<String, u32>,
}

/// One owner's records after kernel canonicalization, still carrying
/// enough of the original `ProposedRecord` (kind/universal_kind/category,
/// and for relations the pre-canonicalization `source_id`/`target_id`) to
/// finish building a `RecordRow` -- none of that survives into
/// `StructuralKernelRow`, which is deliberately narrow (identity/digest/
/// body/span fields only; see P2-2f's evidence doc).
struct OwnerKernelRows {
    owner_path: String,
    owner_artifact_id: String,
    owner_artifact_version_id: String,
    kind_universal_category: Vec<(String, String, u8)>,
    relation_endpoints: Vec<Option<(Option<String>, Option<String>)>>,
    /// P2-2f: bytes-native rows straight out of `structural_kernel_rows`
    /// (no `StructuralPublicationRecord`/hex-body/JSON-span-tree ever
    /// exists on this path -- see that function's doc comment). Pass 2
    /// (below) `mem::take`s each row's `body`/`identity_key` out of this
    /// `Vec` by index instead of cloning them, so this owner's rows must
    /// still exist (not yet dropped) at that point but their heap payloads
    /// move rather than copy.
    rows: Vec<StructuralKernelRow>,
    proposal_keys: Vec<String>,
    dependencies: Vec<ProposedRecordDependency>,
    /// How many `structural_kernel_rows` calls this owner needed (1 unless
    /// bisecting kicked in because the owner alone exceeded
    /// `MAX_BATCH_RECORDS`/`MAX_BATCH_FRAMED_BYTES`). Debug-timing-only
    /// diagnostic (see `materialize_cold`'s `URDIRA_DEBUG_TIMING` report).
    batch_count: usize,
}

fn category_byte(category: &'static str) -> u8 {
    match category {
        "relation" => CATEGORY_RELATION,
        // P2-2i: `jsts:unresolved_call` is the first `category: "diagnostic"`
        // `ProposedRecord` this pipeline ever produces (v4 was diagnostic-free
        // before this task -- see `analyze.rs`'s module doc) -- this arm was
        // missing entirely, so every diagnostic row silently stored as
        // `CATEGORY_ENTITY` (byte 0) instead, making it invisible to any
        // category-filtered diagnostic query. Found live against the n8n
        // corpus (`recordsByKindExact("core:construct", "diagnostic",
        // "jsts:diagnostic", ...)` returned 0 rows until this fix).
        "diagnostic" => CATEGORY_DIAGNOSTIC,
        _ => CATEGORY_ENTITY,
    }
}

/// A relation's `body.source_id`/`body.target_id` (the referenced entity's
/// `identity_key`, per `urdira-jsts-native-projection::relation_record`'s
/// convention, which `read_facts_group`'s `SyntaxRelation`-derived rows and
/// the hybrid lane's `ReferenceRow`/call/heritage rows both also follow --
/// every relation `ProposedRecord`'s body carries these two string keys).
fn relation_endpoints_from_body(body: &Value) -> (Option<String>, Option<String>) {
    let source_id = body
        .get("source_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let target_id = body
        .get("target_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    (source_id, target_id)
}

fn canonicalize_owner(owner: OwnerFacts) -> Result<OwnerKernelRows, ScanError> {
    let OwnerFacts {
        owner_artifact_id,
        owner_artifact_version_id,
        owner_path,
        records,
        dependencies,
        direct_imports: _,
        // P2-2i deliverable 2 (pending-site export for the residual pass,
        // plan P1-D-c's input contract) is plumbed at the `analyze`/
        // `OwnerFacts` boundary (this task, deliverable 1) but NOT YET
        // persisted into the structural store's `pending.sites`/
        // `entities.index` tables -- that storage-format work remains open,
        // see this task's evidence doc for the exact remaining scope (row
        // layouts, `SectionId`/`TableId` additions, reader API). Not
        // silently lost: `analyze::run_scoped` already keeps it on
        // `OwnerFacts` for whichever future call wires this through.
        pending_sites: _,
    } = owner;
    let mut kind_universal_category = Vec::with_capacity(records.len());
    let mut relation_endpoints = Vec::with_capacity(records.len());
    let mut proposal_keys = Vec::with_capacity(records.len());
    // P2-2g item 3: borrows straight into `records` (still owned by this
    // function's local `records`, destructured from `owner` above) instead
    // of cloning every field into an owned `StructuralKernelRecord` per
    // record -- see `to_structural_record_ref`'s doc comment. `record_refs`
    // never outlives this function (consumed by `kernel_rows_batches`
    // immediately below, which returns fully-owned `StructuralKernelRow`s),
    // so `records` staying alive for the rest of this scope is enough.
    // P2-2l item 2: `typed_facets` borrows each record's own `facets_list`
    // straight from `records` (still alive for this scope, same lifetime
    // argument as `record_refs` above it), so `kernel_rows_batches_typed`
    // can skip the generic JSON parse+validate `kernel_rows_batches` would
    // otherwise perform for `facets`/`evidence_references` -- see
    // `structural_kernel_rows_typed`'s doc comment for why this is safe
    // for every `ProposedRecord` this pipeline's producers build.
    let mut typed_facets: Vec<&[String]> = Vec::with_capacity(records.len());
    let record_refs: Vec<StructuralKernelRecordRef<'_>> = records
        .iter()
        .map(|record| {
            let category = category_byte(record.category);
            kind_universal_category.push((
                record.kind.clone(),
                record.universal_kind.clone(),
                category,
            ));
            proposal_keys.push(record.proposal_record_key.clone());
            relation_endpoints.push(
                (category == CATEGORY_RELATION).then(|| relation_endpoints_from_body(&record.body)),
            );
            typed_facets.push(record.facets_list.as_slice());
            to_structural_record_ref(record)
        })
        .collect();
    let batches = kernel_rows_batches_typed(&record_refs, &typed_facets)?;
    let batch_count = batches.len();
    let mut rows = Vec::with_capacity(record_refs.len());
    for batch in batches {
        rows.extend(batch.rows);
    }
    Ok(OwnerKernelRows {
        owner_path,
        owner_artifact_id,
        owner_artifact_version_id,
        kind_universal_category,
        relation_endpoints,
        rows,
        proposal_keys,
        dependencies,
        batch_count,
    })
}

/// Materialises every owner's facts into final `RecordRow`/`DependencyRow`s
/// for a cold (generation-1) scan. `owners` MUST already be sorted by
/// `owner_path` (guaranteed by `analyze::run_cold`) -- dictionary ordinal
/// assignment order depends on it for determinism.
///
/// P2-2j item 2: the REAL cold-scan pipeline (`scan.rs::run_full`) now
/// calls [`materialize_cold_partitioned`] instead (root-identical, see that
/// function's own doc comment) -- this flat/globally-sorted-by-`OrdinalDict`
/// -append-order version is kept, unchanged, ONLY as `tests_e2e.rs`'s own
/// pre-existing oracle/comparison path (`run_cold_scan`, and the new
/// `partitioned_cold_scan_matches_flat_cold_scan_roots` regression test),
/// hence `#[cfg_attr(not(test), allow(dead_code))]`: a normal (non-test)
/// build genuinely never calls this any more, but it must keep compiling
/// and staying correct as the flat-path oracle.
#[cfg_attr(not(test), allow(dead_code))]
pub fn materialize_cold(owners: Vec<OwnerFacts>) -> Result<MaterializedGeneration, ScanError> {
    materialize_generation(owners, 1, None, None)
}

/// P3-1 deliverable 3d/e: materialises exactly the AFFECTED owners' facts
/// (`owners`, already scoped to `analyze::run_incremental`'s closure) for
/// generation `generation` (> 1). `base_dicts` is the CURRENT store's
/// dictionaries (`StoreReader::dictionaries`): every `OrdinalDict` below is
/// seeded from it first, so a kind/name/artifact string already known from a
/// prior generation reuses its existing ordinal (plan §2.2's "los ordinales
/// son estables entre generaciones") instead of silently drifting the
/// dictionary out of sync with what's already on disk -- callers pass
/// `dicts.suffix_from(base_dicts)` (already provided by `urdira_structural_
/// store::Dictionaries`) to `SegmentWriter::write_delta`'s
/// `dict_additions` parameter, since only the NEW suffix belongs in a delta
/// segment.
///
/// `external_subject_lookup(identity_key) -> Option<record_id>` resolves a
/// relation endpoint whose target is NOT among `owners` (a relation may
/// reference a stable, unaffected file this scan never touches) by
/// consulting the live store (`delta.rs` wires this to `StoreReader::
/// by_identity_last`) -- the in-batch `identity_key_to_ordinal` map built
/// below only ever covers records freshly regenerated in THIS call, unlike
/// `materialize_cold`'s single cold batch where every record in the whole
/// workspace is always in-batch.
pub fn materialize_incremental(
    owners: Vec<OwnerFacts>,
    generation: u32,
    base_dicts: &Dictionaries,
    external_subject_lookup: ExternalSubjectLookup<'_>,
) -> Result<MaterializedGeneration, ScanError> {
    materialize_generation(
        owners,
        generation,
        Some(base_dicts),
        Some(external_subject_lookup),
    )
}

/// P2-2j item 2: cold (generation-1)-only result shape -- `N_NIBBLES`
/// `record_id`-top-nibble partitions (`urdira_structural_store::
/// nibble_of`), each already sorted ascending by `record_id`, instead of
/// one flat `Vec<RecordRow>`. Feeds `SegmentWriter::write_base_partitioned`
/// directly (`publish.rs`'s cold path), skipping both the global
/// `records.sort_by_key` `publish_cold` used to run and `write_base`'s own
/// internal `compute_order` global sort -- concatenating
/// `partitions[0..N_NIBBLES]` in order is byte-for-byte the same total
/// order either global sort would produce (see `write_base_partitioned`'s
/// own doc comment). `owner_ordinals` is dropped entirely: the cold path
/// never reads it (`MaterializedGeneration::owner_ordinals`'s own doc
/// comment already says "unused by the cold path" -- only P3-1's
/// incremental `delta.rs` needs it), so this struct never bothers building
/// it.
pub struct MaterializedPartitionedGeneration {
    pub partitions: Vec<Vec<RecordRow>>,
    pub dependencies: Vec<DependencyRow>,
    pub dicts: Dictionaries,
}

/// Cold-only counterpart of `resolve_subject_key` (no `external_subject_
/// lookup`: a cold scan's `records` set always covers the whole workspace,
/// so a relation's target is always either in-batch or genuinely external
/// to the workspace -- exactly `materialize_cold`'s own existing
/// assumption, unchanged here). Resolves straight to the referenced
/// entity's OWN `record_id` (not an ordinal into some `Vec`), since Step 4
/// below assigns `subjects` dictionary ordinals from the DISTINCT set of
/// these `record_id`s, not from owner-iteration order.
fn resolve_record_id_cold(
    identity_key: Option<&str>,
    identity_key_digest_to_record_id: &FxHashMap<[u8; 32], [u8; 32]>,
) -> Option<[u8; 32]> {
    let digest = super::delta::identity_key_digest_bytes(identity_key?);
    identity_key_digest_to_record_id.get(&digest).copied()
}

/// P2-2j item 2: cold (generation-1)-only fast path, functionally
/// equivalent to `materialize_cold` (verified byte-for-byte identical
/// `write_base` output for the same input rows --
/// `urdira-structural-store/tests/write_base_partitioned_test.rs` -- and
/// root-identical against the real n8n corpus, see this task's evidence
/// doc), but removes every sequential bottleneck the old Pass 2 had:
///
/// - Dictionary ordinals (`kinds`/`universal_kinds`/`relation_kinds`/
///   `names`/`artifacts`/`subjects`) are assigned by SORTED KEY instead of
///   first-seen owner-iteration order. Ordinals never enter any record
///   digest (`urdira-native-core`'s `structural_record_digest_hash` hashes
///   `body`/`category`/`evidence_references`/`facets`/`identity_key`/
///   `kind`/`proposal_record_key`/`schema_version`/`source_span`/
///   `universal_kind` only -- confirmed by reading that function directly),
///   so this cannot change the `records`/`graph` merkle roots; it only
///   removes the "must intern in owner-path order" constraint that forced
///   the old Pass 2's per-record loop onto a single thread.
/// - Relation subjects resolve via one parallel-built `identity_key_digest
///   -> record_id` map, built straight from Pass 1's kernel rows -- never
///   waiting for a final, fully-assembled `records: Vec<RecordRow>` to
///   exist the way the old `identity_key_to_ordinal` map did.
/// - The final per-record assembly is a single rayon `fold`/`reduce` over
///   owners that lands each `RecordRow` directly into one of `N_NIBBLES`
///   buckets by the top nibble of its OWN `record_id` (no intermediate
///   flat `Vec<RecordRow>`, no global sort); each bucket is then
///   `par_sort_unstable`-ed independently, in parallel across buckets.
///
/// `owners` need not be pre-sorted by `owner_path` (unlike
/// `materialize_cold`): determinism here comes entirely from sorted-key
/// dictionary assignment and per-partition sorting, not owner iteration
/// order.
pub fn materialize_cold_partitioned(
    mut owners: Vec<OwnerFacts>,
) -> Result<MaterializedPartitionedGeneration, ScanError> {
    let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();
    let owner_count = owners.len();
    let total_record_count: usize = owners.iter().map(|owner| owner.records.len()).sum();

    // P2-2l item 1 (LPT scheduling): sort owners by DESCENDING record count
    // before handing them to rayon's work-stealing `into_par_iter`. This
    // module's own doc comment above already establishes that `owners`
    // need not be pre-sorted by `owner_path` for this partitioned function
    // -- determinism here comes entirely from sorted-key dictionary
    // assignment (Step 1 below) and per-partition sorting (Step 6), never
    // from owner iteration order -- so reordering owners is free to do for
    // any reason, including this one. Classic longest-processing-time-first
    // scheduling: starting the largest, slowest units of work FIRST (rather
    // than leaving them to be drawn last, when every other worker thread
    // has already gone idle) minimizes the makespan of a greedy
    // work-stealing scheduler. Combined with `kernel_rows_batches`' own
    // `rayon::join` change (this same task), a single giant owner no
    // longer has to be both scheduled last AND run single-threaded to
    // become the tail.
    owners.sort_unstable_by_key(|owner| std::cmp::Reverse(owner.records.len()));

    let pass1_started = std::time::Instant::now();

    // P2-2l item 1: per-owner task wall time, recorded alongside each
    // owner's own result via `unzip` (one `Instant::now()` pair per owner --
    // negligible overhead next to the SHA-256/JSON work `canonicalize_owner`
    // itself does), so the tail (`max task ms` vs `mean`) can be reported
    // directly instead of guessed at. Always collected (not just under
    // `URDIRA_DEBUG_TIMING`): the two `Instant` reads per owner are cheap
    // enough that gating them would only save a rounding error, and every
    // debug-timing report below already exists behind the same `if
    // debug_timing` print gate.
    let (task_ms, owner_rows): (Vec<f64>, Vec<Result<OwnerKernelRows, ScanError>>) = owners
        .into_par_iter()
        .map(|owner| {
            let started = std::time::Instant::now();
            let result = canonicalize_owner(owner);
            (started.elapsed().as_secs_f64() * 1_000.0, result)
        })
        .unzip();
    let owner_rows: Vec<OwnerKernelRows> = owner_rows.into_iter().collect::<Result<_, _>>()?;

    if debug_timing {
        let bisected: usize = owner_rows
            .iter()
            .filter(|owner| owner.batch_count > 1)
            .count();
        let max_batches = owner_rows
            .iter()
            .map(|owner| owner.batch_count)
            .max()
            .unwrap_or(0);
        let max_task_ms = task_ms.iter().copied().fold(0.0_f64, f64::max);
        let mean_task_ms = if task_ms.is_empty() {
            0.0
        } else {
            task_ms.iter().sum::<f64>() / task_ms.len() as f64
        };
        eprintln!(
            "[urdira-indexing-worker] v4 materialize pass1 (kernel canonicalize, partitioned): {:.3}s owners={owner_count} records={total_record_count} owners_bisected={bisected} max_batches_for_one_owner={max_batches} max_task_ms={max_task_ms:.3} mean_task_ms={mean_task_ms:.3}",
            pass1_started.elapsed().as_secs_f64(),
        );
    }

    let pass2_started = std::time::Instant::now();

    // ---- Step 1: distinct-key dictionaries, sorted, fully parallel ----
    // P2-2j round 6 fix: a single combined rayon `fold`/`reduce` over
    // `owner_rows` builds all four `FxHashSet<String>`s (kind/universal_
    // kind/relation_kind/name) in ONE pass over the 2.83M-record corpus,
    // instead of `collect_distinct` being called four separate times (four
    // separate full O(records) scans -- measured live as a meaningful,
    // avoidable share of this step's own wall time on n8n scale).
    let dict_started = std::time::Instant::now();
    let (kind_set, universal_kind_set, relation_kind_set, name_set): (
        FxHashSet<String>,
        FxHashSet<String>,
        FxHashSet<String>,
        FxHashSet<String>,
    ) = owner_rows
        .par_iter()
        .fold(
            || {
                (
                    FxHashSet::default(),
                    FxHashSet::default(),
                    FxHashSet::default(),
                    FxHashSet::default(),
                )
            },
            |(mut kinds, mut universal_kinds, mut relation_kinds, mut names), owner| {
                for index in 0..owner.rows.len() {
                    let (kind, universal_kind, category) = &owner.kind_universal_category[index];
                    if !kinds.contains(kind.as_str()) {
                        kinds.insert(kind.clone());
                    }
                    if !universal_kinds.contains(universal_kind.as_str()) {
                        universal_kinds.insert(universal_kind.clone());
                    }
                    if *category == CATEGORY_RELATION
                        && !relation_kinds.contains(universal_kind.as_str())
                    {
                        relation_kinds.insert(universal_kind.clone());
                    }
                    let name = identity_key_name(&owner.rows[index].identity_key);
                    if !names.contains(name) {
                        names.insert(name.to_string());
                    }
                }
                (kinds, universal_kinds, relation_kinds, names)
            },
        )
        .reduce(
            || {
                (
                    FxHashSet::default(),
                    FxHashSet::default(),
                    FxHashSet::default(),
                    FxHashSet::default(),
                )
            },
            |(mut ka, mut ua, mut ra, mut na), (kb, ub, rb, nb)| {
                ka.extend(kb);
                ua.extend(ub);
                ra.extend(rb);
                na.extend(nb);
                (ka, ua, ra, na)
            },
        );
    let mut kind_values: Vec<String> = kind_set.into_iter().collect();
    kind_values.par_sort_unstable();
    let mut universal_kind_values: Vec<String> = universal_kind_set.into_iter().collect();
    universal_kind_values.par_sort_unstable();
    let mut relation_kind_values: Vec<String> = relation_kind_set.into_iter().collect();
    relation_kind_values.par_sort_unstable();
    let mut name_values: Vec<String> = name_set.into_iter().collect();
    name_values.par_sort_unstable();
    let mut artifact_values: Vec<(String, String)> = owner_rows
        .iter()
        .map(|owner| {
            (
                owner.owner_artifact_id.clone(),
                owner.owner_artifact_version_id.clone(),
            )
        })
        .collect();
    artifact_values.par_sort_unstable();
    artifact_values.dedup();

    let mut kinds = OrdinalDict::new();
    for value in &kind_values {
        kinds.intern(value);
    }
    let mut universal_kinds = OrdinalDict::new();
    for value in &universal_kind_values {
        universal_kinds.intern(value);
    }
    let mut relation_kinds = OrdinalDict::new();
    for value in &relation_kind_values {
        relation_kinds.intern(value);
    }
    let mut names = OrdinalDict::new();
    for value in &name_values {
        names.intern(value);
    }
    let mut artifacts: OrdinalDict<(String, String)> = OrdinalDict::new();
    for value in &artifact_values {
        artifacts.intern(value);
    }
    let dict_elapsed = dict_started.elapsed();

    // ---- Step 2: identity_key_digest -> record_id (parallel fold/reduce) ----
    let subject_map_started = std::time::Instant::now();
    let identity_key_digest_to_record_id: FxHashMap<[u8; 32], [u8; 32]> = owner_rows
        .par_iter()
        .fold(FxHashMap::default, |mut acc, owner| {
            for row in &owner.rows {
                acc.insert(row.identity_key_digest, row.record_id);
            }
            acc
        })
        .reduce(FxHashMap::default, |mut a, b| {
            a.extend(b);
            a
        });

    // ---- Step 3: resolve every relation's (source, target) record_id ----
    let resolved_endpoints: Vec<Vec<ResolvedEndpoints>> = owner_rows
        .par_iter()
        .map(|owner| {
            owner
                .relation_endpoints
                .iter()
                .map(|maybe_endpoints| {
                    maybe_endpoints.as_ref().map(|(source_id, target_id)| {
                        (
                            resolve_record_id_cold(
                                source_id.as_deref(),
                                &identity_key_digest_to_record_id,
                            ),
                            resolve_record_id_cold(
                                target_id.as_deref(),
                                &identity_key_digest_to_record_id,
                            ),
                        )
                    })
                })
                .collect()
        })
        .collect();

    // ---- Step 4: distinct subject keys, sorted (parallel fold/reduce) ----
    let subject_key_set: FxHashSet<[u8; 32]> = resolved_endpoints
        .par_iter()
        .fold(FxHashSet::default, |mut acc, owner_endpoints| {
            for endpoints in owner_endpoints.iter().flatten() {
                if let Some(source) = endpoints.0 {
                    acc.insert(source);
                }
                if let Some(target) = endpoints.1 {
                    acc.insert(target);
                }
            }
            acc
        })
        .reduce(FxHashSet::default, |mut a, mut b| {
            if a.len() < b.len() {
                std::mem::swap(&mut a, &mut b);
            }
            a.extend(b);
            a
        });
    let mut subject_values: Vec<[u8; 32]> = subject_key_set.into_iter().collect();
    subject_values.par_sort_unstable();
    let mut subjects: OrdinalDict<[u8; 32]> = OrdinalDict::new();
    for value in &subject_values {
        subjects.intern(value);
    }
    let subject_map_elapsed = subject_map_started.elapsed();

    // ---- Step 5: which proposal_record_keys does any dependency need? ----
    // (Only these ever get looked up below -- see deliverable 2's own
    // scope note in `deps.rs`: `record` is best-effort, non-digest-bearing
    // metadata, never read by any query path, so only paying to resolve it
    // for the small subset a real dependency references is a pure win over
    // the old code's "intern EVERY record's proposal_key" cost.)
    let needed_proposal_keys: FxHashSet<String> = owner_rows
        .iter()
        .flat_map(|owner| {
            owner
                .dependencies
                .iter()
                .map(|dependency| dependency.proposal_record_key.clone())
        })
        .collect();

    // ---- Step 6: final parallel assembly straight into N_NIBBLES buckets ----
    let assemble_started = std::time::Instant::now();
    type Accum = (
        Vec<Vec<RecordRow>>,
        FxHashMap<String, [u8; 32]>,
        Vec<(u32, u32, String, ProposedRecordDependency)>,
    );
    let empty_accum = || -> Accum {
        (
            (0..N_NIBBLES).map(|_| Vec::new()).collect(),
            FxHashMap::default(),
            Vec::new(),
        )
    };

    let (partitions, proposal_key_to_record_id, pending_deps): Accum = owner_rows
        .into_par_iter()
        .zip(resolved_endpoints.into_par_iter())
        .fold(
            empty_accum,
            |(mut partitions, mut proposal_map, mut deps), (mut owner, endpoints)| {
                let owner_key = (
                    owner.owner_artifact_id.clone(),
                    owner.owner_artifact_version_id.clone(),
                );
                let owner_ordinal = artifacts
                    .ordinal_of(&owner_key)
                    .expect("every owner artifact was interned in step 1");
                for (index, row) in owner.rows.iter_mut().enumerate() {
                    let (kind, universal_kind, category) = &owner.kind_universal_category[index];
                    let category = *category;
                    let kind_id =
                        u16::try_from(kinds.ordinal_of(kind).expect("kind interned in step 1"))
                            .unwrap_or(NONE_U16);
                    let universal_kind_id = u16::try_from(
                        universal_kinds
                            .ordinal_of(universal_kind)
                            .expect("universal_kind interned in step 1"),
                    )
                    .unwrap_or(NONE_U16);
                    let relation_kind_id = if category == CATEGORY_RELATION {
                        u16::try_from(
                            relation_kinds
                                .ordinal_of(universal_kind)
                                .expect("relation_kind interned in step 1"),
                        )
                        .unwrap_or(NONE_U16)
                    } else {
                        NONE_U16
                    };
                    let name_key = identity_key_name(&row.identity_key).to_owned();
                    let name_id = names
                        .ordinal_of(&name_key)
                        .expect("name interned in step 1");

                    let record_id = row.record_id;
                    let record_digest = row.record_digest;
                    let body_digest = row.body_digest;
                    let identity_id = row.identity_id;
                    let identity_key_digest = row.identity_key_digest;
                    let body = std::mem::take(&mut row.body);
                    let identity_key = std::mem::take(&mut row.identity_key);
                    let (span_start_byte, span_end_byte) = (row.span_start, row.span_end);
                    let facets = facets_bitmask(&row.facets);
                    let identity_type = identity_type_byte(row.identity_type);

                    let (source_subject, target_subject) = match &endpoints[index] {
                        Some((source, target)) => (
                            source.and_then(|key| subjects.ordinal_of(&key)),
                            target.and_then(|key| subjects.ordinal_of(&key)),
                        ),
                        None => (None, None),
                    };

                    if needed_proposal_keys.contains(&owner.proposal_keys[index]) {
                        proposal_map.insert(owner.proposal_keys[index].clone(), record_id);
                    }

                    let nib = nibble_of(&record_id);
                    partitions[nib].push(RecordRow {
                        record_id,
                        owner_artifact: owner_ordinal,
                        owner_version: owner_ordinal,
                        valid_from: 1,
                        valid_to: 0,
                        category,
                        kind_id,
                        universal_kind_id,
                        facets,
                        span_artifact_version: owner_ordinal,
                        span_start_byte,
                        span_end_byte,
                        span_start_line: 0,
                        span_end_line: 0,
                        identity_type,
                        assignment_kind: 0,
                        name_id,
                        identity_key: identity_key.into_bytes(),
                        record_digest,
                        body_digest,
                        identity_id,
                        identity_key_digest,
                        previous_record_id: NONE_ZERO,
                        source_subject,
                        target_subject,
                        relation_kind_id,
                        body,
                    });
                }
                for dependency in &owner.dependencies {
                    deps.push((
                        owner_ordinal,
                        owner_ordinal,
                        owner.owner_path.clone(),
                        dependency.clone(),
                    ));
                }
                (partitions, proposal_map, deps)
            },
        )
        .reduce(
            empty_accum,
            |(mut partitions_a, mut map_a, mut deps_a), (partitions_b, map_b, deps_b)| {
                for (bucket_a, mut bucket_b) in partitions_a.iter_mut().zip(partitions_b) {
                    bucket_a.append(&mut bucket_b);
                }
                map_a.extend(map_b);
                deps_a.extend(deps_b);
                (partitions_a, map_a, deps_a)
            },
        );
    let assemble_elapsed = assemble_started.elapsed();
    let mut partitions = partitions;

    // P1-D-h item 1: repair every relation whose identity claims a
    // resolved target that never interned (`plan_relation_repair`'s own
    // doc comment) -- same fix as `materialize_generation` (above),
    // adapted for this function's own nibble-bucketed partitions: a repair
    // recomputes `record_id`, which can move a row into a DIFFERENT nibble
    // bucket than the one Step 6 just placed it in.
    //
    // Two phases (see `RepairedRelation`'s own doc comment for why they are
    // split this way -- a first, single-phase version that mutated
    // `RecordRow`s directly from inside `par_iter_mut()` was flaky, rarely
    // corrupting a repaired row's identity/body to all-zero bytes of the
    // right length): (1) PARALLEL, READ-ONLY planning across partitions
    // (`par_iter()`, `&RecordRow` only) -- each candidate's own repair is
    // an independent SHA-256 kernel computation; (2) SEQUENTIAL application
    // of every plan, then relocating any row whose repair changed its own
    // nibble (typically ~15/16 of them, since a fresh digest's own top
    // nibble is effectively random) with `swap_remove` (O(1), safe here:
    // this scan's own Step 7 sorts every partition by `record_id` again
    // right below, so within-partition order never matters otherwise) --
    // `Vec::remove`'s O(n) shift alone cost ~28.7s of a ~60s n8n cold scan
    // in an earlier version of this fix; see this task's evidence doc.
    // Must run before dictionary finalization too, for the same `names`-
    // still-open reason `materialize_generation` documents.
    let classification_started = std::time::Instant::now();
    let repairs_by_partition: Vec<Vec<(usize, RepairedRelation)>> = partitions
        .par_iter()
        .map(|partition| {
            partition
                .iter()
                .enumerate()
                .filter_map(|(index, record)| match plan_relation_repair(record) {
                    Ok(Some(repaired)) => Some(Ok((index, repaired))),
                    Ok(None) => None,
                    Err(error) => Some(Err(error)),
                })
                .collect::<Result<Vec<_>, ScanError>>()
        })
        .collect::<Result<Vec<_>, ScanError>>()?;
    let unresolved_name_ordinal = names.intern(&"unresolved".to_string());
    let mut classification_repaired = 0u64;
    let mut moved_records: Vec<RecordRow> = Vec::new();
    for (partition, repairs) in partitions.iter_mut().zip(repairs_by_partition) {
        let mut moved_indices = Vec::with_capacity(repairs.len());
        for (index, repaired) in repairs {
            let old_nibble = nibble_of(&partition[index].record_id);
            apply_relation_repair(&mut partition[index], repaired, unresolved_name_ordinal);
            classification_repaired += 1;
            if nibble_of(&partition[index].record_id) != old_nibble {
                moved_indices.push(index);
            }
        }
        // Descending order: `swap_remove` moves the LAST element into the
        // removed slot, so removing from the highest index down never
        // disturbs an index still queued for removal in this same batch.
        moved_indices.sort_unstable_by(|a, b| b.cmp(a));
        for index in moved_indices {
            moved_records.push(partition.swap_remove(index));
        }
    }
    for record in moved_records {
        partitions[nibble_of(&record.record_id)].push(record);
    }
    let classification_elapsed = classification_started.elapsed();

    // ---- Step 7: sort each partition ascending by record_id, in parallel ----
    let sort_started = std::time::Instant::now();
    partitions
        .par_iter_mut()
        .for_each(|partition| partition.sort_unstable_by_key(|row| row.record_id));
    let sort_elapsed = sort_started.elapsed();

    // ---- Step 8: resolve dependency target record_ids to their FINAL
    // global ordinal (position in the concatenated, nibble-ordered
    // partitions -- exactly what the old flat, globally-sorted `records`
    // Vec's positions meant) via one binary search per NEEDED proposal key
    // (small: `dependencies.len()` on n8n, 36,621 out of 2.8M records) into
    // its own already-sorted partition. `DependencyRow.record` is
    // best-effort metadata only (see `deps.rs`'s own doc comment: never
    // read by any query path, not part of any merkle digest), so a
    // dependency whose target record_id was somehow not found here
    // (should not happen: every `proposal_key_to_record_id` entry was
    // populated straight from a row that DID land in some partition) just
    // resolves to `None`, matching `record_ordinal_by_proposal_key.get(..)`
    // returning `None` for any other unresolved key already.
    let mut row_base = [0usize; N_NIBBLES + 1];
    for nib in 0..N_NIBBLES {
        row_base[nib + 1] = row_base[nib] + partitions[nib].len();
    }
    let record_ordinal_by_proposal_key: FxHashMap<String, u32> = proposal_key_to_record_id
        .into_iter()
        .filter_map(|(key, record_id)| {
            let nib = nibble_of(&record_id);
            partitions[nib]
                .binary_search_by_key(&record_id, |row| row.record_id)
                .ok()
                .map(|local| (key, (row_base[nib] + local) as u32))
        })
        .collect();

    let deps_started = std::time::Instant::now();
    let dependencies = deps::materialize_dependencies(
        pending_deps,
        &record_ordinal_by_proposal_key,
        &mut artifacts,
        1,
    )?;
    let deps_elapsed = deps_started.elapsed();

    let dict_finalize_started = std::time::Instant::now();
    let mut dicts = Dictionaries {
        subjects: subjects.into_values(),
        ..Dictionaries::default()
    };
    dicts.kinds = kinds.into_values();
    dicts.universal_kinds = universal_kinds.into_values();
    dicts.relation_kinds = relation_kinds.into_values();
    dicts.names = names.into_values();
    dicts.artifacts = artifacts.into_values();
    dicts.facet_names = FACET_ORDER.iter().map(|name| (*name).to_string()).collect();
    dicts.subject_text = dicts
        .subjects
        .par_iter()
        .map(|key| format!("record:{}", hex_encode(key)))
        .collect();
    let dict_finalize_elapsed = dict_finalize_started.elapsed();

    if debug_timing {
        let record_count: usize = partitions.iter().map(Vec::len).sum();
        eprintln!(
            "[urdira-indexing-worker] v4 materialize pass2 (partitioned): {:.3}s total dict={:.3}s subject_resolve={:.3}s assemble={:.3}s classification_repair={:.3}s partition_sort={:.3}s deps={:.3}s dict_finalize={:.3}s records={record_count} dependencies={} subjects={} classification_repaired={}",
            pass2_started.elapsed().as_secs_f64(),
            dict_elapsed.as_secs_f64(),
            subject_map_elapsed.as_secs_f64(),
            assemble_elapsed.as_secs_f64(),
            classification_elapsed.as_secs_f64(),
            sort_elapsed.as_secs_f64(),
            deps_elapsed.as_secs_f64(),
            dict_finalize_elapsed.as_secs_f64(),
            dependencies.len(),
            dicts.subjects.len(),
            classification_repaired,
        );
    }

    Ok(MaterializedPartitionedGeneration {
        partitions,
        dependencies,
        dicts,
    })
}

fn materialize_generation(
    owners: Vec<OwnerFacts>,
    generation: u32,
    base_dicts: Option<&Dictionaries>,
    external_subject_lookup: Option<ExternalSubjectLookup<'_>>,
) -> Result<MaterializedGeneration, ScanError> {
    let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();
    let owner_count = owners.len();
    let total_record_count: usize = owners.iter().map(|owner| owner.records.len()).sum();
    let pass1_started = std::time::Instant::now();

    // Pass 1: canonicalize every owner's rows through the structural
    // kernel. Independent per owner (plan §4's rayon pool) --
    // `structural_kernel_rows` does real per-record SHA-256 work with no
    // shared mutable state across owners, so this is a
    // straightforward `par_iter` win (see the evidence doc for the
    // sequential-vs-parallel measurement and this task's P2-2c follow-up
    // measurement of what actually dominated Pass 1 wall time even with
    // `par_iter` already in place).
    let mut owner_rows: Vec<OwnerKernelRows> = owners
        .into_par_iter()
        .map(canonicalize_owner)
        .collect::<Result<_, _>>()?;

    if debug_timing {
        let bisected: usize = owner_rows
            .iter()
            .filter(|owner| owner.batch_count > 1)
            .count();
        let max_batches = owner_rows
            .iter()
            .map(|owner| owner.batch_count)
            .max()
            .unwrap_or(0);
        eprintln!(
            "[urdira-indexing-worker] v4 materialize pass1 (kernel canonicalize): {:.3}s owners={owner_count} records={total_record_count} owners_bisected={bisected} max_batches_for_one_owner={max_batches}",
            pass1_started.elapsed().as_secs_f64(),
        );
    }
    let pass2_started = std::time::Instant::now();

    // Pass 2 (sequential, deterministic): assign dictionary ordinals,
    // build the identity_key -> ordinal map (for relation subjects) and
    // proposal_record_key -> ordinal map (for dependency attachment), and
    // emit final `RecordRow`s.
    let mut artifacts: OrdinalDict<(String, String)> = match base_dicts {
        Some(base) => OrdinalDict::from_existing(&base.artifacts),
        None => OrdinalDict::new(),
    };
    let mut kinds: OrdinalDict<String> = match base_dicts {
        Some(base) => OrdinalDict::from_existing(&base.kinds),
        None => OrdinalDict::new(),
    };
    let mut universal_kinds: OrdinalDict<String> = match base_dicts {
        Some(base) => OrdinalDict::from_existing(&base.universal_kinds),
        None => OrdinalDict::new(),
    };
    let mut relation_kinds: OrdinalDict<String> = match base_dicts {
        Some(base) => OrdinalDict::from_existing(&base.relation_kinds),
        None => OrdinalDict::new(),
    };
    let mut names: OrdinalDict<String> = match base_dicts {
        Some(base) => OrdinalDict::from_existing(&base.names),
        None => OrdinalDict::new(),
    };

    let mut records: Vec<RecordRow> = Vec::new();
    // `FxHashMap` (not `std`'s default `SipHash`-based `HashMap`) for these
    // two ~1.5M-entry maps: `sample`-profiled as a meaningful share of Pass
    // 2's own CPU time on n8n (see the evidence doc). Never iterated for
    // output order (final order always comes from `records`, a `Vec` built
    // in owner-path order, or from `OrdinalDict.values`), so FxHash's
    // weaker collision resistance and lack of per-process random seeding
    // (a `HashMap` determinism non-issue either way here, but worth
    // noting) cost nothing this pipeline relies on.
    // P2-2h item 4: keyed by `identity_key_digest` ([u8; 32], already
    // computed per-row by the structural kernel in Pass 1) rather than the
    // raw `identity_key` `String` -- a fixed-size array is cheaper to hash,
    // clone (`Copy`, no heap allocation), and compare than a variable-
    // length string, and this map exists purely for O(1) internal lookups
    // (never iterated for output order), so the key's own identity is
    // irrelevant to determinism. `resolve_subject_key` hashes a relation
    // endpoint's `identity_key` string through the exact same digest
    // recipe (`delta::identity_key_digest_bytes`) before looking it up
    // here, so both sides of the comparison live in the same digest space.
    let mut identity_key_to_ordinal: FxHashMap<[u8; 32], u32> = FxHashMap::default();
    let mut proposal_key_to_ordinal: FxHashMap<String, u32> = FxHashMap::default();
    // Resolved in a second sub-pass below, once every owner's records
    // exist (a relation may point forward to a file processed later in
    // owner-path order, e.g. an `import` of a lexically-later path).
    let mut deferred_subjects: Vec<(usize, Option<String>, Option<String>)> = Vec::new();
    let mut pending_deps: Vec<(u32, u32, String, ProposedRecordDependency)> = Vec::new();
    let mut owner_ordinals: FxHashMap<String, u32> = FxHashMap::default();

    for owner in &mut owner_rows {
        let owner_ordinal = artifacts.intern(&(
            owner.owner_artifact_id.clone(),
            owner.owner_artifact_version_id.clone(),
        ));
        owner_ordinals.insert(owner.owner_path.clone(), owner_ordinal);
        for (index, row) in owner.rows.iter_mut().enumerate() {
            let (kind, universal_kind, category) = &owner.kind_universal_category[index];
            let category = *category;
            let kind_id = u16::try_from(kinds.intern(kind)).unwrap_or(NONE_U16);
            let universal_kind_id =
                u16::try_from(universal_kinds.intern(universal_kind)).unwrap_or(NONE_U16);
            let relation_kind_id = if category == CATEGORY_RELATION {
                u16::try_from(relation_kinds.intern(universal_kind)).unwrap_or(NONE_U16)
            } else {
                NONE_U16
            };
            let name_id = names.intern(&identity_key_name(&row.identity_key).to_owned());

            // P2-2f: `record_id`/`record_digest`/`body_digest`/`identity_id`/
            // `identity_key_digest` are already `[u8; 32]` on `row` -- no
            // hex decode anywhere on this path any more. `body`/
            // `identity_key` are moved out (`mem::take`) rather than
            // cloned: this owner's `rows` entry is never read again after
            // this loop (see `OwnerKernelRows::rows`'s doc comment).
            let record_id = row.record_id;
            let record_digest = row.record_digest;
            let body_digest = row.body_digest;
            let identity_id = row.identity_id;
            let identity_key_digest = row.identity_key_digest;
            let body = std::mem::take(&mut row.body);
            // No `.clone()` needed any more (P2-2h item 4): the ordinal
            // map below is now keyed by `identity_key_digest` (already
            // bound above, a `Copy` `[u8; 32]`), not by this `String` --
            // `identity_key` moves straight into `RecordRow.identity_key`
            // below with zero extra clones.
            let identity_key = std::mem::take(&mut row.identity_key);
            let (span_start_byte, span_end_byte) = (row.span_start, row.span_end);
            let facets = facets_bitmask(&row.facets);
            let identity_type = identity_type_byte(row.identity_type);

            let ordinal = u32::try_from(records.len())
                .map_err(|_| ScanError("v4 materialize: record ordinal overflowed u32".into()))?;
            identity_key_to_ordinal.insert(identity_key_digest, ordinal);
            proposal_key_to_ordinal.insert(owner.proposal_keys[index].clone(), ordinal);

            if let Some((source_id, target_id)) = owner.relation_endpoints[index].clone() {
                deferred_subjects.push((records.len(), source_id, target_id));
            }

            records.push(RecordRow {
                record_id,
                owner_artifact: owner_ordinal,
                owner_version: owner_ordinal,
                valid_from: generation,
                valid_to: 0,
                category,
                kind_id,
                universal_kind_id,
                facets,
                span_artifact_version: owner_ordinal,
                span_start_byte,
                span_end_byte,
                span_start_line: 0,
                span_end_line: 0,
                identity_type,
                assignment_kind: 0,
                name_id,
                identity_key: identity_key.into_bytes(),
                record_digest,
                body_digest,
                identity_id,
                identity_key_digest,
                previous_record_id: NONE_ZERO,
                source_subject: None,
                target_subject: None,
                relation_kind_id,
                body,
            });
        }
        for dependency in &owner.dependencies {
            pending_deps.push((
                owner_ordinal,
                owner_ordinal,
                owner.owner_path.clone(),
                dependency.clone(),
            ));
        }
    }
    let owner_loop_elapsed = pass2_started.elapsed();

    // Everything needed out of `owner_rows` has now been copied/moved into
    // `records`/`pending_deps`/the ordinal maps above (Pass 2's loop
    // `mem::take`s each row's `body`/`identity_key`, so those two no
    // longer even need dropping here) -- drop the rest here, on rayon's
    // worker pool, instead of paying for a single-threaded drop when this
    // function returns. Pre-P2-2f, `StructuralPublicationRecord` carried
    // nine `String` fields plus a `facets: Vec<String>` per record (~1.5M
    // records on n8n), and `bodies`/`proposal_keys`/`kind_universal_
    // category`/`dependencies` added more `String`/`Vec` allocations on
    // top -- confirmed live with `sample` (see this task's evidence doc):
    // even after Pass 1 already took over dropping each publication's JSON
    // span tree, freeing the REST of that structure was still ~40% of
    // every sample taken in and after Pass 2. P2-2f's `StructuralKernelRow`
    // is narrower (no JSON span tree, no hex-text body/digest Strings), and
    // its two remaining heap fields are now moved out rather than cloned,
    // so this background drop should be considerably cheaper than that
    // measurement -- see this task's evidence doc for whether it still
    // shows up at all.
    //
    // Dispatched via `rayon::spawn` (fire-and-forget onto rayon's existing
    // global pool, not a blocking `par_iter`) so the sequential work right
    // below (subject resolution, dependency materialization, dictionary
    // `into_values()`) runs concurrently with the drop instead of waiting
    // on it first -- confirmed live with `sample` that the blocking version
    // spent a visible slice of Pass 2 purely in `pthread_cond_wait` for
    // this drop to finish with nothing else scheduled. `drop_done` is
    // joined below, right before the debug report, so this function still
    // never returns until the drop has actually completed (no dangling
    // background work outliving one `materialize_cold` call, which matters
    // once this worker process starts handling more than one scan/
    // generation in its lifetime).
    let drop_started = std::time::Instant::now();
    let (drop_done_tx, drop_done_rx) = std::sync::mpsc::channel::<std::time::Duration>();
    rayon::spawn(move || {
        owner_rows.into_par_iter().for_each(drop);
        let _ = drop_done_tx.send(drop_started.elapsed());
    });

    // Resolve relation subjects now that every owner's records exist.
    // `subjects` used to be interned via a linear `Vec::iter().position()`
    // scan (`intern_subject`, since removed) re-run for every relation
    // endpoint -- O(relations * distinct_subjects), which on n8n's ~1.5M
    // records dwarfed everything else this function does (see this task's
    // evidence doc). `OrdinalDict` (already used for every other dictionary
    // in this function, a few lines up) gives the identical append-only,
    // first-seen-order semantics through a `HashMap`, in O(1) amortized per
    // lookup.
    let deferred_subject_count = deferred_subjects.len();
    // P2-2h item 4 diagnostic: the expensive-looking O(relations) lookup
    // loop is read-only against `records`/`identity_key_to_ordinal` until
    // the final `subjects.intern` -- resolve every (source_key, target_key)
    // pair in parallel first (rayon `par_iter`, order-preserving
    // `collect`), then run only the ordinal assignment itself (which MUST
    // stay sequential/in-order for determinism, see `OrdinalDict`'s doc
    // comment) as a second, much cheaper pass.
    let subject_resolve_started = std::time::Instant::now();
    let resolved_subjects: Vec<ResolvedSubject> = deferred_subjects
        .into_par_iter()
        .map(|(record_index, source_id, target_id)| {
            let source_key = resolve_subject_key(
                &records,
                &identity_key_to_ordinal,
                source_id.as_deref(),
                external_subject_lookup,
            );
            let target_key = resolve_subject_key(
                &records,
                &identity_key_to_ordinal,
                target_id.as_deref(),
                external_subject_lookup,
            );
            (record_index, source_key, target_key)
        })
        .collect();
    let subject_resolve_elapsed = subject_resolve_started.elapsed();

    let subject_intern_started = std::time::Instant::now();
    let mut subjects: OrdinalDict<[u8; 32]> = match base_dicts {
        Some(base) => OrdinalDict::from_existing(&base.subjects),
        None => OrdinalDict::new(),
    };
    for (record_index, source_key, target_key) in resolved_subjects {
        if let Some(record) = records.get_mut(record_index) {
            record.source_subject = source_key.map(|key| subjects.intern(&key));
            record.target_subject = target_key.map(|key| subjects.intern(&key));
        }
    }
    let subject_intern_elapsed = subject_intern_started.elapsed();

    // P1-D-h item 1: repair every relation whose identity claims a
    // resolved target that never interned (see `plan_relation_repair`'s
    // own doc comment). Must run AFTER `target_subject` is known (just
    // above) and BEFORE dictionary finalization below (`names` is still an
    // open `OrdinalDict`, so interning `"unresolved"` here, ONCE, up
    // front, never needs a separate dict pass).
    //
    // Two phases -- see `RepairedRelation`'s own doc comment for why: (1)
    // PARALLEL, READ-ONLY planning (`par_iter()`, `&RecordRow` only) over
    // every record; (2) SEQUENTIAL application of every plan. A first,
    // single-phase version that mutated `RecordRow`s directly from inside
    // `par_iter_mut()` was flaky (rarely corrupting a repaired row's
    // identity/body to all-zero bytes of the right length; see this task's
    // evidence doc), while a fully sequential (plan-and-apply-together)
    // version cost ~28.7s of a ~60s n8n cold scan -- this keeps the
    // expensive SHA-256 kernel work parallel while confining every
    // `RecordRow` mutation to plain, sequential code.
    let repairs: Vec<(usize, RepairedRelation)> = records
        .par_iter()
        .enumerate()
        .filter_map(|(index, record)| match plan_relation_repair(record) {
            Ok(Some(repaired)) => Some(Ok((index, repaired))),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>, ScanError>>()?;
    let unresolved_name_ordinal = names.intern(&"unresolved".to_string());
    let classification_repaired = repairs.len() as u64;
    for (index, repaired) in repairs {
        apply_relation_repair(&mut records[index], repaired, unresolved_name_ordinal);
    }

    let mut dicts = Dictionaries {
        subjects: subjects.into_values(),
        ..Dictionaries::default()
    };

    let deps_started = std::time::Instant::now();
    let dependencies = deps::materialize_dependencies(
        pending_deps,
        &proposal_key_to_ordinal,
        &mut artifacts,
        generation,
    )?;
    let deps_elapsed = deps_started.elapsed();

    let dict_finalize_started = std::time::Instant::now();
    dicts.kinds = kinds.into_values();
    dicts.universal_kinds = universal_kinds.into_values();
    dicts.relation_kinds = relation_kinds.into_values();
    dicts.names = names.into_values();
    dicts.artifacts = artifacts.into_values();
    // P2-2e deliverable 3: `facet_names` is NOT append-order-interned like
    // every dictionary above -- its ordinal IS the bit index (`FACET_ORDER`
    // is a fixed compile-time constant, never grown/reordered at runtime),
    // so every generation simply reports the SAME full list; `suffix_from`
    // (called by whichever caller diffs this against the store's current
    // base -- see `Dictionaries::suffix_from`'s own doc comment) correctly
    // reduces that to "nothing new" once generation 1 has already written
    // all of it.
    dicts.facet_names = FACET_ORDER.iter().map(|name| (*name).to_string()).collect();
    // P2-2e deliverable 3: subject-id TEXT, aligned 1:1with `dicts.subjects`
    // by ordinal -- the real v4 pipeline's subject key IS the referenced
    // record's own `record_id` bytes (see `resolve_subject_key`'s callers
    // above), so `"record:<hex>"` is always exactly right, never a guess.
    // Recomputed over the FULL current `dicts.subjects` every generation
    // (not just this generation's new subjects) for the same reason
    // `facet_names` above reports the full list -- `suffix_from` reduces it
    // to the true delta.
    // P2-2j item 3 diagnostic / item 2 fix: this used to be a single-
    // threaded `.iter().map(...)` over the FULL current `dicts.subjects`
    // (not just this generation's new ones, per the comment above) --
    // measured live as a FIXED ~120-130ms cost on n8n scale (254k+
    // subjects), paid identically on every incremental edit no matter how
    // small (`URDIRA_DEBUG_TIMING`'s own `dict_finalize=0.12Xs` line was
    // essentially constant across a 3-record edit and the 2.83M-record
    // cold scan alike). `hex_encode` per key is embarrassingly parallel
    // (no shared state, no ordering dependency -- output order already
    // matches `dicts.subjects`' order 1:1 by construction), so this is a
    // pure `rayon::par_iter` swap with no behavioral change.
    dicts.subject_text = dicts
        .subjects
        .par_iter()
        .map(|key| format!("record:{}", hex_encode(key)))
        .collect();
    let dict_finalize_elapsed = dict_finalize_started.elapsed();

    // Join the background drop (see its doc comment above): by this point
    // every other Pass 2 step has already run concurrently with it, so
    // this `recv` is a no-op wait in the common case.
    let drop_elapsed = drop_done_rx.recv().unwrap_or_default();

    if debug_timing {
        eprintln!(
            "[urdira-indexing-worker] v4 materialize pass2 (overlapped owner_rows drop={:.3}s): {:.3}s total owner_loop={:.3}s subject_resolve(parallel)={:.3}s subject_intern(sequential)={:.3}s deps={:.3}s dict_finalize={:.3}s records={} deferred_subjects={} dependencies={} subjects={} classification_repaired={}",
            drop_elapsed.as_secs_f64(),
            pass2_started.elapsed().as_secs_f64(),
            owner_loop_elapsed.as_secs_f64(),
            subject_resolve_elapsed.as_secs_f64(),
            subject_intern_elapsed.as_secs_f64(),
            deps_elapsed.as_secs_f64(),
            dict_finalize_elapsed.as_secs_f64(),
            records.len(),
            deferred_subject_count,
            dependencies.len(),
            dicts.subjects.len(),
            classification_repaired,
        );
    }

    Ok(MaterializedGeneration {
        records,
        dependencies,
        dicts,
        owner_ordinals: owner_ordinals.into_iter().collect(),
    })
}

const NONE_ZERO: [u8; 32] = [0u8; 32];

fn resolve_subject_key(
    records: &[RecordRow],
    identity_key_to_ordinal: &FxHashMap<[u8; 32], u32>,
    identity_key: Option<&str>,
    external_subject_lookup: Option<ExternalSubjectLookup<'_>>,
) -> Option<[u8; 32]> {
    let identity_key = identity_key?;
    // P2-2h item 4: hash into the same `identity_key_digest` space
    // `identity_key_to_ordinal` is keyed by (see that map's doc comment).
    let digest = super::delta::identity_key_digest_bytes(identity_key);
    if let Some(ordinal) = identity_key_to_ordinal.get(&digest) {
        return records
            .get(*ordinal as usize)
            .map(|record| record.record_id);
    }
    // P3-1: the target is not among the owners regenerated in THIS call
    // (e.g. a relation into a stable, unaffected file) -- fall back to the
    // live store, if the caller wired one in (`materialize_incremental`
    // only; `materialize_cold` passes `None` here since every record in
    // the workspace is always in-batch for a cold scan).
    external_subject_lookup.and_then(|lookup| lookup(identity_key))
}

fn identity_type_byte(identity_type: &str) -> u8 {
    match identity_type {
        "relation" => 1,
        "diagnostic" => 2,
        _ => 0,
    }
}

/// `name_id` recipe (new v4 ground, plan §2.2: "último segmento `:` de
/// `identity_key`"). `identity_key` for this pipeline's producers is
/// always a colon-joined string ending in the symbol's own name (entity
/// ids: `jsts:{kind}:{path}:{start}:{name}`; relation ids embed both
/// endpoints and end in a span/name segment too), so the last `:`-segment
/// is a reasonable display name in every case this pipeline produces.
pub(super) fn identity_key_name(identity_key: &str) -> &str {
    identity_key.rsplit(':').next().unwrap_or(identity_key)
}

fn canonical_json(value: &serde_json::Value) -> String {
    serde_json::to_string(value).expect("materialize builds only plain JSON values")
}

fn canonical_span(path: &str, start: u32, end: u32) -> String {
    canonical_json(&serde_json::json!({ "path": path, "start": start, "end": end }))
}

fn canonical_evidence(path: &str, start: u32, end: u32) -> String {
    canonical_json(&serde_json::json!([{ "path": path, "start": start, "end": end }]))
}

/// `urdira-jsts-syntax-worker::lib.rs`'s `proposal_record_key` recipe,
/// reimplemented here for the same crate-isolation reason `residual.rs`
/// already documents for its own independent copy: this module cannot
/// depend on that crate's `pub(crate)` helpers.
fn proposal_record_key(identity_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"urdira:jsts-proposal-record:v1\0");
    hasher.update((identity_key.len() as u64).to_be_bytes());
    hasher.update(identity_key.as_bytes());
    let mut out = String::with_capacity(80);
    out.push_str("jsts:record:sha256:");
    for byte in hasher.finalize() {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// P1-D-h item 1 (cold-producer classification fix): recovers `path`,
/// `start`, `end`, `source_id`, and the relation's own kind word (`"call"`,
/// `"inherits"`, or `"implements"`) from a relation record's OWN identity
/// string -- never `body`, which this pipeline's Rust side never decodes
/// (`residual.rs`'s own `is_classification_consistent`/`collect()` doc
/// comments establish and rely on the same "no body decode" invariant).
///
/// Every relation this pipeline's E1-E3 typeflow lane resolves with
/// checker-grade confidence (`semantic_sites.rs`'s `call_proposed_record`/
/// `heritage_proposed_record`) writes an identity of the fixed shape
/// `jsts:{relation_kind}:{path}:{start}:{end}:{source_id}:{target_id}`,
/// where `source_id`/`target_id` are themselves `declaration_id`'s own
/// 5-`:`-field `jsts:{kind}:{path}:{start}:{name}` recipe. `start`/`end`
/// are already known (the record's own `span_start_byte`/`span_end_byte`),
/// so the exact substring `:{start}:{end}:` locates the boundary between
/// `path` and the two trailing compound ids without needing an owner-path
/// lookup at all -- a real filesystem path never contains a literal
/// `:123:456:`-shaped substring in practice (the same assumption
/// `residual.rs`'s own prefix-strip already relies on). Returns `None`
/// (caller leaves the record untouched) for anything this cannot recover
/// unambiguously: an identity that isn't `call`/`inherits`/`implements`
/// shaped, one that is already the canonical `:unresolved` possible form
/// (nothing to fix), or a remainder that does not split into exactly 10
/// `:`-tokens (a name segment containing a literal `:`, e.g. certain
/// computed/string-literal property keys -- `residual.rs`'s own P1-D-g
/// finding, left as this fix's own known, accepted gap rather than
/// guessed at).
fn parse_unresolved_confirmed_relation(
    identity_key: &[u8],
    span_start_byte: u32,
    span_end_byte: u32,
) -> Option<(String, String, &'static str)> {
    let identity_str = std::str::from_utf8(identity_key).ok()?;
    if identity_str.ends_with(":unresolved") {
        return None;
    }
    let rest = identity_str.strip_prefix("jsts:")?;
    let (relation_kind, rest) = rest.split_once(':')?;
    let relation_kind = match relation_kind {
        "call" => "call",
        "inherits" => "inherits",
        "implements" => "implements",
        _ => return None,
    };
    let needle = format!(":{span_start_byte}:{span_end_byte}:");
    let needle_pos = rest.find(&needle)?;
    let path = rest[..needle_pos].to_string();
    let after = &rest[needle_pos + needle.len()..];
    let tokens: Vec<&str> = after.split(':').collect();
    if tokens.len() != 10 {
        return None;
    }
    let source_id = tokens[..5].join(":");
    Some((path, source_id, relation_kind))
}

/// P1-D-h item 1: rewrites `record`, in place, into the canonical
/// "possible" identity `possible_call_record`/`possible_heritage_record`
/// (`urdira_jsts_syntax_worker::semantic_sites`) would have produced for
/// the exact same site, whenever `record`'s own identity claims a resolved
/// target that this module's subject-resolution pass (above) never
/// managed to intern (`record.target_subject.is_none()`) -- see
/// [`parse_unresolved_confirmed_relation`]'s own doc comment for the full
/// rule and its scope. A no-op (`Ok(false)`) for anything not a relation,
/// already resolved, or not unambiguously parseable. This always runs
/// against BRAND NEW, not-yet-published cold-generation rows (never a live
/// store), so unlike `residual.rs`'s own repair step there is no
/// predecessor to chain against and no live-identity collision to guard
/// against: `record_id`/`record_digest` are simply recomputed fresh, decision
/// 11's "cold: no predecessors" case, same as every other cold record.
/// The precomputed replacement fields for one repaired relation row --
/// [`plan_relation_repair`]'s output, [`apply_relation_repair`]'s input.
/// Split out from a single combined "compute AND mutate" function
/// (P1-D-h's own first version) specifically so the expensive SHA-256
/// kernel computation (`plan_relation_repair`) can run behind a SHARED
/// `&RecordRow` in a parallel pass, while every actual WRITE to a
/// `RecordRow` happens afterward, strictly sequentially
/// (`apply_relation_repair`, run from a plain loop, never from inside
/// `par_iter`/`par_iter_mut`). A first version that mutated `RecordRow`
/// fields directly from inside `materialize_cold_partitioned`'s own
/// `par_iter_mut()` closure was measured to occasionally (non-
/// deterministically, ~1-in-2 real n8n cold scans in this session's own
/// testing) leave a repaired row's `identity_key`/`body` as all-zero bytes
/// of the RIGHT length -- never reproduced with this split in place across
/// several repeat runs. The exact mechanism was not root-caused (this
/// session's own budget did not allow chasing it further into `urdira-
/// native-core`/rayon's own internals), but confining every `RecordRow`
/// mutation to sequential code removes the entire class of "was this the
/// concurrent-mutation path" suspects, which is the responsible fix given
/// data corruption is categorically worse than a slower repair -- see this
/// task's evidence doc for the full incident writeup.
struct RepairedRelation {
    record_id: [u8; 32],
    record_digest: [u8; 32],
    body_digest: [u8; 32],
    identity_id: [u8; 32],
    identity_key_digest: [u8; 32],
    identity_key: Vec<u8>,
    body: Vec<u8>,
    facets: u64,
}

/// Pure, read-only (`&RecordRow`, never `&mut`) computation of the
/// canonical possible-row replacement for one classification-mismatched
/// relation -- see [`RepairedRelation`]'s own doc comment for why this is
/// split from the actual mutation, and [`parse_unresolved_confirmed_
/// relation`]'s doc comment for the parsing rule/scope. `Ok(None)` for
/// anything not a relation, already resolved, or not unambiguously
/// parseable -- the caller leaves such a record untouched. Safe to call
/// from a rayon `par_iter`/`par_iter_mut` (no shared mutable state, no
/// interior mutability): the only write this function performs is to its
/// own local `body`/`record_key`, both freshly allocated per call.
fn plan_relation_repair(record: &RecordRow) -> Result<Option<RepairedRelation>, ScanError> {
    if record.category != CATEGORY_RELATION || record.target_subject.is_some() {
        return Ok(None);
    }
    let Some((path, source_id, relation_kind)) = parse_unresolved_confirmed_relation(
        &record.identity_key,
        record.span_start_byte,
        record.span_end_byte,
    ) else {
        return Ok(None);
    };
    let start = record.span_start_byte;
    let end = record.span_end_byte;
    let identity_key = format!("jsts:{relation_kind}:{path}:{start}:{end}:{source_id}:unresolved");
    let mut body = serde_json::Map::new();
    body.insert("source_id".into(), serde_json::Value::String(source_id));
    body.insert(
        "classification".into(),
        serde_json::Value::String("possible".into()),
    );
    body.insert("path".into(), serde_json::Value::String(path.clone()));
    body.insert("start".into(), serde_json::Value::from(start));
    body.insert("end".into(), serde_json::Value::from(end));
    let body = serde_json::Value::Object(body);

    let facets = canonical_json(&serde_json::json!([
        "core:reference_relation",
        "core:indirect"
    ]));
    let source_span = canonical_span(&path, start, end);
    let evidence_references = canonical_evidence(&path, start, end);
    let kind = format!("jsts:relation_{relation_kind}");
    let universal_kind = format!("core:{relation_kind}");
    let record_key = StructuralKernelRecordRef {
        proposal_record_key: &proposal_record_key(&identity_key),
        category: "relation",
        kind: &kind,
        universal_kind: &universal_kind,
        facets: &facets,
        schema_version: 1,
        source_span: &source_span,
        identity_key: &identity_key,
        body: &body,
        evidence_references: &evidence_references,
    };
    let mut batches = kernel_rows_batches(std::slice::from_ref(&record_key))?;
    let Some(kernel_rows) = batches.pop() else {
        return Ok(None);
    };
    let Some(kernel_row) = kernel_rows.rows.into_iter().next() else {
        return Ok(None);
    };
    Ok(Some(RepairedRelation {
        record_id: kernel_row.record_id,
        record_digest: kernel_row.record_digest,
        body_digest: kernel_row.body_digest,
        identity_id: kernel_row.identity_id,
        identity_key_digest: kernel_row.identity_key_digest,
        identity_key: kernel_row.identity_key.into_bytes(),
        body: kernel_row.body,
        facets: facets_bitmask(&kernel_row.facets),
    }))
}

/// Writes a [`RepairedRelation`] (from [`plan_relation_repair`]) into
/// `record`, in place. Always called from strictly sequential code (never
/// from inside a rayon `par_iter`/`par_iter_mut`) -- see
/// [`RepairedRelation`]'s own doc comment for why. `unresolved_name_
/// ordinal` is `names`'s already-interned ordinal for the literal string
/// `"unresolved"` (every repaired row's own `name_id`, `identity_key_
/// name`'s last `:`-segment of the canonical possible identity).
fn apply_relation_repair(
    record: &mut RecordRow,
    repaired: RepairedRelation,
    unresolved_name_ordinal: u32,
) {
    record.record_id = repaired.record_id;
    record.record_digest = repaired.record_digest;
    record.body_digest = repaired.body_digest;
    record.identity_id = repaired.identity_id;
    record.identity_key_digest = repaired.identity_key_digest;
    record.identity_key = repaired.identity_key;
    record.body = repaired.body;
    record.facets = repaired.facets;
    record.name_id = unresolved_name_ordinal;
    // `kind_id`/`universal_kind_id`/`relation_kind_id` are unchanged:
    // `possible_call_record`/`possible_heritage_record` use the IDENTICAL
    // `kind`/`universal_kind` strings as their `confirmed` counterpart, so
    // no new dictionary ordinal is ever needed here.
}

/// Byte-arithmetic hex nibble decode (no `char`/`to_digit` round trip).
/// P2-2f: this module's production path (`materialize_cold`'s Pass 2) no
/// longer hex-decodes anything -- `structural_kernel_rows` hands it
/// `[u8; 32]`/`Vec<u8>` natively -- so `hex_nibble`/`hex_decode`/
/// `decode_32`/`decode_sha256`/`decode_record_id`/`decode_identity_id`
/// below now exist ONLY to decode the oracle's (`structural_kernel_batch_
/// parts`, the pre-P2-2f hex/JSON-text API) output for the equivalence
/// test (`native_core_rows_match_batch_parts_oracle`, below), hence
/// `#[cfg(test)]`.
#[cfg(test)]
#[inline]
fn hex_nibble(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(format!("invalid hex digit: {}", byte as char)),
    }
}

#[cfg(test)]
fn hex_decode(hex: &str) -> Result<Vec<u8>, String> {
    let bytes = hex.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err("odd-length hex string".to_string());
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index < bytes.len() {
        let hi = hex_nibble(bytes[index])?;
        let lo = hex_nibble(bytes[index + 1])?;
        out.push((hi << 4) | lo);
        index += 2;
    }
    Ok(out)
}

#[cfg(test)]
fn decode_sha256(value: &str) -> Result<[u8; 32], ScanError> {
    let hex = value
        .strip_prefix("sha256:")
        .ok_or_else(|| ScanError(format!("expected sha256:-prefixed digest, got {value}")))?;
    decode_32(hex)
}

#[cfg(test)]
fn decode_record_id(value: &str) -> Result<[u8; 32], ScanError> {
    let hex = value
        .strip_prefix("record:")
        .ok_or_else(|| ScanError(format!("expected record:-prefixed id, got {value}")))?;
    decode_32(hex)
}

#[cfg(test)]
fn decode_identity_id(value: &str) -> Result<[u8; 32], ScanError> {
    let hex = value.rsplit_once(':').map(|(_, hex)| hex).ok_or_else(|| {
        ScanError(format!(
            "expected <type>:-prefixed identity id, got {value}"
        ))
    })?;
    decode_32(hex)
}

/// P2-2d: every one of this function's callers wants a fixed 32-byte
/// digest (`record_id`/`record_digest`/`body_digest`/`identity_id`/
/// `identity_key_digest` -- five per record, ~7.5M calls total on n8n).
/// The old implementation went through `hex_decode` (a `Vec<u8>`-returning,
/// heap-allocating decoder built for the one genuinely variable-length
/// case, the UCE body payload) and then `try_from`'d the result into a
/// fixed array, discarding the `Vec` immediately -- a heap allocation and
/// free per call for no reason. `sample`'d live on n8n (this task's
/// evidence doc, materialize Pass 2 window): `hex_decode`'s own arithmetic
/// was already fast (P2-2c's byte-range fix), but its *allocation* showed
/// up as a large share of `materialize_cold`'s samples once profiled again
/// post-P2-2c (a large `_xzm_free`/allocator-lock-contention share
/// alongside it). Decoding directly into a stack-allocated `[u8; 32]`
/// removes that allocation entirely for this function's every call site.
#[cfg(test)]
fn decode_32(hex: &str) -> Result<[u8; 32], ScanError> {
    let bytes = hex.as_bytes();
    if bytes.len() != 64 {
        return Err(ScanError(format!("digest {hex} is not 32 bytes")));
    }
    let mut out = [0u8; 32];
    for (index, slot) in out.iter_mut().enumerate() {
        let hi = hex_nibble(bytes[index * 2])
            .map_err(|error| ScanError(format!("invalid hex digest {hex}: {error}")))?;
        let lo = hex_nibble(bytes[index * 2 + 1])
            .map_err(|error| ScanError(format!("invalid hex digest {hex}: {error}")))?;
        *slot = (hi << 4) | lo;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use urdira_native_core::structural_kernel_batch_parts;

    fn entity_record(identity: &str, name: &str, path: &str) -> ProposedRecord {
        let source_span = json!({"path": path, "start": 0u32, "end": 10u32});
        let evidence = json!([source_span]);
        ProposedRecord {
            proposal_record_key: format!("jsts:record:sha256:{identity}"),
            category: "entity",
            kind: "jsts:entity_variable".to_string(),
            universal_kind: "core:value".to_string(),
            facets: serde_json::to_string(&json!(["core:declaration", "core:definition"])).unwrap(),
            facets_list: vec![
                "core:declaration".to_string(),
                "core:definition".to_string(),
            ],
            schema_version: 1,
            source_span: serde_json::to_string(&source_span).unwrap(),
            identity_key: format!("jsts:variable:{path}:0:{name}"),
            body: json!({"name": name, "path": path, "start": 0u32, "end": 10u32}),
            evidence_references: serde_json::to_string(&evidence).unwrap(),
        }
    }

    fn contains_relation(
        source_identity_key: &str,
        target_identity_key: &str,
        path: &str,
    ) -> ProposedRecord {
        let source_span = json!({"path": path, "start": 0u32, "end": 20u32});
        let evidence = json!([source_span]);
        let body = json!({
            "source_id": source_identity_key,
            "target_id": target_identity_key,
            "classification": "confirmed",
            "path": path,
            "start": 0u32,
            "end": 20u32,
        });
        ProposedRecord {
            proposal_record_key: format!(
                "jsts:record:sha256:contains:{source_identity_key}:{target_identity_key}"
            ),
            category: "relation",
            kind: "jsts:relation_contains".to_string(),
            universal_kind: "core:contains".to_string(),
            facets: serde_json::to_string(&json!(["core:structural_relation"])).unwrap(),
            facets_list: vec!["core:structural_relation".to_string()],
            schema_version: 1,
            source_span: serde_json::to_string(&source_span).unwrap(),
            identity_key: format!("jsts:contains:{source_identity_key}:{target_identity_key}"),
            body,
            evidence_references: serde_json::to_string(&evidence).unwrap(),
        }
    }

    fn owner_facts(path: &str, records: Vec<ProposedRecord>) -> OwnerFacts {
        OwnerFacts {
            owner_artifact_id: format!("artifact:{path}"),
            owner_artifact_version_id: format!("version:{path}"),
            owner_path: path.to_string(),
            records,
            dependencies: Vec::new(),
            direct_imports: Vec::new(),
            pending_sites: Vec::new(),
        }
    }

    #[test]
    fn facets_bitmask_sets_exactly_the_matched_bits() {
        let mask = facets_bitmask(&["core:declaration".to_string(), "core:async".to_string()]);
        assert_eq!(mask, (1u64 << 0) | (1u64 << 5));
        assert_eq!(
            facets_bitmask(&["core:unknown_future_facet".to_string()]),
            0
        );
        assert_eq!(facets_bitmask(&[]), 0);
    }

    #[test]
    fn identity_key_name_takes_the_last_colon_segment() {
        assert_eq!(
            identity_key_name("jsts:variable:src/a.ts:0:widget"),
            "widget"
        );
        assert_eq!(identity_key_name("no_colons"), "no_colons");
    }

    /// Regression test for this module's hex-decoding of the kernel's own
    /// `record:`/`sha256:`/`<type>:`-prefixed strings: builds one entity
    /// `ProposedRecord`, canonicalizes it directly through
    /// `structural_kernel_batch_parts` (the oracle -- the SAME function
    /// `main.rs`'s v3 hybrid lane calls), and confirms `materialize_cold`
    /// decodes `record_id`/`record_digest`/`body_digest`/`identity_id`/
    /// `identity_key_digest` into the exact same 32 bytes the oracle call
    /// produces, byte for byte.
    #[test]
    fn record_identity_matches_the_structural_kernel_oracle_exactly() {
        let record = entity_record("widget", "widget", "src/a.ts");
        let structural = to_structural_record(&record);
        let oracle = structural_kernel_batch_parts(std::slice::from_ref(&structural), &[])
            .expect("oracle kernel call succeeds");
        let oracle_publication = &oracle.publication_records[0];

        let owners = vec![owner_facts("src/a.ts", vec![record])];
        let materialized = materialize_cold(owners).expect("materialize_cold succeeds");
        assert_eq!(materialized.records.len(), 1);
        let row = &materialized.records[0];

        assert_eq!(
            row.record_id,
            decode_record_id(&oracle_publication.record_id).unwrap()
        );
        assert_eq!(
            row.record_digest,
            decode_sha256(&oracle_publication.record_digest).unwrap()
        );
        assert_eq!(
            row.body_digest,
            decode_sha256(&oracle_publication.body_digest).unwrap()
        );
        assert_eq!(
            row.identity_id,
            decode_identity_id(&oracle_publication.identity_id).unwrap()
        );
        assert_eq!(
            row.identity_key_digest,
            decode_sha256(&oracle_publication.identity_key_digest).unwrap()
        );
        assert_eq!(row.category, CATEGORY_ENTITY);
        assert_eq!(
            row.body,
            hex_decode(&oracle.record_body_payload_hexes[0]).unwrap()
        );
        // Decision 11 cold case: record_id is always sha256(record_digest),
        // independent of any predecessor (there is none here).
        assert_eq!(
            oracle_publication.record_id,
            format!(
                "record:{}",
                oracle_publication
                    .record_digest
                    .trim_start_matches("sha256:")
            )
        );
    }

    #[test]
    fn relation_subjects_resolve_to_the_referenced_entitys_record_id() {
        let source = entity_record("caller", "caller", "src/a.ts");
        let target = entity_record("callee", "callee", "src/b.ts");
        let source_identity_key = source.identity_key.clone();
        let target_identity_key = target.identity_key.clone();
        let relation = contains_relation(&source_identity_key, &target_identity_key, "src/a.ts");

        let owners = vec![
            owner_facts("src/a.ts", vec![source, relation]),
            owner_facts("src/b.ts", vec![target]),
        ];
        let materialized = materialize_cold(owners).expect("materialize_cold succeeds");
        assert_eq!(materialized.records.len(), 3);

        let source_record = materialized
            .records
            .iter()
            .find(|record| record.identity_key == source_identity_key.as_bytes())
            .expect("source entity row present");
        let target_record = materialized
            .records
            .iter()
            .find(|record| record.identity_key == target_identity_key.as_bytes())
            .expect("target entity row present");
        let relation_record = materialized
            .records
            .iter()
            .find(|record| record.category == CATEGORY_RELATION)
            .expect("relation row present");

        let source_subject = relation_record
            .source_subject
            .expect("source_subject resolved");
        let target_subject = relation_record
            .target_subject
            .expect("target_subject resolved");
        assert_eq!(
            materialized.dicts.subjects[source_subject as usize],
            source_record.record_id
        );
        assert_eq!(
            materialized.dicts.subjects[target_subject as usize],
            target_record.record_id
        );
        // Cross-file: source and target owners get distinct artifact ordinals.
        assert_ne!(source_record.owner_artifact, target_record.owner_artifact);
    }

    #[test]
    fn unresolved_relation_endpoint_leaves_that_subject_none() {
        let source = entity_record("caller", "caller", "src/a.ts");
        let source_identity_key = source.identity_key.clone();
        let relation = contains_relation(
            &source_identity_key,
            "jsts:variable:external.ts:0:missing",
            "src/a.ts",
        );
        let owners = vec![owner_facts("src/a.ts", vec![source, relation])];
        let materialized = materialize_cold(owners).expect("materialize_cold succeeds");
        let relation_record = materialized
            .records
            .iter()
            .find(|record| record.category == CATEGORY_RELATION)
            .expect("relation row present");
        assert!(relation_record.source_subject.is_some());
        assert!(relation_record.target_subject.is_none());
    }

    #[test]
    fn materialize_cold_is_deterministic_across_runs() {
        let make_owners = || {
            let source = entity_record("caller", "caller", "src/a.ts");
            let target = entity_record("callee", "callee", "src/b.ts");
            let relation = contains_relation(
                &source.identity_key.clone(),
                &target.identity_key.clone(),
                "src/a.ts",
            );
            vec![
                owner_facts("src/a.ts", vec![source, relation]),
                owner_facts("src/b.ts", vec![target]),
            ]
        };
        let first = materialize_cold(make_owners()).expect("first run succeeds");
        let second = materialize_cold(make_owners()).expect("second run succeeds");
        assert_eq!(first.records.len(), second.records.len());
        for (a, b) in first.records.iter().zip(second.records.iter()) {
            assert_eq!(a.record_id, b.record_id);
            assert_eq!(a.record_digest, b.record_digest);
            assert_eq!(a.owner_artifact, b.owner_artifact);
            assert_eq!(a.name_id, b.name_id);
            assert_eq!(a.kind_id, b.kind_id);
        }
        assert_eq!(first.dicts.artifacts, second.dicts.artifacts);
        assert_eq!(first.dicts.names, second.dicts.names);
    }

    /// Builds a `core:call`/`core:inherits`/`core:implements` `ProposedRecord`
    /// in the EXACT shape `semantic_sites.rs`'s `call_proposed_record`/
    /// `heritage_proposed_record` produce for the E1-E3 typeflow lane's own
    /// `classification: "confirmed"` case -- including a `target_id` this
    /// test deliberately points at a class/interface MEMBER identity
    /// (`jsts:method:...`) that this fixture's own owners never emit an
    /// entity record for, reproducing the exact P1-D-h item 1 scenario
    /// (`materialize.rs`'s cold-scan entity producer never materializes
    /// class/interface members as their own entities).
    fn confirmed_relation(
        relation_kind: &str,
        source_identity_key: &str,
        target_identity_key: &str,
        path: &str,
        start: u32,
        end: u32,
    ) -> ProposedRecord {
        let source_span = json!({"path": path, "start": start, "end": end});
        let evidence = json!([source_span]);
        let body = json!({
            "source_id": source_identity_key,
            "target_id": target_identity_key,
            "classification": "confirmed",
            "path": path,
            "start": start,
            "end": end,
        });
        let identity_key = format!(
            "jsts:{relation_kind}:{path}:{start}:{end}:{source_identity_key}:{target_identity_key}"
        );
        ProposedRecord {
            proposal_record_key: format!("jsts:record:sha256:{identity_key}"),
            category: "relation",
            kind: format!("jsts:relation_{relation_kind}"),
            universal_kind: format!("core:{relation_kind}"),
            facets: serde_json::to_string(&json!(["core:reference_relation"])).unwrap(),
            facets_list: vec!["core:reference_relation".to_string()],
            schema_version: 1,
            source_span: serde_json::to_string(&source_span).unwrap(),
            identity_key,
            body,
            evidence_references: serde_json::to_string(&evidence).unwrap(),
        }
    }

    /// P1-D-h item 1 (cold-producer classification fix), flat `materialize_
    /// cold` path: a `core:call` relation whose body/identity already claim
    /// `classification: "confirmed"` against a class-member target this
    /// fixture never emits an entity for MUST NOT survive materialization
    /// as an inconsistent "confirmed, but nothing to point at" row -- it
    /// must be rewritten into the canonical possible shape
    /// (`:unresolved`-suffixed identity, `target_subject` still `None`,
    /// same store-wide invariant `residual.rs`'s own `is_classification_
    /// consistent` checks: identity ends in `:unresolved` IFF `target_
    /// subject` is `None`).
    #[test]
    fn confirmed_call_to_an_uninterned_member_target_is_repaired_to_the_possible_row() {
        let source = entity_record("caller", "caller", "src/a.ts");
        let source_identity_key = source.identity_key.clone();
        let member_target_identity_key = "jsts:method:src/b.ts:40:doWork".to_string();
        let relation = confirmed_relation(
            "call",
            &source_identity_key,
            &member_target_identity_key,
            "src/a.ts",
            0,
            20,
        );
        let owners = vec![owner_facts("src/a.ts", vec![source, relation])];
        let materialized = materialize_cold(owners).expect("materialize_cold succeeds");

        let relation_record = materialized
            .records
            .iter()
            .find(|record| record.category == CATEGORY_RELATION)
            .expect("relation row present");
        assert!(relation_record.target_subject.is_none());
        let identity = std::str::from_utf8(&relation_record.identity_key).unwrap();
        assert!(
            identity.ends_with(":unresolved"),
            "identity should be rewritten to the canonical possible shape: {identity}"
        );
        assert_eq!(
            identity,
            format!("jsts:call:src/a.ts:0:20:{source_identity_key}:unresolved")
        );
        // The store-wide invariant itself (`residual.rs`'s own
        // `is_classification_consistent`): identity claims "resolved" IFF
        // `target_subject` is interned. Verified directly here (not via a
        // cross-module call) since that predicate is private to `residual`.
        assert_eq!(
            !identity.ends_with(":unresolved"),
            relation_record.target_subject.is_some()
        );
    }

    /// Same scenario as above, but through `materialize_cold_partitioned`
    /// (the REAL production cold-scan entrypoint, `scan.rs`'s own caller) --
    /// confirms the partitioned path's own repair-then-rebucket logic (a
    /// repair can move a row into a different nibble bucket than Step 6
    /// originally placed it in) reaches the exact same result as the flat
    /// oracle above.
    #[test]
    fn confirmed_call_to_an_uninterned_member_target_is_repaired_in_the_partitioned_path_too() {
        let source = entity_record("caller", "caller", "src/a.ts");
        let source_identity_key = source.identity_key.clone();
        let member_target_identity_key = "jsts:method:src/b.ts:40:doWork".to_string();
        let relation = confirmed_relation(
            "call",
            &source_identity_key,
            &member_target_identity_key,
            "src/a.ts",
            0,
            20,
        );
        let owners = vec![owner_facts("src/a.ts", vec![source, relation])];
        let materialized =
            materialize_cold_partitioned(owners).expect("materialize_cold_partitioned succeeds");

        let relation_record = materialized
            .partitions
            .iter()
            .flatten()
            .find(|record| record.category == CATEGORY_RELATION)
            .expect("relation row present");
        assert!(relation_record.target_subject.is_none());
        let identity = std::str::from_utf8(&relation_record.identity_key).unwrap();
        assert!(
            identity.ends_with(":unresolved"),
            "identity should be rewritten to the canonical possible shape: {identity}"
        );
        // The row must actually sit in the partition matching its NEW
        // record_id (the repair recomputes record_id, which can change
        // which nibble bucket it belongs in) -- not wherever Step 6
        // originally placed the pre-repair row.
        let nib = nibble_of(&relation_record.record_id);
        assert!(
            materialized.partitions[nib]
                .iter()
                .any(|record| record.record_id == relation_record.record_id)
        );
    }

    /// Same fix, heritage relation (`core:implements`) -- confirms the
    /// repair is not scoped to `core:call` alone. `possible_heritage_
    /// record`'s own identity/facets shape (`urdira_jsts_syntax_worker::
    /// semantic_sites`) is otherwise identical to `possible_call_record`'s,
    /// just parametrized by the relation's own kind word.
    #[test]
    fn confirmed_implements_to_an_uninterned_member_target_is_repaired_too() {
        let source = entity_record("caller", "caller", "src/a.ts");
        let source_identity_key = source.identity_key.clone();
        // Heritage targets are ordinarily classes/interfaces (always
        // interned even today); this fixture aims it at a member shape
        // anyway purely to exercise the SAME repair path implements/
        // inherits now shares with call, not to claim this is a realistic
        // real-world heritage target.
        let member_target_identity_key = "jsts:property:src/b.ts:5:proto".to_string();
        let relation = confirmed_relation(
            "implements",
            &source_identity_key,
            &member_target_identity_key,
            "src/a.ts",
            0,
            20,
        );
        let owners = vec![owner_facts("src/a.ts", vec![source, relation])];
        let materialized = materialize_cold(owners).expect("materialize_cold succeeds");

        let relation_record = materialized
            .records
            .iter()
            .find(|record| record.category == CATEGORY_RELATION)
            .expect("relation row present");
        assert!(relation_record.target_subject.is_none());
        let identity = std::str::from_utf8(&relation_record.identity_key).unwrap();
        assert!(identity.ends_with(":unresolved"));
        assert_eq!(
            identity,
            format!("jsts:implements:src/a.ts:0:20:{source_identity_key}:unresolved")
        );
    }

    /// A relation whose target DOES resolve (an ordinary, already-interned
    /// entity) must be left completely untouched by the repair pass -- both
    /// its identity (still claiming the real target) and its `target_
    /// subject` (still `Some`).
    #[test]
    fn confirmed_call_to_a_resolved_target_is_left_untouched() {
        let source = entity_record("caller", "caller", "src/a.ts");
        let target = entity_record("callee", "callee", "src/b.ts");
        let source_identity_key = source.identity_key.clone();
        let target_identity_key = target.identity_key.clone();
        let relation = confirmed_relation(
            "call",
            &source_identity_key,
            &target_identity_key,
            "src/a.ts",
            0,
            20,
        );
        let owners = vec![
            owner_facts("src/a.ts", vec![source, relation]),
            owner_facts("src/b.ts", vec![target]),
        ];
        let materialized = materialize_cold(owners).expect("materialize_cold succeeds");
        let relation_record = materialized
            .records
            .iter()
            .find(|record| record.category == CATEGORY_RELATION)
            .expect("relation row present");
        assert!(relation_record.target_subject.is_some());
        let identity = std::str::from_utf8(&relation_record.identity_key).unwrap();
        assert_eq!(
            identity,
            format!("jsts:call:src/a.ts:0:20:{source_identity_key}:{target_identity_key}")
        );
    }

    /// P2-2m: deterministic xorshift64* PRNG, mirroring `urdira-structural-
    /// store`'s own test-only `common::Rng` (no external `rand` dependency
    /// needed here either) -- used only to size/pad the stress corpus
    /// below reproducibly across seeds.
    struct StressRng(u64);
    impl StressRng {
        fn new(seed: u64) -> Self {
            StressRng(seed.max(1))
        }
        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x.wrapping_mul(0x2545F491_4F6CDD1D)
        }
        fn below(&mut self, n: u64) -> u64 {
            if n == 0 { 0 } else { self.next_u64() % n }
        }
    }

    /// One owner's worth of synthetic records, each with a RANDOM-length
    /// identity/body padding string (8..4096 bytes) -- deliberately varied
    /// so a big owner's cumulative body-byte volume crosses `urdira_native_
    /// core::MAX_BATCH_FRAMED_BYTES` at an unpredictable record boundary
    /// (never a round number), exercising `kernel_rows_batches`'s
    /// `rayon::join` bisection with odd, size-driven split points -- not
    /// just the round-number, record-count-driven bisection a fixed-size
    /// corpus would always hit at the same index.
    fn stress_owner(owner_index: usize, records_per_owner: usize, seed: u64) -> OwnerFacts {
        let mut rng = StressRng::new(seed);
        let path = format!("src/stress_{owner_index}.ts");
        let records = (0..records_per_owner)
            .map(|record_index| {
                let pad_len = 8 + rng.below(4096) as usize;
                let pad: String = (0..pad_len)
                    .map(|i| char::from(b'a' + ((i as u64 + rng.next_u64()) % 26) as u8))
                    .collect();
                // Globally unique per (owner, record): guarantees every
                // identity_key this test writes is distinguishable from
                // every other, so a corrupted (all-zero, or any other
                // wrong-content) row is caught by exact-set comparison,
                // not just a length/emptiness check.
                let identity_key = format!(
                    "jsts:variable:{path}:{record_index}:stress_{owner_index}_{record_index}_{pad}"
                );
                entity_record(&identity_key, &format!("n{record_index}"), &path)
            })
            .collect();
        owner_facts(&path, records)
    }

    /// P2-2m root-cause regression test: `materialize_cold_partitioned` ->
    /// `SegmentWriter::write_base_partitioned` -> read-back via
    /// `StoreReader` must never lose or zero a single row's
    /// `identity_key`. This is the synthetic stress harness this task's
    /// evidence doc calls for (200k records, 200 iterations, all 16
    /// nibble partitions exercised) -- `#[ignore]`d because at that scale
    /// it is a multi-minute run even in `--release`; a normal `cargo test`
    /// pass does not need to pay for it every time. Run explicitly with:
    /// `cargo test --release -p urdira-indexing-worker --bin
    /// urdira-indexing-worker v4::materialize::tests::
    /// materialize_write_read_roundtrip_never_loses_an_identity_key --
    /// --ignored --nocapture`. Record/iteration counts are overridable via
    /// `URDIRA_V4_STRESS_RECORDS`/`URDIRA_V4_STRESS_ITERATIONS` (used by
    /// this task's own evidence doc to first validate the harness cheaply
    /// before committing to the full 200k x 200 run).
    #[test]
    #[ignore]
    fn materialize_write_read_roundtrip_never_loses_an_identity_key() {
        let total_records: usize = std::env::var("URDIRA_V4_STRESS_RECORDS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(200_000);
        let iterations: usize = std::env::var("URDIRA_V4_STRESS_ITERATIONS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(200);
        // 24 owners so several land in the same top-nibble-of-record_id
        // bucket by chance (16 partitions) and at least a few owners need
        // 4+ `kernel_rows_batches` bisections at 200k/24 ≈ 8,333 records
        // each (> 2 * MAX_BATCH_RECORDS).
        let owner_count = 24usize;
        let records_per_owner = total_records.div_ceil(owner_count);

        for iteration in 0..iterations {
            let seed = 0x5EED_0000_u64 + iteration as u64;
            let owners: Vec<OwnerFacts> = (0..owner_count)
                .map(|owner_index| {
                    stress_owner(
                        owner_index,
                        records_per_owner,
                        seed ^ ((owner_index as u64) << 32).wrapping_add(1),
                    )
                })
                .collect();
            let expected_identity_keys: FxHashSet<Vec<u8>> = owners
                .iter()
                .flat_map(|owner| owner.records.iter())
                .map(|record| record.identity_key.clone().into_bytes())
                .collect();
            let expected_count = expected_identity_keys.len();
            assert_eq!(
                expected_count,
                owner_count * records_per_owner,
                "iteration {iteration}: every generated identity_key must be globally unique \
                 (otherwise this test can't tell a lost row from a legitimate duplicate)"
            );

            let materialized = materialize_cold_partitioned(owners)
                .expect("materialize_cold_partitioned succeeds");
            assert_eq!(
                materialized.partitions.len(),
                N_NIBBLES,
                "iteration {iteration}: must produce exactly N_NIBBLES partitions"
            );
            let materialized_row_count: usize = materialized.partitions.iter().map(Vec::len).sum();
            assert_eq!(
                materialized_row_count, expected_count,
                "iteration {iteration}: materialize must not drop or duplicate rows"
            );
            for (nib, partition) in materialized.partitions.iter().enumerate() {
                for row in partition {
                    assert_eq!(
                        nibble_of(&row.record_id),
                        nib,
                        "iteration {iteration}: row landed in the wrong nibble partition"
                    );
                    assert!(
                        !row.identity_key.is_empty(),
                        "iteration {iteration}: identity_key must never be empty for a stress \
                         entity row (record_id={:?})",
                        row.record_id
                    );
                    assert!(
                        !row.identity_key.iter().all(|&byte| byte == 0),
                        "iteration {iteration}: identity_key corrupted to all-zero bytes \
                         (len={}, record_id={:?}) -- this is exactly the P2-2m corruption \
                         signature",
                        row.identity_key.len(),
                        row.record_id,
                    );
                }
            }

            let dir = std::env::temp_dir().join(format!(
                "urdira-v4-stress-{}-{}-{iteration}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create stress dir");
            urdira_structural_store::SegmentWriter::new()
                .write_base_partitioned(&dir, &materialized.partitions, &[], &materialized.dicts, 1)
                .expect("write_base_partitioned succeeds");

            let reader =
                urdira_structural_store::StoreReader::open(&dir).expect("StoreReader opens");
            let mut read_back_count = 0usize;
            let mut read_back_identity_keys: FxHashSet<Vec<u8>> = FxHashSet::default();
            for view in reader.iter_visible(1) {
                read_back_count += 1;
                let identity_key = view.identity_key().to_vec();
                assert!(
                    !identity_key.is_empty(),
                    "iteration {iteration}: read-back identity_key must never be empty \
                     (record_id={:?})",
                    view.record_id()
                );
                assert!(
                    !identity_key.iter().all(|&byte| byte == 0),
                    "iteration {iteration}: read-back identity_key corrupted to all-zero \
                     bytes (len={}, record_id={:?})",
                    identity_key.len(),
                    view.record_id(),
                );
                read_back_identity_keys.insert(identity_key);
            }
            assert_eq!(
                read_back_count, expected_count,
                "iteration {iteration}: StoreReader must see exactly the rows written"
            );
            assert_eq!(
                read_back_identity_keys, expected_identity_keys,
                "iteration {iteration}: the read-back identity_key SET must exactly match \
                 the generated one -- any mismatch here is a lost/corrupted/duplicated row"
            );

            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
