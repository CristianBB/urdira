//! Typed wire shapes for the tsgo async API, transcribed from
//! `node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/dist/api/proto.d.ts`
//! and the request-building call sites in `dist/api/async/api.js` (see
//! `crate::client` for the method-name/params mapping). Only the subset this
//! crate's `TsgoClient`/`ResidualResolver` actually send or parse is
//! reproduced; anything else in the real API (diagnostics, completions,
//! emit, most of the `Checker`'s type-level surface) is out of scope — see
//! the crate-level docs.

use serde::{Deserialize, Serialize};

/// A file identified by path. The real protocol also allows `{uri: string}`
/// (`DocumentIdentifier`'s other variant, for LSP interop); this crate only
/// ever talks in plain paths, so it is not reproduced.
pub type DocumentIdentifier = String;

/// Params for `updateSnapshot`. Field names and semantics match
/// `LSPUpdateSnapshotParams`/`UpdateSnapshotParams` in `proto.d.ts`; the
/// deprecated singular `openProject` shim is intentionally not reproduced —
/// always send `open_projects`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct UpdateSnapshotParams {
    #[serde(rename = "openProjects", skip_serializing_if = "Vec::is_empty")]
    pub open_projects: Vec<DocumentIdentifier>,
    #[serde(rename = "closeProjects", skip_serializing_if = "Vec::is_empty")]
    pub close_projects: Vec<DocumentIdentifier>,
    #[serde(rename = "openFiles", skip_serializing_if = "Vec::is_empty")]
    pub open_files: Vec<DocumentIdentifier>,
    #[serde(rename = "closeFiles", skip_serializing_if = "Vec::is_empty")]
    pub close_files: Vec<DocumentIdentifier>,
    #[serde(rename = "fileChanges", skip_serializing_if = "Option::is_none")]
    pub file_changes: Option<FileChanges>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum FileChanges {
    Summary {
        #[serde(skip_serializing_if = "Vec::is_empty")]
        changed: Vec<DocumentIdentifier>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        created: Vec<DocumentIdentifier>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        deleted: Vec<DocumentIdentifier>,
    },
    InvalidateAll {
        #[serde(rename = "invalidateAll")]
        invalidate_all: bool,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectResponse {
    pub id: String,
    #[serde(rename = "configFileName")]
    pub config_file_name: String,
    #[serde(rename = "compilerOptions")]
    pub compiler_options: serde_json::Value,
    #[serde(rename = "rootFiles")]
    pub root_files: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProjectFileChanges {
    #[serde(rename = "changedFiles", default)]
    pub changed_files: Vec<String>,
    #[serde(rename = "deletedFiles", default)]
    pub deleted_files: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SnapshotChanges {
    #[serde(rename = "changedProjects", default)]
    pub changed_projects: std::collections::BTreeMap<String, ProjectFileChanges>,
    #[serde(rename = "removedProjects", default)]
    pub removed_projects: Vec<String>,
}

/// Response from `updateSnapshot`, named `SnapshotInfo` per the task brief
/// (the wire shape is `UpdateSnapshotResponse` in `proto.d.ts`).
#[derive(Debug, Clone, Deserialize)]
pub struct SnapshotInfo {
    pub snapshot: u64,
    pub projects: Vec<ProjectResponse>,
    #[serde(default)]
    pub changes: Option<SnapshotChanges>,
}

/// `SymbolResponse` from `proto.d.ts`. `flags` is the checker's
/// `SymbolFlags` bitmask (see `crate::symbol_flags` for the bits this crate
/// tests against); `declarations`/`value_declaration` are node handle
/// strings (`"{index}.{kind}.{path}"`, `crate::node::NodeHandle`).
#[derive(Debug, Clone, Deserialize)]
pub struct SymbolResponse {
    pub id: u64,
    pub project: String,
    pub name: String,
    pub flags: u32,
    #[serde(rename = "checkFlags", default)]
    pub check_flags: u32,
    #[serde(default)]
    pub declarations: Vec<String>,
    #[serde(rename = "valueDeclaration", default)]
    pub value_declaration: Option<String>,
    #[serde(default)]
    pub parent: Option<u64>,
    #[serde(rename = "exportSymbol", default)]
    pub export_symbol: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SignatureResponse {
    pub id: u64,
    pub flags: u32,
    #[serde(default)]
    pub declaration: Option<String>,
    #[serde(default)]
    pub parameters: Vec<u64>,
    #[serde(rename = "thisParameter", default)]
    pub this_parameter: Option<u64>,
    #[serde(default)]
    pub target: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TypeResponse {
    pub id: u64,
    pub flags: u32,
    #[serde(default)]
    pub symbol: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InitializeResponse {
    #[allow(dead_code)]
    #[serde(rename = "useCaseSensitiveFileNames")]
    pub use_case_sensitive_file_names: bool,
    #[serde(rename = "currentDirectory")]
    pub current_directory: String,
}

/// Bits of `SymbolFlags` this crate reads (from
/// `node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/dist/enums/symbolFlags.enum.js`).
/// Only `Alias` is needed: `ResidualResolver` mirrors `analyzer.ts`'s
/// `(symbol.flags & SymbolFlags.Alias) !== 0` alias-hop check.
pub mod symbol_flags {
    pub const ALIAS: u32 = 0x0020_0000;
}
