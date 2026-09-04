//! Owned, in-memory row shapes handed to [`crate::writer::SegmentWriter`]
//! and returned (borrowed, as [`crate::reader::RecordView`]) from
//! [`crate::reader::StoreReader`].

pub const NONE_U32: u32 = u32::MAX;
pub const NONE_U16: u16 = u16::MAX;
pub const ZERO32: [u8; 32] = [0u8; 32];

pub const CATEGORY_ENTITY: u8 = 0;
pub const CATEGORY_RELATION: u8 = 1;
pub const CATEGORY_DIAGNOSTIC: u8 = 2;

/// One structural record row (an entity or a relation occurrence), v4
/// shape. Category/kind/facets/span/identity/body fields per plan §2.2;
/// `source_subject`/`target_subject`/`relation_kind_id` are populated only
/// for relation rows (there is no separate edge table on this route --
/// adjacency is an index over relation records, per the task brief).
#[derive(Clone, Debug)]
pub struct RecordRow {
    pub record_id: [u8; 32],
    pub owner_artifact: u32,
    pub owner_version: u32,
    pub valid_from: u32,
    pub valid_to: u32, // 0 == open
    pub category: u8,
    pub kind_id: u16,
    pub universal_kind_id: u16,
    pub facets: u64,
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
    pub source_subject: Option<u32>,  // ordinal into Dictionaries::subjects
    pub target_subject: Option<u32>,
    pub relation_kind_id: u16, // NONE_U16 if not a relation
    pub body: Vec<u8>,
}

impl RecordRow {
    pub fn name_id_opt(&self) -> Option<u32> {
        (self.name_id != NONE_U32).then_some(self.name_id)
    }
}

/// One artifact-dependency row. `dependency_id` is a stable 32-byte key
/// (analogous to `record_id`) so `closures.deps` can name a specific
/// dependency edge -- not present in the plan's §2.2 sketch of
/// `deps.meta`, added here because delta closures need a key to close
/// against; documented as an addition in the evidence doc.
#[derive(Clone, Debug)]
pub struct DependencyRow {
    pub dependency_id: [u8; 32],
    pub record: Option<u32>, // ordinal into this generation's records; None for the bare `record:` sentinel (v3 data quirk)
    pub owner_artifact: u32,
    pub owner_version: u32,
    pub dep_artifact: u32,
    pub dep_version: u32,
    pub role: u8,
    pub valid_from: u32,
    pub valid_to: u32,
}

/// Append-only dictionaries. Ordinals are stable across generations: a
/// delta only ever appends to these vectors (never reorders or removes),
/// so an ordinal minted in generation G remains valid forever.
#[derive(Default, Clone, Debug)]
pub struct Dictionaries {
    pub kinds: Vec<String>,
    pub universal_kinds: Vec<String>,
    pub relation_kinds: Vec<String>,
    pub names: Vec<String>,
    pub subjects: Vec<[u8; 32]>,
    /// (artifact_id, artifact_version_id) text pairs; catalog ids stay TEXT
    /// in SQLite per plan §2.2, this is just the ordinal <-> text mapping.
    pub artifacts: Vec<(String, String)>,
    /// P2-2e: facet name text, indexed by BIT INDEX (0 = the `1 << 0` bit
    /// of `RecordRow::facets`), NOT by first-seen append order like every
    /// other list above -- a bit's meaning is fixed by its position, so
    /// `facet_names[i]` is simply "whichever facet name a producer assigned
    /// bit `i`" (`urdira-indexing-worker`'s `FACET_ORDER` for the real v4
    /// pipeline). At most 64 entries (`facets` is a `u64` bitmask). Still
    /// append-only/stable across generations in the sense every other field
    /// here is: once bit `i` names a facet, it keeps that name forever --
    /// `suffix_from`/`append` below treat it exactly like the other lists
    /// (a later generation only ever grows it, from the end).
    pub facet_names: Vec<String>,
    /// P2-2e: subject-id TEXT, aligned 1:1 with `subjects` BY ORDINAL
    /// (`subject_text[i]` is `subjects[i]`'s human-readable form). The real
    /// v4 pipeline always writes `"record:<hex>"` here (`subjects[i]` is
    /// literally that referenced record's `record_id` bytes -- see
    /// `urdira-indexing-worker`'s `materialize_generation`), but this is
    /// its own text vector (not derived from `subjects` on read) so a
    /// future subject kind that is NOT simply its own digest's hex form has
    /// somewhere real to carry its text. May be SHORTER than `subjects`
    /// for a store whose earlier generations were written before this
    /// field existed -- a reader falls back to `"record:<hex(subjects[i])>"`
    /// for any ordinal beyond `subject_text`'s length (same convention the
    /// napi port's `subject_text_for` already uses for a v3-converted
    /// store's sidecar).
    pub subject_text: Vec<String>,
    /// A3a-fix: the REAL owner path text, aligned 1:1 BY ORDINAL with
    /// `artifacts` (`artifact_paths[i]` is `artifacts[i]`'s owner's actual
    /// `owner_path`, e.g. `"src/a.ts"` -- never the `(artifact_id,
    /// artifact_version_id)` digest pair `artifacts[i]` itself carries, and
    /// never derived from it: only the caller that minted the artifact
    /// (`urdira-indexing-worker`'s materialize pass) knows the real path).
    /// Populated by that caller alongside `artifacts` itself; this crate
    /// only stores/reads it back. May be SHORTER than `artifacts` for a
    /// store whose earlier generations predate this field (or a
    /// v3-converted store, which never populates it at all) -- a reader's
    /// `.get(ord)` returning `None` for such an ordinal is the intended
    /// "can't reconstruct, fall back to Raw" signal (`identity_codec::
    /// artifact_path`), never a bug.
    pub artifact_paths: Vec<String>,
    /// A3a-fix: the FINE per-declaration entity-kind word (`"function"`/
    /// `"class"`/`"method"`/`"getter"`/... -- `EntityKind::identity_name()`
    /// in `urdira-jsts-syntax-worker`) an entity row's identity string's
    /// `{kind}` segment actually uses, interned by ordinal. Unlike every
    /// other dictionary here, this one is populated ENTIRELY INSIDE this
    /// crate (`identity_codec::collect_new_entity_kinds`, called from
    /// `writer.rs`/`segment_io.rs` at write time) by parsing the fine word
    /// straight out of each entity row's OWN `identity_key` bytes -- no
    /// caller needs to (or can: `RecordRow`/`Dictionaries` carry no fine-
    /// grained kind field at all, only the coarse `UniversalKind`-bucketed
    /// `kind_id`) populate this field itself. New words are assigned
    /// ordinals in SORTED order among only the words new to this batch
    /// (never row-iteration order), so `write_base` and `write_base_
    /// partitioned` -- which see the same logical rows bucketed
    /// differently -- always assign identical ordinals to a given word
    /// (`write_base_partitioned_test.rs`'s byte-for-byte oracle depends on
    /// this). `records.meta`'s `ENTITY_KIND` byte (u8, 255 == none) indexes
    /// into this list; an ordinal that would not fit in a `u8` (>254,
    /// meaning >255 distinct fine words have ever been seen -- never
    /// happens in practice, the real vocabulary is under 20 words) simply
    /// is not tagged (`IDENTITY_LAYOUT_RAW`), same never-lose-correctness
    /// discipline every other classify-time guard in `identity_codec` uses.
    pub entity_kinds: Vec<String>,
}

pub const PENDING_SITE_KIND_CALL: u8 = 1;
pub const PENDING_SITE_KIND_INHERITS: u8 = 2;
pub const PENDING_SITE_KIND_IMPLEMENTS: u8 = 3;

/// One unresolved call/heritage site awaiting the residual tsgo pass --
/// the compact side-table counterpart of what used to be a full
/// `RecordRow` with `classification: "possible"` and no target. The
/// store never interprets `reason` (an opaque producer-assigned code);
/// its only consumers are the residual checker and this crate's own
/// tests.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingSiteRow {
    pub owner_artifact: u32,
    pub owner_version: u32,
    pub valid_from: u32,
    pub valid_to: u32, // 0 == open, same convention as RecordRow
    pub start: u32,    // UTF-16 code-unit offset, same convention as RecordRow::span_start_byte
    pub end: u32,
    pub start_line: u32,
    pub end_line: u32,
    pub site_kind: u8, // one of the PENDING_SITE_KIND_* constants
    pub reason: u8,
    pub source_subject: Option<u32>, // ordinal into Dictionaries::subjects
}

impl PendingSiteRow {
    /// This row's identity within a store: `(owner_artifact, start, end,
    /// site_kind)`. Field order matches [`PendingSiteKey`]'s own derived
    /// `Ord` exactly, which is also the on-disk sort order -- so sorting
    /// a slice of rows by `.key()` IS sorting them into on-disk order.
    pub fn key(&self) -> PendingSiteKey {
        PendingSiteKey {
            owner_artifact: self.owner_artifact,
            start: self.start,
            end: self.end,
            site_kind: self.site_kind,
        }
    }
}

/// Identity of one pending site within a store: `(owner_artifact, start,
/// end, site_kind)`. A key closes at most once per delta (mirrors
/// `record_id`/`dependency_id` for `closures.records`/`closures.deps`),
/// but -- unlike those two -- is not itself a stored digest: `closures.
/// pending` inlines the four identity fields directly (20-byte fixed
/// entries) rather than referencing a 32-byte key file, since there is no
/// `pending.keys` file to reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PendingSiteKey {
    pub owner_artifact: u32,
    pub start: u32,
    pub end: u32,
    pub site_kind: u8,
}

impl Dictionaries {
    /// The entries in `self` beyond what `base` already has, assuming
    /// `self` extends `base` by simple append (asserted by callers via
    /// `debug_assert` in the writer, not re-verified here).
    pub fn suffix_from(&self, base: &Dictionaries) -> Dictionaries {
        Dictionaries {
            kinds: self.kinds[base.kinds.len().min(self.kinds.len())..].to_vec(),
            universal_kinds: self.universal_kinds
                [base.universal_kinds.len().min(self.universal_kinds.len())..]
                .to_vec(),
            relation_kinds: self.relation_kinds
                [base.relation_kinds.len().min(self.relation_kinds.len())..]
                .to_vec(),
            names: self.names[base.names.len().min(self.names.len())..].to_vec(),
            subjects: self.subjects[base.subjects.len().min(self.subjects.len())..].to_vec(),
            artifacts: self.artifacts[base.artifacts.len().min(self.artifacts.len())..].to_vec(),
            facet_names: self.facet_names[base.facet_names.len().min(self.facet_names.len())..]
                .to_vec(),
            subject_text: self.subject_text[base.subject_text.len().min(self.subject_text.len())..]
                .to_vec(),
            artifact_paths: self.artifact_paths
                [base.artifact_paths.len().min(self.artifact_paths.len())..]
                .to_vec(),
            entity_kinds: self.entity_kinds[base.entity_kinds.len().min(self.entity_kinds.len())..]
                .to_vec(),
        }
    }

    pub fn append(&mut self, additions: &Dictionaries) {
        self.kinds.extend(additions.kinds.iter().cloned());
        self.universal_kinds
            .extend(additions.universal_kinds.iter().cloned());
        self.relation_kinds
            .extend(additions.relation_kinds.iter().cloned());
        self.names.extend(additions.names.iter().cloned());
        self.subjects.extend(additions.subjects.iter().copied());
        self.artifacts.extend(additions.artifacts.iter().cloned());
        self.facet_names
            .extend(additions.facet_names.iter().cloned());
        self.subject_text
            .extend(additions.subject_text.iter().cloned());
        self.artifact_paths
            .extend(additions.artifact_paths.iter().cloned());
        self.entity_kinds
            .extend(additions.entity_kinds.iter().cloned());
    }

    pub fn is_empty(&self) -> bool {
        self.kinds.is_empty()
            && self.universal_kinds.is_empty()
            && self.relation_kinds.is_empty()
            && self.names.is_empty()
            && self.subjects.is_empty()
            && self.artifacts.is_empty()
            && self.facet_names.is_empty()
            && self.subject_text.is_empty()
            && self.artifact_paths.is_empty()
            && self.entity_kinds.is_empty()
    }
}
