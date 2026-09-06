//! Persistent, content-keyed Oxc syntax analysis with no ambient source reads.

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingIdentifier, BindingPattern, CallExpression, Class, ClassType, Declaration,
    ExportAllDeclaration, ExportDefaultDeclaration, ExportDefaultDeclarationKind,
    ExportNamedDeclaration, ExportSpecifier, Expression, Function, FunctionType, ImportDeclaration,
    ImportDeclarationSpecifier, ImportExpression, ModuleExportName, Statement, TSEnumDeclaration,
    TSExportAssignment, TSGlobalDeclaration, TSInterfaceDeclaration, TSModuleDeclaration,
    TSModuleDeclarationBody, TSModuleDeclarationName, TSTypeAliasDeclaration, VariableDeclaration,
};
use oxc_ast_visit::{
    Visit,
    utf8_to_utf16::Utf8ToUtf16,
    walk::{
        walk_call_expression, walk_class, walk_export_all_declaration,
        walk_export_default_declaration, walk_export_named_declaration, walk_export_specifier,
        walk_function, walk_import_declaration, walk_import_expression, walk_ts_enum_declaration,
        walk_ts_export_assignment, walk_ts_global_declaration, walk_ts_interface_declaration,
        walk_ts_module_declaration, walk_ts_type_alias_declaration, walk_variable_declaration,
    },
};
use oxc_parser::Parser;
use oxc_span::SourceType;
use oxc_syntax::scope::ScopeFlags;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use urdira_worker_protocol::{
    AuthoritativeChangeSet, MAX_FRAME_CHUNK_BYTES, MAX_MESSAGE_BYTES, PROTOCOL_IDENTITY,
    PROTOCOL_VERSION,
};

mod line_index;
mod resolver;
mod semantic_sites;
pub use line_index::LineIndex;
pub use resolver::{
    AmbientModuleIndex, ConfigAsset, ExportPolicy, ExportResolution, WorkspaceResolver,
    resolve_named_export,
};
pub use semantic_sites::{
    HybridResolutionContext, OwnerSemantics, PendingReasonCode, PendingSiteKind,
    PendingSiteProposal, REASON_HERITAGE_UNRESOLVED, REASON_TARGET_NOT_INTERNED, SemanticSite,
    SiteDisposition, SiteKind, TypeflowOracleHit, ambiguous_ambient_would_be_external_count,
    analyze_owner_semantics, analyze_owner_semantics_with_context,
    reset_ambiguous_ambient_would_be_external_count,
};

pub const WORKER_BUILD_IDENTITY: &str = "urdira:jsts-syntax-worker:0.3.0+oxc-0.142.0.fact-groups-v1.protobuf-v3.authoritative-changes-v1.bounded-row-identities-v1.definition-syntax-v1";
const MAX_FACT_OUTPUT_BYTES: u32 = 4 * 1024 * 1024;
const MAX_FACT_ROWS: u32 = 4096;
const MAX_FACT_GROUP_OUTPUT_BYTES: u32 = 16 * 1024 * 1024;
const MAX_FACT_GROUP_OWNERS: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostMessage {
    Handshake {
        request_id: String,
        protocol_identity: String,
        protocol_version: u8,
        expected_worker_build_identity: String,
        max_frame_chunk_bytes: u32,
        max_message_bytes: u32,
    },
    Analyze {
        request_id: String,
        cancellation_id: String,
        project_key: String,
        configuration_digest: String,
        root_names: Vec<String>,
        files: Vec<SourceInput>,
        change_set: AuthoritativeChangeSet,
        budgets: AnalysisBudgets,
        /// Resolution-relevant workspace assets (E2, F5 hybrid design):
        /// `package.json`, `tsconfig.json`/`jsconfig.json`,
        /// `pnpm-workspace.yaml`. Defaulted so a caller/oracle transport
        /// built before E2 (and every existing test fixture) still decodes;
        /// an absent/empty list makes `WorkspaceResolver` behave exactly
        /// like the pre-E2 relative-only resolver.
        #[serde(default)]
        config_assets: Vec<ConfigAssetInput>,
    },
    ReadFacts {
        request_id: String,
        cancellation_id: String,
        project_key: String,
        path: String,
        cursor: Option<FactsCursor>,
        max_output_bytes: u32,
        max_rows: u32,
    },
    ReadFactsGroup {
        request_id: String,
        cancellation_id: String,
        project_key: String,
        entries: Vec<FactsGroupEntry>,
        max_output_bytes: u32,
        max_rows: u32,
    },
    CommitAnalysis {
        request_id: String,
        project_key: String,
        analysis_token: String,
    },
    Cancel {
        request_id: String,
        cancellation_id: String,
    },
    Reset {
        request_id: String,
        project_key: Option<String>,
    },
    Shutdown {
        request_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceInput {
    pub path: String,
    pub artifact_id: String,
    pub artifact_version_id: String,
    pub content_digest: String,
    pub source_blob_path: String,
    pub byte_length: usize,
}

/// A resolution-relevant workspace asset (E2): `package.json`,
/// `tsconfig.json`/`jsconfig.json`, or `pnpm-workspace.yaml`. Mirrors
/// `SourceInput`'s content-addressed blob-path shape (no artifact
/// id/version: these files are never analyzed as owners or published as
/// facts, only consumed to build a `WorkspaceResolver`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigAssetInput {
    pub path: String,
    pub content_digest: String,
    pub source_blob_path: String,
    pub byte_length: usize,
}

/// Explicit `serde(default = ...)` target for `AnalysisBudgets::
/// enforce_output_bytes`. A bare `#[serde(default)]` would resolve to
/// `bool::default()` (`false`), silently disabling the `max_output_bytes`/
/// `MAX_MESSAGE_BYTES` guard in `SyntaxWorkerState::analyze` for every
/// caller whose envelope predates this field -- including the stdio
/// binary's IPC path, where the guard also keeps this worker's internal
/// state in sync with the frame actually sent to the host. Named so every
/// deserialization of a `budgets` object missing the field keeps the guard
/// ON unless a caller opts out explicitly.
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnalysisBudgets {
    pub max_output_bytes: u32,
    pub max_files: u32,
    pub max_source_bytes: u32,
    /// When `true` (the default, including for any pre-existing envelope
    /// that never sent this field), `analyze` serializes its response to
    /// measure it against `max_output_bytes`/`MAX_MESSAGE_BYTES` before
    /// committing the new project state, exactly as it always has.
    /// In-process Rust->Rust callers that never go over the wire (v3's
    /// `run_jsts_generation`, v4's `run_cold`) set this to `false` to skip
    /// that serialize-and-discard pass entirely -- there is no frame size
    /// to bound and no desync risk since nothing is sent anywhere.
    #[serde(default = "default_true")]
    pub enforce_output_bytes: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FactsGroupEntry {
    pub path: String,
    pub cursor: Option<FactsCursor>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkerMessage {
    HandshakeAck {
        request_id: String,
        protocol_identity: &'static str,
        protocol_version: u8,
        worker_build_identity: &'static str,
        max_frame_chunk_bytes: u32,
        max_message_bytes: u32,
    },
    AnalysisResult {
        request_id: String,
        cancellation_id: String,
        project_key: String,
        analysis_token: String,
        build: BuildKind,
        #[serde(skip_serializing_if = "Option::is_none")]
        reset_reason: Option<ResetReason>,
        changed_files: Vec<String>,
        affected_files: Vec<String>,
        metrics: BoundaryMetrics,
    },
    FactsResult {
        request_id: String,
        cancellation_id: String,
        project_key: String,
        path: String,
        content_digest: String,
        language: Language,
        script_kind: ScriptKind,
        byte_length: usize,
        parsed: bool,
        direct_imports: Vec<DirectImport>,
        records: Vec<ProposedRecord>,
        dependencies: Vec<ProposedRecordDependency>,
        diagnostics: Vec<SyntaxDiagnostic>,
        #[serde(skip_serializing_if = "Option::is_none")]
        next_cursor: Option<FactsCursor>,
        metrics: FactsTransferMetrics,
    },
    FactsGroupResult {
        request_id: String,
        cancellation_id: String,
        project_key: String,
        pages: Vec<WorkerMessage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        next_request_index: Option<usize>,
        metrics: FactsTransferMetrics,
    },
    CommitAnalysisAck {
        request_id: String,
        project_key: String,
        analysis_token: String,
    },
    CancelAck {
        request_id: String,
        cancellation_id: String,
    },
    Cancelled {
        request_id: String,
        cancellation_id: String,
    },
    ResetAck {
        request_id: String,
        reset_projects: usize,
    },
    ShutdownAck {
        request_id: String,
    },
    Error {
        request_id: String,
        code: ErrorCode,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BuildKind {
    Full,
    Incremental,
    Unchanged,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResetReason {
    Initial,
    RootSetChanged,
    ConfigurationChanged,
    FileSetChanged,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    ProtocolInvalid,
    HandshakeRequired,
    BuildIdentityMismatch,
    WorkerBusy,
    ResourceExhausted,
    SourceDigestMismatch,
    UnsupportedSource,
    AnalysisFailed,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct BoundaryMetrics {
    pub bytes_read: u64,
    pub bytes_transferred: u64,
    pub bytes_copied: u64,
    pub bytes_decoded: u64,
    pub bytes_retained: u64,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FactsCursor {
    pub imports_offset: usize,
    pub records_offset: usize,
    pub dependencies_offset: usize,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct FactsTransferMetrics {
    pub bytes_transferred: u64,
    pub bytes_copied: u64,
}

/// A3b: a record's `body`, either the pre-existing `serde_json::Value` tree
/// (`Value` -- every not-yet-migrated producer, and every test helper) or an
/// already-[`urdira_native_core::BodyEncoder`]-built payload (`Encoded` --
/// every migrated hot-path producer, skipping the tree entirely). `PartialEq`/
/// `Eq` are derived: `Value` compares structurally as before, `EncodedBody`
/// derives `PartialEq`/`Eq` over its own `payload`/`body_digest`/
/// `body_byte_length` fields.
///
/// `Serialize` is hand-written rather than derived so this enum's JSON shape
/// is IDENTICAL to a plain `Value`'s -- `serde_json::to_string(&ProposedRecord)`
/// (the shape that travels over IPC to the daemon on the v3/checker path, and
/// in `AnalysisResponse`) must not change no matter which variant a given
/// record carries: `Value` serializes directly, `Encoded` streams its
/// payload straight into the serializer via
/// [`urdira_native_core::serialize_payload`] -- NOT `decode_body` then
/// `value.serialize(serializer)` (that decode-to-`Value`-then-reserialize
/// round trip was `SyntaxWorkerState::analyze`'s single largest per-record
/// cost on the v4 hot path, where every record's body is `Encoded`; see
/// `serialize_payload`'s own doc comment). See `encoded_body_serializes_
/// identically_to_a_plain_value_body` (this crate's tests) for the
/// byte-for-byte proof.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordBody {
    Value(serde_json::Value),
    Encoded(urdira_native_core::EncodedBody),
}

impl RecordBody {
    /// Borrows this body into the [`urdira_native_core::BodyRef`] the
    /// structural kernel accepts, without cloning/converting either variant.
    pub fn as_body_ref(&self) -> urdira_native_core::BodyRef<'_> {
        match self {
            RecordBody::Value(value) => urdira_native_core::BodyRef::Value(value),
            RecordBody::Encoded(encoded) => urdira_native_core::BodyRef::Encoded(encoded),
        }
    }

    /// Returns this body as an owned `serde_json::Value`, decoding an
    /// `Encoded` payload on demand (`urdira_native_core::decode_body`).
    /// Convenience for callers that only need occasional/one-off reads --
    /// this crate's own tests, and the v3/legacy `run_jsts_generation` path
    /// in `urdira-indexing-worker::main` -- never the v4 hot path, which
    /// reads `source_id`/`target_id` off `ProposedRecord`'s own dedicated
    /// fields instead of decoding a body at all. Panics if `payload` is
    /// somehow not a valid encoding, which would mean this crate's own
    /// `BodyEncoder` usage produced an invalid payload -- a producer bug,
    /// not a data-dependent error.
    pub fn to_value(&self) -> serde_json::Value {
        match self {
            RecordBody::Value(value) => value.clone(),
            RecordBody::Encoded(encoded) => urdira_native_core::decode_body(&encoded.payload)
                .expect("BodyEncoder-produced payload always decodes"),
        }
    }
}

impl Serialize for RecordBody {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            RecordBody::Value(value) => value.serialize(serializer),
            RecordBody::Encoded(encoded) => {
                urdira_native_core::serialize_payload(&encoded.payload, serializer)
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProposedRecord {
    pub proposal_record_key: String,
    pub category: &'static str,
    pub kind: String,
    pub universal_kind: String,
    pub facets: String,
    pub schema_version: u8,
    pub source_span: String,
    /// A4 (line numbers task, 2026-09-05): 1-based line numbers for the SAME
    /// offsets `source_span` already encodes -- deliberately NOT folded into
    /// `source_span` itself (a plain, additive field here instead), because
    /// `source_span`'s canonical-JSON text enters the record digest
    /// (`urdira-native-core::structural_record_digest_hash`) and a line
    /// number must never perturb an existing record's identity/digest.
    /// `0` means "no line known" -- either this record's span is synthetic
    /// (e.g. an external-package entity's `start`/`end` are both `0` with no
    /// real file backing them) or the producing file's own [`LineIndex`]
    /// was not available at the call site. Every real producer fills these
    /// from `LineIndex::line_of` on the SAME UTF-16 offsets `source_span`
    /// was built from -- see [`SyntaxFileResult::line_index`]'s own doc
    /// comment for why that index is always for the OWNER file, never the
    /// span's own `path` when those two differ (a cross-file relation's span
    /// is always on the owning file, so they never differ for a relation;
    /// only a synthetic external entity ever has a `path` unequal to any
    /// real owner, and that case is exactly the `0` one above).
    pub span_start_line: u32,
    pub span_end_line: u32,
    pub identity_key: String,
    pub body: RecordBody,
    /// A3b: a relation's `body.source_id`/`.target_id` (the referenced
    /// entity's `identity_key`), carried alongside `body` so a reader that
    /// only needs the endpoints (`urdira-indexing-worker::v4::materialize`'s
    /// `relation_endpoints_from_body`) never has to decode an `Encoded`
    /// body just to pull two strings back out of it. Every producer that
    /// puts `source_id`/`target_id` into its body sets these to the exact
    /// same values; an entity record (no endpoints at all) leaves both
    /// `None`. A `Value`-bodied record's endpoints can still be read from
    /// the body itself (unchanged reader path) -- these fields are purely
    /// additive, never the only source of truth for a `Value` body.
    pub source_id: Option<String>,
    pub target_id: Option<String>,
    pub evidence_references: String,
    /// P2-2l item 2: the exact, already-deduplicated facet list `facets`
    /// (the canonical-JSON TEXT field above) was built from, carried
    /// alongside it. Every producer in this crate (`lib.rs`'s two,
    /// `semantic_sites.rs`'s seven) derives this from the SAME
    /// `serde_json::Value` it feeds to `canonical_json` for `facets`
    /// itself (see [`facets_list_from_value`]), so the two fields can
    /// never drift from each other. Exists so `urdira-indexing-worker`'s
    /// v4 hot path (`urdira_native_core::structural_kernel_rows_typed`)
    /// can skip re-parsing `facets` back out of its own canonical JSON
    /// text -- see that function's doc comment for why that round trip is
    /// provably a no-op for every producer here.
    pub facets_list: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProposedRecordDependency {
    pub proposed_dependency_id: String,
    pub proposal_record_key: String,
    pub dependency_artifact_id: String,
    pub dependency_artifact_version_id: String,
    /// The dependency target's raw path (P3-2 item 3, additive field):
    /// `urdira-indexing-worker::v4::deps` needs this, not
    /// `dependency_artifact_id`/`dependency_artifact_version_id`, to build
    /// a `dependency_id` comparable across independent scans -- see
    /// `resolved_dependencies`'s doc comment for why the artifact
    /// id/version pair is NOT stable across scans of identical content
    /// (workspace_id and generation salting) while the raw path is.
    pub dependency_target_path: String,
    pub dependency_role: &'static str,
    pub dependency_basis: &'static str,
    pub source_reference: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SyntaxFileResult {
    pub path: String,
    pub content_digest: String,
    pub language: Language,
    pub script_kind: ScriptKind,
    pub byte_length: usize,
    pub parsed: bool,
    pub direct_imports: Vec<DirectImport>,
    pub entities: Vec<SyntaxEntity>,
    pub relations: Vec<SyntaxRelation>,
    pub diagnostics: Vec<SyntaxDiagnostic>,
    /// Named-export bindings this module exposes (E2, F5 hybrid design):
    /// used by the hybrid lane's `resolver::resolve_named_export` to close
    /// an import -> export -> declaration chain across files. Deliberately
    /// narrower than `entities`: only a declaration reachable through a
    /// real `export` (direct `export function/class/const/interface/type/
    /// enum`, sourceless `export { a, b as c }`, or a named re-export
    /// `export { a } from "./x"`) is captured here -- `export default` is
    /// never captured (see `resolver.rs`'s module doc for why) and a bare
    /// `export * from "./x"` (no `as X`) is captured SEPARATELY, in
    /// `export_star_specifiers` below, not here -- so a lookup that only
    /// exists through one of those two still misses `export_bindings`
    /// itself and stays `checker_pending` upstream, never wrongly resolved,
    /// but a name reachable only through a plain `export *` barrel now has
    /// a second, bounded chance via `export_star_specifiers` (2026-09-04
    /// references-parity task, bucket 2 -- see `resolver::resolve_named_
    /// export_inner`'s own doc comment for the exact algorithm).
    pub export_bindings: Vec<SyntaxExportBinding>,
    /// 2026-09-04 references-parity task, bucket 2 (`import_binding`/
    /// `re_export_binding`, multi-hop barrels): every bare `export * from
    /// "./x"` this module has (no `as X` -- THAT form already gets a
    /// `SyntaxExportBinding` with the `NAMESPACE_REEXPORT_LOCAL_NAME`
    /// sentinel, see its own doc comment, and is NOT duplicated here).
    /// `resolver::resolve_named_export_inner` consults this list, AFTER its
    /// own `export_bindings` lookup for a name comes up empty, to chase the
    /// name through each star target -- but ONLY when resolving the name
    /// through this module's star re-exports lands on exactly one
    /// candidate module (never a guess when two star targets could both
    /// plausibly provide the same name, mirroring real ESM's own "ambiguous
    /// export" restriction). Resolved the same way `DirectImport::
    /// target_path`/`SyntaxExportBinding::source_target_path` are.
    pub export_star_specifiers: Vec<ExportStarSpecifier>,
    /// Ambient module resolution task (2026-09-04): every top-level
    /// `declare module "specifier" { ... }` / `declare module "specifier";`
    /// this file declares (a `TSModuleDeclaration` whose `id` is a STRING
    /// LITERAL -- an ordinary `namespace X {}`/`declare namespace X {}`,
    /// whose `id` is an `Identifier`, is NOT one of these: it names a local
    /// binding, never a module specifier another file's `import`/`export
    /// ... from` could target). Consulted by `resolver::AmbientModuleIndex`
    /// (workspace-wide, built from every file's own list) so a bare
    /// specifier that fails ordinary workspace-file resolution gets a
    /// chance to resolve through one of these BEFORE `resolver::classify_
    /// external_specifier`'s external-entity fallback fires -- see that
    /// module's own doc comment for the exact rule and `docs/evidence/
    /// 2026-09-04-v4-ambient-module-resolution.md` for the n8n regression
    /// this closes (677 `v4_different_target` reference-parity rows, all
    /// resolving externally where v3 resolved to a declaration inside one
    /// of these).
    pub ambient_modules: Vec<AmbientModuleDeclaration>,
    /// D.1 (2026-09-05, references-parity task): every top-level ambient
    /// GLOBAL-scope declaration this file contributes to the workspace-wide
    /// `resolver::AmbientModuleIndex::globals` lookup -- a `namespace X`/
    /// `declare namespace X`/`interface X`/`type X`/`declare var|let|const|
    /// function|class|enum X` at this file's OWN top level (a SCRIPT file
    /// only -- see `AmbientGlobalDeclaration::scope`'s own doc comment for
    /// why `ScriptTopLevel` candidates are dropped post-walk for a MODULE
    /// file, in `parse_source`, right next to `ambient_modules`' own
    /// `is_augmentation` patch), or a declaration directly inside a
    /// `declare global { ... }` block (valid regardless of script-vs-module,
    /// collected during the walk by `SyntaxCollector::visit_ts_global_
    /// declaration`). Closes `unresolved_global × namespace` reference-
    /// parity gap (`jest.Mock`/`globalThis.X` referencing a `.d.ts` script's
    /// `namespace jest {}`, `docs/evidence/2026-09-05-v4-frentes-1-2-3-4-
    /// reopen-references-analyze-residual.md` §10.7): `resolve_identifier_
    /// reference` had no cross-file table of globals to consult at all
    /// before this task -- every unresolved-scope `IdentifierReference`
    /// degraded straight to `REASON_UNRESOLVED_GLOBAL`, permanently.
    /// `entity_id` is NEVER a new entity: it is the EXACT SAME `stable_
    /// entity_id` formula the ordinary recursive walk already used to give
    /// this SAME declaration its own `SyntaxEntity` (this list is purely a
    /// workspace-wide NAME lookup fact pointing at an entity that exists
    /// either way).
    pub ambient_globals: Vec<AmbientGlobalDeclaration>,
    /// D.3 (2026-09-05, references-parity task): every DIRECT `export`
    /// member of a LOCAL (`Identifier`-named, NEVER the string-literal
    /// ambient-module shape -- see `visit_ts_module_declaration`'s own doc
    /// comment for why the two are disjoint) `namespace X { ... }`/
    /// `declare namespace X { ... }` block this file declares --
    /// `A.B`/`A.B.C` qualified-name resolution (`resolver::AmbientModuleIndex
    /// ::resolve_namespace_member_by_name`, consulted by `semantic_sites.rs`'s
    /// `resolve_qualified_namespace_path`) needs a workspace-wide "what does
    /// THIS namespace export under THIS name" table, which nothing before
    /// this task built (`declaration_export_names`/`export_bindings` only
    /// ever answer "what does a FILE export", never "what does a namespace
    /// BLOCK export"). Reuses `ambient_module_members`'s own exported-name
    /// extraction verbatim -- same "only a real `export` keyword makes a
    /// member visible to a qualified-name lookup from outside the block"
    /// rule TypeScript itself enforces, same shape (`name`, `entity_id`)
    /// `AmbientModuleDeclaration::members` already uses for the string-
    /// literal case.
    pub namespace_members: Vec<NamespaceMember>,
    /// A4 (line numbers task, 2026-09-05): this file's own UTF-16-code-unit
    /// line index, built ONCE per parse (`LineIndex::from_text`, over the
    /// SAME original UTF-8 `text` `Utf8ToUtf16::convert_program` already
    /// converts spans against) and carried here so every `ProposedRecord`
    /// producer that owns a span on THIS file -- every one of `entities`/
    /// `relations` except a synthetic external-package entity, whose `path`
    /// is `external:{specifier}`, never this file's own path -- can turn its
    /// `start`/`end` into 1-based `span_start_line`/`span_end_line` without
    /// re-scanning the file. `reresolve_file`/`reresolve_ambient_relations`
    /// (T1 incremental re-resolution) never touch this file's own byte
    /// content, only import/export target-path resolution, so both simply
    /// carry the ORIGINAL parse's `line_index` forward unchanged rather than
    /// rebuilding it. n8n-scale cost: ~2M lines workspace-wide, 4 bytes per
    /// line entry, ~8 MB resident total -- accepted (owner-approved design,
    /// `~/.claude/plans/happy-noodling-nygaard.md` §A4).
    pub line_index: LineIndex,
}

/// One `declare module "specifier" { ... }` / `declare module "specifier";`
/// block, as a structural fact independent of any particular importer.
/// `namespace_entity_id` is ALWAYS populated (v3's own `addEntity` gives the
/// `TSModuleDeclaration` node itself a `"namespace"`-kind entity regardless
/// of whether it has a body -- `isModuleDeclaration(node)` never checks
/// `node.body`), but only usable as an IMPORT's resolution target when
/// `bodyful` -- see `resolver::AmbientModuleIndex::resolve_export`'s own
/// doc comment for why a shorthand (bodyless) block's own entity still
/// exists in the corpus but is never a named/default/namespace import's
/// resolved target (fix item 3: TS treats a shorthand ambient module as
/// `any`, so the checker never provides a declaration for the checker's own
/// `entityByNode` lookup to land on either -- mirrored here as "stay
/// pending", not "resolve to the block itself").
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AmbientModuleDeclaration {
    pub specifier: String,
    pub bodyful: bool,
    /// Owner-flagged follow-up (2026-09-04, same day as the rest of this
    /// task): TypeScript distinguishes an AMBIENT MODULE DECLARATION
    /// (`declare module "x" { ... }` in a SCRIPT file -- one with NO
    /// top-level `import`/`export` syntax of its own, e.g. `env.d.ts`'s
    /// `declare module "~icons/*"`) from a MODULE AUGMENTATION (the exact
    /// same syntax, but in a file that IS a module -- has at least one
    /// top-level `import`/`export`/`export =` statement, e.g. a Vue/Pinia
    /// `declare module "vue" { interface ComponentCustomProperties {...}
    /// }` alongside a top-level `import`/`export {}`). An augmentation
    /// EXTENDS an existing external package's own type surface; it never
    /// stands in for the package's real declaration, so it must NEVER
    /// enter `resolver::AmbientModuleIndex` (found live: n8n's Vue
    /// frontend has many of these, one per file that augments `vue`/
    /// `pinia`/`n8n-workflow`/...; treating every one as a genuine
    /// ambient declaration made those specifiers workspace-"ambiguous"
    /// under the multiple-declaring-files rule, silently reverting every
    /// `vue`/`pinia`-style import back to pending -- a ~120K reference
    /// regression, caught in review before this task shipped). Computed
    /// PER FILE (uniform across every `declare module` block that file
    /// contains -- see `parse_source`'s own post-walk patch) since
    /// TypeScript's own script-vs-module classification is a whole-file
    /// property, not a per-block one. Still emits its own namespace entity
    /// either way (v3 parity, `push_namespace_entity`'s own doc comment) --
    /// only RESOLUTION is gated on this flag, never entity emission.
    pub is_augmentation: bool,
    pub namespace_entity_id: String,
    /// Every top-level member this block directly `export`s (`export
    /// function`/`class`/`interface`/`type`/`enum`/`const`/`let`/`var`) --
    /// deliberately narrower than v3's own `collect`, which walks the WHOLE
    /// block recursively and gives every declaration (exported or not) an
    /// entity: a non-exported member is invisible to an IMPORTER by
    /// construction, so it is never worth carrying here (this list exists
    /// purely to answer "what does a named import of this specifier
    /// resolve to", never to enumerate every entity the block contains --
    /// those are already published by the ordinary `push_entity`/`visit_*`
    /// producers, which fire for every declaration regardless of nesting
    /// inside an ambient block, unaffected by this task). A sourceless
    /// re-export specifier form (`export { a }`, no `source`, naming a
    /// declaration written WITHOUT its own `export` keyword elsewhere in
    /// the same block) is deliberately NOT walked -- rare inside a
    /// `declare module` block in practice, and never a guess.
    pub members: Vec<AmbientModuleMember>,
    /// `export default <nameable-decl>` inside the block, when present --
    /// same restricted, nameable-only shape `visit_export_default_
    /// declaration` (lib.rs, file-level) already uses: a named function/
    /// class/interface declaration, or a bare identifier naming another
    /// member already collected into `members` above. `export = X` (a
    /// separate TS construct entirely, CommonJS-style) is deliberately NOT
    /// treated as a default-import target here -- out of this task's
    /// explicit scope (see the fix's own task description); a default
    /// import of an `export =`-only ambient module stays pending, never a
    /// guess.
    pub default_member: Option<AmbientModuleMember>,
}

/// One member fact inside an [`AmbientModuleDeclaration`] -- `entity_id` is
/// already the FULLY BUILT id (`stable_entity_id(kind, declaring_path,
/// name_start, name)`), byte-identical to the id the SAME declaration's own
/// ordinary `push_entity` call already publishes elsewhere in this file's
/// `entities` list (member ids never depend on nesting/nesting depth --
/// only `(kind, path, name_start, name)` -- see `AmbientModuleDeclaration`'s
/// own doc comment), so storing it pre-built here avoids re-deriving it
/// (and re-threading `kind`/`name_start`) at every resolution call site.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AmbientModuleMember {
    pub name: String,
    pub entity_id: String,
}

/// D.1 (2026-09-05, references-parity task): where an [`AmbientGlobalDeclaration`]
/// was found. `ScriptTopLevel` candidates are collected during the walk
/// (`script_top_level_ambient_global_candidates`) but only kept when
/// `parse_source`'s own post-walk `file_has_top_level_module_syntax` check
/// confirms the file has NO top-level `import`/`export` of its own -- a
/// SCRIPT's top level genuinely extends the shared global scope (that is
/// what makes a `.d.ts` without any `import`/`export` an ambient
/// declaration file at all), while the identically-shaped declaration in a
/// MODULE file is scoped to that module alone, never a global. `DeclareGlobal`
/// candidates (inside a `declare global { ... }` block) are ALWAYS kept
/// regardless of their own file's script-vs-module status -- augmenting the
/// true global scope is the entire point of the `global` keyword, valid
/// from a module file too (see `SyntaxCollector::visit_ts_global_
/// declaration`'s own doc comment).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum GlobalScope {
    ScriptTopLevel,
    DeclareGlobal,
}

/// D.1 (2026-09-05, references-parity task): one ambient (cross-file,
/// import-less) global name this file contributes to the workspace-wide
/// `resolver::AmbientModuleIndex::globals` lookup -- see `SyntaxFileResult::
/// ambient_globals`'s own doc comment for the full mechanism and why
/// `entity_id` is never a NEW entity.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AmbientGlobalDeclaration {
    pub name: String,
    pub entity_id: String,
    pub kind: EntityKind,
    pub scope: GlobalScope,
}

/// D.3 (2026-09-05, references-parity task): one directly-`export`ed member
/// of a LOCAL `namespace X { ... }` block -- see `SyntaxFileResult::
/// namespace_members`'s own doc comment.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NamespaceMember {
    pub namespace_entity_id: String,
    pub name: String,
    pub member_entity_id: String,
}

/// One bare `export * from "specifier"` this module has -- see
/// `SyntaxFileResult::export_star_specifiers`'s own doc comment.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct ExportStarSpecifier {
    pub specifier: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
}

/// P1-B: the sentinel `SyntaxExportBinding::local_name` for an `export * as
/// X from "spec"` namespace re-export -- never a valid JS identifier, so it
/// can never collide with a real re-exported name. `resolver::resolve_
/// named_export` recognizes it and short-circuits to `ExportResolution::
/// Namespace(target_path)` instead of chasing it as an ordinary name in the
/// target module (there is no single symbol to chase -- `X` names the
/// WHOLE module). See `visit_export_all_declaration`'s doc comment.
pub(crate) const NAMESPACE_REEXPORT_LOCAL_NAME: &str = "*";

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct SyntaxExportBinding {
    pub exported_name: String,
    /// The name to look up in the local module's `entities` (a direct
    /// export) or, when `source_specifier` is set, in the target module's
    /// own `export_bindings` (a named re-export).
    pub local_name: String,
    /// Set only for `export { a } from "./x"` / `export { a as b } from
    /// "./x"` -- `None` for a local declaration/sourceless-specifier
    /// export.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_specifier: Option<String>,
    /// Resolved the same way `DirectImport::target_path` is (same
    /// `WorkspaceResolver`, same `available` set), once resolution has run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_target_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SyntaxEntity {
    pub id: String,
    pub name: String,
    pub kind: EntityKind,
    pub universal_kind: UniversalKind,
    pub path: String,
    pub start: u32,
    pub end: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qualified_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_test: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    Module,
    Function,
    Class,
    Interface,
    Type,
    Enum,
    Variable,
    /// A class instance/static method, or an interface method signature.
    /// Kind word `"method"`, matching v3's `analyzer.ts` vocabulary byte for
    /// byte (`MethodDeclaration`/`MethodSignature` both collapse to this
    /// one word there -- see `urdira-indexing-worker::v4::residual::
    /// member_kind_name`'s own doc comment for why that distinction was
    /// deliberately dropped).
    Method,
    /// A class constructor. Its "name" is the `constructor` keyword's own
    /// identifier span (`ClassElement::MethodDefinition`'s `key`, an
    /// oxc `PropertyKey::StaticIdentifier` naming the keyword itself --
    /// there is no separate syntax to special-case).
    Constructor,
    /// A class `get` accessor, or an interface `get`-kind method signature.
    Getter,
    /// A class `set` accessor, or an interface `set`-kind method signature.
    Setter,
    /// A class field/property definition, or an interface property
    /// signature.
    Property,
    /// An identifier-pattern parameter declaration (function/method/
    /// constructor/getter/setter/arrow/function-expression). EVERY such
    /// declaration gets an entity now (2026-09-06 fidelity fix, flecos v4
    /// plan §3.3, superseding the 2026-09-04 "referenced-only" cut that used
    /// to require at least one resolved reference in the body): `get_outline`
    /// must list every declared parameter an agent might ask about, not only
    /// the ones some caller happens to read. See `semantic_sites::ParamOwner`/
    /// `ParameterDeclarationFact` for the producer and `docs/evidence/
    /// 2026-09-04-v4-pending-sites-fold-and-member-entities.md`'s sibling page
    /// for the class/interface member entity precedent this follows.
    Parameter,
    /// External package/symbol entities task (2026-09-04): the whole
    /// external package/builtin an unresolved bare/scoped import specifier
    /// names (`jsts:external_module:{specifier}`, `id` built directly by
    /// [`crate::external_module_entity`] rather than through `stable_
    /// entity_id` -- there is no owning workspace file/span to key off of).
    /// See `docs/evidence/2026-09-04-v4-external-entities.md`.
    ExternalModule,
    /// One imported/exported/member-accessed NAME of an [`Self::
    /// ExternalModule`] (`jsts:external_symbol:{specifier}#{name}`, `id`
    /// built by [`crate::external_symbol_entity`]).
    ExternalSymbol,
    /// Ambient module resolution task (2026-09-04): a `namespace X {}` OR
    /// `declare module "specifier" { ... }` declaration -- kind word
    /// `"namespace"`, matching v3's `analyzer.ts` `addEntity`'s
    /// `isModuleDeclaration(node)` branch byte for byte (`kind =
    /// "namespace"`, `universalKind = "core:type"`). Until this task, no
    /// `EntityKind` covered `TSModuleDeclaration` at all (see
    /// `declaration_export_names`'s old doc comment) -- a bare specifier
    /// resolving through a workspace `declare module "x" { ... }` block
    /// needs THIS entity id as its `import * as ns` / `jsts:relation_
    /// import` target (see `push_namespace_entity`).
    Namespace,
}

impl EntityKind {
    const fn identity_name(self) -> &'static str {
        match self {
            Self::Module => "module",
            Self::Function => "function",
            Self::Class => "class",
            Self::Interface => "interface",
            Self::Type => "type",
            Self::Enum => "enum",
            Self::Variable => "variable",
            Self::Method => "method",
            Self::Constructor => "constructor",
            Self::Getter => "getter",
            Self::Setter => "setter",
            Self::Property => "property",
            Self::Parameter => "parameter",
            Self::ExternalModule => "external_module",
            Self::ExternalSymbol => "external_symbol",
            Self::Namespace => "namespace",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum UniversalKind {
    #[serde(rename = "core:container")]
    Container,
    #[serde(rename = "core:callable")]
    Callable,
    #[serde(rename = "core:type")]
    Type,
    #[serde(rename = "core:value")]
    Value,
    #[serde(rename = "core:parameter")]
    Parameter,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SyntaxRelation {
    pub id: String,
    pub kind: RelationKind,
    pub source_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    pub path: String,
    pub start: u32,
    pub end: u32,
    pub classification: RelationClassification,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum RelationKind {
    #[serde(rename = "core:contains")]
    Contains,
    #[serde(rename = "core:import")]
    Import,
    #[serde(rename = "core:export")]
    Export,
}

impl RelationKind {
    const fn identity_name(self) -> &'static str {
        match self {
            Self::Contains => "contains",
            Self::Import => "import",
            Self::Export => "export",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelationClassification {
    Confirmed,
    Possible,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    Javascript,
    Typescript,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScriptKind {
    Js,
    Jsx,
    Ts,
    Tsx,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DirectImport {
    pub specifier: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    pub kind: ImportKind,
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ImportKind {
    Import,
    Export,
    DynamicImport,
    Require,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SyntaxDiagnostic {
    pub message: String,
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone)]
struct DecodedSource {
    path: String,
    content_digest: String,
    bytes: Vec<u8>,
    language: Language,
    script_kind: ScriptKind,
}

#[derive(Debug, Clone)]
struct ValidatedSource {
    path: String,
    artifact_id: String,
    artifact_version_id: String,
    content_digest: String,
    source_blob_path: String,
    byte_length: usize,
    language: Language,
    script_kind: ScriptKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceMetadata {
    artifact_id: String,
    artifact_version_id: String,
    content_hash: String,
}

#[derive(Debug, Clone)]
struct PendingAnalysis {
    analysis_token: String,
    affected_files: Vec<String>,
    authoritative_changed_artifact_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
struct ProjectState {
    configuration_digest: String,
    root_names: Vec<String>,
    files: BTreeMap<String, SyntaxFileResult>,
    source_metadata: BTreeMap<String, SourceMetadata>,
    analysis_token: String,
    pending_analysis: Option<PendingAnalysis>,
}

/// P3-6 item 2: a project's reverse "which importer's specifier could
/// resolve to this concrete path" index, maintained incrementally (never
/// rebuilt wholesale except alongside a full/reset scan, which is already
/// O(corpus) for other reasons) so a pure create/delete/rename call can
/// look up a BOUNDED candidate set of importers to re-resolve instead of
/// sweeping every file in the corpus (`reresolve_file`'s old `stale_paths`
/// loop). Held OUTSIDE `ProjectState` (which is reconstructed fresh on
/// every `analyze` call, not mutated in place) specifically so it can be
/// mutated in place for just the handful of paths that actually changed
/// this call -- an `Arc`/full-clone-on-write scheme would still cost
/// O(index size) per call, defeating the whole point.
#[derive(Debug, Default, Clone)]
struct CandidateIndex {
    /// `candidate_path -> {importer paths whose specifier resolution could
    /// touch this path}` -- every extension/`/index` variant of every
    /// direct-import and re-export specifier a file carries, from
    /// [`resolver::WorkspaceResolver::candidate_paths`] (a safe
    /// over-approximation: an extra importer here just means one harmless
    /// extra `reresolve_file` call, never a missed one).
    reverse: HashMap<String, BTreeSet<String>>,
    /// `importer_path -> [candidate paths it currently contributes to
    /// `reverse`]`, so removing/re-deriving one file's own contribution
    /// (on edit, or on that path's removal) is O(that file's own import
    /// count), not O(index size).
    contributed: HashMap<String, Vec<String>>,
}

impl CandidateIndex {
    /// Removes every candidate-path entry `path` previously contributed
    /// (a no-op the first time a path is seen).
    fn remove_file(&mut self, path: &str) {
        if let Some(candidates) = self.contributed.remove(path) {
            for candidate in candidates {
                if let Some(importers) = self.reverse.get_mut(&candidate) {
                    importers.remove(path);
                    if importers.is_empty() {
                        self.reverse.remove(&candidate);
                    }
                }
            }
        }
    }

    /// (Re-)inserts `path`'s own contribution from its current
    /// `direct_imports`/`export_bindings`. Callers must call
    /// [`Self::remove_file`] first when `path` might already be indexed
    /// (an edit that changes its imports) -- `insert_file` alone does not
    /// know what to remove.
    fn insert_file(&mut self, path: &str, file: &SyntaxFileResult, resolver: &WorkspaceResolver) {
        let mut candidates: Vec<String> = Vec::new();
        for import in &file.direct_imports {
            candidates.extend(resolver.candidate_paths(path, &import.specifier));
        }
        for binding in &file.export_bindings {
            if let Some(specifier) = &binding.source_specifier {
                candidates.extend(resolver.candidate_paths(path, specifier));
            }
        }
        // 2026-09-04 references-parity task, bucket 2: a bare `export *
        // from "./x"` is a real dependency edge too (this file's own
        // re-exported surface depends on `./x`'s), so it must feed the
        // reverse index exactly like a named re-export's `source_specifier`
        // does just above -- otherwise an edit to the star target would
        // never invalidate this file's importers.
        for star in &file.export_star_specifiers {
            candidates.extend(resolver.candidate_paths(path, &star.specifier));
        }
        candidates.sort_unstable();
        candidates.dedup();
        for candidate in &candidates {
            self.reverse
                .entry(candidate.clone())
                .or_default()
                .insert(path.to_owned());
        }
        if !candidates.is_empty() {
            self.contributed.insert(path.to_owned(), candidates);
        }
    }

    /// The bounded candidate set for a batch of created/deleted/renamed
    /// paths: the union of every importer whose specifier's candidate list
    /// includes ANY of `touched_paths` -- this literally IS the "created/
    /// deleted/renamed path itself" lookup key (a candidate index entry is
    /// keyed by the exact concrete path a specifier could resolve to, and
    /// `touched_paths` are exact concrete paths).
    fn importers_of(&self, touched_paths: &BTreeSet<String>) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        for path in touched_paths {
            if let Some(importers) = self.reverse.get(path) {
                out.extend(importers.iter().cloned());
            }
        }
        out
    }

    /// Full rebuild from `files` -- used only alongside an already-O(corpus)
    /// cold scan or full reset, where this adds no new complexity class.
    fn rebuild(files: &BTreeMap<String, SyntaxFileResult>, resolver: &WorkspaceResolver) -> Self {
        let mut index = CandidateIndex::default();
        for (path, file) in files {
            index.insert_file(path, file, resolver);
        }
        index
    }
}

/// P3-6 item 3: a project's maintained reverse-import graph (`target_path
/// -> {importer paths that resolve to it}`), the same shape `reverse_
/// affected_closure` used to rebuild from EVERY file in the corpus (prior
/// AND next) on every single call, content edits included -- confirmed
/// live as a real O(corpus) cost inside the "parse" phase of a
/// steady-state edit at n8n scale. Maintained the same way as
/// [`CandidateIndex`] (remove-then-reinsert one file's own contribution),
/// except keyed by `target_path` (which DOES change on `reresolve_file`,
/// unlike the specifier text `CandidateIndex` keys on) -- so this index
/// additionally needs updating for the create/delete/rename path's
/// `reresolved` set, not just `changed_sources`/`removed`.
#[derive(Debug, Default, Clone)]
struct ImportReverseIndex {
    reverse: HashMap<String, BTreeSet<String>>,
    contributed: HashMap<String, Vec<String>>,
}

impl ImportReverseIndex {
    fn remove_file(&mut self, path: &str) {
        if let Some(targets) = self.contributed.remove(path) {
            for target in targets {
                if let Some(importers) = self.reverse.get_mut(&target) {
                    importers.remove(path);
                    if importers.is_empty() {
                        self.reverse.remove(&target);
                    }
                }
            }
        }
    }

    fn insert_file(&mut self, path: &str, file: &SyntaxFileResult) {
        let mut targets: Vec<String> = file
            .direct_imports
            .iter()
            .filter_map(|import| import.target_path.clone())
            .collect();
        targets.sort_unstable();
        targets.dedup();
        for target in &targets {
            self.reverse
                .entry(target.clone())
                .or_default()
                .insert(path.to_owned());
        }
        if !targets.is_empty() {
            self.contributed.insert(path.to_owned(), targets);
        }
    }

    /// Same BFS `reverse_affected_closure` always did, just against an
    /// incrementally maintained map instead of one rebuilt from scratch.
    fn affected_closure(&self, changed: &BTreeSet<String>) -> BTreeSet<String> {
        let mut affected = changed.clone();
        let mut queue: VecDeque<String> = changed.iter().cloned().collect();
        while let Some(target) = queue.pop_front() {
            for dependent in self.reverse.get(&target).into_iter().flatten() {
                if affected.insert(dependent.clone()) {
                    queue.push_back(dependent.clone());
                }
            }
        }
        affected
    }

    fn rebuild(files: &BTreeMap<String, SyntaxFileResult>) -> Self {
        let mut index = ImportReverseIndex::default();
        for (path, file) in files {
            index.insert_file(path, file);
        }
        index
    }
}

#[derive(Debug)]
pub struct SyntaxWorkerState {
    projects: HashMap<String, ProjectState>,
    next_analysis_sequence: u64,
    /// One [`CandidateIndex`] per project key (P3-6 item 2). Absent is
    /// exactly equivalent to empty (lazily rebuilt on the next call that
    /// needs it) -- see `analyze`'s own maintenance logic.
    candidate_indexes: HashMap<String, CandidateIndex>,
    /// One [`ImportReverseIndex`] per project key (P3-6 item 3). Same
    /// absent-is-empty convention as `candidate_indexes`.
    import_reverse_indexes: HashMap<String, ImportReverseIndex>,
}

impl Default for SyntaxWorkerState {
    fn default() -> Self {
        Self {
            projects: HashMap::new(),
            next_analysis_sequence: 1,
            candidate_indexes: HashMap::new(),
            import_reverse_indexes: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnalysisError {
    pub code: ErrorCode,
    pub message: String,
}

impl SyntaxWorkerState {
    /// The current, already lane-1-resolved `SyntaxFileResult` for every
    /// file this project's most recent `analyze` call retained (E2: the
    /// orchestrator's `HybridResolutionContext.files`, for the hybrid
    /// lane's cross-file export lookups -- see `resolver::
    /// resolve_named_export`). `None` when the project has never been
    /// analyzed (or was reset).
    pub fn project_files(&self, project_key: &str) -> Option<&BTreeMap<String, SyntaxFileResult>> {
        self.projects.get(project_key).map(|state| &state.files)
    }

    pub fn reset(&mut self, project_key: Option<&str>) -> usize {
        match project_key {
            Some(key) => {
                self.candidate_indexes.remove(key);
                self.import_reverse_indexes.remove(key);
                usize::from(self.projects.remove(key).is_some())
            }
            None => {
                let count = self.projects.len();
                self.projects.clear();
                self.candidate_indexes.clear();
                self.import_reverse_indexes.clear();
                count
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn read_facts(
        &self,
        request_id: String,
        cancellation_id: String,
        project_key: String,
        path: String,
        cursor: Option<FactsCursor>,
        max_output_bytes: u32,
        max_rows: u32,
    ) -> Result<WorkerMessage, AnalysisError> {
        validate_identifier(&request_id, "request_id")?;
        validate_identifier(&cancellation_id, "cancellation_id")?;
        validate_identifier(&project_key, "project_key")?;
        validate_path(&path)?;
        if max_output_bytes == 0 || max_output_bytes > MAX_FACT_OUTPUT_BYTES {
            return resource_error("fact output budget is invalid");
        }
        if max_rows == 0 || max_rows > MAX_FACT_ROWS {
            return resource_error("fact row budget is invalid");
        }
        let project = self
            .projects
            .get(&project_key)
            .ok_or_else(|| AnalysisError {
                code: ErrorCode::AnalysisFailed,
                message: "syntax project state is unavailable".into(),
            })?;
        let file = project.files.get(&path).ok_or_else(|| AnalysisError {
            code: ErrorCode::ProtocolInvalid,
            message: format!("fact path is not present in syntax project: {path}"),
        })?;
        let cursor = cursor.unwrap_or_default();
        validate_facts_cursor(project, file, cursor)?;
        let remaining_rows = remaining_fact_rows(project, file, cursor);
        let candidate_rows = remaining_rows.min(max_rows as usize);

        if candidate_rows == 0 {
            let (length, response) = serialized_response_length(build_facts_page(
                &request_id,
                &cancellation_id,
                &project_key,
                project,
                file,
                cursor,
                0,
            )?)?;
            if length > max_output_bytes as usize {
                return resource_error("fact response metadata exceeds max_output_bytes");
            }
            return Ok(response);
        }

        // Most source files fit their complete remaining fact set in the
        // response budget.  The old implementation entered the binary
        // search unconditionally and serialized the same page O(log(rows))
        // times for those files.  On a large cold workspace that turns into
        // thousands of avoidable JSON passes before the bytes even reach the
        // composition worker.  Probe the complete candidate once; retain the
        // bounded binary search only for the genuinely oversized page.
        let complete_candidate = build_facts_page(
            &request_id,
            &cancellation_id,
            &project_key,
            project,
            file,
            cursor,
            candidate_rows,
        )?;
        let (complete_length, complete_response) = serialized_response_length(complete_candidate)?;
        if complete_length <= max_output_bytes as usize {
            return Ok(complete_response);
        }

        let mut low = 1usize;
        let mut high = candidate_rows;
        let mut best: Option<WorkerMessage> = None;
        while low <= high {
            let count = low + (high - low) / 2;
            let candidate = build_facts_page(
                &request_id,
                &cancellation_id,
                &project_key,
                project,
                file,
                cursor,
                count,
            )?;
            let (length, response) = serialized_response_length(candidate)?;
            if length <= max_output_bytes as usize {
                best = Some(response);
                low = count + 1;
            } else {
                high = count - 1;
            }
        }
        best.ok_or_else(|| AnalysisError {
            code: ErrorCode::ResourceExhausted,
            message: "a single fact row exceeds max_output_bytes".into(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn read_facts_group(
        &self,
        request_id: String,
        cancellation_id: String,
        project_key: String,
        entries: Vec<FactsGroupEntry>,
        max_output_bytes: u32,
        max_rows: u32,
    ) -> Result<WorkerMessage, AnalysisError> {
        validate_identifier(&request_id, "request_id")?;
        validate_identifier(&cancellation_id, "cancellation_id")?;
        validate_identifier(&project_key, "project_key")?;
        if entries.is_empty() || entries.len() > MAX_FACT_GROUP_OWNERS {
            return resource_error("fact group owner count is invalid");
        }
        if max_output_bytes == 0 || max_output_bytes > MAX_FACT_GROUP_OUTPUT_BYTES {
            return resource_error("fact group output budget is invalid");
        }
        if max_rows == 0 || max_rows > MAX_FACT_ROWS {
            return resource_error("fact group row budget is invalid");
        }
        let mut paths = BTreeSet::new();
        for entry in &entries {
            validate_path(&entry.path)?;
            if !paths.insert(entry.path.clone()) {
                return protocol_error("fact group paths must be duplicate-free");
            }
        }

        let mut pages = Vec::with_capacity(entries.len());
        let mut row_count = 0usize;
        let mut next_request_index = None;
        let mut used_bytes = 512usize;
        for (entry_index, entry) in entries.iter().enumerate() {
            if row_count >= max_rows as usize {
                next_request_index = Some(entry_index);
                break;
            }
            // Leave room for the group envelope and the remaining page
            // metadata. A page is retriable and state-free, so stopping here
            // never consumes or advances an owner cursor.
            let remaining_bytes = (max_output_bytes as usize).saturating_sub(used_bytes + 4096);
            if remaining_bytes < 1024 {
                next_request_index = Some(entry_index);
                break;
            }
            let response = self.read_facts(
                request_id.clone(),
                cancellation_id.clone(),
                project_key.clone(),
                entry.path.clone(),
                entry.cursor,
                remaining_bytes.min(MAX_FACT_OUTPUT_BYTES as usize) as u32,
                (max_rows as usize - row_count) as u32,
            )?;
            let page_rows = match &response {
                WorkerMessage::FactsResult {
                    direct_imports,
                    records,
                    dependencies,
                    ..
                } => direct_imports.len() + records.len() + dependencies.len(),
                _ => return protocol_error("fact group produced a non-fact page"),
            };
            pages.push(response);
            let (candidate_length, candidate) =
                serialized_response_length(WorkerMessage::FactsGroupResult {
                    request_id: request_id.clone(),
                    cancellation_id: cancellation_id.clone(),
                    project_key: project_key.clone(),
                    pages,
                    next_request_index: if entry_index + 1 < entries.len() {
                        Some(entry_index + 1)
                    } else {
                        None
                    },
                    metrics: FactsTransferMetrics::default(),
                })?;
            pages = match candidate {
                WorkerMessage::FactsGroupResult { pages, .. } => pages,
                _ => return protocol_error("fact group serialization changed response kind"),
            };
            if candidate_length > max_output_bytes as usize {
                pages.pop();
                next_request_index = Some(entry_index);
                break;
            }
            used_bytes = candidate_length;
            row_count += page_rows;
        }
        if pages.is_empty() {
            return resource_error("fact group budget cannot fit one owner page");
        }
        if next_request_index.is_none() && pages.len() < entries.len() {
            next_request_index = Some(pages.len());
        }
        let (length, response) = serialized_response_length(WorkerMessage::FactsGroupResult {
            request_id,
            cancellation_id,
            project_key,
            pages,
            next_request_index,
            metrics: FactsTransferMetrics::default(),
        })?;
        if length > max_output_bytes as usize {
            return resource_error("fact group response exceeds max_output_bytes");
        }
        Ok(response)
    }

    /// v4 in-process fast path (P2-2g item 1). `read_facts`/`read_facts_
    /// group` above exist to serve an out-of-process worker across a
    /// byte-bounded IPC channel: every call re-derives `ProposedRecord`s for
    /// its requested slice, then `read_facts_group`'s caller
    /// (`serialized_response_length`) round-trips the ENTIRE growing page
    /// through `serde_json::to_vec` 2-4 times (a fixed-point loop that
    /// converges once the embedded byte-count's own digit width stops
    /// changing) purely to police `max_output_bytes`/`max_rows` — a real
    /// concern for a byte-bounded channel, pure waste for an in-process
    /// caller like `urdira-indexing-worker`'s v4 pipeline, which holds this
    /// `SyntaxWorkerState` directly and never serializes a `WorkerMessage`
    /// at all. Measured live on n8n (14,082 owners): the `read_facts_group`
    /// path cost ~12s; this path (same `proposed_records`/`proposed_
    /// dependencies` builders, zero budget/cursor/serialization overhead)
    /// is the fix — see this task's evidence doc §14 for the before/after.
    ///
    /// Returns every requested path's COMPLETE fact set in one shot (no
    /// cursor: an in-process caller can hold the whole `Vec` per file, it
    /// never has to fit inside a wire frame). Unlike `read_facts_group`,
    /// `paths` may repeat or be given in any order; a path absent from the
    /// project is an error, matching `read_facts`'s existing behavior for
    /// an unknown path.
    pub fn facts_for_paths(
        &self,
        project_key: &str,
        paths: &[String],
    ) -> Result<Vec<FactsForPath>, AnalysisError> {
        validate_identifier(project_key, "project_key")?;
        let project = self
            .projects
            .get(project_key)
            .ok_or_else(|| AnalysisError {
                code: ErrorCode::AnalysisFailed,
                message: "syntax project state is unavailable".into(),
            })?;
        paths
            .iter()
            .map(|path| facts_for_one_path(project, path))
            .collect()
    }

    pub fn commit_analysis(
        &mut self,
        request_id: String,
        project_key: String,
        analysis_token: String,
    ) -> Result<WorkerMessage, AnalysisError> {
        validate_identifier(&request_id, "request_id")?;
        validate_identifier(&project_key, "project_key")?;
        validate_identifier(&analysis_token, "analysis_token")?;
        let project = self
            .projects
            .get_mut(&project_key)
            .ok_or_else(|| AnalysisError {
                code: ErrorCode::AnalysisFailed,
                message: "syntax project state is unavailable".into(),
            })?;
        if project.analysis_token != analysis_token {
            return protocol_error("analysis_token does not identify the current analysis");
        }
        if project
            .pending_analysis
            .as_ref()
            .is_some_and(|pending| pending.analysis_token != analysis_token)
        {
            return protocol_error("analysis_token does not identify the pending analysis");
        }
        project.pending_analysis = None;
        Ok(WorkerMessage::CommitAnalysisAck {
            request_id,
            project_key,
            analysis_token,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn analyze(
        &mut self,
        request_id: String,
        cancellation_id: String,
        project_key: String,
        configuration_digest: String,
        mut root_names: Vec<String>,
        sources: Vec<SourceInput>,
        config_assets: Vec<ConfigAssetInput>,
        change_set: AuthoritativeChangeSet,
        budgets: AnalysisBudgets,
        cancelled: &AtomicBool,
    ) -> Result<WorkerMessage, AnalysisError> {
        validate_identifier(&request_id, "request_id")?;
        validate_identifier(&cancellation_id, "cancellation_id")?;
        validate_identifier(&project_key, "project_key")?;
        validate_digest(&configuration_digest, "configuration_digest")?;
        // E2 (F5 hybrid design): fold every config asset's content digest
        // into the digest this project's incremental state is keyed on, so
        // an edit to `tsconfig.json`/`package.json`/`pnpm-workspace.yaml`
        // -- even with the JS/TS source set otherwise unchanged -- forces
        // `ResetReason::ConfigurationChanged` (full re-resolution) instead
        // of silently reusing stale `direct_imports`/`export_bindings`
        // target paths. Folded from the WIRE digests (not from whether an
        // individual asset happened to parse), so a corrupted/unparseable
        // asset still correctly invalidates state.
        let configuration_digest = fold_configuration_digest(&configuration_digest, &config_assets);
        let resolver_assets = decode_config_assets_inner(config_assets)?;
        let resolver = WorkspaceResolver::build(&resolver_assets);
        if budgets.max_output_bytes == 0 || budgets.max_files == 0 || budgets.max_source_bytes == 0
        {
            return resource_error("analysis budgets must be positive");
        }
        if sources.len() > budgets.max_files as usize {
            return Err(AnalysisError {
                code: ErrorCode::ResourceExhausted,
                message: format!(
                    "source file count exceeds max_files ({} > {})",
                    sources.len(),
                    budgets.max_files
                ),
            });
        }
        root_names.sort();
        if root_names.windows(2).any(|pair| pair[0] == pair[1]) {
            return protocol_error("root_names contains duplicates");
        }
        let validated = validate_sources(sources, budgets.max_source_bytes)?;
        let paths: BTreeSet<_> = validated.iter().map(|source| source.path.clone()).collect();
        let source_metadata = validated
            .iter()
            .map(|source| {
                (
                    source.path.clone(),
                    SourceMetadata {
                        artifact_id: source.artifact_id.clone(),
                        artifact_version_id: source.artifact_version_id.clone(),
                        content_hash: source.content_digest.clone(),
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        if root_names.iter().any(|root| !paths.contains(root)) {
            return protocol_error("every root name must name an explicit source input");
        }
        // P3-3 item 3: was `self.projects.get(&project_key).cloned()` -- an
        // UNCONDITIONAL full clone of the ENTIRE prior `ProjectState` on
        // EVERY call (cold, edit, add/remove alike), including its
        // `files: BTreeMap<String, SyntaxFileResult>` (one entry per
        // corpus file, each carrying its own `entities`/`relations`/
        // `direct_imports`/`export_bindings` vectors) -- genuinely
        // O(corpus) regardless of how small the actual edit is, and (for
        // the two branches below that also do `state.files.clone()`) paid
        // TWICE over: once here, once more to seed `next_files`. Measured
        // as the dominant cost of `parse_ms` for a steady-state 1-file
        // edit at n8n scale (`docs/evidence/2026-09-03-v4-p3-3-digest-
        // churn.md` §item 3). A borrow instead of a clone: every `prior`
        // read below (root_names/configuration_digest/source_metadata/
        // pending_analysis comparisons, and `reverse_affected_closure`'s
        // own read of `&state.files`) only ever needs `&ProjectState`, not
        // an owned one -- the ONE real clone this function needs
        // (`next_files`'s own starting point, since it goes on to be
        // mutated independently of the retained `self.projects` entry) is
        // still paid, exactly once, at its own call site below, never
        // twice. This borrow's last use is always before this function's
        // own `self.projects.insert(...)`/`self.projects.get_mut(...)`
        // calls (verified by the borrow checker, not asserted by hand).
        let prior = self.projects.get(&project_key);
        let prior_paths = prior
            .as_ref()
            .map(|state| state.files.keys().cloned().collect::<BTreeSet<_>>());
        let reset_reason = match &prior {
            None => Some(ResetReason::Initial),
            Some(state) if state.root_names != root_names => Some(ResetReason::RootSetChanged),
            Some(state) if state.configuration_digest != configuration_digest => {
                Some(ResetReason::ConfigurationChanged)
            }
            Some(_) if prior_paths.as_ref() != Some(&paths) => Some(ResetReason::FileSetChanged),
            Some(_) => None,
        };
        // T1 (docs/evidence/2026-09-02-file-creation-diagnosis.md): a
        // root/file-set change that is a PURE path-membership change --
        // every path present both before and now kept byte-identical
        // content, and the resolver configuration did not change -- never
        // needs the O(corpus) reparse the generic reset below performs.
        // Only the added/removed paths themselves, plus whichever OTHER
        // files' import/export resolution the new path set actually
        // changes (computed exactly by `reresolve_file`, never guessed
        // at), are re-derived. Any case this cannot certify -- a content
        // edit mixed into the same request, or a configuration change --
        // is deliberately excluded here and falls through to the existing
        // conservative full reset.
        let path_membership_incremental = matches!(
            reset_reason,
            Some(ResetReason::RootSetChanged) | Some(ResetReason::FileSetChanged)
        ) && prior.as_ref().is_some_and(|state| {
            state.configuration_digest == configuration_digest
                && state
                    .source_metadata
                    .iter()
                    .filter(|(path, _)| paths.contains(path.as_str()))
                    .all(|(path, metadata)| source_metadata.get(path) == Some(metadata))
        });
        let added: BTreeSet<String> = if path_membership_incremental {
            prior_paths.as_ref().map_or_else(
                || paths.clone(),
                |prior_paths| paths.difference(prior_paths).cloned().collect(),
            )
        } else {
            BTreeSet::new()
        };
        let removed: BTreeSet<String> = if path_membership_incremental {
            prior_paths
                .as_ref()
                .map_or_else(BTreeSet::new, |prior_paths| {
                    prior_paths.difference(&paths).cloned().collect()
                })
        } else {
            BTreeSet::new()
        };
        let pending_replay = reset_reason.is_none()
            && prior
                .as_ref()
                .is_some_and(|state| state.pending_analysis.is_some())
            && prior.as_ref().is_some_and(|state| match &change_set {
                AuthoritativeChangeSet::Full => {
                    same_source_content(&state.source_metadata, &source_metadata)
                }
                AuthoritativeChangeSet::Exact { .. } => state.source_metadata == source_metadata,
            });
        let replayed_exact_ids = pending_replay
            .then(|| {
                prior
                    .as_ref()
                    .and_then(|state| state.pending_analysis.as_ref())
                    .and_then(|pending| pending.authoritative_changed_artifact_ids.as_deref())
            })
            .flatten();
        let authoritative_changed = authoritative_changed_paths(
            &change_set,
            &source_metadata,
            prior.as_ref().map(|state| &state.source_metadata),
            replayed_exact_ids,
        )?;
        let changed = if pending_replay {
            BTreeSet::new()
        } else if path_membership_incremental {
            added.clone()
        } else if reset_reason.is_some() || matches!(&change_set, AuthoritativeChangeSet::Full) {
            paths.clone()
        } else {
            authoritative_changed
        };
        if cancelled.load(Ordering::Acquire) {
            return Ok(WorkerMessage::Cancelled {
                request_id,
                cancellation_id,
            });
        }
        if changed.is_empty() && reset_reason.is_none() {
            let current = self
                .projects
                .get_mut(&project_key)
                .ok_or_else(|| AnalysisError {
                    code: ErrorCode::AnalysisFailed,
                    message: "syntax project state is unavailable".into(),
                })?;
            current.source_metadata = source_metadata;
            let affected_files = current
                .pending_analysis
                .as_ref()
                .map_or_else(Vec::new, |pending| pending.affected_files.clone());
            return Ok(WorkerMessage::AnalysisResult {
                request_id,
                cancellation_id,
                project_key,
                analysis_token: current.analysis_token.clone(),
                build: BuildKind::Unchanged,
                reset_reason: None,
                changed_files: Vec::new(),
                affected_files,
                metrics: BoundaryMetrics::default(),
            });
        }
        let available = paths.clone();
        // A1 (grupo A campaign): `next_files`'s starting point used to be an
        // UNCONDITIONAL `prior...files.clone()` right here -- a full
        // O(corpus) clone of the entire `BTreeMap<String, SyntaxFileResult>`
        // on every incremental scan (14k entries/70-140ms at n8n scale),
        // even though `next_files` never needs to coexist with `prior`'s own
        // copy once this point is reached: every OTHER read of `prior` in
        // this function happens either strictly BEFORE this point (the
        // root_names/configuration_digest/source_metadata/pending_analysis
        // comparisons above, all done) or is one of exactly two later reads,
        // both snapshotted into cheap, O(changes) (never O(corpus)) owned
        // values right here, before `prior`'s borrow of `self.projects` is
        // dropped and the entry is MOVED out instead of cloned:
        //   (a) the ambient-module diff loop below (`ambient_touched_
        //       specifiers`) only ever reads `prior...files.get(path).
        //       ambient_modules` for `path` in `changed ∪ removed` --
        //       `prior_ambient_specifiers` snapshots exactly that (just the
        //       specifier strings actually used), and nothing else, for
        //       exactly those paths.
        //   (b) `reverse_affected_closure`'s defensive fallback (used only
        //       when this project has no maintained `ImportReverseIndex`
        //       yet) reads `prior...&state.files` in full. `ProjectState`
        //       entries and `ImportReverseIndex` entries are only ever
        //       created together (the index-build block a few lines below,
        //       which unconditionally does `.entry(project_key).or_
        //       default()` for THIS call before either of that fallback's
        //       two call sites is reached) and only ever removed together
        //       (`reset`) -- so by the time either call site's `match self.
        //       import_reverse_indexes.get(&project_key)` runs, the index
        //       already exists, always, making the `None` arm provably
        //       dead code (not just "shouldn't fire in practice", as the
        //       comment near those call sites already said) -- `None` is
        //       passed there directly below rather than trying to source a
        //       value from `prior` that's no longer reachable at that
        //       point.
        //
        // `self.projects.remove` below then takes ownership of the whole
        // `ProjectState` (not just `files`) so a `Cancelled`/parse-`Err`/
        // output-budget early return anywhere between here and this
        // function's own final `self.projects.insert(...)` (there are
        // several: before parsing starts, mid-parse-loop, mid-reresolve-
        // loop, and the `max_output_bytes` check) can restore it via
        // `restore_prior_on_bail` instead of silently losing this project's
        // persisted state. That restore pairs whatever `next_files` holds
        // at the bail point with the ORIGINAL (never this call's freshly
        // computed) `root_names`/`configuration_digest`/`source_metadata`/
        // `analysis_token`/`pending_analysis` -- see `restore_prior_on_bail`
        // for why that pairing, not a byte-identical restore, is what makes
        // every bail point safe without paying for a second clone.
        let next_files_move_started = std::time::Instant::now();
        let prior_ambient_specifiers: HashMap<&str, Vec<String>> = changed
            .iter()
            .chain(removed.iter())
            .filter_map(|path| {
                prior
                    .as_ref()
                    .and_then(|state| state.files.get(path))
                    .map(|file| {
                        let specifiers = file
                            .ambient_modules
                            .iter()
                            .map(|decl| decl.specifier.clone())
                            .collect::<Vec<_>>();
                        (path.as_str(), specifiers)
                    })
            })
            .collect();
        let owned_prior = self.projects.remove(&project_key);
        let (mut next_files, prior_rest) = match owned_prior {
            Some(mut state) => {
                let files = std::mem::take(&mut state.files);
                let files = if path_membership_incremental {
                    let mut files = files;
                    for path in &removed {
                        files.remove(path);
                    }
                    files
                } else if reset_reason.is_some() {
                    // Full reset: `state`'s old `files` are intentionally
                    // discarded (`files` local above just drops here), not
                    // reused -- but `state` itself (now holding an empty
                    // `files` placeholder) is still kept as `prior_rest` so
                    // a bail during the reset's from-scratch reparse can
                    // still restore something sane (see
                    // `restore_prior_on_bail`).
                    BTreeMap::new()
                } else {
                    files
                };
                (files, Some(state))
            }
            None => (BTreeMap::new(), None),
        };
        if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
            eprintln!(
                "[urdira-jsts-syntax-worker] v4 DEBUG: next_files move: {:.3}s ({} entries)",
                next_files_move_started.elapsed().as_secs_f64(),
                next_files.len(),
            );
        }
        let changed_sources = validated
            .iter()
            .filter(|source| changed.contains(&source.path))
            .collect::<Vec<_>>();
        if cancelled.load(Ordering::Acquire) {
            self.restore_prior_on_bail(&project_key, prior_rest, next_files);
            return Ok(WorkerMessage::Cancelled {
                request_id,
                cancellation_id,
            });
        }
        // Source decoding and Oxc parsing are owner-independent. Keep the
        // result merge ordered, but use a bounded scoped pool so cold scans do
        // not spend their dominant span on one file at a time. The cap matches
        // the native qualification budget and avoids creating a second worker
        // process or duplicating compiler state.
        let worker_count = std::thread::available_parallelism()
            .map_or(1, |parallelism| parallelism.get().clamp(1, 6))
            .min(changed_sources.len().max(1));
        let changed_sources = &changed_sources;
        let available = &available;
        let resolver = &resolver;
        let parsed_sources = std::thread::scope(|scope| {
            let (sender, receiver) = std::sync::mpsc::channel();
            for worker_index in 0..worker_count {
                let sender = sender.clone();
                scope.spawn(move || {
                    for (source_index, source) in changed_sources.iter().enumerate() {
                        if source_index % worker_count != worker_index {
                            continue;
                        }
                        if cancelled.load(Ordering::Acquire) {
                            let _ = sender.send((
                                source_index,
                                Err(AnalysisError {
                                    code: ErrorCode::AnalysisFailed,
                                    message: "analysis cancelled".into(),
                                }),
                            ));
                            continue;
                        }
                        let result = decode_source(source).and_then(|decoded| {
                            let byte_length = decoded.bytes.len() as u64;
                            parse_source(&decoded, available, resolver)
                                .map(|parsed| (byte_length, parsed))
                        });
                        let _ = sender.send((source_index, result));
                    }
                });
            }
            drop(sender);
            let mut results = receiver.into_iter().collect::<Vec<_>>();
            results.sort_by_key(|(source_index, _)| *source_index);
            results
        });
        let mut source_bytes = 0u64;
        for (_, result) in parsed_sources {
            match result {
                Ok((byte_length, parsed)) => {
                    source_bytes = source_bytes.saturating_add(byte_length);
                    next_files.insert(parsed.path.clone(), parsed);
                }
                Err(error)
                    if cancelled.load(Ordering::Acquire)
                        && error.message == "analysis cancelled" =>
                {
                    self.restore_prior_on_bail(&project_key, prior_rest, next_files);
                    return Ok(WorkerMessage::Cancelled {
                        request_id,
                        cancellation_id,
                    });
                }
                Err(error) => {
                    self.restore_prior_on_bail(&project_key, prior_rest, next_files);
                    return Err(error);
                }
            }
        }
        // P3-6 item 2: maintain this project's reverse candidate-path
        // index (`CandidateIndex`) BEFORE using it below to narrow the
        // create/delete/rename re-resolution sweep -- a file's specifier
        // text (what the index is keyed from) only ever changes when that
        // file is actually reparsed, which happens for exactly the paths
        // in `changed_sources` (added paths, in path-membership-incremental
        // mode; literally-edited paths otherwise) and never for a path
        // that's merely `reresolve_file`'d (that only rewrites
        // `target_path`, not the specifier text an import/re-export
        // names). `removed` paths must have their own contribution dropped
        // so a later create/delete call never uses a deleted file's now-
        // meaningless specifiers to widen its lookup. A cold scan or full
        // reset touches every path in `next_files`, so it's cheaper (and
        // simpler to prove correct) to just rebuild the whole index from
        // scratch there -- already an O(corpus) call for other reasons.
        {
            let index = self
                .candidate_indexes
                .entry(project_key.clone())
                .or_default();
            if reset_reason.is_some() && !path_membership_incremental {
                *index = CandidateIndex::rebuild(&next_files, resolver);
            } else {
                for path in &removed {
                    index.remove_file(path);
                }
                for path in changed_sources.iter().map(|source| &source.path) {
                    index.remove_file(path);
                    if let Some(file) = next_files.get(path.as_str()) {
                        index.insert_file(path, file, resolver);
                    }
                }
            }
        }
        // P3-6 item 3: same incremental-maintenance shape as the candidate
        // index just above, for `reverse_affected_closure`'s reverse-
        // import graph (`target_path -> importers`). Kept as a SEPARATE
        // index (not folded into `CandidateIndex`) because it's keyed by
        // `target_path`, which the reresolve loop below DOES mutate (a
        // create/delete/rename can change what a stable file's specifier
        // resolves to) -- `CandidateIndex` is keyed by specifier TEXT,
        // which reresolution never touches. Updated for `changed_sources`/
        // `removed` here (mirrors `next_files`'s state as of this point);
        // updated again for `reresolved` right after that loop runs.
        {
            let index = self
                .import_reverse_indexes
                .entry(project_key.clone())
                .or_default();
            if reset_reason.is_some() && !path_membership_incremental {
                *index = ImportReverseIndex::rebuild(&next_files);
            } else {
                for path in &removed {
                    index.remove_file(path);
                }
                for path in changed_sources.iter().map(|source| &source.path) {
                    index.remove_file(path);
                    if let Some(file) = next_files.get(path.as_str()) {
                        index.insert_file(path, file);
                    }
                }
            }
        }
        // T1: a path add/remove can change the resolved `target_path` of an
        // OTHER, byte-identical file's relative/bare import specifier --
        // both when a specifier that used to be unresolved now finds the
        // added path, and when a higher-resolution-priority path shadows
        // (add) or stops shadowing (remove) a specifier's previous target
        // (see `resolve_relative`/`probe_extensions`'s fixed extension
        // order). P3-6 item 2: narrowed from an O(corpus) sweep of every
        // retained path to the BOUNDED set the reverse candidate index
        // above names as possibly touched by `added`/`removed` -- any
        // importer whose specifier's candidate-path list includes one of
        // those exact paths (covers both "a specifier that used to be
        // unresolved now finds the added path" and "a higher-priority
        // extension shadows/unshadows a specifier's previous target",
        // since `CandidateIndex` is keyed by every extension/`/index`
        // variant, not just whichever one currently resolves). Falls back
        // to the old full sweep only if this project somehow has no index
        // yet (defensive; every code path above that returns from this
        // function also updates the index, so this should never fire in
        // practice).
        let mut reresolved: BTreeSet<String> = BTreeSet::new();
        if path_membership_incremental {
            let touched: BTreeSet<String> = added.iter().chain(removed.iter()).cloned().collect();
            let stale_paths: Vec<String> = match self.candidate_indexes.get(&project_key) {
                Some(index) => index
                    .importers_of(&touched)
                    .into_iter()
                    .filter(|path| {
                        next_files.contains_key(path) && !changed.contains(path.as_str())
                    })
                    .collect(),
                None => next_files
                    .keys()
                    .filter(|path| !changed.contains(path.as_str()))
                    .cloned()
                    .collect(),
            };
            for path in stale_paths {
                if cancelled.load(Ordering::Acquire) {
                    self.restore_prior_on_bail(&project_key, prior_rest, next_files);
                    return Ok(WorkerMessage::Cancelled {
                        request_id,
                        cancellation_id,
                    });
                }
                let updated = next_files
                    .get(&path)
                    .and_then(|existing| reresolve_file(existing, available, resolver));
                if let Some(updated) = updated {
                    next_files.insert(path.clone(), updated);
                    reresolved.insert(path);
                }
            }
        }
        // P3-6 item 3: `reresolve_file` above may have changed a stable
        // path's `target_path` (that's the whole point of it) without
        // changing its specifier text -- refresh THIS path's own
        // contribution to the reverse-import index now that its outgoing
        // edges are known to be current. `CandidateIndex` needs no
        // equivalent step here (specifier text, its own key, never
        // changes from reresolution alone).
        if !reresolved.is_empty() {
            let index = self
                .import_reverse_indexes
                .entry(project_key.clone())
                .or_default();
            for path in &reresolved {
                index.remove_file(path);
                if let Some(file) = next_files.get(path.as_str()) {
                    index.insert_file(path, file);
                }
            }
        }
        // Ambient module resolution task (2026-09-04), fix item 2: a
        // `declare module "specifier" { ... }` block anywhere in the
        // workspace can change what a DIFFERENT file's bare import/export
        // specifier resolves to (`build_import_export_facts`'s decision
        // order) -- but `parse_source` (per-file, run in parallel above,
        // with no cross-file view) always builds a freshly (re)parsed
        // file's own relations with `ambient_index: None`, and neither
        // `CandidateIndex` nor `ImportReverseIndex` can find the files this
        // affects (both are keyed by resolvable workspace PATHS; an
        // ambient specifier's raw text is not one). This pass corrects
        // both gaps: (1) every file THIS call (re)parsed always needs its
        // ambient-index decision revisited, regardless of mode; (2) when a
        // touched file's OWN ambient declarations changed (added/removed/
        // edited), every OTHER file importing that same specifier needs
        // revisiting too, found via a bounded scan restricted to exactly
        // those specifiers (never a corpus-wide sweep). Deliberately NOT
        // incrementally maintained the way `CandidateIndex`/
        // `ImportReverseIndex` are (no persistent index survives across
        // calls) -- ambient declarations are rare (a handful of `.d.ts`
        // files in a real corpus), so a fresh `AmbientModuleIndex::rebuild`
        // over every file's already-in-memory, usually-empty `ambient_
        // modules` vector is cheap: no AST walk, no reparse, not the
        // per-edit cost class those P3-6 indexes exist to avoid.
        let ambient_index_started = std::time::Instant::now();
        let ambient_index = resolver::AmbientModuleIndex::rebuild(&next_files);
        if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
            eprintln!(
                "[urdira-jsts-syntax-worker] v4 DEBUG: analyze()'s own AmbientModuleIndex::rebuild: {:.3}s ({} files)",
                ambient_index_started.elapsed().as_secs_f64(),
                next_files.len(),
            );
        }
        let mut ambient_touched_specifiers: BTreeSet<String> = BTreeSet::new();
        for path in changed.iter().chain(removed.iter()) {
            if let Some(specifiers) = prior_ambient_specifiers.get(path.as_str()) {
                ambient_touched_specifiers.extend(specifiers.iter().cloned());
            }
            if let Some(file) = next_files.get(path.as_str()) {
                ambient_touched_specifiers.extend(
                    file.ambient_modules
                        .iter()
                        .map(|decl| decl.specifier.clone()),
                );
            }
        }
        let mut ambient_affected: BTreeSet<String> = BTreeSet::new();
        if !ambient_touched_specifiers.is_empty() {
            let mut specifier_importers: HashMap<&str, Vec<String>> = HashMap::new();
            for (importer_path, file) in next_files.iter() {
                for import in &file.direct_imports {
                    if import.target_path.is_none()
                        && ambient_touched_specifiers.contains(&import.specifier)
                    {
                        specifier_importers
                            .entry(import.specifier.as_str())
                            .or_default()
                            .push(importer_path.clone());
                    }
                }
            }
            for specifier in &ambient_touched_specifiers {
                for importer in specifier_importers
                    .get(specifier.as_str())
                    .into_iter()
                    .flatten()
                {
                    if !changed.contains(importer.as_str()) {
                        ambient_affected.insert(importer.clone());
                    }
                }
            }
        }
        for path in changed.iter().chain(ambient_affected.iter()) {
            if let Some(updated) = next_files
                .get(path.as_str())
                .and_then(|file| reresolve_ambient_relations(file, &ambient_index))
            {
                next_files.insert(path.clone(), updated);
            }
        }
        // P3-6 item 3: `reverse_affected_closure`'s own O(corpus)-per-call
        // rebuild replaced with a lookup against the maintained `Import
        // ReverseIndex` above -- same BFS, same result (the maintained
        // index mirrors `next_files`'s current reverse-import graph
        // exactly, and every literal seed of the BFS below is already a
        // member of `changed`/`closure_changed` regardless of what the
        // graph itself contains, so which generation's snapshot the graph
        // reflects cannot change the OUTPUT set -- verified, not just
        // argued, by every existing closure/root-equality test plus this
        // task's own new randomized test still passing). Falls back to the
        // old from-scratch rebuild only if this project has no index yet
        // (defensive; every path that returns from this function updates
        // the index, so this should never fire in practice -- A1: provably
        // so, not just empirically, per the note next to `next_files`'s own
        // construction above; `None` is passed for `prior` in that dead
        // arm because `prior`'s own borrow is gone by this point, moved out
        // for `next_files` instead of cloned).
        let affected = if path_membership_incremental {
            let closure_changed: BTreeSet<String> =
                added.iter().chain(reresolved.iter()).cloned().collect();
            match self.import_reverse_indexes.get(&project_key) {
                Some(index) => index.affected_closure(&closure_changed),
                None => reverse_affected_closure(None, &next_files, &closure_changed),
            }
        } else if reset_reason.is_some() {
            paths
        } else {
            match self.import_reverse_indexes.get(&project_key) {
                Some(index) => index.affected_closure(&changed),
                None => reverse_affected_closure(None, &next_files, &changed),
            }
        };
        // Ambient module resolution task (2026-09-04): fold in every
        // importer `reresolve_ambient_relations` above rewrote because a
        // DIFFERENT file's ambient declarations changed this call -- these
        // are not reachable through `ImportReverseIndex`'s `target_path`
        // graph (see that pass's own doc comment), so they would otherwise
        // never be reported as `affected_files`, even though their own
        // `jsts:relation_import`/`export` rows just changed.
        let affected: BTreeSet<String> = affected.into_iter().chain(ambient_affected).collect();
        let metrics = BoundaryMetrics {
            bytes_read: source_bytes,
            bytes_transferred: 0,
            bytes_copied: 0,
            bytes_decoded: source_bytes,
            bytes_retained: retained_bytes(&next_files),
        };
        let analysis_token = next_analysis_token(&project_key, self.next_analysis_sequence);
        self.next_analysis_sequence = self.next_analysis_sequence.saturating_add(1);
        let affected_files = affected.into_iter().collect::<Vec<_>>();
        let reported_changed_files: Vec<String> = if path_membership_incremental {
            added.union(&reresolved).cloned().collect()
        } else {
            changed.into_iter().collect()
        };
        let response = WorkerMessage::AnalysisResult {
            request_id,
            cancellation_id,
            project_key: project_key.clone(),
            analysis_token: analysis_token.clone(),
            build: if path_membership_incremental {
                BuildKind::Incremental
            } else if reset_reason.is_some() {
                BuildKind::Full
            } else {
                BuildKind::Incremental
            },
            reset_reason,
            changed_files: reported_changed_files,
            affected_files: affected_files.clone(),
            metrics,
        };
        if budgets.enforce_output_bytes {
            let output_length = match serde_json::to_vec(&response) {
                Ok(bytes) => bytes.len(),
                Err(_) => {
                    self.restore_prior_on_bail(&project_key, prior_rest, next_files);
                    return Err(AnalysisError {
                        code: ErrorCode::AnalysisFailed,
                        message: "analysis response serialization failed".into(),
                    });
                }
            };
            if output_length > budgets.max_output_bytes as usize
                || output_length > MAX_MESSAGE_BYTES
            {
                self.restore_prior_on_bail(&project_key, prior_rest, next_files);
                return resource_error("analysis response exceeds max_output_bytes");
            }
        }
        self.projects.insert(
            project_key,
            ProjectState {
                configuration_digest,
                root_names,
                files: next_files,
                source_metadata,
                analysis_token: analysis_token.clone(),
                pending_analysis: Some(PendingAnalysis {
                    analysis_token,
                    affected_files,
                    authoritative_changed_artifact_ids: match change_set {
                        AuthoritativeChangeSet::Full => None,
                        AuthoritativeChangeSet::Exact {
                            changed_artifact_ids,
                        } => Some(changed_artifact_ids),
                    },
                }),
            },
        );
        Ok(response)
    }

    /// A1 (grupo A campaign): puts a project's state back once `analyze`
    /// has moved (not cloned) `prior`'s `files` out of `self.projects` --
    /// via `self.projects.remove` -- for `next_files`'s own starting point,
    /// on every one of `analyze`'s early-return paths between that point
    /// and its own final, successful `self.projects.insert(...)`
    /// (`Cancelled` before parsing starts, a cancelled or genuinely failed
    /// parse mid-loop, a cancellation mid-reresolve, a response
    /// serialization failure, or the `max_output_bytes` budget check).
    /// Called at most once per `analyze` invocation (every call site is a
    /// `return`), so `prior_rest`/`next_files` are always still owned,
    /// unmoved, at whichever single site actually calls this.
    ///
    /// Deliberately does NOT try to restore the byte-identical original
    /// `ProjectState` -- `next_files` may already hold partial progress
    /// (some `removed` paths already dropped, some `changed`/`added`
    /// sources already reparsed and merged in, or some paths already
    /// reresolved) by the time a bail happens, and reconstructing the
    /// exact pre-call snapshot would need the very clone this change
    /// exists to avoid. Instead, whatever `next_files` currently holds is
    /// paired with `prior_rest`'s fields taken from the ORIGINAL, pre-call
    /// `ProjectState` -- never this call's freshly computed
    /// `root_names`/`configuration_digest`/`source_metadata` locals (those
    /// describe the analysis this call never got to finish). That pairing
    /// is always safe, even when it doesn't exactly match the pre-call
    /// state: `analyze`'s own `reset_reason`/`authoritative_changed_paths`
    /// comparisons on the NEXT call key off `state.files.keys()` (for
    /// `prior_paths`) and `state.source_metadata` (for content-hash diffs)
    /// -- pairing a partially-advanced `files` with the OLD scalar fields
    /// can only make those comparisons MORE conservative (a spurious full
    /// `ResetReason`, or a path recomputed as `changed` when it already,
    /// unknowingly, wasn't), which just repeats some work on the next call.
    /// The unsafe direction -- `files` genuinely stale for a path while
    /// `source_metadata` already reports its NEW content hash, so a later
    /// read of that path's facts is silently wrong until its next edit --
    /// can only happen by pairing partial `files` with the FRESH metadata,
    /// which this function never does.
    fn restore_prior_on_bail(
        &mut self,
        project_key: &str,
        prior_rest: Option<ProjectState>,
        next_files: BTreeMap<String, SyntaxFileResult>,
    ) {
        if let Some(mut rest) = prior_rest {
            rest.files = next_files;
            self.projects.insert(project_key.to_string(), rest);
        }
    }
}

fn authoritative_changed_paths(
    change_set: &AuthoritativeChangeSet,
    current: &BTreeMap<String, SourceMetadata>,
    prior: Option<&BTreeMap<String, SourceMetadata>>,
    replayed_exact_ids: Option<&[String]>,
) -> Result<BTreeSet<String>, AnalysisError> {
    let AuthoritativeChangeSet::Exact {
        changed_artifact_ids,
    } = change_set
    else {
        return Ok(current.keys().cloned().collect());
    };
    if changed_artifact_ids
        .windows(2)
        .any(|pair| pair[0] >= pair[1])
    {
        return protocol_error("changed_artifact_ids must be UTF-8 sorted and duplicate-free");
    }

    let mut declared_ids = BTreeSet::new();
    for artifact_id in changed_artifact_ids {
        validate_identifier(artifact_id, "changed_artifact_id")?;
        if !declared_ids.insert(artifact_id.clone()) {
            return protocol_error("changed_artifact_ids must be duplicate-free");
        }
    }

    let mut paths_by_artifact_id = BTreeMap::<String, BTreeSet<String>>::new();
    for manifest in [prior, Some(current)].into_iter().flatten() {
        for (path, metadata) in manifest {
            paths_by_artifact_id
                .entry(metadata.artifact_id.clone())
                .or_default()
                .insert(path.clone());
        }
    }

    let mut declared_paths = BTreeSet::new();
    for artifact_id in &declared_ids {
        let artifact_paths = paths_by_artifact_id.get(artifact_id).ok_or_else(|| AnalysisError {
            code: ErrorCode::ProtocolInvalid,
            message: format!(
                "changed artifact id is absent from the current and retained manifests: {artifact_id}"
            ),
        })?;
        if artifact_paths.len() != 1 {
            return protocol_error("changed artifact id maps to more than one source path");
        }
        declared_paths.extend(artifact_paths.iter().cloned());
    }

    // A missing retained state is a genuine full-build boundary. The exact
    // set is still shape/member validated, but there is no prior manifest
    // against which the host declaration can be checked.
    let Some(prior) = prior else {
        return Ok(current.keys().cloned().collect());
    };

    // This comparison is validation only. Its result is never used as the
    // analysis scope: the returned paths above come exclusively from the
    // host-authoritative artifact ids.
    let mut observed_ids = BTreeSet::new();
    for (path, metadata) in current {
        match prior.get(path) {
            None => {
                observed_ids.insert(metadata.artifact_id.clone());
            }
            Some(previous) if previous != metadata => {
                observed_ids.insert(metadata.artifact_id.clone());
                if previous.artifact_id != metadata.artifact_id {
                    observed_ids.insert(previous.artifact_id.clone());
                }
            }
            Some(_) => {}
        }
    }
    for (path, metadata) in prior {
        if !current.contains_key(path) {
            observed_ids.insert(metadata.artifact_id.clone());
        }
    }
    let replay_matches =
        replayed_exact_ids.is_some_and(|artifact_ids| artifact_ids.iter().eq(declared_ids.iter()));
    if observed_ids != declared_ids && !replay_matches {
        return protocol_error(
            "authoritative changed_artifact_ids do not match the retained manifest transition",
        );
    }

    Ok(declared_paths)
}

fn same_source_content(
    left: &BTreeMap<String, SourceMetadata>,
    right: &BTreeMap<String, SourceMetadata>,
) -> bool {
    left.len() == right.len()
        && left.iter().all(|(path, metadata)| {
            right.get(path).is_some_and(|candidate| {
                candidate.artifact_id == metadata.artifact_id
                    && candidate.content_hash == metadata.content_hash
            })
        })
}

fn next_analysis_token(project_key: &str, sequence: u64) -> String {
    let mut digest = Sha256::new();
    digest.update(b"urdira:jsts:analysis-token:v1\0");
    digest.update(project_key.as_bytes());
    digest.update([0]);
    digest.update(sequence.to_be_bytes());
    let mut output = String::with_capacity(73);
    output.push_str("analysis:");
    use std::fmt::Write as _;
    for byte in digest.finalize() {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn validate_facts_cursor(
    project: &ProjectState,
    file: &SyntaxFileResult,
    cursor: FactsCursor,
) -> Result<(), AnalysisError> {
    let record_count = file.entities.len().saturating_add(file.relations.len());
    let dependency_count = resolved_dependencies(project, file).count();
    if cursor.imports_offset > file.direct_imports.len()
        || cursor.records_offset > record_count
        || cursor.dependencies_offset > dependency_count
    {
        return protocol_error("fact cursor is outside the owner result");
    }
    Ok(())
}

/// One path's complete fact set, `facts_for_paths`'s per-path result. Same
/// fields `FactsResult` carries for records/dependencies/direct_imports,
/// minus everything that only exists to serve the paged/budgeted wire
/// protocol (`content_digest`/`language`/`script_kind`/`byte_length`/
/// `parsed`/`diagnostics`/`next_cursor`/`metrics` — a v4 caller already has
/// all of that from `analyze()`'s own result, or (diagnostics) never wants
/// it at all, per `analyze.rs`'s module doc: "No `jsts:diagnostic` records
/// are produced anywhere in this module").
pub struct FactsForPath {
    pub path: String,
    pub direct_imports: Vec<DirectImport>,
    pub records: Vec<ProposedRecord>,
    pub dependencies: Vec<ProposedRecordDependency>,
}

fn facts_for_one_path(project: &ProjectState, path: &str) -> Result<FactsForPath, AnalysisError> {
    let file = project.files.get(path).ok_or_else(|| AnalysisError {
        code: ErrorCode::ProtocolInvalid,
        message: format!("fact path is not present in syntax project: {path}"),
    })?;
    let record_count = file.entities.len().saturating_add(file.relations.len());
    let dependency_count = resolved_dependencies(project, file).count();
    Ok(FactsForPath {
        path: path.to_owned(),
        direct_imports: file.direct_imports.clone(),
        records: proposed_records(file, 0, record_count),
        dependencies: proposed_dependencies(project, file, 0, dependency_count),
    })
}

fn remaining_fact_rows(
    project: &ProjectState,
    file: &SyntaxFileResult,
    cursor: FactsCursor,
) -> usize {
    file.direct_imports
        .len()
        .saturating_sub(cursor.imports_offset)
        .saturating_add(
            file.entities
                .len()
                .saturating_add(file.relations.len())
                .saturating_sub(cursor.records_offset),
        )
        .saturating_add(
            resolved_dependencies(project, file)
                .count()
                .saturating_sub(cursor.dependencies_offset),
        )
}

#[allow(clippy::too_many_arguments)]
fn build_facts_page(
    request_id: &str,
    cancellation_id: &str,
    project_key: &str,
    project: &ProjectState,
    file: &SyntaxFileResult,
    cursor: FactsCursor,
    row_budget: usize,
) -> Result<WorkerMessage, AnalysisError> {
    let mut remaining = row_budget;
    let import_end = cursor
        .imports_offset
        .saturating_add(remaining)
        .min(file.direct_imports.len());
    let direct_imports = file.direct_imports[cursor.imports_offset..import_end].to_vec();
    remaining = remaining.saturating_sub(direct_imports.len());

    let record_count = file.entities.len().saturating_add(file.relations.len());
    let record_end = cursor
        .records_offset
        .saturating_add(remaining)
        .min(record_count);
    let records = proposed_records(file, cursor.records_offset, record_end);
    remaining = remaining.saturating_sub(records.len());

    let dependency_count = resolved_dependencies(project, file).count();
    let dependency_end = cursor
        .dependencies_offset
        .saturating_add(remaining)
        .min(dependency_count);
    let dependencies =
        proposed_dependencies(project, file, cursor.dependencies_offset, dependency_end);
    let diagnostics = if cursor == FactsCursor::default() {
        file.diagnostics.clone()
    } else {
        Vec::new()
    };
    let next_cursor = if import_end == file.direct_imports.len()
        && record_end == record_count
        && dependency_end == dependency_count
    {
        None
    } else {
        Some(FactsCursor {
            imports_offset: import_end,
            records_offset: record_end,
            dependencies_offset: dependency_end,
        })
    };
    Ok(WorkerMessage::FactsResult {
        request_id: request_id.to_owned(),
        cancellation_id: cancellation_id.to_owned(),
        project_key: project_key.to_owned(),
        path: file.path.clone(),
        content_digest: file.content_digest.clone(),
        language: file.language,
        script_kind: file.script_kind,
        byte_length: file.byte_length,
        parsed: file.parsed,
        direct_imports,
        records,
        dependencies,
        diagnostics,
        next_cursor,
        metrics: FactsTransferMetrics {
            bytes_transferred: 0,
            bytes_copied: 0,
        },
    })
}

fn serialized_response_length(
    mut response: WorkerMessage,
) -> Result<(usize, WorkerMessage), AnalysisError> {
    for _ in 0..8 {
        let length = serde_json::to_vec(&response)
            .map_err(|_| AnalysisError {
                code: ErrorCode::AnalysisFailed,
                message: "fact response serialization failed".into(),
            })?
            .len();
        let metrics = match &mut response {
            WorkerMessage::FactsResult { metrics, .. }
            | WorkerMessage::FactsGroupResult { metrics, .. } => metrics,
            _ => return Ok((length, response)),
        };
        if metrics.bytes_transferred == length as u64 && metrics.bytes_copied == length as u64 {
            return Ok((length, response));
        }
        metrics.bytes_transferred = length as u64;
        metrics.bytes_copied = length as u64;
    }
    let length = serde_json::to_vec(&response)
        .map_err(|_| AnalysisError {
            code: ErrorCode::AnalysisFailed,
            message: "fact response serialization failed".into(),
        })?
        .len();
    Ok((length, response))
}

fn proposed_records(file: &SyntaxFileResult, start: usize, end: usize) -> Vec<ProposedRecord> {
    let mut records = Vec::with_capacity(end.saturating_sub(start));
    if start < file.entities.len() {
        let entity_end = end.min(file.entities.len());
        records.extend(file.entities[start..entity_end].iter().map(|entity| {
            // A4 (line numbers task): `file.entities` can hold a synthetic
            // external-package/symbol entity (`external_module_entity`/
            // `external_symbol_entity`, `path: "external:{specifier}"`,
            // `start`/`end` both `0`) alongside this file's own real
            // entities -- `file.line_index` is only valid for `file.path`
            // itself, so only use it when the entity's own `path` actually
            // matches (never a guess for the synthetic case).
            let line_index = (entity.path == file.path).then_some(&file.line_index);
            proposal_entity_record(entity, file.language, line_index)
        }));
    }
    let relation_start = start.saturating_sub(file.entities.len());
    let relation_end = end.saturating_sub(file.entities.len());
    if relation_start < file.relations.len() && relation_start < relation_end {
        // Every `SyntaxRelation` this crate ever builds carries `path: self.
        // path.clone()` (`push_relation`/`build_import_export_facts`), i.e.
        // always `file.path` itself -- unlike an entity, a relation never
        // has a synthetic cross-file `path`, so `file.line_index` always
        // applies here, unconditionally.
        records.extend(
            file.relations[relation_start..relation_end.min(file.relations.len())]
                .iter()
                .map(|relation| proposal_relation_record(relation, Some(&file.line_index))),
        );
    }
    records
}

fn proposal_entity_record(
    entity: &SyntaxEntity,
    language: Language,
    line_index: Option<&LineIndex>,
) -> ProposedRecord {
    let kind = match entity.universal_kind {
        UniversalKind::Type => "jsts:entity_type",
        UniversalKind::Callable => "jsts:entity_callable",
        UniversalKind::Container => "jsts:entity_container",
        UniversalKind::Value => "jsts:entity_variable",
        UniversalKind::Parameter => "jsts:entity_parameter",
    };
    // Cross-owner-dedup correctness bug found live 2026-09-05
    // (`n8n_incremental_create_delete_roots_match_oracle`'s `records` root
    // regression, root-caused via `debug_dump_external_entity_bodies`):
    // `jsts:external_module:*`/`jsts:external_symbol:*` entities are
    // documented (`external_module_entity`/`external_symbol_entity`'s own
    // doc comments) as "owner-independent by construction... a pure
    // function of specifier/name alone, never the importing file" -- a
    // claim `dedupe_external_entities_across_owners`
    // (`urdira-indexing-worker::v4::analyze`) relies on to justify keeping
    // just ONE of many identical per-owner proposals. But every entity
    // (this function is the ONLY producer of an entity's `body`, for every
    // `EntityKind` alike) used to get the CALLING file's own `language`
    // stamped in regardless of kind -- so two files importing the SAME
    // external specifier, one `.ts` and one `.js`, propose the SAME
    // identity with DIFFERENT bodies, breaking the "pure function" claim.
    // Harmless at a COLD scan (dedup picks whichever owner is
    // alphabetically first, deterministically, forever, as long as that
    // exact file exists) -- but confirmed live to break root-parity the
    // moment that owner is DELETED: an incremental scan and a from-scratch
    // oracle of the same mutated tree can pick DIFFERENT alphabetically-
    // first REMAINING importers with different languages, producing
    // genuinely different bodies/digests for the identical identity_key
    // (`node:test#after`: `language=typescript` under the original owner,
    // `language=javascript` under the oracle's replacement owner).
    // `record_id`/`record_digest` are pure kernel functions of this body
    // (`urdira-native-core::structural_record_digest_hash`) -- once they
    // differ, no `diff_owner` reopen/migration case can ever reproduce a
    // from-scratch oracle's plain first-occurrence id anyway (chaining
    // ALWAYS mints a new, non-oracle-matching id -- see `diff.rs`'s
    // `chained_record_id`), so the only real fix is to stop the body from
    // varying with the importer at all, exactly as the two builders' own
    // doc comments already (aspirationally) promised. Fixed by stamping a
    // FIXED, canonical language for these two kinds only -- every other
    // entity kind's real, per-file language stamp is unchanged.
    let external_entity = matches!(
        entity.kind,
        EntityKind::ExternalModule | EntityKind::ExternalSymbol
    );
    let stamped_language = if external_entity {
        Language::Typescript
    } else {
        language
    };
    // A3b: fields written in strict lexicographic key order (`end`,
    // `is_test`?, `kind`, `language`, `name`, `parent_id`?, `path`,
    // `qualified_name`?, `start`) -- the same order `serde_json::Map`'s
    // `BTreeMap` iteration already produced for the equivalent `Value`
    // tree (no `preserve_order` feature anywhere in this workspace).
    let mut field_count = 6;
    if entity.parent_id.is_some() {
        field_count += 1;
    }
    if entity.qualified_name.is_some() {
        field_count += 1;
    }
    if entity.is_test.is_some() {
        field_count += 1;
    }
    let mut encoder = urdira_native_core::BodyEncoder::new();
    encoder
        .begin_object(field_count)
        .expect("entity body field count is fixed");
    encoder.key("end").expect("entity body key order");
    encoder
        .uint(u64::from(entity.end))
        .expect("entity end is a finite u32");
    if let Some(is_test) = entity.is_test {
        encoder.key("is_test").expect("entity body key order");
        encoder.bool(is_test).expect("bool never fails");
    }
    encoder.key("kind").expect("entity body key order");
    encoder
        .string(entity_kind_name(entity.kind))
        .expect("string never fails");
    encoder.key("language").expect("entity body key order");
    encoder
        .string(language_name(stamped_language))
        .expect("string never fails");
    encoder.key("name").expect("entity body key order");
    encoder.string(&entity.name).expect("string never fails");
    if let Some(parent_id) = &entity.parent_id {
        encoder.key("parent_id").expect("entity body key order");
        encoder.string(parent_id).expect("string never fails");
    }
    encoder.key("path").expect("entity body key order");
    encoder.string(&entity.path).expect("string never fails");
    if let Some(qualified_name) = &entity.qualified_name {
        encoder
            .key("qualified_name")
            .expect("entity body key order");
        encoder.string(qualified_name).expect("string never fails");
    }
    encoder.key("start").expect("entity body key order");
    encoder
        .uint(u64::from(entity.start))
        .expect("entity start is a finite u32");
    let body = encoder.finish();
    let facets = if entity.parent_id.is_none() {
        serde_json::json!(["core:declaration", "core:definition"])
    } else {
        serde_json::json!(["core:declaration", "core:definition", "core:member"])
    };
    let facets_list = facets_list_from_value(&facets);
    let (span_start_line, span_end_line) = match line_index {
        Some(index) => (index.line_of(entity.start), index.line_of(entity.end)),
        None => (0, 0),
    };
    ProposedRecord {
        proposal_record_key: proposal_record_key(&entity.id),
        category: "entity",
        kind: kind.into(),
        universal_kind: universal_kind_name(entity.universal_kind).into(),
        facets: canonical_json(&facets),
        schema_version: 1,
        source_span: canonical_span(&entity.path, entity.start, entity.end),
        span_start_line,
        span_end_line,
        identity_key: entity.id.clone(),
        body: RecordBody::Encoded(body),
        source_id: None,
        target_id: None,
        evidence_references: canonical_evidence(&entity.path, entity.start, entity.end),
        facets_list,
    }
}

fn proposal_relation_record(
    relation: &SyntaxRelation,
    line_index: Option<&LineIndex>,
) -> ProposedRecord {
    // A3b: strict lexicographic key order (`classification`, `end`, `path`,
    // `source_id`, `start`, `target_id`?) -- same order as `serde_json::
    // Map`'s `BTreeMap` iteration for the equivalent `Value` tree.
    let field_count = if relation.target_id.is_some() { 6 } else { 5 };
    let mut encoder = urdira_native_core::BodyEncoder::new();
    encoder
        .begin_object(field_count)
        .expect("relation body field count is fixed");
    encoder
        .key("classification")
        .expect("relation body key order");
    encoder
        .string(relation_classification_name(relation.classification))
        .expect("string never fails");
    encoder.key("end").expect("relation body key order");
    encoder
        .uint(u64::from(relation.end))
        .expect("relation end is a finite u32");
    encoder.key("path").expect("relation body key order");
    encoder.string(&relation.path).expect("string never fails");
    encoder.key("source_id").expect("relation body key order");
    encoder
        .string(&relation.source_id)
        .expect("string never fails");
    encoder.key("start").expect("relation body key order");
    encoder
        .uint(u64::from(relation.start))
        .expect("relation start is a finite u32");
    if let Some(target_id) = &relation.target_id {
        encoder.key("target_id").expect("relation body key order");
        encoder.string(target_id).expect("string never fails");
    }
    let body = encoder.finish();
    let source_id = Some(relation.source_id.clone());
    let target_id = relation.target_id.clone();
    let facets = if relation.kind == RelationKind::Contains {
        serde_json::json!(["core:structural_relation"])
    } else if relation.classification == RelationClassification::Possible {
        serde_json::json!(["core:reference_relation", "core:indirect"])
    } else {
        serde_json::json!(["core:reference_relation"])
    };
    let facets_list = facets_list_from_value(&facets);
    let (span_start_line, span_end_line) = match line_index {
        Some(index) => (index.line_of(relation.start), index.line_of(relation.end)),
        None => (0, 0),
    };
    ProposedRecord {
        proposal_record_key: proposal_record_key(&relation.id),
        category: "relation",
        kind: format!("jsts:relation_{}", relation.kind.identity_name()),
        universal_kind: relation_kind_name(relation.kind).into(),
        facets: canonical_json(&facets),
        schema_version: 1,
        source_span: canonical_span(&relation.path, relation.start, relation.end),
        span_start_line,
        span_end_line,
        identity_key: relation.id.clone(),
        body: RecordBody::Encoded(body),
        source_id,
        target_id,
        evidence_references: canonical_evidence(&relation.path, relation.start, relation.end),
        facets_list,
    }
}

/// External package/symbol entities task (2026-09-04): the `SyntaxEntity`
/// for `jsts:external_module:{specifier}`. Owner-independent by
/// construction -- `path`/`start`/`end` are synthetic and never vary with
/// the importing file, so every importer of the same `specifier` builds a
/// byte-identical entity -- see `urdira-indexing-worker::v4::analyze::
/// run_scoped`'s cross-owner dedup pass (the mechanism that makes a single
/// visible record survive many identical per-owner proposals) for why that
/// determinism is load-bearing, not incidental. `path` uses a synthetic
/// `external:{specifier}` value (never a real workspace path, and never
/// read by anything that expects a real artifact path -- see the entity
/// schema's own `path` field, a free descriptive string) rather than the
/// empty string, so a human or a debugging tool reading the record body can
/// still tell at a glance that it names an external package, not a
/// workspace file with an empty path.
pub(crate) fn external_module_entity(specifier: &str) -> SyntaxEntity {
    SyntaxEntity {
        id: resolver::external_module_id(specifier),
        name: specifier.to_owned(),
        kind: EntityKind::ExternalModule,
        universal_kind: UniversalKind::Container,
        path: format!("external:{specifier}"),
        start: 0,
        end: 0,
        parent_id: None,
        qualified_name: None,
        is_test: None,
    }
}

/// External package/symbol entities task: the `SyntaxEntity` for
/// `jsts:external_symbol:{specifier}#{name}`. `is_type` selects `core:type`
/// (an `import type`/`export type` binding) over `core:value` -- see
/// [`external_module_entity`]'s doc comment for why every field here is a
/// pure function of `(specifier, name, is_type)`, never the importing file.
pub(crate) fn external_symbol_entity(specifier: &str, name: &str, is_type: bool) -> SyntaxEntity {
    SyntaxEntity {
        id: resolver::external_symbol_id(specifier, name),
        name: name.to_owned(),
        kind: EntityKind::ExternalSymbol,
        universal_kind: if is_type {
            UniversalKind::Type
        } else {
            UniversalKind::Value
        },
        path: format!("external:{specifier}"),
        start: 0,
        end: 0,
        parent_id: Some(resolver::external_module_id(specifier)),
        qualified_name: Some(format!("{specifier}.{name}")),
        is_test: None,
    }
}

/// External package/symbol entities task: the `core:contains` `SyntaxEntity`
/// -> `SyntaxEntity` edge from an external module to one of its symbols, for
/// ONE occurrence (`owner_path`/`start`/`end` are the occurrence's own
/// site -- the importing declaration or member-access use, UNLIKE the two
/// entity builders above, which are occurrence-independent). Multiple
/// importers/occurrences of the same `(specifier, name)` pair each propose
/// their own `core:contains` row here, differentiated by `(owner_path,
/// start, end)` exactly like `core:import`/`core:call`/... already are --
/// no cross-owner dedup needed for this one, only the two ENTITY rows above
/// need it (a relation's identity already varies per occurrence).
pub(crate) fn external_contains_relation(
    specifier: &str,
    name: &str,
    owner_path: &str,
    start: u32,
    end: u32,
) -> SyntaxRelation {
    let source_id = resolver::external_module_id(specifier);
    let target_id = resolver::external_symbol_id(specifier, name);
    let id = format!("jsts:contains:{owner_path}:{start}:{end}:{source_id}:{target_id}");
    SyntaxRelation {
        id,
        kind: RelationKind::Contains,
        source_id,
        target_id: Some(target_id),
        path: owner_path.to_owned(),
        start,
        end,
        classification: RelationClassification::Confirmed,
    }
}

fn proposed_dependencies(
    project: &ProjectState,
    file: &SyntaxFileResult,
    start: usize,
    end: usize,
) -> Vec<ProposedRecordDependency> {
    resolved_dependencies(project, file)
        .skip(start)
        .take(end.saturating_sub(start))
        .map(|(relation, metadata, target_path)| {
            let proposal_record_key = proposal_record_key(&relation.id);
            let mut source_reference = serde_json::Map::new();
            source_reference.insert(
                "reference_type".into(),
                serde_json::Value::String("local_proposal".into()),
            );
            source_reference.insert(
                "proposal_record_key".into(),
                serde_json::Value::String(proposal_record_key.clone()),
            );
            source_reference.insert(
                "content_hash".into(),
                serde_json::Value::String(metadata.content_hash.clone()),
            );
            ProposedRecordDependency {
                proposed_dependency_id: proposed_dependency_id(
                    &relation.id,
                    &metadata.artifact_version_id,
                ),
                proposal_record_key,
                dependency_artifact_id: metadata.artifact_id.clone(),
                dependency_artifact_version_id: metadata.artifact_version_id.clone(),
                dependency_target_path: target_path.to_string(),
                dependency_role: "jsts:resolution_input",
                dependency_basis: "checker_resolution",
                source_reference: serde_json::Value::Object(source_reference),
            }
        })
        .collect()
}

fn proposed_dependency_id(relation_id: &str, artifact_version_id: &str) -> String {
    bounded_sha256_identity(
        "jsts:dependency:sha256:",
        b"urdira:jsts-proposed-dependency:v1\0",
        &[relation_id, artifact_version_id],
    )
}

pub(crate) fn proposal_record_key(identity_key: &str) -> String {
    bounded_sha256_identity(
        "jsts:record:sha256:",
        b"urdira:jsts-proposal-record:v1\0",
        &[identity_key],
    )
}

pub(crate) fn bounded_sha256_identity(prefix: &str, domain: &[u8], values: &[&str]) -> String {
    use std::fmt::Write as _;

    let mut hash = Sha256::new();
    hash.update(domain);
    for value in values {
        let bytes = value.as_bytes();
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    }
    let mut identity = String::with_capacity(prefix.len() + 64);
    identity.push_str(prefix);
    for byte in hash.finalize() {
        let _ = write!(identity, "{byte:02x}");
    }
    identity
}

/// Third tuple element is the dependency TARGET's raw path -- P3-2 item 3
/// needs this (not just `metadata.artifact_id`/`artifact_version_id`) to
/// build a `dependency_id` that is comparable across two independent scans
/// of the SAME content: `artifact_id` is salted with `workspace_id`
/// (`urdira-source-frontier::ids::artifact_id`) and `artifact_version_id`
/// is additionally salted with the scan's own `generation`
/// (`ids::artifact_version_id` -> `source_observation_id` ->
/// `observation_batch_id(workspace_id, generation)`) -- neither is stable
/// across an incremental store (built across several generations, one
/// workspace_id) versus an independent from-scratch oracle scan (always
/// generation 1, and in practice often a DIFFERENT workspace_id, e.g. a
/// throwaway comparison workspace) of otherwise-identical content. The raw
/// PATH has neither salt -- the same primitive `stable_entity_id`'s own
/// `jsts:entity_container`/module identity already uses, which is why
/// `records`/`graph` roots already compare correctly across such scans
/// (confirmed live, `urdira-indexing-worker`'s n8n-scale oracle test).
fn resolved_dependencies<'a>(
    project: &'a ProjectState,
    file: &'a SyntaxFileResult,
) -> impl Iterator<Item = (&'a SyntaxRelation, &'a SourceMetadata, &'a str)> + 'a {
    file.relations.iter().filter_map(move |relation| {
        if !matches!(relation.kind, RelationKind::Import | RelationKind::Export) {
            return None;
        }
        let target_id = relation.target_id.as_deref()?;
        let target_path = file.direct_imports.iter().find_map(|import| {
            let expected_kind = match import.kind {
                ImportKind::Import => RelationKind::Import,
                ImportKind::Export => RelationKind::Export,
                ImportKind::DynamicImport | ImportKind::Require => return None,
            };
            let path = import.target_path.as_deref()?;
            (expected_kind == relation.kind
                && import.start == relation.start
                && import.end == relation.end
                && stable_entity_id(EntityKind::Module, path, 0, path) == target_id)
                .then_some(path)
        })?;
        let metadata = project.source_metadata.get(target_path)?;
        (target_path != file.path).then_some((relation, metadata, target_path))
    })
}

pub(crate) fn canonical_json(value: &serde_json::Value) -> String {
    serde_json::to_string(value).expect("stage-one facts contain only JSON values")
}

pub(crate) fn canonical_span(path: &str, start: u32, end: u32) -> String {
    canonical_json(&serde_json::json!({ "path": path, "start": start, "end": end }))
}

pub(crate) fn canonical_evidence(path: &str, start: u32, end: u32) -> String {
    canonical_json(&serde_json::json!([{ "path": path, "start": start, "end": end }]))
}

/// P2-2l item 2: extracts the flat string list every `facets` value this
/// crate builds is derived from (`json!([...])`, always a JSON array of
/// plain strings -- confirmed by reading every `ProposedRecord` producer
/// in this crate, `lib.rs`'s two and `semantic_sites.rs`'s seven) directly
/// from the SAME `Value` fed to `canonical_json` for the text field, so
/// `ProposedRecord::facets_list` can never drift from `ProposedRecord::
/// facets`. Panics only if a producer ever stops building `facets` this
/// way (a programmer error caught immediately by any test exercising that
/// producer, not a real-input data-shape possibility).
pub(crate) fn facets_list_from_value(value: &serde_json::Value) -> Vec<String> {
    value
        .as_array()
        .expect("facets is always built as a JSON array literal")
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .expect("facets entries are always string literals")
                .to_owned()
        })
        .collect()
}

const fn entity_kind_name(kind: EntityKind) -> &'static str {
    kind.identity_name()
}

const fn universal_kind_name(kind: UniversalKind) -> &'static str {
    match kind {
        UniversalKind::Container => "core:container",
        UniversalKind::Callable => "core:callable",
        UniversalKind::Type => "core:type",
        UniversalKind::Value => "core:value",
        UniversalKind::Parameter => "core:parameter",
    }
}

const fn relation_kind_name(kind: RelationKind) -> &'static str {
    match kind {
        RelationKind::Contains => "core:contains",
        RelationKind::Import => "core:import",
        RelationKind::Export => "core:export",
    }
}

const fn relation_classification_name(classification: RelationClassification) -> &'static str {
    match classification {
        RelationClassification::Confirmed => "confirmed",
        RelationClassification::Possible => "possible",
    }
}

const fn language_name(language: Language) -> &'static str {
    match language {
        Language::Javascript => "javascript",
        Language::Typescript => "typescript",
    }
}

pub fn handshake(
    request_id: String,
    protocol_identity: String,
    protocol_version: u8,
    expected_build_identity: String,
    max_frame_chunk_bytes: u32,
    max_message_bytes: u32,
) -> Result<WorkerMessage, AnalysisError> {
    validate_identifier(&request_id, "request_id")?;
    if protocol_identity != PROTOCOL_IDENTITY
        || protocol_version != PROTOCOL_VERSION
        || max_frame_chunk_bytes != MAX_FRAME_CHUNK_BYTES as u32
        || max_message_bytes > MAX_MESSAGE_BYTES as u32
    {
        return Err(AnalysisError {
            code: ErrorCode::ProtocolInvalid,
            message: "host protocol identity or transport budgets are incompatible".into(),
        });
    }
    if expected_build_identity != WORKER_BUILD_IDENTITY {
        return Err(AnalysisError {
            code: ErrorCode::BuildIdentityMismatch,
            message: "requested worker build identity does not match this executable".into(),
        });
    }
    Ok(WorkerMessage::HandshakeAck {
        request_id,
        protocol_identity: PROTOCOL_IDENTITY,
        protocol_version: PROTOCOL_VERSION,
        worker_build_identity: WORKER_BUILD_IDENTITY,
        max_frame_chunk_bytes: MAX_FRAME_CHUNK_BYTES as u32,
        max_message_bytes: MAX_MESSAGE_BYTES as u32,
    })
}

fn validate_sources(
    sources: Vec<SourceInput>,
    max_source_bytes: u32,
) -> Result<Vec<ValidatedSource>, AnalysisError> {
    let mut validated = Vec::with_capacity(sources.len());
    let mut seen_paths = BTreeSet::new();
    let mut seen_artifact_ids = BTreeSet::new();
    let mut total = 0usize;
    for source in sources {
        validate_path(&source.path)?;
        validate_identifier(&source.artifact_id, "artifact_id")?;
        validate_identifier(&source.artifact_version_id, "artifact_version_id")?;
        validate_digest(&source.content_digest, "content_digest")?;
        if !seen_paths.insert(source.path.clone()) {
            return protocol_error("source paths must be duplicate-free");
        }
        if !seen_artifact_ids.insert(source.artifact_id.clone()) {
            return protocol_error("source artifact ids must be duplicate-free");
        }
        let (language, script_kind) =
            language_for_path(&source.path).ok_or_else(|| AnalysisError {
                code: ErrorCode::UnsupportedSource,
                message: "source extension is not JavaScript, JSX, TypeScript, or TSX".into(),
            })?;
        let blob_path = Path::new(&source.source_blob_path);
        if !blob_path.is_absolute() {
            return protocol_error("source blob paths must be absolute");
        }
        total = total
            .checked_add(source.byte_length)
            .ok_or_else(|| AnalysisError {
                code: ErrorCode::ResourceExhausted,
                message: "source byte count overflow".into(),
            })?;
        if total > max_source_bytes as usize {
            return resource_error("source bytes exceed max_source_bytes");
        }
        validated.push(ValidatedSource {
            path: source.path,
            artifact_id: source.artifact_id,
            artifact_version_id: source.artifact_version_id,
            content_digest: source.content_digest,
            source_blob_path: source.source_blob_path,
            byte_length: source.byte_length,
            language,
            script_kind,
        });
    }
    validated.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(validated)
}

fn decode_source(source: &ValidatedSource) -> Result<DecodedSource, AnalysisError> {
    let bytes = fs::read(&source.source_blob_path).map_err(|_| AnalysisError {
        code: ErrorCode::AnalysisFailed,
        message: format!("cannot read explicit source blob for {}", source.path),
    })?;
    if bytes.len() != source.byte_length {
        return Err(AnalysisError {
            code: ErrorCode::SourceDigestMismatch,
            message: format!("source byte length mismatch for {}", source.path),
        });
    }
    let actual = sha256_digest(&bytes);
    if actual != source.content_digest {
        return Err(AnalysisError {
            code: ErrorCode::SourceDigestMismatch,
            message: format!("source digest mismatch for {}", source.path),
        });
    }
    Ok(DecodedSource {
        path: source.path.clone(),
        content_digest: source.content_digest.clone(),
        bytes,
        language: source.language,
        script_kind: source.script_kind,
    })
}

/// Total content this worker will ever read for config assets in one
/// `analyze` call. Generous relative to any real workspace's
/// `package.json`/`tsconfig.json`/`pnpm-workspace.yaml` footprint (these are
/// small, hand-authored control files, never generated at source-file
/// scale); exists purely as a resource-exhaustion backstop, matching
/// `AnalysisBudgets`' role for `sources`.
const MAX_CONFIG_ASSET_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CONFIG_ASSETS: usize = 16_384;

/// Fold every config asset's WIRE content digest (not whether it happened
/// to parse -- see the call site's doc comment) into `base`, producing the
/// digest this project's incremental syntax state is actually keyed on.
/// Order-independent input (sorted by path) so the result is stable
/// regardless of caller-supplied ordering.
fn fold_configuration_digest(base: &str, config_assets: &[ConfigAssetInput]) -> String {
    let mut sorted: Vec<&ConfigAssetInput> = config_assets.iter().collect();
    sorted.sort_by(|left, right| left.path.cmp(&right.path));
    let mut buffer = String::from("urdira:jsts-configuration-digest:v1\0");
    buffer.push_str(base);
    for asset in sorted {
        buffer.push('\0');
        buffer.push_str(&asset.path);
        buffer.push('\0');
        buffer.push_str(&asset.content_digest);
    }
    sha256_digest(buffer.as_bytes())
}

/// Validate protocol shape (path format, digest format, duplicate-free
/// paths, a resource-exhaustion backstop) strictly -- same posture as
/// `validate_sources` -- but degrade a single asset's CONTENT problem
/// (unreadable blob, byte-length/digest mismatch, invalid UTF-8) by
/// dropping just that asset rather than failing the whole analysis. A
/// config asset is a best-effort resolution hint, not authoritative source:
/// losing one narrows `WorkspaceResolver`'s coverage for that file, it does
/// not corrupt anything.
/// Public re-export of the same best-effort decode `analyze` uses
/// internally, for the orchestrator (`urdira-indexing-worker`'s
/// `run_jsts_generation`) to build the SAME `WorkspaceResolver` this
/// generation's lane 1 used, for the hybrid lane's `HybridResolutionContext`
/// (see `semantic_sites.rs`). Kept as one function (not duplicated) so the
/// two lanes can never disagree about which config assets counted.
pub fn decode_config_assets(
    assets: Vec<ConfigAssetInput>,
) -> Result<Vec<resolver::ConfigAsset>, AnalysisError> {
    decode_config_assets_inner(assets)
}

fn decode_config_assets_inner(
    assets: Vec<ConfigAssetInput>,
) -> Result<Vec<resolver::ConfigAsset>, AnalysisError> {
    if assets.len() > MAX_CONFIG_ASSETS {
        return resource_error("config asset count exceeds the resolver limit");
    }
    let mut seen_paths = BTreeSet::new();
    let mut total_bytes = 0u64;
    let mut decoded = Vec::with_capacity(assets.len());
    for asset in assets {
        validate_path(&asset.path)?;
        validate_digest(&asset.content_digest, "config asset content_digest")?;
        if !seen_paths.insert(asset.path.clone()) {
            return protocol_error("config asset paths must be duplicate-free");
        }
        total_bytes = total_bytes
            .checked_add(asset.byte_length as u64)
            .ok_or_else(|| AnalysisError {
                code: ErrorCode::ResourceExhausted,
                message: "config asset byte count overflow".into(),
            })?;
        if total_bytes > MAX_CONFIG_ASSET_BYTES {
            return resource_error("config asset bytes exceed the resolver limit");
        }
        let Ok(bytes) = fs::read(&asset.source_blob_path) else {
            continue;
        };
        if bytes.len() != asset.byte_length || sha256_digest(&bytes) != asset.content_digest {
            continue;
        }
        let Ok(content) = String::from_utf8(bytes) else {
            continue;
        };
        decoded.push(resolver::ConfigAsset {
            path: asset.path,
            content,
        });
    }
    Ok(decoded)
}

fn parse_source(
    source: &DecodedSource,
    available: &BTreeSet<String>,
    resolver: &WorkspaceResolver,
) -> Result<SyntaxFileResult, AnalysisError> {
    let text = std::str::from_utf8(&source.bytes).map_err(|_| AnalysisError {
        code: ErrorCode::ProtocolInvalid,
        message: format!("source {} is not UTF-8", source.path),
    })?;
    let source_type =
        SourceType::from_path(Path::new(&source.path)).map_err(|_| AnalysisError {
            code: ErrorCode::UnsupportedSource,
            message: format!("unsupported source type for {}", source.path),
        })?;
    let is_typescript_definition = source_type.is_typescript_definition();
    let allocator = Allocator::default();
    let mut parsed = Parser::new(&allocator, text, source_type).parse();
    Utf8ToUtf16::new(text).convert_program(&mut parsed.program);
    let mut collector = SyntaxCollector::new(&source.path, text.encode_utf16().count() as u32);
    collector.visit_program(&parsed.program);
    // Ambient module resolution task (2026-09-04) follow-up: patch every
    // `declare module` block this file collected with the file's real
    // script-vs-module status -- see `AmbientModuleDeclaration::is_
    // augmentation`'s own doc comment for why this can only be known AFTER
    // the whole-file walk completes (a top-level `import`/`export`
    // anywhere in the file, not just before the `declare module` block,
    // makes it a module augmentation). Skipped entirely when this file
    // declared no ambient modules at all (the overwhelming majority) --
    // `file_has_top_level_module_syntax` is never worth the scan otherwise.
    // D.1 (2026-09-05, references-parity task): script-top-level ambient
    // global candidates -- a flat, non-recursive scan of `program.body`
    // appended AFTER the walk so it runs alongside (and shares the exact
    // same whole-file script-vs-module fact as) the `is_augmentation` patch
    // just below. `DeclareGlobal` candidates (from `visit_ts_global_
    // declaration`, during the walk above) are already in `collector.
    // ambient_globals` at this point and are never touched here.
    collector
        .ambient_globals
        .extend(script_top_level_ambient_global_candidates(
            &parsed.program.body,
            &source.path,
        ));
    if !collector.ambient_modules.is_empty()
        || collector
            .ambient_globals
            .iter()
            .any(|global| global.scope == GlobalScope::ScriptTopLevel)
    {
        let is_augmentation = file_has_top_level_module_syntax(&parsed.program.body);
        for declaration in &mut collector.ambient_modules {
            declaration.is_augmentation = is_augmentation;
        }
        // A MODULE file's own top level never extends the shared global
        // scope (see `GlobalScope::ScriptTopLevel`'s own doc comment) --
        // `DeclareGlobal` candidates are unaffected, kept unconditionally.
        if is_augmentation {
            collector
                .ambient_globals
                .retain(|global| global.scope != GlobalScope::ScriptTopLevel);
        }
    }
    // Class/interface MEMBER entities (method/constructor/getter/setter/
    // property): a distinct pass, deliberately not folded into the `Visit`
    // walk above, because its discovery surface must match `urdira_jsts_
    // typeflow::member_declarations`'s own (module-level/`export`-only,
    // anonymous class skipped) byte for byte -- see that function's own doc
    // comment for why a plain recursive `Visit` (which also descends into a
    // class nested inside a function body) would over-collect relative to
    // what typeflow's `ProgramIndex` ever builds a `MemberEntry` for.
    let member_declarations =
        urdira_jsts_typeflow::member_declarations(&parsed.program, &source.path);
    collector.push_member_entities(&member_declarations);
    for import in &mut collector.imports {
        import.target_path = resolver.resolve(&source.path, &import.specifier, available);
    }
    for binding in &mut collector.export_bindings {
        if let Some(specifier) = &binding.source_specifier {
            binding.source_target_path = resolver.resolve(&source.path, specifier, available);
        }
    }
    for star in &mut collector.export_star_specifiers {
        star.target_path = resolver.resolve(&source.path, &star.specifier, available);
    }
    collector.imports.sort_by(|left, right| {
        (left.start, left.end, left.kind, &left.specifier).cmp(&(
            right.start,
            right.end,
            right.kind,
            &right.specifier,
        ))
    });
    collector.imports.dedup();
    collector.finish_import_relations();
    collector
        .entities
        .sort_by(|left, right| left.id.cmp(&right.id));
    collector
        .relations
        .sort_by(|left, right| left.id.cmp(&right.id));
    collector.export_bindings.sort();
    collector.export_bindings.dedup();
    collector.export_star_specifiers.sort();
    collector.export_star_specifiers.dedup();
    collector
        .ambient_modules
        .sort_by(|left, right| left.namespace_entity_id.cmp(&right.namespace_entity_id));
    collector
        .ambient_globals
        .sort_by(|left, right| left.entity_id.cmp(&right.entity_id));
    collector.namespace_members.sort_by(|left, right| {
        (
            &left.namespace_entity_id,
            &left.name,
            &left.member_entity_id,
        )
            .cmp(&(
                &right.namespace_entity_id,
                &right.name,
                &right.member_entity_id,
            ))
    });
    let diagnostics = parsed
        .diagnostics
        .into_iter()
        // TS1038 is an ambient-context semantic diagnostic. Valid ecosystem
        // declaration files commonly contain nested `declare` forms and the
        // pinned TypeScript checker, not Oxc stage one, owns that decision.
        .filter(|diagnostic| {
            !(is_typescript_definition
                && diagnostic.code.scope.as_deref() == Some("TS")
                && diagnostic.code.number.as_deref() == Some("1038"))
        })
        .map(|diagnostic| SyntaxDiagnostic {
            message: truncate_message(&diagnostic.to_string()),
            start: 0,
            end: 0,
        })
        .collect::<Vec<_>>();
    Ok(SyntaxFileResult {
        path: source.path.clone(),
        content_digest: source.content_digest.clone(),
        language: source.language,
        script_kind: source.script_kind,
        byte_length: source.bytes.len(),
        parsed: !parsed.panicked && diagnostics.is_empty(),
        direct_imports: collector.imports,
        entities: collector.entities,
        relations: collector.relations,
        diagnostics,
        export_bindings: collector.export_bindings,
        export_star_specifiers: collector.export_star_specifiers,
        ambient_modules: collector.ambient_modules,
        ambient_globals: collector.ambient_globals,
        namespace_members: collector.namespace_members,
        line_index: LineIndex::from_text(text),
    })
}

/// A5b (2026-09-05 references-parity task, bucket 1): what an imported LOCAL
/// binding names in its OWN source module, per `SyntaxCollector::
/// imported_locals`'s own doc comment -- `Named` carries the imported name
/// (`import { a as b }` -> local `b` maps to `Named("a")`; `import { a }`
/// maps to `Named("a")` too, same name either side), `Default` an
/// `import local from "spec"`, `Namespace` an `import * as local from
/// "spec"`.
#[derive(Debug, Clone)]
enum ImportedName {
    Named(String),
    Default,
    Namespace,
}

struct SyntaxCollector {
    path: String,
    module_id: String,
    imports: Vec<DirectImport>,
    entities: Vec<SyntaxEntity>,
    relations: Vec<SyntaxRelation>,
    node_test_from: bool,
    export_bindings: Vec<SyntaxExportBinding>,
    export_star_specifiers: Vec<ExportStarSpecifier>,
    /// Ambient module resolution task (2026-09-04): every top-level
    /// `declare module "specifier" { ... }` this file declares -- see
    /// `SyntaxFileResult::ambient_modules`'s own doc comment.
    ambient_modules: Vec<AmbientModuleDeclaration>,
    /// D.1 (2026-09-05, references-parity task): see `SyntaxFileResult::
    /// ambient_globals`'s own doc comment. Populated from two sources: the
    /// `visit_ts_global_declaration` override below (`DeclareGlobal`
    /// candidates, during the walk) and a post-`visit_program` flat scan of
    /// `parsed.program.body` in `parse_source` (`ScriptTopLevel`
    /// candidates, filtered there once script-vs-module is known).
    ambient_globals: Vec<AmbientGlobalDeclaration>,
    /// D.3 (2026-09-05, references-parity task): see `SyntaxFileResult::
    /// namespace_members`'s own doc comment. Populated by `visit_ts_module_
    /// declaration`'s `Identifier`-named branch.
    namespace_members: Vec<NamespaceMember>,
    /// A5b (2026-09-05 references-parity task, bucket 1 --
    /// `import_binding/export:unresolved`, 1,340 workspace sites): every
    /// local binding this file's own `import` statements introduce, keyed by
    /// that LOCAL name -- populated in `visit_import_declaration`, consulted
    /// in `visit_export_specifier` so a barrel doing `import { X } from
    /// './x'; export { X };` (a re-export with NO `from` clause on the
    /// `export` itself) is recognized as a re-export of the IMPORTED `X`,
    /// not a local declaration named `X` (there is none -- the previous
    /// behavior treated `local_name: "X"` as a same-file declaration name for
    /// `resolver::resolve_direct_export` to look up, which never finds one
    /// for a purely re-exported import, and stayed `Unresolved` forever).
    /// Never cleared/consulted across files (one `SyntaxCollector` per file).
    imported_locals: HashMap<String, (String, ImportedName)>,
}

impl SyntaxCollector {
    fn new(path: &str, source_end: u32) -> Self {
        let module_id = stable_entity_id(EntityKind::Module, path, 0, path);
        Self {
            path: path.to_owned(),
            module_id: module_id.clone(),
            imports: Vec::new(),
            entities: vec![SyntaxEntity {
                id: module_id,
                name: path.to_owned(),
                kind: EntityKind::Module,
                universal_kind: UniversalKind::Container,
                path: path.to_owned(),
                start: 0,
                end: source_end,
                parent_id: None,
                qualified_name: None,
                is_test: None,
            }],
            relations: Vec::new(),
            node_test_from: false,
            export_bindings: Vec::new(),
            export_star_specifiers: Vec::new(),
            ambient_modules: Vec::new(),
            ambient_globals: Vec::new(),
            namespace_members: Vec::new(),
            imported_locals: HashMap::new(),
        }
    }

    /// Direct-declaration export names (E2): `export function/class/const/
    /// let/var/interface/type/enum/namespace <name>` (the `Identifier`-
    /// named namespace form only -- see `declaration_export_names`'s own
    /// doc comment). Multiple names for a single `export const a = 1, b =
    /// 2;` -- one binding per declarator, matching `entities`' own
    /// one-entity-per-declarator granularity.
    fn push_direct_export_names(&mut self, names: Vec<(u32, String)>) {
        for (_, name) in names {
            self.export_bindings.push(SyntaxExportBinding {
                exported_name: name.clone(),
                local_name: name,
                source_specifier: None,
                source_target_path: None,
            });
        }
    }

    fn push_import(&mut self, value: &str, kind: ImportKind, start: u32, end: u32) {
        self.imports.push(DirectImport {
            specifier: value.to_owned(),
            target_path: None,
            kind,
            start,
            end,
        });
    }

    fn push_entity(
        &mut self,
        identifier: &BindingIdentifier<'_>,
        kind: EntityKind,
        universal_kind: UniversalKind,
    ) {
        let name = identifier.name.as_str();
        let id = stable_entity_id(kind, &self.path, identifier.span.start, name);
        self.entities.push(SyntaxEntity {
            id: id.clone(),
            name: name.to_owned(),
            kind,
            universal_kind,
            path: self.path.clone(),
            start: identifier.span.start,
            end: identifier.span.end,
            parent_id: Some(self.module_id.clone()),
            qualified_name: Some(format!("{}.{}", self.path, name)),
            is_test: None,
        });
        self.push_relation(
            RelationKind::Contains,
            self.module_id.clone(),
            Some(id),
            identifier.span.start,
            identifier.span.end,
            RelationClassification::Confirmed,
        );
    }

    /// Ambient module resolution task (2026-09-04): `push_entity`'s sibling
    /// for a `TSModuleDeclaration` whose `id` is a STRING LITERAL (`declare
    /// module "specifier" { ... }`) -- `push_entity` itself only accepts a
    /// `BindingIdentifier` (an `Identifier`-named `namespace X {}` would go
    /// through it if `EntityKind::Namespace` were ever wired to that visitor
    /// too, which it is not -- out of this task's scope). Mirrors v3's own
    /// `addEntity` exactly: `id`'s identity anchors on the STRING LITERAL's
    /// own span start (`identity_start` -- the position of the opening
    /// quote, matching TypeScript's `nameNode.getStart(source)` for a
    /// `StringLiteral` name node), while the PUBLISHED `start`/`end` cover
    /// the WHOLE declaration (`declare` through the closing `}`, or through
    /// the `;` for the shorthand form) -- same "identity span narrower than
    /// published span" split `push_entity` uses for a `constructor`'s
    /// keyword-anchored identity vs. its full-member published span.
    fn push_namespace_entity(
        &mut self,
        name: &str,
        identity_start: u32,
        decl_start: u32,
        decl_end: u32,
    ) -> String {
        let id = stable_entity_id(EntityKind::Namespace, &self.path, identity_start, name);
        self.entities.push(SyntaxEntity {
            id: id.clone(),
            name: name.to_owned(),
            kind: EntityKind::Namespace,
            universal_kind: UniversalKind::Type,
            path: self.path.clone(),
            start: decl_start,
            end: decl_end,
            parent_id: Some(self.module_id.clone()),
            qualified_name: Some(format!("{}.{}", self.path, name)),
            is_test: None,
        });
        self.push_relation(
            RelationKind::Contains,
            self.module_id.clone(),
            Some(id.clone()),
            decl_start,
            decl_end,
            RelationClassification::Confirmed,
        );
        id
    }

    /// Materializes one `SyntaxEntity` + one `core:contains` relation per
    /// `MemberDeclaration` -- the class/interface member entity producer
    /// (see the module doc's "member entities" section). `declarations`
    /// comes from `urdira_jsts_typeflow::member_declarations`, the SAME
    /// helper `urdira-jsts-typeflow`'s own `ProgramIndex` builder uses to
    /// construct its `MemberEntry`s, so the entity id this pushes is
    /// byte-identical to the `target_id` a typeflow-confirmed member call
    /// already carries -- the whole point of this producer (see decision 28
    /// "Entity synthesis for members" for the residual-pass gap this
    /// closes at cold). `start`/`end` are the member's own KEY (name) span
    /// -- the constructor's own "name" is the `constructor` keyword span,
    /// same as every other member (`class_element_member_shape`'s own doc
    /// comment) -- never the whole member's body span, matching how
    /// `push_entity` uses the identifier span for every other entity kind.
    /// `qualified_name` extends the container's own `push_entity`-assigned
    /// `{path}.{ContainerName}` with `.{name}`. The container is guaranteed
    /// to already have an entity (`member_declarations` only enumerates
    /// members of a NAMED, module-level `ClassDeclaration`/
    /// `TSInterfaceDeclaration` -- the identical discovery surface `visit_
    /// class`/`visit_ts_interface_declaration` already push an entity for,
    /// see `member_declarations`'s own doc comment), so `parent_id` never
    /// dangles.
    fn push_member_entities(&mut self, declarations: &[urdira_jsts_typeflow::MemberDeclaration]) {
        for declaration in declarations {
            let (kind, universal_kind) = match declaration.kind_word {
                "method" => (EntityKind::Method, UniversalKind::Callable),
                "constructor" => (EntityKind::Constructor, UniversalKind::Callable),
                "getter" => (EntityKind::Getter, UniversalKind::Callable),
                "setter" => (EntityKind::Setter, UniversalKind::Callable),
                "property" => (EntityKind::Property, UniversalKind::Value),
                // 2026-09-04 references-parity task: a constructor
                // parameter property (`constructor(public x: T)`) --
                // `EntityKind::Parameter`/`UniversalKind::Parameter`, the
                // SAME kind v3's `analyzer.ts` gives EVERY parameter
                // (`isParameterDeclaration` fires before its
                // `isPropertyDeclaration` arm, so a parameter property never
                // gets a distinct "property" entity kind there either).
                // `semantic_sites.rs`'s own "referenced-only" parameter
                // producer (`visit_formal_parameter`) deliberately skips a
                // parameter property (see its doc comment), so this is its
                // ONLY entity producer -- unconditional, like every other
                // member, never gated on whether the parameter turns out
                // referenced.
                "parameter" => (EntityKind::Parameter, UniversalKind::Parameter),
                // `member_declarations` only ever produces the six kind
                // words above (`class_element_member_shape`/`signature_
                // member_shape`/`push_constructor_parameter_property_
                // declarations`'s own exhaustive match) -- never reached.
                _ => continue,
            };
            self.entities.push(SyntaxEntity {
                id: declaration.entity_id.clone(),
                name: declaration.name.clone(),
                kind,
                universal_kind,
                path: self.path.clone(),
                start: declaration.key_start,
                end: declaration.key_end,
                parent_id: Some(declaration.container_entity_id.clone()),
                qualified_name: Some(format!(
                    "{}.{}.{}",
                    self.path, declaration.container_name, declaration.name
                )),
                is_test: None,
            });
            self.push_relation(
                RelationKind::Contains,
                declaration.container_entity_id.clone(),
                Some(declaration.entity_id.clone()),
                declaration.key_start,
                declaration.key_end,
                RelationClassification::Confirmed,
            );
        }
    }

    fn push_relation(
        &mut self,
        kind: RelationKind,
        source_id: String,
        target_id: Option<String>,
        start: u32,
        end: u32,
        classification: RelationClassification,
    ) {
        let id = format!(
            "jsts:{}:{}:{}:{}:{}:{}",
            kind.identity_name(),
            self.path,
            start,
            end,
            source_id,
            target_id.as_deref().unwrap_or("unresolved")
        );
        self.relations.push(SyntaxRelation {
            id,
            kind,
            source_id,
            target_id,
            path: self.path.clone(),
            start,
            end,
            classification,
        });
    }

    /// External package/symbol entities task (2026-09-04, item 1), extended
    /// by the ambient module resolution task (same date, item 2): builds
    /// this file's `jsts:relation_import`/`jsts:relation_export` rows plus
    /// any `external_module` entities they need, from `self.imports`, and
    /// appends both -- delegates the actual per-edge decision to
    /// [`build_import_export_facts`] with `ambient_index: None` (this
    /// per-file, parse-time call site has no cross-file view of OTHER
    /// files' `declare module` blocks yet -- see that function's own doc
    /// comment for the full decision order, and `reresolve_ambient_
    /// relations` for the project-level pass that revisits this decision
    /// once the full workspace picture is available).
    fn finish_import_relations(&mut self) {
        if self.node_test_from {
            self.entities[0].is_test = Some(true);
        }
        let (relations, external_entities) =
            build_import_export_facts(&self.path, &self.module_id, &self.imports, None);
        self.entities.extend(external_entities);
        self.relations.extend(relations);
    }
}

/// Ambient module resolution task (2026-09-04): shared core of
/// `SyntaxCollector::finish_import_relations`'s import/export-edge lane and
/// `reresolve_ambient_relations`'s project-level rebuild -- for every
/// `import`/`export ... from` edge, decides its `jsts:relation_import`/
/// `export` target and classification, and which (if any) `external_
/// module` entity that decision needs (never `external_symbol` -- that kind
/// only exists at the semantic reference layer, per name, see `semantic_
/// sites.rs`'s `emit_external_use`).
///
/// Decision order per edge:
/// 1. `target_path: Some(path)` (already resolved against the current
///    workspace path set, upstream) -- targets that workspace file's own
///    module entity, `Confirmed`. Unaffected by `ambient_index`.
/// 2. `target_path: None`, and `ambient_index` names EXACTLY ONE workspace
///    file declaring `declare module "{edge.specifier}"` (fix item 2) --
///    targets that block's own namespace entity, `Confirmed`. Never pushes
///    a synthetic entity locally: the target already exists, published by
///    the DECLARING file's own `push_namespace_entity` call.
/// 3. `target_path: None`, `ambient_index` names two-or-more declaring
///    files for the specifier (workspace-ambiguous) -- `Possible`, no
///    target. NEVER falls through to external classification below: the
///    specifier is proven to be an ambient module somewhere in this
///    workspace, so guessing "external" would misrepresent it exactly the
///    way `resolver::classify_external_specifier`'s own doc comment warns
///    against for a relative specifier that merely failed to resolve.
/// 4. `target_path: None`, no ambient declaration anywhere (`ambient_index`
///    is `None` -- the per-file call site -- or names zero declaring
///    files): `resolver::classify_external_specifier`'s pre-existing
///    fallback, byte-for-byte unchanged from before this task.
fn build_import_export_facts(
    path: &str,
    module_id: &str,
    direct_imports: &[DirectImport],
    ambient_index: Option<&resolver::AmbientModuleIndex>,
) -> (Vec<SyntaxRelation>, Vec<SyntaxEntity>) {
    let mut relations = Vec::new();
    let mut external_entities = Vec::new();
    let mut external_ids_seen: BTreeSet<String> = BTreeSet::new();
    for edge in direct_imports {
        let kind = match edge.kind {
            ImportKind::Import => RelationKind::Import,
            ImportKind::Export => RelationKind::Export,
            ImportKind::DynamicImport | ImportKind::Require => continue,
        };
        let (target_id, classification) = if let Some(target_path) = &edge.target_path {
            (
                Some(stable_entity_id(
                    EntityKind::Module,
                    target_path,
                    0,
                    target_path,
                )),
                RelationClassification::Confirmed,
            )
        } else if let Some(namespace_id) =
            ambient_index.and_then(|index| index.unique_namespace_entity(&edge.specifier))
        {
            (Some(namespace_id), RelationClassification::Confirmed)
        } else if ambient_index.is_some_and(|index| index.has_any_declaration(&edge.specifier)) {
            (None, RelationClassification::Possible)
        } else {
            match resolver::classify_external_specifier(&edge.specifier) {
                Some(canonical) => {
                    let target_id = resolver::external_module_id(&canonical);
                    if external_ids_seen.insert(target_id.clone()) {
                        external_entities.push(external_module_entity(&canonical));
                    }
                    (Some(target_id), RelationClassification::Confirmed)
                }
                None => (None, RelationClassification::Possible),
            }
        };
        let id = format!(
            "jsts:{}:{}:{}:{}:{}:{}",
            kind.identity_name(),
            path,
            edge.start,
            edge.end,
            module_id,
            target_id.as_deref().unwrap_or("unresolved")
        );
        relations.push(SyntaxRelation {
            id,
            kind,
            source_id: module_id.to_owned(),
            target_id,
            path: path.to_owned(),
            start: edge.start,
            end: edge.end,
            classification,
        });
    }
    (relations, external_entities)
}

/// The name a `ModuleExportName` carries, whichever variant it is (a plain
/// identifier is by far the common case; a string-literal export name --
/// `export { x as "weird name" }`, valid ES2022 syntax -- uses its literal
/// value).
fn module_export_name_text(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.as_str().to_owned(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.as_str().to_owned(),
        ModuleExportName::StringLiteral(literal) => literal.value.as_str().to_owned(),
    }
}

/// Every name a direct `export <declaration>` form declares, with its
/// binding identifier's start offset (unused by callers today, kept for
/// parity with `push_entity`'s identity scheme and future diagnostics).
/// Only the kinds `push_entity` above ever gives an entity to are collected
/// here -- `export default ...` is a different AST node entirely
/// (`ExportDefaultDeclaration`) and never reaches this function.
fn declaration_export_names(declaration: &Declaration<'_>) -> Vec<(u32, String)> {
    match declaration {
        Declaration::VariableDeclaration(variable) => variable
            .declarations
            .iter()
            .filter_map(|declarator| match &declarator.id {
                BindingPattern::BindingIdentifier(identifier) => {
                    Some((identifier.span.start, identifier.name.as_str().to_owned()))
                }
                _ => None,
            })
            .collect(),
        Declaration::FunctionDeclaration(function) => function
            .id
            .as_ref()
            .map(|identifier| vec![(identifier.span.start, identifier.name.as_str().to_owned())])
            .unwrap_or_default(),
        Declaration::ClassDeclaration(class) => class
            .id
            .as_ref()
            .map(|identifier| vec![(identifier.span.start, identifier.name.as_str().to_owned())])
            .unwrap_or_default(),
        Declaration::TSTypeAliasDeclaration(alias) => {
            vec![(alias.id.span.start, alias.id.name.as_str().to_owned())]
        }
        Declaration::TSInterfaceDeclaration(interface) => {
            vec![(
                interface.id.span.start,
                interface.id.name.as_str().to_owned(),
            )]
        }
        Declaration::TSEnumDeclaration(enum_declaration) => vec![(
            enum_declaration.id.span.start,
            enum_declaration.id.name.as_str().to_owned(),
        )],
        // 3b/n8n-parity fix (2026-09-05): `export namespace X {}` (an
        // `Identifier`-named `TSModuleDeclaration`) DOES need an entry
        // here -- the stale claim this comment used to make ("`visit_ts_
        // module_declaration` handles it directly, so folding it in here
        // would double-count it") confused the ENTITY push (`push_entity`,
        // unconditional, unaffected by the `export` wrapper) with the
        // EXPORT BINDING this function builds (a completely separate list,
        // `self.export_bindings`, that NOTHING else ever pushed to for a
        // namespace) -- `import { Cfg } from "./a"` where `a.ts` has
        // `export namespace Cfg { ... }` stayed `Unresolved` forever
        // (`export_bindings` had no entry to even try `resolve_direct_
        // export` against), found live against the n8n corpus (505 sites,
        // `import_binding/export:unresolved` bucketed by target kind
        // `namespace`) despite the entity itself existing since 3b. The
        // STRING-LITERAL form (`export declare module "x" { ... }`) is
        // UNCHANGED -- that one really is resolved a different way
        // entirely (`AmbientModuleIndex`/specifier matching, never by a
        // plain `import`-by-name), so it stays excluded here.
        Declaration::TSModuleDeclaration(module) => match &module.id {
            TSModuleDeclarationName::Identifier(identifier) => {
                vec![(identifier.span.start, identifier.name.as_str().to_owned())]
            }
            TSModuleDeclarationName::StringLiteral(_) => Vec::new(),
        },
        // `TSImportEqualsDeclaration` (still genuinely out of `EntityKind`'s
        // scope) is left out deliberately, not an oversight.
        _ => Vec::new(),
    }
}

/// Ambient module resolution task (2026-09-04): the `EntityKind` a direct
/// `export <decl>` declaration inside a `declare module "specifier" { ... }`
/// block would get from its own ordinary `push_entity`/`visit_*` call
/// elsewhere in this same walk (function/class/interface/type/enum/
/// variable) -- used ONLY to build `AmbientModuleDeclaration::members`'
/// entity ids ahead of time; never itself pushes an entity (the ordinary
/// walk already does that, unaffected by ambient nesting -- see
/// `AmbientModuleDeclaration`'s own doc comment for why member ids never
/// depend on nesting). `None` for every declaration shape without a
/// nameable `EntityKind` (mirrors `declaration_export_names`'s own
/// fallthrough).
/// Ambient module resolution task (2026-09-04) follow-up: TypeScript's own
/// script-vs-module test, applied to `body` (a file's top-level statement
/// list) -- a file is a MODULE the moment it contains AT LEAST ONE
/// top-level `import`/`export ... `/`export ... from`/`export default`/
/// `export = X` statement (`oxc_ast::Statement::as_module_declaration`
/// covers exactly those five forms -- `ModuleDeclaration`'s own variant
/// list: `ImportDeclaration`, `ExportAllDeclaration`, `ExportDefault
/// Declaration`, `ExportNamedDeclaration` (this ALSO covers the bare
/// `export {}` idiom some files use purely to force module mode -- oxc
/// parses it as an `ExportNamedDeclaration` with empty specifiers, no
/// `declaration`, no `source`), and `TSExportAssignment`), OR a top-level
/// `import X = require(...)` (`TSImportEqualsDeclaration` -- a `Declaration`
/// variant, not a `ModuleDeclaration` one in oxc's own split, so checked
/// separately via `Statement::as_declaration`). A file with NONE of these
/// is a SCRIPT: every `declare module "x" { ... }` it contains is a real
/// ambient module declaration, not an augmentation of an existing package
/// (see `AmbientModuleDeclaration::is_augmentation`'s own doc comment).
fn file_has_top_level_module_syntax(body: &[Statement<'_>]) -> bool {
    body.iter().any(|statement| {
        statement.as_module_declaration().is_some()
            || matches!(
                statement.as_declaration(),
                Some(Declaration::TSImportEqualsDeclaration(_))
            )
    })
}

/// D.1 (2026-09-05, references-parity task): every ambient-global
/// candidate directly inside `body` -- a flat, NON-RECURSIVE scan (same
/// "top-level = one pass over a statement list" idiom `file_has_top_level_
/// module_syntax`/`urdira_jsts_typeflow::collect_import_specifiers` already
/// use for other top-level-only facts), so a same-shaped declaration
/// nested one level deeper (inside a function/class/block) is never
/// mistaken for one of these. Recognizes `namespace X`/`declare namespace
/// X` (an `Identifier`-named `TSModuleDeclaration`), `interface X`, `type
/// X` unconditionally, and `var|let|const`/`function`/`class`/`enum X`
/// gated on `require_declare` -- `false` for a `declare global { ... }`
/// block's own children (ambient context is inherited, oxc's own `declare`
/// flag on a nested declaration stays `false` there), `true` for a
/// script's own top level (where an ordinary, non-`declare` `var x = 1;`
/// is NOT one of these -- see `GlobalScope::ScriptTopLevel`'s own doc
/// comment). Multiple declarators in one `declare const a, b;` each become
/// their own candidate, matching `SyntaxCollector::visit_variable_
/// declaration`'s own "one entity per declarator" rule. `entity_id` is the
/// EXACT SAME `stable_entity_id` formula the ordinary recursive walk
/// already used for this SAME declaration's own entity (see
/// `AmbientGlobalDeclaration`'s own doc comment).
fn ambient_global_candidates_in(
    body: &[Statement<'_>],
    path: &str,
    scope: GlobalScope,
    require_declare: bool,
) -> Vec<AmbientGlobalDeclaration> {
    let mut candidates = Vec::new();
    for statement in body {
        let Some(declaration) = statement.as_declaration() else {
            continue;
        };
        match declaration {
            Declaration::TSModuleDeclaration(module) => {
                if let TSModuleDeclarationName::Identifier(identifier) = &module.id {
                    push_ambient_global_candidate(
                        &mut candidates,
                        path,
                        identifier,
                        EntityKind::Namespace,
                        scope,
                    );
                }
            }
            Declaration::TSInterfaceDeclaration(interface) => {
                push_ambient_global_candidate(
                    &mut candidates,
                    path,
                    &interface.id,
                    EntityKind::Interface,
                    scope,
                );
            }
            Declaration::TSTypeAliasDeclaration(alias) => {
                push_ambient_global_candidate(
                    &mut candidates,
                    path,
                    &alias.id,
                    EntityKind::Type,
                    scope,
                );
            }
            Declaration::VariableDeclaration(variable) if !require_declare || variable.declare => {
                for declarator in &variable.declarations {
                    if let BindingPattern::BindingIdentifier(identifier) = &declarator.id {
                        push_ambient_global_candidate(
                            &mut candidates,
                            path,
                            identifier,
                            EntityKind::Variable,
                            scope,
                        );
                    }
                }
            }
            Declaration::FunctionDeclaration(function) if !require_declare || function.declare => {
                if let Some(identifier) = &function.id {
                    push_ambient_global_candidate(
                        &mut candidates,
                        path,
                        identifier,
                        EntityKind::Function,
                        scope,
                    );
                }
            }
            Declaration::ClassDeclaration(class) if !require_declare || class.declare => {
                if let Some(identifier) = &class.id {
                    push_ambient_global_candidate(
                        &mut candidates,
                        path,
                        identifier,
                        EntityKind::Class,
                        scope,
                    );
                }
            }
            Declaration::TSEnumDeclaration(enum_declaration)
                if !require_declare || enum_declaration.declare =>
            {
                push_ambient_global_candidate(
                    &mut candidates,
                    path,
                    &enum_declaration.id,
                    EntityKind::Enum,
                    scope,
                );
            }
            _ => {}
        }
    }
    candidates
}

/// D.1: script-top-level-only wrapper over `ambient_global_candidates_in`
/// (`require_declare: true`, `scope: ScriptTopLevel`) -- see that
/// function's own doc comment and this call site in `parse_source` for why
/// the result is provisional until the post-walk script-vs-module check.
fn script_top_level_ambient_global_candidates(
    body: &[Statement<'_>],
    path: &str,
) -> Vec<AmbientGlobalDeclaration> {
    ambient_global_candidates_in(body, path, GlobalScope::ScriptTopLevel, true)
}

fn push_ambient_global_candidate(
    out: &mut Vec<AmbientGlobalDeclaration>,
    path: &str,
    identifier: &BindingIdentifier<'_>,
    kind: EntityKind,
    scope: GlobalScope,
) {
    let name = identifier.name.as_str().to_owned();
    let entity_id = stable_entity_id(kind, path, identifier.span.start, &name);
    out.push(AmbientGlobalDeclaration {
        name,
        entity_id,
        kind,
        scope,
    });
}

fn declaration_entity_kind(declaration: &Declaration<'_>) -> Option<EntityKind> {
    match declaration {
        Declaration::VariableDeclaration(_) => Some(EntityKind::Variable),
        Declaration::FunctionDeclaration(_) => Some(EntityKind::Function),
        Declaration::ClassDeclaration(_) => Some(EntityKind::Class),
        Declaration::TSTypeAliasDeclaration(_) => Some(EntityKind::Type),
        Declaration::TSInterfaceDeclaration(_) => Some(EntityKind::Interface),
        Declaration::TSEnumDeclaration(_) => Some(EntityKind::Enum),
        // D.3 (2026-09-05, references-parity task): `export namespace X {}`
        // (`Identifier`-named only -- the string-literal ambient-module
        // form is a different construct entirely, excluded here for the
        // SAME reason `declaration_export_names`'s own `TSModuleDeclaration`
        // arm excludes it) -- needed so `ambient_module_members`'s reuse as
        // `SyntaxFileResult::namespace_members`'s own extraction captures a
        // NESTED namespace as a member of its enclosing one
        // (`ListQueryDb.Workflow.Plain`: `Workflow` is itself a namespace
        // MEMBER of `ListQueryDb`, needed to keep descending the qualified-
        // name chain -- see `resolve_qualified_namespace_path`, semantic_
        // sites.rs).
        Declaration::TSModuleDeclaration(module) => {
            matches!(module.id, TSModuleDeclarationName::Identifier(_))
                .then_some(EntityKind::Namespace)
        }
        _ => None,
    }
}

/// Ambient module resolution task (2026-09-04): extracts `(members,
/// default_member)` from one ambient module block's body -- see
/// `AmbientModuleDeclaration`'s own doc comment for exactly which
/// statement shapes are walked (direct `export <decl>` forms, plus a
/// restricted, nameable-only `export default`) and which are deliberately
/// left out.
///
/// Found live against the n8n corpus (references-parity task, all 649
/// remaining `v4_different_target` rows after the wildcard-pattern fix
/// below): the dominant real-world shape for a virtual-asset ambient
/// module is `const component: T; export default component;` -- a BARE
/// (non-`export`ed) top-level declaration, referenced only indirectly
/// through `export default <identifier>`. `members` (the named-import
/// resolution surface) stays export-gated as before, but `export default
/// <identifier>` must also be able to resolve against a declaration that
/// was NEVER itself exported -- so this collects a SEPARATE, wider
/// `all_declarations` list (every top-level nameable declaration in the
/// block, exported or not, via `Statement::as_declaration` -- oxc flattens
/// `Declaration`'s variants directly into `Statement`, so a bare `const
/// component: T;` is reached the exact same way an `export`ed one is,
/// just without the `ExportNamedDeclaration` wrapper) purely for `export
/// default <identifier>` to search, never published/exposed beyond that.
/// h1 (2026-09-05): counts every `export = <expression>` this crate saw
/// (top-level file scope or inside an ambient module block) whose
/// `expression` was NOT a bare identifier -- the only shape this task
/// resolves (`export = f;`). A diagnostic aggregate only, mirroring
/// `semantic_sites::AMBIGUOUS_AMBIENT_WOULD_BE_EXTERNAL`'s own "process-
/// wide counter, `Relaxed` ordering, reset once per scan" discipline; read
/// via [`unsupported_export_assignment_shape_count`], reset via
/// [`reset_unsupported_export_assignment_shape_count`].
static UNSUPPORTED_EXPORT_ASSIGNMENT_SHAPE: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// See [`UNSUPPORTED_EXPORT_ASSIGNMENT_SHAPE`]'s own doc comment.
pub fn unsupported_export_assignment_shape_count() -> u64 {
    UNSUPPORTED_EXPORT_ASSIGNMENT_SHAPE.load(std::sync::atomic::Ordering::Relaxed)
}

/// See [`UNSUPPORTED_EXPORT_ASSIGNMENT_SHAPE`]'s own doc comment.
pub fn reset_unsupported_export_assignment_shape_count() {
    UNSUPPORTED_EXPORT_ASSIGNMENT_SHAPE.store(0, std::sync::atomic::Ordering::Relaxed);
}

fn ambient_module_members(
    path: &str,
    body: &[Statement<'_>],
) -> (Vec<AmbientModuleMember>, Option<AmbientModuleMember>) {
    let mut members = Vec::new();
    let mut all_declarations = Vec::new();
    let mut default_statement = None;
    // h1 (2026-09-05): `export = f;` inside an ambient module block --
    // CommonJS's own default-export idiom, syntactically exclusive with
    // `export default ...` (a `.d.ts` block never has both), so this is
    // consulted only when `default_statement` above stayed `None`.
    let mut export_assignment_expression = None;
    for statement in body {
        if let Some(declaration) = statement.as_declaration()
            && let Some(kind) = declaration_entity_kind(declaration)
        {
            for (start, name) in declaration_export_names(declaration) {
                let entity_id = stable_entity_id(kind, path, start, &name);
                all_declarations.push(AmbientModuleMember { name, entity_id });
            }
            continue;
        }
        match statement {
            Statement::ExportNamedDeclaration(export) => {
                if let Some(inner) = &export.declaration
                    && let Some(kind) = declaration_entity_kind(inner)
                {
                    for (start, name) in declaration_export_names(inner) {
                        let entity_id = stable_entity_id(kind, path, start, &name);
                        members.push(AmbientModuleMember {
                            name: name.clone(),
                            entity_id: entity_id.clone(),
                        });
                        all_declarations.push(AmbientModuleMember { name, entity_id });
                    }
                }
            }
            Statement::ExportDefaultDeclaration(export_default) => {
                default_statement = Some(export_default);
            }
            Statement::TSExportAssignment(assign) => {
                export_assignment_expression = Some(&assign.expression);
            }
            _ => {}
        }
    }
    let default_member = match default_statement {
        Some(export_default) => ambient_default_member(path, export_default, &all_declarations),
        None => export_assignment_expression
            .and_then(|expression| ambient_export_assignment_member(expression, &all_declarations)),
    };
    (members, default_member)
}

/// h1 (2026-09-05): the `AmbientModuleMember` an `export = <expression>`
/// statement inside an ambient module block names -- mirrors
/// `ambient_default_member`'s own `Identifier` arm exactly (same "unique
/// match against `all_declarations` or bust" rule), since `export =
/// identifier` is CommonJS's own spelling of the same idiom `export
/// default identifier` covers for ES modules. Minimal scope, per the
/// plan: only a bare identifier resolves; every other expression shape
/// (`export = { a, b };`, `export = class {};`, ...) has no single name to
/// point at and is counted, never guessed.
fn ambient_export_assignment_member(
    expression: &Expression<'_>,
    all_declarations: &[AmbientModuleMember],
) -> Option<AmbientModuleMember> {
    let Expression::Identifier(ident) = expression else {
        UNSUPPORTED_EXPORT_ASSIGNMENT_SHAPE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        return None;
    };
    let matches: Vec<&AmbientModuleMember> = all_declarations
        .iter()
        .filter(|member| member.name == ident.name.as_str())
        .collect();
    match matches.as_slice() {
        [single] => Some((*single).clone()),
        _ => None,
    }
}

/// Ambient module resolution task (2026-09-04): the `AmbientModuleMember`
/// an `export default <decl>` statement inside an ambient module block
/// names, when nameable -- mirrors `visit_export_default_declaration`'s
/// (lib.rs, file-level) own restricted shape: a named function/class/
/// interface declaration resolves to ITS OWN entity id; a bare identifier
/// resolves to an ALREADY-COLLECTED member of the SAME block sharing that
/// name (unique match only -- ambiguous/absent stays `None`, never a
/// guess, same "unique or bust" rule `resolver::resolve_direct_export`
/// uses elsewhere). Every other shape (anonymous function/class expression,
/// object/array literal, ...) has no name to resolve to and stays `None`.
fn ambient_default_member(
    path: &str,
    export_default: &ExportDefaultDeclaration<'_>,
    members: &[AmbientModuleMember],
) -> Option<AmbientModuleMember> {
    match &export_default.declaration {
        ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
            let identifier = function.id.as_ref()?;
            let name = identifier.name.as_str().to_owned();
            let entity_id =
                stable_entity_id(EntityKind::Function, path, identifier.span.start, &name);
            Some(AmbientModuleMember { name, entity_id })
        }
        ExportDefaultDeclarationKind::ClassDeclaration(class) => {
            let identifier = class.id.as_ref()?;
            let name = identifier.name.as_str().to_owned();
            let entity_id = stable_entity_id(EntityKind::Class, path, identifier.span.start, &name);
            Some(AmbientModuleMember { name, entity_id })
        }
        ExportDefaultDeclarationKind::TSInterfaceDeclaration(interface) => {
            let name = interface.id.name.as_str().to_owned();
            let entity_id =
                stable_entity_id(EntityKind::Interface, path, interface.id.span.start, &name);
            Some(AmbientModuleMember { name, entity_id })
        }
        ExportDefaultDeclarationKind::Identifier(ident) => {
            let matches: Vec<&AmbientModuleMember> = members
                .iter()
                .filter(|member| member.name == ident.name.as_str())
                .collect();
            match matches.as_slice() {
                [single] => Some((*single).clone()),
                _ => None,
            }
        }
        _ => None,
    }
}

impl<'a> Visit<'a> for SyntaxCollector {
    fn visit_import_declaration(&mut self, declaration: &ImportDeclaration<'a>) {
        if declaration.specifiers.is_some() && declaration.source.value == "node:test" {
            self.node_test_from = true;
        }
        self.push_import(
            declaration.source.value.as_str(),
            ImportKind::Import,
            declaration.span.start,
            declaration.source.span.end,
        );
        // A5b (2026-09-05 references-parity task, bucket 1): record every
        // local binding this declaration introduces into `imported_locals`
        // -- see that field's own doc comment -- so a LATER sourceless
        // re-export of the same local name (`visit_export_specifier` below)
        // can recognize it as a re-export of an IMPORTED binding rather than
        // a local declaration. Covers all three specifier shapes
        // (`import { a }`/`import { a as b }`, `import def`, `import * as
        // ns`) uniformly, including `import type`/`import { type a }` --
        // resolution downstream never distinguishes value vs. type imports
        // either.
        if let Some(specifiers) = &declaration.specifiers {
            let specifier_text = declaration.source.value.as_str().to_owned();
            for specifier in specifiers {
                match specifier {
                    ImportDeclarationSpecifier::ImportSpecifier(named) => {
                        let imported_name = module_export_name_text(&named.imported);
                        self.imported_locals.insert(
                            named.local.name.as_str().to_owned(),
                            (specifier_text.clone(), ImportedName::Named(imported_name)),
                        );
                    }
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                        self.imported_locals.insert(
                            default.local.name.as_str().to_owned(),
                            (specifier_text.clone(), ImportedName::Default),
                        );
                    }
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                        self.imported_locals.insert(
                            namespace.local.name.as_str().to_owned(),
                            (specifier_text.clone(), ImportedName::Namespace),
                        );
                    }
                }
            }
        }
        walk_import_declaration(self, declaration);
    }

    fn visit_export_named_declaration(&mut self, declaration: &ExportNamedDeclaration<'a>) {
        if let Some(source) = &declaration.source {
            self.push_import(
                source.value.as_str(),
                ImportKind::Export,
                declaration.span.start,
                source.span.end,
            );
            // Named re-export (`export { a, b as c } from "./x"`): each
            // specifier's `local` names the binding in the OTHER module
            // (`ModuleExportName::IdentifierName`, never a local reference
            // -- see `semantic_sites.rs`'s `REASON_RE_EXPORT_BINDING` doc
            // comment for why oxc shapes it this way), `exported` is the
            // name visible to THIS module's own consumers.
            for specifier in &declaration.specifiers {
                if let ModuleExportName::IdentifierName(local) = &specifier.local {
                    let exported_name = module_export_name_text(&specifier.exported);
                    self.export_bindings.push(SyntaxExportBinding {
                        exported_name,
                        local_name: local.name.as_str().to_owned(),
                        source_specifier: Some(source.value.as_str().to_owned()),
                        source_target_path: None,
                    });
                }
            }
        } else if let Some(inner) = &declaration.declaration {
            // Direct declaration form (`export function foo() {}`, `export
            // const a = 1, b = 2;`, ...): every declared name is exported
            // under its own name.
            let names = declaration_export_names(inner);
            self.push_direct_export_names(names);
        }
        // Sourceless specifier form (`export { a, b as c }`) is handled by
        // `visit_export_specifier` below, reached through the default walk.
        walk_export_named_declaration(self, declaration);
    }

    /// Sourceless local re-export (`export { a, b as c }`, no `from`
    /// clause): `local` genuinely references a local binding here (oxc
    /// gives it `ModuleExportName::IdentifierReference`, unlike the
    /// re-export-with-source form above), so it is captured as a direct
    /// export whose `local_name` names that binding. A specifier that
    /// belongs to a `from`-bearing declaration is already handled in
    /// `visit_export_named_declaration` and skipped here to avoid a
    /// duplicate/incorrect (non-re-export) binding.
    ///
    /// A5b (2026-09-05 references-parity task, bucket 1): when `local` is
    /// itself one of THIS file's own `imported_locals` (a barrel doing
    /// `import { X } from './x'; export { X };` / `export type { T };`,
    /// with no `from` on the `export` itself), this is genuinely a
    /// RE-EXPORT of the imported binding, not a local declaration named
    /// `local` -- there usually is none (`resolver::resolve_direct_export`
    /// would search this file's own `entities` for a same-named
    /// declaration and never find one, staying `Unresolved` forever; see
    /// `docs/evidence/...` for the 1,340-site regression this closes).
    /// Emitted as a re-export binding carrying the ORIGINAL import's own
    /// specifier text (`source_specifier`) so the SAME generic
    /// `source_specifier -> source_target_path` resolution pass every other
    /// re-export binding goes through (`parse_source`, this file's own
    /// caller) resolves it identically, and `resolver::resolve_named_export`
    /// then chases it exactly like an ordinary `export { a } from "./x"` --
    /// including transitively, through further re-export hops. The three
    /// `ImportedName` shapes each map to the form `resolve_named_export`
    /// already knows how to chase: `Named(orig)` -> an ordinary re-export of
    /// `orig`; `Namespace` -> the `NAMESPACE_REEXPORT_LOCAL_NAME` sentinel
    /// (same shape `export * as X from "spec"` uses, see that constant's own
    /// doc comment); `Default` -> `local_name: "default"`, the SAME local
    /// name a with-source `export { default as X } from "./y"` gives this
    /// exact field (oxc parses that form's own `local` as the literal
    /// `IdentifierName` text `"default"` -- verified against `visit_export_
    /// named_declaration`'s own with-source loop just above, which stores
    /// `local.name.as_str()` verbatim with no special-casing), so both forms
    /// resolve through `resolve_direct_export`'s existing `name == "default"`
    /// lookup (itself populated by `visit_export_default_declaration`)
    /// without any further change there.
    fn visit_export_specifier(&mut self, specifier: &ExportSpecifier<'a>) {
        if let ModuleExportName::IdentifierReference(local) = &specifier.local {
            let exported_name = module_export_name_text(&specifier.exported);
            match self.imported_locals.get(local.name.as_str()) {
                Some((source_specifier, ImportedName::Named(orig))) => {
                    self.export_bindings.push(SyntaxExportBinding {
                        exported_name,
                        local_name: orig.clone(),
                        source_specifier: Some(source_specifier.clone()),
                        source_target_path: None,
                    });
                }
                Some((source_specifier, ImportedName::Namespace)) => {
                    self.export_bindings.push(SyntaxExportBinding {
                        exported_name,
                        local_name: NAMESPACE_REEXPORT_LOCAL_NAME.to_owned(),
                        source_specifier: Some(source_specifier.clone()),
                        source_target_path: None,
                    });
                }
                Some((source_specifier, ImportedName::Default)) => {
                    self.export_bindings.push(SyntaxExportBinding {
                        exported_name,
                        local_name: "default".to_owned(),
                        source_specifier: Some(source_specifier.clone()),
                        source_target_path: None,
                    });
                }
                None => {
                    self.export_bindings.push(SyntaxExportBinding {
                        exported_name,
                        local_name: local.name.as_str().to_owned(),
                        source_specifier: None,
                        source_target_path: None,
                    });
                }
            }
        }
        walk_export_specifier(self, specifier);
    }

    fn visit_export_all_declaration(&mut self, declaration: &ExportAllDeclaration<'a>) {
        self.push_import(
            declaration.source.value.as_str(),
            ImportKind::Export,
            declaration.span.start,
            declaration.source.span.end,
        );
        // P1-B: `export * as X from "spec"` (as opposed to a plain,
        // nameless `export * from "spec"`, captured separately below) now
        // ALSO synthesizes a `SyntaxExportBinding` for `X` naming the WHOLE
        // re-exported module as a namespace -- `local_name` is the
        // sentinel `NAMESPACE_REEXPORT_LOCAL_NAME` (never a real
        // identifier), which `resolver::resolve_named_export` recognizes
        // and returns as `ExportResolution::Namespace(target_path)` rather
        // than chasing it as an ordinary re-exported NAME (there is no
        // single symbol here -- it is the whole module). `source_target_
        // path` is left `None` here and filled in by the SAME generic
        // per-binding resolution pass every other `source_specifier`-
        // bearing binding already goes through (this file's own caller,
        // `parse_source`), not a special case.
        if let Some(exported) = &declaration.exported {
            self.export_bindings.push(SyntaxExportBinding {
                exported_name: module_export_name_text(exported),
                local_name: NAMESPACE_REEXPORT_LOCAL_NAME.to_owned(),
                source_specifier: Some(declaration.source.value.as_str().to_owned()),
                source_target_path: None,
            });
        } else {
            // 2026-09-04 references-parity task, bucket 2: a plain, nameless
            // `export * from "spec"` -- there is no single exported NAME
            // here (it re-exports EVERY name the target module itself
            // exports), so it cannot become a `SyntaxExportBinding` the way
            // the `as X` form above does. Recorded into the separate
            // `export_star_specifiers` list instead, for `resolver::
            // resolve_named_export_inner` to consult as a fallback AFTER an
            // ordinary `export_bindings` lookup for a name comes up empty --
            // see that function's own doc comment. `target_path` is left
            // `None` here, filled in by the SAME generic per-specifier
            // resolution pass `export_bindings`' own `source_target_path`
            // goes through, just below in this file's own caller.
            self.export_star_specifiers.push(ExportStarSpecifier {
                specifier: declaration.source.value.as_str().to_owned(),
                target_path: None,
            });
        }
        walk_export_all_declaration(self, declaration);
    }

    /// 2026-09-04 references-parity task, Phase B bucket 1: `export default
    /// <decl-or-expr>` is a DIFFERENT AST node from every other export form
    /// (`ExportDefaultDeclaration`, not `ExportNamedDeclaration`) --
    /// `declaration_export_names`'s own doc comment notes it "never reaches
    /// this function" for exactly that reason, and until this fix
    /// `export_bindings` carried NOTHING for a default export at all, so
    /// `resolver::resolve_named_export(files, path, "default")` (what an
    /// `import X from "path"` specifier looks up) always reported
    /// `Unresolved` regardless of what the target module actually exports
    /// as its default -- found live against the n8n corpus: 7,500
    /// v3-confirmed reference sites stayed `checker_pending` this way,
    /// `import buildTrivyBlocks from "./build-trivy-blocks.mjs"` (whose
    /// target is `export default function buildTrivyBlocks(...) {}`) the
    /// first sample found.
    ///
    /// Captured ONLY when the default-exported thing has a NAMEABLE,
    /// already-existing entity to point `local_name` at (the same "never
    /// guess" rule `resolve_named_export`'s own doc comment states): a
    /// named function/class/interface declaration (its OWN entity --
    /// `visit_function`/`visit_class`/`visit_ts_interface_declaration`
    /// already push one for it regardless of the `export default` wrapper,
    /// since the wrapper does not change the inner declaration's own AST
    /// shape) or a bare identifier expression (`export default
    /// someLocalThing;`, re-exporting an already-declared local binding by
    /// name). Every other shape -- an ANONYMOUS function/class expression,
    /// an object/array literal, an arrow function, a template/conditional/
    /// binary expression, ... -- has no name to resolve to at all and is
    /// left uncaptured, exactly like before this fix (stays `checker_
    /// pending` upstream, never a guess).
    fn visit_export_default_declaration(&mut self, declaration: &ExportDefaultDeclaration<'a>) {
        let local_name: Option<String> = match &declaration.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                function.id.as_ref().map(|id| id.name.as_str().to_owned())
            }
            ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                class.id.as_ref().map(|id| id.name.as_str().to_owned())
            }
            ExportDefaultDeclarationKind::TSInterfaceDeclaration(interface) => {
                Some(interface.id.name.as_str().to_owned())
            }
            ExportDefaultDeclarationKind::Identifier(ident) => Some(ident.name.as_str().to_owned()),
            _ => None,
        };
        if let Some(local_name) = local_name {
            self.export_bindings.push(SyntaxExportBinding {
                exported_name: "default".to_owned(),
                local_name,
                source_specifier: None,
                source_target_path: None,
            });
        }
        walk_export_default_declaration(self, declaration);
    }

    /// h1 (2026-09-05): `export = <identifier>;` -- CommonJS's own default-
    /// export idiom, syntactically exclusive with every ES `export ...`
    /// form in the same file (no `TSExportAssignment` visitor existed
    /// before this task; `file_has_top_level_module_syntax`'s own doc
    /// comment already accounts for `TSExportAssignment` making a file a
    /// MODULE). Only a bare identifier resolves, mirroring `visit_export_
    /// default_declaration`'s `Identifier` arm exactly (`local_name` is the
    /// identifier's OWN name, looked up in `entities` the same way);
    /// pushed as `exported_name: "default"`, same as an ES `export default
    /// someLocalThing;`, since `import x from "./this-file"` and `import x
    /// = require("./this-file")` both resolve through the SAME `"default"`
    /// binding lookup (`resolver::resolve_named_export`). Fires for a
    /// TRUE top-level `export = f;` in an ordinary file AND for one
    /// nested inside a `declare module "spec" { ... }` block (the default
    /// recursive walk reaches it either way) -- the latter ALSO reaches
    /// `ambient_module_members`'s own `TSExportAssignment` arm, which
    /// builds the ambient module's OWN `default_member` for specifier-
    /// based resolution (`import x from "spec"`); this file-level binding
    /// is a SEPARATE, path-based lookup surface, not a duplicate of it.
    /// Every other expression shape is ignored, counted via
    /// `UNSUPPORTED_EXPORT_ASSIGNMENT_SHAPE`, never guessed.
    fn visit_ts_export_assignment(&mut self, assignment: &TSExportAssignment<'a>) {
        if let Expression::Identifier(ident) = &assignment.expression {
            self.export_bindings.push(SyntaxExportBinding {
                exported_name: "default".to_owned(),
                local_name: ident.name.as_str().to_owned(),
                source_specifier: None,
                source_target_path: None,
            });
        } else {
            UNSUPPORTED_EXPORT_ASSIGNMENT_SHAPE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        walk_ts_export_assignment(self, assignment);
    }

    fn visit_import_expression(&mut self, expression: &ImportExpression<'a>) {
        if let Expression::StringLiteral(source) = &expression.source {
            self.push_import(
                source.value.as_str(),
                ImportKind::DynamicImport,
                expression.span.start,
                expression.span.end,
            );
        }
        walk_import_expression(self, expression);
    }

    fn visit_call_expression(&mut self, expression: &CallExpression<'a>) {
        if expression.callee.is_specific_id("require")
            && let Some(Expression::StringLiteral(source)) = expression
                .arguments
                .first()
                .and_then(|argument| argument.as_expression())
        {
            self.push_import(
                source.value.as_str(),
                ImportKind::Require,
                expression.span.start,
                expression.span.end,
            );
        }
        walk_call_expression(self, expression);
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        if matches!(
            function.r#type,
            FunctionType::FunctionDeclaration | FunctionType::TSDeclareFunction
        ) && let Some(identifier) = &function.id
        {
            self.push_entity(identifier, EntityKind::Function, UniversalKind::Callable);
        }
        walk_function(self, function, flags);
    }

    fn visit_class(&mut self, class: &Class<'a>) {
        if class.r#type == ClassType::ClassDeclaration
            && let Some(identifier) = &class.id
        {
            self.push_entity(identifier, EntityKind::Class, UniversalKind::Type);
        }
        walk_class(self, class);
    }

    fn visit_variable_declaration(&mut self, declaration: &VariableDeclaration<'a>) {
        // 3c (2026-09-05): an entity for EVERY declarator, not just the
        // first -- `const a = 1, b = 2;` previously left `b` with no entity
        // at all, so any reference to `b` fell through to `REASON_
        // UNSUPPORTED_DECLARATION_KIND` in the resolver. `SemanticWalker::
        // visit_variable_declaration` (semantic_sites.rs) mirrors this same
        // "one entity per BindingIdentifier declarator" rule via
        // `declarator_owns_entity`.
        for declarator in &declaration.declarations {
            if let BindingPattern::BindingIdentifier(identifier) = &declarator.id {
                self.push_entity(identifier, EntityKind::Variable, UniversalKind::Value);
            }
        }
        walk_variable_declaration(self, declaration);
    }

    fn visit_ts_enum_declaration(&mut self, declaration: &TSEnumDeclaration<'a>) {
        self.push_entity(&declaration.id, EntityKind::Enum, UniversalKind::Type);
        walk_ts_enum_declaration(self, declaration);
    }

    fn visit_ts_type_alias_declaration(&mut self, declaration: &TSTypeAliasDeclaration<'a>) {
        self.push_entity(&declaration.id, EntityKind::Type, UniversalKind::Type);
        walk_ts_type_alias_declaration(self, declaration);
    }

    fn visit_ts_interface_declaration(&mut self, declaration: &TSInterfaceDeclaration<'a>) {
        self.push_entity(&declaration.id, EntityKind::Interface, UniversalKind::Type);
        walk_ts_interface_declaration(self, declaration);
    }

    /// Ambient module resolution task (2026-09-04): only a STRING-LITERAL-
    /// named `TSModuleDeclaration` (`declare module "specifier" { ... }` /
    /// `declare module "specifier";`) is an ambient module declaration --
    /// see `AmbientModuleDeclaration`'s own doc comment. An `Identifier`-
    /// named one (`namespace X {}`/`declare namespace X {}`) names a LOCAL
    /// binding instead (3b, 2026-09-05): it now gets its own entity via
    /// `push_entity` (same shape as `visit_class`/`visit_ts_enum_declaration`
    /// above) AND (3b/n8n-parity follow-up, same date) an export binding via
    /// `declaration_export_names`'s own `TSModuleDeclaration` arm, reached
    /// through `visit_export_named_declaration`'s direct-declaration branch
    /// -- so `import { X } from "./this-file"` where `X` names an exported
    /// namespace now actually resolves (505 n8n sites,
    /// `import_binding/export:unresolved` bucketed by target kind
    /// `namespace`, stayed unresolved even after 3b's own entity landed,
    /// because nothing ever registered the export binding a plain
    /// name-based `import` lookup needs). Every declaration nested inside
    /// the block (function/class/interface/type/enum/variable) still gets
    /// its own entity through the ordinary recursive walk below, unaffected
    /// -- this override only ADDS the block's own namespace/ambient-module
    /// entity plus (string-literal case only) the `AmbientModuleDeclaration`
    /// fact; it never replaces or skips the default walk.
    ///
    /// Known gap, not fixed here: nested `namespace A.B {}` desugars in oxc
    /// to `namespace A { namespace B {} }`, so this visitor fires once per
    /// level and each produces its own entity -- no special-casing needed,
    /// but the identity of `A` is anchored at the OUTER declaration's
    /// identifier span, same as v3.
    ///
    /// Declaration merging (3b/n8n-parity follow-up): the export resolver
    /// (`resolver::resolve_direct_export`) now resolves TWO merge shapes for
    /// a PLAIN reference (`ExportPolicy::FirstDeclaration`), matching v3's
    /// own `valueDeclaration ?? declarations[0]` rule: (1) the same
    /// `namespace X {}` repeated more than once in the same file (each
    /// occurrence its own entity, `push_entity` never deduplicates by name)
    /// resolves to the FIRST one in source order, exactly like an
    /// overloaded function; (2) a namespace merged with EXACTLY ONE
    /// class/function/enum declaration of the same name (`export class Foo
    /// {} export namespace Foo { ... }`, TypeScript's own supported merge
    /// shape -- very common in n8n) resolves to the VALUE declaration
    /// (class/function/enum), regardless of source order, since that is the
    /// declaration real references/`instanceof`/construction actually mean.
    /// Anything else (two DIFFERENT non-namespace kinds sharing a name, or
    /// more than one non-namespace candidate) is not a real TypeScript merge
    /// shape and stays `Ambiguous`, never a guess. The CALL-target policy
    /// (`UniqueOrAmbiguous`) is unaffected either way -- see `resolve_direct_
    /// export`'s own doc comment for the full mechanism.
    fn visit_ts_module_declaration(&mut self, declaration: &TSModuleDeclaration<'a>) {
        if let TSModuleDeclarationName::Identifier(identifier) = &declaration.id {
            self.push_entity(identifier, EntityKind::Namespace, UniversalKind::Type);
            // D.3 (2026-09-05, references-parity task): this LOCAL
            // namespace's own directly-`export`ed members -- see
            // `SyntaxFileResult::namespace_members`'s own doc comment. Only
            // when the body is a real block directly on THIS declaration
            // (never the nested-`TSModuleDeclaration` shape `namespace
            // A.B {}` desugars `A`'s own body into -- there is nothing of
            // `A`'s own to export directly there, only `B`, itself visited
            // separately with its OWN `Identifier` branch when the walk
            // reaches it).
            if let Some(TSModuleDeclarationBody::TSModuleBlock(block)) = &declaration.body {
                let namespace_entity_id = stable_entity_id(
                    EntityKind::Namespace,
                    &self.path,
                    identifier.span.start,
                    identifier.name.as_str(),
                );
                let (members, _default_member) = ambient_module_members(&self.path, &block.body);
                self.namespace_members
                    .extend(members.into_iter().map(|member| NamespaceMember {
                        namespace_entity_id: namespace_entity_id.clone(),
                        name: member.name,
                        member_entity_id: member.entity_id,
                    }));
            }
        }
        if let TSModuleDeclarationName::StringLiteral(literal) = &declaration.id {
            let specifier = literal.value.as_str().to_owned();
            let namespace_entity_id = self.push_namespace_entity(
                &specifier,
                literal.span.start,
                declaration.span.start,
                declaration.span.end,
            );
            let (bodyful, members, default_member) = match &declaration.body {
                Some(TSModuleDeclarationBody::TSModuleBlock(block)) => {
                    let (members, default_member) = ambient_module_members(&self.path, &block.body);
                    (true, members, default_member)
                }
                // A nested `declare module "x" { declare module "y" {} }`
                // is syntactically legal but vanishingly rare in practice
                // (module augmentation blocks are conventionally top-
                // level); treated the same as the bodyless shorthand below
                // -- no members captured, never a guess.
                _ => (false, Vec::new(), None),
            };
            self.ambient_modules.push(AmbientModuleDeclaration {
                specifier,
                bodyful,
                // Patched to the file's real script-vs-module status by
                // `parse_source` right after the walk completes (a
                // whole-file property, not knowable mid-walk -- see
                // `AmbientModuleDeclaration::is_augmentation`'s own doc
                // comment). `false` here is a placeholder, never the
                // published value.
                is_augmentation: false,
                namespace_entity_id,
                members,
                default_member,
            });
        }
        walk_ts_module_declaration(self, declaration);
    }

    /// D.1 (2026-09-05, references-parity task): `declare global { ... }`
    /// is its OWN oxc AST node (`Declaration::TSGlobalDeclaration`, distinct
    /// from `TSModuleDeclaration` -- see `AmbientGlobalDeclaration::scope`'s
    /// own doc comment), reached through its OWN `Visit` override point,
    /// never through `visit_ts_module_declaration` above. Before this
    /// override, this collector had no override for it at all, so the
    /// default recursive walk (`walk_ts_global_declaration`) ran, still
    /// giving every declaration directly inside the block its own ordinary
    /// entity (unaffected -- that part of the walk is untouched) but never
    /// recording that any of them is a GLOBAL, cross-file-visible name. This
    /// override ADDS exactly that fact for every declaration ONE level
    /// inside the block (`ambient_global_candidates_in`'s own flat,
    /// non-recursive scan -- a nested `declare global { declare global {}
    /// }` is not legal TypeScript, never a concern), then still runs the
    /// unchanged default walk so entity emission is byte-identical to
    /// before this task.
    fn visit_ts_global_declaration(&mut self, declaration: &TSGlobalDeclaration<'a>) {
        self.ambient_globals.extend(ambient_global_candidates_in(
            &declaration.body.body,
            &self.path,
            GlobalScope::DeclareGlobal,
            false,
        ));
        walk_ts_global_declaration(self, declaration);
    }
}

fn stable_entity_id(kind: EntityKind, path: &str, start: u32, name: &str) -> String {
    format!("jsts:{}:{path}:{start}:{name}", kind.identity_name())
}

/// Re-derive only the import/export target-path resolution (and the
/// corresponding `core:import`/`core:export` relations) of an already-parsed
/// file against a NEW `available` path set, without re-parsing its source.
/// `file`'s own byte content never changes here -- only which other path (if
/// any) each of its relative/bare specifiers now resolves to, which is
/// exactly what changes when a sibling path is added to or removed from the
/// corpus (T1, `docs/evidence/2026-09-02-file-creation-diagnosis.md`).
/// Returns `None` when nothing about this file's resolution actually
/// changed, so the caller can skip touching it -- keeping the incremental
/// add/remove-root path's rewrite proportional to what genuinely changed,
/// not to the corpus size.
fn reresolve_file(
    file: &SyntaxFileResult,
    available: &BTreeSet<String>,
    resolver: &WorkspaceResolver,
) -> Option<SyntaxFileResult> {
    let mut direct_imports = file.direct_imports.clone();
    let mut resolution_changed = false;
    for import in &mut direct_imports {
        let resolved = resolver.resolve(&file.path, &import.specifier, available);
        if resolved != import.target_path {
            resolution_changed = true;
        }
        import.target_path = resolved;
    }
    let mut export_bindings = file.export_bindings.clone();
    for binding in &mut export_bindings {
        if let Some(specifier) = &binding.source_specifier {
            let resolved = resolver.resolve(&file.path, specifier, available);
            if resolved != binding.source_target_path {
                resolution_changed = true;
            }
            binding.source_target_path = resolved;
        }
    }
    let mut export_star_specifiers = file.export_star_specifiers.clone();
    for star in &mut export_star_specifiers {
        let resolved = resolver.resolve(&file.path, &star.specifier, available);
        if resolved != star.target_path {
            resolution_changed = true;
        }
        star.target_path = resolved;
    }
    if !resolution_changed {
        return None;
    }
    let module_id = stable_entity_id(EntityKind::Module, &file.path, 0, &file.path);
    let mut relations: Vec<SyntaxRelation> = file
        .relations
        .iter()
        .filter(|relation| {
            !(matches!(relation.kind, RelationKind::Import | RelationKind::Export)
                && relation.source_id == module_id)
        })
        .cloned()
        .collect();
    // Ambient module resolution task (2026-09-04): delegates to the SAME
    // shared decision `finish_import_relations` uses (`ambient_index: None`
    // here too -- T1's add/remove-root sweep has no cross-file ambient
    // picture either, same reasoning as the per-file parse call site; the
    // separate `reresolve_ambient_relations` pass below is what applies
    // ambient resolution). Before this fix, this loop rebuilt an
    // unresolved edge's relation as unconditionally `Possible`/no-target,
    // NEVER re-applying `classify_external_specifier` -- a latent bug this
    // refactor also fixes: a bare external import untouched by THIS call's
    // own resolution change (e.g. a sibling relative import in the same
    // file DID change, forcing this whole relation list to rebuild) used
    // to silently lose its external classification here.
    let (import_export_relations, external_entities) =
        build_import_export_facts(&file.path, &module_id, &direct_imports, None);
    relations.extend(import_export_relations);
    relations.sort_by(|left, right| left.id.cmp(&right.id));
    let mut entities: Vec<SyntaxEntity> = file
        .entities
        .iter()
        .filter(|entity| entity.kind != EntityKind::ExternalModule)
        .cloned()
        .collect();
    entities.extend(external_entities);
    entities.sort_by(|left, right| left.id.cmp(&right.id));
    Some(SyntaxFileResult {
        path: file.path.clone(),
        content_digest: file.content_digest.clone(),
        language: file.language,
        script_kind: file.script_kind,
        byte_length: file.byte_length,
        parsed: file.parsed,
        direct_imports,
        entities,
        relations,
        diagnostics: file.diagnostics.clone(),
        export_bindings,
        export_star_specifiers,
        ambient_modules: file.ambient_modules.clone(),
        ambient_globals: file.ambient_globals.clone(),
        namespace_members: file.namespace_members.clone(),
        // A4: `file`'s own byte content is untouched here (only import/
        // export target-path resolution changed), so its line index is
        // still valid unchanged -- see `SyntaxFileResult::line_index`'s own
        // doc comment.
        line_index: file.line_index.clone(),
    })
}

/// Ambient module resolution task (2026-09-04), fix item 2: rebuilds ONLY
/// `path`'s `jsts:relation_import`/`export` rows (plus the `external_
/// module` entities they need) using `ambient_index`, WITHOUT re-deriving
/// `direct_imports`/`export_bindings`/`export_star_specifiers` -- unlike
/// `reresolve_file` (T1, triggered by a path add/remove), the trigger here
/// is a DIFFERENT file's `declare module` block appearing/disappearing/
/// changing, which never touches `path`'s own workspace-path resolution.
/// Returns `None` when the rebuilt relations/entities are byte-identical to
/// what `file` already had (a specifier this call reconsidered turned out
/// to resolve the same way, e.g. still zero declaring files -> still
/// external), sparing the caller a no-op `next_files` write.
fn reresolve_ambient_relations(
    file: &SyntaxFileResult,
    ambient_index: &resolver::AmbientModuleIndex,
) -> Option<SyntaxFileResult> {
    let module_id = stable_entity_id(EntityKind::Module, &file.path, 0, &file.path);
    let mut relations: Vec<SyntaxRelation> = file
        .relations
        .iter()
        .filter(|relation| {
            !(matches!(relation.kind, RelationKind::Import | RelationKind::Export)
                && relation.source_id == module_id)
        })
        .cloned()
        .collect();
    let (import_export_relations, external_entities) = build_import_export_facts(
        &file.path,
        &module_id,
        &file.direct_imports,
        Some(ambient_index),
    );
    relations.extend(import_export_relations);
    relations.sort_by(|left, right| left.id.cmp(&right.id));
    let mut entities: Vec<SyntaxEntity> = file
        .entities
        .iter()
        .filter(|entity| entity.kind != EntityKind::ExternalModule)
        .cloned()
        .collect();
    entities.extend(external_entities);
    entities.sort_by(|left, right| left.id.cmp(&right.id));
    if relations == file.relations && entities == file.entities {
        return None;
    }
    Some(SyntaxFileResult {
        path: file.path.clone(),
        content_digest: file.content_digest.clone(),
        language: file.language,
        script_kind: file.script_kind,
        byte_length: file.byte_length,
        parsed: file.parsed,
        direct_imports: file.direct_imports.clone(),
        entities,
        relations,
        diagnostics: file.diagnostics.clone(),
        export_bindings: file.export_bindings.clone(),
        export_star_specifiers: file.export_star_specifiers.clone(),
        ambient_modules: file.ambient_modules.clone(),
        ambient_globals: file.ambient_globals.clone(),
        namespace_members: file.namespace_members.clone(),
        // A4: same reasoning as `reresolve_file` above -- this rebuild never
        // touches `file`'s own byte content either.
        line_index: file.line_index.clone(),
    })
}

fn reverse_affected_closure(
    prior: Option<&BTreeMap<String, SyntaxFileResult>>,
    next: &BTreeMap<String, SyntaxFileResult>,
    changed: &BTreeSet<String>,
) -> BTreeSet<String> {
    // An unresolved relative import does not create an indexed dependency: its
    // target is outside the captured source manifest.  Earlier versions
    // treated any such import as a project-wide invalidation, which made a
    // one-file content edit in a bounded workspace (for example the n8n
    // benchmark slice) rebuild every owner.  File-set changes are handled by
    // the caller as a full reset; for stable paths the known reverse graph is
    // the exact closure that can change.
    let mut reverse: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for files in [prior, Some(next)].into_iter().flatten() {
        for (source, result) in files {
            for target in result
                .direct_imports
                .iter()
                .filter_map(|import| import.target_path.as_ref())
            {
                reverse
                    .entry(target.clone())
                    .or_default()
                    .insert(source.clone());
            }
        }
    }
    let mut affected = changed.clone();
    let mut queue: VecDeque<String> = changed.iter().cloned().collect();
    while let Some(target) = queue.pop_front() {
        for dependent in reverse.get(&target).into_iter().flatten() {
            if affected.insert(dependent.clone()) {
                queue.push_back(dependent.clone());
            }
        }
    }
    affected
}

fn language_for_path(path: &str) -> Option<(Language, ScriptKind)> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".tsx") {
        Some((Language::Typescript, ScriptKind::Tsx))
    } else if lower.ends_with(".jsx") {
        Some((Language::Javascript, ScriptKind::Jsx))
    } else if [".ts", ".mts", ".cts"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
    {
        Some((Language::Typescript, ScriptKind::Ts))
    } else if [".js", ".mjs", ".cjs"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
    {
        Some((Language::Javascript, ScriptKind::Js))
    } else {
        None
    }
}

fn retained_bytes(files: &BTreeMap<String, SyntaxFileResult>) -> u64 {
    files
        .values()
        .map(|file| {
            file.path.len()
                + file.content_digest.len()
                + file
                    .direct_imports
                    .iter()
                    .map(|import| {
                        import.specifier.len() + import.target_path.as_ref().map_or(0, String::len)
                    })
                    .sum::<usize>()
                + file
                    .entities
                    .iter()
                    .map(|entity| {
                        entity.id.len()
                            + entity.name.len()
                            + entity.path.len()
                            + entity.parent_id.as_ref().map_or(0, String::len)
                            + entity.qualified_name.as_ref().map_or(0, String::len)
                    })
                    .sum::<usize>()
                + file
                    .relations
                    .iter()
                    .map(|relation| {
                        relation.id.len()
                            + relation.source_id.len()
                            + relation.target_id.as_ref().map_or(0, String::len)
                            + relation.path.len()
                    })
                    .sum::<usize>()
                + file
                    .export_bindings
                    .iter()
                    .map(|binding| {
                        binding.exported_name.len()
                            + binding.local_name.len()
                            + binding.source_specifier.as_ref().map_or(0, String::len)
                            + binding.source_target_path.as_ref().map_or(0, String::len)
                    })
                    .sum::<usize>()
                + file
                    .export_star_specifiers
                    .iter()
                    .map(|star| {
                        star.specifier.len() + star.target_path.as_ref().map_or(0, String::len)
                    })
                    .sum::<usize>()
        })
        .sum::<usize>() as u64
}

fn sha256_digest(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(71);
    output.push_str("sha256:");
    for byte in Sha256::digest(bytes) {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn truncate_message(value: &str) -> String {
    value.chars().take(1024).collect()
}

fn validate_identifier(value: &str, field: &str) -> Result<(), AnalysisError> {
    if value.is_empty()
        || value.len() > 240
        || value
            .bytes()
            .any(|byte| matches!(byte, 0 | b'\r' | b'\n' | b'\t'))
    {
        protocol_error(&format!("{field} is invalid"))
    } else {
        Ok(())
    }
}

fn validate_digest(value: &str, field: &str) -> Result<(), AnalysisError> {
    validate_identifier(value, field)?;
    if value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        protocol_error(&format!("{field} must be a lowercase SHA-256 digest"))
    }
}

fn validate_path(path: &str) -> Result<(), AnalysisError> {
    validate_identifier(path, "path")?;
    if path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        protocol_error("source path must be normalized and relative")
    } else {
        Ok(())
    }
}

fn protocol_error<T>(message: &str) -> Result<T, AnalysisError> {
    Err(AnalysisError {
        code: ErrorCode::ProtocolInvalid,
        message: message.into(),
    })
}
fn resource_error<T>(message: &str) -> Result<T, AnalysisError> {
    Err(AnalysisError {
        code: ErrorCode::ResourceExhausted,
        message: message.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A3b mechanism item 5: `RecordBody::Encoded` must serialize to the
    /// EXACT same JSON `serde_json::to_string(&ProposedRecord)` would have
    /// produced for the equivalent `RecordBody::Value` -- this is the IPC/
    /// `AnalysisResponse` wire contract, and must not change no matter which
    /// variant a given record happens to carry. Checked for one relation
    /// body (`source_id`/`target_id`/`classification`/`path`/`start`/`end`)
    /// and one entity body (`name`/`kind`/`language`/`path`/`start`/`end`,
    /// with `parent_id` present) -- covers both a `BodyEncoder::string`+
    /// `uint` mix and the optional-field case.
    #[test]
    fn encoded_body_serializes_identically_to_a_plain_value_body() {
        fn record_with_body(body: RecordBody) -> ProposedRecord {
            ProposedRecord {
                proposal_record_key: "jsts:record:sha256:test".to_owned(),
                category: "relation",
                kind: "jsts:relation_call".to_owned(),
                universal_kind: "core:call".to_owned(),
                facets: "[\"core:reference_relation\"]".to_owned(),
                schema_version: 1,
                source_span: "{\"end\":2,\"path\":\"a.ts\",\"start\":1}".to_owned(),
                span_start_line: 1,
                span_end_line: 1,
                identity_key: "jsts:call:a.ts:1:2:src:tgt".to_owned(),
                body,
                source_id: Some("src".to_owned()),
                target_id: Some("tgt".to_owned()),
                evidence_references: "[]".to_owned(),
                facets_list: vec!["core:reference_relation".to_owned()],
            }
        }

        let value_body = serde_json::json!({
            "classification": "confirmed",
            "end": 2u32,
            "path": "a.ts",
            "source_id": "src",
            "start": 1u32,
            "target_id": "tgt",
        });
        let mut encoder = urdira_native_core::BodyEncoder::new();
        encoder.begin_object(6).unwrap();
        encoder.key("classification").unwrap();
        encoder.string("confirmed").unwrap();
        encoder.key("end").unwrap();
        encoder.uint(2).unwrap();
        encoder.key("path").unwrap();
        encoder.string("a.ts").unwrap();
        encoder.key("source_id").unwrap();
        encoder.string("src").unwrap();
        encoder.key("start").unwrap();
        encoder.uint(1).unwrap();
        encoder.key("target_id").unwrap();
        encoder.string("tgt").unwrap();
        let encoded_body = encoder.finish();

        let value_record = record_with_body(RecordBody::Value(value_body));
        let encoded_record = record_with_body(RecordBody::Encoded(encoded_body));

        assert_eq!(
            serde_json::to_string(&value_record).unwrap(),
            serde_json::to_string(&encoded_record).unwrap(),
            "Encoded relation body must serialize identically to the equivalent Value body"
        );

        // Entity body variant, including an optional field (`parent_id`).
        let value_entity_body = serde_json::json!({
            "end": 20u32,
            "kind": "method",
            "language": "typescript",
            "name": "run",
            "parent_id": "jsts:class:a.ts:0:Widget",
            "path": "a.ts",
            "start": 10u32,
        });
        let mut entity_encoder = urdira_native_core::BodyEncoder::new();
        entity_encoder.begin_object(7).unwrap();
        entity_encoder.key("end").unwrap();
        entity_encoder.uint(20).unwrap();
        entity_encoder.key("kind").unwrap();
        entity_encoder.string("method").unwrap();
        entity_encoder.key("language").unwrap();
        entity_encoder.string("typescript").unwrap();
        entity_encoder.key("name").unwrap();
        entity_encoder.string("run").unwrap();
        entity_encoder.key("parent_id").unwrap();
        entity_encoder.string("jsts:class:a.ts:0:Widget").unwrap();
        entity_encoder.key("path").unwrap();
        entity_encoder.string("a.ts").unwrap();
        entity_encoder.key("start").unwrap();
        entity_encoder.uint(10).unwrap();
        let encoded_entity_body = entity_encoder.finish();

        let mut value_entity = record_with_body(RecordBody::Value(value_entity_body));
        value_entity.category = "entity";
        value_entity.source_id = None;
        value_entity.target_id = None;
        let mut encoded_entity = record_with_body(RecordBody::Encoded(encoded_entity_body));
        encoded_entity.category = "entity";
        encoded_entity.source_id = None;
        encoded_entity.target_id = None;

        assert_eq!(
            serde_json::to_string(&value_entity).unwrap(),
            serde_json::to_string(&encoded_entity).unwrap(),
            "Encoded entity body must serialize identically to the equivalent Value body"
        );
    }

    #[test]
    fn dependency_proposal_identity_is_bounded_and_domain_separated() {
        let relation_id = "jsts:import:packages/@n8n/agents/src/__tests__/integration/custom-message-suspend-resume.test.ts:63:98:jsts:module:packages/@n8n/agents/src/__tests__/integration/custom-message-suspend-resume.test.ts:0:packages/@n8n/agents/src/__tests__/integration/custom-message-suspend-resume.test.ts:jsts:module:packages/@n8n/agents/src/__tests__/integration/helpers.ts:0:packages/@n8n/agents/src/__tests__/integration/helpers.ts";
        let artifact_version_id = format!("artifact-version:{}", "a".repeat(64));

        let identity = proposed_dependency_id(relation_id, &artifact_version_id);

        assert!(identity.starts_with("jsts:dependency:sha256:"));
        assert_eq!(identity.chars().count(), 87);
        assert_eq!(
            identity,
            "jsts:dependency:sha256:c4cb48ff9d4b05bd4f48fe07c66328e84e1e2884d94e4e7852fb157059a97041"
        );
    }

    #[test]
    fn proposal_record_key_is_bounded_and_domain_separated() {
        let identity_key = "jsts:contains:packages/@n8n/ai-utilities/src/__tests__/utils/failed-attempt-handler/n8nDefaultFailedAttemptHandler.test.ts:1089:1103:jsts:module:packages/@n8n/ai-utilities/src/__tests__/utils/failed-attempt-handler/n8nDefaultFailedAttemptHandler.test.ts:0:packages/@n8n/ai-utilities/src/__tests__/utils/failed-attempt-handler/n8nDefaultFailedAttemptHandler.test.ts:jsts:class:packages/@n8n/ai-utilities/src/__tests__/utils/failed-attempt-handler/n8nDefaultFailedAttemptHandler.test.ts:1089:MockAbortError";

        let key = proposal_record_key(identity_key);

        assert_eq!(key.chars().count(), 83);
        assert_eq!(
            key,
            "jsts:record:sha256:738f6e2eded71e09664e8b83a97da348bfe55276f1bdbf215189cc83e14b9d5f"
        );
    }

    fn source(path: &str, text: &str) -> SourceInput {
        let bytes = text.as_bytes();
        let digest = sha256_digest(bytes);
        let blob_path = std::env::temp_dir().join(format!(
            "urdira-jsts-worker-test-{:?}-{}",
            std::thread::current().id(),
            digest.trim_start_matches("sha256:")
        ));
        std::fs::write(&blob_path, bytes).expect("write explicit test blob");
        SourceInput {
            path: path.into(),
            artifact_id: format!("artifact:{path}"),
            artifact_version_id: format!(
                "artifact-version:{}",
                digest.trim_start_matches("sha256:")
            ),
            content_digest: digest,
            source_blob_path: blob_path.to_string_lossy().into_owned(),
            byte_length: bytes.len(),
        }
    }

    fn analyze(
        state: &mut SyntaxWorkerState,
        sources: Vec<SourceInput>,
        roots: &[&str],
        config: char,
    ) -> WorkerMessage {
        analyze_with_change_set(state, sources, roots, config, AuthoritativeChangeSet::Full)
    }

    fn analyze_exact(
        state: &mut SyntaxWorkerState,
        sources: Vec<SourceInput>,
        roots: &[&str],
        config: char,
        changed_artifact_ids: &[&str],
    ) -> WorkerMessage {
        analyze_with_change_set(
            state,
            sources,
            roots,
            config,
            AuthoritativeChangeSet::Exact {
                changed_artifact_ids: changed_artifact_ids
                    .iter()
                    .map(|artifact_id| (*artifact_id).into())
                    .collect(),
            },
        )
    }

    fn analyze_with_change_set(
        state: &mut SyntaxWorkerState,
        sources: Vec<SourceInput>,
        roots: &[&str],
        config: char,
        change_set: AuthoritativeChangeSet,
    ) -> WorkerMessage {
        try_analyze_with_change_set(state, sources, roots, config, change_set).unwrap()
    }

    fn try_analyze_with_change_set(
        state: &mut SyntaxWorkerState,
        sources: Vec<SourceInput>,
        roots: &[&str],
        config: char,
        change_set: AuthoritativeChangeSet,
    ) -> Result<WorkerMessage, AnalysisError> {
        state.analyze(
            "request:one".into(),
            "cancel:one".into(),
            "project:one".into(),
            format!("sha256:{}", config.to_string().repeat(64)),
            roots.iter().map(|root| (*root).into()).collect(),
            sources,
            Vec::new(),
            change_set,
            AnalysisBudgets {
                max_output_bytes: 1_000_000,
                max_files: 100,
                max_source_bytes: 1_000_000,
                enforce_output_bytes: true,
            },
            &AtomicBool::new(false),
        )
    }

    fn read_page(
        state: &SyntaxWorkerState,
        path: &str,
        cursor: Option<FactsCursor>,
        max_output_bytes: u32,
        max_rows: u32,
    ) -> WorkerMessage {
        state
            .read_facts(
                format!("request:facts:{path}"),
                format!("cancel:facts:{path}"),
                "project:one".into(),
                path.into(),
                cursor,
                max_output_bytes,
                max_rows,
            )
            .unwrap()
    }

    #[test]
    fn oxc_parses_all_four_syntax_families_and_extracts_direct_edges() {
        let mut state = SyntaxWorkerState::default();
        let files = vec![
            source("a.js", "export { value } from './b.js'; import('./c.jsx');"),
            source("b.js", "export const value = 1;"),
            source("c.jsx", "export const View = () => <div />;"),
            source("d.ts", "export type Value = string;"),
            source(
                "e.tsx",
                "import type { Value } from './d'; export const V = (_p: Value) => <span />;",
            ),
        ];
        let roots = ["a.js", "b.js", "c.jsx", "d.ts", "e.tsx"];
        let WorkerMessage::AnalysisResult { build, .. } = analyze(&mut state, files, &roots, '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        let facts = roots
            .iter()
            .map(|path| {
                state
                    .read_facts(
                        format!("request:facts:{path}"),
                        format!("cancel:facts:{path}"),
                        "project:one".into(),
                        (*path).into(),
                        None,
                        1_000_000,
                        4096,
                    )
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert!(
            facts
                .iter()
                .all(|result| matches!(result, WorkerMessage::FactsResult { parsed: true, .. }))
        );
        let a = facts
            .iter()
            .find(|result| {
                matches!(
                    result,
                    WorkerMessage::FactsResult { path, .. } if path == "a.js"
                )
            })
            .unwrap();
        let WorkerMessage::FactsResult {
            direct_imports,
            records,
            ..
        } = a
        else {
            unreachable!()
        };
        assert_eq!(
            direct_imports
                .iter()
                .filter_map(|edge| edge.target_path.as_deref())
                .collect::<Vec<_>>(),
            vec!["b.js", "c.jsx"]
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| record.category == "entity")
                .map(|record| {
                    let body = record.body.to_value();
                    (
                        body["kind"].as_str().unwrap().to_owned(),
                        body["name"].as_str().unwrap().to_owned(),
                    )
                })
                .collect::<Vec<_>>(),
            vec![("module".to_owned(), "a.js".to_owned())]
        );
        assert!(records.iter().any(|record| {
            record.kind == "jsts:relation_export"
                && record.body.to_value()["classification"] == "confirmed"
        }));
        let WorkerMessage::FactsResult {
            direct_imports,
            records,
            ..
        } = facts
            .iter()
            .find(|result| {
                matches!(
                    result,
                    WorkerMessage::FactsResult { path, .. } if path == "e.tsx"
                )
            })
            .unwrap()
        else {
            unreachable!()
        };
        assert_eq!(direct_imports[0].target_path.as_deref(), Some("d.ts"));
        assert!(records.iter().any(|record| {
            record.category == "entity"
                && record.body.to_value()["kind"] == "variable"
                && record.body.to_value()["name"] == "V"
        }));
    }

    // -- 2026-09-04 external package/symbol entities task: lane 1 (module-
    // level `jsts:relation_import`/`_export` target + `external_module`
    // entity) ------------------------------------------------------------

    #[test]
    fn unresolved_bare_import_gets_an_external_module_entity_and_a_confirmed_relation_target() {
        let mut state = SyntaxWorkerState::default();
        let files = vec![source("a.ts", "import { get } from \"lodash\";\nget(1);\n")];
        let WorkerMessage::AnalysisResult { build, .. } =
            analyze(&mut state, files, &["a.ts"], '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        let WorkerMessage::FactsResult {
            records,
            direct_imports,
            ..
        } = read_page(&state, "a.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        // The workspace resolver still reports no workspace target -- lane 1
        // never invents a fake file path.
        assert_eq!(direct_imports[0].target_path, None);
        let import_relation = records
            .iter()
            .find(|record| record.kind == "jsts:relation_import")
            .expect("expected an import relation record");
        assert_eq!(
            import_relation.body.to_value()["target_id"],
            "jsts:external_module:lodash",
            "the relation now carries the external module as its target"
        );
        assert_eq!(
            import_relation.body.to_value()["classification"],
            "confirmed"
        );
        let module_entity = records
            .iter()
            .find(|record| record.identity_key == "jsts:external_module:lodash")
            .expect("expected an external_module entity record");
        assert_eq!(module_entity.category, "entity");
        assert_eq!(module_entity.kind, "jsts:entity_container");
        assert_eq!(module_entity.universal_kind, "core:container");
        assert_eq!(module_entity.body.to_value()["kind"], "external_module");
        assert_eq!(module_entity.body.to_value()["name"], "lodash");
    }

    #[test]
    fn export_from_an_unresolved_bare_specifier_also_targets_the_external_module() {
        let mut state = SyntaxWorkerState::default();
        let files = vec![source("a.ts", "export { get } from \"lodash\";\n")];
        let WorkerMessage::AnalysisResult { build, .. } =
            analyze(&mut state, files, &["a.ts"], '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        let WorkerMessage::FactsResult { records, .. } =
            read_page(&state, "a.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        let export_relation = records
            .iter()
            .find(|record| record.kind == "jsts:relation_export")
            .expect("expected an export relation record");
        assert_eq!(
            export_relation.body.to_value()["target_id"],
            "jsts:external_module:lodash"
        );
        assert_eq!(
            export_relation.body.to_value()["classification"],
            "confirmed"
        );
    }

    #[test]
    fn relative_import_that_fails_to_resolve_never_gets_an_external_module_entity() {
        let mut state = SyntaxWorkerState::default();
        let files = vec![source("a.ts", "import { helper } from \"./missing\";\n")];
        let WorkerMessage::AnalysisResult { build, .. } =
            analyze(&mut state, files, &["a.ts"], '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        let WorkerMessage::FactsResult { records, .. } =
            read_page(&state, "a.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        let import_relation = records
            .iter()
            .find(|record| record.kind == "jsts:relation_import")
            .expect("expected an import relation record");
        assert_eq!(import_relation.body.to_value().get("target_id"), None);
        assert_eq!(
            import_relation.body.to_value()["classification"],
            "possible"
        );
        assert!(
            !records
                .iter()
                .any(|record| record.identity_key.starts_with("jsts:external_module:")),
            "a relative specifier that merely failed to resolve must never synthesize an external entity: {records:?}"
        );
        // Exactly one entity (the owner's own module) -- same invariant the
        // pre-existing `oxc_parses_all_four_syntax_families_and_extracts_
        // direct_edges` test above already asserts for a resolvable import.
        assert_eq!(
            records
                .iter()
                .filter(|record| record.category == "entity")
                .count(),
            1
        );
    }

    // -- A4 (line numbers task, 2026-09-05) --------------------------------

    #[test]
    fn entity_record_carries_the_real_editor_line_past_a_multibyte_comment() {
        // Line 1 is a comment containing "café" -- 5 UTF-8 bytes ('é' is a
        // 2-byte UTF-8 sequence) but only 4 UTF-16 code units -- so a byte-
        // counting (rather than UTF-16-code-unit-counting) line index would
        // still land on the right line here (multibyte content stays BEFORE
        // the newline either way), but a naive per-BYTE offset->line lookup
        // fed a UTF-16 offset (the bug this whole task exists to avoid)
        // would drift onto the wrong line for any file where this shows up
        // more than once -- this fixture at least exercises the conversion
        // path end to end. Line 2 is empty. The function declaration is on
        // line 3.
        let source_text = "// café\n\nexport function greet(): void {}\n";
        let mut state = SyntaxWorkerState::default();
        let files = vec![source("a.ts", source_text)];
        let WorkerMessage::AnalysisResult { build, .. } =
            analyze(&mut state, files, &["a.ts"], '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        let WorkerMessage::FactsResult { records, .. } =
            read_page(&state, "a.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        let entity = records
            .iter()
            .find(|record| {
                record.kind == "jsts:entity_callable" && record.body.to_value()["name"] == "greet"
            })
            .expect("expected the `greet` function entity");
        assert_eq!(
            entity.span_start_line, 3,
            "entity record: {entity:?}, source: {source_text:?}"
        );
        assert_eq!(
            entity.span_end_line, 3,
            "entity record: {entity:?}, source: {source_text:?}"
        );
    }

    // -- Ambient module resolution task (2026-09-04) ----------------------

    #[test]
    fn ambient_module_declaration_gets_a_namespace_entity_and_its_members_keep_their_own_ids() {
        let mut state = SyntaxWorkerState::default();
        let files = vec![source(
            "plugins.d.ts",
            "declare module \"eslint-plugin-lodash\" {\n  export function configure(): void;\n}\n",
        )];
        let WorkerMessage::AnalysisResult { build, .. } =
            analyze(&mut state, files, &["plugins.d.ts"], '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        let WorkerMessage::FactsResult { records, .. } =
            read_page(&state, "plugins.d.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        let text =
            "declare module \"eslint-plugin-lodash\" {\n  export function configure(): void;\n}\n";
        let quote_start = text.find('"').unwrap() as u32;
        let namespace_id =
            format!("jsts:namespace:plugins.d.ts:{quote_start}:eslint-plugin-lodash");
        let namespace_entity = records
            .iter()
            .find(|record| record.identity_key == namespace_id)
            .unwrap_or_else(|| panic!("expected a namespace entity {namespace_id}: {records:?}"));
        assert_eq!(namespace_entity.body.to_value()["kind"], "namespace");
        assert_eq!(namespace_entity.universal_kind, "core:type");
        assert_eq!(
            namespace_entity.body.to_value()["name"],
            "eslint-plugin-lodash"
        );
        // The member's own entity id is UNAFFECTED by ambient nesting -- the
        // ordinary `visit_function`/`push_entity` producer already covers
        // it, byte-identical to what `AmbientModuleDeclaration::members`
        // records for resolution purposes.
        let function_start = text.find("configure").unwrap() as u32;
        let function_id = format!("jsts:function:plugins.d.ts:{function_start}:configure");
        assert!(
            records
                .iter()
                .any(|record| record.identity_key == function_id),
            "expected a function entity {function_id}: {records:?}"
        );
    }

    /// 3b (2026-09-05): an `Identifier`-named `TSModuleDeclaration`
    /// (`namespace Foo {}`, here wrapped in `export`) now gets its own
    /// `EntityKind::Namespace` entity plus a `core:contains` relation from
    /// the file's module entity, mirroring `push_namespace_entity`'s
    /// string-literal (ambient module) sibling above -- see that test for
    /// the ambient-module-still-works-unchanged half of this coverage.
    #[test]
    fn namespace_identifier_declaration_gets_its_own_entity_and_contains_relation() {
        let mut state = SyntaxWorkerState::default();
        let text = "export namespace Foo {\n  export const a = 1;\n}\n";
        let files = vec![source("ns.ts", text)];
        let WorkerMessage::AnalysisResult { build, .. } =
            analyze(&mut state, files, &["ns.ts"], '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        let WorkerMessage::FactsResult { records, .. } =
            read_page(&state, "ns.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        let name_start = text.find("Foo").unwrap() as u32;
        let name_end = name_start + "Foo".len() as u32;
        let namespace_id = format!("jsts:namespace:ns.ts:{name_start}:Foo");
        let namespace_entity = records
            .iter()
            .find(|record| record.identity_key == namespace_id)
            .unwrap_or_else(|| panic!("expected a namespace entity {namespace_id}: {records:?}"));
        assert_eq!(namespace_entity.body.to_value()["kind"], "namespace");
        assert_eq!(namespace_entity.universal_kind, "core:type");
        assert_eq!(namespace_entity.body.to_value()["name"], "Foo");

        let module_id = stable_entity_id(EntityKind::Module, "ns.ts", 0, "ns.ts");
        let contains_id =
            format!("jsts:contains:ns.ts:{name_start}:{name_end}:{module_id}:{namespace_id}");
        let contains_relation = records
            .iter()
            .find(|record| record.identity_key == contains_id)
            .unwrap_or_else(|| {
                panic!("expected a core:contains relation {contains_id}: {records:?}")
            });
        assert_eq!(contains_relation.universal_kind, "core:contains");

        // Nested declarations inside the namespace block still get their
        // own entity through the ordinary recursive walk, unaffected.
        let variable_start = (text.find("const a").unwrap() + "const ".len()) as u32;
        let variable_id = format!("jsts:variable:ns.ts:{variable_start}:a");
        assert!(
            records
                .iter()
                .any(|record| record.identity_key == variable_id),
            "expected a variable entity {variable_id}: {records:?}"
        );
    }

    fn parse_source_for_test(path: &str, text: &str) -> SyntaxFileResult {
        let decoded = DecodedSource {
            path: path.to_owned(),
            content_digest: sha256_digest(text.as_bytes()),
            bytes: text.as_bytes().to_vec(),
            language: Language::Typescript,
            script_kind: ScriptKind::Ts,
        };
        let available = BTreeSet::new();
        let resolver = WorkspaceResolver::default();
        parse_source(&decoded, &available, &resolver).expect("parses")
    }

    /// D.1 (2026-09-05, references-parity task): a SCRIPT file (no
    /// top-level `import`/`export` of its own) declaring `namespace jest
    /// {}` at its own top level contributes a `ScriptTopLevel` ambient
    /// global candidate for `jest` -- the entity id is byte-identical to
    /// the one the ordinary recursive walk already gives this same
    /// declaration (`push_entity`'s own formula).
    #[test]
    fn script_top_level_namespace_becomes_an_ambient_global_candidate() {
        let text = "namespace jest {\n  interface Mock {}\n}\n";
        let result = parse_source_for_test("jest.d.ts", text);
        let name_start = text.find("jest").unwrap() as u32;
        let expected_id = format!("jsts:namespace:jest.d.ts:{name_start}:jest");
        assert_eq!(
            result.ambient_globals,
            vec![AmbientGlobalDeclaration {
                name: "jest".to_owned(),
                entity_id: expected_id.clone(),
                kind: EntityKind::Namespace,
                scope: GlobalScope::ScriptTopLevel,
            }],
            "expected exactly one ScriptTopLevel candidate for jest, got {:?}",
            result.ambient_globals
        );
        // Entity emission is unaffected -- the SAME entity id already
        // exists in `entities`, this list is purely an additional lookup
        // fact pointing at it.
        assert!(
            result
                .entities
                .iter()
                .any(|entity| entity.id == expected_id),
            "expected the namespace's own entity to still exist: {:?}",
            result.entities
        );
    }

    /// D.1: the SAME `namespace jest {}` declared at a file's top level,
    /// but that file ALSO has `export {}` (module syntax --
    /// `file_has_top_level_module_syntax`'s own five recognized forms): the
    /// file is a MODULE, so its top level does NOT extend the shared
    /// global scope -- the `ScriptTopLevel` candidate is discarded by
    /// `parse_source`'s own post-walk filter (the SAME filter that patches
    /// `AmbientModuleDeclaration::is_augmentation`), even though the
    /// namespace's own entity still exists unaffected.
    #[test]
    fn namespace_in_a_module_file_never_enters_the_ambient_global_index() {
        let text = "namespace jest {\n  interface Mock {}\n}\nexport {};\n";
        let result = parse_source_for_test("mod-jest.d.ts", text);
        assert!(
            result.ambient_globals.is_empty(),
            "a namespace in a MODULE file must never enter the ambient-global index: {:?}",
            result.ambient_globals
        );
        let name_start = text.find("jest").unwrap() as u32;
        let expected_id = format!("jsts:namespace:mod-jest.d.ts:{name_start}:jest");
        assert!(
            result
                .entities
                .iter()
                .any(|entity| entity.id == expected_id),
            "the namespace's own entity must still exist regardless of the ambient-global filter: {:?}",
            result.entities
        );
    }

    /// D.1: `declare global { var foo: number; interface Window {} }` --
    /// every declaration DIRECTLY inside the block becomes a
    /// `DeclareGlobal` candidate (via `visit_ts_global_declaration`'s own
    /// flat, one-level scan), regardless of the file's own script-vs-
    /// module status (this file itself has no top-level import/export --
    /// see the next test for the module case) -- and no spurious `global`-
    /// named entity is ever created for the block itself.
    #[test]
    fn declare_global_block_children_become_declare_global_candidates() {
        let text = "declare global {\n  var foo: number;\n  interface Window {}\n}\n";
        let result = parse_source_for_test("globals.ts", text);
        let foo_start = text.find("foo").unwrap() as u32;
        let window_start = text.find("Window").unwrap() as u32;
        let mut globals = result.ambient_globals.clone();
        globals.sort_by(|left, right| left.name.cmp(&right.name));
        // ASCII sort puts the capitalized `Window` before lowercase `foo`.
        assert_eq!(
            globals,
            vec![
                AmbientGlobalDeclaration {
                    name: "Window".to_owned(),
                    entity_id: format!("jsts:interface:globals.ts:{window_start}:Window"),
                    kind: EntityKind::Interface,
                    scope: GlobalScope::DeclareGlobal,
                },
                AmbientGlobalDeclaration {
                    name: "foo".to_owned(),
                    entity_id: format!("jsts:variable:globals.ts:{foo_start}:foo"),
                    kind: EntityKind::Variable,
                    scope: GlobalScope::DeclareGlobal,
                },
            ],
            "expected DeclareGlobal candidates for both foo and Window, got {:?}",
            result.ambient_globals
        );
        assert!(
            !result
                .entities
                .iter()
                .any(|entity| entity.kind == EntityKind::Module && entity.name == "global"),
            "declare global {{}} must never create its own spurious entity"
        );
    }

    /// D.1: `declare global {}` reaches its shared-global-scope semantics
    /// regardless of whether ITS OWN file is a script or a module -- unlike
    /// `ScriptTopLevel` candidates, `DeclareGlobal` ones are never filtered
    /// by `parse_source`'s post-walk script-vs-module check.
    #[test]
    fn declare_global_block_in_a_module_file_still_enters_the_ambient_global_index() {
        let text = "declare global {\n  var foo: number;\n}\nexport {};\n";
        let result = parse_source_for_test("globals.ts", text);
        let foo_start = text.find("foo").unwrap() as u32;
        assert_eq!(
            result.ambient_globals,
            vec![AmbientGlobalDeclaration {
                name: "foo".to_owned(),
                entity_id: format!("jsts:variable:globals.ts:{foo_start}:foo"),
                kind: EntityKind::Variable,
                scope: GlobalScope::DeclareGlobal,
            }],
        );
    }

    /// 3c (2026-09-05): every declarator of a comma-separated
    /// `VariableDeclaration` gets its own entity, not just the first --
    /// before this fix, `b` here had NO entity at all: `use(b)`'s reference
    /// (`semantic_sites.rs`'s `classify_symbol_declaration` already
    /// classified a non-first `BindingIdentifier` declarator as `DeclKind::
    /// Variable` before this task) would resolve to an identity key that no
    /// `SyntaxEntity` this crate published ever matched -- a dangling
    /// reference at the store level. This crate's plain `analyze`/`read_
    /// page` only exercises lane 1 (entities); see `semantic_sites::tests::
    /// non_first_declarator_reference_resolves_to_its_own_entity` for lane 2
    /// (the reference resolution itself) matching this SAME identity key.
    #[test]
    fn multi_declarator_variable_declaration_gives_every_declarator_an_entity() {
        let mut state = SyntaxWorkerState::default();
        let text = "const a = 1, b = 2;\nuse(b);\n";
        let files = vec![source("multi.ts", text)];
        let WorkerMessage::AnalysisResult { build, .. } =
            analyze(&mut state, files, &["multi.ts"], '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        let WorkerMessage::FactsResult { records, .. } =
            read_page(&state, "multi.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        let a_start = text.find("a = 1").unwrap() as u32;
        let a_id = format!("jsts:variable:multi.ts:{a_start}:a");
        assert!(
            records.iter().any(|record| record.identity_key == a_id),
            "expected the first declarator's entity {a_id}: {records:?}"
        );
        let b_start = text.find("b = 2").unwrap() as u32;
        let b_id = format!("jsts:variable:multi.ts:{b_start}:b");
        assert!(
            records.iter().any(|record| record.identity_key == b_id),
            "expected the second declarator's entity {b_id}: {records:?}"
        );
    }

    #[test]
    fn ambient_named_import_relation_targets_the_namespace_entity_not_an_external_module() {
        let mut state = SyntaxWorkerState::default();
        let declaration_text =
            "declare module \"eslint-plugin-lodash\" {\n  export function configure(): void;\n}\n";
        let files = vec![
            source("plugins.d.ts", declaration_text),
            source(
                "a.ts",
                "import { configure } from \"eslint-plugin-lodash\";\nconfigure();\n",
            ),
        ];
        let WorkerMessage::AnalysisResult { build, .. } =
            analyze(&mut state, files, &["plugins.d.ts", "a.ts"], '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        let WorkerMessage::FactsResult { records, .. } =
            read_page(&state, "a.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        let quote_start = declaration_text.find('"').unwrap() as u32;
        let namespace_id =
            format!("jsts:namespace:plugins.d.ts:{quote_start}:eslint-plugin-lodash");
        let import_relation = records
            .iter()
            .find(|record| record.kind == "jsts:relation_import")
            .expect("expected an import relation record");
        assert_eq!(import_relation.body.to_value()["target_id"], namespace_id);
        assert_eq!(
            import_relation.body.to_value()["classification"],
            "confirmed"
        );
        assert!(
            !records
                .iter()
                .any(|record| record.identity_key.starts_with("jsts:external_module:")),
            "an ambiently-resolved specifier must never synthesize an external_module entity: {records:?}"
        );
    }

    /// Fix item 2's own incremental requirement: adding a `declare module`
    /// for a specifier previously external flips EVERY importer's relation
    /// target on the NEXT scan, even when the importer's own content did
    /// not change this call (so it is never among `changed_sources`, and
    /// `ImportReverseIndex`/`CandidateIndex` -- both keyed by resolvable
    /// PATHS -- can never find it either).
    #[test]
    fn incrementally_adding_an_ambient_declaration_flips_a_previously_external_importer() {
        let mut state = SyntaxWorkerState::default();
        let importer_text = "import { configure } from \"eslint-plugin-lodash\";\nconfigure();\n";
        let first_pass = vec![source("a.ts", importer_text)];
        let WorkerMessage::AnalysisResult { build, .. } =
            analyze(&mut state, first_pass, &["a.ts"], '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        let WorkerMessage::FactsResult { records, .. } =
            read_page(&state, "a.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        let import_relation = records
            .iter()
            .find(|record| record.kind == "jsts:relation_import")
            .expect("expected an import relation record");
        assert_eq!(
            import_relation.body.to_value()["target_id"],
            "jsts:external_module:eslint-plugin-lodash",
            "before the ambient declaration exists, this stays external"
        );

        // Second scan: `a.ts` is byte-identical (never re-parsed this
        // call), only `plugins.d.ts` is newly added.
        let declaration_text =
            "declare module \"eslint-plugin-lodash\" {\n  export function configure(): void;\n}\n";
        let second_pass = vec![
            source("a.ts", importer_text),
            source("plugins.d.ts", declaration_text),
        ];
        let WorkerMessage::AnalysisResult {
            build,
            affected_files,
            ..
        } = analyze(&mut state, second_pass, &["a.ts", "plugins.d.ts"], '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Incremental);
        assert!(
            affected_files.iter().any(|path| path == "a.ts"),
            "the importer must be reported as affected even though its own text did not change: {affected_files:?}"
        );
        let WorkerMessage::FactsResult { records, .. } =
            read_page(&state, "a.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        let quote_start = declaration_text.find('"').unwrap() as u32;
        let namespace_id =
            format!("jsts:namespace:plugins.d.ts:{quote_start}:eslint-plugin-lodash");
        let import_relation = records
            .iter()
            .find(|record| record.kind == "jsts:relation_import")
            .expect("expected an import relation record");
        assert_eq!(
            import_relation.body.to_value()["target_id"],
            namespace_id,
            "the importer's relation must flip to the ambient namespace entity on the next scan"
        );
        assert!(
            !records
                .iter()
                .any(|record| record.identity_key.starts_with("jsts:external_module:")),
            "the now-stale external_module entity must not survive the flip: {records:?}"
        );
    }

    /// n8n corpus regression (found live: 649 `v4_different_target` rows,
    /// all tracing back to `packages/frontend/@n8n/chat/src/env.d.ts`):
    /// `declare module '~icons/*' { const component: T; export default
    /// component; }` -- a WILDCARD specifier pattern, `export default`ing a
    /// BARE (never itself `export`ed) local declaration. Both the wildcard
    /// match and the non-exported default target must resolve.
    #[test]
    fn ambient_wildcard_default_export_of_a_bare_local_declaration_resolves() {
        let mut state = SyntaxWorkerState::default();
        let declaration_text = "declare module \"~icons/*\" {\n  const component: unknown;\n  export default component;\n}\n";
        let files = vec![
            source("env.d.ts", declaration_text),
            source(
                "a.ts",
                "import IconLucideMessageSquare from \"~icons/lucide/message-square\";\nconsole.log(IconLucideMessageSquare);\n",
            ),
        ];
        let WorkerMessage::AnalysisResult { build, .. } =
            analyze(&mut state, files, &["env.d.ts", "a.ts"], '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        let WorkerMessage::FactsResult { records, .. } =
            read_page(&state, "a.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        let component_start = declaration_text.find("component").unwrap() as u32;
        let target_id = format!("jsts:variable:env.d.ts:{component_start}:component");
        let import_relation = records
            .iter()
            .find(|record| record.kind == "jsts:relation_import")
            .expect("expected an import relation record");
        assert!(
            import_relation.body.to_value()["target_id"]
                .as_str()
                .unwrap()
                .starts_with("jsts:namespace:env.d.ts:"),
            "the wildcard-matched import relation must target the namespace entity, got {:?}",
            import_relation.body.to_value()["target_id"]
        );
        assert!(
            !records
                .iter()
                .any(|record| record.identity_key.starts_with("jsts:external_module:")),
            "a wildcard-matched specifier must never synthesize an external_module entity: {records:?}"
        );
        // The `component` variable entity itself must exist with that id,
        // published under `env.d.ts`'s OWN facts page (the ordinary
        // `visit_variable_declaration` producer, unaffected by ambient
        // nesting -- never the importer's own page).
        let WorkerMessage::FactsResult {
            records: declaration_records,
            ..
        } = read_page(&state, "env.d.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        assert!(
            declaration_records
                .iter()
                .any(|record| record.identity_key == target_id),
            "expected a variable entity {target_id}: {declaration_records:?}"
        );
    }

    /// Owner-flagged follow-up (2026-09-04): a `declare module "vue" {
    /// ... }` block inside a file that ITSELF has top-level `import`/
    /// `export` syntax is a MODULE AUGMENTATION, not a genuine ambient
    /// module declaration -- it must never capture the `vue` specifier.
    /// A real `import { Foo } from "vue"` elsewhere in the workspace must
    /// stay classified `external_module`/`external_symbol`, exactly as it
    /// would with no augmentation file present at all. This is the exact
    /// n8n Vue-frontend regression the owner flagged: many files augment
    /// `vue`/`pinia`/`n8n-workflow`, and without this file-level script-
    /// vs-module distinction, `has_any_declaration("vue")` would return
    /// `true`, permanently reverting every `vue` import to pending.
    #[test]
    fn module_augmentation_never_captures_the_specifier_for_resolution() {
        let mut state = SyntaxWorkerState::default();
        let augmentation_text = "import { ComponentCustomProperties } from \"vue\";\ndeclare module \"vue\" {\n  export interface ComponentCustomProperties {\n    foo: string;\n  }\n}\nexport {};\n";
        let files = vec![
            source("augment.ts", augmentation_text),
            source(
                "a.ts",
                "import { defineComponent } from \"vue\";\ndefineComponent({});\n",
            ),
        ];
        let WorkerMessage::AnalysisResult { build, .. } =
            analyze(&mut state, files, &["augment.ts", "a.ts"], '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        let WorkerMessage::FactsResult { records, .. } =
            read_page(&state, "a.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        let import_relation = records
            .iter()
            .find(|record| record.kind == "jsts:relation_import")
            .expect("expected an import relation record");
        assert_eq!(
            import_relation.body.to_value()["target_id"],
            "jsts:external_module:vue",
            "a module augmentation must never make `vue` resolve ambiently -- it must stay external, got {:?}",
            import_relation.body.to_value()["target_id"]
        );
        assert_eq!(
            import_relation.body.to_value()["classification"],
            "confirmed"
        );
        // The augmentation block's own namespace entity still exists (v3
        // parity -- entity emission is unaffected, only RESOLUTION is
        // gated on `is_augmentation`), published under `augment.ts`'s own
        // facts page.
        let WorkerMessage::FactsResult {
            records: augment_records,
            ..
        } = read_page(&state, "augment.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        assert!(
            augment_records
                .iter()
                .any(|record| record.body.to_value()["kind"] == "namespace"
                    && record.body.to_value()["name"] == "vue"),
            "the augmentation block's own namespace entity must still be published: {augment_records:?}"
        );
    }

    #[test]
    fn two_import_statements_of_the_same_external_package_share_one_module_entity() {
        let mut state = SyntaxWorkerState::default();
        let files = vec![source(
            "a.ts",
            "import { get } from \"lodash\";\nimport { set } from \"lodash\";\n",
        )];
        let WorkerMessage::AnalysisResult { build, .. } =
            analyze(&mut state, files, &["a.ts"], '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        let WorkerMessage::FactsResult { records, .. } =
            read_page(&state, "a.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        assert_eq!(
            records
                .iter()
                .filter(|record| record.identity_key == "jsts:external_module:lodash")
                .count(),
            1,
            "within-file dedup must keep exactly one module entity for two import statements of the same package: {records:?}"
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| record.kind == "jsts:relation_import")
                .count(),
            2,
            "each import STATEMENT still gets its own relation row"
        );
    }

    /// The task brief's own unit-test list: class instance/static methods,
    /// properties, constructor, getter/setter; interface method + property
    /// signatures; an anonymous class skipped; ids equal `urdira_jsts_
    /// typeflow::declaration_id(...)`'s own output; a `contains` relation
    /// per member with the class/interface as source; module-level
    /// `contains` unchanged.
    #[test]
    fn class_and_interface_members_materialize_as_entities_with_typeflow_identity() {
        let mut state = SyntaxWorkerState::default();
        let text = "class Base {\n  constructor(x) {}\n  greet() {}\n  static make() {}\n  get id() { return 1; }\n  set id(v) {}\n  name = \"x\";\n  static count = 0;\n}\ninterface Shape {\n  area(): number;\n  readonly kind: string;\n}\nexport default class {\n  hidden() {}\n}\n";
        let files = vec![source("a.ts", text)];
        let WorkerMessage::AnalysisResult { build, .. } =
            analyze(&mut state, files, &["a.ts"], '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        let WorkerMessage::FactsResult { records, .. } =
            read_page(&state, "a.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };

        let entity_records: Vec<_> = records
            .iter()
            .filter(|record| record.category == "entity")
            .collect();
        let relation_records: Vec<_> = records
            .iter()
            .filter(|record| record.category == "relation")
            .collect();

        // Anonymous default-export class is skipped entirely -- no entity
        // for the class itself, and no member entity for `hidden` either
        // (typeflow's own `summarize_class` never summarizes it, so there
        // is no `MemberEntry`/`MemberDeclaration` to materialize).
        assert!(
            !entity_records
                .iter()
                .any(|record| record.body.to_value()["name"] == "hidden")
        );

        let class_id = entity_records
            .iter()
            .find(|record| {
                record.body.to_value()["kind"] == "class"
                    && record.body.to_value()["name"] == "Base"
            })
            .expect("Base class entity present")
            .identity_key
            .clone();
        assert_eq!(class_id, "jsts:class:a.ts:6:Base");
        let interface_id = entity_records
            .iter()
            .find(|record| {
                record.body.to_value()["kind"] == "interface"
                    && record.body.to_value()["name"] == "Shape"
            })
            .expect("Shape interface entity present")
            .identity_key
            .clone();

        let module_id = entity_records
            .iter()
            .find(|record| record.body.to_value()["kind"] == "module")
            .expect("module entity present")
            .identity_key
            .clone();

        // Module-level `contains` (module -> Base, module -> Shape) is
        // unchanged by member-entity emission.
        assert!(relation_records.iter().any(|record| {
            record.kind == "jsts:relation_contains"
                && record.body.to_value()["source_id"] == module_id
                && record.body.to_value()["target_id"] == class_id
        }));
        assert!(relation_records.iter().any(|record| {
            record.kind == "jsts:relation_contains"
                && record.body.to_value()["source_id"] == module_id
                && record.body.to_value()["target_id"] == interface_id
        }));

        let member = |container_id: &str, name: &str, kind: &str| {
            entity_records
                .iter()
                .find(|record| {
                    record.body.to_value()["parent_id"] == container_id
                        && record.body.to_value()["name"] == name
                        && record.body.to_value()["kind"] == kind
                })
                .unwrap_or_else(|| panic!("missing member entity {container_id}/{name}:{kind}"))
        };

        for (name, kind, projected_kind) in [
            ("constructor", "constructor", "jsts:entity_callable"),
            ("greet", "method", "jsts:entity_callable"),
            ("make", "method", "jsts:entity_callable"),
            ("id", "getter", "jsts:entity_callable"),
            ("id", "setter", "jsts:entity_callable"),
            ("name", "property", "jsts:entity_variable"),
            ("count", "property", "jsts:entity_variable"),
        ] {
            let record = member(&class_id, name, kind);
            assert_eq!(record.kind, projected_kind, "projected kind for {name}");
            assert_eq!(
                record.identity_key,
                urdira_jsts_typeflow::declaration_id(
                    kind,
                    "a.ts",
                    record.body.to_value()["start"].as_u64().unwrap() as u32,
                    name
                ),
                "identity for {name}:{kind} matches typeflow's declaration_id"
            );
            assert_eq!(
                record.body.to_value()["qualified_name"],
                format!("a.ts.Base.{name}")
            );
            // One `contains` relation, container -> this exact member.
            assert!(relation_records.iter().any(|relation| {
                relation.kind == "jsts:relation_contains"
                    && relation.body.to_value()["source_id"] == class_id
                    && relation.body.to_value()["target_id"] == record.identity_key
            }));
        }

        for (name, kind, projected_kind) in [
            ("area", "method", "jsts:entity_callable"),
            ("kind", "property", "jsts:entity_variable"),
        ] {
            let record = member(&interface_id, name, kind);
            assert_eq!(record.kind, projected_kind, "projected kind for {name}");
            assert_eq!(
                record.identity_key,
                urdira_jsts_typeflow::declaration_id(
                    kind,
                    "a.ts",
                    record.body.to_value()["start"].as_u64().unwrap() as u32,
                    name
                ),
            );
            assert!(relation_records.iter().any(|relation| {
                relation.kind == "jsts:relation_contains"
                    && relation.body.to_value()["source_id"] == interface_id
                    && relation.body.to_value()["target_id"] == record.identity_key
            }));
        }
    }

    #[test]
    fn definition_files_do_not_promote_oxc_ambient_semantics_to_authority() {
        let mut state = SyntaxWorkerState::default();
        let text = r#"/// <reference types="vite/client" />

declare module 'markdown-it-task-lists' {
    declare namespace markdownItTaskLists {
        interface Config { enabled?: boolean; }
    }
    declare const markdownItTaskLists: unknown;
    export = markdownItTaskLists;
}
"#;
        analyze(
            &mut state,
            vec![source("env.d.ts", text)],
            &["env.d.ts"],
            '1',
        );

        let WorkerMessage::FactsResult {
            parsed,
            diagnostics,
            ..
        } = read_page(
            &state,
            "env.d.ts",
            None,
            MAX_FACT_OUTPUT_BYTES,
            MAX_FACT_ROWS,
        )
        else {
            panic!("expected facts page")
        };
        assert!(parsed, "unexpected syntax diagnostics: {diagnostics:?}");
        assert!(diagnostics.is_empty());
    }

    #[test]
    fn content_changes_return_the_reverse_affected_closure() {
        let mut state = SyntaxWorkerState::default();
        let roots = ["a.ts", "b.ts", "c.ts", "unrelated.ts"];
        analyze(
            &mut state,
            vec![
                source("a.ts", "import { b } from './b'; export const a = b;"),
                source("b.ts", "import { c } from './c'; export const b = c;"),
                source("c.ts", "export const c = 1;"),
                source("unrelated.ts", "export const other = 1;"),
            ],
            &roots,
            '1',
        );
        let WorkerMessage::AnalysisResult {
            build,
            changed_files,
            affected_files,
            ..
        } = analyze_exact(
            &mut state,
            vec![
                source("a.ts", "import { b } from './b'; export const a = b;"),
                source("b.ts", "import { c } from './c'; export const b = c;"),
                source("c.ts", "export const c = 2;"),
                source("unrelated.ts", "export const other = 1;"),
            ],
            &roots,
            '1',
            &["artifact:c.ts"],
        )
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Incremental);
        assert_eq!(changed_files, vec!["c.ts"]);
        assert_eq!(affected_files, vec!["a.ts", "b.ts", "c.ts"]);
    }

    #[test]
    fn incremental_analysis_reads_only_changed_source_blobs() {
        let mut state = SyntaxWorkerState::default();
        let roots = ["a.ts", "b.ts"];
        let first_a = source("a.ts", "import { b } from './b'; export const a = b;");
        let first_b = source("b.ts", "export const b = 1;");
        analyze(&mut state, vec![first_a.clone(), first_b], &roots, '1');
        let missing_unchanged = SourceInput {
            source_blob_path: std::env::temp_dir()
                .join("urdira-intentionally-missing-unchanged-source")
                .to_string_lossy()
                .into_owned(),
            ..first_a
        };
        let changed = source("b.ts", "export const b = 2;");
        let expected_bytes = changed.byte_length as u64;
        let WorkerMessage::AnalysisResult { metrics, .. } = analyze_exact(
            &mut state,
            vec![missing_unchanged, changed],
            &roots,
            '1',
            &["artifact:b.ts"],
        ) else {
            panic!("expected result")
        };
        assert_eq!(metrics.bytes_read, expected_bytes);
        assert_eq!(metrics.bytes_copied, 0);
        assert_eq!(metrics.bytes_transferred, 0);
    }

    #[test]
    fn exact_change_set_is_authoritative_and_digest_comparison_only_validates_it() {
        let mut state = SyntaxWorkerState::default();
        let roots = ["a.ts", "b.ts"];
        analyze(
            &mut state,
            vec![
                source("a.ts", "export const a = 1;"),
                source("b.ts", "export const b = 1;"),
            ],
            &roots,
            '1',
        );

        let unchanged = source("a.ts", "export const a = 1;");
        let mut changed = source("b.ts", "export const b = 2;");
        changed.source_blob_path = std::env::temp_dir()
            .join("urdira-authoritative-change-missing-source")
            .to_string_lossy()
            .into_owned();

        let unsorted = try_analyze_with_change_set(
            &mut state,
            vec![unchanged.clone(), changed.clone()],
            &roots,
            '1',
            AuthoritativeChangeSet::Exact {
                changed_artifact_ids: vec!["artifact:b.ts".into(), "artifact:a.ts".into()],
            },
        )
        .unwrap_err();
        assert_eq!(unsorted.code, ErrorCode::ProtocolInvalid);
        assert!(unsorted.message.contains("UTF-8 sorted"));

        let omitted = try_analyze_with_change_set(
            &mut state,
            vec![unchanged.clone(), changed.clone()],
            &roots,
            '1',
            AuthoritativeChangeSet::Exact {
                changed_artifact_ids: Vec::new(),
            },
        )
        .unwrap_err();
        assert_eq!(omitted.code, ErrorCode::ProtocolInvalid);
        assert!(omitted.message.contains("do not match"));

        let selected = try_analyze_with_change_set(
            &mut state,
            vec![unchanged, changed],
            &roots,
            '1',
            AuthoritativeChangeSet::Exact {
                changed_artifact_ids: vec!["artifact:b.ts".into()],
            },
        )
        .unwrap_err();
        assert_eq!(selected.code, ErrorCode::AnalysisFailed);
        assert!(selected.message.contains("b.ts"));
    }

    #[test]
    fn exact_empty_first_scan_still_builds_every_current_source() {
        let mut state = SyntaxWorkerState::default();
        let WorkerMessage::AnalysisResult {
            build,
            reset_reason,
            changed_files,
            affected_files,
            ..
        } = analyze_exact(
            &mut state,
            vec![source("a.ts", "export const a = 1;")],
            &["a.ts"],
            '1',
            &[],
        )
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        assert_eq!(reset_reason, Some(ResetReason::Initial));
        assert_eq!(changed_files, vec!["a.ts"]);
        assert_eq!(affected_files, vec!["a.ts"]);
    }

    #[test]
    fn rejects_ambiguous_artifact_identity_in_the_complete_manifest() {
        let mut state = SyntaxWorkerState::default();
        let first = source("a.ts", "export const a = 1;");
        let second = SourceInput {
            artifact_id: first.artifact_id.clone(),
            ..source("b.ts", "export const b = 1;")
        };
        let error = try_analyze_with_change_set(
            &mut state,
            vec![first, second],
            &["a.ts", "b.ts"],
            '1',
            AuthoritativeChangeSet::Full,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ProtocolInvalid);
        assert!(error.message.contains("artifact ids"));
    }

    #[test]
    fn deleting_the_last_source_resets_to_an_empty_manifest() {
        let mut state = SyntaxWorkerState::default();
        analyze(
            &mut state,
            vec![source("a.ts", "export const a = 1;")],
            &["a.ts"],
            '1',
        );
        let WorkerMessage::AnalysisResult {
            build,
            reset_reason,
            changed_files,
            affected_files,
            ..
        } = analyze_exact(&mut state, Vec::new(), &[], '1', &["artifact:a.ts"])
        else {
            panic!("expected result")
        };
        // T1: deleting the last source is a pure path-membership change (no
        // retained path's content changed, no configuration change), so it
        // now takes the narrow incremental add/remove-root path instead of
        // the O(corpus) reset -- `reset_reason` still reports the root-set
        // transition, but `build` is `Incremental`. The resulting state
        // (empty manifest, empty changed/affected sets) is identical either
        // way.
        assert_eq!(build, BuildKind::Incremental);
        assert_eq!(reset_reason, Some(ResetReason::RootSetChanged));
        assert!(changed_files.is_empty());
        assert!(affected_files.is_empty());
        assert!(state.projects["project:one"].files.is_empty());
        assert!(state.projects["project:one"].source_metadata.is_empty());
    }

    // -------------------------------------------------------------------
    // T1 equivalence gate (docs/evidence/2026-09-02-file-creation-diagnosis.md):
    // the incremental add/remove-root path must produce the EXACT same
    // retained `SyntaxFileResult` state as a fresh full build of the same
    // target corpus, scale-independent -- the same property the Merkle
    // equivalence tests establish elsewhere. Each test below builds the
    // target corpus two ways (incrementally, from a smaller prior state;
    // and directly, as a single full build) and asserts the two runs'
    // retained project state is byte-for-byte identical.
    // -------------------------------------------------------------------

    #[test]
    fn incremental_root_add_matches_full_rebuild_for_a_new_file_without_importers() {
        let mut incremental_state = SyntaxWorkerState::default();
        analyze(
            &mut incremental_state,
            vec![
                source("a.ts", "export const a = 1;"),
                source("b.ts", "export const b = 2;"),
            ],
            &["a.ts", "b.ts"],
            '1',
        );
        let WorkerMessage::AnalysisResult { build, .. } = analyze_exact(
            &mut incremental_state,
            vec![
                source("a.ts", "export const a = 1;"),
                source("b.ts", "export const b = 2;"),
                source("c.ts", "export const c = 3;"),
            ],
            &["a.ts", "b.ts", "c.ts"],
            '1',
            &["artifact:c.ts"],
        ) else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Incremental);

        let mut full_state = SyntaxWorkerState::default();
        analyze(
            &mut full_state,
            vec![
                source("a.ts", "export const a = 1;"),
                source("b.ts", "export const b = 2;"),
                source("c.ts", "export const c = 3;"),
            ],
            &["a.ts", "b.ts", "c.ts"],
            '1',
        );

        assert_eq!(
            incremental_state.projects["project:one"].files,
            full_state.projects["project:one"].files
        );
    }

    #[test]
    fn incremental_root_add_matches_full_rebuild_when_the_new_file_satisfies_a_previously_unresolved_import()
     {
        let mut incremental_state = SyntaxWorkerState::default();
        analyze(
            &mut incremental_state,
            vec![source(
                "a.ts",
                "import { b } from './b'; export const a = 1;",
            )],
            &["a.ts"],
            '1',
        );
        let unresolved = &incremental_state.projects["project:one"].files["a.ts"].direct_imports[0];
        assert_eq!(unresolved.target_path, None);

        let WorkerMessage::AnalysisResult {
            build,
            affected_files,
            ..
        } = analyze_exact(
            &mut incremental_state,
            vec![
                source("a.ts", "import { b } from './b'; export const a = 1;"),
                source("b.ts", "export const b = 2;"),
            ],
            &["a.ts", "b.ts"],
            '1',
            &["artifact:b.ts"],
        )
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Incremental);
        // `a.ts` is affected too: its own import target flipped from
        // unresolved to `b.ts`, even though `a.ts`'s byte content never
        // changed -- this is exactly the case the diagnosis doc calls out
        // as the delicate one.
        assert_eq!(affected_files, vec!["a.ts".to_owned(), "b.ts".to_owned()]);

        let mut full_state = SyntaxWorkerState::default();
        analyze(
            &mut full_state,
            vec![
                source("a.ts", "import { b } from './b'; export const a = 1;"),
                source("b.ts", "export const b = 2;"),
            ],
            &["a.ts", "b.ts"],
            '1',
        );

        assert_eq!(
            incremental_state.projects["project:one"].files,
            full_state.projects["project:one"].files
        );
        assert_eq!(
            incremental_state.projects["project:one"].files["a.ts"].direct_imports[0]
                .target_path
                .as_deref(),
            Some("b.ts")
        );
    }

    #[test]
    fn incremental_root_removal_matches_full_rebuild_when_deleting_an_imported_file() {
        let mut incremental_state = SyntaxWorkerState::default();
        analyze(
            &mut incremental_state,
            vec![
                source("a.ts", "import { b } from './b'; export const a = 1;"),
                source("b.ts", "export const b = 2;"),
            ],
            &["a.ts", "b.ts"],
            '1',
        );
        let WorkerMessage::AnalysisResult {
            build,
            affected_files,
            ..
        } = analyze_exact(
            &mut incremental_state,
            vec![source(
                "a.ts",
                "import { b } from './b'; export const a = 1;",
            )],
            &["a.ts"],
            '1',
            &["artifact:b.ts"],
        )
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Incremental);
        // `a.ts` is affected: its import target regresses to unresolved
        // now that `b.ts` is gone.
        assert_eq!(affected_files, vec!["a.ts".to_owned()]);

        let mut full_state = SyntaxWorkerState::default();
        analyze(
            &mut full_state,
            vec![source(
                "a.ts",
                "import { b } from './b'; export const a = 1;",
            )],
            &["a.ts"],
            '1',
        );

        assert_eq!(
            incremental_state.projects["project:one"].files,
            full_state.projects["project:one"].files
        );
        assert_eq!(
            incremental_state.projects["project:one"].files["a.ts"].direct_imports[0].target_path,
            None
        );
    }

    #[test]
    fn incremental_root_add_reresolves_a_higher_priority_extension_shadow() {
        // `./util` currently resolves to `util.ts` (the only match). Adding
        // `util.js` -- which `RESOLUTION_EXTENSIONS`'s fixed `.js`-before-
        // `.ts` priority order prefers -- must flip `a.ts`'s import target
        // even though `a.ts`'s own byte content is unchanged: this is the
        // shadowing half of "the new path set changes an unchanged file's
        // resolution", not just the previously-unresolved half.
        let mut incremental_state = SyntaxWorkerState::default();
        analyze(
            &mut incremental_state,
            vec![
                source("a.ts", "import { u } from './util'; export const a = 1;"),
                source("util.ts", "export const u = 1;"),
            ],
            &["a.ts", "util.ts"],
            '1',
        );
        assert_eq!(
            incremental_state.projects["project:one"].files["a.ts"].direct_imports[0]
                .target_path
                .as_deref(),
            Some("util.ts")
        );

        let WorkerMessage::AnalysisResult { build, .. } = analyze_exact(
            &mut incremental_state,
            vec![
                source("a.ts", "import { u } from './util'; export const a = 1;"),
                source("util.ts", "export const u = 1;"),
                source("util.js", "export const u = 1;"),
            ],
            &["a.ts", "util.ts", "util.js"],
            '1',
            &["artifact:util.js"],
        ) else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Incremental);

        let mut full_state = SyntaxWorkerState::default();
        analyze(
            &mut full_state,
            vec![
                source("a.ts", "import { u } from './util'; export const a = 1;"),
                source("util.ts", "export const u = 1;"),
                source("util.js", "export const u = 1;"),
            ],
            &["a.ts", "util.ts", "util.js"],
            '1',
        );

        assert_eq!(
            incremental_state.projects["project:one"].files,
            full_state.projects["project:one"].files
        );
        assert_eq!(
            incremental_state.projects["project:one"].files["a.ts"].direct_imports[0]
                .target_path
                .as_deref(),
            Some("util.js")
        );
    }

    #[test]
    fn incremental_rename_via_delete_plus_create_repoints_importers_that_used_the_new_name() {
        // A rename is a delete + a create in the SAME batch: `old.ts` goes
        // away, `new.ts` appears. Two separate importers -- one that named
        // the OLD path (must regress to unresolved) and one that already
        // named the NEW path (was unresolved, must now resolve) -- so this
        // test cannot pass by accident of only exercising one direction.
        let mut incremental_state = SyntaxWorkerState::default();
        analyze(
            &mut incremental_state,
            vec![
                source(
                    "importer_of_old.ts",
                    "import { v } from './old'; export const a = 1;",
                ),
                source(
                    "importer_of_new.ts",
                    "import { v } from './new'; export const b = 1;",
                ),
                source("old.ts", "export const v = 1;"),
            ],
            &["importer_of_old.ts", "importer_of_new.ts", "old.ts"],
            '1',
        );
        assert_eq!(
            incremental_state.projects["project:one"].files["importer_of_old.ts"].direct_imports[0]
                .target_path
                .as_deref(),
            Some("old.ts")
        );
        assert_eq!(
            incremental_state.projects["project:one"].files["importer_of_new.ts"].direct_imports[0]
                .target_path,
            None
        );

        let WorkerMessage::AnalysisResult { build, .. } = analyze_exact(
            &mut incremental_state,
            vec![
                source(
                    "importer_of_old.ts",
                    "import { v } from './old'; export const a = 1;",
                ),
                source(
                    "importer_of_new.ts",
                    "import { v } from './new'; export const b = 1;",
                ),
                source("new.ts", "export const v = 1;"),
            ],
            &["importer_of_old.ts", "importer_of_new.ts", "new.ts"],
            '1',
            &["artifact:new.ts", "artifact:old.ts"],
        ) else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Incremental);

        let mut full_state = SyntaxWorkerState::default();
        analyze(
            &mut full_state,
            vec![
                source(
                    "importer_of_old.ts",
                    "import { v } from './old'; export const a = 1;",
                ),
                source(
                    "importer_of_new.ts",
                    "import { v } from './new'; export const b = 1;",
                ),
                source("new.ts", "export const v = 1;"),
            ],
            &["importer_of_old.ts", "importer_of_new.ts", "new.ts"],
            '1',
        );

        assert_eq!(
            incremental_state.projects["project:one"].files,
            full_state.projects["project:one"].files
        );
        assert_eq!(
            incremental_state.projects["project:one"].files["importer_of_old.ts"].direct_imports[0]
                .target_path,
            None
        );
        assert_eq!(
            incremental_state.projects["project:one"].files["importer_of_new.ts"].direct_imports[0]
                .target_path
                .as_deref(),
            Some("new.ts")
        );
    }

    #[test]
    fn incremental_root_add_resolves_a_directory_import_via_index_ts() {
        // `./dir` can only ever resolve through `probe_extensions`'s
        // `/index`+extension branch -- a distinct code path from a bare
        // `./name` + extension match, and the one P3-6 item 2's candidate
        // index must also cover (`push_candidate_variants` emits `{base}/
        // index{ext}` entries, not just `{base}{ext}`).
        let mut incremental_state = SyntaxWorkerState::default();
        analyze(
            &mut incremental_state,
            vec![source(
                "importer.ts",
                "import { v } from './dir'; export const a = 1;",
            )],
            &["importer.ts"],
            '1',
        );
        assert_eq!(
            incremental_state.projects["project:one"].files["importer.ts"].direct_imports[0]
                .target_path,
            None
        );

        let WorkerMessage::AnalysisResult { build, .. } = analyze_exact(
            &mut incremental_state,
            vec![
                source(
                    "importer.ts",
                    "import { v } from './dir'; export const a = 1;",
                ),
                source("dir/index.ts", "export const v = 1;"),
            ],
            &["importer.ts", "dir/index.ts"],
            '1',
            &["artifact:dir/index.ts"],
        ) else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Incremental);

        let mut full_state = SyntaxWorkerState::default();
        analyze(
            &mut full_state,
            vec![
                source(
                    "importer.ts",
                    "import { v } from './dir'; export const a = 1;",
                ),
                source("dir/index.ts", "export const v = 1;"),
            ],
            &["importer.ts", "dir/index.ts"],
            '1',
        );

        assert_eq!(
            incremental_state.projects["project:one"].files,
            full_state.projects["project:one"].files
        );
        assert_eq!(
            incremental_state.projects["project:one"].files["importer.ts"].direct_imports[0]
                .target_path
                .as_deref(),
            Some("dir/index.ts")
        );
    }

    /// A small, dependency-free xorshift64* PRNG -- deterministic across
    /// runs/platforms (unlike relying on a system RNG or adding a `rand`
    /// dependency just for one test) so a failure here is exactly
    /// reproducible from the fixed seed below.
    struct XorShift64(u64);
    impl XorShift64 {
        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn next_range(&mut self, bound: usize) -> usize {
            (self.next_u64() % bound as u64) as usize
        }
    }

    #[test]
    fn narrowed_create_delete_matches_full_reresolution_on_a_synthetic_300_file_project() {
        // P3-6 item 2's own correctness gate: the narrowed (bounded
        // candidate-index) re-resolution sweep must be byte-for-byte
        // IDENTICAL to a from-scratch full re-resolution, for every step of
        // a long randomized create/delete sequence over a synthetic corpus
        // shaped to exercise every case the index has to get right at
        // once -- fan-in (many importers naming the same target base),
        // extension-priority shadowing (`.js` beats `.ts` in
        // `RESOLUTION_EXTENSIONS`, so both variants of the same base
        // toggle independently), and directory-index resolution. 30 target
        // bases x 2 extension variants (60 possible target files) + 240
        // fan-in importers = up to 300 distinct paths, matching the task's
        // own "synthetic 300-file project" scale.
        const TARGET_BASES: usize = 30;
        const IMPORTERS: usize = 240;
        const STEPS: usize = 30;

        // This corpus (up to 300 files) exceeds `analyze`/`analyze_exact`'s
        // shared `max_files: 100` test budget, so this test drives
        // `SyntaxWorkerState::analyze` directly with a larger one.
        fn run(
            state: &mut SyntaxWorkerState,
            sources: Vec<SourceInput>,
            roots: &[&str],
            change_set: AuthoritativeChangeSet,
        ) -> WorkerMessage {
            state
                .analyze(
                    "request:one".into(),
                    "cancel:one".into(),
                    "project:one".into(),
                    format!("sha256:{}", "1".repeat(64)),
                    roots.iter().map(|root| (*root).into()).collect(),
                    sources,
                    Vec::new(),
                    change_set,
                    AnalysisBudgets {
                        max_output_bytes: 10_000_000,
                        max_files: 1000,
                        max_source_bytes: 10_000_000,
                        enforce_output_bytes: true,
                    },
                    &AtomicBool::new(false),
                )
                .unwrap()
        }

        let mut rng = XorShift64(0x9E3779B97F4A7C15);
        // `present[k] = (ts_present, js_present)` for target base `k`.
        let mut present: Vec<(bool, bool)> = (0..TARGET_BASES)
            .map(|_| (rng.next_range(2) == 1, rng.next_range(2) == 1))
            .collect();

        let importer_source = |i: usize| -> SourceInput {
            let base = i % TARGET_BASES;
            source(
                &format!("importer_{i}.ts"),
                &format!("import {{ v }} from './target_{base}'; export const imp{i} = 1;"),
            )
        };
        let target_source = |k: usize, ext: &str| -> SourceInput {
            source(
                &format!("target_{k}{ext}"),
                &format!("export const v = {k};"),
            )
        };

        let build_sources_and_roots =
            |present: &[(bool, bool)]| -> (Vec<SourceInput>, Vec<String>) {
                let mut sources: Vec<SourceInput> = (0..IMPORTERS).map(importer_source).collect();
                for (k, &(has_ts, has_js)) in present.iter().enumerate() {
                    if has_ts {
                        sources.push(target_source(k, ".ts"));
                    }
                    if has_js {
                        sources.push(target_source(k, ".js"));
                    }
                }
                let roots = sources.iter().map(|s| s.path.clone()).collect();
                (sources, roots)
            };

        let mut incremental_state = SyntaxWorkerState::default();
        {
            let (sources, roots) = build_sources_and_roots(&present);
            let root_refs: Vec<&str> = roots.iter().map(String::as_str).collect();
            run(
                &mut incremental_state,
                sources,
                &root_refs,
                AuthoritativeChangeSet::Full,
            );
        }

        for step in 0..STEPS {
            let base = rng.next_range(TARGET_BASES);
            let want_js = rng.next_range(2) == 1;
            let (ts, js) = &mut present[base];
            let (ext, was_present) = if want_js { (".js", *js) } else { (".ts", *ts) };
            let changed_artifact = format!("artifact:target_{base}{ext}");
            if want_js {
                *js = !was_present;
            } else {
                *ts = !was_present;
            }

            let (sources, roots) = build_sources_and_roots(&present);
            let root_refs: Vec<&str> = roots.iter().map(String::as_str).collect();
            let WorkerMessage::AnalysisResult { build, .. } = run(
                &mut incremental_state,
                sources,
                &root_refs,
                AuthoritativeChangeSet::Exact {
                    changed_artifact_ids: vec![changed_artifact.clone()],
                },
            ) else {
                panic!("expected result at step {step}");
            };
            assert_eq!(
                build,
                BuildKind::Incremental,
                "step {step} unexpectedly took the full-reset path"
            );

            let mut full_state = SyntaxWorkerState::default();
            let (full_sources, full_roots) = build_sources_and_roots(&present);
            let full_root_refs: Vec<&str> = full_roots.iter().map(String::as_str).collect();
            run(
                &mut full_state,
                full_sources,
                &full_root_refs,
                AuthoritativeChangeSet::Full,
            );

            assert_eq!(
                incremental_state.projects["project:one"].files,
                full_state.projects["project:one"].files,
                "narrowed re-resolution diverged from a full rebuild at step {step} \
                 (toggled target_{base}{ext})"
            );
        }
    }

    #[test]
    fn unresolved_relative_imports_do_not_expand_stable_content_edits() {
        let mut state = SyntaxWorkerState::default();
        let roots = ["broken.ts", "changed.ts", "unrelated.ts"];
        analyze(
            &mut state,
            vec![
                source("broken.ts", "import { missing } from './missing';"),
                source("changed.ts", "export const changed = 1;"),
                source("unrelated.ts", "export const unrelated = 1;"),
            ],
            &roots,
            '1',
        );
        let WorkerMessage::AnalysisResult { affected_files, .. } = analyze_exact(
            &mut state,
            vec![
                source("broken.ts", "import { missing } from './missing';"),
                source("changed.ts", "export const changed = 2;"),
                source("unrelated.ts", "export const unrelated = 1;"),
            ],
            &roots,
            '1',
            &["artifact:changed.ts"],
        ) else {
            panic!("expected result")
        };
        assert_eq!(affected_files, vec!["changed.ts"]);
    }

    #[test]
    fn root_config_and_file_set_changes_reset_conservatively() {
        let mut state = SyntaxWorkerState::default();
        analyze(
            &mut state,
            vec![source("a.ts", "export const a = 1;")],
            &["a.ts"],
            '1',
        );
        let WorkerMessage::AnalysisResult {
            reset_reason,
            build,
            ..
        } = analyze_exact(
            &mut state,
            vec![source("a.ts", "export const a = 1;")],
            &["a.ts"],
            '2',
            &[],
        )
        else {
            panic!("expected result")
        };
        assert_eq!(
            (build, reset_reason),
            (BuildKind::Full, Some(ResetReason::ConfigurationChanged))
        );
        let WorkerMessage::AnalysisResult { reset_reason, .. } = analyze_exact(
            &mut state,
            vec![
                source("a.ts", "export const a = 1;"),
                source("b.ts", "export const b = 1;"),
            ],
            &["a.ts", "b.ts"],
            '2',
            &["artifact:b.ts"],
        ) else {
            panic!("expected result")
        };
        assert_eq!(reset_reason, Some(ResetReason::RootSetChanged));
    }

    #[test]
    fn rejects_content_that_does_not_match_the_explicit_digest() {
        let mut state = SyntaxWorkerState::default();
        let mut invalid = source("a.ts", "export const a = 1;");
        invalid.content_digest = format!("sha256:{}", "0".repeat(64));
        let error = state
            .analyze(
                "request:one".into(),
                "cancel:one".into(),
                "project:one".into(),
                format!("sha256:{}", "1".repeat(64)),
                vec!["a.ts".into()],
                vec![invalid],
                Vec::new(),
                AuthoritativeChangeSet::Full,
                AnalysisBudgets {
                    max_output_bytes: 1000,
                    max_files: 1,
                    max_source_bytes: 1000,
                    enforce_output_bytes: true,
                },
                &AtomicBool::new(false),
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::SourceDigestMismatch);
    }

    #[test]
    fn enforced_output_bytes_bails_and_restores_prior_state_on_overflow() {
        // (a) Plan 3.1: with `enforce_output_bytes: true` (the guarded
        // path every IPC caller keeps), an unreasonably small
        // `max_output_bytes` must still trip `ResourceExhausted` and leave
        // the project's PRIOR `analysis_token`/`pending_analysis` in place
        // -- exactly as it did before this field existed.
        let mut state = SyntaxWorkerState::default();
        let baseline = analyze(
            &mut state,
            vec![source("a.ts", "export const a = 1;")],
            &["a.ts"],
            '1',
        );
        let WorkerMessage::AnalysisResult {
            analysis_token: baseline_token,
            ..
        } = baseline
        else {
            panic!("expected analysis result");
        };
        let error = state
            .analyze(
                "request:two".into(),
                "cancel:two".into(),
                "project:one".into(),
                format!("sha256:{}", "1".repeat(64)),
                vec!["a.ts".into()],
                vec![source("a.ts", "export const a = 2;")],
                Vec::new(),
                AuthoritativeChangeSet::Full,
                AnalysisBudgets {
                    max_output_bytes: 1,
                    max_files: 1,
                    max_source_bytes: 1000,
                    enforce_output_bytes: true,
                },
                &AtomicBool::new(false),
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceExhausted);
        let restored = state
            .projects
            .get("project:one")
            .expect("project state kept after bail");
        assert_eq!(
            restored.analysis_token, baseline_token,
            "a bail must restore the pre-call analysis_token, not adopt the failed call's"
        );
        assert_eq!(
            restored
                .pending_analysis
                .as_ref()
                .map(|pending| pending.analysis_token.clone()),
            Some(baseline_token),
            "a bail must restore the pre-call pending_analysis, not adopt the failed call's"
        );
    }

    #[test]
    fn disabled_output_bytes_enforcement_skips_the_size_guard() {
        // (b) Same oversized-relative-to-budget response, but with
        // `enforce_output_bytes: false` (the in-process v3/v4 caller
        // setting): the serialize-and-measure pass is skipped entirely, so
        // the same `max_output_bytes: 1` that fails case (a) must now
        // succeed.
        let mut state = SyntaxWorkerState::default();
        let result = state
            .analyze(
                "request:one".into(),
                "cancel:one".into(),
                "project:one".into(),
                format!("sha256:{}", "1".repeat(64)),
                vec!["a.ts".into()],
                vec![source("a.ts", "export const a = 1;")],
                Vec::new(),
                AuthoritativeChangeSet::Full,
                AnalysisBudgets {
                    max_output_bytes: 1,
                    max_files: 1,
                    max_source_bytes: 1000,
                    enforce_output_bytes: false,
                },
                &AtomicBool::new(false),
            )
            .expect("enforce_output_bytes: false must skip the max_output_bytes guard");
        assert!(matches!(result, WorkerMessage::AnalysisResult { .. }));
    }

    #[test]
    fn budgets_without_the_enforce_field_default_to_enforcing() {
        // (c) A `budgets` JSON object built before this field existed (the
        // shape every pre-existing envelope/test fixture still sends) must
        // deserialize with `enforce_output_bytes == true` -- a bare
        // `#[serde(default)]` would silently resolve to `false` instead and
        // disable the guard for every such caller.
        let budgets: AnalysisBudgets = serde_json::from_value(serde_json::json!({
            "max_output_bytes": 1024,
            "max_files": 16,
            "max_source_bytes": 1024
        }))
        .expect("budgets without enforce_output_bytes must still deserialize");
        assert!(budgets.enforce_output_bytes);
    }

    #[test]
    fn groups_owner_fact_pages_under_one_bounded_response() {
        let mut state = SyntaxWorkerState::default();
        analyze(
            &mut state,
            vec![
                source("a.ts", "export const a = 1;"),
                source("b.ts", "import { a } from './a'; export const b = a;"),
                source("c.ts", "export function c() { return 3; }"),
            ],
            &["a.ts", "b.ts", "c.ts"],
            '1',
        );
        let WorkerMessage::FactsGroupResult {
            pages,
            next_request_index,
            ..
        } = state
            .read_facts_group(
                "request:group".into(),
                "cancel:group".into(),
                "project:one".into(),
                ["a.ts", "b.ts", "c.ts"]
                    .into_iter()
                    .map(|path| FactsGroupEntry {
                        path: path.into(),
                        cursor: None,
                    })
                    .collect(),
                MAX_FACT_GROUP_OUTPUT_BYTES,
                MAX_FACT_ROWS,
            )
            .expect("group facts")
        else {
            panic!("expected fact group")
        };
        assert_eq!(pages.len(), 3);
        assert_eq!(next_request_index, None);
        let paths = pages
            .iter()
            .map(|page| match page {
                WorkerMessage::FactsResult { path, .. } => path.as_str(),
                _ => panic!("expected fact page"),
            })
            .collect::<Vec<_>>();
        assert_eq!(paths, vec!["a.ts", "b.ts", "c.ts"]);
    }

    #[test]
    fn pages_a_single_file_larger_than_four_mib_without_cursor_gaps_or_duplicates() {
        let mut state = SyntaxWorkerState::default();
        let text = (0..12_000)
            .map(|index| format!("export const value_{index} = {index};\n"))
            .collect::<String>();
        analyze(
            &mut state,
            vec![source("large.ts", &text)],
            &["large.ts"],
            '1',
        );

        let project = state.projects.get("project:one").unwrap();
        let file = project.files.get("large.ts").unwrap();
        let all_rows = remaining_fact_rows(project, file, FactsCursor::default());
        let (unpaged_size, _) = serialized_response_length(
            build_facts_page(
                "request:unpaged",
                "cancel:unpaged",
                "project:one",
                project,
                file,
                FactsCursor::default(),
                all_rows,
            )
            .unwrap(),
        )
        .unwrap();
        assert!(unpaged_size > MAX_FACT_OUTPUT_BYTES as usize);

        let mut cursor = None;
        let mut prior = FactsCursor::default();
        let mut pages = 0usize;
        let mut rows = 0usize;
        let mut record_keys = BTreeSet::new();
        let mut dependency_ids = BTreeSet::new();
        loop {
            let page = read_page(
                &state,
                "large.ts",
                cursor,
                MAX_FACT_OUTPUT_BYTES,
                MAX_FACT_ROWS,
            );
            let encoded = serde_json::to_vec(&page).unwrap();
            assert!(encoded.len() <= MAX_FACT_OUTPUT_BYTES as usize);
            let WorkerMessage::FactsResult {
                direct_imports,
                records,
                dependencies,
                next_cursor,
                ..
            } = page
            else {
                panic!("expected facts page")
            };
            let page_rows = direct_imports.len() + records.len() + dependencies.len();
            assert!(page_rows <= MAX_FACT_ROWS as usize);
            for record in records {
                assert!(record_keys.insert(record.proposal_record_key));
            }
            for dependency in dependencies {
                assert!(dependency_ids.insert(dependency.proposed_dependency_id));
            }
            rows += page_rows;
            pages += 1;
            match next_cursor {
                Some(next) => {
                    assert!(
                        next.imports_offset > prior.imports_offset
                            || next.records_offset > prior.records_offset
                            || next.dependencies_offset > prior.dependencies_offset
                    );
                    prior = next;
                    cursor = Some(next);
                }
                None => break,
            }
        }
        assert!(pages > 1);
        assert_eq!(rows, all_rows);
        assert_eq!(
            record_keys.len(),
            file.entities.len() + file.relations.len()
        );
        assert_eq!(dependency_ids.len(), 0);
    }

    #[test]
    fn enforces_the_4096_row_page_boundary() {
        let mut state = SyntaxWorkerState::default();
        let text = (0..2_100)
            .map(|index| format!("export const boundary_{index} = {index};\n"))
            .collect::<String>();
        analyze(
            &mut state,
            vec![source("boundary.ts", &text)],
            &["boundary.ts"],
            '1',
        );
        let WorkerMessage::FactsResult {
            direct_imports,
            records,
            dependencies,
            next_cursor,
            ..
        } = read_page(
            &state,
            "boundary.ts",
            None,
            MAX_FACT_OUTPUT_BYTES,
            MAX_FACT_ROWS,
        )
        else {
            panic!("expected facts page")
        };
        assert_eq!(
            direct_imports.len() + records.len() + dependencies.len(),
            MAX_FACT_ROWS as usize
        );
        assert!(next_cursor.is_some());
    }

    #[test]
    fn a_single_row_that_cannot_fit_fails_closed() {
        let mut state = SyntaxWorkerState::default();
        analyze(
            &mut state,
            vec![source("small.ts", "export const value = 1;")],
            &["small.ts"],
            '1',
        );
        let project = state.projects.get("project:one").unwrap();
        let file = project.files.get("small.ts").unwrap();
        let (metadata_size, _) = serialized_response_length(
            build_facts_page(
                "request:facts:small.ts",
                "cancel:facts:small.ts",
                "project:one",
                project,
                file,
                FactsCursor::default(),
                0,
            )
            .unwrap(),
        )
        .unwrap();
        let (one_row_size, _) = serialized_response_length(
            build_facts_page(
                "request:facts:small.ts",
                "cancel:facts:small.ts",
                "project:one",
                project,
                file,
                FactsCursor::default(),
                1,
            )
            .unwrap(),
        )
        .unwrap();
        assert!(one_row_size > metadata_size);
        let error = state
            .read_facts(
                "request:facts:small.ts".into(),
                "cancel:facts:small.ts".into(),
                "project:one".into(),
                "small.ts".into(),
                None,
                u32::try_from(one_row_size - 1).unwrap(),
                1,
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ResourceExhausted);
    }

    #[test]
    fn unchanged_analysis_replays_pending_paths_and_token_until_commit() {
        let mut state = SyntaxWorkerState::default();
        let roots = ["a.ts", "b.ts"];
        let first_sources = vec![
            source("a.ts", "export { b } from './b';"),
            source("b.ts", "export const b = 1;"),
        ];
        let WorkerMessage::AnalysisResult {
            analysis_token,
            affected_files,
            ..
        } = analyze(&mut state, first_sources, &roots, '1')
        else {
            panic!("expected analysis result")
        };
        assert_eq!(affected_files, vec!["a.ts", "b.ts"]);

        let mut replay_sources = vec![
            source("a.ts", "export { b } from './b';"),
            source("b.ts", "export const b = 1;"),
        ];
        replay_sources[1].artifact_version_id = "artifact-version:refreshed".into();
        let WorkerMessage::AnalysisResult {
            analysis_token: replay_token,
            build,
            changed_files,
            affected_files: replayed,
            ..
        } = analyze(&mut state, replay_sources.clone(), &roots, '1')
        else {
            panic!("expected replay result")
        };
        assert_eq!(build, BuildKind::Unchanged);
        assert!(changed_files.is_empty());
        assert_eq!(replay_token, analysis_token);
        assert_eq!(replayed, affected_files);

        let WorkerMessage::FactsResult { dependencies, .. } =
            read_page(&state, "a.ts", None, MAX_FACT_OUTPUT_BYTES, MAX_FACT_ROWS)
        else {
            panic!("expected facts page")
        };
        assert_eq!(dependencies.len(), 1);
        assert_eq!(
            dependencies[0].dependency_artifact_version_id,
            "artifact-version:refreshed"
        );

        let WorkerMessage::CommitAnalysisAck {
            analysis_token: committed,
            ..
        } = state
            .commit_analysis(
                "request:commit".into(),
                "project:one".into(),
                analysis_token.clone(),
            )
            .unwrap()
        else {
            panic!("expected commit acknowledgement")
        };
        assert_eq!(committed, analysis_token);

        let WorkerMessage::AnalysisResult {
            analysis_token: after_commit_token,
            build,
            affected_files,
            ..
        } = analyze_exact(&mut state, replay_sources, &roots, '1', &[])
        else {
            panic!("expected unchanged result")
        };
        assert_eq!(build, BuildKind::Unchanged);
        assert_eq!(after_commit_token, analysis_token);
        assert!(affected_files.is_empty());
    }

    #[test]
    fn exact_incremental_retry_reuses_the_pending_analysis_without_digest_reinference() {
        let mut state = SyntaxWorkerState::default();
        let roots = ["a.ts", "b.ts"];
        let initial = analyze(
            &mut state,
            vec![
                source("a.ts", "export { b } from './b';"),
                source("b.ts", "export const b = 1;"),
            ],
            &roots,
            '1',
        );
        let WorkerMessage::AnalysisResult { analysis_token, .. } = initial else {
            panic!("expected initial analysis")
        };
        state
            .commit_analysis(
                "request:initial-commit".into(),
                "project:one".into(),
                analysis_token,
            )
            .unwrap();

        let changed_sources = vec![
            source("a.ts", "export { b } from './b';"),
            source("b.ts", "export const b = 2;"),
        ];
        let WorkerMessage::AnalysisResult {
            analysis_token,
            affected_files,
            ..
        } = analyze_exact(
            &mut state,
            changed_sources.clone(),
            &roots,
            '1',
            &["artifact:b.ts"],
        )
        else {
            panic!("expected incremental analysis")
        };
        let WorkerMessage::AnalysisResult {
            analysis_token: replayed_token,
            build,
            changed_files,
            affected_files: replayed_affected,
            ..
        } = analyze_exact(&mut state, changed_sources, &roots, '1', &["artifact:b.ts"])
        else {
            panic!("expected replayed analysis")
        };
        assert_eq!(build, BuildKind::Unchanged);
        assert!(changed_files.is_empty());
        assert_eq!(replayed_token, analysis_token);
        assert_eq!(replayed_affected, affected_files);
    }

    fn collect(path: &str, source_text: &str) -> SyntaxCollector {
        let source_type = SourceType::from_path(std::path::Path::new(path)).expect("source type");
        let allocator = Allocator::default();
        let mut parsed = Parser::new(&allocator, source_text, source_type).parse();
        Utf8ToUtf16::new(source_text).convert_program(&mut parsed.program);
        let mut collector = SyntaxCollector::new(path, source_text.encode_utf16().count() as u32);
        collector.visit_program(&parsed.program);
        collector
    }

    // n8n-parity follow-up (2026-09-05): `export namespace X {}` must push
    // a direct export binding, not just an entity -- root cause of 505
    // n8n sites staying `import_binding/export:unresolved` (kind
    // `namespace`) even after 3b's own entity landed.

    #[test]
    fn export_namespace_declaration_pushes_a_direct_export_binding() {
        // The nested `export const x = 1;` ALSO reaches `visit_export_
        // named_declaration`'s own direct-declaration branch through the
        // default recursive walk (this crate has no scoping concept for
        // export bindings any more than it does for entities -- same
        // pre-existing, documented limitation `visit_ts_module_
        // declaration`'s own doc comment notes for entities), so it pushes
        // its OWN unrelated `{x, x}` binding too; only the `Cfg` binding
        // itself is this test's concern.
        let collector = collect("a.ts", "export namespace Cfg {\n  export const x = 1;\n}\n");
        let cfg_bindings: Vec<_> = collector
            .export_bindings
            .iter()
            .filter(|binding| binding.exported_name == "Cfg")
            .collect();
        assert_eq!(
            cfg_bindings.len(),
            1,
            "bindings: {:?}",
            collector.export_bindings
        );
        assert_eq!(cfg_bindings[0].local_name, "Cfg");
        assert_eq!(cfg_bindings[0].source_specifier, None);
    }

    #[test]
    fn export_class_namespace_merge_pushes_one_deduplicated_export_binding_for_each_declaration() {
        // Both `export class Foo {}` and `export namespace Foo { ... }`
        // push a BYTE-IDENTICAL `SyntaxExportBinding { exported_name:
        // "Foo", local_name: "Foo", .. }` -- `parse_source`'s own post-
        // collection `sort()`/`dedup()` collapses them to one, exactly
        // like two overloaded `export function f` bindings already do
        // (this crate's own `collect()` test helper runs BEFORE that
        // dedup pass, so both raw entries are visible here). The nested
        // `export const y = 1;` pushes its own unrelated `{y, y}` binding,
        // same pre-existing scoping gap as the test right above.
        let collector = collect(
            "a.ts",
            "export class Foo {}\nexport namespace Foo {\n  export const y = 1;\n}\n",
        );
        let foo_bindings: Vec<_> = collector
            .export_bindings
            .iter()
            .filter(|binding| binding.exported_name == "Foo")
            .collect();
        assert_eq!(
            foo_bindings.len(),
            2,
            "bindings: {:?}",
            collector.export_bindings
        );
        assert!(
            foo_bindings
                .iter()
                .all(|binding| binding.local_name == "Foo" && binding.source_specifier.is_none()),
            "bindings: {:?}",
            foo_bindings
        );
    }

    /// Defensive: `declaration_export_names`'s `TSModuleDeclaration` arm
    /// only extracts a name for the `Identifier` form -- a STRING-LITERAL-
    /// named one wrapped in `export` (oxc parses this permissively at the
    /// syntax level even though it is not meaningful TypeScript -- an
    /// ambient module declaration is never itself `export`ed) still stays
    /// `Vec::new()`, so this documents the fallback is intentional, not an
    /// oversight.
    #[test]
    fn export_wrapped_ambient_string_literal_module_is_not_a_direct_export_name() {
        let collector = collect("a.ts", "export declare module \"specifier\" {}\n");
        assert!(
            collector.export_bindings.is_empty(),
            "bindings: {:?}",
            collector.export_bindings
        );
    }

    // P1-B: `export * as X from "spec"` lane-1 widening.

    #[test]
    fn export_all_as_synthesizes_a_namespace_binding() {
        let collector = collect("index.ts", "export * as evals from './evals/index';\n");
        assert_eq!(collector.export_bindings.len(), 1);
        let binding = &collector.export_bindings[0];
        assert_eq!(binding.exported_name, "evals");
        assert_eq!(binding.local_name, NAMESPACE_REEXPORT_LOCAL_NAME);
        assert_eq!(binding.source_specifier.as_deref(), Some("./evals/index"));
        // Filled in by `parse_source`'s own generic per-binding resolution
        // pass, not here.
        assert_eq!(binding.source_target_path, None);
    }

    #[test]
    fn plain_export_star_still_synthesizes_no_binding() {
        // E2's existing "export * is never captured as a named binding"
        // behavior (see `SyntaxFileResult::export_bindings`'s doc comment)
        // MUST stay unchanged for the nameless form -- it is captured
        // SEPARATELY, in `export_star_specifiers` (2026-09-04
        // references-parity task, bucket 2).
        let collector = collect("index.ts", "export * from './evals/index';\n");
        assert!(collector.export_bindings.is_empty());
        assert_eq!(collector.export_star_specifiers.len(), 1);
        assert_eq!(
            collector.export_star_specifiers[0].specifier,
            "./evals/index"
        );
        // Filled in by `parse_source`'s own generic per-specifier
        // resolution pass, not here.
        assert_eq!(collector.export_star_specifiers[0].target_path, None);
    }

    #[test]
    fn export_all_as_string_literal_name_synthesizes_a_namespace_binding() {
        // `export * as "eval s"` (a string-literal export name, legal ESM)
        // -- `module_export_name_text` already handles this shape.
        let collector = collect(
            "index.ts",
            "export * as \"eval-utils\" from './evals/index';\n",
        );
        assert_eq!(collector.export_bindings.len(), 1);
        assert_eq!(collector.export_bindings[0].exported_name, "eval-utils");
    }

    // h1 (2026-09-05): `export = <identifier>;` -- CommonJS's own default-
    // export idiom.

    #[test]
    fn export_assignment_of_an_identifier_pushes_a_default_export_binding() {
        let collector = collect("widget.ts", "declare function f(): void;\nexport = f;\n");
        assert_eq!(collector.export_bindings.len(), 1);
        let binding = &collector.export_bindings[0];
        assert_eq!(binding.exported_name, "default");
        assert_eq!(binding.local_name, "f");
        assert_eq!(binding.source_specifier, None);
        assert_eq!(binding.source_target_path, None);
    }

    #[test]
    fn export_assignment_inside_an_ambient_module_becomes_its_default_member() {
        let text = "declare module \"x\" {\n  function f(): void;\n  export = f;\n}\n";
        let collector = collect("plugins.d.ts", text);
        assert_eq!(collector.ambient_modules.len(), 1);
        let declaration = &collector.ambient_modules[0];
        let function_start = text.find("function f").unwrap() as u32 + "function ".len() as u32;
        let expected_id = format!("jsts:function:plugins.d.ts:{function_start}:f");
        let default_member = declaration
            .default_member
            .as_ref()
            .unwrap_or_else(|| panic!("expected a default_member: {declaration:?}"));
        assert_eq!(default_member.name, "f");
        assert_eq!(default_member.entity_id, expected_id);
        // The file-level visitor ALSO fires for this same nested node (the
        // default recursive walk reaches it either way) -- a SEPARATE,
        // path-based export binding, not a duplicate of the ambient
        // module's own `default_member` above.
        assert_eq!(collector.export_bindings.len(), 1);
        assert_eq!(collector.export_bindings[0].local_name, "f");
    }

    #[test]
    fn export_assignment_of_a_non_identifier_expression_is_ignored_and_counted() {
        let before = unsupported_export_assignment_shape_count();
        let collector = collect("widget.ts", "export = { a: 1 };\n");
        assert!(collector.export_bindings.is_empty());
        assert!(unsupported_export_assignment_shape_count() > before);
    }

    /// Plan's literal test scenario: an ambient module's `export = f;` plus
    /// an importer resolves the import through the ambient module's own
    /// namespace entity (never external) -- the per-name resolution to
    /// `f` itself goes through `resolver::AmbientModuleIndex::resolve_
    /// export`'s `"default"` arm (unchanged by this task, already reading
    /// `default_member`), exercised in `resolver.rs`'s own test suite; this
    /// integration test covers the declaration side this task actually
    /// changed.
    #[test]
    fn ambient_export_assignment_import_resolves_to_the_namespace_not_external() {
        let mut state = SyntaxWorkerState::default();
        let declaration_text = "declare module \"x\" {\n  function f(): void;\n  export = f;\n}\n";
        let files = vec![
            source("plugins.d.ts", declaration_text),
            source("a.ts", "import x from \"x\";\nx();\n"),
        ];
        let WorkerMessage::AnalysisResult { build, .. } =
            analyze(&mut state, files, &["plugins.d.ts", "a.ts"], '1')
        else {
            panic!("expected result")
        };
        assert_eq!(build, BuildKind::Full);
        let WorkerMessage::FactsResult { records, .. } =
            read_page(&state, "a.ts", None, 1_000_000, 4096)
        else {
            panic!("expected facts")
        };
        let quote_start = declaration_text.find('"').unwrap() as u32;
        let namespace_id = format!("jsts:namespace:plugins.d.ts:{quote_start}:x");
        let import_relation = records
            .iter()
            .find(|record| record.kind == "jsts:relation_import")
            .expect("expected an import relation record");
        assert_eq!(import_relation.body.to_value()["target_id"], namespace_id);
        assert_eq!(
            import_relation.body.to_value()["classification"],
            "confirmed"
        );
        assert!(
            !records
                .iter()
                .any(|record| record.identity_key.starts_with("jsts:external_module:")),
            "an ambiently-resolved specifier must never synthesize an external_module entity: {records:?}"
        );
    }

    // A5b (2026-09-05 references-parity task, bucket 1 --
    // `import_binding/export:unresolved`): a barrel doing `import { X } from
    // './x'; export { X };` (no `from` on the `export` itself) must be
    // recognized as a re-export of the IMPORTED `X`, not a same-file
    // declaration lookup -- see `SyntaxCollector::imported_locals`'s own doc
    // comment.

    #[test]
    fn sourceless_reexport_of_a_named_import_binds_through_the_import_specifier() {
        let collector = collect("index.ts", "import { A } from './a';\nexport { A };\n");
        assert_eq!(collector.export_bindings.len(), 1);
        let binding = &collector.export_bindings[0];
        assert_eq!(binding.exported_name, "A");
        assert_eq!(binding.local_name, "A");
        assert_eq!(binding.source_specifier.as_deref(), Some("./a"));
        // Filled in by `parse_source`'s own generic per-binding resolution
        // pass, not here.
        assert_eq!(binding.source_target_path, None);
    }

    #[test]
    fn sourceless_reexport_of_a_renamed_named_import_tracks_the_original_name() {
        // `import { B as C } from './b'` binds local `C` to `B` in './b';
        // `export { C as D }` must re-export `./b`'s own `B`, under the
        // NEW public name `D` -- never `C` (a local binding that does not
        // exist in `./b`) and never `B` as the exported name (the barrel's
        // own consumers see `D`).
        let collector = collect(
            "index.ts",
            "import { B as C } from './b';\nexport { C as D };\n",
        );
        assert_eq!(collector.export_bindings.len(), 1);
        let binding = &collector.export_bindings[0];
        assert_eq!(binding.exported_name, "D");
        assert_eq!(binding.local_name, "B");
        assert_eq!(binding.source_specifier.as_deref(), Some("./b"));
    }

    #[test]
    fn sourceless_reexport_of_a_type_only_named_import() {
        // `export type { T }` of a `type`-only import -- value/type-only
        // status is never distinguished by this mechanism (mirrors every
        // other `SyntaxExportBinding` producer here).
        let collector = collect(
            "index.ts",
            "import type { T } from './t';\nexport type { T };\n",
        );
        assert_eq!(collector.export_bindings.len(), 1);
        let binding = &collector.export_bindings[0];
        assert_eq!(binding.exported_name, "T");
        assert_eq!(binding.local_name, "T");
        assert_eq!(binding.source_specifier.as_deref(), Some("./t"));
    }

    #[test]
    fn sourceless_reexport_of_a_namespace_import_synthesizes_a_namespace_binding() {
        // `import * as ns from './n'; export { ns };` re-exports the WHOLE
        // namespace under `ns` -- same `NAMESPACE_REEXPORT_LOCAL_NAME`
        // sentinel shape `export * as X from "spec"` already uses (see that
        // constant's own doc comment), reached through the sourceless form
        // this time.
        let collector = collect("index.ts", "import * as ns from './n';\nexport { ns };\n");
        assert_eq!(collector.export_bindings.len(), 1);
        let binding = &collector.export_bindings[0];
        assert_eq!(binding.exported_name, "ns");
        assert_eq!(binding.local_name, NAMESPACE_REEXPORT_LOCAL_NAME);
        assert_eq!(binding.source_specifier.as_deref(), Some("./n"));
    }

    #[test]
    fn sourceless_reexport_of_a_default_import_binds_to_the_default_local_name() {
        // `import Def from './d'; export { Def };` -- `local_name:
        // "default"`, the SAME local name a with-source `export { default
        // as X } from "./d"` already gives this field (see `visit_export_
        // specifier`'s own doc comment for why this is deliberate, not a
        // coincidence).
        let collector = collect("index.ts", "import Def from './d';\nexport { Def };\n");
        assert_eq!(collector.export_bindings.len(), 1);
        let binding = &collector.export_bindings[0];
        assert_eq!(binding.exported_name, "Def");
        assert_eq!(binding.local_name, "default");
        assert_eq!(binding.source_specifier.as_deref(), Some("./d"));
    }

    #[test]
    fn sourceless_reexport_of_a_non_imported_local_is_unchanged() {
        // Negative case: `local` is NOT one of this file's own
        // `imported_locals` (here, a genuine same-file function
        // declaration) -- old behavior (a same-file declaration lookup,
        // `source_specifier: None`) must be completely unaffected.
        let collector = collect(
            "index.ts",
            "function locallyDeclared() {}\nexport { locallyDeclared };\n",
        );
        assert_eq!(collector.export_bindings.len(), 1);
        let binding = &collector.export_bindings[0];
        assert_eq!(binding.exported_name, "locallyDeclared");
        assert_eq!(binding.local_name, "locallyDeclared");
        assert_eq!(binding.source_specifier, None);
    }

    #[test]
    fn sourceless_reexport_of_a_name_with_neither_an_import_nor_a_declaration_stays_unresolved() {
        // Negative case, end to end: `local` is neither imported nor
        // declared anywhere in this file -- the binding shape is unchanged
        // (a same-file declaration lookup, exactly like the non-imported
        // case above), and `resolver::resolve_direct_export` must stay
        // `Unresolved` for it -- never guessed.
        let source_text = "export { neverDeclared };\n";
        let collector = collect("index.ts", source_text);
        assert_eq!(collector.export_bindings.len(), 1);
        let binding = &collector.export_bindings[0];
        assert_eq!(binding.exported_name, "neverDeclared");
        assert_eq!(binding.local_name, "neverDeclared");
        assert_eq!(binding.source_specifier, None);

        let mut files = BTreeMap::new();
        files.insert(
            "index.ts".to_owned(),
            SyntaxFileResult {
                path: "index.ts".to_owned(),
                content_digest: "sha256:0".to_owned(),
                language: Language::Typescript,
                script_kind: ScriptKind::Ts,
                byte_length: 0,
                parsed: true,
                direct_imports: Vec::new(),
                entities: collector.entities.clone(),
                relations: Vec::new(),
                diagnostics: Vec::new(),
                export_bindings: collector.export_bindings.clone(),
                export_star_specifiers: Vec::new(),
                ambient_modules: Vec::new(),
                ambient_globals: Vec::new(),
                namespace_members: Vec::new(),
                line_index: LineIndex::from_text(source_text),
            },
        );
        assert_eq!(
            resolver::resolve_named_export(
                &files,
                "index.ts",
                "neverDeclared",
                resolver::ExportPolicy::UniqueOrAmbiguous
            ),
            resolver::ExportResolution::Unresolved
        );
    }
}
