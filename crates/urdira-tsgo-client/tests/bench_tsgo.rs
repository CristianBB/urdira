//! Perf smoke test for task P1-D-a (plan §... background residual pass over
//! a bounded root window). `#[ignore]`d: run with
//!
//! ```sh
//! cargo test -p urdira-tsgo-client --test bench_tsgo -- --ignored --nocapture
//! ```
//!
//! Spawns the real tsgo binary, opens a 512-file window read directly from
//! the n8n corpus
//! (`/Users/Cristian/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`,
//! read into the virtual FS — no real-disk fallback, matching production
//! usage), finds ~1,000 real `a.b(` member-access call sites across that
//! window by a plain character scan (no regex dependency — see
//! `find_member_call_sites`), and resolves them all through one
//! `ResidualResolver::resolve` call (the real usage shape: one call per
//! owner-file window, internally batched per file). Reports timings and
//! child RSS; skips (rather than fails) if the corpus or the tsgo binary
//! is not present, since this exercises scale, not correctness — that is
//! `tests/oracle_resolve.rs`'s job. Numbers from an actual run are recorded
//! in `docs/evidence/2026-09-03-v4-p1d-a-tsgo-client.md`, not asserted here
//! (a shared, possibly loaded dev machine makes a hard `assert!` on wall
//! time flaky).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Instant;

use urdira_tsgo_client::binary;
use urdira_tsgo_client::client::TsgoClient;
use urdira_tsgo_client::proto::UpdateSnapshotParams;
use urdira_tsgo_client::resolver::{PendingSite, ResidualResolver, Resolution, SiteKind};
use urdira_tsgo_client::virtual_fs::MapFs;

const WINDOW_SIZE: usize = 512;
const TARGET_SITES: usize = 1000;
const VIRTUAL_ROOT: &str = "/workspace";
const CONFIG_PATH: &str = "/workspace/__bench_project__.json";

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

/// Collects up to `WINDOW_SIZE` `.ts`/`.tsx` files under `root`, in a
/// deterministic (sorted) order, skipping the usual noise directories a
/// real workspace scan would also skip.
fn collect_window(root: &Path, limit: usize) -> Vec<PathBuf> {
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
                .is_some_and(|ext| ext == "ts" || ext == "tsx")
            {
                files.push(path);
            }
        }
    }
    files.sort();
    files.truncate(limit);
    files
}

fn is_ident_start(c: u16) -> bool {
    (c < 128 && (c as u8 as char).is_ascii_alphabetic()) || c == b'_' as u16 || c == b'$' as u16
}

fn is_ident_part(c: u16) -> bool {
    is_ident_start(c) || (c < 128 && (c as u8 as char).is_ascii_digit())
}

/// Finds `a.b(` occurrences (a bare member-access call: identifier, `.`,
/// identifier, `(`) in `text`, returning `[start, end)` UTF-16 spans where
/// `end` is just past the `(`. As established in this crate's `node.rs`
/// (`descend_to_span`'s containment check), a span that stops right at the
/// open paren — rather than the call's true matching close paren, which
/// this simple scan does not track — still lands `descend_to_span` on the
/// enclosing `CallExpression` node: neither the callee (ends before `(`)
/// nor any argument (starts after `(`) contains `[start, end)`, so the call
/// itself is the innermost containing node. Good enough for a synthetic
/// load-generation site list; not a claim that these are all real,
/// well-formed call sites (a preceding `?.`, `new`, or generic type
/// argument list before the `(` is not specially handled, for instance —
/// again, fine for load generation, not for correctness).
fn find_member_call_sites(text: &[u16], remaining_budget: usize) -> Vec<(i32, i32)> {
    let mut sites = Vec::new();
    let mut i = 0usize;
    let len = text.len();
    while i < len && sites.len() < remaining_budget {
        if !is_ident_start(text[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < len && is_ident_part(text[i]) {
            i += 1;
        }
        if i < len && text[i] == b'.' as u16 {
            let mut j = i + 1;
            if j < len && is_ident_start(text[j]) {
                while j < len && is_ident_part(text[j]) {
                    j += 1;
                }
                if j < len && text[j] == b'(' as u16 {
                    sites.push((start as i32, (j + 1) as i32));
                    i = j + 1;
                    continue;
                }
            }
        }
        // No match starting here; resume scanning right after the
        // identifier already consumed.
    }
    sites
}

fn percentile(sorted_ms: &[f64], p: f64) -> f64 {
    if sorted_ms.is_empty() {
        return 0.0;
    }
    let rank = ((p / 100.0) * (sorted_ms.len() - 1) as f64).round() as usize;
    sorted_ms[rank.min(sorted_ms.len() - 1)]
}

fn sample_rss_kb(pid: u32) -> Option<u64> {
    let output = Command::new("ps")
        .arg("-o")
        .arg("rss=")
        .arg("-p")
        .arg(pid.to_string())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

#[test]
#[ignore]
fn bench_spawn_snapshot_and_resolve_1000_member_call_sites() {
    let Some(corpus_root) = n8n_corpus_root() else {
        eprintln!("skipping: n8n corpus not present at the expected benchmark path");
        return;
    };
    let tsgo = match binary::discover(&repo_root()) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("skipping: tsgo binary not discoverable: {e}");
            return;
        }
    };

    let window = collect_window(&corpus_root, WINDOW_SIZE);
    assert!(
        !window.is_empty(),
        "expected at least one .ts file in the n8n corpus"
    );
    println!("window: {} files (target {WINDOW_SIZE})", window.len());

    let mut fs = MapFs::new();
    let mut root_names = Vec::with_capacity(window.len());
    let mut texts: Vec<(String, Vec<u16>)> = Vec::with_capacity(window.len());
    for path in &window {
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        let rel = path
            .strip_prefix(&corpus_root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let virtual_path = format!("{VIRTUAL_ROOT}/{rel}");
        let utf16 = urdira_tsgo_client::trivia::to_utf16(&content);
        fs.insert(virtual_path.clone(), content);
        root_names.push(virtual_path.clone());
        texts.push((virtual_path, utf16));
    }
    let config = serde_json::json!({
        "compilerOptions": {
            "module": "ESNext",
            "moduleResolution": "Bundler",
            "target": "ES2022",
            "strict": false,
            "skipLibCheck": true,
        },
        "files": root_names,
    })
    .to_string();
    fs.insert(CONFIG_PATH, config);
    let fs: Arc<dyn urdira_tsgo_client::VirtualFs> = Arc::new(fs);

    let spawn_start = Instant::now();
    let mut client =
        TsgoClient::spawn(&tsgo, VIRTUAL_ROOT, Arc::clone(&fs)).expect("tsgo should spawn");
    client.initialize().expect("initialize should succeed");
    let spawn_ms = spawn_start.elapsed().as_secs_f64() * 1000.0;

    let snapshot_start = Instant::now();
    let snapshot = client
        .update_snapshot(&UpdateSnapshotParams {
            open_projects: vec![CONFIG_PATH.to_string()],
            ..Default::default()
        })
        .expect("updateSnapshot should succeed");
    let snapshot_ms = snapshot_start.elapsed().as_secs_f64() * 1000.0;

    let project = snapshot
        .projects
        .iter()
        .find(|p| p.config_file_name == CONFIG_PATH)
        .expect("tsgo should open a project for the bench window")
        .id
        .clone();

    let rss_after_snapshot_kb = sample_rss_kb(client.pid());

    // Collect ~TARGET_SITES sites spread across the window (not all from
    // the first few files), grouped by owner file — `ResidualResolver`
    // batches per owner internally, and feeding it every owner's sites in
    // one `resolve()` call (rather than one call per file) is the real
    // usage shape a background residual pass would use for a whole window.
    let mut sites: Vec<PendingSite> = Vec::with_capacity(TARGET_SITES);
    'outer: for (owner_path, utf16) in &texts {
        let remaining = TARGET_SITES.saturating_sub(sites.len());
        if remaining == 0 {
            break 'outer;
        }
        // Cap per file so the site list actually spreads across the
        // window instead of exhausting the budget on one large file.
        let per_file_cap = (TARGET_SITES / WINDOW_SIZE).max(4);
        for (start, end) in find_member_call_sites(utf16, per_file_cap.min(remaining)) {
            sites.push(PendingSite {
                owner_path: owner_path.clone(),
                start,
                end,
                kind: SiteKind::Call,
                reason: "bench".to_string(),
            });
            if sites.len() >= TARGET_SITES {
                break 'outer;
            }
        }
    }
    println!(
        "collected {} member-call sites across {} files",
        sites.len(),
        texts.len()
    );
    assert!(
        sites.len() >= 100,
        "expected to find at least 100 member-call sites in the corpus window, found {}",
        sites.len()
    );

    let mut resolver =
        ResidualResolver::new(&client, Arc::clone(&fs), snapshot.snapshot, project.clone());
    let resolve_start = Instant::now();
    let resolutions = resolver.resolve(&sites);
    let resolve_ms = resolve_start.elapsed().as_secs_f64() * 1000.0;

    let resolved_count = resolutions
        .iter()
        .filter(|r| matches!(r, Resolution::Resolved(_)))
        .count();
    let per_query_mean_ms = resolve_ms / sites.len() as f64;

    let rss_after_resolve_kb = sample_rss_kb(client.pid());

    println!("spawn+initialize: {spawn_ms:.1} ms");
    println!(
        "updateSnapshot ({} files): {snapshot_ms:.1} ms",
        root_names.len()
    );
    println!(
        "resolve {} sites: {resolve_ms:.1} ms total, {per_query_mean_ms:.3} ms/site mean, {}/{} resolved",
        sites.len(),
        resolved_count,
        sites.len()
    );
    if let Some(kb) = rss_after_snapshot_kb {
        println!(
            "child RSS after updateSnapshot: {kb} KB ({:.1} MB)",
            kb as f64 / 1024.0
        );
    }
    if let Some(kb) = rss_after_resolve_kb {
        println!(
            "child RSS after resolve: {kb} KB ({:.1} MB)",
            kb as f64 / 1024.0
        );
    }

    // Per-owner-file batch latency distribution: a natural production-shaped
    // unit (one `resolve()` call per file's sites), reported alongside the
    // whole-window number above rather than instead of it.
    let mut by_owner: std::collections::BTreeMap<&str, Vec<&PendingSite>> =
        std::collections::BTreeMap::new();
    for site in &sites {
        by_owner
            .entry(site.owner_path.as_str())
            .or_default()
            .push(site);
    }
    let mut batch_ms: Vec<f64> = Vec::with_capacity(by_owner.len());
    for owner_sites in by_owner.values() {
        let owned: Vec<PendingSite> = owner_sites.iter().map(|s| (*s).clone()).collect();
        let mut resolver =
            ResidualResolver::new(&client, Arc::clone(&fs), snapshot.snapshot, project.clone());
        let start = Instant::now();
        let _ = resolver.resolve(&owned);
        batch_ms.push(start.elapsed().as_secs_f64() * 1000.0 / owned.len() as f64);
    }
    batch_ms.sort_by(|a, b| a.total_cmp(b));
    println!(
        "per-owner-batch per-site ms: p50={:.3} p95={:.3} (n={} owner batches)",
        percentile(&batch_ms, 50.0),
        percentile(&batch_ms, 95.0),
        batch_ms.len()
    );

    let status = client.shutdown().expect("tsgo should exit cleanly");
    assert!(status.success(), "tsgo exited with {status:?}");
}
