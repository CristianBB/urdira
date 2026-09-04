//! Parallel filesystem walk + hash, replacing
//! `packages/engine/src/directory-provider.ts`'s enumeration/`#captureFile`
//! on the Rust route. See `docs/evidence/2026-09-02-v4-p2-2a-source-frontier.md`
//! for the line-by-line mapping to the TS source and the oracle comparison
//! that pins `normalized_uri`/`content_hash` byte-for-byte against it.
//!
//! Deliberate simplifications versus the full TS provider (documented, not
//! accidental — see the evidence doc's "Deviations" section):
//! - Symlinks are never followed and never observed at all (the walker skips
//!   them at `lstat` time), matching TS's default `follow_symlinks !== true`
//!   configuration's net effect without replicating its separate
//!   target-inspection branch.
//! - `metadata_digest` hashes only the plain stat fields (`byte_length,
//!   ctime_ms, device, inode, mode, mtime_ms`), not TS's
//!   `{link, target, target_path}` boundary wrapper — the wrapper embeds an
//!   absolute, machine-canonicalized `target_path`, which is not portable
//!   across checkouts/machines and is not needed for this crate's own
//!   equivalence rule (which only ever compares a value this same crate
//!   produced against an earlier one it produced).

use crate::cas::CasPut;
use crate::digest::digest_logical_value;
use crate::inclusion::{
    GitIgnoreRules, InclusionObservation, InclusionRules, compute_media_type, evaluate_inclusion,
};
use rayon::prelude::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

/// Port of `directory-provider.ts`'s `metadata(statValue)`: the plain stat
/// fields hashed into `metadata_digest` (see the module doc's deviation
/// note for why the TS `{link, target, target_path}` wrapper is dropped).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StatMetadata {
    pub byte_length: u64,
    pub ctime_ms: f64,
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub mtime_ms: f64,
}

impl StatMetadata {
    fn to_json(self) -> serde_json::Value {
        json!({
            "byte_length": self.byte_length,
            "ctime_ms": self.ctime_ms,
            "device": self.device,
            "inode": self.inode,
            "mode": self.mode,
            "mtime_ms": self.mtime_ms,
        })
    }

    /// `digestLogicalValue(metadata(statValue))`.
    pub fn digest(self) -> String {
        digest_logical_value(&self.to_json())
    }
}

#[cfg(unix)]
fn stat_metadata(metadata: &std::fs::Metadata) -> StatMetadata {
    use std::os::unix::fs::MetadataExt;
    StatMetadata {
        byte_length: metadata.len(),
        ctime_ms: metadata.ctime() as f64 * 1000.0 + metadata.ctime_nsec() as f64 / 1_000_000.0,
        device: metadata.dev(),
        inode: metadata.ino(),
        mode: metadata.mode(),
        mtime_ms: metadata.mtime() as f64 * 1000.0 + metadata.mtime_nsec() as f64 / 1_000_000.0,
    }
}

#[cfg(not(unix))]
fn stat_metadata(metadata: &std::fs::Metadata) -> StatMetadata {
    // Best-effort fallback (documented limitation, see the evidence doc):
    // Windows exposes no POSIX inode/device pair through `std::fs`. This
    // crate's own equivalence rule only ever compares a digest this crate
    // produced against an earlier one it produced, so a stable non-POSIX
    // substitute is safe here even though it cannot reproduce the Unix
    // numbers.
    use std::os::windows::fs::MetadataExt;
    let modified_ticks = metadata.last_write_time();
    StatMetadata {
        byte_length: metadata.len(),
        ctime_ms: metadata.creation_time() as f64 / 10_000.0,
        device: u64::from(metadata.volume_serial_number().unwrap_or(0)),
        inode: metadata.file_index().unwrap_or(0),
        mode: 0,
        mtime_ms: modified_ticks as f64 / 10_000.0,
    }
}

/// Port of `contentVersionToken(boundaryToken, contentHash)`, with
/// `boundaryToken` taken to be `metadata_digest` (in the real TS
/// `FileBoundary`, `token` and `metadata_digest` are computed from the
/// exact same `identity` object and so are literally always equal — see the
/// evidence doc).
pub fn content_version_token(metadata_digest: &str, content_hash: &str) -> String {
    digest_logical_value(&json!({
        "boundary_token": metadata_digest,
        "content_hash": content_hash,
    }))
}

fn sha256_hex_prefixed(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(71);
    out.push_str("sha256:");
    for byte in Sha256::digest(bytes) {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

/// One observed source file: same shape as a `ProviderObservation` row's
/// content-bearing fields (`normalized_uri`, `observed_content_hash`,
/// `observed_metadata_digest`, `provider_version_token`), plus the raw stat
/// used to build them.
#[derive(Debug, Clone)]
pub struct Observation {
    pub normalized_uri: String,
    pub content_hash: String,
    pub byte_length: u64,
    pub metadata: StatMetadata,
    pub metadata_digest: String,
    pub version_token: String,
    /// `"utf-8"` or `"binary"`, matching `ArtifactVersionInput.encoding`
    /// (`packages/engine/src/source-indexer.ts:976`).
    pub encoding: &'static str,
    /// `Some("text")` unless `encoding == "binary"`, matching
    /// `language_hint` at the same call site.
    pub language_hint: Option<&'static str>,
}

/// `Walker::observe_paths`' per-path result: a path can have been deleted
/// (or excluded) since the caller last knew about it.
#[derive(Debug, Clone)]
pub enum PathObservation {
    Present(Observation),
    Absent { normalized_uri: String },
}

fn normalize_relative(root: &Path, absolute: &Path) -> Option<String> {
    let relative = absolute.strip_prefix(root).ok()?;
    let mut segments = Vec::new();
    for component in relative.components() {
        match component {
            std::path::Component::Normal(part) => {
                segments.push(part.to_string_lossy().into_owned())
            }
            _ => return None,
        }
    }
    let joined = segments.join("/");
    Some(joined.nfc().collect::<String>())
}

fn hash_and_include(
    root: &Path,
    absolute: &Path,
    uri: &str,
    rules: &InclusionRules,
    gitignore: &GitIgnoreRules,
    cas: Option<&dyn CasPut>,
) -> std::io::Result<Option<Observation>> {
    let link_metadata = std::fs::symlink_metadata(absolute)?;
    if link_metadata.file_type().is_symlink() {
        // Skip symlinks exactly as TS does by default (see the module doc).
        return Ok(None);
    }
    if !link_metadata.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(absolute)?;
    let content_hash = sha256_hex_prefixed(&bytes);
    let media_type = compute_media_type(uri, &bytes);
    let observation = InclusionObservation {
        normalized_path: uri,
        is_symlink: false,
        is_directory: false,
        byte_length: link_metadata.len(),
        media_type,
        outside_allowed_root: false,
        symlink_cycle: false,
        is_special: false,
    };
    if !evaluate_inclusion(&observation, rules, gitignore).included {
        return Ok(None);
    }
    // CAS put happens per-file, right here (plan §4.1: "por fichero: lstat
    // -> read -> sha256 -> CAS put si no existe"), not deferred to
    // `Catalog::apply` — an unchanged re-observed file (dropped by
    // `Delta::compute`'s equivalence check before it ever reaches the
    // catalog) still gets its bytes durably content-addressed here exactly
    // once, same as every other observed file.
    // I/O for the write itself (or its enqueue) happens off this
    // function's caller's critical path when `cas` is a `CasWriteQueue`
    // (item 2, P2-2h): `bytes` is moved, not cloned, into `sink.put` --
    // this is the last use of `bytes` in this function either way.
    if let Some(sink) = cas {
        sink.put(&content_hash, bytes);
    }
    let metadata = stat_metadata(&link_metadata);
    let metadata_digest = metadata.digest();
    let version_token = content_version_token(&metadata_digest, &content_hash);
    let is_binary = media_type == "application/octet-stream";
    let _ = root; // kept for signature symmetry / future use (e.g. external-root checks).
    Ok(Some(Observation {
        normalized_uri: uri.to_string(),
        content_hash,
        byte_length: metadata.byte_length,
        metadata,
        metadata_digest,
        version_token,
        encoding: if is_binary { "binary" } else { "utf-8" },
        language_hint: if is_binary { None } else { Some("text") },
    }))
}

pub struct Walker;

impl Walker {
    /// Parallel full-tree enumeration: `ignore::WalkBuilder::build_parallel`
    /// fans the directory walk itself out across `available_parallelism`
    /// threads (always pruning `.git`/`.urdira` outright via
    /// `WalkState::Skip` rather than merely filtering their entries out
    /// afterward, and never following symlinked directories), doing each
    /// file's `lstat` -> `read` -> `sha256` -> CAS-put -> inclusion check
    /// inline on whichever worker thread visits it — one parallel pass
    /// instead of a sequential walk followed by a separate `rayon` hashing
    /// pass, which is what actually saturates disk I/O (see the evidence
    /// doc's bench numbers: this replaced an earlier two-phase version that
    /// walked single-threaded before hashing in parallel and was
    /// measurably slower on a real corpus).
    pub fn enumerate(
        root: &Path,
        rules: &InclusionRules,
        gitignore: &GitIgnoreRules,
        cas: Option<&dyn CasPut>,
    ) -> std::io::Result<Vec<Observation>> {
        let threads = std::thread::available_parallelism()
            .map(std::num::NonZero::get)
            .unwrap_or(4);
        let mut builder = ignore::WalkBuilder::new(root);
        builder
            .standard_filters(false) // this crate's own `evaluate_inclusion` is the authority, not the `ignore` crate's git-standard defaults.
            .follow_links(false)
            .hidden(false)
            .threads(threads);

        let (sender, receiver) = std::sync::mpsc::channel::<Observation>();
        builder.build_parallel().run(|| {
            let sender = sender.clone();
            Box::new(move |result| {
                use ignore::WalkState;
                let Ok(entry) = result else {
                    return WalkState::Continue;
                };
                let path = entry.path();
                let relative = path.strip_prefix(root).unwrap_or(path);
                if matches!(relative.components().next(), Some(std::path::Component::Normal(name)) if name == ".git" || name == ".urdira") {
                    return WalkState::Skip;
                }
                let Some(uri) = normalize_relative(root, path) else {
                    return WalkState::Continue;
                };
                if uri.is_empty() {
                    return WalkState::Continue;
                }
                if let Ok(Some(observation)) = hash_and_include(root, path, &uri, rules, gitignore, cas) {
                    let _ = sender.send(observation);
                }
                WalkState::Continue
            })
        });
        drop(sender);
        Ok(receiver.into_iter().collect())
    }

    /// Incremental case: re-observe exactly `paths` (workspace-relative,
    /// forward-slash) without walking the tree. A path that no longer
    /// exists, or no longer passes inclusion, comes back as
    /// [`PathObservation::Absent`].
    pub fn observe_paths(
        root: &Path,
        paths: &[String],
        rules: &InclusionRules,
        gitignore: &GitIgnoreRules,
        cas: Option<&dyn CasPut>,
    ) -> Vec<PathObservation> {
        paths
            .par_iter()
            .map(|uri| {
                let absolute = root.join(uri);
                match hash_and_include(root, &absolute, uri, rules, gitignore, cas) {
                    Ok(Some(observation)) => PathObservation::Present(observation),
                    Ok(None) | Err(_) => PathObservation::Absent {
                        normalized_uri: uri.clone(),
                    },
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inclusion::default_workspace_inclusion;
    use std::fs;
    use std::path::PathBuf;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "urdira-source-frontier-walker-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn enumerate_skips_excluded_binary_and_git_and_symlinks() {
        let dir = TempDir::new("enumerate");
        let root = dir.path();
        fs::create_dir_all(root.join("src/sub")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("src/a.ts"), b"export const a = 1;").unwrap();
        fs::write(root.join("src/sub/b.ts"), b"export const b = 2;").unwrap();
        fs::write(root.join("src/img.png"), b"binary").unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), b"module.exports={}").unwrap();
        fs::write(root.join(".git/HEAD"), b"ref: refs/heads/main").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(root.join("src/a.ts"), root.join("src/link.ts")).unwrap();
        }

        let rules = default_workspace_inclusion();
        let gitignore = GitIgnoreRules::default();
        let mut uris: Vec<String> = Walker::enumerate(root, &rules, &gitignore, None)
            .unwrap()
            .into_iter()
            .map(|observation| observation.normalized_uri)
            .collect();
        uris.sort();
        assert_eq!(
            uris,
            vec!["src/a.ts".to_string(), "src/sub/b.ts".to_string()]
        );
    }

    #[test]
    fn observe_paths_reports_deleted_file_as_absent() {
        let dir = TempDir::new("observe-paths");
        let root = dir.path();
        fs::write(root.join("a.ts"), b"export const a = 1;").unwrap();
        let rules = default_workspace_inclusion();
        let gitignore = GitIgnoreRules::default();
        let results = Walker::observe_paths(
            root,
            &["a.ts".to_string(), "missing.ts".to_string()],
            &rules,
            &gitignore,
            None,
        );
        let mut present = 0;
        let mut absent = 0;
        for result in results {
            match result {
                PathObservation::Present(observation) => {
                    assert_eq!(observation.normalized_uri, "a.ts");
                    present += 1;
                }
                PathObservation::Absent { normalized_uri } => {
                    assert_eq!(normalized_uri, "missing.ts");
                    absent += 1;
                }
            }
        }
        assert_eq!(present, 1);
        assert_eq!(absent, 1);
    }

    #[test]
    fn same_content_and_stat_yields_same_digests_across_two_walks() {
        let dir = TempDir::new("stability");
        let root = dir.path();
        fs::write(root.join("a.ts"), b"export const a = 1;").unwrap();
        let rules = default_workspace_inclusion();
        let gitignore = GitIgnoreRules::default();
        let first = Walker::enumerate(root, &rules, &gitignore, None).unwrap();
        let second = Walker::enumerate(root, &rules, &gitignore, None).unwrap();
        assert_eq!(first[0].content_hash, second[0].content_hash);
        assert_eq!(first[0].metadata_digest, second[0].metadata_digest);
        assert_eq!(first[0].version_token, second[0].version_token);
    }

    #[test]
    fn enumerate_writes_included_bytes_into_cas() {
        let dir = TempDir::new("cas-integration");
        let root = dir.path();
        fs::write(root.join("a.ts"), b"export const a = 1;").unwrap();
        let cas_dir = std::env::temp_dir().join(format!(
            "urdira-source-frontier-walker-cas-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = crate::cas::CasStore::open(&cas_dir).unwrap();
        let rules = default_workspace_inclusion();
        let gitignore = GitIgnoreRules::default();
        let observations = Walker::enumerate(root, &rules, &gitignore, Some(&store)).unwrap();
        assert_eq!(observations.len(), 1);
        let blob_path = store.blob_path(&observations[0].content_hash).unwrap();
        assert_eq!(fs::read(blob_path).unwrap(), b"export const a = 1;");
        let _ = fs::remove_dir_all(&cas_dir);
    }
}
