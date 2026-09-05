//! P1-D-e: controlled, standalone reproductions of each of the four
//! hypotheses `docs/evidence/2026-09-04-v4-p1d-d-residual-diagnosis.md` §6
//! left open for the "stale node handle" `getSymbolsAtLocations` RPC error
//! (37% of n8n's residual-pass sites). Against the REAL tsgo binary. C.4
//! (2026-09-05): every test here is `#[ignore = "requires tsgo binary (set
//! URDIRA_TSGO_BINARY)"]` and calls `binary::discover_for_tests`, which
//! panics (with guidance) rather than silently skipping when the binary is
//! not discoverable. Each test is deliberately narrow (one hypothesis, one
//! minimal fixture) so a failure or pass here isolates a single mechanism
//! rather than reproducing the whole n8n corpus.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use urdira_tsgo_client::binary::{self, TsgoBinary};
use urdira_tsgo_client::residual_pass::{
    ResidualPass, ResidualPassConfig, SiteOutcome, WindowPlan,
};
use urdira_tsgo_client::resolver::{PendingSite, SiteKind};
use urdira_tsgo_client::virtual_fs::{MapFs, VirtualFs};

const VIRTUAL_ROOT: &str = "/workspace";
const CONFIG_PATH: &str = "/workspace/__hypothesis_repro__.json";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root should exist")
}

fn lib_root_dir(binary: &TsgoBinary) -> String {
    binary
        .path
        .parent()
        .expect("tsgo binary path should have a parent directory")
        .to_string_lossy()
        .replace('\\', "/")
}

fn compiler_options() -> serde_json::Value {
    serde_json::json!({
        "module": "ESNext",
        "moduleResolution": "Bundler",
        "target": "ES2022",
        "strict": false,
        "skipLibCheck": true,
    })
}

fn find_utf16_span(text: &str, needle: &str, occurrence: usize) -> (i32, i32) {
    let mut search_from = 0usize;
    let mut byte_start = None;
    for _ in 0..occurrence {
        let found = text[search_from..].find(needle).unwrap_or_else(|| {
            panic!(
                "occurrence {occurrence} of {needle:?} not found in fixture text (only found up \
                 to the previous one)"
            )
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

/// Hypothesis A: tsgo lowercases absolute paths in declaration/lookup
/// handles on this case-insensitive host filesystem, so a PascalCase-named
/// owner file (n8n's own convention, e.g. `HttpRequest.node.ts`) might have
/// its OWN identity mismatched between the `getSourceFile` call (which
/// succeeds and returns node indices) and the subsequent
/// `getSymbolsAtLocations` batched call using a `NodeHandle` built from the
/// SAME (real-case) owner path string. If tsgo canonicalizes the owner path
/// to lowercase internally on `getSourceFile`, but the handle we send later
/// is real-case, "file may not be loaded" would be the naturally expected
/// error for exactly this mismatch.
#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn pascal_case_owner_file_single_site_does_not_produce_rpc_error() {
    let tsgo = binary::discover_for_tests(&repo_root());
    let mut fs = MapFs::new();
    let owner = format!("{VIRTUAL_ROOT}/HttpRequest.node.ts");
    let text = "export function run(): number {\n  return [1, 2].map((n) => n).length;\n}\n";
    fs.insert(owner.clone(), text);
    fs.insert(
        format!("{VIRTUAL_ROOT}/package.json"),
        r#"{"type":"module"}"#,
    );
    let fs: Arc<dyn VirtualFs> = Arc::new(fs);

    let plan = WindowPlan::build(std::slice::from_ref(&owner), 512);
    let (start, end) = find_utf16_span(text, "[1, 2].map((n) => n)", 1);
    let pending_by_owner = BTreeMap::from([(
        owner.clone(),
        vec![PendingSite {
            owner_path: owner.clone(),
            start,
            end,
            kind: SiteKind::Call,
            reason: "pascal_case_owner".to_string(),
        }],
    )]);

    let config = ResidualPassConfig {
        lib_roots: vec![lib_root_dir(&tsgo)],
        binary: tsgo,
        root: VIRTUAL_ROOT.to_string(),
        project_config_path: CONFIG_PATH.to_string(),
        compiler_options: compiler_options(),
        fetch_semantics: false,
        deadline: None,
    };
    let results = ResidualPass::run(&plan, 1, &pending_by_owner, fs, &config)
        .expect("residual pass should succeed at the pass level");
    assert_eq!(results.len(), 1);
    if let SiteOutcome::Unresolved { reason } = &results[0].outcome {
        assert!(
            !reason.contains("getSymbolsAtLocations failed"),
            "PascalCase owner file alone should not trigger the RPC error; got: {reason}"
        );
    } // Resolved (External/WorkspaceTarget) is the expected/healthy outcome.
}

/// Hypothesis D: an owner file that is a window root (every jsts source file
/// is always a root per `residual.rs::run_once_with_quiet_period`) but is
/// NOT imported by anything else, and is not itself the entry of any import
/// chain, still gets its pending sites resolved -- module resolution should
/// still see it because it is present in `files:` for its own window.
#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn unimported_owner_with_pending_sites_still_resolves() {
    let tsgo = binary::discover_for_tests(&repo_root());
    let owner = format!("{VIRTUAL_ROOT}/orphan.test.ts");
    let text = "export function check(): number {\n  return [1, 2].map((n) => n).length;\n}\n";

    // Two windows, window_size=1: the orphan is the ONLY root of its own
    // window -- nothing else references it, and it references nothing else.
    let other = format!("{VIRTUAL_ROOT}/unrelated.ts");
    let mut fs2 = MapFs::new();
    fs2.insert(owner.clone(), text);
    fs2.insert(other.clone(), "export const x = 1;\n");
    fs2.insert(
        format!("{VIRTUAL_ROOT}/package.json"),
        r#"{"type":"module"}"#,
    );
    let fs2: Arc<dyn VirtualFs> = Arc::new(fs2);

    let plan = WindowPlan::build(&[other.clone(), owner.clone()], 1);
    assert_eq!(plan.windows.len(), 2);
    let (start, end) = find_utf16_span(text, "[1, 2].map((n) => n)", 1);
    let pending_by_owner = BTreeMap::from([(
        owner.clone(),
        vec![PendingSite {
            owner_path: owner.clone(),
            start,
            end,
            kind: SiteKind::Call,
            reason: "unimported_owner".to_string(),
        }],
    )]);

    let config = ResidualPassConfig {
        lib_roots: vec![lib_root_dir(&tsgo)],
        binary: tsgo,
        root: VIRTUAL_ROOT.to_string(),
        project_config_path: CONFIG_PATH.to_string(),
        compiler_options: compiler_options(),
        fetch_semantics: false,
        deadline: None,
    };
    let results = ResidualPass::run(&plan, 1, &pending_by_owner, fs2, &config)
        .expect("residual pass should succeed");
    assert_eq!(results.len(), 1);
    match &results[0].outcome {
        SiteOutcome::External { symbol_name, .. } => {
            assert_eq!(symbol_name, "map");
        }
        other => {
            panic!("expected the orphan file's own site to resolve as External, got {other:?}")
        }
    }
}

/// Hypothesis B: a resolver instance built for one window, whose owner
/// `RemoteSourceFile` was fetched against that window's snapshot, must not
/// be reused against a LATER snapshot (after `updateSnapshot` + `release`).
/// This test drives `TsgoClient`/`ResidualResolver` directly (bypassing
/// `ResidualPass::run_lane`'s own "fresh resolver per window" discipline)
/// to confirm that reusing a stale (superseded-snapshot) owner handle
/// produces exactly the "file may not be loaded or handle may be stale"
/// RPC error -- i.e. that this failure mode is real and reachable, not
/// hypothetical, even though `run_lane` itself does not do this.
#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn reusing_a_handle_from_a_released_snapshot_produces_the_stale_handle_error() {
    use urdira_tsgo_client::client::TsgoClient;
    use urdira_tsgo_client::node::NodeHandle;
    use urdira_tsgo_client::proto::{FileChanges, UpdateSnapshotParams};
    use urdira_tsgo_client::virtual_fs::OverlayFs;

    let tsgo = binary::discover_for_tests(&repo_root());
    let owner = format!("{VIRTUAL_ROOT}/a.ts");
    let text = "export function f(): number {\n  return [1, 2].map((n) => n).length;\n}\n";
    let mut base = MapFs::new();
    base.insert(owner.clone(), text);
    base.insert(
        format!("{VIRTUAL_ROOT}/package.json"),
        r#"{"type":"module"}"#,
    );
    let base: Arc<dyn VirtualFs> = Arc::new(base);
    let overlay = Arc::new(OverlayFs::new(base));
    let fs: Arc<dyn VirtualFs> = overlay.clone();

    let mut client = TsgoClient::spawn(&tsgo, VIRTUAL_ROOT, fs).expect("spawn should succeed");
    client.initialize().expect("initialize should succeed");

    let config_path = CONFIG_PATH.to_string();
    let compiler_options = compiler_options();

    let open_window =
        |client: &TsgoClient, overlay: &OverlayFs, prev: Option<u64>| -> (u64, String) {
            let config_json = serde_json::json!({
                "compilerOptions": compiler_options,
                "files": [owner.clone()],
            })
            .to_string();
            overlay.set(config_path.clone(), config_json);
            let params = UpdateSnapshotParams {
                open_projects: vec![config_path.clone()],
                file_changes: prev.map(|_| FileChanges::Summary {
                    changed: vec![config_path.clone()],
                    created: Vec::new(),
                    deleted: Vec::new(),
                }),
                ..Default::default()
            };
            let snapshot = client.update_snapshot(&params).expect("updateSnapshot");
            let project = snapshot
                .projects
                .iter()
                .find(|p| p.config_file_name == config_path)
                .expect("project should open")
                .id
                .clone();
            (snapshot.snapshot, project)
        };

    // Window 1.
    let (snapshot1, project1) = open_window(&client, &overlay, None);
    let source1 = client
        .get_source_file(snapshot1, &project1, &owner)
        .expect("getSourceFile should succeed")
        .expect("owner file should be part of the project");
    // Find the `map` call's callee identifier node index via descend_to_span.
    let (call_start, call_end) = find_utf16_span(text, "[1, 2].map((n) => n)", 1);
    let owner_text_utf16 = urdira_tsgo_client::trivia::to_utf16(text);
    let mut cursor = vec![1usize];
    let descended = source1.descend_to_span(&mut cursor, &owner_text_utf16, call_start, call_end);
    let handle = NodeHandle::new(descended as u32, source1.kind(descended), owner.clone());

    // Advance to window 2 (a no-op content-wise, but a NEW snapshot number)
    // and release window 1's snapshot -- mirrors `run_lane`'s own sequence
    // between windows.
    let (_snapshot2, _project2) = open_window(&client, &overlay, Some(snapshot1));
    client.release(snapshot1).expect("release should succeed");

    // Reuse the OLD (window 1) snapshot id + handle now that it has been
    // released -- this is the "stale handle" shape, driven directly rather
    // than relying on `ResidualPass` (which never does this).
    let result = client.get_symbols_at_locations(snapshot1, &project1, &[handle]);
    eprintln!("reused-after-release result: {result:?}");
    // Whatever the exact error shape, using a released snapshot must not
    // silently return a wrong-but-successful-looking symbol; it should
    // either error or return no symbol. This confirms the reachability of
    // "stale handle" as a real condition, matching the diagnosis's error
    // text family, without asserting a byte-exact message (server wording
    // is not part of this crate's contract).
    if let Ok(symbols) = &result {
        assert!(
            symbols.iter().all(|s| s.is_none()),
            "a released, superseded snapshot must not return a resolved symbol"
        );
    }

    let _ = client.shutdown();
}

/// Hypothesis C: a single owner file with a very large number of pending
/// sites (thousands of trivial call expressions, mirroring an n8n
/// `.test.ts` file dense with `vi.fn()`/`vi.mock()` calls) drives ONE
/// `getSymbolsAtLocations` batched request containing thousands of
/// `NodeHandle`s for the SAME just-fetched owner file. If tsgo has a
/// server-side per-request/per-file handle-table limit, this reproduces the
/// "stale handle" error directly and lets us read off the threshold.
#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn huge_single_owner_batch_of_ten_thousand_call_sites() {
    let tsgo = binary::discover_for_tests(&repo_root());
    const N: usize = 10_000;
    // Built directly (not re-scanned with `find_all_utf16_spans`, which is
    // O(n^2) and far too slow at N=10,000): every line has an identical
    // prefix (`function noop...`'s header line) followed by one `noop(i);\n`
    // per call, so each call's UTF-16 start offset is computed arithmetically.
    let header = "function noop(x: number): number { return x; }\n";
    let mut text = String::from(header);
    let mut spans = Vec::with_capacity(N);
    let mut utf16_pos = header.encode_utf16().count() as i32;
    for i in 0..N {
        let call_expr = format!("noop({i})"); // no trailing `;` -- that's the enclosing ExpressionStatement, not the CallExpression.
        let line = format!("{call_expr};\n");
        let call_len = call_expr.encode_utf16().count() as i32;
        spans.push((utf16_pos, utf16_pos + call_len));
        utf16_pos += line.encode_utf16().count() as i32;
        text.push_str(&line);
    }
    let owner = format!("{VIRTUAL_ROOT}/huge.test.ts");
    let mut fs = MapFs::new();
    fs.insert(owner.clone(), text.clone());
    fs.insert(
        format!("{VIRTUAL_ROOT}/package.json"),
        r#"{"type":"module"}"#,
    );
    let fs: Arc<dyn VirtualFs> = Arc::new(fs);

    let plan = WindowPlan::build(std::slice::from_ref(&owner), 512);
    let sites: Vec<PendingSite> = spans
        .into_iter()
        .enumerate()
        .map(|(i, (start, end))| PendingSite {
            owner_path: owner.clone(),
            start,
            end,
            kind: SiteKind::Call,
            reason: format!("huge_batch_{i}"),
        })
        .collect();
    assert_eq!(sites.len(), N, "expected exactly N call sites collected");
    let pending_by_owner = BTreeMap::from([(owner.clone(), sites)]);

    let config = ResidualPassConfig {
        lib_roots: vec![lib_root_dir(&tsgo)],
        binary: tsgo,
        root: VIRTUAL_ROOT.to_string(),
        project_config_path: CONFIG_PATH.to_string(),
        compiler_options: compiler_options(),
        fetch_semantics: false,
        deadline: None,
    };
    let results = ResidualPass::run(&plan, 1, &pending_by_owner, fs, &config)
        .expect("residual pass should succeed at the pass level");
    assert_eq!(results.len(), N);
    let rpc_error_count = results
        .iter()
        .filter(|r| matches!(&r.outcome, SiteOutcome::Unresolved { reason } if reason.contains("getSymbolsAtLocations failed")))
        .count();
    let resolved_count = results
        .iter()
        .filter(|r| matches!(&r.outcome, SiteOutcome::WorkspaceTarget { .. }))
        .count();
    eprintln!(
        "huge_single_owner_batch: {N} sites -> {resolved_count} resolved, {rpc_error_count} rpc_error"
    );
    let mut reasons: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for r in &results {
        if let SiteOutcome::Unresolved { reason } = &r.outcome {
            // Bucket by a stable prefix (strip the per-site `reason` suffix
            // in parens, which is unique per site and would otherwise make
            // every bucket size 1).
            let bucket = reason.split(" (").next().unwrap_or(reason).to_string();
            *reasons.entry(bucket).or_default() += 1;
        }
    }
    for (reason, count) in &reasons {
        eprintln!("  unresolved reason: {count:>6}  {reason}");
    }
    if let Some(first_unresolved) = results.iter().find_map(|r| match &r.outcome {
        SiteOutcome::Unresolved { reason } => Some(reason.clone()),
        _ => None,
    }) {
        eprintln!("  first unresolved reason (full): {first_unresolved}");
    }
    assert_eq!(
        rpc_error_count, 0,
        "a huge single-owner batch must not produce the stale-handle RPC error once chunking is \
         in place -- {rpc_error_count}/{N} sites failed"
    );
    assert_eq!(
        resolved_count, N,
        "every trivial `noop(i)` call site should resolve to `noop`'s own declaration"
    );
}

/// Exploratory: does an out-of-range (fabricated) `NodeHandle` mixed into
/// an otherwise-valid `getSymbolsAtLocations` batch reproduce the SAME
/// "could not be resolved (file may not be loaded or handle may be stale)"
/// error family the diagnosis observed, and does it poison the WHOLE batch
/// (not just the bad entry)? This directly probes whether that failure mode
/// is reachable via a fabricated-but-structurally-valid handle, informing
/// whether `ResidualResolver::fetch_symbols_chunked`'s per-location retry
/// is exercised by something concretely reproducible, not just theorized.
#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn out_of_range_handle_mixed_into_a_batch() {
    use urdira_tsgo_client::client::TsgoClient;
    use urdira_tsgo_client::node::NodeHandle;
    use urdira_tsgo_client::proto::UpdateSnapshotParams;

    let tsgo = binary::discover_for_tests(&repo_root());
    let owner = format!("{VIRTUAL_ROOT}/a.ts");
    let text = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";
    let config_json = serde_json::json!({
        "compilerOptions": compiler_options(),
        "files": [owner.clone()],
    })
    .to_string();
    let mut fs = MapFs::new();
    fs.insert(owner.clone(), text);
    fs.insert(
        format!("{VIRTUAL_ROOT}/package.json"),
        r#"{"type":"module"}"#,
    );
    fs.insert(CONFIG_PATH, config_json);
    let fs: Arc<dyn VirtualFs> = Arc::new(fs);
    let mut client = TsgoClient::spawn(&tsgo, VIRTUAL_ROOT, fs).expect("spawn should succeed");
    client.initialize().expect("initialize should succeed");
    let params = UpdateSnapshotParams {
        open_projects: vec![CONFIG_PATH.to_string()],
        ..Default::default()
    };
    let snapshot = client.update_snapshot(&params).expect("updateSnapshot");
    let project = snapshot
        .projects
        .iter()
        .find(|p| p.config_file_name == CONFIG_PATH)
        .expect("project should open")
        .id
        .clone();
    let source = client
        .get_source_file(snapshot.snapshot, &project, &owner)
        .expect("getSourceFile should succeed")
        .expect("owner should be part of the project");

    let (a_start, a_end) = find_utf16_span(text, "a", 1);
    let owner_text_utf16 = urdira_tsgo_client::trivia::to_utf16(text);
    let mut cursor = vec![1usize];
    let a_node = source.descend_to_span(&mut cursor, &owner_text_utf16, a_start, a_end);
    let good_handle = NodeHandle::new(a_node as u32, source.kind(a_node), owner.clone());
    let fabricated_handle = NodeHandle::new(999_999, source.kind(a_node), owner.clone());

    let mixed = vec![good_handle.clone(), fabricated_handle.clone()];
    let mixed_result = client.get_symbols_at_locations(snapshot.snapshot, &project, &mixed);
    eprintln!("mixed batch (good + fabricated) result: {mixed_result:?}");

    let good_alone = client.get_symbols_at_locations(snapshot.snapshot, &project, &[good_handle]);
    eprintln!("good handle alone (after mixed attempt): {good_alone:?}");

    let bad_alone =
        client.get_symbols_at_locations(snapshot.snapshot, &project, &[fabricated_handle]);
    eprintln!("fabricated handle alone: {bad_alone:?}");

    let _ = client.shutdown();
}

/// Follow-up to `huge_single_owner_batch_of_ten_thousand_call_sites`: that
/// test used N calls to the SAME single declaration. Live n8n evidence
/// (`docs/evidence/2026-09-04-v4-p1d-e-residual-rpc.md`) shows the residual
/// rpc_error bucket concentrated in large `.test.ts` files with MANY
/// DISTINCT declarations/symbols referenced (`describe`/`it`/`expect`/`vi`
/// call sites, each a different symbol), and multiple DIFFERENT node
/// indices in the SAME owner failing even when retried one-at-a-time. This
/// test probes whether crossing some number of DISTINCT symbols referenced
/// in one owner (not merely many call SITES) reproduces persistent,
/// individually-unrecoverable failures.
#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn many_distinct_declarations_referenced_once_each() {
    let tsgo = binary::discover_for_tests(&repo_root());
    const N: usize = 500;
    let mut text = String::new();
    for i in 0..N {
        text.push_str(&format!(
            "export function fn{i}(): number {{ return {i}; }}\n"
        ));
    }
    let mut spans = Vec::with_capacity(N);
    for i in 0..N {
        let name = format!("fn{i}");
        let (start, end) = find_utf16_span(&text, &format!("function {name}"), 1);
        // `find_utf16_span` finds "function fnN"; the identifier itself
        // starts 9 UTF-16 units after ("function " is 9 chars).
        spans.push((start + 9, end));
    }
    let owner = format!("{VIRTUAL_ROOT}/many_distinct.ts");
    let mut fs = MapFs::new();
    fs.insert(owner.clone(), text.clone());
    fs.insert(
        format!("{VIRTUAL_ROOT}/package.json"),
        r#"{"type":"module"}"#,
    );
    let fs: Arc<dyn VirtualFs> = Arc::new(fs);

    let plan = WindowPlan::build(std::slice::from_ref(&owner), 512);
    let sites: Vec<PendingSite> = spans
        .into_iter()
        .enumerate()
        .map(|(i, (start, end))| PendingSite {
            owner_path: owner.clone(),
            start,
            end,
            kind: SiteKind::IdentifierRef,
            reason: format!("distinct_{i}"),
        })
        .collect();
    assert_eq!(sites.len(), N);
    let pending_by_owner = BTreeMap::from([(owner.clone(), sites)]);

    let config = ResidualPassConfig {
        lib_roots: vec![lib_root_dir(&tsgo)],
        binary: tsgo,
        root: VIRTUAL_ROOT.to_string(),
        project_config_path: CONFIG_PATH.to_string(),
        compiler_options: compiler_options(),
        fetch_semantics: false,
        deadline: None,
    };
    let results = ResidualPass::run(&plan, 1, &pending_by_owner, fs, &config)
        .expect("residual pass should succeed at the pass level");
    assert_eq!(results.len(), N);
    let rpc_error_count = results
        .iter()
        .filter(|r| matches!(&r.outcome, SiteOutcome::Unresolved { reason } if reason.contains("getSymbolsAtLocations failed")))
        .count();
    let resolved_count = results
        .iter()
        .filter(|r| matches!(&r.outcome, SiteOutcome::WorkspaceTarget { .. }))
        .count();
    eprintln!(
        "many_distinct_declarations: {N} distinct decls -> {resolved_count} resolved, {rpc_error_count} rpc_error"
    );
    if rpc_error_count > 0 {
        let first_bad = results
            .iter()
            .find_map(|r| match &r.outcome {
                SiteOutcome::Unresolved { reason }
                    if reason.contains("getSymbolsAtLocations failed") =>
                {
                    Some(reason.clone())
                }
                _ => None,
            })
            .unwrap();
        eprintln!("  first rpc_error: {first_bad}");
    }
}

/// P1-D-g item 3: a live bisection of one real n8n `rpc_error` owner
/// (`docs/evidence/2026-09-05-v4-p1d-g-classification-and-build-failures.md`
/// §3 -- `.github/scripts/trim-fe-packageJson.js`, a plain CommonJS `.js`
/// utility script with no `.ts`/ESM syntax at all): a handful of top-level
/// `require('fs')`/`require('path')`/`resolve(...)` calls, EVERY ONE of
/// which failed with the exact diagnosed "node handle ... could not be
/// resolved (file may not be loaded or handle may be stale)" error on the
/// real corpus, including the LAST call in the file (`trimPackageJson(
/// 'frontend/editor-ui')`, a perfectly ordinary same-file function call with
/// nothing CommonJS-specific about it at all) -- ruling out "only the
/// `require(...)` calls themselves are the problem" as the mechanism.
/// Reproduces the SAME shape here: `allowJs`/`checkJs: true` (P1-D-f's own
/// fix, unconditionally on for every residual pass run since some owner in
/// the corpus is always a `.js` file), a `.js` (not `.ts`) owner, ambient
/// `require`/`module`/`exports` globals with NO `@types/node` served (this
/// corpus's own `node_modules`-free state, `virtual_fs.rs`'s documented
/// scope) -- and, critically, real-file-shaped MIXED content: some plain
/// global calls (`require`), a real cross-module use of a value the global
/// lookup can't resolve either way (`resolve`, `writeFileSync` -- also
/// ambient, unresolvable), AND a same-file, perfectly resolvable local
/// function call (`trimPackageJson(...)`) at the very end, exactly mirroring
/// the real file's own tail.
#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn commonjs_js_file_with_unresolvable_ambient_globals_and_a_trailing_local_call() {
    let tsgo = binary::discover_for_tests(&repo_root());
    let text = "\
const fs = require('fs');\n\
const path = require('path');\n\
const { resolve } = path;\n\
\n\
function trimPackageJson(packageName) {\n\
  const filePath = resolve(__dirname, packageName);\n\
  const packageJson = require(filePath);\n\
  fs.writeFileSync(filePath, JSON.stringify(packageJson));\n\
}\n\
\n\
trimPackageJson('frontend/@n8n/chat');\n\
trimPackageJson('frontend/@n8n/design-system');\n\
trimPackageJson('frontend/editor-ui');\n\
";
    let owner = format!("{VIRTUAL_ROOT}/trim-fe-packageJson.js");
    let mut fs = MapFs::new();
    fs.insert(owner.clone(), text);
    fs.insert(
        format!("{VIRTUAL_ROOT}/package.json"),
        r#"{"type":"commonjs"}"#,
    );
    let fs: Arc<dyn VirtualFs> = Arc::new(fs);

    // Every plain-identifier call site in the file, in source order -- the
    // exact same population `resolve_owner_group`'s direct-lookup shortcut
    // sends into one batched `getSymbolsAtLocations` request.
    let call_names = [
        ("require", 1),
        ("require", 2),
        ("resolve", 1),
        ("require", 3),
        ("trimPackageJson", 1),
        ("trimPackageJson", 2),
        ("trimPackageJson", 3),
    ];
    let sites: Vec<PendingSite> = call_names
        .iter()
        .enumerate()
        .map(|(i, (name, occurrence))| {
            let (start, end) = find_utf16_span(text, name, *occurrence);
            PendingSite {
                owner_path: owner.clone(),
                start,
                end,
                kind: SiteKind::Call,
                reason: format!("trim_fe_repro_{i}_{name}"),
            }
        })
        .collect();
    let pending_by_owner = BTreeMap::from([(owner.clone(), sites)]);

    let mut options = compiler_options();
    options["allowJs"] = serde_json::json!(true);
    options["checkJs"] = serde_json::json!(true);
    let config = ResidualPassConfig {
        lib_roots: vec![lib_root_dir(&tsgo)],
        binary: tsgo,
        root: VIRTUAL_ROOT.to_string(),
        project_config_path: CONFIG_PATH.to_string(),
        compiler_options: options,
        fetch_semantics: false,
        deadline: None,
    };
    let plan = WindowPlan::build(std::slice::from_ref(&owner), 512);
    let results = ResidualPass::run(&plan, 1, &pending_by_owner, fs, &config)
        .expect("residual pass should succeed at the pass level");
    for (result, (name, occurrence)) in results.iter().zip(call_names.iter()) {
        eprintln!("  {name}#{occurrence}: {:?}", result.outcome);
    }
    let rpc_error_count = results
        .iter()
        .filter(|r| matches!(&r.outcome, SiteOutcome::Unresolved { reason } if reason.contains("getSymbolsAtLocations failed")))
        .count();
    eprintln!(
        "commonjs_js_file repro: {}/{} sites hit the rpc_error shape",
        rpc_error_count,
        results.len()
    );
}
