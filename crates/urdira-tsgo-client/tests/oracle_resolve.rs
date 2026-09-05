//! Cross-language oracle test for `ResidualResolver`: spawns the REAL tsgo
//! binary via `urdira_tsgo_client`, resolves a hand-picked set of sites
//! across two small fixtures, and compares the results against
//! `oracle/tsgo-oracle.mjs` — the real `typescript@7.0.2` async API client
//! (`typescript/unstable/async`) resolving the SAME sites through an
//! independently-written but semantically matching algorithm (see that
//! script's module doc for exactly how "matching" is achieved for each
//! site kind).
//!
//! This is the only test in the crate that exercises the full stack
//! end-to-end: binary discovery, process spawn, the JSON-RPC codec, virtual
//! FS callback dispatch, binary AST decoding, and `ResidualResolver`'s
//! resolution sequence, all against the real checker. Everything else is
//! unit-tested against hand-built data (see `src/*.rs`'s own `#[cfg(test)]`
//! modules) precisely so this one test's absence (no `node`/tsgo available)
//! does not leave the crate untested. C.4 (2026-09-05): `node` unavailable
//! stays a genuine skip (the independent oracle script needs it, unrelated
//! to this crate's own tsgo RPC path); tsgo unavailable is now
//! `#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]` +
//! `binary::discover_for_tests` (panics with guidance), never a silent
//! `ok`.
//!
//! Fixtures:
//! - `tests/fixtures/codebases/typescript/task-planner/src` (this repo's
//!   shared, read-only fixture — used here exactly as committed, never
//!   modified, since numerous other tests pin exact expectations against
//!   it): covers `identifier_ref` (a type annotation), `call` through an
//!   interface-typed field (structural dispatch via `getResolvedSignature`,
//!   crossing into a different file), and `heritage` (`implements`).
//! - `crates/urdira-tsgo-client/tests/fixtures/mini` (a tiny fixture local
//!   to this crate): covers `extends` (avoiding the shared fixture's own
//!   `extends Error`, which would require serving `lib.d.ts` content
//!   through the virtual FS), an aliased-import `call` resolving to an
//!   explicit `Constructor` declaration (exercising
//!   `constructor_keyword_start` and the `getResolvedSignature` path over
//!   the direct-declaration shortcut), and an aliased `identifier_ref`
//!   (exercising the alias-hop in `resolve_via_symbol`/`get_aliased_symbol`).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use serde_json::Value;
use urdira_tsgo_client::binary;
use urdira_tsgo_client::client::TsgoClient;
use urdira_tsgo_client::proto::UpdateSnapshotParams;
use urdira_tsgo_client::resolver::{PendingSite, ResidualResolver, Resolution, SiteKind};
use urdira_tsgo_client::virtual_fs::{MapFs, VirtualFs};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root should exist")
}

fn crate_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn node_available() -> bool {
    Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn oracle_script() -> PathBuf {
    crate_root().join("oracle/tsgo-oracle.mjs")
}

/// The exact `compilerOptions`/config shape both `oracle/tsgo-oracle.mjs`
/// and this test's own `updateSnapshot` call use — they must match, or the
/// two programs would be comparing resolutions from different projects.
fn config_json(root_names: &[String]) -> String {
    serde_json::json!({
        "compilerOptions": {
            "module": "NodeNext",
            "moduleResolution": "NodeNext",
            "target": "ES2022",
            "strict": false,
        },
        "files": root_names,
    })
    .to_string()
}

const VIRTUAL_ROOT: &str = "/workspace";
const CONFIG_PATH: &str = "/workspace/__oracle_project__.json";

fn collect_ts_files(dir: &Path, base: &Path, fs: &mut MapFs, root_names: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).expect("fixture dir should be readable") {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.is_dir() {
            collect_ts_files(&path, base, fs, root_names);
        } else if path.extension().is_some_and(|ext| ext == "ts") {
            let rel = path
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let virtual_path = format!("{VIRTUAL_ROOT}/{rel}");
            let content =
                std::fs::read_to_string(&path).expect("fixture file should be readable UTF-8");
            fs.insert(virtual_path.clone(), content);
            root_names.push(virtual_path);
        }
    }
}

/// Builds the virtual filesystem + root file list for `source_dir`, exactly
/// mirroring `oracle/tsgo-oracle.mjs`'s own fixture loading (same virtual
/// paths, same synthetic `package.json`, same project config path/content).
fn build_fixture(source_dir: &Path) -> (MapFs, Vec<String>) {
    let mut fs = MapFs::new();
    let mut root_names = Vec::new();
    collect_ts_files(source_dir, source_dir, &mut fs, &mut root_names);
    root_names.sort();
    fs.insert(
        format!("{VIRTUAL_ROOT}/package.json"),
        r#"{"type":"module"}"#,
    );
    fs.insert(CONFIG_PATH, config_json(&root_names));
    (fs, root_names)
}

/// Finds the UTF-16 `[start, end)` span of the `occurrence`-th (1-based)
/// occurrence of `needle` in `text`. Panics (test setup error, not a
/// resolution failure) if there are fewer than `occurrence` occurrences.
fn find_utf16_span(text: &str, needle: &str, occurrence: usize) -> (i32, i32) {
    let mut search_from = 0usize;
    let mut byte_start = None;
    for _ in 0..occurrence {
        let found = text[search_from..].find(needle).unwrap_or_else(|| {
            panic!("occurrence {occurrence} of {needle:?} not found in fixture text (only found up to the previous one)")
        });
        let absolute = search_from + found;
        byte_start = Some(absolute);
        search_from = absolute + needle.len();
    }
    let byte_start = byte_start.unwrap();
    let utf16_start = text[..byte_start].encode_utf16().count() as i32;
    let utf16_len = needle.encode_utf16().count() as i32;
    (utf16_start, utf16_start + utf16_len)
}

struct OracleSite {
    file: &'static str,
    kind: SiteKind,
    search_text: &'static str,
    /// For `identifier_ref`/`heritage`: a narrower substring (searched for
    /// starting at `search_text`'s position) pinning this crate's own
    /// `PendingSite` span — mirrors the oracle script's `symbolAnchor`.
    /// `None` reuses `search_text` itself as the span (already narrow
    /// enough, e.g. a bare identifier).
    symbol_anchor: Option<&'static str>,
    occurrence: usize,
}

fn json_kind(kind: SiteKind) -> &'static str {
    match kind {
        SiteKind::IdentifierRef => "identifier_ref",
        SiteKind::Call => "call",
        SiteKind::Heritage => "heritage",
    }
}

fn sites_json(sites: &[OracleSite]) -> Value {
    Value::Array(
        sites
            .iter()
            .map(|s| {
                let mut obj = serde_json::json!({
                    "file": s.file,
                    "kind": json_kind(s.kind),
                    "searchText": s.search_text,
                    "occurrence": s.occurrence,
                });
                if let Some(anchor) = s.symbol_anchor {
                    obj["symbolAnchor"] = Value::String(anchor.to_string());
                }
                obj
            })
            .collect(),
    )
}

fn run_oracle(source_dir: &Path, sites: &[OracleSite]) -> Vec<Value> {
    let sites_path = std::env::temp_dir().join(format!(
        "urdira-tsgo-oracle-sites-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    {
        let mut file = std::fs::File::create(&sites_path).unwrap();
        file.write_all(
            serde_json::to_string(&sites_json(sites))
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
    }
    let output = Command::new("node")
        .current_dir(repo_root())
        .arg(oracle_script())
        .arg(source_dir)
        .arg(&sites_path)
        .output()
        .expect("spawning node for the oracle script should not fail");
    let _ = std::fs::remove_file(&sites_path);
    assert!(
        output.status.success(),
        "oracle script exited with failure:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let parsed: Value = serde_json::from_slice(&output.stdout).unwrap_or_else(|e| {
        panic!(
            "oracle script did not print valid JSON: {e}\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    });
    parsed
        .as_array()
        .expect("oracle script prints a JSON array")
        .clone()
}

/// Runs `sites` (this crate's `ResidualResolver`) against `source_dir` and
/// returns one `Resolution` per site, alongside the oracle's own JSON
/// results for the same sites — both computed from independently-derived
/// spans/positions over the identical fixture text.
///
/// C.4 (2026-09-05): the tsgo binary is required (`binary::
/// discover_for_tests` panics with guidance if missing -- callers carry
/// `#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]`); `node`
/// on `PATH` (for the independent oracle script) stays a genuine skip --
/// unrelated to tsgo discovery, out of this hygiene item's scope.
fn resolve_and_compare(source_dir: &Path, oracle_sites: &[OracleSite]) {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let tsgo = binary::discover_for_tests(&repo_root());

    let (fs, root_names) = build_fixture(source_dir);
    let fs: Arc<dyn VirtualFs> = Arc::new(fs);

    let mut client = match TsgoClient::spawn(&tsgo, VIRTUAL_ROOT, Arc::clone(&fs)) {
        Ok(c) => c,
        Err(e) => panic!("failed to spawn tsgo: {e}"),
    };
    client.initialize().expect("initialize should succeed");
    let snapshot = client
        .update_snapshot(&UpdateSnapshotParams {
            open_projects: vec![CONFIG_PATH.to_string()],
            ..Default::default()
        })
        .expect("updateSnapshot should succeed");
    let opened_project = snapshot
        .projects
        .iter()
        .find(|p| p.config_file_name == CONFIG_PATH)
        .unwrap_or_else(|| {
            panic!(
                "tsgo did not open a project for {CONFIG_PATH}; projects: {:?}",
                snapshot.projects
            )
        });
    // Sanity check: every root file this test fed in should show up in the
    // project tsgo actually built (catches a fixture-loading bug early,
    // with a clearer message than a downstream "declaration file not in
    // project").
    for root in &root_names {
        assert!(
            opened_project.root_files.contains(root),
            "expected {root} among the project's root files: {:?}",
            opened_project.root_files
        );
    }
    let project = opened_project.id.clone();

    let owner_texts: std::collections::HashMap<&str, String> = oracle_sites
        .iter()
        .map(|s| s.file)
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .map(|file| {
            let virtual_path = format!("{VIRTUAL_ROOT}/{file}");
            let text = fs
                .read_file(&virtual_path)
                .unwrap_or_else(|| panic!("fixture file missing from virtual FS: {virtual_path}"));
            (file, text)
        })
        .collect();

    let pending_sites: Vec<PendingSite> = oracle_sites
        .iter()
        .map(|s| {
            let text = &owner_texts[s.file];
            let (span_start, span_end) = find_utf16_span(text, s.search_text, s.occurrence);
            let (start, end) = match s.symbol_anchor {
                // A call's `PendingSite` span is always the whole call
                // expression (`descend_to_span` needs the full span to land
                // on the call node); an anchor narrower than that is only
                // meaningful for identifier_ref/heritage, where the
                // resolver's span must exactly match one identifier.
                None => (span_start, span_end),
                Some(anchor) => {
                    // Search for the anchor starting from the span's own
                    // byte offset (not the file start), mirroring the
                    // oracle script's `text.indexOf(anchorText, spanStart)`.
                    let span_byte = byte_offset_of_utf16(text, span_start);
                    let rel = text[span_byte..].find(anchor).unwrap_or_else(|| {
                        panic!("anchor {anchor:?} not found from span start in {}", s.file)
                    });
                    let abs_byte = span_byte + rel;
                    let utf16_start = text[..abs_byte].encode_utf16().count() as i32;
                    let utf16_len = anchor.encode_utf16().count() as i32;
                    (utf16_start, utf16_start + utf16_len)
                }
            };
            PendingSite {
                owner_path: format!("{VIRTUAL_ROOT}/{}", s.file),
                start,
                end,
                kind: s.kind,
                reason: format!("{}:{}:{}", s.file, s.search_text, s.occurrence),
            }
        })
        .collect();

    let oracle_results = run_oracle(source_dir, oracle_sites);
    assert_eq!(oracle_results.len(), pending_sites.len());

    let mut resolver = ResidualResolver::new(&client, Arc::clone(&fs), snapshot.snapshot, project);
    let resolutions = resolver.resolve(&pending_sites);
    assert_eq!(resolutions.len(), pending_sites.len());

    for (index, (resolution, oracle)) in resolutions.iter().zip(oracle_results.iter()).enumerate() {
        let site = &oracle_sites[index];
        let oracle_error = oracle.get("error").and_then(Value::as_str);
        match resolution {
            Resolution::Resolved(resolved) => {
                assert!(
                    oracle_error.is_none(),
                    "site {index} ({}:{}): urdira-tsgo-client resolved {resolved:?} but the oracle failed: {oracle_error:?}",
                    site.file,
                    site.search_text
                );
                let oracle_path = oracle.get("path").and_then(Value::as_str).unwrap();
                let oracle_name_start = oracle
                    .get("nameIdentifierStart")
                    .and_then(Value::as_i64)
                    .unwrap() as i32;
                let oracle_decl_start =
                    oracle.get("declStart").and_then(Value::as_i64).unwrap() as i32;
                let oracle_decl_end = oracle.get("declEnd").and_then(Value::as_i64).unwrap() as i32;
                assert_eq!(
                    resolved.path, oracle_path,
                    "site {index} ({}:{}): path mismatch",
                    site.file, site.search_text
                );
                assert_eq!(
                    resolved.name_identifier_start, oracle_name_start,
                    "site {index} ({}:{}): name-identifier start mismatch",
                    site.file, site.search_text
                );
                assert_eq!(
                    resolved.decl_start, oracle_decl_start,
                    "site {index} ({}:{}): decl start mismatch",
                    site.file, site.search_text
                );
                assert_eq!(
                    resolved.decl_end, oracle_decl_end,
                    "site {index} ({}:{}): decl end mismatch",
                    site.file, site.search_text
                );
            }
            Resolution::Unresolved { reason } => {
                panic!(
                    "site {index} ({}:{}): urdira-tsgo-client failed to resolve ({reason}); oracle result: {oracle:?}",
                    site.file, site.search_text
                );
            }
        }
    }

    let status = client
        .shutdown()
        .expect("tsgo should exit cleanly after stdin closes");
    assert!(status.success(), "tsgo exited with {status:?}");
}

/// Converts a UTF-16 offset back to a byte offset into `text`, for anchor
/// re-searches that must start at a specific UTF-16 position. `text` is
/// ASCII in every fixture this test uses, so this is a direct char-count
/// walk rather than anything UTF-16-surrogate-aware.
fn byte_offset_of_utf16(text: &str, utf16_offset: i32) -> usize {
    let mut remaining = utf16_offset;
    for (byte_index, ch) in text.char_indices() {
        if remaining <= 0 {
            return byte_index;
        }
        remaining -= ch.len_utf16() as i32;
    }
    text.len()
}

#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn oracle_resolve_task_planner_sites() {
    let source_dir = repo_root().join("tests/fixtures/codebases/typescript/task-planner/src");
    let sites = [
        OracleSite {
            file: "services/task-service.ts",
            kind: SiteKind::IdentifierRef,
            search_text: "TaskRepository",
            symbol_anchor: None,
            occurrence: 2,
        },
        OracleSite {
            file: "services/task-service.ts",
            kind: SiteKind::Call,
            search_text: "this.repository.findById(taskId)",
            symbol_anchor: None,
            occurrence: 1,
        },
        OracleSite {
            file: "services/task-service.ts",
            kind: SiteKind::Call,
            search_text: "this.repository.save(updated)",
            symbol_anchor: None,
            occurrence: 1,
        },
        OracleSite {
            file: "services/task-service.ts",
            kind: SiteKind::Call,
            search_text: "this.repository.create(id, { ...input, title })",
            symbol_anchor: None,
            occurrence: 1,
        },
        OracleSite {
            file: "repository/in-memory-task-repository.ts",
            kind: SiteKind::Heritage,
            search_text: "implements TaskRepository",
            symbol_anchor: Some("TaskRepository"),
            occurrence: 1,
        },
        OracleSite {
            file: "main.ts",
            kind: SiteKind::Call,
            search_text: "new TaskService(repository)",
            symbol_anchor: None,
            occurrence: 1,
        },
    ];
    resolve_and_compare(&source_dir, &sites);
}

#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn oracle_resolve_mini_alias_and_constructor_sites() {
    let source_dir = crate_root().join("tests/fixtures/mini");
    let sites = [
        OracleSite {
            file: "derived.ts",
            kind: SiteKind::Heritage,
            search_text: "extends Base",
            symbol_anchor: Some("Base"),
            occurrence: 1,
        },
        OracleSite {
            file: "main.ts",
            kind: SiteKind::Call,
            search_text: "new AliasedBase(\"hello\")",
            symbol_anchor: None,
            occurrence: 1,
        },
        OracleSite {
            file: "main.ts",
            kind: SiteKind::IdentifierRef,
            search_text: "AliasedBase.name",
            symbol_anchor: Some("AliasedBase"),
            occurrence: 1,
        },
    ];
    resolve_and_compare(&source_dir, &sites);
}
