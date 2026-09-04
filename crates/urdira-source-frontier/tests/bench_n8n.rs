//! Perf gates for task P2-2a (plan §4.1/§8.2 targets). `#[ignore]`d: run with
//!
//! ```sh
//! pgrep -f "urdira-indexing-worker|n8n-incremental-preflight"   # must be empty first
//! cargo test -p urdira-source-frontier --test bench_n8n -- --ignored --nocapture
//! ```
//!
//! Targets (task brief): cold enumerate+hash of the n8n corpus (14k files,
//! 82 MB) in <= 0.5 s with 10 threads; `Frontier::load` on a 14k-row catalog
//! in <= 50 ms; incremental `observe_paths` of 1 file in <= 2 ms. Numbers
//! from an actual run are recorded in
//! `docs/evidence/2026-09-02-v4-p2-2a-source-frontier.md`, not asserted
//! here — a shared, possibly loaded dev machine makes a hard `assert!` on
//! wall time flaky; the point of the run is the printed measurement.

use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::time::Instant;
use urdira_source_frontier::catalog::{BatchMeta, Catalog};
use urdira_source_frontier::delta::Delta;
use urdira_source_frontier::frontier::Frontier;
use urdira_source_frontier::inclusion::{GitIgnoreRules, default_workspace_inclusion};
use urdira_source_frontier::walker::{PathObservation, Walker};

fn n8n_corpus_root() -> Option<PathBuf> {
    let candidate = Path::new("/Users/Cristian/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02");
    candidate.is_dir().then(|| candidate.to_path_buf())
}

fn schema_sql() -> &'static str {
    include_str!("../../../packages/storage/sql/workspace-v3.sql")
}

fn batch_meta(full_scan: bool) -> BatchMeta {
    BatchMeta {
        source_provider_binding_id: "binding:bench".to_string(),
        source_provider: "core:rust_source_frontier".to_string(),
        source_provider_version: "1".to_string(),
        started_at: "2026-09-02T00:00:00.000Z".to_string(),
        completed_at: "2026-09-02T00:00:01.000Z".to_string(),
        full_scan,
    }
}

#[test]
#[ignore]
fn bench_cold_enumerate_frontier_load_and_incremental_edit() {
    let Some(root) = n8n_corpus_root() else {
        eprintln!("skipping: n8n corpus not present at the expected benchmark path");
        return;
    };

    let rules = default_workspace_inclusion();
    let gitignore = GitIgnoreRules::default();

    // 1) Cold enumerate + hash (target <= 0.5s with 10 threads; no CAS put
    // here so this isolates walk+hash from filesystem-write cost, matching
    // the task's "cold enumerate+hash" framing). Uses
    // `DirectorySourceProvider`'s own default rules (gitignore disabled) —
    // this crate catalogs the FULL non-excluded file tree, a superset of
    // the "14k files / 82MB" figure elsewhere in project memory, which
    // refers to the narrower `is_jsts_source_path`-filtered set of JS/TS
    // "owners" the analysis pipeline consumes downstream of this catalog
    // (see the evidence doc's bench section for the measured file/byte
    // counts on this corpus).
    let started = Instant::now();
    let observations =
        Walker::enumerate(&root, &rules, &gitignore, None).expect("walker enumerate must succeed");
    let enumerate_elapsed = started.elapsed();
    println!(
        "cold enumerate+hash: {} files, {:.1} MB, {:.1} ms (rayon threads = {})",
        observations.len(),
        observations
            .iter()
            .map(|observation| observation.byte_length)
            .sum::<u64>() as f64
            / (1024.0 * 1024.0),
        enumerate_elapsed.as_secs_f64() * 1000.0,
        rayon::current_num_threads(),
    );

    // 2) Cold catalog apply, to seed a real 14k-row workspace-v3 SQLite
    // catalog for the Frontier::load benchmark below.
    let conn_path = std::env::temp_dir().join(format!(
        "urdira-source-frontier-bench-{}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&conn_path);
    let mut conn = Connection::open(&conn_path).expect("open bench sqlite db");
    conn.execute_batch(schema_sql())
        .expect("apply workspace-v3 schema");
    let workspace_id = "workspace:bench-n8n";
    let mut frontier = Frontier::empty();
    let delta = Delta::compute(&frontier, &observations);
    println!(
        "cold delta: added={} changed={} deleted={} equivalent={}",
        delta.added.len(),
        delta.changed.len(),
        delta.deleted.len(),
        delta.equivalent_count
    );
    let applied = Catalog::apply(
        &mut conn,
        workspace_id,
        &mut frontier,
        &delta,
        1,
        &batch_meta(true),
    )
    .expect("cold catalog apply must succeed");
    println!(
        "cold catalog apply: state_revision={} source_state_digest={}",
        applied.state_revision, applied.source_state_digest
    );
    drop(frontier);

    // 3) Frontier::load on that now-14k-row catalog (target <= 50ms).
    let started = Instant::now();
    let loaded = Frontier::load(&conn, workspace_id).expect("frontier load must succeed");
    let load_elapsed = started.elapsed();
    println!(
        "Frontier::load: {} present rows, {:.2} ms",
        loaded.present.len(),
        load_elapsed.as_secs_f64() * 1000.0
    );

    // 4) Incremental observe_paths + Delta::compute_partial + Catalog::apply
    // of exactly one edited file (target <= 2ms for observe_paths itself;
    // the full incremental apply, including the SQL transaction, is printed
    // separately since the task's 2ms budget is for observation only).
    let mut frontier = loaded;
    let sample_uri = frontier
        .present
        .keys()
        .next()
        .cloned()
        .expect("corpus must be non-empty");
    let absolute = root.join(&sample_uri);
    let mut bytes = std::fs::read(&absolute).expect("read sample file for incremental edit");
    bytes.extend_from_slice(b"\n// bench edit marker\n");
    std::fs::write(&absolute, &bytes).expect("write sample file edit");

    let started = Instant::now();
    let observed = Walker::observe_paths(
        &root,
        std::slice::from_ref(&sample_uri),
        &rules,
        &gitignore,
        None,
    );
    let observe_elapsed = started.elapsed();
    println!(
        "Walker::observe_paths (1 file): {:.3} ms",
        observe_elapsed.as_secs_f64() * 1000.0
    );

    let started = Instant::now();
    let partial_delta = Delta::compute_partial(&frontier, &observed);
    let apply_result = Catalog::apply(
        &mut conn,
        workspace_id,
        &mut frontier,
        &partial_delta,
        2,
        &batch_meta(false),
    )
    .expect("incremental catalog apply must succeed");
    let incremental_apply_elapsed = started.elapsed();
    println!(
        "Delta::compute_partial + Catalog::apply (1 file): {:.3} ms (changed={})",
        incremental_apply_elapsed.as_secs_f64() * 1000.0,
        apply_result.changed
    );
    assert_eq!(
        apply_result.changed, 1,
        "the edited sample file must be classified as changed"
    );
    assert!(matches!(
        observed.first(),
        Some(PathObservation::Present(_))
    ));

    // Verification: incremental digest must always agree with a from-scratch rebuild.
    assert_eq!(
        frontier.source_state_digest(),
        frontier.from_scratch_digest().unwrap()
    );

    let _ = std::fs::remove_file(&conn_path);
}
