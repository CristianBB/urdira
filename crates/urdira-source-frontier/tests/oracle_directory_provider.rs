//! Cross-language oracle: runs the REAL `DirectorySourceProvider` (built
//! `packages/engine/dist`, the exact TS class the Rust route replaces) over
//! a fixture tree via `oracle/enumerate.mjs`, and asserts the Rust
//! `Walker::enumerate` observes the exact same `(normalized_uri,
//! content_hash)` set — the two fields load-bearing for the SQL rows and
//! CAS blobs this crate must produce identically to what a v3 workspace's
//! `source_artifacts`/`content_blobs` already contain.
//!
//! `metadata_digest`/`provider_version_token` are deliberately NOT compared:
//! see `src/walker.rs`'s module doc for why this crate's `metadata_digest`
//! recipe intentionally diverges from TS's (which embeds an absolute,
//! machine-canonicalized `target_path`).
//!
//! Skips (rather than fails) if `node` is not on `PATH` or
//! `packages/engine/dist`/`packages/canonical/dist` have not been built —
//! this test exercises cross-language parity, not this crate's own
//! correctness (that's `src/walker.rs`'s and `src/inclusion.rs`'s own unit
//! tests, which need no Node at all).

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use urdira_source_frontier::inclusion::{GitIgnoreRules, default_workspace_inclusion};
use urdira_source_frontier::walker::Walker;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn node_available() -> bool {
    Command::new("node")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn dist_built() -> bool {
    repo_root()
        .join("packages/engine/dist/directory-provider.js")
        .is_file()
        && repo_root()
            .join("packages/canonical/dist/index.js")
            .is_file()
}

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "urdira-source-frontier-oracle-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Builds a fixture tree exercising: nested directories, a default-excluded
/// directory (`node_modules`), a binary file (excluded by default), a NUL
/// byte file (excluded as binary media type), a `.gitignore` file (inert —
/// left as an ordinary observed text file, since `DirectorySourceProvider`'s
/// default `GitIgnoreRules` is `{ enabled: false }`), and (on unix) a
/// symlink, which both sides must skip entirely.
fn build_fixture(root: &Path) {
    fs::create_dir_all(root.join("src/sub")).unwrap();
    fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
    fs::write(root.join("src/a.ts"), b"export const a = 1;\n").unwrap();
    fs::write(root.join("src/sub/b.ts"), b"export const b = 2;\n").unwrap();
    fs::write(root.join(".gitignore"), b"dist/\n*.log\n").unwrap();
    fs::write(
        root.join("src/img.png"),
        b"not-a-real-png-but-binary-extension",
    )
    .unwrap();
    fs::write(root.join("src/withnul.bin"), b"a\0b\0c").unwrap();
    fs::write(
        root.join("node_modules/pkg/index.js"),
        b"module.exports = {};\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(root.join("src/a.ts"), root.join("src/link.ts")).unwrap();
    }
}

#[test]
fn walker_enumerate_matches_directory_source_provider_oracle() {
    if !node_available() || !dist_built() {
        eprintln!(
            "skipping oracle comparison: node or packages/engine+canonical dist not available"
        );
        return;
    }

    let temp = TempDir::new();
    let root = &temp.0;
    build_fixture(root);

    let oracle_script = Path::new(env!("CARGO_MANIFEST_DIR")).join("oracle/enumerate.mjs");
    let output = Command::new("node")
        .arg(&oracle_script)
        .arg(root)
        .output()
        .expect("failed to spawn node oracle script");
    assert!(
        output.status.success(),
        "oracle script failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let mut oracle_pairs: BTreeSet<(String, String)> = BTreeSet::new();
    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let value: serde_json::Value =
            serde_json::from_str(line).expect("oracle line must be JSON");
        let uri = value["normalized_uri"].as_str().unwrap().to_string();
        let content_hash = value["observed_content_hash"].as_str().unwrap().to_string();
        oracle_pairs.insert((uri, content_hash));
    }
    assert!(
        !oracle_pairs.is_empty(),
        "oracle must observe at least one file"
    );

    let rules = default_workspace_inclusion();
    let gitignore = GitIgnoreRules::default();
    let observations =
        Walker::enumerate(root, &rules, &gitignore, None).expect("walker enumerate must succeed");
    let rust_pairs: BTreeSet<(String, String)> = observations
        .into_iter()
        .map(|observation| (observation.normalized_uri, observation.content_hash))
        .collect();

    assert_eq!(
        rust_pairs, oracle_pairs,
        "Rust Walker and the TS DirectorySourceProvider oracle must observe the exact same (uri, content_hash) set"
    );

    // Sanity: the fixture's exclusions actually took effect on both sides,
    // so this test isn't vacuously comparing two empty sets.
    let uris: BTreeSet<&str> = rust_pairs.iter().map(|(uri, _)| uri.as_str()).collect();
    assert!(uris.contains("src/a.ts"));
    assert!(uris.contains("src/sub/b.ts"));
    assert!(uris.contains(".gitignore"));
    assert!(!uris.contains("src/img.png"));
    assert!(!uris.contains("src/withnul.bin"));
    assert!(!uris.iter().any(|uri| uri.starts_with("node_modules/")));
    assert!(!uris.contains("src/link.ts"));
}
