//! Perf smoke test for task P1-D-b (the full residual-pass runner: windows,
//! lanes, lib resolution, entity-id-ready output), over a realistic
//! multi-window corpus slice. `#[ignore]`d: run with
//!
//! ```sh
//! cargo test -p urdira-tsgo-client --test bench_residual_pass -- --ignored --nocapture
//! ```
//!
//! Unlike `tests/bench_tsgo.rs` (P1-D-a's single-window, single-lane smoke
//! test), this bench exercises the actual multi-window, multi-lane shape a
//! production residual pass would run: the first 2,000 sorted `.ts`/`.tsx`/
//! `.js` files under the n8n corpus's `packages/` directory (skipping the
//! usual noise directories), built into `WindowPlan::DEFAULT_WINDOW_SIZE`
//! (512-file) windows, resolved once with `lanes = 1` and once with
//! `lanes = 6` for a side-by-side comparison. Pending sites come from the
//! real P0/E1a-vs-checker census JSON when available (real `call`/
//! `heritage` sites with real reasons, e.g. `call_deferred_to_e3` —
//! confirmed `checker_pending` sites the Node/Rust hybrid pipeline actually
//! produced against this exact corpus), falling back to a synthetic
//! `\.\w+\(`-shaped scan (`find_dot_word_call_sites`, no `regex` dependency
//! — same reasoning as `bench_tsgo.rs`'s own `find_member_call_sites`) when
//! the census file is not present.
//!
//! Skips (printing why), rather than failing, when: the n8n corpus is not
//! present at its expected benchmark path, the tsgo binary is not
//! discoverable, or a known heavier benchmark process
//! (`v4-scan`/`n8n-incremental-preflight`) is currently running on this
//! machine — this bench is CPU/RSS-heavy enough (6 child tsgo processes for
//! the `lanes = 6` run) that sharing the machine with another benchmark
//! would contaminate both.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use serde_json::Value;
use urdira_tsgo_client::binary::{self, TsgoBinary};
use urdira_tsgo_client::residual_pass::{
    ResidualPass, ResidualPassConfig, SiteOutcome, WindowPlan, WindowStats,
};
use urdira_tsgo_client::resolver::{PendingSite, SiteKind};
use urdira_tsgo_client::virtual_fs::{MapFs, VirtualFs};

const VIRTUAL_ROOT: &str = "/workspace";
const CONFIG_PATH: &str = "/workspace/__residual_pass_bench__.json";
const OWNER_CUT: usize = 2000;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root should exist")
}

fn n8n_corpus_root() -> Option<PathBuf> {
    let candidate = Path::new("/Users/Cristian/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02");
    candidate.is_dir().then(|| candidate.to_path_buf())
}

fn census_path() -> PathBuf {
    PathBuf::from(
        "/Users/Cristian/Proyectos/urdira/.claude/worktrees/agent-adf2ed2e11c2fffb4/tmp-census.json",
    )
}

/// A known heavier benchmark/scan process sharing the machine would
/// contaminate this bench's timings (and this bench's own 6-lane run would
/// contaminate that other process's numbers right back) — skip rather than
/// run blind, matching the task brief's own operational rule.
fn heavier_benchmark_running() -> bool {
    Command::new("pgrep")
        .arg("-f")
        .arg("v4-scan|n8n-incremental-preflight")
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
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

/// Collects up to `limit` `.ts`/`.tsx`/`.js` files under `root`, in
/// deterministic (sorted) order, skipping the usual noise directories —
/// same policy as `tests/bench_tsgo.rs`'s own `collect_window`, extended to
/// `.js` (the task's "2,000-owner cut" spans all three extensions) and to
/// walk breadth calmly (a `Vec`-backed stack, no recursion depth surprises
/// on a corpus this deep).
fn collect_owner_cut(root: &Path, limit: usize) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if path.is_dir() {
                if matches!(
                    name.as_ref(),
                    "node_modules" | ".git" | "dist" | "build" | "coverage"
                ) {
                    continue;
                }
                stack.push(path);
            } else if path
                .extension()
                .is_some_and(|ext| ext == "ts" || ext == "tsx" || ext == "js")
            {
                files.push(path);
            }
        }
    }
    files.sort();
    files.truncate(limit);
    files
}

fn is_ident_part(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// Finds `.` + one-or-more word characters + `(` occurrences in `text`
/// (byte string; this scans ASCII-only, sufficient for load generation over
/// real corpus source) — the same shape `\.\w+\(` names, without adding a
/// `regex` dependency (this crate's own established convention; see
/// `bench_tsgo.rs`'s `find_member_call_sites` doc comment for the identical
/// reasoning). Spans are `[start, end)` UTF-16 offsets ending right at the
/// `(`, which — as established in `crate::node`'s `descend_to_span` doc
/// comment — still lands on the enclosing `CallExpression`/property-access
/// callee: fine for load generation, not a claim of well-formedness.
fn find_dot_word_call_sites(utf8: &[u8], utf16_len_before: &[i32], cap: usize) -> Vec<(i32, i32)> {
    let mut sites = Vec::new();
    let mut i = 0usize;
    let len = utf8.len();
    while i < len && sites.len() < cap {
        if utf8[i] != b'.' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        if j < len && (utf8[j].is_ascii_alphabetic() || utf8[j] == b'_') {
            while j < len && is_ident_part(utf8[j]) {
                j += 1;
            }
            if j < len && utf8[j] == b'(' {
                sites.push((utf16_len_before[i], utf16_len_before[j + 1]));
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    sites
}

/// Precomputes, for every BYTE offset in `text`, the UTF-16 code unit
/// length of everything before it — lets `find_dot_word_call_sites` convert
/// its byte-offset matches to UTF-16 spans in O(1) per match instead of
/// re-walking the string.
fn utf16_len_before_each_byte(text: &str) -> Vec<i32> {
    let mut out = vec![0i32; text.len() + 1];
    let mut utf16_len = 0i32;
    for (byte_index, ch) in text.char_indices() {
        out[byte_index] = utf16_len;
        utf16_len += ch.len_utf16() as i32;
        for offset in 1..ch.len_utf8() {
            out[byte_index + offset] = utf16_len; // mid-codepoint byte offsets are never matched, but keep the array total
        }
    }
    out[text.len()] = utf16_len;
    out
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[rank.min(sorted.len() - 1)]
}

struct CensusSite {
    path: String,
    start: i32,
    end: i32,
    kind: SiteKind,
    reason: String,
}

/// Loads real `checker_pending` sites from the P0/E1a-vs-checker census
/// JSON (`URDIRA_JSTS_TYPEFLOW_ORACLE_OUT`'s own shape — see
/// `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`'s reason
/// constants for what these `reason` strings mean), if the file is present
/// and parses. Only `calls.checker_confirmed_rust_pending_samples`
/// (`SiteKind::Call`) and `heritage.checker_confirmed_rust_pending_samples`
/// (`SiteKind::Heritage`) are used — the two sample arrays that are
/// themselves lists of real pending sites (`{path, start, end, reason}`),
/// as opposed to this census's many other fields, which are pure counts/
/// histograms (see `docs/evidence/2026-09-03-v4-p1d-b-residual-pass.md` §4
/// for the full shape as read). Returns `None` if the file is missing or
/// not shaped as expected — the caller falls back to synthetic sites.
fn load_census_sites() -> Option<Vec<CensusSite>> {
    let text = std::fs::read_to_string(census_path()).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    let mut sites = Vec::new();
    for (key, kind) in [("calls", SiteKind::Call), ("heritage", SiteKind::Heritage)] {
        let samples = json
            .get(key)
            .and_then(|v| v.get("checker_confirmed_rust_pending_samples"))
            .and_then(Value::as_array);
        let Some(samples) = samples else { continue };
        for sample in samples {
            let (Some(path), Some(start), Some(end)) = (
                sample.get("path").and_then(Value::as_str),
                sample.get("start").and_then(Value::as_i64),
                sample.get("end").and_then(Value::as_i64),
            ) else {
                continue;
            };
            let reason = sample
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("census")
                .to_string();
            sites.push(CensusSite {
                path: path.to_string(),
                start: start as i32,
                end: end as i32,
                kind,
                reason,
            });
        }
    }
    (!sites.is_empty()).then_some(sites)
}

#[test]
#[ignore]
fn bench_residual_pass_over_a_2000_owner_window_plan() {
    if heavier_benchmark_running() {
        eprintln!(
            "skipping: a heavier benchmark (v4-scan / n8n-incremental-preflight) is running \
             on this machine"
        );
        return;
    }
    let Some(corpus_root) = n8n_corpus_root() else {
        eprintln!("skipping: n8n corpus not present at the expected benchmark path");
        return;
    };
    // C.4: a bench genuinely missing its own corpus/heavier-benchmark
    // preconditions above still SKIPS -- those are real, unrelated
    // opt-outs. tsgo itself is required once we get this far: PANIC (with
    // guidance) rather than silently skip, matching every other test in
    // this crate.
    let tsgo = binary::discover_for_tests(&repo_root());

    let owner_files = collect_owner_cut(&corpus_root, OWNER_CUT);
    assert!(
        !owner_files.is_empty(),
        "expected at least one source file in the n8n corpus"
    );
    println!(
        "owner cut: {} files (target {OWNER_CUT})",
        owner_files.len()
    );

    let mut fs = MapFs::new();
    let mut root_names = Vec::with_capacity(owner_files.len());
    let mut owner_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut texts: Vec<(String, String)> = Vec::with_capacity(owner_files.len());
    for path in &owner_files {
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        let rel = path
            .strip_prefix(&corpus_root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let virtual_path = format!("{VIRTUAL_ROOT}/{rel}");
        fs.insert(virtual_path.clone(), content.clone());
        root_names.push(virtual_path.clone());
        owner_set.insert(virtual_path.clone());
        texts.push((virtual_path, content));
    }
    root_names.sort();
    let fs: std::sync::Arc<dyn VirtualFs> = std::sync::Arc::new(fs);

    let plan = WindowPlan::build(&root_names, WindowPlan::DEFAULT_WINDOW_SIZE);
    println!(
        "window plan: {} windows of up to {} roots",
        plan.windows.len(),
        WindowPlan::DEFAULT_WINDOW_SIZE
    );

    // Pending sites: real census sites filtered to this run's owner cut, or
    // a synthetic `\.\w+\(` scan (20 sites/file cap) when the census is not
    // available / yields nothing in this cut.
    let mut pending_by_owner: BTreeMap<String, Vec<PendingSite>> = BTreeMap::new();
    let mut source = "synthetic";
    if let Some(census_sites) = load_census_sites() {
        let mut matched = 0usize;
        for site in census_sites {
            let owner_path = format!("{VIRTUAL_ROOT}/{}", site.path);
            if !owner_set.contains(&owner_path) {
                continue;
            }
            matched += 1;
            pending_by_owner
                .entry(owner_path.clone())
                .or_default()
                .push(PendingSite {
                    owner_path,
                    start: site.start,
                    end: site.end,
                    kind: site.kind,
                    reason: site.reason,
                });
        }
        if matched > 0 {
            source = "census";
        }
    }
    if pending_by_owner.is_empty() {
        const PER_FILE_CAP: usize = 20;
        for (owner_path, text) in &texts {
            let utf16_len_before = utf16_len_before_each_byte(text);
            let sites = find_dot_word_call_sites(text.as_bytes(), &utf16_len_before, PER_FILE_CAP);
            if sites.is_empty() {
                continue;
            }
            let entry = pending_by_owner.entry(owner_path.clone()).or_default();
            for (start, end) in sites {
                entry.push(PendingSite {
                    owner_path: owner_path.clone(),
                    start,
                    end,
                    kind: SiteKind::Call,
                    reason: "bench_synthetic".to_string(),
                });
            }
        }
    }
    let total_sites: usize = pending_by_owner.values().map(Vec::len).sum();
    println!(
        "pending sites: {total_sites} across {} owners (source: {source})",
        pending_by_owner.len()
    );
    assert!(total_sites >= 100, "expected at least 100 pending sites");

    let lib_roots = vec![lib_root_dir(&tsgo)];
    let config = ResidualPassConfig {
        binary: tsgo,
        root: VIRTUAL_ROOT.to_string(),
        project_config_path: CONFIG_PATH.to_string(),
        compiler_options: compiler_options(),
        fetch_semantics: false,
        deadline: None,
        lib_roots,
    };

    for lanes in [1usize, 6usize] {
        println!("\n=== lanes = {lanes} ===");
        let start = Instant::now();
        let (results, stats) = ResidualPass::run_instrumented(
            &plan,
            lanes,
            &pending_by_owner,
            std::sync::Arc::clone(&fs),
            &config,
        )
        .unwrap_or_else(|e| panic!("residual pass failed (lanes={lanes}): {e}"));
        let wall_s = start.elapsed().as_secs_f64();

        let mut snapshot_ms: Vec<f64> = stats
            .windows
            .iter()
            .map(|w: &WindowStats| w.snapshot_ms)
            .collect();
        snapshot_ms.sort_by(|a, b| a.total_cmp(b));

        let mut rss_by_lane: BTreeMap<usize, u64> = BTreeMap::new();
        for window in &stats.windows {
            if let Some(kb) = window.child_rss_kb {
                rss_by_lane
                    .entry(window.lane)
                    .and_modify(|max| *max = (*max).max(kb))
                    .or_insert(kb);
            }
        }

        let mut workspace = 0usize;
        let mut external = 0usize;
        let mut unresolved = 0usize;
        for site in &results {
            match &site.outcome {
                SiteOutcome::WorkspaceTarget { .. } => workspace += 1,
                SiteOutcome::External { .. } => external += 1,
                SiteOutcome::Unresolved { .. } => unresolved += 1,
            }
        }

        println!("wall: {wall_s:.1} s");
        println!("windows opened: {}", stats.windows.len());
        println!(
            "snapshot ms: p50={:.1} p95={:.1} (n={})",
            percentile(&snapshot_ms, 50.0),
            percentile(&snapshot_ms, 95.0),
            snapshot_ms.len()
        );
        println!(
            "sites/s: {:.1} ({} sites resolved)",
            results.len() as f64 / wall_s,
            results.len()
        );
        for (lane, rss_kb) in &rss_by_lane {
            println!(
                "lane {lane} child RSS (max over its windows): {rss_kb} KB ({:.1} MB)",
                *rss_kb as f64 / 1024.0
            );
        }
        println!(
            "outcome histogram: workspace={workspace} external={external} unresolved={unresolved} \
             (of {} total)",
            results.len()
        );
    }
}
