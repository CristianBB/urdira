//! The caller-provided virtual filesystem tsgo's `--callbacks=...` flag asks
//! the client to serve.
//!
//! Mirrors `dist/api/fs.js`'s `FileSystem` interface, minus the "fall back
//! to the real filesystem" case (`readFile` returning `undefined`): this
//! crate always spawns tsgo with every one of `fsCallbackNames` enabled
//! (`readFile,fileExists,directoryExists,getAccessibleEntries,realpath`),
//! so the virtual FS is authoritative — a path tsgo asks about either
//! exists in it or does not, never "ask the real disk instead".

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// The two kinds of entry `getAccessibleEntries` reports for a directory.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct DirectoryEntries {
    pub files: Vec<String>,
    pub directories: Vec<String>,
}

/// Callback surface tsgo's async API mode calls back into over the same
/// JSON-RPC connection, once `--callbacks=...` names them.
///
/// All paths are as tsgo passes them: normalized to the `--cwd` the client
/// spawned it with, forward-slashed. This crate does not second-guess that
/// normalization — a caller building a virtual root should key its map by
/// exactly the paths it intends to hand to `updateSnapshot`/`getSourceFile`.
pub trait VirtualFs: Send + Sync {
    /// `None` means the file does not exist. `Some(String::new())` is a
    /// valid empty file, distinct from "does not exist".
    fn read_file(&self, path: &str) -> Option<String>;
    fn file_exists(&self, path: &str) -> bool;
    fn directory_exists(&self, path: &str) -> bool;
    /// `None` means `path` is not a directory in this filesystem.
    fn get_accessible_entries(&self, path: &str) -> Option<DirectoryEntries>;
    /// This crate's virtual filesystems have no symlinks, so the default
    /// implementation is the identity function, matching
    /// `createVirtualFileSystem`'s own `realpath: path => path`.
    fn realpath(&self, path: &str) -> Option<String> {
        Some(path.to_string())
    }
}

/// A plain in-memory `VirtualFs` keyed by exact path string, sufficient for
/// tests and the bench harness. Directory membership is derived from the
/// file paths inserted (there is no separate "create an empty directory"
/// operation), matching `createVirtualFileSystem`'s own tree-from-paths
/// construction.
#[derive(Debug, Default, Clone)]
pub struct MapFs {
    files: BTreeMap<String, String>,
}

impl MapFs {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, path: impl Into<String>, content: impl Into<String>) {
        self.files.insert(normalize(&path.into()), content.into());
    }

    pub fn from_entries<I, K, V>(entries: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let mut fs = Self::new();
        for (path, content) in entries {
            fs.insert(path, content);
        }
        fs
    }
}

fn normalize(path: &str) -> String {
    path.replace('\\', "/")
}

impl VirtualFs for MapFs {
    fn read_file(&self, path: &str) -> Option<String> {
        self.files.get(&normalize(path)).cloned()
    }

    fn file_exists(&self, path: &str) -> bool {
        self.files.contains_key(&normalize(path))
    }

    fn directory_exists(&self, path: &str) -> bool {
        let path = normalize(path);
        let prefix = if path.ends_with('/') {
            path.clone()
        } else {
            format!("{path}/")
        };
        path == "/" || self.files.keys().any(|f| f.starts_with(&prefix))
    }

    fn get_accessible_entries(&self, path: &str) -> Option<DirectoryEntries> {
        if !self.directory_exists(path) {
            return None;
        }
        let path = normalize(path);
        let prefix = if path == "/" {
            "/".to_string()
        } else if path.ends_with('/') {
            path.clone()
        } else {
            format!("{path}/")
        };
        let mut files = Vec::new();
        let mut directories = std::collections::BTreeSet::new();
        for candidate in self.files.keys() {
            let Some(rest) = candidate.strip_prefix(&prefix) else {
                continue;
            };
            if rest.is_empty() {
                continue;
            }
            match rest.find('/') {
                None => files.push(rest.to_string()),
                Some(idx) => {
                    directories.insert(rest[..idx].to_string());
                }
            }
        }
        Some(DirectoryEntries {
            files,
            directories: directories.into_iter().collect(),
        })
    }
}

/// Wraps a base `VirtualFs` with a small, mutable set of exact-path
/// overrides, checked first. Built for
/// [`crate::residual_pass::ResidualPass`]: a residual pass reuses one long-
/// lived `TsgoClient` (and therefore one fixed `VirtualFs` it was spawned
/// with — the FS is captured by the client's reader thread for the whole
/// process lifetime) across many windows, but each window needs its OWN
/// synthetic project-config document (`{"compilerOptions": ..., "files":
/// [...one window's roots...]}`, the same shape
/// `analyzer.ts`'s `activateRustSemanticWindow` mutates its `fileMap` entry
/// with between windows). `OverlayFs::set` lets the pass runner rewrite
/// that one document's content between `updateSnapshot` calls without
/// needing a mutable `VirtualFs` trait (every other method stays a plain
/// `&self` read) or rebuilding the whole workspace map per window.
///
/// Everything that is not an active override falls through to `base`
/// unchanged — in particular `directory_exists`/`get_accessible_entries`
/// are never affected by overrides (a project-config document is a file,
/// never queried as a directory).
pub struct OverlayFs {
    base: Arc<dyn VirtualFs>,
    overrides: Mutex<BTreeMap<String, String>>,
}

impl OverlayFs {
    pub fn new(base: Arc<dyn VirtualFs>) -> Self {
        Self {
            base,
            overrides: Mutex::new(BTreeMap::new()),
        }
    }

    /// Installs (or replaces) the override content at `path`, effective for
    /// every read starting immediately after this call returns.
    pub fn set(&self, path: impl Into<String>, content: impl Into<String>) {
        self.overrides
            .lock()
            .unwrap()
            .insert(normalize(&path.into()), content.into());
    }
}

impl VirtualFs for OverlayFs {
    fn read_file(&self, path: &str) -> Option<String> {
        if let Some(content) = self.overrides.lock().unwrap().get(&normalize(path)) {
            return Some(content.clone());
        }
        self.base.read_file(path)
    }

    fn file_exists(&self, path: &str) -> bool {
        self.overrides
            .lock()
            .unwrap()
            .contains_key(&normalize(path))
            || self.base.file_exists(path)
    }

    fn directory_exists(&self, path: &str) -> bool {
        self.base.directory_exists(path)
    }

    fn get_accessible_entries(&self, path: &str) -> Option<DirectoryEntries> {
        self.base.get_accessible_entries(path)
    }

    fn realpath(&self, path: &str) -> Option<String> {
        self.base.realpath(path)
    }
}

/// A `VirtualFs` that serves everything from `virtual_fs` (the authoritative
/// in-memory workspace map — see that trait's own doc comment), EXCEPT for
/// paths under one of `real_roots`, which fall through to the real
/// filesystem (`std::fs`).
///
/// Built specifically to answer tsgo's default-lib-file requests: as
/// recorded live in `docs/evidence/2026-09-03-v4-p1d-a-tsgo-client.md`
/// (§2, §8), tsgo's checker asks for `lib.es2025.full.d.ts` and friends by
/// their ABSOLUTE REAL FILESYSTEM PATH — the same directory
/// `crate::binary::TsgoBinary::path`'s parent (the resolved platform
/// package's `lib/` directory, which holds both the native binary AND every
/// `lib.*.d.ts` file side by side; confirmed on disk for this repo's pinned
/// `typescript@7.0.2` / `@typescript/typescript-darwin-arm64@7.0.2`, 108
/// `lib.*.d.ts` files). A caller builds a `LayeredFs` with exactly that one
/// directory (or platform-appropriate equivalent) as its sole `real_roots`
/// entry, and every `Array`/`Promise`/other lib global then resolves.
///
/// Deliberately narrow: this is NOT a "fall back to disk for anything
/// missing" shim. A path outside every listed root — most importantly
/// anything under a workspace's own `node_modules` (third-party type
/// packages) — is never served from disk, even if it happens to exist
/// there. This crate does no module resolution of its own and has no way to
/// know which installed version of a dependency's types a given workspace
/// snapshot should see, so serving `node_modules` from the real filesystem
/// would silently make results depend on whatever happens to be installed
/// on the machine running the pass rather than on the workspace's own
/// virtual snapshot. A reference into an external package therefore stays
/// `Unresolved` (or, if it happens to also be reachable through the
/// workspace map some other way, resolves normally) — a documented scope
/// limit, not a bug.
pub struct LayeredFs {
    virtual_fs: Arc<dyn VirtualFs>,
    /// Normalized (forward-slashed), absolute, no trailing slash.
    real_roots: Vec<String>,
    /// Lowercased copy of `real_roots`, precomputed for `under_real_root`'s
    /// case-insensitive comparison (see that method's doc comment).
    real_roots_lower: Vec<String>,
}

impl LayeredFs {
    pub fn new(virtual_fs: Arc<dyn VirtualFs>, real_roots: Vec<String>) -> Self {
        let real_roots: Vec<String> = real_roots
            .into_iter()
            .map(|root| normalize(&root).trim_end_matches('/').to_string())
            .collect();
        let real_roots_lower = real_roots.iter().map(|root| root.to_lowercase()).collect();
        Self {
            virtual_fs,
            real_roots,
            real_roots_lower,
        }
    }

    /// The real-root list this layer was built with, e.g. for a caller that
    /// needs to classify a resolved declaration's path as "inside a lib
    /// root" after the fact (`crate::residual_pass`'s `External` outcome).
    pub fn real_roots(&self) -> &[String] {
        &self.real_roots
    }

    /// Whether `path` falls under one of `real_roots`, compared CASE-
    /// INSENSITIVELY. This matters live: tsgo's own `initialize` response
    /// reports `useCaseSensitiveFileNames: false` on a case-insensitive
    /// host filesystem (confirmed on this repo's default macOS/APFS setup),
    /// and the checker then canonicalizes absolute paths it hands back in
    /// declaration handles to lowercase — a real capture showed the lib
    /// directory's OWN path (originally mixed-case, e.g.
    /// `/Users/Cristian/...`) coming back as `/users/cristian/...` in a
    /// resolved declaration's `NodeHandle`. A case-SENSITIVE comparison
    /// here would then wrongly classify every lib declaration as
    /// unreachable ("not under any real root"), even though the
    /// subsequent `std::fs::read_to_string` of that same lowercased path
    /// succeeds fine on the case-insensitive volume (the OS itself resolves
    /// it). Case-insensitive matching costs nothing on a case-sensitive
    /// host (a mismatched-case path there would fail the later
    /// `std::fs` call anyway, exactly as it should).
    fn under_real_root(&self, path: &str) -> bool {
        self.matching_real_root(path).is_some()
    }

    /// Like `under_real_root`, but returns the ORIGINAL-case real root
    /// `path` falls under (from `real_roots`, not the lowercased copy used
    /// for the comparison itself) — what `crate::residual_pass`'s
    /// `SiteOutcome::External` classification needs: "is this resolved
    /// declaration's path one this pass considers a lib file", answered
    /// without duplicating the case-insensitive comparison rule at the
    /// call site.
    pub fn matching_real_root(&self, path: &str) -> Option<&str> {
        let normalized = normalize(path).to_lowercase();
        self.real_roots_lower
            .iter()
            .position(|root| normalized == *root || normalized.starts_with(&format!("{root}/")))
            .map(|index| self.real_roots[index].as_str())
    }
}

impl VirtualFs for LayeredFs {
    fn read_file(&self, path: &str) -> Option<String> {
        if let Some(content) = self.virtual_fs.read_file(path) {
            return Some(content);
        }
        if self.under_real_root(path) {
            return std::fs::read_to_string(path).ok();
        }
        None
    }

    fn file_exists(&self, path: &str) -> bool {
        if self.virtual_fs.file_exists(path) {
            return true;
        }
        self.under_real_root(path) && Path::new(path).is_file()
    }

    fn directory_exists(&self, path: &str) -> bool {
        if self.virtual_fs.directory_exists(path) {
            return true;
        }
        self.under_real_root(path) && Path::new(path).is_dir()
    }

    fn get_accessible_entries(&self, path: &str) -> Option<DirectoryEntries> {
        if let Some(entries) = self.virtual_fs.get_accessible_entries(path) {
            return Some(entries);
        }
        if !self.under_real_root(path) {
            return None;
        }
        let read_dir = std::fs::read_dir(path).ok()?;
        let mut files = Vec::new();
        let mut directories = Vec::new();
        for entry in read_dir.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            match entry.file_type() {
                Ok(file_type) if file_type.is_dir() => directories.push(name),
                Ok(_) => files.push(name),
                Err(_) => continue,
            }
        }
        files.sort();
        directories.sort();
        Some(DirectoryEntries { files, directories })
    }

    // `realpath` keeps the default (identity) implementation: none of this
    // crate's usages involve symlinks in either the virtual map or the
    // handful of real lib directories this layers in.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_files_and_subdirectories() {
        let fs =
            MapFs::from_entries([("/root/a.ts", "export {}"), ("/root/sub/b.ts", "export {}")]);
        assert!(fs.file_exists("/root/a.ts"));
        assert!(!fs.file_exists("/root/missing.ts"));
        assert!(fs.directory_exists("/root"));
        assert!(fs.directory_exists("/root/sub"));
        assert!(!fs.directory_exists("/root/nope"));
        let entries = fs.get_accessible_entries("/root").unwrap();
        assert_eq!(entries.files, vec!["a.ts".to_string()]);
        assert_eq!(entries.directories, vec!["sub".to_string()]);
        assert!(fs.get_accessible_entries("/does-not-exist").is_none());
    }

    #[test]
    fn realpath_is_identity() {
        let fs = MapFs::new();
        assert_eq!(fs.realpath("/x/y.ts"), Some("/x/y.ts".to_string()));
    }

    #[test]
    fn read_file_distinguishes_missing_from_empty() {
        let fs = MapFs::from_entries([("/a.ts", "")]);
        assert_eq!(fs.read_file("/a.ts"), Some(String::new()));
        assert_eq!(fs.read_file("/b.ts"), None);
    }

    #[test]
    fn overlay_override_wins_and_falls_through_when_absent() {
        let base: Arc<dyn VirtualFs> = Arc::new(MapFs::from_entries([("/a.ts", "base")]));
        let overlay = OverlayFs::new(base);
        assert_eq!(overlay.read_file("/a.ts"), Some("base".to_string()));
        overlay.set("/a.ts", "overridden");
        assert_eq!(overlay.read_file("/a.ts"), Some("overridden".to_string()));
        assert!(overlay.file_exists("/a.ts"));
        assert!(!overlay.file_exists("/missing.ts"));
        overlay.set("/config.json", "{}");
        assert!(overlay.file_exists("/config.json"));
        assert_eq!(overlay.read_file("/config.json"), Some("{}".to_string()));
    }

    #[test]
    fn overlay_leaves_directory_queries_to_base() {
        let base: Arc<dyn VirtualFs> = Arc::new(MapFs::from_entries([("/root/a.ts", "x")]));
        let overlay = OverlayFs::new(base);
        overlay.set("/root/config.json", "{}");
        // The override is a file, never surfaced by directory listing --
        // only `base`'s own entries appear.
        let entries = overlay.get_accessible_entries("/root").unwrap();
        assert_eq!(entries.files, vec!["a.ts".to_string()]);
    }

    #[test]
    fn layered_fs_serves_real_root_files_not_in_the_virtual_map() {
        let dir = std::env::temp_dir().join(format!(
            "urdira-tsgo-client-layered-fs-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let lib_file = dir.join("lib.fake.d.ts");
        std::fs::write(&lib_file, "declare const X: number;").unwrap();

        let virtual_fs: Arc<dyn VirtualFs> =
            Arc::new(MapFs::from_entries([("/workspace/a.ts", "export {}")]));
        let real_root = dir.to_string_lossy().replace('\\', "/");
        let layered = LayeredFs::new(virtual_fs, vec![real_root.clone()]);

        // Virtual entries still win / are still served.
        assert_eq!(
            layered.read_file("/workspace/a.ts"),
            Some("export {}".to_string())
        );
        assert!(layered.file_exists("/workspace/a.ts"));

        // A path under the real root, absent from the virtual map, is
        // served from disk.
        let lib_path = lib_file.to_string_lossy().replace('\\', "/");
        assert_eq!(
            layered.read_file(&lib_path),
            Some("declare const X: number;".to_string())
        );
        assert!(layered.file_exists(&lib_path));
        assert!(layered.directory_exists(&real_root));
        let entries = layered.get_accessible_entries(&real_root).unwrap();
        assert_eq!(entries.files, vec!["lib.fake.d.ts".to_string()]);

        // A path NOT under any real root and NOT in the virtual map is
        // still "not found" -- the workspace-only rule for everything else
        // (e.g. `node_modules`).
        assert_eq!(
            layered.read_file("/workspace/node_modules/x/index.d.ts"),
            None
        );
        assert!(!layered.file_exists("/workspace/node_modules/x/index.d.ts"));
        assert_eq!(layered.real_roots(), &[real_root]);

        std::fs::remove_dir_all(&dir).ok();
    }
}
