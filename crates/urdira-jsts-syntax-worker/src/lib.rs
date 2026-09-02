//! Persistent, content-keyed Oxc syntax analysis with no ambient source reads.

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingIdentifier, BindingPattern, CallExpression, Class, ClassType, Declaration,
    ExportAllDeclaration, ExportNamedDeclaration, ExportSpecifier, Expression, Function,
    FunctionType, ImportDeclaration, ImportExpression, ModuleExportName, TSEnumDeclaration,
    TSInterfaceDeclaration, TSTypeAliasDeclaration, VariableDeclaration,
};
use oxc_ast_visit::{
    Visit,
    utf8_to_utf16::Utf8ToUtf16,
    walk::{
        walk_call_expression, walk_class, walk_export_all_declaration,
        walk_export_named_declaration, walk_export_specifier, walk_function,
        walk_import_declaration, walk_import_expression, walk_ts_enum_declaration,
        walk_ts_interface_declaration, walk_ts_type_alias_declaration, walk_variable_declaration,
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

mod resolver;
mod semantic_sites;
pub use resolver::{ConfigAsset, WorkspaceResolver};
pub use semantic_sites::{
    HybridResolutionContext, OwnerSemantics, SemanticSite, SiteDisposition, SiteKind,
    analyze_owner_semantics, analyze_owner_semantics_with_context,
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

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnalysisBudgets {
    pub max_output_bytes: u32,
    pub max_files: u32,
    pub max_source_bytes: u32,
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProposedRecord {
    pub proposal_record_key: String,
    pub category: &'static str,
    pub kind: String,
    pub universal_kind: String,
    pub facets: String,
    pub schema_version: u8,
    pub source_span: String,
    pub identity_key: String,
    pub body: serde_json::Value,
    pub evidence_references: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProposedRecordDependency {
    pub proposed_dependency_id: String,
    pub proposal_record_key: String,
    pub dependency_artifact_id: String,
    pub dependency_artifact_version_id: String,
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
    /// `export { a } from "./x"`) is captured here -- `export default` and
    /// `export * from` are never captured (see `resolver.rs`'s module doc
    /// for why), so a lookup that only exists through one of those always
    /// misses here and stays `checker_pending` upstream, never wrongly
    /// resolved.
    pub export_bindings: Vec<SyntaxExportBinding>,
}

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

#[derive(Debug)]
pub struct SyntaxWorkerState {
    projects: HashMap<String, ProjectState>,
    next_analysis_sequence: u64,
}

impl Default for SyntaxWorkerState {
    fn default() -> Self {
        Self {
            projects: HashMap::new(),
            next_analysis_sequence: 1,
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
            Some(key) => usize::from(self.projects.remove(key).is_some()),
            None => {
                let count = self.projects.len();
                self.projects.clear();
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
        let prior = self.projects.get(&project_key).cloned();
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
        let mut next_files = if path_membership_incremental {
            let mut files = prior
                .as_ref()
                .map_or_else(BTreeMap::new, |state| state.files.clone());
            for path in &removed {
                files.remove(path);
            }
            files
        } else if reset_reason.is_some() {
            BTreeMap::new()
        } else {
            prior
                .as_ref()
                .map_or_else(BTreeMap::new, |state| state.files.clone())
        };
        let changed_sources = validated
            .iter()
            .filter(|source| changed.contains(&source.path))
            .collect::<Vec<_>>();
        if cancelled.load(Ordering::Acquire) {
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
                    return Ok(WorkerMessage::Cancelled {
                        request_id,
                        cancellation_id,
                    });
                }
                Err(error) => return Err(error),
            }
        }
        // T1: a path add/remove can change the resolved `target_path` of an
        // OTHER, byte-identical file's relative/bare import specifier --
        // both when a specifier that used to be unresolved now finds the
        // added path, and when a higher-resolution-priority path shadows
        // (add) or stops shadowing (remove) a specifier's previous target
        // (see `resolve_relative`/`probe_extensions`'s fixed extension
        // order). Re-resolving is cheap (no re-parse; a handful of
        // `BTreeSet` probes per existing import) so every retained file is
        // checked exactly, never guessed at from specifier text alone.
        let mut reresolved: BTreeSet<String> = BTreeSet::new();
        if path_membership_incremental {
            let stale_paths: Vec<String> = next_files
                .keys()
                .filter(|path| !changed.contains(path.as_str()))
                .cloned()
                .collect();
            for path in stale_paths {
                if cancelled.load(Ordering::Acquire) {
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
        let affected = if path_membership_incremental {
            let closure_changed: BTreeSet<String> =
                added.iter().chain(reresolved.iter()).cloned().collect();
            reverse_affected_closure(
                prior.as_ref().map(|state| &state.files),
                &next_files,
                &closure_changed,
            )
        } else if reset_reason.is_some() {
            paths
        } else {
            reverse_affected_closure(
                prior.as_ref().map(|state| &state.files),
                &next_files,
                &changed,
            )
        };
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
        let output_length = serde_json::to_vec(&response)
            .map_err(|_| AnalysisError {
                code: ErrorCode::AnalysisFailed,
                message: "analysis response serialization failed".into(),
            })?
            .len();
        if output_length > budgets.max_output_bytes as usize || output_length > MAX_MESSAGE_BYTES {
            return resource_error("analysis response exceeds max_output_bytes");
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
        records.extend(
            file.entities[start..entity_end]
                .iter()
                .map(|entity| proposal_entity_record(entity, file.language)),
        );
    }
    let relation_start = start.saturating_sub(file.entities.len());
    let relation_end = end.saturating_sub(file.entities.len());
    if relation_start < file.relations.len() && relation_start < relation_end {
        records.extend(
            file.relations[relation_start..relation_end.min(file.relations.len())]
                .iter()
                .map(proposal_relation_record),
        );
    }
    records
}

fn proposal_entity_record(entity: &SyntaxEntity, language: Language) -> ProposedRecord {
    let kind = match entity.universal_kind {
        UniversalKind::Type => "jsts:entity_type",
        UniversalKind::Callable => "jsts:entity_callable",
        UniversalKind::Container => "jsts:entity_container",
        UniversalKind::Value => "jsts:entity_variable",
    };
    let mut body = serde_json::Map::new();
    body.insert(
        "name".into(),
        serde_json::Value::String(entity.name.clone()),
    );
    body.insert(
        "kind".into(),
        serde_json::Value::String(entity_kind_name(entity.kind).into()),
    );
    body.insert(
        "language".into(),
        serde_json::Value::String(language_name(language).into()),
    );
    body.insert(
        "path".into(),
        serde_json::Value::String(entity.path.clone()),
    );
    body.insert("start".into(), serde_json::Value::from(entity.start));
    body.insert("end".into(), serde_json::Value::from(entity.end));
    if let Some(parent_id) = &entity.parent_id {
        body.insert(
            "parent_id".into(),
            serde_json::Value::String(parent_id.clone()),
        );
    }
    if let Some(qualified_name) = &entity.qualified_name {
        body.insert(
            "qualified_name".into(),
            serde_json::Value::String(qualified_name.clone()),
        );
    }
    if let Some(is_test) = entity.is_test {
        body.insert("is_test".into(), serde_json::Value::Bool(is_test));
    }
    let facets = if entity.parent_id.is_none() {
        serde_json::json!(["core:declaration", "core:definition"])
    } else {
        serde_json::json!(["core:declaration", "core:definition", "core:member"])
    };
    ProposedRecord {
        proposal_record_key: proposal_record_key(&entity.id),
        category: "entity",
        kind: kind.into(),
        universal_kind: universal_kind_name(entity.universal_kind).into(),
        facets: canonical_json(&facets),
        schema_version: 1,
        source_span: canonical_span(&entity.path, entity.start, entity.end),
        identity_key: entity.id.clone(),
        body: serde_json::Value::Object(body),
        evidence_references: canonical_evidence(&entity.path, entity.start, entity.end),
    }
}

fn proposal_relation_record(relation: &SyntaxRelation) -> ProposedRecord {
    let mut body = serde_json::Map::new();
    body.insert(
        "source_id".into(),
        serde_json::Value::String(relation.source_id.clone()),
    );
    if let Some(target_id) = &relation.target_id {
        body.insert(
            "target_id".into(),
            serde_json::Value::String(target_id.clone()),
        );
    }
    body.insert(
        "classification".into(),
        serde_json::Value::String(relation_classification_name(relation.classification).into()),
    );
    body.insert(
        "path".into(),
        serde_json::Value::String(relation.path.clone()),
    );
    body.insert("start".into(), serde_json::Value::from(relation.start));
    body.insert("end".into(), serde_json::Value::from(relation.end));
    let facets = if relation.kind == RelationKind::Contains {
        serde_json::json!(["core:structural_relation"])
    } else if relation.classification == RelationClassification::Possible {
        serde_json::json!(["core:reference_relation", "core:indirect"])
    } else {
        serde_json::json!(["core:reference_relation"])
    };
    ProposedRecord {
        proposal_record_key: proposal_record_key(&relation.id),
        category: "relation",
        kind: format!("jsts:relation_{}", relation.kind.identity_name()),
        universal_kind: relation_kind_name(relation.kind).into(),
        facets: canonical_json(&facets),
        schema_version: 1,
        source_span: canonical_span(&relation.path, relation.start, relation.end),
        identity_key: relation.id.clone(),
        body: serde_json::Value::Object(body),
        evidence_references: canonical_evidence(&relation.path, relation.start, relation.end),
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
        .map(|(relation, metadata)| {
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

fn resolved_dependencies<'a>(
    project: &'a ProjectState,
    file: &'a SyntaxFileResult,
) -> impl Iterator<Item = (&'a SyntaxRelation, &'a SourceMetadata)> + 'a {
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
        (target_path != file.path).then_some((relation, metadata))
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

const fn entity_kind_name(kind: EntityKind) -> &'static str {
    kind.identity_name()
}

const fn universal_kind_name(kind: UniversalKind) -> &'static str {
    match kind {
        UniversalKind::Container => "core:container",
        UniversalKind::Callable => "core:callable",
        UniversalKind::Type => "core:type",
        UniversalKind::Value => "core:value",
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
    for import in &mut collector.imports {
        import.target_path = resolver.resolve(&source.path, &import.specifier, available);
    }
    for binding in &mut collector.export_bindings {
        if let Some(specifier) = &binding.source_specifier {
            binding.source_target_path = resolver.resolve(&source.path, specifier, available);
        }
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
    })
}

struct SyntaxCollector {
    path: String,
    module_id: String,
    imports: Vec<DirectImport>,
    entities: Vec<SyntaxEntity>,
    relations: Vec<SyntaxRelation>,
    node_test_from: bool,
    export_bindings: Vec<SyntaxExportBinding>,
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
        }
    }

    /// Direct-declaration export names (E2): `export function/class/const/
    /// let/var/interface/type/enum <name>`. Multiple names for a single
    /// `export const a = 1, b = 2;` -- one binding per declarator, matching
    /// `entities`' own one-entity-per-declarator granularity.
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

    fn finish_import_relations(&mut self) {
        if self.node_test_from {
            self.entities[0].is_test = Some(true);
        }
        let facts = self
            .imports
            .iter()
            .filter_map(|edge| match edge.kind {
                ImportKind::Import => Some((RelationKind::Import, edge)),
                ImportKind::Export => Some((RelationKind::Export, edge)),
                ImportKind::DynamicImport | ImportKind::Require => None,
            })
            .map(|(kind, edge)| {
                let target_id = edge
                    .target_path
                    .as_ref()
                    .map(|path| stable_entity_id(EntityKind::Module, path, 0, path));
                (
                    kind,
                    target_id.clone(),
                    edge.start,
                    edge.end,
                    if target_id.is_some() {
                        RelationClassification::Confirmed
                    } else {
                        RelationClassification::Possible
                    },
                )
            })
            .collect::<Vec<_>>();
        for (kind, target_id, start, end, classification) in facts {
            self.push_relation(
                kind,
                self.module_id.clone(),
                target_id,
                start,
                end,
                classification,
            );
        }
    }
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
        // `TSModuleDeclaration` (namespace) and `TSImportEqualsDeclaration`
        // are not in `EntityKind`'s scope at all (see `SyntaxExportBinding`'s
        // doc comment) -- left out deliberately, not an oversight.
        _ => Vec::new(),
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
    fn visit_export_specifier(&mut self, specifier: &ExportSpecifier<'a>) {
        if let ModuleExportName::IdentifierReference(local) = &specifier.local {
            let exported_name = module_export_name_text(&specifier.exported);
            self.export_bindings.push(SyntaxExportBinding {
                exported_name,
                local_name: local.name.as_str().to_owned(),
                source_specifier: None,
                source_target_path: None,
            });
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
        walk_export_all_declaration(self, declaration);
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
        if let Some(declarator) = declaration.declarations.first()
            && let BindingPattern::BindingIdentifier(identifier) = &declarator.id
        {
            self.push_entity(identifier, EntityKind::Variable, UniversalKind::Value);
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
    for import in &direct_imports {
        let kind = match import.kind {
            ImportKind::Import => RelationKind::Import,
            ImportKind::Export => RelationKind::Export,
            ImportKind::DynamicImport | ImportKind::Require => continue,
        };
        let target_id = import
            .target_path
            .as_ref()
            .map(|path| stable_entity_id(EntityKind::Module, path, 0, path));
        let classification = if target_id.is_some() {
            RelationClassification::Confirmed
        } else {
            RelationClassification::Possible
        };
        let id = format!(
            "jsts:{}:{}:{}:{}:{}:{}",
            kind.identity_name(),
            file.path,
            import.start,
            import.end,
            module_id,
            target_id.as_deref().unwrap_or("unresolved")
        );
        relations.push(SyntaxRelation {
            id,
            kind,
            source_id: module_id.clone(),
            target_id,
            path: file.path.clone(),
            start: import.start,
            end: import.end,
            classification,
        });
    }
    relations.sort_by(|left, right| left.id.cmp(&right.id));
    Some(SyntaxFileResult {
        path: file.path.clone(),
        content_digest: file.content_digest.clone(),
        language: file.language,
        script_kind: file.script_kind,
        byte_length: file.byte_length,
        parsed: file.parsed,
        direct_imports,
        entities: file.entities.clone(),
        relations,
        diagnostics: file.diagnostics.clone(),
        export_bindings,
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
                    (
                        record.body["kind"].as_str().unwrap(),
                        record.body["name"].as_str().unwrap(),
                    )
                })
                .collect::<Vec<_>>(),
            vec![("module", "a.js")]
        );
        assert!(records.iter().any(|record| {
            record.kind == "jsts:relation_export" && record.body["classification"] == "confirmed"
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
                && record.body["kind"] == "variable"
                && record.body["name"] == "V"
        }));
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
                },
                &AtomicBool::new(false),
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::SourceDigestMismatch);
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
}
