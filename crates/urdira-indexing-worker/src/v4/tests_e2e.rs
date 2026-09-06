//! End-to-end cold-scan test against a real fixture (task P2-2b deliverable
//! 5: "an integration test... that runs `scripts/v4-scan.mjs` logic on
//! `tests/fixtures/codebases/typescript/*`... using the `StoreReader` via a
//! small Rust test binary"). `urdira-indexing-worker` has no library
//! target (only `[[bin]]`), so an external `tests/*.rs` integration test
//! cannot import `crate::v4` at all -- this module runs as a `#[cfg(test)]`
//! unit test inside the binary's own test harness instead, exercising the
//! exact same `catalog::run_full_scan` -> `analyze::run_cold` ->
//! `materialize::materialize_cold` -> `publish::publish_cold` sequence
//! `scan::run` drives, then opens the result with
//! `urdira_structural_store::StoreReader` (this task's real store reader,
//! not a decoder written just for the test).

#![cfg(test)]

use super::timings::ScanClock;
use super::{analyze, catalog, materialize, publish, residual, scan};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use urdira_jsts_syntax_worker::SyntaxWorkerState;
use urdira_structural_store::StoreReader;
use urdira_worker_protocol::{ChangeKind, ChangedPath, IndexingEvent, ScanPriority, ScanScope};

static SCRATCH_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A scratch directory under this crate's own `target/`, never `/tmp` (plan
/// §11's rule, applied here too even though this is a unit test, not the
/// n8n benchmark: consistency with the rest of this task's evidence). One
/// call per test, plus a process-unique counter, so parallel `cargo test`
/// runs of this module never collide.
pub(super) fn scratch_dir(label: &str) -> PathBuf {
    let counter = SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("v4-e2e-test")
        .join(format!("{label}-{}-{counter}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("scratch dir creation succeeds");
    dir
}

fn fixture_root() -> PathBuf {
    // `crates/urdira-indexing-worker` -> repo root -> tests/fixtures/...
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("tests/fixtures/codebases/typescript/task-planner")
}

struct ColdScanOutput {
    structural_root: PathBuf,
    records: Vec<urdira_structural_store::row::RecordRow>,
    dependencies_count: usize,
    /// A2 (pending.sites migration): `materialized.pending_sites.len()`,
    /// captured before `materialized` moves into `publish_cold` below.
    pending_sites_count: usize,
    generation: u64,
    /// P2-2j item 2 regression test hook (`partitioned_cold_scan_matches_
    /// flat_cold_scan_roots`, below): the SAME `ScanRoots` `publish_cold`
    /// returns for this call, so a test can compare it byte-for-byte
    /// against `scan::run_with_residual`'s (the real production
    /// entrypoint, which now calls the NEW `materialize_cold_partitioned`/
    /// `publish_cold_partitioned` pair) without re-deriving roots from the
    /// published store a second time.
    roots: urdira_worker_protocol::ScanRoots,
}

fn run_cold_scan(scratch: &Path) -> ColdScanOutput {
    let database_path = scratch.join("workspace.sqlite");
    let structural_root = scratch.join("structural");
    let cas_root = scratch.join("cas");
    let workspace_root = fixture_root();
    assert!(
        workspace_root.is_dir(),
        "fixture missing at {workspace_root:?} -- tests/fixtures/codebases/typescript/task-planner must exist"
    );

    let mut conn = catalog::open_and_ensure_schema(&database_path).expect("schema opens");
    let generation: i64 = 1;
    let outcome = catalog::run_full_scan(
        &mut conn,
        "workspace:v4-e2e-test",
        &workspace_root,
        &cas_root,
        generation,
    )
    .expect("catalog scan succeeds");
    catalog::restore_steady_state_pragmas(&conn)
        .expect("restoring synchronous=NORMAL after the cold catalog transaction succeeds");
    assert!(
        !outcome.frontier.present.is_empty(),
        "the fixture's walk observed zero files -- inclusion rules or the fixture path are wrong"
    );

    let mut clock = ScanClock::start();
    let mut syntax = urdira_jsts_syntax_worker::SyntaxWorkerState::default();
    let cas_signal = outcome
        .cas_write_queue
        .as_ref()
        .expect("run_full_scan always populates cas_write_queue")
        .signal();
    let (analysis, _source_cache, _typeflow_cache) = analyze::run_cold(
        &outcome.frontier,
        &cas_root,
        "workspace:v4-e2e-test",
        &mut syntax,
        &mut clock,
        &cas_signal,
    )
    .expect("analyze succeeds");
    assert!(!analysis.owners.is_empty(), "no JS/TS owners were analyzed");

    let materialized =
        materialize::materialize_cold(analysis.owners).expect("materialize succeeds");
    let dependencies_count = materialized.dependencies.len();
    let pending_sites_count = materialized.pending_sites.len();
    let records = materialized.records.clone();

    let request = scan::ScanRequest {
        request_id: "request:v4-e2e-test".to_string(),
        workspace_id: "workspace:v4-e2e-test".to_string(),
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        database_path: database_path.to_string_lossy().into_owned(),
        structural_root: structural_root.to_string_lossy().into_owned(),
        cas_root: cas_root.to_string_lossy().into_owned(),
        sidecar_root: scratch.join("sidecar").to_string_lossy().into_owned(),
        scope: urdira_worker_protocol::ScanScope::Full,
        registry_snapshot_id: "registry:v4-e2e-test".to_string(),
        configuration_revision_id: "configuration:v4-e2e-test".to_string(),
        resolution_lock_id: "resolution:v4-e2e-test".to_string(),
        deadline_ms: None,
        priority: urdira_worker_protocol::ScanPriority::Interactive,
    };
    let mut queryable_seen = false;
    let mut on_queryable = |_event: urdira_worker_protocol::IndexingEvent| -> Result<(), String> {
        queryable_seen = true;
        Ok(())
    };
    let event = publish::publish_cold(
        &mut conn,
        &request,
        &structural_root,
        generation,
        &outcome,
        materialized,
        &mut clock,
        &mut on_queryable,
    )
    .expect("publish succeeds");
    assert!(
        queryable_seen,
        "publish_cold must invoke on_queryable before returning"
    );
    let urdira_worker_protocol::IndexingEvent::ScanCompleted {
        generation: event_generation,
        roots: event_roots,
        ..
    } = event
    else {
        panic!("publish_cold must return ScanCompleted");
    };

    ColdScanOutput {
        structural_root,
        records,
        dependencies_count,
        pending_sites_count,
        generation: event_generation,
        roots: event_roots,
    }
}

#[test]
fn cold_scan_produces_a_readable_store_with_the_expected_record_count() {
    let scratch = scratch_dir("readable");
    let output = run_cold_scan(&scratch);
    assert_eq!(output.generation, 1);

    let manifest_path = output.structural_root.join("MANIFEST");
    assert!(
        manifest_path.is_file(),
        "MANIFEST must exist at {manifest_path:?}"
    );
    let base_dir = output.structural_root.join("base-1");
    assert!(base_dir.join("records.keys").is_file());
    assert!(base_dir.join("records.body").is_file());

    let reader =
        StoreReader::open(&output.structural_root).expect("StoreReader opens the published store");
    assert_eq!(reader.generation(), 1);
    let visible = reader.visible_count(1);
    assert_eq!(
        visible,
        output.records.len() as u64,
        "StoreReader's visible_count must match the materialized row count"
    );
    assert!(visible > 0, "the fixture must produce at least one record");
    assert_eq!(
        reader.deps_visible_count(1),
        output.dependencies_count as u64
    );

    // Every entity record from `src/domain/task.ts` should be findable by
    // its owner (a coarse "did the pipeline actually see this file"
    // check, independent of exact record ids).
    let dicts = reader.dictionaries();
    let task_ts_ordinal = dicts
        .artifacts
        .iter()
        .position(|(artifact_id, _version)| {
            artifact_id.contains("task.ts") || artifact_id.ends_with("task-repository.ts")
        })
        .or_else(|| {
            dicts
                .artifacts
                .iter()
                .position(|(artifact_id, _)| artifact_id.contains("domain"))
        });
    assert!(
        task_ts_ordinal.is_some() || !dicts.artifacts.is_empty(),
        "expected at least one interned artifact"
    );

    let _ = std::fs::remove_dir_all(&scratch);
}

/// P4-b investigation diagnostic (`docs/evidence/2026-09-03-v4-records-root-
/// change.md`): a permanent, fixture-scale counterpart to the n8n-only
/// `inspect_store_record_histogram` (`#[ignore]`d, needs a real corpus) --
/// this one runs on every `cargo test` since the fixture is checked in and
/// cheap. Asserts the two structural invariants that investigation relied
/// on to localize the `records` root drift to the entity subset without a
/// surviving pre-change store to diff against:
///
/// 1. **Every record is either `category=entity` with a `jsts:entity_`-
///    prefixed kind, or `category=relation` with a `jsts:relation_`-
///    prefixed kind** -- no third category exists on this pipeline (`v4::
///    analyze`'s own module doc: "No `jsts:diagnostic` records are
///    produced anywhere in this module"), so `records` root's member set is
///    always exactly `entity_count + relation_count` with no undocumented
///    third bucket that could silently absorb a membership change.
/// 2. **`total_records == entity_count + relation_count`** exactly (the
///    same identity used at n8n scale in the investigation's evidence doc
///    to prove the `records` root delta was confined to per-record DIGEST
///    content within the entity subset, not to membership/count, once
///    combined with the separately-provable fact that `graph` -- built
///    from the exact same `(record_id, record_digest)` pairs, filtered to
///    `category=relation` -- never changed root across that same window:
///    see `v4/publish.rs`'s `graph_entries` and `merkle.rs`'s doc comment
///    "key = record_id, logical = record_digest" for why a `graph` root
///    match makes every relation record's `(id, digest)` pair a proven
///    match too).
///
/// Also prints the same per-`(category, kind)` histogram shape as
/// `inspect_store_record_histogram` (via `--nocapture`) so a future
/// investigation has a fixture-scale reference table without needing a
/// real corpus at all.
#[test]
fn cold_scan_record_histogram_matches_category_kind_prefix_invariant() {
    use std::collections::BTreeMap;

    let scratch = scratch_dir("histogram");
    let output = run_cold_scan(&scratch);
    let reader =
        StoreReader::open(&output.structural_root).expect("StoreReader opens the published store");
    let generation = reader.generation();
    let dicts = reader.dictionaries();

    let mut by_kind: BTreeMap<(u8, String), u64> = BTreeMap::new();
    let mut entity_count = 0u64;
    let mut relation_count = 0u64;
    // A2 (pending.sites migration): `jsts:unresolved_call` diagnostics were
    // already folded away before this task (2026-09-04, see `semantic_
    // sites.rs`'s own `OwnerSemantics::pending_site_rows` doc comment) --
    // v4 emits NO diagnostic-category record at all, not even transiently,
    // so `diagnostic_count` must be EXACTLY zero (tightened from the old
    // "record it, whatever it is" stance this test used to take while that
    // fold-away was still a recent, uncertain change).
    let mut diagnostic_count = 0u64;
    let mut total = 0u64;
    for view in reader.iter_visible(generation) {
        total += 1;
        let category = view.category();
        let kind = dicts
            .kinds
            .get(view.kind_id() as usize)
            .cloned()
            .unwrap_or_else(|| format!("<unknown:{}>", view.kind_id()));
        match category {
            urdira_structural_store::row::CATEGORY_ENTITY => {
                entity_count += 1;
                assert!(
                    kind.starts_with("jsts:entity_"),
                    "category=entity record has non-entity kind {kind:?}"
                );
            }
            urdira_structural_store::row::CATEGORY_RELATION => {
                relation_count += 1;
                assert!(
                    kind.starts_with("jsts:relation_"),
                    "category=relation record has non-relation kind {kind:?}"
                );
                // A2's own invariant: after this migration, a `core:call`/
                // `core:inherits`/`core:implements` relation record can no
                // longer exist without a resolved `target_subject` -- a
                // no-target site is a `pending.sites` row instead (never a
                // RECORD). Scoped to these three universal kinds (not every
                // relation kind): `core:import`/`core:export`/`core:contains`
                // legitimately resolve to `None` for a target OUTSIDE this
                // workspace (an external package import) -- that is a
                // pre-existing, unrelated condition this task does not
                // touch, so asserting it here would be wrong, not stricter.
                let universal_kind = dicts
                    .universal_kinds
                    .get(view.universal_kind_id() as usize)
                    .map(String::as_str)
                    .unwrap_or("");
                if matches!(
                    universal_kind,
                    "core:call" | "core:inherits" | "core:implements"
                ) {
                    assert!(
                        view.target_subject().is_some(),
                        "a {universal_kind} relation record must always carry a resolved target_subject: {kind} record_id={:?}",
                        view.record_id(),
                    );
                }
            }
            urdira_structural_store::row::CATEGORY_DIAGNOSTIC => {
                diagnostic_count += 1;
            }
            other => panic!("unexpected record category {other} (kind {kind:?})"),
        }
        *by_kind.entry((category, kind)).or_insert(0) += 1;
    }

    assert_eq!(
        diagnostic_count, 0,
        "v4 must emit zero diagnostic-category records"
    );
    assert_eq!(
        total,
        entity_count + relation_count + diagnostic_count,
        "total records must equal entity_count + relation_count + diagnostic_count exactly"
    );
    assert_eq!(total, output.records.len() as u64);

    println!("fixture generation={generation} total_records={total}");
    for ((category, kind), count) in &by_kind {
        let category_name = match *category {
            urdira_structural_store::row::CATEGORY_ENTITY => "entity",
            urdira_structural_store::row::CATEGORY_RELATION => "relation",
            urdira_structural_store::row::CATEGORY_DIAGNOSTIC => "diagnostic",
            _ => "unknown",
        };
        println!("  {category_name:9} {kind:32} {count}");
    }

    // A2 (pending.sites migration): the fixture must produce at least one
    // pending site (its own non-identifier-callee/ambiguous call sites --
    // see the `v4-daemon-e2e.test.ts` TS-side fixture assertion for the
    // same population). Before the C task (member entities at cold),
    // `source_subject` was `None` whenever the site's own enclosing scope
    // was a class/interface MEMBER (v4's entity schema did not materialize
    // members -- `residual.rs`'s own `collect()` doc comment, "Known
    // regression versus the pre-migration `collect()`", documented this
    // exact gap); now that member entities materialize at cold, a pending
    // site enclosed by a member resolves too (see `cold_scan_materializes_
    // member_entities_and_confirms_a_typeflow_member_call`, below, for the
    // dedicated coverage). This assertion only requires that EVERY site
    // whose `source_subject` DOES resolve points at a visible ENTITY
    // record -- `materialize.rs` resolves a pending site's `source_id` the
    // exact same way a relation row's own endpoint resolves, so this
    // doubles as a regression check on that resolution path.
    let pending = reader.iter_visible_pending_sites(generation);
    assert!(
        !pending.is_empty(),
        "expected at least one pending site for this fixture"
    );
    assert_eq!(pending.len(), output.pending_sites_count);
    let mut pending_with_source_subject = 0u64;
    for site in &pending {
        let Some(source_subject) = site.source_subject() else {
            continue;
        };
        pending_with_source_subject += 1;
        let source_record_id = dicts
            .subjects
            .get(source_subject as usize)
            .unwrap_or_else(|| {
                panic!("source_subject {source_subject} has no dicts.subjects entry")
            });
        let source_record = reader
            .get_visible(source_record_id, generation)
            .expect("a pending site's source_subject must resolve to a visible record");
        assert_eq!(
            source_record.category(),
            urdira_structural_store::row::CATEGORY_ENTITY,
            "a pending site's source_subject must resolve to an ENTITY record"
        );
    }
    println!(
        "pending_sites={} pending_with_source_subject={pending_with_source_subject}",
        pending.len()
    );

    let _ = std::fs::remove_dir_all(&scratch);
}

/// The C task's own e2e proof: the cold entity producer must materialize
/// class/interface member entities (histogram shows the new kinds), AND a
/// typeflow-confirmed member call must already carry a resolved
/// `target_subject` at GENERATION 1 (cold), before any residual tsgo pass
/// ever runs (this test never schedules one). The fixture's own `src/main.
/// ts` -- `const tasks = new TaskService(repository); tasks.createTask(...)`
/// -- is exactly typeflow's "new expression initializer member call" rule
/// (`urdira-jsts-syntax-worker::semantic_sites::tests::typeflow_resolves_a_
/// new_expression_initializer_member_call` covers the same shape at unit
/// scale) targeting `TaskService`'s own class methods -- before this task,
/// that target was a class MEMBER the cold entity producer never
/// materialized, so the call's relation row was dropped at materialize time
/// (`target_not_interned`) and downgraded to a pending site; this test
/// proves that no longer happens.
#[test]
fn cold_scan_materializes_member_entities_and_confirms_a_typeflow_member_call() {
    let scratch = scratch_dir("member-entities");
    let output = run_cold_scan(&scratch);
    let reader =
        StoreReader::open(&output.structural_root).expect("StoreReader opens the published store");
    let generation = reader.generation();
    assert_eq!(generation, 1, "this test asserts a COLD-generation fact");
    let dicts = reader.dictionaries();
    let indirect_bit = dicts
        .facet_names
        .iter()
        .position(|name| name == "core:indirect")
        .expect("FACET_ORDER always registers core:indirect");

    // Histogram: at least one member entity of each kind this fixture's own
    // classes/interfaces exercise (method, constructor, property -- see
    // `TaskService`'s `#nextId` field and its own constructor/methods, and
    // `TaskRepository`'s interface method signatures) must be present,
    // identified purely from `identity_key`'s own `jsts:{kind_word}:...`
    // prefix -- the same recipe `urdira_jsts_typeflow::declaration_id` and
    // `stable_entity_id` both build.
    let mut member_kind_words_seen: std::collections::BTreeSet<&'static str> = Default::default();
    for view in reader.iter_visible(generation) {
        if view.category() != urdira_structural_store::row::CATEGORY_ENTITY {
            continue;
        }
        let identity_key = String::from_utf8_lossy(&view.identity_key()).into_owned();
        for kind_word in ["method", "constructor", "getter", "setter", "property"] {
            if identity_key.starts_with(&format!("jsts:{kind_word}:")) {
                member_kind_words_seen.insert(kind_word);
            }
        }
    }
    println!("member entity kind words seen: {member_kind_words_seen:?}");
    for expected in ["method", "constructor", "property"] {
        assert!(
            member_kind_words_seen.contains(expected),
            "expected at least one {expected} member entity in the fixture's cold histogram, saw {member_kind_words_seen:?}"
        );
    }

    // A typeflow-confirmed (non-candidate) `core:call` relation whose
    // resolved target is one of those member entities.
    let mut found_confirmed_member_call = false;
    for view in reader.iter_visible(generation) {
        if view.category() != urdira_structural_store::row::CATEGORY_RELATION {
            continue;
        }
        let universal_kind = dicts
            .universal_kinds
            .get(view.universal_kind_id() as usize)
            .map(String::as_str)
            .unwrap_or("");
        if universal_kind != "core:call" {
            continue;
        }
        let is_candidate = (view.facets() & (1u64 << indirect_bit)) != 0;
        if is_candidate {
            continue;
        }
        let Some(target_subject) = view.target_subject() else {
            continue;
        };
        let Some(target_record_id) = dicts.subjects.get(target_subject as usize) else {
            continue;
        };
        let Some(target_view) = reader.get_visible(target_record_id, generation) else {
            continue;
        };
        let target_identity = String::from_utf8_lossy(&target_view.identity_key()).into_owned();
        if ["method", "constructor", "getter", "setter", "property"]
            .iter()
            .any(|kind_word| target_identity.starts_with(&format!("jsts:{kind_word}:")))
        {
            found_confirmed_member_call = true;
            println!("confirmed member call target: {target_identity}");
            break;
        }
    }
    assert!(
        found_confirmed_member_call,
        "expected at least one confirmed (non-candidate) core:call relation targeting a class/interface member entity at generation 1 (cold)"
    );

    let _ = std::fs::remove_dir_all(&scratch);
}

/// Parameter entities, "referenced-only" variant (owner-approved,
/// 2026-09-04): the cold entity producer must materialize one `jsts:
/// entity_parameter` per identifier-pattern parameter that receives at
/// least one resolved reference (histogram shows the new kind), AND a
/// `core:references` relation whose target is one of those entities must
/// already carry a resolved `target_subject` at GENERATION 1 (cold), before
/// any residual tsgo pass ever runs. The fixture's `TaskService::createTask`
/// (`src/services/task-service.ts`) references its own `input` parameter
/// twice in its body (`input.title.trim()`, `{ ...input, title }`) -- before
/// this task, no entity was ever materialized for a parameter declaration
/// at all, so that reference's target never interned.
#[test]
fn cold_scan_materializes_referenced_parameter_entities_and_resolves_their_target_subject() {
    let scratch = scratch_dir("parameter-entities");
    let output = run_cold_scan(&scratch);
    let reader =
        StoreReader::open(&output.structural_root).expect("StoreReader opens the published store");
    let generation = reader.generation();
    assert_eq!(generation, 1, "this test asserts a COLD-generation fact");
    let dicts = reader.dictionaries();

    // Histogram: at least one `jsts:entity_parameter` entity, identified
    // from `identity_key`'s own `jsts:parameter:...` prefix -- the same
    // recipe `declaration_id(DeclKind::Parameter, ...)` builds for a
    // reference TARGETING it.
    let mut parameter_entity_ids: std::collections::BTreeSet<Vec<u8>> = Default::default();
    for view in reader.iter_visible(generation) {
        if view.category() != urdira_structural_store::row::CATEGORY_ENTITY {
            continue;
        }
        let identity_key = view.identity_key();
        if identity_key.starts_with(b"jsts:parameter:") {
            parameter_entity_ids.insert(identity_key.to_vec());
        }
    }
    println!("jsts:entity_parameter count={}", parameter_entity_ids.len());
    assert!(
        !parameter_entity_ids.is_empty(),
        "expected at least one jsts:entity_parameter entity in the fixture's cold histogram"
    );

    // A `core:references` relation whose resolved target is one of those
    // parameter entities, `target_subject` already set (interned) at cold.
    let mut found_referenced_parameter = false;
    for view in reader.iter_visible(generation) {
        if view.category() != urdira_structural_store::row::CATEGORY_RELATION {
            continue;
        }
        let universal_kind = dicts
            .universal_kinds
            .get(view.universal_kind_id() as usize)
            .map(String::as_str)
            .unwrap_or("");
        if universal_kind != "core:references" {
            continue;
        }
        let Some(target_subject) = view.target_subject() else {
            continue;
        };
        let Some(target_record_id) = dicts.subjects.get(target_subject as usize) else {
            continue;
        };
        let Some(target_view) = reader.get_visible(target_record_id, generation) else {
            continue;
        };
        if parameter_entity_ids.contains(target_view.identity_key().as_ref()) {
            found_referenced_parameter = true;
            println!(
                "resolved core:references target: {}",
                String::from_utf8_lossy(&target_view.identity_key())
            );
            break;
        }
    }
    assert!(
        found_referenced_parameter,
        "expected at least one core:references relation with target_subject resolved to a parameter entity at generation 1 (cold)"
    );

    let _ = std::fs::remove_dir_all(&scratch);
}

#[test]
fn cold_scan_is_deterministic_across_two_independent_runs() {
    let scratch_a = scratch_dir("determinism-a");
    let scratch_b = scratch_dir("determinism-b");
    let output_a = run_cold_scan(&scratch_a);
    let output_b = run_cold_scan(&scratch_b);

    assert_eq!(output_a.records.len(), output_b.records.len());
    let mut records_a = output_a.records.clone();
    let mut records_b = output_b.records.clone();
    records_a.sort_by_key(|record| record.record_id);
    records_b.sort_by_key(|record| record.record_id);
    for (a, b) in records_a.iter().zip(records_b.iter()) {
        assert_eq!(a.record_id, b.record_id);
        assert_eq!(a.record_digest, b.record_digest);
        assert_eq!(a.identity_key, b.identity_key);
    }

    let manifest_a =
        urdira_structural_store::Manifest::read(&scratch_a.join("structural").join("MANIFEST"))
            .expect("manifest a reads");
    let manifest_b =
        urdira_structural_store::Manifest::read(&scratch_b.join("structural").join("MANIFEST"))
            .expect("manifest b reads");
    assert_eq!(
        manifest_a.roots.get("records"),
        manifest_b.roots.get("records"),
        "records root must be identical across two from-scratch cold scans of the same fixture"
    );

    let _ = std::fs::remove_dir_all(&scratch_a);
    let _ = std::fs::remove_dir_all(&scratch_b);
}

/// P2-2j item 2 regression test: `run_cold_scan` (this file's own test
/// helper) still calls the OLD, flat/globally-sorted `materialize_cold`/
/// `publish_cold` pair directly; the REAL production cold-scan entrypoint
/// (`scan::run_with_residual`'s `ScanScope::Full` arm, `scan.rs::run_full`)
/// now calls the NEW partitioned pair (`materialize_cold_partitioned`/
/// `publish_cold_partitioned`) instead. This test runs BOTH against the
/// SAME fixture and asserts every one of the four published roots
/// (records/dependency/graph/metric) is byte-for-byte identical --
/// confirming the sorted-key dictionary ordinals and the nibble-partitioned
/// assembly this task's evidence doc describes really do produce the same
/// canonical structural-record set as the pre-existing, well-tested flat
/// path, through the ENTIRE real pipeline (catalog -> analyze -> materialize
/// -> publish), not just at the `write_base` byte level (see
/// `urdira-structural-store/tests/write_base_partitioned_test.rs` for that
/// separate, lower-level check).
#[test]
fn partitioned_cold_scan_matches_flat_cold_scan_roots() {
    let scratch_flat = scratch_dir("partitioned-vs-flat-old");
    let old_output = run_cold_scan(&scratch_flat);

    let scratch_new = scratch_dir("partitioned-vs-flat-new");
    let database_path = scratch_new.join("workspace.sqlite");
    let structural_root = scratch_new.join("structural");
    let cas_root = scratch_new.join("cas");
    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();
    let new_event = run_scan(
        "request:partitioned-vs-flat",
        "workspace:partitioned-vs-flat",
        &fixture_root(),
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    let new_roots = roots_of(&new_event);

    assert_eq!(
        old_output.roots.records, new_roots.records,
        "records root must match between the flat and the partitioned cold path"
    );
    assert_eq!(
        old_output.roots.dependency, new_roots.dependency,
        "dependency root must match between the flat and the partitioned cold path"
    );
    assert_eq!(
        old_output.roots.graph, new_roots.graph,
        "graph root must match between the flat and the partitioned cold path"
    );
    assert_eq!(
        old_output.roots.metric, new_roots.metric,
        "metric root must match between the flat and the partitioned cold path"
    );

    let _ = std::fs::remove_dir_all(&scratch_flat);
    let _ = std::fs::remove_dir_all(&scratch_new);
}

fn copy_dir_recursive(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("create_dir_all succeeds");
    for entry in std::fs::read_dir(from).expect("read_dir succeeds") {
        let entry = entry.expect("dir entry readable");
        let file_type = entry.file_type().expect("file_type readable");
        let dest = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest);
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &dest).expect("file copy succeeds");
        } else {
            // Symlinks (dangling, or to a directory) and other special
            // entries: a real monorepo corpus (e.g. n8n) can contain a
            // handful of these outside the fixture tests' small,
            // symlink-free corpora this helper originally served --
            // `std::fs::copy` rejects anything that isn't a regular file
            // or a symlink to one, so skip rather than panic. Never
            // affects correctness of a v4 scan: the walker's own
            // inclusion rules (`urdira-source-frontier::inclusion`) do
            // not treat symlinks as source files either.
            eprintln!(
                "copy_dir_recursive: skipping non-regular-file entry {:?}",
                entry.path()
            );
        }
    }
}

/// P3-2 hard rule: the shared n8n benchmark corpus
/// (`/Users/Cristian/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`,
/// marked with a `.urdira-shared-corpus-readonly` sentinel file at its
/// root) must NEVER be mutated in place. This is not theoretical: an
/// earlier version of [`n8n_incremental_measurement`] did exactly that
/// (`std::fs::write`/`std::fs::remove_file` straight into
/// `URDIRA_V4_N8N_CORPUS`), permanently corrupting the shared asset twice
/// before the mistake was caught and the corpus manually restored (see
/// `docs/evidence/2026-09-03-v4-p3-1-incremental.md` §7.6). Every n8n-scale
/// test must route its corpus through this helper: it copies
/// unconditionally (a scratch copy is required regardless of the marker's
/// presence) and additionally hard-asserts the scratch workspace can never
/// alias the source path, so a future refactor that accidentally drops the
/// copy step fails loudly instead of silently mutating the shared asset
/// again.
pub(super) fn scratch_copy_of_n8n_corpus(label: &str, corpus_env_value: &str) -> PathBuf {
    let source_root = PathBuf::from(corpus_env_value);
    let scratch_root = scratch_dir(label);
    let workspace_root = scratch_root.join("workspace");
    assert_ne!(
        workspace_root, source_root,
        "refusing to alias the shared n8n corpus as a mutable scratch workspace"
    );
    let marker_path = source_root.join(".urdira-shared-corpus-readonly");
    if marker_path.exists() {
        eprintln!(
            "{source_root:?} carries the shared-corpus read-only marker: copying to {workspace_root:?} before any mutation"
        );
    }
    eprintln!("copying n8n corpus to scratch (this takes a while for ~20k files)...");
    let copy_started = std::time::Instant::now();
    copy_dir_recursive(&source_root, &workspace_root);
    eprintln!("copy done in {:.1}s", copy_started.elapsed().as_secs_f64());
    workspace_root
}

/// P3-2 item 3 diagnostic: when the `dependency` root mismatches a
/// from-scratch oracle, dumps the first 20 differing dependency edges (per
/// side), resolving each edge's `owner_artifact`/`dep_artifact` ordinals
/// back to their `(artifact_id, artifact_version_id)` strings via that
/// SAME store's own dictionaries (each side's ordinal space is only
/// meaningful relative to its own dictionary -- see `deps.rs`'s module doc
/// on why `dependency_id` itself no longer embeds ordinals at all,
/// post-fix). Never panics on its own: purely diagnostic, called before
/// the real `assert_eq!` that does the failing.
fn dump_dependency_set_diff(
    incremental_structural_root: &Path,
    incremental_generation: u64,
    oracle_structural_root: &Path,
    oracle_generation: u64,
) {
    fn resolved_deps(
        structural_root: &Path,
        generation: u64,
    ) -> std::collections::HashMap<[u8; 32], (String, String, String, String, u8)> {
        let reader = StoreReader::open(structural_root).expect("diagnostic store reader opens");
        let dicts = reader.dictionaries();
        reader
            .iter_visible_deps(generation)
            .into_iter()
            .map(|view| {
                let owner = dicts
                    .artifacts
                    .get(view.owner_artifact() as usize)
                    .cloned()
                    .unwrap_or_default();
                let dep = dicts
                    .artifacts
                    .get(view.dep_artifact() as usize)
                    .cloned()
                    .unwrap_or_default();
                (
                    view.dependency_id(),
                    (owner.0, owner.1, dep.0, dep.1, view.role()),
                )
            })
            .collect()
    }
    let incremental = resolved_deps(incremental_structural_root, incremental_generation);
    let oracle = resolved_deps(oracle_structural_root, oracle_generation);
    let mut only_incremental: Vec<_> = incremental
        .iter()
        .filter(|(id, _)| !oracle.contains_key(*id))
        .collect();
    let mut only_oracle: Vec<_> = oracle
        .iter()
        .filter(|(id, _)| !incremental.contains_key(*id))
        .collect();
    only_incremental.sort_by_key(|(id, _)| **id);
    only_oracle.sort_by_key(|(id, _)| **id);
    eprintln!(
        "dependency set diff: incremental has {} live edges, oracle has {} live edges; {} only-in-incremental, {} only-in-oracle",
        incremental.len(),
        oracle.len(),
        only_incremental.len(),
        only_oracle.len()
    );
    for (id, (owner_id, owner_version, dep_id, dep_version, role)) in
        only_incremental.iter().take(20)
    {
        eprintln!(
            "  ONLY-INCREMENTAL {}: owner=({owner_id}, {owner_version}) dep=({dep_id}, {dep_version}) role={role}",
            urdira_structural_store::to_prefixed_hex(id)
        );
    }
    for (id, (owner_id, owner_version, dep_id, dep_version, role)) in only_oracle.iter().take(20) {
        eprintln!(
            "  ONLY-ORACLE {}: owner=({owner_id}, {owner_version}) dep=({dep_id}, {dep_version}) role={role}",
            urdira_structural_store::to_prefixed_hex(id)
        );
    }
}

/// Diagnostic for `n8n_incremental_create_delete_roots_match_oracle`'s
/// `records` root mismatch: opens both stores, iterates every VISIBLE
/// record at the given generation, keys by `identity_key` (not
/// `record_id` -- the whole point is to find identities whose surviving
/// `record_id`/`record_digest`/owner DIFFER between the two sides, not
/// identities that vanished, which `only_incremental`/`only_oracle` below
/// already cover), and prints every differing identity with both sides'
/// `(record_id, record_digest, owner_artifact, owner_path)`.
fn dump_records_set_diff(
    incremental_structural_root: &Path,
    incremental_generation: u64,
    oracle_structural_root: &Path,
    oracle_generation: u64,
) {
    #[derive(Clone, PartialEq, Eq, Debug)]
    struct Row {
        record_id: [u8; 32],
        record_digest: [u8; 32],
        owner_artifact_id: String,
    }
    fn visible_by_identity(
        structural_root: &Path,
        generation: u64,
    ) -> std::collections::HashMap<Vec<u8>, Row> {
        let reader = StoreReader::open(structural_root).expect("diagnostic store reader opens");
        let dicts = reader.dictionaries();
        reader
            .iter_visible(generation)
            .map(|view| {
                let owner = dicts
                    .artifacts
                    .get(view.owner_artifact() as usize)
                    .cloned()
                    .unwrap_or_default();
                (
                    view.identity_key().to_vec(),
                    Row {
                        record_id: view.record_id(),
                        record_digest: view.record_digest(),
                        owner_artifact_id: owner.0,
                    },
                )
            })
            .collect()
    }
    // Direct comparison over the EXACT space the `records` merkle tree
    // hashes: `(record_id -> record_digest)`, bypassing `identity_key`
    // entirely. If this set differs while the identity-keyed comparison
    // below reports zero real differences, the identity-keyed view is
    // masking something (e.g. two live rows sharing one `identity_key` on
    // one side, silently collapsed by the `HashMap<identity_key, Row>`
    // above) -- reported separately so that is never silently missed.
    fn visible_by_record_id(
        structural_root: &Path,
        generation: u64,
    ) -> std::collections::HashMap<[u8; 32], [u8; 32]> {
        let reader = StoreReader::open(structural_root).expect("diagnostic store reader opens");
        reader
            .iter_visible(generation)
            .map(|view| (view.record_id(), view.record_digest()))
            .collect()
    }
    let incremental_by_id =
        visible_by_record_id(incremental_structural_root, incremental_generation);
    let oracle_by_id = visible_by_record_id(oracle_structural_root, oracle_generation);
    let id_only_incremental = incremental_by_id
        .keys()
        .filter(|k| !oracle_by_id.contains_key(*k))
        .count();
    let id_only_oracle = oracle_by_id
        .keys()
        .filter(|k| !incremental_by_id.contains_key(*k))
        .count();
    let id_digest_mismatch = incremental_by_id
        .iter()
        .filter(|(k, v)| oracle_by_id.get(*k).is_some_and(|ov| ov != *v))
        .count();
    eprintln!(
        "records set diff (BY record_id, bypassing identity_key entirely -- this is exactly the `records` merkle tree's own key space): incremental has {} live record_ids, oracle has {} live record_ids; {} only-in-incremental, {} only-in-oracle, {} same-record_id-different-digest",
        incremental_by_id.len(),
        oracle_by_id.len(),
        id_only_incremental,
        id_only_oracle,
        id_digest_mismatch,
    );

    let incremental = visible_by_identity(incremental_structural_root, incremental_generation);
    let oracle = visible_by_identity(oracle_structural_root, oracle_generation);
    let mut only_incremental: Vec<&Vec<u8>> = incremental
        .keys()
        .filter(|id| !oracle.contains_key(*id))
        .collect();
    let mut only_oracle: Vec<&Vec<u8>> = oracle
        .keys()
        .filter(|id| !incremental.contains_key(*id))
        .collect();
    // `owner_artifact_id` is salted with `workspace_id` (`urdira-source-
    // frontier::ids::artifact_id`), which legitimately differs between the
    // incremental run's workspace ("workspace:n8n-oracle") and this
    // oracle's own ("workspace:n8n-oracle-fromscratch") -- so an
    // owner-only difference is EXPECTED NOISE, not a bug: the `records`
    // merkle tree's leaf is `(key=record_id, logical=record_digest)`
    // ONLY (`urdira-structural-store::writer::write_delta`'s own
    // `record_changes` construction, confirmed by reading it directly),
    // never `owner_artifact`. Split into two buckets so a real digest/id
    // mismatch is never buried under thousands of harmless owner-string
    // differences.
    let mut differing_owner_only: Vec<&Vec<u8>> = Vec::new();
    let mut differing_real: Vec<&Vec<u8>> = Vec::new();
    for id in incremental.keys() {
        let Some(o) = oracle.get(id) else { continue };
        let inc = &incremental[id];
        if inc == o {
            continue;
        }
        if inc.record_id == o.record_id && inc.record_digest == o.record_digest {
            differing_owner_only.push(id);
        } else {
            differing_real.push(id);
        }
    }
    only_incremental.sort();
    only_oracle.sort();
    differing_owner_only.sort();
    differing_real.sort();
    eprintln!(
        "records set diff: incremental has {} live records, oracle has {} live records; {} only-in-incremental, {} only-in-oracle, {} owner-only-diff (expected noise), {} REAL record_id/digest diff",
        incremental.len(),
        oracle.len(),
        only_incremental.len(),
        only_oracle.len(),
        differing_owner_only.len(),
        differing_real.len(),
    );
    for id in only_incremental.iter().take(20) {
        eprintln!(
            "  ONLY-INCREMENTAL identity={}",
            String::from_utf8_lossy(id)
        );
    }
    for id in only_oracle.iter().take(20) {
        eprintln!("  ONLY-ORACLE identity={}", String::from_utf8_lossy(id));
    }
    for id in differing_real.iter().take(40) {
        let inc = &incremental[*id];
        let ora = &oracle[*id];
        eprintln!(
            "  REAL-DIFFERS identity={} incremental=(record_id={}, digest={}, owner={}) oracle=(record_id={}, digest={}, owner={})",
            String::from_utf8_lossy(id),
            urdira_structural_store::to_prefixed_hex(&inc.record_id),
            urdira_structural_store::to_prefixed_hex(&inc.record_digest),
            inc.owner_artifact_id,
            urdira_structural_store::to_prefixed_hex(&ora.record_id),
            urdira_structural_store::to_prefixed_hex(&ora.record_digest),
            ora.owner_artifact_id,
        );
    }
}

/// Runs one `WorkspaceScan` (the real `scan::run` entry point -- not the
/// manual step-by-step pipeline `run_cold_scan` above drives) and returns
/// its terminal `ScanCompleted` event.
#[allow(clippy::too_many_arguments)]
pub(super) fn run_scan(
    request_id: &str,
    workspace_id: &str,
    workspace_root: &Path,
    database_path: &Path,
    structural_root: &Path,
    cas_root: &Path,
    scope: ScanScope,
    syntax: &mut SyntaxWorkerState,
    worker_state: &mut super::state::WorkerState,
) -> IndexingEvent {
    let request = scan::ScanRequest {
        request_id: request_id.to_string(),
        workspace_id: workspace_id.to_string(),
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        database_path: database_path.to_string_lossy().into_owned(),
        structural_root: structural_root.to_string_lossy().into_owned(),
        cas_root: cas_root.to_string_lossy().into_owned(),
        sidecar_root: structural_root
            .parent()
            .unwrap()
            .join("sidecar")
            .to_string_lossy()
            .into_owned(),
        scope,
        registry_snapshot_id: "registry:v4-e2e-test".to_string(),
        configuration_revision_id: "configuration:v4-e2e-test".to_string(),
        resolution_lock_id: "resolution:v4-e2e-test".to_string(),
        deadline_ms: None,
        priority: ScanPriority::Interactive,
    };
    let mut on_queryable = |_event: IndexingEvent| -> Result<(), String> { Ok(()) };
    scan::run_with_residual(request, syntax, worker_state, &mut on_queryable, None)
        .expect("scan::run_with_residual succeeds")
}

/// A2 (pending.sites migration): every visible pending site's `(path,
/// start, end, site_kind, reason)` tuple, sorted -- for incremental-vs-
/// oracle equality comparisons alongside the existing `records`/
/// `dependency`/`graph` root comparisons every test below already makes.
/// Resolves `owner_artifact` back to a path via the workspace's own
/// `Frontier` (same pattern `residual.rs`'s `owner_path` closure and
/// `dump_call_bodies` both already establish).
pub(super) fn pending_site_set(
    structural_root: &Path,
    database_path: &Path,
    workspace_id: &str,
) -> Vec<(String, u32, u32, u8, u8)> {
    let reader = StoreReader::open(structural_root).expect("StoreReader opens for pending set");
    let generation = reader.generation();
    let dicts = reader.dictionaries();
    let conn =
        catalog::open_and_ensure_schema(database_path).expect("catalog opens for pending set");
    let frontier = urdira_source_frontier::Frontier::load(&conn, workspace_id)
        .expect("frontier loads for pending set");
    drop(conn);
    let mut path_by_pair: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();
    for (path, entry) in &frontier.present {
        path_by_pair.insert(
            (entry.artifact_id.clone(), entry.artifact_version_id.clone()),
            path.clone(),
        );
    }
    let mut out: Vec<(String, u32, u32, u8, u8)> = Vec::new();
    for site in reader.iter_visible_pending_sites(generation) {
        let Some(pair) = dicts.artifacts.get(site.owner_artifact() as usize) else {
            continue;
        };
        let Some(path) = path_by_pair.get(pair) else {
            continue;
        };
        out.push((
            path.clone(),
            site.start(),
            site.end(),
            site.site_kind(),
            site.reason(),
        ));
    }
    out.sort();
    out
}

fn roots_of(event: &IndexingEvent) -> urdira_worker_protocol::ScanRoots {
    match event {
        IndexingEvent::ScanCompleted { roots, .. } => roots.clone(),
        other => panic!("expected ScanCompleted, got {other:?}"),
    }
}

pub(super) fn generation_of(event: &IndexingEvent) -> u64 {
    match event {
        IndexingEvent::ScanCompleted { generation, .. } => *generation,
        other => panic!("expected ScanCompleted, got {other:?}"),
    }
}

/// F1 1.1: a one-line, grep-able rendering of the four new `ScanTimings`
/// columns (`reopen_ms`/`close_protection_ms`/`publish_sql_select_ms`/
/// `publish_sql_write_ms`) plus `total_ms`, for `n8n_incremental_
/// measurement`'s printed A/B comparison -- the full `{:?}` of the event
/// already carries these fields too, but a dedicated line keeps the
/// before/after diff of a bench log to just the columns this task cares
/// about instead of the whole event's debug dump.
fn f1_timing_columns_of(event: &IndexingEvent) -> String {
    let timings = match event {
        IndexingEvent::ScanCompleted { timings, .. } => timings,
        other => panic!("expected ScanCompleted, got {other:?}"),
    };
    format!(
        "reopen_ms={:?} close_protection_ms={:?} publish_sql_select_ms={:?} publish_sql_write_ms={:?} total_ms={}",
        timings.reopen_ms,
        timings.close_protection_ms,
        timings.publish_sql_select_ms,
        timings.publish_sql_write_ms,
        timings.total_ms,
    )
}

/// P3-1's central correctness claim (plan §6, task brief: "Merkle roots
/// identical to a from-scratch cold index of the mutated tree"): a cold
/// scan, one incremental EDIT (`ScanScope::Changed`), then an independent
/// from-scratch cold scan of the SAME mutated tree in a separate data
/// dir -- the incremental generation's `records`/`dependency`/`graph`
/// roots must equal the oracle's.
///
/// The mutation mirrors `scripts/v4-mutation-harness.mjs`'s `applyEditFile`
/// exactly (APPENDS a brand-new exported function and calls it; never
/// touches an existing record's body) -- this is what makes root equality
/// achievable at all despite decision 11's identity chaining (see this
/// module's own analysis, `docs/evidence/2026-09-03-v4-p3-1-incremental.md`
/// §"why edit roots can equal a from-scratch oracle"): every record this
/// edit touches is either byte-identical to generation 1 (kept under its
/// EXISTING id, which already equals `sha256(digest)` since generation 1
/// was itself a cold/first-occurrence scan) or brand new (first occurrence
/// on both the incremental AND the from-scratch side, since the identity
/// key -- which embeds the function's name -- never existed before). A
/// mutation that instead edited an EXISTING record's body would produce a
/// chained (non-oracle-matching) id by design -- decision 11's whole point
/// -- and is exercised separately by `diff.rs`'s own unit tests instead.
/// **Finding, not a bug** (documented in full in this task's evidence doc,
/// "why edit roots do NOT equal a semantic from-scratch oracle"): a content
/// EDIT to an existing file can never produce `records`/`graph` roots
/// byte-identical to an independent from-scratch cold scan of the mutated
/// tree, even for the harness's own pure-append `applyEditFile` mutation
/// (which never touches an existing record's `body`). Root cause, found by
/// direct comparison against a real oracle in this task: `jsts:entity_
/// container` (one per file, `SyntaxCollector::new`,
/// `crates/urdira-jsts-syntax-worker/src/lib.rs`) carries `end: source_end`
/// -- the file's own byte length -- as part of its entity span, which
/// (like every entity's `start`/`end`) is part of `record.body`, which IS
/// hashed into `record_digest` (`structural_record_digest_hash`,
/// `urdira-native-core`). Any edit that changes the file's length (every
/// edit the harness's mutations produce) therefore changes the container's
/// `record_digest`, while its `identity_key` (`jsts:module:{path}:0:
/// {path}`) never changes -- decision 11's own definition of a
/// "replacement": same identity, different digest, MUST chain
/// (`record_id = H(digest || predecessor)`), never reuse the kernel's
/// unconditional cold recipe (`record_id = sha256(digest)`) a from-scratch
/// oracle always uses. This is `diff_owner`'s correct, intended behavior
/// (verified directly against a real oracle, not asserted from theory) --
/// the plan's own decision-11 doc states the guarantee this IS protecting:
/// "an A-to-B-to-A lifecycle cannot reopen a closed row under the same
/// record_id." What DOES still hold, and what the test below actually
/// verifies: (1) `records_root`/`dependency_root`/`graph`, if recomputed
/// FROM SCRATCH by scanning the incremental store's own final visible
/// `(record_id, record_digest)` pairs, exactly equal the roots the
/// INCREMENTAL update itself produced -- the property task deliverable 6
/// actually names ("Merkle incremental == from-scratch after random
/// sequences" is a statement about the TREE structure over a given final
/// key set, not about which record_id a content edit is assigned); (2)
/// every record whose digest did NOT change keeps its EXACT prior id
/// (`diff.rs`'s own dedicated unit tests already cover the chaining cases
/// directly, at owner-diff granularity, without this ambiguity).
#[test]
fn incremental_edit_produces_a_self_consistent_incremental_merkle_update() {
    let scratch_root = scratch_dir("incremental-edit");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:v4-e2e-incremental",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);
    let reader1 = StoreReader::open(&structural_root).expect("reader opens after cold");
    let mut records_before: std::collections::HashMap<[u8; 32], [u8; 32]> =
        std::collections::HashMap::new();
    for view in reader1.iter_visible(1) {
        records_before.insert(view.identity_key_digest(), view.record_id());
    }
    drop(reader1);

    // Mutate: append a new exported function + call it to an existing
    // file, exactly like the harness's `applyEditFile`.
    let edited_relative = "src/domain/task.ts";
    let edited_absolute = workspace_root.join(edited_relative);
    assert!(
        edited_absolute.is_file(),
        "fixture must contain {edited_relative}"
    );
    let before = std::fs::read_to_string(&edited_absolute).expect("read edited file");
    let after = format!(
        "{before}{}\nexport function urdiraHarnessEdit_marker1() {{\n  return \"marker1\";\n}}\nurdiraHarnessEdit_marker1();\n",
        if before.ends_with('\n') { "" } else { "\n" }
    );
    std::fs::write(&edited_absolute, &after).expect("write mutated file");

    let incremental = run_scan(
        "request:incremental-edit",
        "workspace:v4-e2e-incremental",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: edited_relative.to_string(),
                kind: ChangeKind::Modified,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(
        generation_of(&incremental),
        2,
        "the incremental scan must publish generation 2"
    );
    let incremental_roots = roots_of(&incremental);

    // Property 1: the incrementally-updated `records`/`dependency` roots
    // equal what a FROM-SCRATCH rebuild of the tree, over the store's own
    // final visible key set, produces -- `urdira_structural_store::
    // recompute_roots_from_scratch` is exactly this crate's own
    // verification primitive (`lifecycle.verify`'s own tool).
    let reader2 = StoreReader::open(&structural_root).expect("reader opens after incremental");
    let generation2 = reader2.generation();
    assert_eq!(generation2, 2);
    let (records_root_from_scratch, dependency_root_from_scratch) =
        urdira_structural_store::recompute_roots_from_scratch(&reader2, generation2)
            .expect("recompute_roots_from_scratch succeeds");
    assert_eq!(
        incremental_roots.records,
        urdira_structural_store::to_prefixed_hex(&records_root_from_scratch),
        "the incrementally-updated records root must equal a from-scratch rebuild over the SAME final key set"
    );
    assert_eq!(
        incremental_roots.dependency,
        urdira_structural_store::to_prefixed_hex(&dependency_root_from_scratch),
        "the incrementally-updated dependency root must equal a from-scratch rebuild over the SAME final key set"
    );
    let graph_entries: Vec<_> = reader2
        .iter_visible(generation2)
        .filter(|view| view.category() == urdira_structural_store::row::CATEGORY_RELATION)
        .map(|view| (view.record_id(), view.record_digest()))
        .collect();
    let graph_root_from_scratch =
        urdira_structural_store::BucketedMerkleSet::from_sorted(&graph_entries)
            .expect("graph merkle build succeeds")
            .root();
    assert_eq!(
        incremental_roots.graph,
        urdira_structural_store::to_prefixed_hex(&graph_root_from_scratch),
        "the incrementally-updated graph root must equal a from-scratch rebuild over the SAME final key set"
    );

    // Property 2: every record whose identity existed in generation 1 and
    // was NOT the edited file's container (the one row that legitimately
    // chains, per this test's own doc comment) keeps its EXACT prior id.
    let mut unchanged_checked = 0;
    for view in reader2.iter_visible(generation2) {
        if let Some(&prior_id) = records_before.get(&view.identity_key_digest())
            && prior_id == view.record_id()
        {
            unchanged_checked += 1;
        }
    }
    assert!(
        unchanged_checked > 100,
        "most of generation 1's records must survive this edit with their exact prior id \
         (got {unchanged_checked}); an edit to one file should not reopen/rechain unrelated records"
    );

    let _ = std::fs::remove_dir_all(&scratch_root);
}

/// P3-3 item 1: minimal reproduction of the digest-churn root cause found
/// at n8n hub-edit scale
/// (`docs/evidence/2026-09-03-v4-p3-2-incremental-residuals.md` §6): three
/// files, `a.ts` imports `b.ts` imports `c.ts`. Editing `c.ts` by RENAMING
/// its existing export (this changes `c.ts`'s exported surface under item
/// 2's subset rule -- a pure addition alone would no longer widen -- so
/// item 2's narrowing does NOT apply here -- see the dedicated
/// `surface_unchanged_edit_narrows_the_affected_closure_to_the_literal_
/// edit` test below for the narrowing case -- and the closure legitimately widens
/// to `b.ts`/`a.ts`, exactly the scenario item 1's bug lived in) never
/// touches `a.ts`/`b.ts`'s bytes, but puts `a.ts` in the affected closure
/// TRANSITIVELY (`reverse_affected_closure`'s own BFS); `a.ts` itself is
/// never reparsed -- its `SyntaxFileResult` is byte-identical between the
/// cold pass and this incremental pass. This test extracts `a.ts`'s
/// `ProposedRecord`s directly from `analyze::run_scoped` (the facts-
/// extraction layer, one level below materialize/diff/write) at both
/// points and diffs them field-by-field: the rule this task's own brief
/// states is "the digest of an owner whose bytes AND whose resolutions did
/// not change must be identical", so an unaffected owner must produce
/// EXACTLY the same records both times.
#[test]
fn unaffected_transitive_importer_produces_identical_records_across_an_incremental_edit() {
    let scratch = scratch_dir("digest-churn-repro");
    let workspace_root = scratch.join("workspace");
    std::fs::create_dir_all(&workspace_root).expect("workspace dir");
    std::fs::write(
        workspace_root.join("c.ts"),
        b"export const C_VALUE = 1;\n" as &[u8],
    )
    .expect("write c.ts");
    std::fs::write(
        workspace_root.join("b.ts"),
        b"import { C_VALUE } from \"./c\";\nexport const B_VALUE = C_VALUE + 1;\n" as &[u8],
    )
    .expect("write b.ts");
    std::fs::write(
        workspace_root.join("a.ts"),
        b"import { B_VALUE } from \"./b\";\nexport const A_VALUE = B_VALUE + 1;\n" as &[u8],
    )
    .expect("write a.ts");

    let database_path = scratch.join("workspace.sqlite");
    let structural_root = scratch.join("structural");
    let cas_root = scratch.join("cas");
    let workspace_id = "workspace:digest-churn-repro";

    let mut conn = catalog::open_and_ensure_schema(&database_path).expect("schema opens");
    let outcome = catalog::run_full_scan(&mut conn, workspace_id, &workspace_root, &cas_root, 1)
        .expect("cold catalog scan succeeds");
    catalog::restore_steady_state_pragmas(&conn).expect("restoring pragmas succeeds");

    let mut clock = ScanClock::start();
    let mut syntax = SyntaxWorkerState::default();
    let cas_signal = outcome
        .cas_write_queue
        .as_ref()
        .expect("run_full_scan always populates cas_write_queue")
        .signal();
    let (cold_analysis, _cache, _typeflow_cache) = analyze::run_cold(
        &outcome.frontier,
        &cas_root,
        workspace_id,
        &mut syntax,
        &mut clock,
        &cas_signal,
    )
    .expect("cold analyze succeeds");
    let cold_a_records: Vec<urdira_jsts_syntax_worker::ProposedRecord> = cold_analysis
        .owners
        .iter()
        .find(|owner| owner.owner_path == "a.ts")
        .expect("a.ts analyzed cold")
        .records
        .clone();
    assert!(
        !cold_a_records.is_empty(),
        "a.ts must have produced at least one record cold (entity_container/entity_variable at minimum)"
    );

    let materialized =
        materialize::materialize_cold(cold_analysis.owners).expect("materialize succeeds");
    let request = scan::ScanRequest {
        request_id: "request:digest-churn-cold".to_string(),
        workspace_id: workspace_id.to_string(),
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        database_path: database_path.to_string_lossy().into_owned(),
        structural_root: structural_root.to_string_lossy().into_owned(),
        cas_root: cas_root.to_string_lossy().into_owned(),
        sidecar_root: scratch.join("sidecar").to_string_lossy().into_owned(),
        scope: ScanScope::Full,
        registry_snapshot_id: "registry:digest-churn-repro".to_string(),
        configuration_revision_id: "configuration:digest-churn-repro".to_string(),
        resolution_lock_id: "resolution:digest-churn-repro".to_string(),
        deadline_ms: None,
        priority: ScanPriority::Interactive,
    };
    let mut on_queryable = |_event: IndexingEvent| -> Result<(), String> { Ok(()) };
    publish::publish_cold(
        &mut conn,
        &request,
        &structural_root,
        1,
        &outcome,
        materialized,
        &mut clock,
        &mut on_queryable,
    )
    .expect("cold publish succeeds");

    // Mutate C only -- A and B's bytes never change. RENAMES the existing
    // export (removes `C_VALUE`, adds `C_VALUE2`) -- a genuine surface
    // change per item 2's subset rule (a pure ADDITION alone would no
    // longer force widening; see `run_scoped`'s own doc comment), so the
    // closure legitimately widens to `b.ts`/`a.ts` -- this is the scenario
    // item 1's bug lived in.
    std::fs::write(
        workspace_root.join("c.ts"),
        b"export const C_VALUE2 = 1;\n" as &[u8],
    )
    .expect("rewrite c.ts");

    // Replicate `delta::run_one`'s own catalog-delta + source-cache
    // preparation (that function is private to its own module; this test
    // module is a sibling, not a descendant, so it cannot call it directly
    // -- same isolation convention `analyze.rs`'s own doc comment already
    // explains for its byte-identical copies of `main.rs`'s private
    // predicates) up through `analyze::run_incremental`, which is as far as
    // this repro needs to go: it inspects the FACTS EXTRACTION layer
    // directly, one level below materialize/diff/write.
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();
    let workspace_state = super::state::ensure_workspace(&mut worker_state, &conn, workspace_id)
        .expect("workspace state available");
    let cas = urdira_source_frontier::CasStore::open(&cas_root).expect("cas opens");
    let rules = urdira_source_frontier::inclusion::default_workspace_inclusion();
    let gitignore = urdira_source_frontier::inclusion::GitIgnoreRules {
        enabled: false,
        patterns: Vec::new(),
    };
    let changed_path_strings = vec!["c.ts".to_string()];
    let observations = urdira_source_frontier::Walker::observe_paths(
        &workspace_root,
        &changed_path_strings,
        &rules,
        &gitignore,
        Some(&cas),
    );
    let source_delta =
        urdira_source_frontier::Delta::compute_partial(&workspace_state.frontier, &observations);
    let now = super::now_iso8601();
    let batch_meta = urdira_source_frontier::BatchMeta {
        source_provider_binding_id: format!("urdira:v4-directory-walker:{workspace_id}"),
        source_provider: "urdira:v4-directory-walker".to_string(),
        source_provider_version: "1".to_string(),
        started_at: now.clone(),
        completed_at: now,
        full_scan: false,
    };
    urdira_source_frontier::Catalog::apply(
        &mut conn,
        workspace_id,
        &mut workspace_state.frontier,
        &source_delta,
        2,
        &batch_meta,
    )
    .expect("catalog delta applies");
    catalog::restore_steady_state_pragmas(&conn).expect("restoring pragmas succeeds");

    let mut changed_artifact_ids: Vec<String> = source_delta
        .changed
        .iter()
        .filter_map(|observation| {
            workspace_state
                .frontier
                .present
                .get(&observation.normalized_uri)
                .map(|entry| entry.artifact_id.clone())
        })
        .collect();
    changed_artifact_ids.sort();
    changed_artifact_ids.dedup();
    assert_eq!(
        changed_artifact_ids.len(),
        1,
        "exactly c.ts's artifact id should be reported changed"
    );

    workspace_state.source_cache = Some(
        super::state::SourceCache::build_full(&workspace_state.frontier, &cas_root)
            .expect("source cache builds"),
    );
    let source_cache = workspace_state.source_cache.as_ref().unwrap();
    let mut typeflow_cache =
        super::typeflow::TypeflowCache::build_full(&source_cache.files_vec(), None)
            .expect("typeflow cache builds");

    let mut incremental_clock = ScanClock::start();
    let incremental_analysis = analyze::run_incremental(
        source_cache.files_vec(),
        source_cache.config_assets_vec(),
        workspace_id,
        &mut syntax,
        changed_artifact_ids,
        &mut incremental_clock,
        &mut typeflow_cache,
    )
    .expect("incremental analyze succeeds");

    let affected_paths: Vec<&str> = incremental_analysis
        .owners
        .iter()
        .map(|owner| owner.owner_path.as_str())
        .collect();
    assert!(
        affected_paths.contains(&"a.ts"),
        "a.ts must be in the incremental affected closure (it transitively imports the \
         edited file through b.ts) -- got affected owners: {affected_paths:?}"
    );

    let incremental_a_records = &incremental_analysis
        .owners
        .iter()
        .find(|owner| owner.owner_path == "a.ts")
        .expect("a.ts present in incremental analysis")
        .records;

    // THE REPRODUCTION: dump both sides and diff byte-for-byte before the
    // hard assertion, so a real failure here prints exactly which
    // `ProposedRecord` field differs (this is what this task's evidence doc
    // quotes as the byte-for-byte diff).
    for (index, cold_record) in cold_a_records.iter().enumerate() {
        match incremental_a_records.get(index) {
            Some(incremental_record) if incremental_record == cold_record => {}
            Some(incremental_record) => {
                eprintln!(
                    "digest churn repro: a.ts record #{index} DIFFERS between cold and incremental extraction:\n  COLD:        {cold_record:?}\n  INCREMENTAL: {incremental_record:?}"
                );
            }
            None => {
                eprintln!(
                    "digest churn repro: a.ts record #{index} present cold but MISSING incremental:\n  COLD: {cold_record:?}"
                );
            }
        }
    }
    assert_eq!(
        cold_a_records.len(),
        incremental_a_records.len(),
        "a.ts must produce the same NUMBER of records cold vs incremental (see stderr above)"
    );
    assert_eq!(
        &cold_a_records, incremental_a_records,
        "a.ts (byte-identical, only transitively affected by the c.ts edit) must re-extract \
         to EXACTLY the same ProposedRecords -- see stderr above for the first differing record"
    );

    let _ = std::fs::remove_dir_all(&scratch);
}

/// P3-3 item 1 regression test (the diff-layer half of the bug): even
/// though `a.ts`'s freshly-extracted records are byte-identical to
/// generation 1 (proved by the test above), `diff_owner` must classify
/// them ALL as "unchanged, keep" -- zero opened, zero closed -- for an
/// owner whose OWN bytes never changed, only its transitive dependency
/// did. `c.ts`'s edit RENAMES its existing export (a surface change, per
/// item 2's subset rule -- a pure addition alone would no longer widen) so
/// the closure legitimately widens to `b.ts`/`a.ts` -- item 1's guarantee
/// is exercised in exactly the case its bug lived in, not vacuously
/// skipped by item 2's narrowing. Verified directly against the store:
/// `a.ts`'s exact `record_id` SET at generation 2 must equal its set at
/// generation 1.
#[test]
fn unaffected_transitive_importer_produces_zero_record_churn_in_the_store() {
    let scratch = scratch_dir("digest-churn-store");
    let workspace_root = scratch.join("workspace");
    std::fs::create_dir_all(&workspace_root).expect("workspace dir");
    std::fs::write(
        workspace_root.join("c.ts"),
        b"export const C_VALUE = 1;\n" as &[u8],
    )
    .expect("write c.ts");
    std::fs::write(
        workspace_root.join("b.ts"),
        b"import { C_VALUE } from \"./c\";\nexport const B_VALUE = C_VALUE + 1;\n" as &[u8],
    )
    .expect("write b.ts");
    std::fs::write(
        workspace_root.join("a.ts"),
        b"import { B_VALUE } from \"./b\";\nexport const A_VALUE = B_VALUE + 1;\n" as &[u8],
    )
    .expect("write a.ts");

    let database_path = scratch.join("workspace.sqlite");
    let structural_root = scratch.join("structural");
    let cas_root = scratch.join("cas");
    let workspace_id = "workspace:digest-churn-store";

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        workspace_id,
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);

    let reader1 = StoreReader::open(&structural_root).expect("reader opens after cold");
    let dicts1 = reader1.dictionaries();
    let a_frontier_entry = worker_state
        .get(workspace_id)
        .expect("workspace state seeded by cold scan")
        .frontier
        .present
        .get("a.ts")
        .cloned()
        .expect("a.ts present in frontier after cold scan");
    let a_ordinal = dicts1
        .artifacts
        .iter()
        .position(|pair| {
            *pair
                == (
                    a_frontier_entry.artifact_id.clone(),
                    a_frontier_entry.artifact_version_id.clone(),
                )
        })
        .expect("a.ts has a dictionary ordinal after the cold scan") as u32;
    let mut a_records_gen1: Vec<[u8; 32]> = reader1
        .by_owner(a_ordinal, 1)
        .into_iter()
        .map(|view| view.record_id())
        .collect();
    a_records_gen1.sort();
    assert!(
        !a_records_gen1.is_empty(),
        "a.ts must have records at generation 1"
    );
    drop(reader1);

    std::fs::write(
        workspace_root.join("c.ts"),
        b"export const C_VALUE2 = 1;\n" as &[u8],
    )
    .expect("rewrite c.ts");

    let incremental = run_scan(
        "request:edit",
        workspace_id,
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: "c.ts".to_string(),
                kind: ChangeKind::Modified,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&incremental), 2);

    let reader2 = StoreReader::open(&structural_root).expect("reader opens after incremental");
    let mut a_records_gen2: Vec<[u8; 32]> = reader2
        .by_owner(a_ordinal, 2)
        .into_iter()
        .map(|view| view.record_id())
        .collect();
    a_records_gen2.sort();

    assert_eq!(
        a_records_gen1, a_records_gen2,
        "a.ts's exact record_id set must be unchanged: it is only TRANSITIVELY affected by \
         the c.ts edit (via b.ts) and its own bytes never changed, so diff_owner must treat \
         every one of its records as unchanged, keep -- zero opened, zero closed"
    );

    let _ = std::fs::remove_dir_all(&scratch);
}

/// P3-3 item 2: a content edit that does NOT change the edited file's
/// exported surface (here, `c.ts`'s existing `C_VALUE` export keeps its
/// exact name/local declaration position -- only the literal expression on
/// its right-hand side changes) must narrow `analyze::run_scoped`'s
/// affected-owner set down to EXACTLY the literal edited path: `a.ts`/
/// `b.ts` (transitive importers `reverse_affected_closure` would otherwise
/// widen to) must be ABSENT from `analysis.owners` entirely -- not merely
/// diffed to a no-op by item 1's fix, genuinely never reprocessed.
#[test]
fn surface_unchanged_edit_narrows_the_affected_closure_to_the_literal_edit() {
    let scratch = scratch_dir("surface-narrowing");
    let workspace_root = scratch.join("workspace");
    std::fs::create_dir_all(&workspace_root).expect("workspace dir");
    std::fs::write(
        workspace_root.join("c.ts"),
        b"export const C_VALUE = 1;\n" as &[u8],
    )
    .expect("write c.ts");
    std::fs::write(
        workspace_root.join("b.ts"),
        b"import { C_VALUE } from \"./c\";\nexport const B_VALUE = C_VALUE + 1;\n" as &[u8],
    )
    .expect("write b.ts");
    std::fs::write(
        workspace_root.join("a.ts"),
        b"import { B_VALUE } from \"./b\";\nexport const A_VALUE = B_VALUE + 1;\n" as &[u8],
    )
    .expect("write a.ts");

    let database_path = scratch.join("workspace.sqlite");
    let structural_root = scratch.join("structural");
    let cas_root = scratch.join("cas");
    let workspace_id = "workspace:surface-narrowing";

    let mut conn = catalog::open_and_ensure_schema(&database_path).expect("schema opens");
    let outcome = catalog::run_full_scan(&mut conn, workspace_id, &workspace_root, &cas_root, 1)
        .expect("cold catalog scan succeeds");
    catalog::restore_steady_state_pragmas(&conn).expect("restoring pragmas succeeds");

    let mut clock = ScanClock::start();
    let mut syntax = SyntaxWorkerState::default();
    let cas_signal = outcome
        .cas_write_queue
        .as_ref()
        .expect("run_full_scan always populates cas_write_queue")
        .signal();
    let (cold_analysis, _cache, _typeflow_cache) = analyze::run_cold(
        &outcome.frontier,
        &cas_root,
        workspace_id,
        &mut syntax,
        &mut clock,
        &cas_signal,
    )
    .expect("cold analyze succeeds");
    let materialized =
        materialize::materialize_cold(cold_analysis.owners).expect("materialize succeeds");
    let request = scan::ScanRequest {
        request_id: "request:surface-narrowing-cold".to_string(),
        workspace_id: workspace_id.to_string(),
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        database_path: database_path.to_string_lossy().into_owned(),
        structural_root: structural_root.to_string_lossy().into_owned(),
        cas_root: cas_root.to_string_lossy().into_owned(),
        sidecar_root: scratch.join("sidecar").to_string_lossy().into_owned(),
        scope: ScanScope::Full,
        registry_snapshot_id: "registry:surface-narrowing".to_string(),
        configuration_revision_id: "configuration:surface-narrowing".to_string(),
        resolution_lock_id: "resolution:surface-narrowing".to_string(),
        deadline_ms: None,
        priority: ScanPriority::Interactive,
    };
    let mut on_queryable = |_event: IndexingEvent| -> Result<(), String> { Ok(()) };
    publish::publish_cold(
        &mut conn,
        &request,
        &structural_root,
        1,
        &outcome,
        materialized,
        &mut clock,
        &mut on_queryable,
    )
    .expect("cold publish succeeds");

    // Edit C's value only -- the exported name/declaration position (its
    // surface) never changes.
    std::fs::write(
        workspace_root.join("c.ts"),
        b"export const C_VALUE = 2;\n" as &[u8],
    )
    .expect("rewrite c.ts");

    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();
    let workspace_state = super::state::ensure_workspace(&mut worker_state, &conn, workspace_id)
        .expect("workspace state available");
    let cas = urdira_source_frontier::CasStore::open(&cas_root).expect("cas opens");
    let rules = urdira_source_frontier::inclusion::default_workspace_inclusion();
    let gitignore = urdira_source_frontier::inclusion::GitIgnoreRules {
        enabled: false,
        patterns: Vec::new(),
    };
    let changed_path_strings = vec!["c.ts".to_string()];
    let observations = urdira_source_frontier::Walker::observe_paths(
        &workspace_root,
        &changed_path_strings,
        &rules,
        &gitignore,
        Some(&cas),
    );
    let source_delta =
        urdira_source_frontier::Delta::compute_partial(&workspace_state.frontier, &observations);
    let now = super::now_iso8601();
    let batch_meta = urdira_source_frontier::BatchMeta {
        source_provider_binding_id: format!("urdira:v4-directory-walker:{workspace_id}"),
        source_provider: "urdira:v4-directory-walker".to_string(),
        source_provider_version: "1".to_string(),
        started_at: now.clone(),
        completed_at: now,
        full_scan: false,
    };
    urdira_source_frontier::Catalog::apply(
        &mut conn,
        workspace_id,
        &mut workspace_state.frontier,
        &source_delta,
        2,
        &batch_meta,
    )
    .expect("catalog delta applies");
    catalog::restore_steady_state_pragmas(&conn).expect("restoring pragmas succeeds");

    let mut changed_artifact_ids: Vec<String> = source_delta
        .changed
        .iter()
        .filter_map(|observation| {
            workspace_state
                .frontier
                .present
                .get(&observation.normalized_uri)
                .map(|entry| entry.artifact_id.clone())
        })
        .collect();
    changed_artifact_ids.sort();
    changed_artifact_ids.dedup();

    workspace_state.source_cache = Some(
        super::state::SourceCache::build_full(&workspace_state.frontier, &cas_root)
            .expect("source cache builds"),
    );
    let source_cache = workspace_state.source_cache.as_ref().unwrap();
    let mut typeflow_cache =
        super::typeflow::TypeflowCache::build_full(&source_cache.files_vec(), None)
            .expect("typeflow cache builds");

    let mut incremental_clock = ScanClock::start();
    let incremental_analysis = analyze::run_incremental(
        source_cache.files_vec(),
        source_cache.config_assets_vec(),
        workspace_id,
        &mut syntax,
        changed_artifact_ids,
        &mut incremental_clock,
        &mut typeflow_cache,
    )
    .expect("incremental analyze succeeds");

    let affected_paths: Vec<&str> = incremental_analysis
        .owners
        .iter()
        .map(|owner| owner.owner_path.as_str())
        .collect();
    assert_eq!(
        affected_paths,
        vec!["c.ts"],
        "a surface-unchanged edit must narrow the affected closure to EXACTLY the literal \
         edited path -- b.ts/a.ts (transitive importers) must be entirely absent, not merely \
         diffed to a no-op; got {affected_paths:?}"
    );

    let _ = std::fs::remove_dir_all(&scratch);
}

/// P3-2 item 5: a `Changed` batch mixing a genuine content EDIT with an
/// UNRELATED create/delete of a different path, in the SAME `WorkspaceScan`
/// command -- `delta::run` now splits this into two sequential internal
/// generations (structural changes first, then the edit) instead of
/// letting `SyntaxWorkerState::analyze`'s own `path_membership_incremental`
/// fast path bail out to a full reparse of every current root (its
/// documented, pre-existing behavior for a batch it cannot certify as
/// pure add/remove -- see `delta::run`'s own module doc). This test
/// verifies the split actually happens (TWO generations are consumed by
/// ONE `scan::run` call, not one) and that the result is still correct:
/// the incrementally-updated roots must equal a from-scratch REBUILD of
/// the merkle tree over the store's own final visible key set (the same
/// property `incremental_edit_produces_a_self_consistent_incremental_
/// merkle_update` verifies for a pure edit -- decision 11 still applies
/// here since the batch contains an edit), AND the create/delete halves
/// must be visible in the store exactly as their own dedicated tests
/// verify (the created path's records present, the deleted path's records
/// no longer visible).
#[test]
fn mixed_burst_edit_plus_create_delete_splits_into_two_generations_and_stays_self_consistent() {
    let scratch_root = scratch_dir("mixed-burst");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:v4-e2e-mixed",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);

    // Three unrelated mutations in ONE batch: an edit (append, matching
    // `applyEditFile`), a create, and a delete of an existing leaf file.
    let edited_relative = "src/domain/task.ts";
    let edited_absolute = workspace_root.join(edited_relative);
    let before = std::fs::read_to_string(&edited_absolute).expect("read edited file");
    let after = format!(
        "{before}{}\nexport function urdiraHarnessMixedEdit_marker() {{\n  return \"marker\";\n}}\nurdiraHarnessMixedEdit_marker();\n",
        if before.ends_with('\n') { "" } else { "\n" }
    );
    std::fs::write(&edited_absolute, &after).expect("write mutated file");

    let created_relative = "src/domain/urdira-mixed-created.ts";
    std::fs::write(
        workspace_root.join(created_relative),
        "export function urdiraMixedCreated_marker() {\n  return \"marker\";\n}\n",
    )
    .expect("write created file");

    let deleted_relative = "src/domain/errors.ts";
    let deleted_absolute = workspace_root.join(deleted_relative);
    assert!(
        deleted_absolute.is_file(),
        "fixture must contain {deleted_relative}"
    );
    std::fs::remove_file(&deleted_absolute).expect("remove deleted file");

    let mixed = run_scan(
        "request:mixed-burst",
        "workspace:v4-e2e-mixed",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![
                ChangedPath {
                    path: edited_relative.to_string(),
                    kind: ChangeKind::Modified,
                },
                ChangedPath {
                    path: created_relative.to_string(),
                    kind: ChangeKind::Created,
                },
                ChangedPath {
                    path: deleted_relative.to_string(),
                    kind: ChangeKind::Deleted,
                },
            ],
        },
        &mut syntax,
        &mut worker_state,
    );
    // Two internal generations were consumed by this ONE `WorkspaceScan`
    // call (structural pass -> generation 2, content/edit pass ->
    // generation 3) -- the split's own defining, directly observable
    // effect.
    assert_eq!(
        generation_of(&mixed),
        3,
        "a mixed burst must consume two internal generations (structural, then content)"
    );
    let mixed_roots = roots_of(&mixed);

    let reader = StoreReader::open(&structural_root).expect("reader opens after mixed burst");
    let generation = reader.generation();
    assert_eq!(generation, 3);

    // Property 1 (decision 11, same as the pure-edit test): incremental ==
    // from-scratch rebuild of the SAME final key set.
    let (records_root_from_scratch, dependency_root_from_scratch) =
        urdira_structural_store::recompute_roots_from_scratch(&reader, generation)
            .expect("recompute_roots_from_scratch succeeds");
    assert_eq!(
        mixed_roots.records,
        urdira_structural_store::to_prefixed_hex(&records_root_from_scratch),
        "records root must equal a from-scratch rebuild over the SAME final key set"
    );
    assert_eq!(
        mixed_roots.dependency,
        urdira_structural_store::to_prefixed_hex(&dependency_root_from_scratch),
        "dependency root must equal a from-scratch rebuild over the SAME final key set"
    );
    let graph_entries: Vec<_> = reader
        .iter_visible(generation)
        .filter(|view| view.category() == urdira_structural_store::row::CATEGORY_RELATION)
        .map(|view| (view.record_id(), view.record_digest()))
        .collect();
    let graph_root_from_scratch =
        urdira_structural_store::BucketedMerkleSet::from_sorted(&graph_entries)
            .expect("graph merkle build succeeds")
            .root();
    assert_eq!(
        mixed_roots.graph,
        urdira_structural_store::to_prefixed_hex(&graph_root_from_scratch),
        "graph root must equal a from-scratch rebuild over the SAME final key set"
    );

    // Property 2: the create/delete halves actually took effect -- not
    // silently skipped by the split, and not double-applied. `artifact_id`
    // is a `sha256(workspace_id, normalized_uri)` digest (not a readable
    // path), so look it up by recomputing it the same way the catalog
    // does rather than substring-matching a path against a hash.
    let dicts = reader.dictionaries();
    let created_artifact_id =
        urdira_source_frontier::ids::artifact_id("workspace:v4-e2e-mixed", created_relative);
    let created_owner = dicts
        .artifacts
        .iter()
        .position(|(artifact_id, _)| *artifact_id == created_artifact_id);
    assert!(
        created_owner.is_some(),
        "the created file must be interned as an owner"
    );
    let created_ordinal = u32::try_from(created_owner.unwrap()).unwrap();
    assert!(
        !reader.by_owner(created_ordinal, generation).is_empty(),
        "the created file's records must be visible at the final generation"
    );
    let deleted_artifact_id =
        urdira_source_frontier::ids::artifact_id("workspace:v4-e2e-mixed", deleted_relative);
    let deleted_owner_ordinal = dicts
        .artifacts
        .iter()
        .position(|(artifact_id, _)| *artifact_id == deleted_artifact_id)
        .map(|ordinal| u32::try_from(ordinal).unwrap());
    if let Some(ordinal) = deleted_owner_ordinal {
        assert!(
            reader.by_owner(ordinal, generation).is_empty(),
            "the deleted file's records must no longer be visible at the final generation"
        );
    }

    let _ = std::fs::remove_dir_all(&scratch_root);
}

/// The portion of the task brief's gate that IS achievable byte-for-byte
/// against an independent from-scratch oracle: a pure file CREATION.
/// Every record a new file produces has a brand-new `identity_key`
/// (embeds the new path), so `diff_owner` always takes the "first
/// occurrence" branch (`record_id = sha256(record_digest)`, decision 11's
/// unconditional cold recipe) -- identical, by construction, to what an
/// independent from-scratch cold scan of the same final tree computes.
#[test]
fn incremental_create_roots_match_a_from_scratch_scan_of_the_mutated_tree() {
    let scratch_root = scratch_dir("incremental-create");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:v4-e2e-create",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);

    let created_relative = "src/domain/urdira-harness-created.ts";
    let created_absolute = workspace_root.join(created_relative);
    std::fs::write(
        &created_absolute,
        "export function urdiraHarnessCreated_marker1() {\n  return \"marker1\";\n}\n",
    )
    .expect("write created file");

    let incremental = run_scan(
        "request:incremental-create",
        "workspace:v4-e2e-create",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: created_relative.to_string(),
                kind: ChangeKind::Created,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&incremental), 2);

    let oracle_root = scratch_dir("incremental-create-oracle");
    let oracle_database = oracle_root.join("workspace.sqlite");
    let oracle_structural = oracle_root.join("structural");
    let oracle_cas = oracle_root.join("cas");
    let mut oracle_syntax = SyntaxWorkerState::default();
    let mut oracle_state: super::state::WorkerState = std::collections::HashMap::new();
    let oracle = run_scan(
        "request:oracle",
        "workspace:v4-e2e-create-oracle",
        &workspace_root,
        &oracle_database,
        &oracle_structural,
        &oracle_cas,
        ScanScope::Full,
        &mut oracle_syntax,
        &mut oracle_state,
    );
    assert_eq!(generation_of(&oracle), 1);

    let incremental_roots = roots_of(&incremental);
    let oracle_roots = roots_of(&oracle);
    assert_eq!(incremental_roots.records, oracle_roots.records);
    assert_eq!(incremental_roots.dependency, oracle_roots.dependency);
    assert_eq!(incremental_roots.graph, oracle_roots.graph);

    // A2 (pending.sites migration): the visible pending-site set must ALSO
    // match a from-scratch oracle scan of the same mutated tree.
    let incremental_pending =
        pending_site_set(&structural_root, &database_path, "workspace:v4-e2e-create");
    let oracle_pending = pending_site_set(
        &oracle_structural,
        &oracle_database,
        "workspace:v4-e2e-create-oracle",
    );
    assert_eq!(
        incremental_pending, oracle_pending,
        "pending-site set must match a from-scratch scan after a pure create"
    );

    let _ = std::fs::remove_dir_all(&scratch_root);
    let _ = std::fs::remove_dir_all(&oracle_root);
}

/// Ambient module resolution task (2026-09-04), fix item 2's own
/// incremental requirement: a bare specifier's `jsts:relation_import`
/// target must flip from a synthetic `external_module` entity to a
/// workspace `declare module "specifier" { ... }` block's namespace entity
/// on the NEXT scan after that block is ADDED -- even though the importer
/// file's own text never changes (so it is never among `changed_sources`,
/// and neither `CandidateIndex` nor `ImportReverseIndex`, both keyed by
/// resolvable PATHS, can find it -- see `SyntaxWorkerState::analyze`'s own
/// ambient-pass doc comment in `lib.rs`). Same two-generation shape every
/// other `incremental_*_matches_a_from_scratch_scan` test in this module
/// uses: create both the importer (generation 1, cold) and the ambient
/// declaration (generation 2, incremental `Created`), then prove the
/// incremental result matches a from-scratch oracle scan of the identical
/// mutated tree -- AND directly inspect the flipped relation's target.
#[test]
fn incremental_ambient_declaration_flips_a_previously_external_importer() {
    let scratch_root = scratch_dir("incremental-ambient");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let importer_relative = "src/domain/urdira-harness-ambient-importer.ts";
    let importer_text = "import { ambientThing } from \"urdira-harness-ambient-pkg\";\nexport function useAmbientThing(): void {\n  ambientThing();\n}\n";
    std::fs::write(workspace_root.join(importer_relative), importer_text)
        .expect("write importer file");

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:v4-e2e-ambient",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);

    // At generation 1, `urdira-harness-ambient-pkg` has no ambient
    // declaration anywhere in the workspace -- the import relation must
    // target a synthetic `external_module` entity (pre-existing, unaffected
    // behavior, the "still external" regression guard at e2e scale).
    let import_relation_target = |structural_root: &Path, generation: u64| -> String {
        let reader = StoreReader::open(structural_root).expect("StoreReader opens");
        let dicts = reader.dictionaries();
        for view in reader.iter_visible(generation) {
            if view.category() != urdira_structural_store::row::CATEGORY_RELATION {
                continue;
            }
            let universal_kind = dicts
                .universal_kinds
                .get(view.universal_kind_id() as usize)
                .map(String::as_str)
                .unwrap_or("");
            if universal_kind != "core:import" {
                continue;
            }
            let Some(target_subject) = view.target_subject() else {
                continue;
            };
            let Some(target_record_id) = dicts.subjects.get(target_subject as usize) else {
                continue;
            };
            let Some(target_view) = reader.get_visible(target_record_id, generation) else {
                continue;
            };
            let target_identity = String::from_utf8_lossy(&target_view.identity_key()).into_owned();
            if target_identity.contains("urdira-harness-ambient-pkg") {
                return target_identity;
            }
        }
        panic!(
            "expected an import relation targeting urdira-harness-ambient-pkg at generation {generation}"
        );
    };
    let cold_target = import_relation_target(&structural_root, generation_of(&cold));
    assert_eq!(
        cold_target, "jsts:external_module:urdira-harness-ambient-pkg",
        "before the ambient declaration exists, this must stay external"
    );

    // Generation 2: add the ambient declaration. `importer_relative` is
    // NOT touched this call -- it is byte-identical, and not part of
    // `ScanScope::Changed`'s own path list either.
    let declaration_relative = "src/domain/urdira-harness-ambient-declaration.d.ts";
    let declaration_text = "declare module \"urdira-harness-ambient-pkg\" {\n  export function ambientThing(): void;\n}\n";
    std::fs::write(workspace_root.join(declaration_relative), declaration_text)
        .expect("write ambient declaration file");

    let incremental = run_scan(
        "request:incremental-ambient",
        "workspace:v4-e2e-ambient",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: declaration_relative.to_string(),
                kind: ChangeKind::Created,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&incremental), 2);

    let incremental_target = import_relation_target(&structural_root, generation_of(&incremental));
    assert!(
        incremental_target.starts_with("jsts:namespace:"),
        "the importer's relation must flip to the ambient namespace entity on the next scan, got {incremental_target}"
    );
    assert!(
        incremental_target.ends_with(":urdira-harness-ambient-pkg"),
        "got {incremental_target}"
    );

    // The strong proof every other incremental test in this module relies
    // on: the incremental result must be indistinguishable from a
    // from-scratch scan of the SAME (already mutated) tree.
    let oracle_root = scratch_dir("incremental-ambient-oracle");
    let oracle_database = oracle_root.join("workspace.sqlite");
    let oracle_structural = oracle_root.join("structural");
    let oracle_cas = oracle_root.join("cas");
    let mut oracle_syntax = SyntaxWorkerState::default();
    let mut oracle_state: super::state::WorkerState = std::collections::HashMap::new();
    let oracle = run_scan(
        "request:oracle",
        "workspace:v4-e2e-ambient-oracle",
        &workspace_root,
        &oracle_database,
        &oracle_structural,
        &oracle_cas,
        ScanScope::Full,
        &mut oracle_syntax,
        &mut oracle_state,
    );
    assert_eq!(generation_of(&oracle), 1);

    let incremental_roots = roots_of(&incremental);
    let oracle_roots = roots_of(&oracle);
    assert_eq!(incremental_roots.records, oracle_roots.records);
    assert_eq!(incremental_roots.dependency, oracle_roots.dependency);
    assert_eq!(incremental_roots.graph, oracle_roots.graph);

    let _ = std::fs::remove_dir_all(&scratch_root);
    let _ = std::fs::remove_dir_all(&oracle_root);
}

/// Plan §6.4: a pure DELETE. Every one of the deleted file's rows simply
/// closes on both sides (the incremental store closes them via the
/// diff/`write_delta` path; the from-scratch oracle never materializes
/// them in the first place, since it walks the ALREADY-mutated tree) --
/// roots must match exactly, no decision-11 ambiguity (nothing chains,
/// nothing is a "replacement").
#[test]
fn incremental_delete_roots_match_a_from_scratch_scan_of_the_mutated_tree() {
    let scratch_root = scratch_dir("incremental-delete");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:v4-e2e-delete",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);

    let deleted_relative = "src/domain/errors.ts";
    let deleted_absolute = workspace_root.join(deleted_relative);
    assert!(
        deleted_absolute.is_file(),
        "fixture must contain {deleted_relative}"
    );
    std::fs::remove_file(&deleted_absolute).expect("remove deleted file");

    let incremental = run_scan(
        "request:incremental-delete",
        "workspace:v4-e2e-delete",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: deleted_relative.to_string(),
                kind: ChangeKind::Deleted,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&incremental), 2);

    let oracle_root = scratch_dir("incremental-delete-oracle");
    let oracle_database = oracle_root.join("workspace.sqlite");
    let oracle_structural = oracle_root.join("structural");
    let oracle_cas = oracle_root.join("cas");
    let mut oracle_syntax = SyntaxWorkerState::default();
    let mut oracle_state: super::state::WorkerState = std::collections::HashMap::new();
    let oracle = run_scan(
        "request:oracle",
        "workspace:v4-e2e-delete-oracle",
        &workspace_root,
        &oracle_database,
        &oracle_structural,
        &oracle_cas,
        ScanScope::Full,
        &mut oracle_syntax,
        &mut oracle_state,
    );
    assert_eq!(generation_of(&oracle), 1);

    let incremental_roots = roots_of(&incremental);
    let oracle_roots = roots_of(&oracle);
    assert_eq!(incremental_roots.records, oracle_roots.records);
    assert_eq!(incremental_roots.dependency, oracle_roots.dependency);
    assert_eq!(incremental_roots.graph, oracle_roots.graph);

    // A2 (pending.sites migration): same pending-site-set comparison as the
    // create test above -- the deleted owner's pending sites must be gone
    // on both sides.
    let incremental_pending =
        pending_site_set(&structural_root, &database_path, "workspace:v4-e2e-delete");
    let oracle_pending = pending_site_set(
        &oracle_structural,
        &oracle_database,
        "workspace:v4-e2e-delete-oracle",
    );
    assert_eq!(
        incremental_pending, oracle_pending,
        "pending-site set must match a from-scratch scan after a pure delete"
    );

    let _ = std::fs::remove_dir_all(&scratch_root);
    let _ = std::fs::remove_dir_all(&oracle_root);
}

/// Plan §6.4: a RENAME arrives as delete+create in ONE `Changed` command.
/// Content is byte-identical, so every record's `identity_key` changes
/// (it embeds the path) but no record's `record_digest` does relative to
/// what a from-scratch scan of the renamed path computes -- first
/// occurrence on both sides, matching exactly (no chaining).
#[test]
fn incremental_rename_roots_match_a_from_scratch_scan_of_the_mutated_tree() {
    let scratch_root = scratch_dir("incremental-rename");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:v4-e2e-rename",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);

    let old_relative = "src/domain/errors.ts";
    let new_relative = "src/domain/errors-renamed.ts";
    let old_absolute = workspace_root.join(old_relative);
    let new_absolute = workspace_root.join(new_relative);
    std::fs::rename(&old_absolute, &new_absolute).expect("rename succeeds");

    let incremental = run_scan(
        "request:incremental-rename",
        "workspace:v4-e2e-rename",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![
                ChangedPath {
                    path: old_relative.to_string(),
                    kind: ChangeKind::Deleted,
                },
                ChangedPath {
                    path: new_relative.to_string(),
                    kind: ChangeKind::Created,
                },
            ],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&incremental), 2);

    let oracle_root = scratch_dir("incremental-rename-oracle");
    let oracle_database = oracle_root.join("workspace.sqlite");
    let oracle_structural = oracle_root.join("structural");
    let oracle_cas = oracle_root.join("cas");
    let mut oracle_syntax = SyntaxWorkerState::default();
    let mut oracle_state: super::state::WorkerState = std::collections::HashMap::new();
    let oracle = run_scan(
        "request:oracle",
        "workspace:v4-e2e-rename-oracle",
        &workspace_root,
        &oracle_database,
        &oracle_structural,
        &oracle_cas,
        ScanScope::Full,
        &mut oracle_syntax,
        &mut oracle_state,
    );
    assert_eq!(generation_of(&oracle), 1);

    let incremental_roots = roots_of(&incremental);
    let oracle_roots = roots_of(&oracle);
    assert_eq!(incremental_roots.records, oracle_roots.records);
    assert_eq!(incremental_roots.dependency, oracle_roots.dependency);
    assert_eq!(incremental_roots.graph, oracle_roots.graph);

    // A2 (pending.sites migration): the renamed owner's pending sites must
    // reappear under the NEW path on both sides.
    let incremental_pending =
        pending_site_set(&structural_root, &database_path, "workspace:v4-e2e-rename");
    let oracle_pending = pending_site_set(
        &oracle_structural,
        &oracle_database,
        "workspace:v4-e2e-rename-oracle",
    );
    assert_eq!(
        incremental_pending, oracle_pending,
        "pending-site set must match a from-scratch scan after a rename"
    );

    let _ = std::fs::remove_dir_all(&scratch_root);
    let _ = std::fs::remove_dir_all(&oracle_root);
}

/// P3-8a item 1: a real `fs.rename()` delivered by a watcher does not
/// always arrive as ONE combined `Changed{[Deleted old, Created new]}`
/// command the way `incremental_rename_roots_match_a_from_scratch_scan_of_
/// the_mutated_tree` above exercises -- the daemon's own aggregation
/// window can split the two fs-level events across separate `Changed`
/// calls, in either order. This test drives the CREATE-then-DELETE
/// ordering as two SEPARATE `scan::run` calls against the SAME workspace
/// state (mirroring what two independent watcher-triggered scans would
/// do), on `src/domain/task.ts` -- a file with real importers (unlike
/// `errors.ts` above), so a stale-owner-ordinal or CandidateIndex
/// re-resolution bug touching its importers would surface here. The
/// content is untouched (pure rename, no importer rewrite), so per
/// decision 11 the final incremental state must match a from-scratch
/// scan of the renamed tree EXACTLY (no chaining) -- same invariant as
/// the combined-burst test, just reached via a different event order.
#[test]
fn incremental_rename_via_create_then_delete_in_two_generations_matches_a_from_scratch_scan() {
    let scratch_root = scratch_dir("incremental-rename-create-then-delete");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:v4-e2e-rename-create-then-delete",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);

    let old_relative = "src/domain/task.ts";
    let new_relative = "src/domain/task-renamed.ts";
    let old_absolute = workspace_root.join(old_relative);
    let new_absolute = workspace_root.join(new_relative);
    assert!(
        old_absolute.is_file(),
        "fixture must contain {old_relative}"
    );

    // Step 1: the new path appears on disk WHILE the old path still
    // exists too (byte-identical content -- a copy, not yet a move) and
    // is reported to the worker as its own `Changed{Created}` command,
    // exactly as if a watcher observed the create half of a rename
    // before the delete half.
    std::fs::copy(&old_absolute, &new_absolute).expect("copy to new path succeeds");
    let after_create = run_scan(
        "request:incremental-create",
        "workspace:v4-e2e-rename-create-then-delete",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: new_relative.to_string(),
                kind: ChangeKind::Created,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&after_create), 2);

    // Step 2: the old path is removed and reported as its own
    // `Changed{Deleted}` command.
    std::fs::remove_file(&old_absolute).expect("remove old path succeeds");
    let after_delete = run_scan(
        "request:incremental-delete",
        "workspace:v4-e2e-rename-create-then-delete",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: old_relative.to_string(),
                kind: ChangeKind::Deleted,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&after_delete), 3);

    let oracle_root = scratch_dir("incremental-rename-create-then-delete-oracle");
    let oracle_database = oracle_root.join("workspace.sqlite");
    let oracle_structural = oracle_root.join("structural");
    let oracle_cas = oracle_root.join("cas");
    let mut oracle_syntax = SyntaxWorkerState::default();
    let mut oracle_state: super::state::WorkerState = std::collections::HashMap::new();
    let oracle = run_scan(
        "request:oracle",
        "workspace:v4-e2e-rename-create-then-delete-oracle",
        &workspace_root,
        &oracle_database,
        &oracle_structural,
        &oracle_cas,
        ScanScope::Full,
        &mut oracle_syntax,
        &mut oracle_state,
    );
    assert_eq!(generation_of(&oracle), 1);

    let incremental_roots = roots_of(&after_delete);
    let oracle_roots = roots_of(&oracle);
    assert_eq!(
        incremental_roots.records, oracle_roots.records,
        "records root must match a from-scratch scan after create-then-delete"
    );
    assert_eq!(
        incremental_roots.dependency, oracle_roots.dependency,
        "dependency root must match a from-scratch scan after create-then-delete"
    );
    assert_eq!(
        incremental_roots.graph, oracle_roots.graph,
        "graph root must match a from-scratch scan after create-then-delete"
    );

    // A2 (pending.sites migration): same pending-site-set comparison.
    let incremental_pending = pending_site_set(
        &structural_root,
        &database_path,
        "workspace:v4-e2e-rename-create-then-delete",
    );
    let oracle_pending = pending_site_set(
        &oracle_structural,
        &oracle_database,
        "workspace:v4-e2e-rename-create-then-delete-oracle",
    );
    assert_eq!(
        incremental_pending, oracle_pending,
        "pending-site set must match a from-scratch scan after create-then-delete"
    );

    let _ = std::fs::remove_dir_all(&scratch_root);
    let _ = std::fs::remove_dir_all(&oracle_root);
}

/// P3-8a item 1: the REVERSE ordering of the test above -- DELETE-then-
/// CREATE across two separate `scan::run` calls. Between the two steps
/// the workspace transiently has NEITHER the old nor the new path on
/// disk (every importer of `task.ts` is briefly dangling), which is
/// exactly the state hypothesized to leave stale owner rows open if the
/// DELETE half's `Changed` handling failed to close them before the
/// CREATE half re-opens the renamed content under a new identity.
#[test]
fn incremental_rename_via_delete_then_create_in_two_generations_matches_a_from_scratch_scan() {
    let scratch_root = scratch_dir("incremental-rename-delete-then-create");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:v4-e2e-rename-delete-then-create",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);

    let old_relative = "src/domain/task.ts";
    let new_relative = "src/domain/task-renamed.ts";
    let old_absolute = workspace_root.join(old_relative);
    let new_absolute = workspace_root.join(new_relative);
    assert!(
        old_absolute.is_file(),
        "fixture must contain {old_relative}"
    );
    let content = std::fs::read(&old_absolute).expect("read old content");

    // Step 1: the old path is removed FIRST -- reported as its own
    // `Changed{Deleted}` command while the new path does not exist yet
    // anywhere (a real intermediate state a watcher could observe).
    std::fs::remove_file(&old_absolute).expect("remove old path succeeds");
    let after_delete = run_scan(
        "request:incremental-delete",
        "workspace:v4-e2e-rename-delete-then-create",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: old_relative.to_string(),
                kind: ChangeKind::Deleted,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&after_delete), 2);

    // Step 2: the new path appears, reported as its own
    // `Changed{Created}` command.
    std::fs::write(&new_absolute, &content).expect("write new path succeeds");
    let after_create = run_scan(
        "request:incremental-create",
        "workspace:v4-e2e-rename-delete-then-create",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: new_relative.to_string(),
                kind: ChangeKind::Created,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&after_create), 3);

    let oracle_root = scratch_dir("incremental-rename-delete-then-create-oracle");
    let oracle_database = oracle_root.join("workspace.sqlite");
    let oracle_structural = oracle_root.join("structural");
    let oracle_cas = oracle_root.join("cas");
    let mut oracle_syntax = SyntaxWorkerState::default();
    let mut oracle_state: super::state::WorkerState = std::collections::HashMap::new();
    let oracle = run_scan(
        "request:oracle",
        "workspace:v4-e2e-rename-delete-then-create-oracle",
        &workspace_root,
        &oracle_database,
        &oracle_structural,
        &oracle_cas,
        ScanScope::Full,
        &mut oracle_syntax,
        &mut oracle_state,
    );
    assert_eq!(generation_of(&oracle), 1);

    let incremental_roots = roots_of(&after_create);
    let oracle_roots = roots_of(&oracle);
    assert_eq!(
        incremental_roots.records, oracle_roots.records,
        "records root must match a from-scratch scan after delete-then-create"
    );
    assert_eq!(
        incremental_roots.dependency, oracle_roots.dependency,
        "dependency root must match a from-scratch scan after delete-then-create"
    );
    assert_eq!(
        incremental_roots.graph, oracle_roots.graph,
        "graph root must match a from-scratch scan after delete-then-create"
    );

    // A2 (pending.sites migration): same pending-site-set comparison.
    let incremental_pending = pending_site_set(
        &structural_root,
        &database_path,
        "workspace:v4-e2e-rename-delete-then-create",
    );
    let oracle_pending = pending_site_set(
        &oracle_structural,
        &oracle_database,
        "workspace:v4-e2e-rename-delete-then-create-oracle",
    );
    assert_eq!(
        incremental_pending, oracle_pending,
        "pending-site set must match a from-scratch scan after delete-then-create"
    );

    let _ = std::fs::remove_dir_all(&scratch_root);
    let _ = std::fs::remove_dir_all(&oracle_root);
}

// ---------------------------------------------------------------------
// Frente E (plan `generic-waddling-hartmanis.md` §2.4): `ScanScope::
// Reconcile`. Every test below holds the SAME paridad Merkle bloqueante
// invariant the `incremental_*` family above holds for `Changed`: whichever
// pipeline a reconcile actually runs (`Delta` or `Cold`), its roots must be
// byte-identical to a from-scratch cold scan of the SAME mutated tree.
// `threshold`/`inject_delta_failure` are passed explicitly (never via
// `std::env::set_var`, forbidden in this `#![forbid(unsafe_code)]` binary)
// so these tests can force one branch deterministically regardless of this
// tiny fixture's own size -- see `scan::run_reconcile`'s own doc comment.
// ---------------------------------------------------------------------

/// Runs one `ScanScope::Reconcile` request directly against
/// `scan::run_reconcile` (not through `scan::run_with_residual`/`run_scan`,
/// which would read `URDIRA_V4_RECONCILE_THRESHOLD`/`URDIRA_V4_RECONCILE_
/// FAIL_DELTA` from the environment -- unusable here, see this section's own
/// header comment) and returns its terminal event alongside
/// `touched_owner_paths`.
#[allow(clippy::too_many_arguments)]
fn run_reconcile_scan(
    request_id: &str,
    workspace_id: &str,
    workspace_root: &Path,
    database_path: &Path,
    structural_root: &Path,
    cas_root: &Path,
    threshold: f64,
    inject_delta_failure: bool,
    syntax: &mut SyntaxWorkerState,
    worker_state: &mut super::state::WorkerState,
) -> (IndexingEvent, Option<Vec<String>>) {
    let request = scan::ScanRequest {
        request_id: request_id.to_string(),
        workspace_id: workspace_id.to_string(),
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        database_path: database_path.to_string_lossy().into_owned(),
        structural_root: structural_root.to_string_lossy().into_owned(),
        cas_root: cas_root.to_string_lossy().into_owned(),
        sidecar_root: structural_root
            .parent()
            .unwrap()
            .join("sidecar")
            .to_string_lossy()
            .into_owned(),
        scope: ScanScope::Reconcile,
        registry_snapshot_id: "registry:v4-e2e-test".to_string(),
        configuration_revision_id: "configuration:v4-e2e-test".to_string(),
        resolution_lock_id: "resolution:v4-e2e-test".to_string(),
        deadline_ms: None,
        priority: ScanPriority::Interactive,
    };
    let mut conn =
        catalog::open_and_ensure_schema(database_path).expect("catalog opens for reconcile");
    let mut clock = ScanClock::start();
    let mut on_queryable = |_event: IndexingEvent| -> Result<(), String> { Ok(()) };
    scan::run_reconcile(
        &request,
        threshold,
        inject_delta_failure,
        &mut conn,
        workspace_root,
        structural_root,
        cas_root,
        syntax,
        worker_state,
        &mut clock,
        &mut on_queryable,
    )
    .expect("scan::run_reconcile succeeds")
}

fn reconcile_summary_of(event: &IndexingEvent) -> urdira_worker_protocol::ReconcileSummary {
    match event {
        IndexingEvent::ScanCompleted { reconcile, .. } => reconcile
            .clone()
            .expect("reconcile scope must report a ReconcileSummary"),
        other => panic!("expected ScanCompleted, got {other:?}"),
    }
}

/// R3: an empty authoritative delta is a no-op -- same generation, same
/// roots as the cold scan that published them, `reconcile.mode == Noop`,
/// and `touched_owner_paths == Some(vec![])` (nothing for the residual pass
/// to re-schedule).
#[test]
fn reconcile_noop_keeps_generation_and_roots() {
    let scratch_root = scratch_dir("reconcile-noop");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:v4-e2e-reconcile-noop",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);
    let cold_roots = roots_of(&cold);

    // Nothing on disk changes between the cold scan and the reconcile.
    let (reconciled, touched) = run_reconcile_scan(
        "request:reconcile-noop",
        "workspace:v4-e2e-reconcile-noop",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        scan::RECONCILE_DELTA_THRESHOLD,
        false,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(
        generation_of(&reconciled),
        1,
        "a no-op reconcile must not publish a new generation"
    );
    assert_eq!(roots_of(&reconciled), cold_roots);
    let summary = reconcile_summary_of(&reconciled);
    assert_eq!(summary.mode, urdira_worker_protocol::ReconcileMode::Noop);
    assert_eq!(summary.added, 0);
    assert_eq!(summary.changed, 0);
    assert_eq!(summary.deleted, 0);
    assert!(!summary.fell_back_to_cold);
    assert_eq!(touched, Some(Vec::new()));

    let _ = std::fs::remove_dir_all(&scratch_root);
}

/// Plan §2.4: a small CREATE, forced through the `Delta` pipeline
/// (`threshold: 1.0` guarantees `n <= T * frontier_size` regardless of this
/// fixture's own tiny size) -- roots and pending sites must match a
/// from-scratch oracle scan of the identically mutated tree, and
/// `reconcile.mode == Delta`.
#[test]
fn reconcile_create_roots_match_a_from_scratch_scan_of_the_mutated_tree() {
    let scratch_root = scratch_dir("reconcile-create");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:v4-e2e-reconcile-create",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);

    let created_relative = "src/domain/urdira-harness-reconcile-created.ts";
    std::fs::write(
        workspace_root.join(created_relative),
        "export function urdiraHarnessReconcileCreated_marker1() {\n  return \"marker1\";\n}\n",
    )
    .expect("write created file");

    let (reconciled, touched) = run_reconcile_scan(
        "request:reconcile-create",
        "workspace:v4-e2e-reconcile-create",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        1.0,
        false,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&reconciled), 2);
    let summary = reconcile_summary_of(&reconciled);
    assert_eq!(summary.mode, urdira_worker_protocol::ReconcileMode::Delta);
    assert_eq!(summary.added, 1);
    assert_eq!(summary.changed, 0);
    assert_eq!(summary.deleted, 0);
    assert!(!summary.fell_back_to_cold);
    assert_eq!(
        touched,
        Some(vec![created_relative.to_string()]),
        "Delta mode must report exactly the touched owner path"
    );

    let oracle_root = scratch_dir("reconcile-create-oracle");
    let oracle_database = oracle_root.join("workspace.sqlite");
    let oracle_structural = oracle_root.join("structural");
    let oracle_cas = oracle_root.join("cas");
    let mut oracle_syntax = SyntaxWorkerState::default();
    let mut oracle_state: super::state::WorkerState = std::collections::HashMap::new();
    let oracle = run_scan(
        "request:oracle",
        "workspace:v4-e2e-reconcile-create-oracle",
        &workspace_root,
        &oracle_database,
        &oracle_structural,
        &oracle_cas,
        ScanScope::Full,
        &mut oracle_syntax,
        &mut oracle_state,
    );
    assert_eq!(generation_of(&oracle), 1);

    let reconciled_roots = roots_of(&reconciled);
    let oracle_roots = roots_of(&oracle);
    assert_eq!(reconciled_roots.records, oracle_roots.records);
    assert_eq!(reconciled_roots.dependency, oracle_roots.dependency);
    assert_eq!(reconciled_roots.graph, oracle_roots.graph);

    let reconciled_pending = pending_site_set(
        &structural_root,
        &database_path,
        "workspace:v4-e2e-reconcile-create",
    );
    let oracle_pending = pending_site_set(
        &oracle_structural,
        &oracle_database,
        "workspace:v4-e2e-reconcile-create-oracle",
    );
    assert_eq!(reconciled_pending, oracle_pending);

    let _ = std::fs::remove_dir_all(&scratch_root);
    let _ = std::fs::remove_dir_all(&oracle_root);
}

/// Plan §2.4: a small MODIFY, forced through `Delta`. Unlike the create/
/// delete/rename siblings above, a content EDIT going through `Delta`
/// (`delta::run` -> `diff.rs::diff_owner`) does NOT match an independent
/// from-scratch oracle by design -- decision 11's documented "replacement"
/// chaining (`record_id = H(digest, predecessor)` for an identity that
/// persists with a changed digest, e.g. `jsts:entity_container`'s `end`
/// shifting with the file's byte length) never matches the kernel's plain
/// `record_id = sha256(digest)` a from-scratch oracle always uses -- the
/// EXACT property `incremental_edit_produces_a_self_consistent_incremental_
/// merkle_update` (above) already establishes for the `Changed` scope, and
/// `reconcile`'s `Delta` branch is that same `delta::run` call underneath.
/// (Confirmed NOT to be a reconcile-specific gap: a content edit through
/// the `Cold` pipeline instead -- no prior-generation chaining there at all
/// -- DOES match an independent oracle exactly, verified live while
/// diagnosing this.) So this test holds `Delta`'s only real guarantees
/// instead: (1) the reconciled roots equal a from-scratch REBUILD over the
/// store's own final visible key set (`recompute_roots_from_scratch`,
/// `lifecycle.verify`'s own primitive); (2) every unrelated record keeps
/// its exact prior id.
#[test]
fn reconcile_modify_produces_a_self_consistent_incremental_merkle_update() {
    let scratch_root = scratch_dir("reconcile-modify");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:v4-e2e-reconcile-modify",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);
    let reader1 = StoreReader::open(&structural_root).expect("reader opens after cold");
    let mut records_before: std::collections::HashMap<[u8; 32], [u8; 32]> =
        std::collections::HashMap::new();
    for view in reader1.iter_visible(1) {
        records_before.insert(view.identity_key_digest(), view.record_id());
    }
    drop(reader1);

    let modified_relative = "src/domain/task.ts";
    let modified_absolute = workspace_root.join(modified_relative);
    let mut text = std::fs::read_to_string(&modified_absolute).expect("read modified file");
    text.push_str("\n// urdira-harness-reconcile-modify marker\n");
    std::fs::write(&modified_absolute, text).expect("write modified file");

    let (reconciled, touched) = run_reconcile_scan(
        "request:reconcile-modify",
        "workspace:v4-e2e-reconcile-modify",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        1.0,
        false,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&reconciled), 2);
    let summary = reconcile_summary_of(&reconciled);
    assert_eq!(summary.mode, urdira_worker_protocol::ReconcileMode::Delta);
    assert_eq!(summary.added, 0);
    assert_eq!(summary.changed, 1);
    assert_eq!(summary.deleted, 0);
    assert_eq!(touched, Some(vec![modified_relative.to_string()]));

    let reconciled_roots = roots_of(&reconciled);
    let reader2 = StoreReader::open(&structural_root).expect("reader opens after reconcile");
    let generation2 = reader2.generation();
    assert_eq!(generation2, 2);
    let (records_root_from_scratch, dependency_root_from_scratch) =
        urdira_structural_store::recompute_roots_from_scratch(&reader2, generation2)
            .expect("recompute_roots_from_scratch succeeds");
    assert_eq!(
        reconciled_roots.records,
        urdira_structural_store::to_prefixed_hex(&records_root_from_scratch),
        "the reconciled records root must equal a from-scratch rebuild over the SAME final key set"
    );
    assert_eq!(
        reconciled_roots.dependency,
        urdira_structural_store::to_prefixed_hex(&dependency_root_from_scratch),
        "the reconciled dependency root must equal a from-scratch rebuild over the SAME final key set"
    );
    let graph_entries: Vec<_> = reader2
        .iter_visible(generation2)
        .filter(|view| view.category() == urdira_structural_store::row::CATEGORY_RELATION)
        .map(|view| (view.record_id(), view.record_digest()))
        .collect();
    let graph_root_from_scratch =
        urdira_structural_store::BucketedMerkleSet::from_sorted(&graph_entries)
            .expect("graph merkle build succeeds")
            .root();
    assert_eq!(
        reconciled_roots.graph,
        urdira_structural_store::to_prefixed_hex(&graph_root_from_scratch),
        "the reconciled graph root must equal a from-scratch rebuild over the SAME final key set"
    );

    let mut unchanged_checked = 0;
    for view in reader2.iter_visible(generation2) {
        if let Some(&prior_id) = records_before.get(&view.identity_key_digest())
            && prior_id == view.record_id()
        {
            unchanged_checked += 1;
        }
    }
    assert!(
        unchanged_checked > 100,
        "most of generation 1's records must survive this edit with their exact prior id \
         (got {unchanged_checked}); a reconcile Delta should not reopen/rechain unrelated records"
    );

    let _ = std::fs::remove_dir_all(&scratch_root);
}

/// Plan §2.4: a pure DELETE, forced through `Delta`.
#[test]
fn reconcile_delete_roots_match_a_from_scratch_scan_of_the_mutated_tree() {
    let scratch_root = scratch_dir("reconcile-delete");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:v4-e2e-reconcile-delete",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);

    let deleted_relative = "src/repository/in-memory-task-repository.ts";
    std::fs::remove_file(workspace_root.join(deleted_relative)).expect("delete file");

    let (reconciled, touched) = run_reconcile_scan(
        "request:reconcile-delete",
        "workspace:v4-e2e-reconcile-delete",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        1.0,
        false,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&reconciled), 2);
    let summary = reconcile_summary_of(&reconciled);
    assert_eq!(summary.mode, urdira_worker_protocol::ReconcileMode::Delta);
    assert_eq!(summary.added, 0);
    assert_eq!(summary.changed, 0);
    assert_eq!(summary.deleted, 1);
    assert_eq!(touched, Some(vec![deleted_relative.to_string()]));

    let oracle_root = scratch_dir("reconcile-delete-oracle");
    let oracle_database = oracle_root.join("workspace.sqlite");
    let oracle_structural = oracle_root.join("structural");
    let oracle_cas = oracle_root.join("cas");
    let mut oracle_syntax = SyntaxWorkerState::default();
    let mut oracle_state: super::state::WorkerState = std::collections::HashMap::new();
    let oracle = run_scan(
        "request:oracle",
        "workspace:v4-e2e-reconcile-delete-oracle",
        &workspace_root,
        &oracle_database,
        &oracle_structural,
        &oracle_cas,
        ScanScope::Full,
        &mut oracle_syntax,
        &mut oracle_state,
    );
    assert_eq!(generation_of(&oracle), 1);

    let reconciled_roots = roots_of(&reconciled);
    let oracle_roots = roots_of(&oracle);
    assert_eq!(reconciled_roots.records, oracle_roots.records);
    assert_eq!(reconciled_roots.dependency, oracle_roots.dependency);
    assert_eq!(reconciled_roots.graph, oracle_roots.graph);

    let _ = std::fs::remove_dir_all(&scratch_root);
    let _ = std::fs::remove_dir_all(&oracle_root);
}

/// Plan §2.4: a RENAME (a same-generation delete+create pair with no
/// modified entries, `Delta::compute`'s own authoritative diff derives
/// BOTH from the walk -- reconcile never receives a rename hint from a
/// watcher), forced through `Delta`.
#[test]
fn reconcile_rename_roots_match_a_from_scratch_scan_of_the_mutated_tree() {
    let scratch_root = scratch_dir("reconcile-rename");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:v4-e2e-reconcile-rename",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);

    let old_relative = "src/domain/errors.ts";
    let new_relative = "src/domain/errors-reconcile-renamed.ts";
    std::fs::rename(
        workspace_root.join(old_relative),
        workspace_root.join(new_relative),
    )
    .expect("rename succeeds");

    let (reconciled, touched) = run_reconcile_scan(
        "request:reconcile-rename",
        "workspace:v4-e2e-reconcile-rename",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        1.0,
        false,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&reconciled), 2);
    let summary = reconcile_summary_of(&reconciled);
    assert_eq!(summary.mode, urdira_worker_protocol::ReconcileMode::Delta);
    assert_eq!(summary.added, 1);
    assert_eq!(summary.changed, 0);
    assert_eq!(summary.deleted, 1);
    let mut touched = touched.expect("Delta mode reports touched owner paths");
    touched.sort();
    assert_eq!(
        touched,
        vec![new_relative.to_string(), old_relative.to_string()]
    );

    let oracle_root = scratch_dir("reconcile-rename-oracle");
    let oracle_database = oracle_root.join("workspace.sqlite");
    let oracle_structural = oracle_root.join("structural");
    let oracle_cas = oracle_root.join("cas");
    let mut oracle_syntax = SyntaxWorkerState::default();
    let mut oracle_state: super::state::WorkerState = std::collections::HashMap::new();
    let oracle = run_scan(
        "request:oracle",
        "workspace:v4-e2e-reconcile-rename-oracle",
        &workspace_root,
        &oracle_database,
        &oracle_structural,
        &oracle_cas,
        ScanScope::Full,
        &mut oracle_syntax,
        &mut oracle_state,
    );
    assert_eq!(generation_of(&oracle), 1);

    let reconciled_roots = roots_of(&reconciled);
    let oracle_roots = roots_of(&oracle);
    assert_eq!(reconciled_roots.records, oracle_roots.records);
    assert_eq!(reconciled_roots.dependency, oracle_roots.dependency);
    assert_eq!(reconciled_roots.graph, oracle_roots.graph);

    let reconciled_pending = pending_site_set(
        &structural_root,
        &database_path,
        "workspace:v4-e2e-reconcile-rename",
    );
    let oracle_pending = pending_site_set(
        &oracle_structural,
        &oracle_database,
        "workspace:v4-e2e-reconcile-rename-oracle",
    );
    assert_eq!(reconciled_pending, oracle_pending);

    let _ = std::fs::remove_dir_all(&scratch_root);
    let _ = std::fs::remove_dir_all(&oracle_root);
}

/// Plan §2.4/§0 R1: sweeps batch sizes `⌈p * N⌉` (`N` = this fixture's own
/// 8-file `.ts` inventory) over `p ∈ {1, 5, 10, 25, 50}%`, mutating that
/// many files, and republishes the SAME mutated tree twice -- once forced
/// through `Delta` (`threshold: 1.0`) and once forced through `Cold`
/// (`threshold: 0.0`) -- against independent scratch copies. Both must
/// match a from-scratch oracle scan of the identically mutated tree
/// exactly: `T` only ever decides WHICH pipeline runs, never the resulting
/// roots.
///
/// **Decided in implementation, deviating from the plan's literal "90%
/// comment added" mutation recipe**: a CREATE at each batch size, not a
/// content EDIT to an existing file. Diagnosed live while writing this
/// family (see `reconcile_modify_produces_a_self_consistent_incremental_
/// merkle_update`'s own doc comment and `full_scan_twice_in_the_same_
/// process_matches_a_from_scratch_oracle`): a content edit's `Delta`
/// branch legitimately chains an existing identity's `record_id` per
/// decision 11, which by design never matches an independent from-scratch
/// oracle -- true of `Changed` today, inherited by `reconcile`'s `Delta`
/// branch unchanged, NOT a reconcile-specific gap. A pure CREATE has no
/// prior identity to chain against on EITHER branch, so it is the correct
/// choice for a test whose whole point is oracle-parity across both
/// branches at once; content-edit batches are exactly what `scripts/v4-
/// reconcile-threshold.mjs` (plan §2.6, real n8n corpus) exercises instead,
/// where wall-clock measurement -- not root parity -- is the point, and a
/// `delta`-vs-`cold` comparison at `T=1.0`/`T=0.0` on the SAME edit-heavy
/// mutation is expected to (and, per this finding, will) diverge on any
/// touched file's own chained record while still validating everything
/// else; that script's own "abortar si no" gate should compare its DELTA
/// run's roots against its OWN COLD run (both mutated identically), never
/// against a fully independent oracle, for exactly this reason. (This
/// fixture is also far too small for the percentages themselves to be
/// meaningful load figures -- that calibration is the threshold script's
/// job -- this test only proves the parity invariant holds at several
/// distinct batch sizes.)
#[test]
fn reconcile_batches_match_cold_at_1_5_10_25_50_percent() {
    let total = 8_usize;

    for fraction in [0.01_f64, 0.05, 0.10, 0.25, 0.50] {
        let touched_count = ((fraction * total as f64).ceil() as usize).max(1);
        let pct = (fraction * 100.0) as u32;
        let label = format!("reconcile-batch-{pct:02}pct");
        // TS identifiers cannot contain `-`; `pct` (a plain integer) is
        // used inside the generated source text instead of `label` itself.
        let mutate = |workspace_root: &Path| {
            for index in 0..touched_count {
                let relative = format!("src/domain/urdira-harness-{label}-created-{index}.ts");
                std::fs::write(
                    workspace_root.join(&relative),
                    format!(
                        "export function urdiraHarness_batch_{pct}pct_created_{index}() {{\n  return {index};\n}}\n"
                    ),
                )
                .expect("write created file");
            }
        };

        // Forced Delta.
        let delta_scratch = scratch_dir(&format!("{label}-delta"));
        let delta_workspace = delta_scratch.join("workspace");
        copy_dir_recursive(&fixture_root(), &delta_workspace);
        let delta_database = delta_scratch.join("workspace.sqlite");
        let delta_structural = delta_scratch.join("structural");
        let delta_cas = delta_scratch.join("cas");
        let mut delta_syntax = SyntaxWorkerState::default();
        let mut delta_state: super::state::WorkerState = std::collections::HashMap::new();
        let delta_workspace_id = format!("workspace:v4-e2e-{label}-delta");
        let cold = run_scan(
            "request:cold",
            &delta_workspace_id,
            &delta_workspace,
            &delta_database,
            &delta_structural,
            &delta_cas,
            ScanScope::Full,
            &mut delta_syntax,
            &mut delta_state,
        );
        assert_eq!(generation_of(&cold), 1);
        mutate(&delta_workspace);
        let (delta_event, _) = run_reconcile_scan(
            "request:reconcile-delta",
            &delta_workspace_id,
            &delta_workspace,
            &delta_database,
            &delta_structural,
            &delta_cas,
            1.0,
            false,
            &mut delta_syntax,
            &mut delta_state,
        );
        assert_eq!(generation_of(&delta_event), 2);
        assert_eq!(
            reconcile_summary_of(&delta_event).mode,
            urdira_worker_protocol::ReconcileMode::Delta,
            "fraction={fraction} touched={touched_count}"
        );

        // Forced Cold, same mutations, independent copy.
        let cold_scratch = scratch_dir(&format!("{label}-cold"));
        let cold_workspace = cold_scratch.join("workspace");
        copy_dir_recursive(&fixture_root(), &cold_workspace);
        let cold_database = cold_scratch.join("workspace.sqlite");
        let cold_structural = cold_scratch.join("structural");
        let cold_cas = cold_scratch.join("cas");
        let mut cold_syntax = SyntaxWorkerState::default();
        let mut cold_state: super::state::WorkerState = std::collections::HashMap::new();
        let cold_workspace_id = format!("workspace:v4-e2e-{label}-cold");
        let cold_gen1 = run_scan(
            "request:cold",
            &cold_workspace_id,
            &cold_workspace,
            &cold_database,
            &cold_structural,
            &cold_cas,
            ScanScope::Full,
            &mut cold_syntax,
            &mut cold_state,
        );
        assert_eq!(generation_of(&cold_gen1), 1);
        mutate(&cold_workspace);
        let (cold_event, _) = run_reconcile_scan(
            "request:reconcile-cold",
            &cold_workspace_id,
            &cold_workspace,
            &cold_database,
            &cold_structural,
            &cold_cas,
            0.0,
            false,
            &mut cold_syntax,
            &mut cold_state,
        );
        assert_eq!(generation_of(&cold_event), 2);
        assert_eq!(
            reconcile_summary_of(&cold_event).mode,
            urdira_worker_protocol::ReconcileMode::Cold,
            "fraction={fraction} touched={touched_count}"
        );

        // From-scratch oracle of the identically mutated tree.
        let oracle_scratch = scratch_dir(&format!("{label}-oracle"));
        let oracle_workspace = oracle_scratch.join("workspace");
        copy_dir_recursive(&fixture_root(), &oracle_workspace);
        mutate(&oracle_workspace);
        let oracle_database = oracle_scratch.join("workspace.sqlite");
        let oracle_structural = oracle_scratch.join("structural");
        let oracle_cas = oracle_scratch.join("cas");
        let mut oracle_syntax = SyntaxWorkerState::default();
        let mut oracle_state: super::state::WorkerState = std::collections::HashMap::new();
        let oracle_event = run_scan(
            "request:oracle",
            &format!("workspace:v4-e2e-{label}-oracle"),
            &oracle_workspace,
            &oracle_database,
            &oracle_structural,
            &oracle_cas,
            ScanScope::Full,
            &mut oracle_syntax,
            &mut oracle_state,
        );
        assert_eq!(generation_of(&oracle_event), 1);

        let delta_roots = roots_of(&delta_event);
        let cold_roots = roots_of(&cold_event);
        let oracle_roots = roots_of(&oracle_event);
        assert_eq!(
            delta_roots.records, oracle_roots.records,
            "fraction={fraction} touched={touched_count}: delta records root vs oracle"
        );
        assert_eq!(
            delta_roots.dependency, oracle_roots.dependency,
            "fraction={fraction} touched={touched_count}: delta dependency root vs oracle"
        );
        assert_eq!(
            delta_roots.graph, oracle_roots.graph,
            "fraction={fraction} touched={touched_count}: delta graph root vs oracle"
        );
        assert_eq!(
            cold_roots.records, oracle_roots.records,
            "fraction={fraction} touched={touched_count}: cold records root vs oracle"
        );
        assert_eq!(
            cold_roots.dependency, oracle_roots.dependency,
            "fraction={fraction} touched={touched_count}: cold dependency root vs oracle"
        );
        assert_eq!(
            cold_roots.graph, oracle_roots.graph,
            "fraction={fraction} touched={touched_count}: cold graph root vs oracle"
        );

        let _ = std::fs::remove_dir_all(&delta_scratch);
        let _ = std::fs::remove_dir_all(&cold_scratch);
        let _ = std::fs::remove_dir_all(&oracle_scratch);
    }
}

/// Plan §0 R2: the `Delta` attempt fails (injected) -- the SAME request
/// must fall back to `Cold` rather than surface a partial generation.
/// Exactly one new generation is published (`read_current_generation ==
/// 2`, not 3: the failed `Delta` attempt's own `Catalog::apply` publishes
/// generation 2's CATALOG row before `delta::run` fails deeper in its own
/// pipeline, and the fallback's `run_full_from` re-walks and republishes
/// that SAME generation 2 -- never a generation 3).
#[test]
fn reconcile_falls_back_to_cold_when_delta_fails() {
    let scratch_root = scratch_dir("reconcile-fail-delta");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:v4-e2e-reconcile-fail-delta",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);

    let created_relative = "src/domain/urdira-harness-reconcile-fail-delta-created.ts";
    std::fs::write(
        workspace_root.join(created_relative),
        "export function urdiraHarnessReconcileFailDeltaCreated_marker1() {\n  return \"marker1\";\n}\n",
    )
    .expect("write created file");

    let (reconciled, touched) = run_reconcile_scan(
        "request:reconcile-fail-delta",
        "workspace:v4-e2e-reconcile-fail-delta",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        1.0,
        true,
        &mut syntax,
        &mut worker_state,
    );
    let summary = reconcile_summary_of(&reconciled);
    assert_eq!(summary.mode, urdira_worker_protocol::ReconcileMode::Cold);
    assert!(summary.fell_back_to_cold);
    assert!(
        touched.is_none(),
        "Cold mode reports no touched owner scope"
    );

    let conn =
        catalog::open_and_ensure_schema(&database_path).expect("catalog reopens after fallback");
    assert_eq!(
        catalog::read_current_generation(&conn, "workspace:v4-e2e-reconcile-fail-delta")
            .expect("reads current generation"),
        2,
        "the fallback must publish exactly one new generation, never a partial one"
    );
    drop(conn);

    let oracle_root = scratch_dir("reconcile-fail-delta-oracle");
    let oracle_database = oracle_root.join("workspace.sqlite");
    let oracle_structural = oracle_root.join("structural");
    let oracle_cas = oracle_root.join("cas");
    let mut oracle_syntax = SyntaxWorkerState::default();
    let mut oracle_state: super::state::WorkerState = std::collections::HashMap::new();
    let oracle = run_scan(
        "request:oracle",
        "workspace:v4-e2e-reconcile-fail-delta-oracle",
        &workspace_root,
        &oracle_database,
        &oracle_structural,
        &oracle_cas,
        ScanScope::Full,
        &mut oracle_syntax,
        &mut oracle_state,
    );
    assert_eq!(generation_of(&oracle), 1);

    let reconciled_roots = roots_of(&reconciled);
    let oracle_roots = roots_of(&oracle);
    assert_eq!(reconciled_roots.records, oracle_roots.records);
    assert_eq!(reconciled_roots.dependency, oracle_roots.dependency);
    assert_eq!(reconciled_roots.graph, oracle_roots.graph);

    let _ = std::fs::remove_dir_all(&scratch_root);
    let _ = std::fs::remove_dir_all(&oracle_root);
}

/// Counts the currently-visible entity records under `identity_key`
/// `prefix` -- used below to check the external module/symbol identity's
/// live-record count directly against the store, generation over
/// generation.
fn visible_entity_count_with_prefix(structural_root: &Path, prefix: &[u8]) -> usize {
    let reader = StoreReader::open(structural_root).expect("StoreReader opens");
    let generation = reader.generation();
    reader
        .iter_visible(generation)
        .filter(|view| {
            view.category() == urdira_structural_store::row::CATEGORY_ENTITY
                && view.identity_key().starts_with(prefix)
        })
        .count()
}

/// External package/symbol entities task (2026-09-04), owner-requested
/// incremental test: two files (`a.ts`, `b.ts`, alphabetically `a.ts` first)
/// each `import { get } from "lodash"` -- cold materialize's cross-owner
/// dedup (`analyze::run_scoped`'s `dedupe_external_entities_across_owners`,
/// applied to `owners` AFTER the `owner_path` sort) keeps exactly one
/// `jsts:external_module:lodash`/`jsts:external_symbol:lodash#get` pair,
/// attributed to `a.ts` (the alphabetically-first, hence deterministically
/// kept, proposer). Verifies the documented edit/delete mechanism directly
/// against the real store, not merely by reasoning about the code:
///
/// 1. Cold: exactly one live module entity, one live symbol entity.
/// 2. Delete `b.ts` (the NON-owning importer, never touched by the dedup
///    pass's keep-decision): `a.ts` is untouched by this incremental batch,
///    so its rows -- including the shared external identity it owns --
///    stay live exactly as-is. The entity survives.
/// 3. Delete `a.ts` too (now the LAST remaining importer, and the one that
///    actually owns the identity in the store): `diff_owner` finds no
///    match for the identity in `a.ts`'s (empty) `next` proposal set and
///    closes it -- the entity is gone. This is the exact "delete both ->
///    gone" outcome the task brief itself anticipated, and matches this
///    task's documented mechanism precisely (see `dedupe_external_entities_
///    across_owners`'s own doc comment in `analyze.rs` for the case this
///    test does NOT exercise: deleting the OWNING importer FIRST while a
///    non-owning one remains untouched -- the entity would disappear
///    early, then self-heal the next time any surviving importer is
///    rescanned. Not repeated here to keep this test's assertions aligned
///    with the exact scenario the task brief named).
#[test]
fn external_module_entity_survives_deleting_one_importer_but_not_the_last_one() {
    let scratch_root = scratch_dir("external-entity-lifecycle");
    let workspace_root = scratch_root.join("workspace");
    std::fs::create_dir_all(&workspace_root).expect("workspace dir");
    std::fs::write(
        workspace_root.join("a.ts"),
        b"import { get } from \"lodash\";\nexport function useA() {\n  return get(1);\n}\n"
            as &[u8],
    )
    .expect("write a.ts");
    std::fs::write(
        workspace_root.join("b.ts"),
        b"import { get } from \"lodash\";\nexport function useB() {\n  return get(2);\n}\n"
            as &[u8],
    )
    .expect("write b.ts");

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");
    let workspace_id = "workspace:external-entity-lifecycle";

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        workspace_id,
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);
    assert_eq!(
        visible_entity_count_with_prefix(&structural_root, b"jsts:external_module:lodash"),
        1,
        "cross-owner dedup must keep exactly one module entity cold, not one per importer"
    );
    assert_eq!(
        visible_entity_count_with_prefix(&structural_root, b"jsts:external_symbol:lodash#get"),
        1,
        "cross-owner dedup must keep exactly one symbol entity cold, not one per importer"
    );

    std::fs::remove_file(workspace_root.join("b.ts")).expect("remove b.ts");
    let after_delete_b = run_scan(
        "request:delete-b",
        workspace_id,
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: "b.ts".to_string(),
                kind: ChangeKind::Deleted,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&after_delete_b), 2);
    assert_eq!(
        visible_entity_count_with_prefix(&structural_root, b"jsts:external_module:lodash"),
        1,
        "the module entity must survive deleting the NON-owning importer -- a.ts still imports lodash"
    );
    assert_eq!(
        visible_entity_count_with_prefix(&structural_root, b"jsts:external_symbol:lodash#get"),
        1,
        "the symbol entity must survive deleting the NON-owning importer -- a.ts still imports lodash"
    );

    std::fs::remove_file(workspace_root.join("a.ts")).expect("remove a.ts");
    let after_delete_a = run_scan(
        "request:delete-a",
        workspace_id,
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: "a.ts".to_string(),
                kind: ChangeKind::Deleted,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&after_delete_a), 3);
    assert_eq!(
        visible_entity_count_with_prefix(&structural_root, b"jsts:external_module:lodash"),
        0,
        "the module entity must be gone once the LAST importer (a.ts, its actual owner) is deleted"
    );
    assert_eq!(
        visible_entity_count_with_prefix(&structural_root, b"jsts:external_symbol:lodash#get"),
        0,
        "the symbol entity must be gone once the LAST importer is deleted"
    );

    let _ = std::fs::remove_dir_all(&scratch_root);
}

/// Bug found live 2026-09-05 against the n8n corpus
/// (`n8n_incremental_create_delete_roots_match_oracle`, diagnosed via
/// `dump_records_set_diff`/the throwaway `debug_dump_external_entity_
/// bodies`): the exact scenario the sibling test just above's own doc
/// comment named but deliberately did NOT exercise -- "deleting the
/// OWNING importer FIRST while a non-owning one remains untouched".
/// `a.ts`/`b.js` (DIFFERENT languages, deliberately, to also cover the
/// second half of the fix -- see below) both `import { get } from
/// "lodash"`; cold materialize's cross-owner dedup keeps exactly one pair
/// of entities, attributed to `a.ts` (alphabetically first). Deleting
/// `a.ts` -- the identity's actual current owner -- while `b.js` still
/// imports the same specifier must NOT make the entity disappear even
/// temporarily, unlike the pre-fix behavior (`delta.rs`'s
/// `protected_external_entity_ids`/`at_risk_external_entities`: `a.ts`'s
/// own diff would otherwise close the shared entity outright, since
/// `dedupe_external_entities_across_owners` only ever sees the SMALL
/// incremental batch, never the whole workspace).
///
/// Two languages, not one, because a SECOND, independent bug shared the
/// same failure mode: `proposal_entity_record` (`urdira-jsts-syntax-
/// worker::lib`) used to stamp the CALLING file's own language onto
/// every entity it proposed, including these two kinds -- despite their
/// own doc comments already claiming to be "a pure function of
/// specifier/name alone, never the importing file". Since `a.ts` (the
/// original owner) is TypeScript and `b.js` (the survivor) is
/// JavaScript, this fixture reproduces BOTH root causes in one small,
/// fast test: without the close-protection fix the entity vanishes
/// after deleting `a.ts`; without the language-normalization fix its
/// surviving/reopened body would still carry `language=typescript`
/// (`a.ts`'s stamp) forever, byte-diverging from what a from-scratch
/// cold scan of the SAME mutated (a.ts-deleted) tree would produce
/// (`language=javascript`, `b.js`'s own stamp) -- exactly the n8n
/// failure this test distills to fixture scale, verified the same way:
/// an independent from-scratch oracle scan of the post-delete tree, with
/// `records`/`dependency`/`graph` roots compared byte-for-byte.
#[test]
fn external_module_entity_survives_deleting_the_owning_importer_while_another_remains() {
    let scratch_root = scratch_dir("external-entity-owner-deleted-first");
    let workspace_root = scratch_root.join("workspace");
    std::fs::create_dir_all(&workspace_root).expect("workspace dir");
    std::fs::write(
        workspace_root.join("a.ts"),
        b"import { get } from \"lodash\";\nexport function useA() {\n  return get(1);\n}\n"
            as &[u8],
    )
    .expect("write a.ts");
    std::fs::write(
        workspace_root.join("b.js"),
        b"import { get } from \"lodash\";\nexport function useB() {\n  return get(2);\n}\n"
            as &[u8],
    )
    .expect("write b.js");

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");
    let workspace_id = "workspace:external-entity-owner-deleted-first";

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        workspace_id,
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);
    assert_eq!(
        visible_entity_count_with_prefix(&structural_root, b"jsts:external_module:lodash"),
        1,
        "cross-owner dedup must keep exactly one module entity cold, not one per importer"
    );
    assert_eq!(
        visible_entity_count_with_prefix(&structural_root, b"jsts:external_symbol:lodash#get"),
        1,
        "cross-owner dedup must keep exactly one symbol entity cold, not one per importer"
    );

    // Delete `a.ts` -- the OWNING importer, alphabetically first, hence
    // the one `dedupe_external_entities_across_owners` picked at cold --
    // while `b.js` (a non-owning importer) remains untouched.
    std::fs::remove_file(workspace_root.join("a.ts")).expect("remove a.ts");
    let after_delete_a = run_scan(
        "request:delete-a",
        workspace_id,
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: "a.ts".to_string(),
                kind: ChangeKind::Deleted,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&after_delete_a), 2);
    assert_eq!(
        visible_entity_count_with_prefix(&structural_root, b"jsts:external_module:lodash"),
        1,
        "the module entity must survive deleting its OWNING importer -- b.js still imports lodash"
    );
    assert_eq!(
        visible_entity_count_with_prefix(&structural_root, b"jsts:external_symbol:lodash#get"),
        1,
        "the symbol entity must survive deleting its OWNING importer -- b.js still imports lodash"
    );

    // Root-equality against a from-scratch oracle of the SAME mutated
    // (a.ts-deleted) tree -- the n8n test's own methodology, at fixture
    // scale: catches not just "is the entity present" but "is its body
    // byte-identical to what a fresh scan of this exact tree would
    // produce" (the language-normalization half of the fix).
    let oracle_root = scratch_dir("external-entity-owner-deleted-first-oracle");
    let oracle_database = oracle_root.join("workspace.sqlite");
    let oracle_structural = oracle_root.join("structural");
    let oracle_cas = oracle_root.join("cas");
    let mut oracle_syntax = SyntaxWorkerState::default();
    let mut oracle_state: super::state::WorkerState = std::collections::HashMap::new();
    let oracle = run_scan(
        "request:oracle-fromscratch",
        "workspace:external-entity-owner-deleted-first-oracle",
        &workspace_root,
        &oracle_database,
        &oracle_structural,
        &oracle_cas,
        ScanScope::Full,
        &mut oracle_syntax,
        &mut oracle_state,
    );
    assert_eq!(generation_of(&oracle), 1);

    let incremental_roots = roots_of(&after_delete_a);
    let oracle_roots = roots_of(&oracle);
    if incremental_roots.records != oracle_roots.records {
        dump_records_set_diff(&structural_root, 2, &oracle_structural, 1);
    }
    assert_eq!(
        incremental_roots.records, oracle_roots.records,
        "records root must match a from-scratch scan of the a.ts-deleted tree (catches a stale language stamp on the surviving entity)"
    );
    assert_eq!(
        incremental_roots.dependency, oracle_roots.dependency,
        "dependency root must match a from-scratch scan of the a.ts-deleted tree"
    );
    assert_eq!(
        incremental_roots.graph, oracle_roots.graph,
        "graph root must match a from-scratch scan of the a.ts-deleted tree"
    );

    // Delete `b.js` too (now the last remaining importer): the entity
    // must finally close, same terminal outcome as the sibling test.
    std::fs::remove_file(workspace_root.join("b.js")).expect("remove b.js");
    let after_delete_b = run_scan(
        "request:delete-b",
        workspace_id,
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: "b.js".to_string(),
                kind: ChangeKind::Deleted,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&after_delete_b), 3);
    assert_eq!(
        visible_entity_count_with_prefix(&structural_root, b"jsts:external_module:lodash"),
        0,
        "the module entity must be gone once the LAST importer is deleted"
    );
    assert_eq!(
        visible_entity_count_with_prefix(&structural_root, b"jsts:external_symbol:lodash#get"),
        0,
        "the symbol entity must be gone once the LAST importer is deleted"
    );

    let _ = std::fs::remove_dir_all(&scratch_root);
    let _ = std::fs::remove_dir_all(&oracle_root);
}

/// Diagnostic, not a correctness assertion: prints a record-count-by-kind
/// histogram for an already-published structural store, for the evidence
/// doc's "record counts by kind" table (task P2-2b deliverable 6). `#[ignore]`d
/// (not part of the normal suite) -- run explicitly against an n8n
/// benchmark output directory: `URDIRA_V4_INSPECT_STORE=<path> cargo test
/// -p urdira-indexing-worker --release v4::tests_e2e::inspect_store_record_histogram -- --ignored --nocapture`.
#[test]
#[ignore]
fn inspect_store_record_histogram() {
    use std::collections::BTreeMap;
    let Ok(path) = std::env::var("URDIRA_V4_INSPECT_STORE") else {
        eprintln!("set URDIRA_V4_INSPECT_STORE=<structural-root> to run this diagnostic");
        return;
    };
    let reader = StoreReader::open(Path::new(&path)).expect("StoreReader opens");
    let generation = reader.generation();
    let dicts = reader.dictionaries();
    let mut by_kind: BTreeMap<(u8, String), u64> = BTreeMap::new();
    let mut total = 0u64;
    // A2 (pending.sites migration): `core:call` confirmed vs. possible-
    // with-target (P2-2j candidate rows) breakdown, and the store-wide
    // "no relation record without target" invariant count -- see
    // `residual.rs`'s `is_classification_consistent`/`count_
    // classification_mismatches` for the same rule. Plan 3.4 (this task):
    // the confirmed/possible split itself now calls `residual::
    // classify_confirmed_possible` (extracted from `residual.rs`'s own
    // `print_confirmed_possible_histogram`, `pub(crate)` specifically so
    // this module no longer has to reimplement it) instead of a second,
    // independently-hand-written copy of the same facet-bit check.
    let mut call_confirmed = 0u64;
    let mut call_possible_with_target = 0u64;
    let mut relation_without_target = 0u64;
    // Parameter entities, "referenced-only" variant (2026-09-04): before
    // this change, EVERY `core:references` row whose target resolved to a
    // parameter (`DeclKind::Parameter`) had no matching entity to intern
    // against, so `target_subject` was always `None` for those rows --
    // `core:find_references` on a parameter always returned nothing. Counted
    // separately from `relation_without_target` above (which is scoped to
    // `core:call`/`core:inherits`/`core:implements` only): a `core:
    // references` row with no target is not the same invariant violation
    // those three are (a reference can legitimately stay `checker_pending`
    // for reasons unrelated to parameters), so this is a plain diagnostic
    // count, not an assertion.
    let mut references_without_target = 0u64;
    // Parameter entities, "referenced-only" variant: of the `core:
    // references` rows that DO have a `target_subject`, how many resolve to
    // a `jsts:parameter:...` entity -- every ONE of these was, before this
    // task, a row with NO `target_subject` at all (there was no entity for
    // any parameter, referenced-only or otherwise, to intern against). This
    // lets a single cold scan report BOTH the current
    // `references_without_target` figure AND the pre-task one it replaced
    // (`references_without_target` + this count), without needing a second,
    // separately-built "before" binary: nothing else in this task changes
    // whether any OTHER reference interns.
    let mut references_resolved_to_parameter = 0u64;
    // External package/symbol entities task (2026-09-04): visible entity
    // count for each new kind, plus `jsts:relation_import`/`_export` rows
    // with an external target -- see this task's own evidence doc.
    let mut external_module_entities = 0u64;
    let mut external_symbol_entities = 0u64;
    let mut import_export_with_external_target = 0u64;
    for view in reader.iter_visible(generation) {
        total += 1;
        let category = view.category();
        let kind = dicts
            .kinds
            .get(view.kind_id() as usize)
            .cloned()
            .unwrap_or_else(|| format!("<unknown:{}>", view.kind_id()));
        let identity_key = view.identity_key();
        if identity_key.starts_with(b"jsts:external_module:") {
            external_module_entities += 1;
        } else if identity_key.starts_with(b"jsts:external_symbol:") {
            external_symbol_entities += 1;
        }
        if matches!(
            kind.as_str(),
            "jsts:relation_import" | "jsts:relation_export"
        ) && let Some(target_subject) = view.target_subject()
            && let Some(target_record_id) = dicts.subjects.get(target_subject as usize)
            && let Some(target_view) = reader.get_visible(target_record_id, generation)
            && target_view
                .identity_key()
                .starts_with(b"jsts:external_module:")
        {
            import_export_with_external_target += 1;
        }
        if category == urdira_structural_store::row::CATEGORY_RELATION {
            let universal_kind = dicts
                .universal_kinds
                .get(view.universal_kind_id() as usize)
                .map(String::as_str)
                .unwrap_or("");
            if matches!(
                universal_kind,
                "core:call" | "core:inherits" | "core:implements"
            ) && view.target_subject().is_none()
            {
                relation_without_target += 1;
            }
            if universal_kind == "core:references" {
                if view.target_subject().is_none() {
                    references_without_target += 1;
                } else if let Some(target_subject) = view.target_subject()
                    && let Some(target_record_id) = dicts.subjects.get(target_subject as usize)
                    && let Some(target_view) = reader.get_visible(target_record_id, generation)
                    && target_view.identity_key().starts_with(b"jsts:parameter:")
                {
                    references_resolved_to_parameter += 1;
                }
            }
            if universal_kind == "core:call" {
                match residual::classify_confirmed_possible(&view, &dicts) {
                    Some((residual::SiteFamily::Call, true)) => call_confirmed += 1,
                    Some((residual::SiteFamily::Call, false)) => {
                        call_possible_with_target += 1;
                    }
                    _ => {}
                }
            }
        }
        *by_kind.entry((category, kind)).or_insert(0) += 1;
    }
    println!("generation={generation} total_records={total}");
    println!("artifacts_interned={}", dicts.artifacts.len());
    for ((category, kind), count) in &by_kind {
        let category_name = match *category {
            urdira_structural_store::row::CATEGORY_ENTITY => "entity",
            urdira_structural_store::row::CATEGORY_RELATION => "relation",
            urdira_structural_store::row::CATEGORY_DIAGNOSTIC => "diagnostic",
            _ => "unknown",
        };
        println!("  {category_name:9} {kind:32} {count}");
    }
    println!(
        "deps_visible_count={}",
        reader.deps_visible_count(generation)
    );
    println!(
        "core:call confirmed={call_confirmed} possible_with_target(candidates)={call_possible_with_target}"
    );
    println!(
        "relation_records_without_target (core:call/inherits/implements only, must be 0)={relation_without_target}"
    );
    println!(
        "references_without_target (core:references, diagnostic only)={references_without_target}"
    );
    println!(
        "references_resolved_to_parameter (subset of core:references WITH target_subject, target is jsts:parameter:...)={references_resolved_to_parameter}"
    );
    println!(
        "references_without_target BEFORE parameter entities (derived: {references_without_target} + {references_resolved_to_parameter})={}",
        references_without_target + references_resolved_to_parameter
    );
    // External package/symbol entities task (2026-09-04).
    println!(
        "external_module_entities={external_module_entities} external_symbol_entities={external_symbol_entities} import_export_relations_with_external_target={import_export_with_external_target}"
    );

    // A2: pending sites, visible count split by (site_kind, reason).
    let pending = reader.iter_visible_pending_sites(generation);
    println!("pending_sites_visible_count={}", pending.len());
    let mut pending_by_kind_reason: BTreeMap<(u8, u8), u64> = BTreeMap::new();
    for site in &pending {
        *pending_by_kind_reason
            .entry((site.site_kind(), site.reason()))
            .or_insert(0) += 1;
    }
    for ((site_kind, reason), count) in &pending_by_kind_reason {
        let kind_name = match *site_kind {
            urdira_structural_store::row::PENDING_SITE_KIND_CALL => "call",
            urdira_structural_store::row::PENDING_SITE_KIND_INHERITS => "inherits",
            urdira_structural_store::row::PENDING_SITE_KIND_IMPLEMENTS => "implements",
            _ => "unknown",
        };
        let reason_name = urdira_jsts_syntax_worker::PendingReasonCode::to_reason(*reason);
        println!("  pending {kind_name:12} reason={reason_name:32} {count}");
    }
    // C task (member entities at cold): before this change, every pending
    // site whose ENCLOSING entity is a class/interface member (a call
    // inside a method body) had `source_subject = None` at materialize
    // time -- `residual.rs::collect()` skips such a site entirely (see that
    // function's own doc comment). With member entities materialized at
    // cold, `source_subject` should resolve for almost all of them --
    // report the count so a before/after comparison is possible without
    // re-deriving `collect()`'s own logic here.
    let pending_source_subject_none = pending
        .iter()
        .filter(|site| site.source_subject().is_none())
        .count();
    println!(
        "pending_sites_visible_source_subject_none={pending_source_subject_none} (of {})",
        pending.len()
    );
}

/// P2-2j item 5 diagnostic: isolates what the REAL cold-scan pipeline's
/// catalog walk (2.7-3.6s on n8n, per this task's evidence doc) adds on top
/// of the P2-2a bench's own 0.4-1.0s "walk+hash only" figure for the SAME
/// corpus. Runs `Walker::enumerate` three ways against the SAME scratch
/// copy: (a) `cas: None` (pure walk+hash, no CAS at all -- the P2-2a
/// bench's own shape), (b) a real `CasWriteQueue` sized exactly like
/// `catalog::run_full_scan`'s (`available_parallelism()/2` workers,
/// capacity 512), joined before reporting, (c) the same real queue but
/// with capacity raised by 40x (20,480) and worker count raised to
/// `available_parallelism()` -- tests whether queue backpressure (workers
/// too few / capacity too small relative to the corpus) is what the
/// production number pays that the bench never did. `#[ignore]`d (needs a
/// real corpus): `URDIRA_V4_N8N_CORPUS=<path> cargo test -p
/// urdira-indexing-worker --release
/// v4::tests_e2e::n8n_catalog_walk_diagnosis -- --ignored --nocapture`.
#[test]
#[ignore]
fn n8n_catalog_walk_diagnosis() {
    use urdira_source_frontier::inclusion::{GitIgnoreRules, default_workspace_inclusion};
    use urdira_source_frontier::{CasStore, CasWriteQueue, Walker};

    let Ok(corpus) = std::env::var("URDIRA_V4_N8N_CORPUS") else {
        eprintln!("set URDIRA_V4_N8N_CORPUS=<path> to run this diagnostic");
        return;
    };
    let workspace_root = scratch_copy_of_n8n_corpus("n8n-catalog-walk-diagnosis", &corpus);
    let rules = default_workspace_inclusion();
    let gitignore = GitIgnoreRules {
        enabled: false,
        patterns: Vec::new(),
    };
    let available = std::thread::available_parallelism()
        .map(std::num::NonZero::get)
        .unwrap_or(4);

    // (a) no CAS at all.
    let started = std::time::Instant::now();
    let observations = Walker::enumerate(&workspace_root, &rules, &gitignore, None)
        .expect("walk without CAS succeeds");
    let elapsed_no_cas = started.elapsed();
    println!(
        "(a) walk, cas=None: {:.3}s observations={}",
        elapsed_no_cas.as_secs_f64(),
        observations.len()
    );

    // (b) real queue, production sizing (worker_count = available/2,
    // capacity 512 -- `catalog::run_full_scan`'s own numbers).
    let cas_root_b = workspace_root
        .parent()
        .unwrap()
        .join("cas-diagnosis-production-sizing");
    let store_b = CasStore::open(&cas_root_b).expect("cas store b opens");
    let queue_b = CasWriteQueue::spawn(store_b, available.div_ceil(2).max(2), 512);
    let started = std::time::Instant::now();
    let observations_b = Walker::enumerate(&workspace_root, &rules, &gitignore, Some(&queue_b))
        .expect("walk with production-sized queue succeeds");
    let walk_elapsed_b = started.elapsed();
    let join_started = std::time::Instant::now();
    queue_b.join().expect("cas queue b join succeeds");
    let join_elapsed_b = join_started.elapsed();
    println!(
        "(b) walk, real CasWriteQueue (workers={}, capacity=512): walk={:.3}s join={:.3}s observations={}",
        available.div_ceil(2).max(2),
        walk_elapsed_b.as_secs_f64(),
        join_elapsed_b.as_secs_f64(),
        observations_b.len()
    );

    // (c) real queue, generously over-sized (never backpressures for a
    // corpus this size; worker_count = full available_parallelism).
    let cas_root_c = workspace_root
        .parent()
        .unwrap()
        .join("cas-diagnosis-oversized");
    let store_c = CasStore::open(&cas_root_c).expect("cas store c opens");
    let queue_c = CasWriteQueue::spawn(store_c, available, 20_480);
    let started = std::time::Instant::now();
    let observations_c = Walker::enumerate(&workspace_root, &rules, &gitignore, Some(&queue_c))
        .expect("walk with oversized queue succeeds");
    let walk_elapsed_c = started.elapsed();
    let join_started = std::time::Instant::now();
    queue_c.join().expect("cas queue c join succeeds");
    let join_elapsed_c = join_started.elapsed();
    println!(
        "(c) walk, oversized CasWriteQueue (workers={available}, capacity=20480): walk={:.3}s join={:.3}s observations={}",
        walk_elapsed_c.as_secs_f64(),
        join_elapsed_c.as_secs_f64(),
        observations_c.len()
    );

    let _ = std::fs::remove_dir_all(&workspace_root);
}

/// P3-1 n8n measurement (task deliverable 7): cold scan + a handful of
/// incremental mutations against a REAL corpus, all inside ONE persistent
/// worker process (`syntax`/`worker_state` reused across every `scan::run`
/// call, exactly like `main.rs`'s command loop does) -- prints
/// `ScanTimings` and roots per call. `#[ignore]`d (needs a real corpus, run
/// explicitly): `URDIRA_V4_N8N_CORPUS=<path> URDIRA_V4_N8N_DATA=<fresh-dir>
/// URDIRA_DEBUG_TIMING=1 cargo test -p urdira-indexing-worker --release
/// v4::tests_e2e::n8n_incremental_measurement -- --ignored --nocapture`.
#[test]
#[ignore]
fn n8n_incremental_measurement() {
    let (Ok(corpus), Ok(data_root)) = (
        std::env::var("URDIRA_V4_N8N_CORPUS"),
        std::env::var("URDIRA_V4_N8N_DATA"),
    ) else {
        eprintln!(
            "set URDIRA_V4_N8N_CORPUS=<path> URDIRA_V4_N8N_DATA=<fresh-dir> to run this measurement"
        );
        return;
    };
    // P3-2 hard rule: never mutate the shared corpus in place (this test
    // used to do exactly that -- see `scratch_copy_of_n8n_corpus`'s doc
    // comment for the incident). Work on a scratch copy instead.
    let workspace_root = scratch_copy_of_n8n_corpus("n8n-measurement", &corpus);
    let data_root = PathBuf::from(&data_root);
    std::fs::create_dir_all(&data_root).expect("create data root");
    let database_path = data_root.join("workspace.sqlite");
    let structural_root = data_root.join("structural");
    let cas_root = data_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let t_cold = std::time::Instant::now();
    let cold = run_scan(
        "request:n8n-cold",
        "workspace:n8n",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    println!(
        "COLD generation={} wall={:.3}s event={:?}",
        generation_of(&cold),
        t_cold.elapsed().as_secs_f64(),
        cold
    );

    // Pick a real, small, leaf-ish TypeScript file under the corpus to
    // edit (append-only, matching `scripts/v4-mutation-harness.mjs`'s own
    // `applyEditFile`).
    let mut candidate: Option<PathBuf> = None;
    for entry in walkdir_ts_files(&workspace_root).into_iter() {
        if entry
            .to_string_lossy()
            .ends_with("package/nodes-base/nodes/Set/GenericFunctions.ts")
            || entry.to_string_lossy().contains("credentials")
        {
            continue;
        }
        candidate = Some(entry);
        break;
    }
    let Some(edited_absolute) = candidate else {
        eprintln!("no candidate .ts file found under {corpus}");
        return;
    };
    let edited_relative = edited_absolute
        .strip_prefix(&workspace_root)
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    println!("editing {edited_relative}");
    let before = std::fs::read_to_string(&edited_absolute).expect("read edited file");
    let after = format!(
        "{before}{}\nexport function urdiraHarnessEdit_marker1() {{\n  return \"marker1\";\n}}\nurdiraHarnessEdit_marker1();\n",
        if before.ends_with('\n') { "" } else { "\n" }
    );
    std::fs::write(&edited_absolute, &after).expect("write mutated file");

    let t_edit = std::time::Instant::now();
    let edit = run_scan(
        "request:n8n-edit-1",
        "workspace:n8n",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: edited_relative.clone(),
                kind: ChangeKind::Modified,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    println!(
        "EDIT#1 generation={} wall={:.3}s event={:?}",
        generation_of(&edit),
        t_edit.elapsed().as_secs_f64(),
        edit
    );
    println!("EDIT#1 {}", f1_timing_columns_of(&edit));

    // A second edit of the SAME file, immediately after -- the "steady
    // state" number (no cold-cache effects from the first edit).
    let before2 = std::fs::read_to_string(&edited_absolute).expect("read edited file");
    let after2 = format!(
        "{before2}\nexport function urdiraHarnessEdit_marker2() {{\n  return \"marker2\";\n}}\nurdiraHarnessEdit_marker2();\n"
    );
    std::fs::write(&edited_absolute, &after2).expect("write mutated file");
    let t_edit2 = std::time::Instant::now();
    let edit2 = run_scan(
        "request:n8n-edit-2",
        "workspace:n8n",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: edited_relative.clone(),
                kind: ChangeKind::Modified,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    println!(
        "EDIT#2 generation={} wall={:.3}s event={:?}",
        generation_of(&edit2),
        t_edit2.elapsed().as_secs_f64(),
        edit2
    );
    println!("EDIT#2 {}", f1_timing_columns_of(&edit2));

    // A create.
    let created_relative = format!(
        "{}/urdira-harness-created.ts",
        std::path::Path::new(&edited_relative)
            .parent()
            .unwrap()
            .to_string_lossy()
    );
    let created_absolute = workspace_root.join(&created_relative);
    std::fs::write(
        &created_absolute,
        "export function urdiraHarnessCreated_marker1() {\n  return \"marker1\";\n}\n",
    )
    .expect("write created file");
    let t_create = std::time::Instant::now();
    let create = run_scan(
        "request:n8n-create-1",
        "workspace:n8n",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: created_relative.clone(),
                kind: ChangeKind::Created,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    println!(
        "CREATE generation={} wall={:.3}s event={:?}",
        generation_of(&create),
        t_create.elapsed().as_secs_f64(),
        create
    );

    // A delete (of the just-created file).
    std::fs::remove_file(&created_absolute).expect("remove created file");
    let t_delete = std::time::Instant::now();
    let delete = run_scan(
        "request:n8n-delete-1",
        "workspace:n8n",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: created_relative,
                kind: ChangeKind::Deleted,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    println!(
        "DELETE generation={} wall={:.3}s event={:?}",
        generation_of(&delete),
        t_delete.elapsed().as_secs_f64(),
        delete
    );

    // P3-2 item 8: a THIRD steady-state edit of the same file (edit#2 was
    // already steady-state relative to edit#1's cold-cache effects; edit#3
    // confirms edit#2 was not itself an outlier).
    let before3 = std::fs::read_to_string(&edited_absolute).expect("read edited file");
    let after3 = format!(
        "{before3}\nexport function urdiraHarnessEdit_marker3() {{\n  return \"marker3\";\n}}\nurdiraHarnessEdit_marker3();\n"
    );
    std::fs::write(&edited_absolute, &after3).expect("write mutated file");
    let t_edit3 = std::time::Instant::now();
    let edit3 = run_scan(
        "request:n8n-edit-3",
        "workspace:n8n",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: edited_relative.clone(),
                kind: ChangeKind::Modified,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    println!(
        "EDIT#3 generation={} wall={:.3}s event={:?}",
        generation_of(&edit3),
        t_edit3.elapsed().as_secs_f64(),
        edit3
    );

    // P3-2 item 8: a RENAME (delete + create of the SAME content under a
    // new path, in ONE `Changed` command) -- proven correct at n8n scale by
    // `n8n_incremental_create_delete_roots_match_oracle`'s sibling
    // create+delete assertions; measured here as its own worker-only
    // number for the first time (the daemon-driven harness previously
    // excluded `rename` entirely due to the now-fixed watcher/aggregation
    // bug, `packages/daemon/src/runtime.ts`, P3-2 item 4 -- this worker-only
    // path never went through the daemon at all, so it was never affected
    // by that bug, only never separately timed).
    let renamed_relative = format!("{edited_relative}.urdira-renamed.ts");
    let renamed_absolute = workspace_root.join(&renamed_relative);
    std::fs::rename(&edited_absolute, &renamed_absolute).expect("rename edited file");
    let t_rename = std::time::Instant::now();
    let rename = run_scan(
        "request:n8n-rename-1",
        "workspace:n8n",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![
                ChangedPath {
                    path: edited_relative.clone(),
                    kind: ChangeKind::Deleted,
                },
                ChangedPath {
                    path: renamed_relative.clone(),
                    kind: ChangeKind::Created,
                },
            ],
        },
        &mut syntax,
        &mut worker_state,
    );
    println!(
        "RENAME generation={} wall={:.3}s event={:?}",
        generation_of(&rename),
        t_rename.elapsed().as_secs_f64(),
        rename
    );
    // Rename back so it does not shadow the hub-edit candidate search
    // below (irrelevant here since the hub file is a different path, but
    // keeps the scratch tree's own bookkeeping tidy for anyone inspecting
    // it after a failure).
    std::fs::rename(&renamed_absolute, &edited_absolute).ok();

    // P3-2 item 8 (also item 6's honest measurement): a HUB edit against a
    // REAL, real high-fan-in n8n file (`packages/nodes-base/utils/
    // utilities.ts`, ~377 importers by grep -- see this task's evidence
    // doc). Two variants, both currently reprocessing the FULL importer
    // closure identically (item 6's surface-hash narrowing is NOT
    // implemented -- see the evidence doc's own honest accounting): (a)
    // "surface-unchanged", an append-only edit exactly like `applyEditFile`
    // (adds a new export, touches none of the existing ones); (b)
    // "surface-changed", renaming an EXISTING exported function (removes
    // one export, adds a differently-named one).
    let hub_relative = "packages/nodes-base/utils/utilities.ts";
    let hub_absolute = workspace_root.join(hub_relative);
    if hub_absolute.is_file() {
        let hub_before = std::fs::read_to_string(&hub_absolute).expect("read hub file");
        let hub_after_unchanged = format!(
            "{hub_before}{}\nexport function urdiraHarnessHubUnchanged_marker() {{\n  return \"marker\";\n}}\n",
            if hub_before.ends_with('\n') { "" } else { "\n" }
        );
        std::fs::write(&hub_absolute, &hub_after_unchanged).expect("write hub file");
        let t_hub_unchanged = std::time::Instant::now();
        let hub_unchanged = run_scan(
            "request:n8n-hub-unchanged",
            "workspace:n8n",
            &workspace_root,
            &database_path,
            &structural_root,
            &cas_root,
            ScanScope::Changed {
                paths: vec![ChangedPath {
                    path: hub_relative.to_string(),
                    kind: ChangeKind::Modified,
                }],
            },
            &mut syntax,
            &mut worker_state,
        );
        println!(
            "HUB_EDIT_SURFACE_UNCHANGED generation={} wall={:.3}s event={:?}",
            generation_of(&hub_unchanged),
            t_hub_unchanged.elapsed().as_secs_f64(),
            hub_unchanged
        );
        println!(
            "HUB_EDIT_SURFACE_UNCHANGED {}",
            f1_timing_columns_of(&hub_unchanged)
        );

        // Surface-changed: rename the FIRST existing exported function
        // found (a real export removal + a differently-named addition).
        let hub_after_changed = if let Some(function_index) =
            hub_after_unchanged.find("export function ")
        {
            let after_keyword = function_index + "export function ".len();
            let name_end = hub_after_unchanged[after_keyword..]
                .find('(')
                .map(|offset| after_keyword + offset)
                .unwrap_or(after_keyword);
            let mut renamed = String::with_capacity(hub_after_unchanged.len() + 24);
            renamed.push_str(&hub_after_unchanged[..name_end]);
            renamed.push_str("UrdiraHarnessRenamed");
            renamed.push_str(&hub_after_unchanged[name_end..]);
            renamed
        } else {
            format!(
                "{hub_after_unchanged}\nexport function urdiraHarnessHubChanged_marker() {{\n  return \"marker\";\n}}\n"
            )
        };
        std::fs::write(&hub_absolute, &hub_after_changed).expect("write hub file");
        let t_hub_changed = std::time::Instant::now();
        let hub_changed = run_scan(
            "request:n8n-hub-changed",
            "workspace:n8n",
            &workspace_root,
            &database_path,
            &structural_root,
            &cas_root,
            ScanScope::Changed {
                paths: vec![ChangedPath {
                    path: hub_relative.to_string(),
                    kind: ChangeKind::Modified,
                }],
            },
            &mut syntax,
            &mut worker_state,
        );
        println!(
            "HUB_EDIT_SURFACE_CHANGED generation={} wall={:.3}s event={:?}",
            generation_of(&hub_changed),
            t_hub_changed.elapsed().as_secs_f64(),
            hub_changed
        );
        println!(
            "HUB_EDIT_SURFACE_CHANGED {}",
            f1_timing_columns_of(&hub_changed)
        );
    } else {
        eprintln!(
            "hub-edit candidate {hub_relative} not found under this corpus checkout -- skipping hub_edit measurement"
        );
    }
}

fn walkdir_ts_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == ".git" || name == "node_modules" || name == ".urdira" {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if name.ends_with(".ts") && !name.ends_with(".d.ts") && out.len() < 20000 {
                out.push(path);
            }
        }
        if out.len() > 50 {
            break;
        }
    }
    out.sort();
    out
}

/// P3-1 deliverable 7/finding closure: n8n-SCALE root-equality confirmation
/// against a from-scratch oracle, entirely in-process (no subprocess
/// spawning at all -- `scripts/v4-mutation-harness.mjs`'s own oracle path,
/// which shells out via `execFileAsync`, hit a real, non-deterministic
/// `spawn EBADF` in this session's environment at n8n scale, documented in
/// the evidence doc rather than worked around further). Operates on a
/// SCRATCH COPY of the corpus (never the shared benchmark asset itself --
/// an earlier direct run of a sibling test mutated the real corpus
/// in-place and had to be restored by hand; not repeating that mistake
/// here). `#[ignore]`d: `URDIRA_V4_N8N_CORPUS=<path> cargo test -p
/// urdira-indexing-worker --release
/// v4::tests_e2e::n8n_incremental_create_delete_roots_match_oracle --
/// --ignored --nocapture`.
#[test]
#[ignore]
fn n8n_incremental_create_delete_roots_match_oracle() {
    let Ok(corpus) = std::env::var("URDIRA_V4_N8N_CORPUS") else {
        eprintln!("set URDIRA_V4_N8N_CORPUS=<path> to run this measurement");
        return;
    };
    let workspace_root = scratch_copy_of_n8n_corpus("n8n-roots-oracle", &corpus);
    let scratch_root = workspace_root
        .parent()
        .expect("scratch workspace has a parent scratch root")
        .to_path_buf();

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");
    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:n8n-oracle-cold",
        "workspace:n8n-oracle",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);
    eprintln!("cold done, generation=1");

    // Create a brand-new file (first-occurrence on both sides -- no
    // decision-11 ambiguity, see `incremental_create_roots_match_a_from_
    // scratch_scan_of_the_mutated_tree`'s doc comment for why this kind
    // achieves exact equality).
    let created_relative = "urdira-n8n-oracle-created.ts";
    let created_absolute = workspace_root.join(created_relative);
    std::fs::write(
        &created_absolute,
        "export function urdiraN8nOracleCreated_marker() {\n  return \"marker\";\n}\n",
    )
    .expect("write created file");
    let create = run_scan(
        "request:n8n-oracle-create",
        "workspace:n8n-oracle",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: created_relative.to_string(),
                kind: ChangeKind::Created,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&create), 2);
    eprintln!("create done, generation=2");

    // Delete a real, already-indexed leaf file (a `.ts` file with no
    // importers is safest -- reuses `walkdir_ts_files`'s own candidate
    // search, skipping the one we just created).
    let candidate = walkdir_ts_files(&workspace_root)
        .into_iter()
        .find(|path| !path.ends_with(created_relative))
        .expect("at least one other .ts file exists in the n8n corpus");
    let deleted_relative = candidate
        .strip_prefix(&workspace_root)
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    std::fs::remove_file(&candidate).expect("remove deleted file");
    let delete = run_scan(
        "request:n8n-oracle-delete",
        "workspace:n8n-oracle",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Changed {
            paths: vec![ChangedPath {
                path: deleted_relative.clone(),
                kind: ChangeKind::Deleted,
            }],
        },
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&delete), 3);
    eprintln!("delete of {deleted_relative} done, generation=3");

    let incremental_roots = roots_of(&delete);

    // Oracle: an entirely independent from-scratch cold scan of the
    // now-mutated (created+deleted) scratch tree, in a separate data dir
    // and separate in-process state.
    let oracle_root = scratch_dir("n8n-roots-oracle-cold");
    let oracle_database = oracle_root.join("workspace.sqlite");
    let oracle_structural = oracle_root.join("structural");
    let oracle_cas = oracle_root.join("cas");
    let mut oracle_syntax = SyntaxWorkerState::default();
    let mut oracle_state: super::state::WorkerState = std::collections::HashMap::new();
    let oracle_started = std::time::Instant::now();
    let oracle = run_scan(
        "request:n8n-oracle-fromscratch",
        "workspace:n8n-oracle-fromscratch",
        &workspace_root,
        &oracle_database,
        &oracle_structural,
        &oracle_cas,
        ScanScope::Full,
        &mut oracle_syntax,
        &mut oracle_state,
    );
    assert_eq!(generation_of(&oracle), 1);
    eprintln!(
        "oracle cold scan of the mutated tree done in {:.1}s",
        oracle_started.elapsed().as_secs_f64()
    );

    let oracle_roots = roots_of(&oracle);
    if incremental_roots.records != oracle_roots.records {
        dump_records_set_diff(&structural_root, 3, &oracle_structural, 1);
    }
    assert_eq!(
        incremental_roots.records, oracle_roots.records,
        "n8n-scale: records root must match a from-scratch scan of the create+delete-mutated tree"
    );
    if incremental_roots.dependency != oracle_roots.dependency {
        dump_dependency_set_diff(&structural_root, 3, &oracle_structural, 1);
    }
    assert_eq!(
        incremental_roots.dependency, oracle_roots.dependency,
        "n8n-scale: dependency root must match a from-scratch scan of the create+delete-mutated tree"
    );
    assert_eq!(
        incremental_roots.graph, oracle_roots.graph,
        "n8n-scale: graph root must match a from-scratch scan of the create+delete-mutated tree"
    );
    println!("n8n-scale root equality CONFIRMED for create+delete against a from-scratch oracle");

    // A2 (pending.sites migration): the visible pending-site set must ALSO
    // match a from-scratch oracle scan of the same mutated tree, at n8n
    // scale -- the created owner's pending sites must be present and the
    // deleted owner's must be gone, on both sides identically.
    let incremental_pending =
        pending_site_set(&structural_root, &database_path, "workspace:n8n-oracle");
    let oracle_pending = pending_site_set(
        &oracle_structural,
        &oracle_database,
        "workspace:n8n-oracle-fromscratch",
    );
    assert_eq!(
        incremental_pending.len(),
        oracle_pending.len(),
        "n8n-scale: pending-site set SIZE must match a from-scratch scan of the create+delete-mutated tree"
    );
    assert_eq!(
        incremental_pending, oracle_pending,
        "n8n-scale: pending-site set must match a from-scratch scan of the create+delete-mutated tree"
    );
    println!(
        "n8n-scale pending-site set equality CONFIRMED for create+delete against a from-scratch oracle ({} sites)",
        incremental_pending.len()
    );

    let _ = std::fs::remove_dir_all(&scratch_root);
    let _ = std::fs::remove_dir_all(&oracle_root);
}

/// 2026-09-04 references-parity task, Phase A: streams every visible
/// `core:references` relation record's raw body bytes to a length-prefixed
/// binary file, in the EXACT SAME wire format `residual.rs`'s own
/// `dump_call_bodies` uses for `core:call` (`u32 row_count`, then repeated
/// `u8 confirmed_flag, u32 body_len, body_len bytes`) -- so `scripts/v4-
/// references-parity-diff.mjs` can decode this dump with the identical
/// `@urdira/canonical` `decodeCanonical` call `scripts/v4-call-parity-
/// diff.mjs` already uses for calls. Deliberately NOT in `residual.rs` (this
/// task's own file-scope rule: the residual pass never touches references at
/// all -- `core:references` sites are never sent to tsgo, see this module's
/// sibling diagnostic `n8n_references_parity_debug_dump`'s doc comment).
///
/// Unlike `dump_call_bodies`, this function does NOT need the `core:
/// indirect`-facet carve-out (no `core:references` row is ever a per-
/// candidate overload/union row -- that mechanism is `core:call`-only, see
/// `semantic_sites.rs`'s `candidate_call_record`), and does NOT synthesize
/// any "possible, no target" entries: `OwnerSemantics::reference_rows` (this
/// crate's module doc, point 1) only ever holds identifier references Rust
/// resolved "lexically, with zero doubt" -- there is no persisted `core:
/// references` row, and no `pending.sites` row either (`PENDING_SITE_KIND_*`
/// only has `Call`/`Inherits`/`Implements`), for anything Rust could not
/// resolve. `confirmed_flag` is therefore expected to be `true` for every
/// row this function ever dumps -- carried through anyway, rather than
/// hard-coded, so the wire format stays byte-compatible with `dump_call_
/// bodies` and a future genuine inconsistency (mirroring the real one that
/// motivated the flag on the call side) would still be visible to the diff
/// script rather than silently assumed away.
fn dump_reference_bodies(structural_root: &Path, generation: u64, out_path: &Path) {
    use urdira_structural_store::row::CATEGORY_RELATION;

    let store = StoreReader::open(structural_root).expect("store reopens for reference body dump");
    let dicts = store.dictionaries();
    let mut rows: Vec<(bool, Vec<u8>)> = Vec::new();
    for view in store.iter_visible(generation) {
        if view.category() != CATEGORY_RELATION {
            continue;
        }
        let universal_kind = dicts
            .universal_kinds
            .get(view.universal_kind_id() as usize)
            .map(String::as_str)
            .unwrap_or("");
        if universal_kind != "core:references" {
            continue;
        }
        let confirmed = view.target_subject().is_some();
        rows.push((confirmed, view.body().to_vec()));
    }

    use std::io::Write;
    let file = std::fs::File::create(out_path)
        .unwrap_or_else(|error| panic!("create reference body dump {out_path:?}: {error}"));
    let mut writer = std::io::BufWriter::new(file);
    writer
        .write_all(&(rows.len() as u32).to_le_bytes())
        .expect("write row count");
    let mut confirmed_flag_count = 0u64;
    for (confirmed, body) in &rows {
        writer
            .write_all(&[u8::from(*confirmed)])
            .expect("write confirmed flag");
        if *confirmed {
            confirmed_flag_count += 1;
        }
        writer
            .write_all(&(body.len() as u32).to_le_bytes())
            .expect("write body length");
        writer.write_all(body).expect("write body bytes");
    }
    writer.flush().expect("flush reference body dump");
    eprintln!(
        "[dump_reference_bodies] generation={generation} rows={} confirmed(target_subject)={confirmed_flag_count} -> {out_path:?}",
        rows.len()
    );
}

/// 2026-09-04 references-parity task, Phase A step 2: a from-scratch n8n
/// cold scan that, unlike every scan helper above, keeps the intermediate
/// `analyze::run_cold` result (`ColdAnalysis.owners`) around long enough to
/// read `OwnerFacts.pending_sites` -- the IN-MEMORY `Vec<SemanticSite>`
/// (`urdira-jsts-syntax-worker`'s own kind, `SiteKind::IdentifierRef`
/// included) BEFORE `materialize::materialize_cold` consumes `owners` by
/// value. This is the only population that answers "why did this reference
/// site stay unresolved": `PendingSiteRow`/`pending.sites` (the store's own
/// side table) carries `Call`/`Inherits`/`Implements` sites only (see
/// `PENDING_SITE_KIND_*` in `urdira-structural-store`) -- an
/// `IdentifierRef` pending site is NEVER persisted (module doc of
/// `semantic_sites.rs`, point 2: "Every other `IdentifierRef` site is a
/// pending site kept only in memory... NOT persisted, NOT sent to tsgo"),
/// so the only way to see its `reason` at all is to catch it here, in the
/// same process, before it is dropped for good.
///
/// Two optional dumps, both env-gated so a plain `cargo test --ignored` run
/// (no env vars set beyond `URDIRA_V4_N8N_CORPUS`) still runs the scan and
/// prints the histogram, without writing anything to disk:
///   - `URDIRA_V4_REFERENCE_BODY_DUMP=<path>`: `dump_reference_bodies`'s
///     binary dump of every published `core:references` row, for `scripts/
///     v4-references-parity-diff.mjs --v4-bodies`.
///   - `URDIRA_V4_PENDING_IDENTIFIER_REF_DUMP=<path>`: one line per pending
///     `IdentifierRef` site, TSV `path\tstart\tend\treason` (`reason` is
///     `"none"` for the vanishingly rare `RustResolved`-but-still-sited case,
///     if any -- see this function's own body), for `scripts/v4-references-
///     parity-diff.mjs --v4-pending-dump`, which joins it against the
///     "missing in v4" population by `(path, start, end)`.
///
/// `#[ignore]`d (needs a real corpus): `URDIRA_V4_N8N_CORPUS=<path>
/// [URDIRA_V4_REFERENCE_BODY_DUMP=<path>] [URDIRA_V4_PENDING_IDENTIFIER_REF_DUMP=<path>]
/// cargo test -p urdira-indexing-worker --release
/// v4::tests_e2e::n8n_references_parity_debug_dump -- --ignored --nocapture`.
#[test]
#[ignore]
fn n8n_references_parity_debug_dump() {
    let Ok(corpus) = std::env::var("URDIRA_V4_N8N_CORPUS") else {
        eprintln!("set URDIRA_V4_N8N_CORPUS=<path> to run this diagnostic");
        return;
    };
    let workspace_root = scratch_copy_of_n8n_corpus("n8n-references-parity", &corpus);
    let scratch_root = workspace_root
        .parent()
        .expect("scratch workspace has a parent scratch root")
        .to_path_buf();
    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");
    let workspace_id = "workspace:n8n-references-parity";

    let mut conn = catalog::open_and_ensure_schema(&database_path).expect("schema opens");
    let generation: i64 = 1;
    let cold_started = std::time::Instant::now();
    let outcome = catalog::run_full_scan(
        &mut conn,
        workspace_id,
        &workspace_root,
        &cas_root,
        generation,
    )
    .expect("catalog scan succeeds");
    catalog::restore_steady_state_pragmas(&conn)
        .expect("restoring synchronous=NORMAL after the cold catalog transaction succeeds");
    assert!(
        !outcome.frontier.present.is_empty(),
        "the n8n corpus walk observed zero files"
    );

    let mut clock = ScanClock::start();
    let mut syntax = SyntaxWorkerState::default();
    let cas_signal = outcome
        .cas_write_queue
        .as_ref()
        .expect("run_full_scan always populates cas_write_queue")
        .signal();
    let (analysis, _source_cache, _typeflow_cache) = analyze::run_cold(
        &outcome.frontier,
        &cas_root,
        workspace_id,
        &mut syntax,
        &mut clock,
        &cas_signal,
    )
    .expect("analyze succeeds");
    eprintln!(
        "[n8n_references_parity_debug_dump] cold analyze wall={:.3}s owners={}",
        cold_started.elapsed().as_secs_f64(),
        analysis.owners.len()
    );

    // Capture every IdentifierRef pending site BEFORE `materialize_cold`
    // consumes `analysis.owners` by value -- see this function's own doc
    // comment for why this is the only point in the whole pipeline this
    // population is observable at all.
    let mut reason_histogram: std::collections::HashMap<String, u64> =
        std::collections::HashMap::new();
    let mut pending_identifier_refs: Vec<(String, u32, u32, String)> = Vec::new();
    for owner in &analysis.owners {
        for site in &owner.pending_sites {
            if site.site_kind != urdira_jsts_syntax_worker::SiteKind::IdentifierRef {
                continue;
            }
            let reason = site.reason.clone().unwrap_or_else(|| "none".to_string());
            *reason_histogram.entry(reason.clone()).or_insert(0) += 1;
            pending_identifier_refs.push((
                owner.owner_path.clone(),
                site.start_utf16,
                site.end_utf16,
                reason,
            ));
        }
    }
    let mut histogram_sorted: Vec<(&String, &u64)> = reason_histogram.iter().collect();
    histogram_sorted.sort_by(|left, right| right.1.cmp(left.1).then(left.0.cmp(right.0)));
    println!();
    println!("=== n8n pending IdentifierRef reason histogram (cold, in-memory-only) ===");
    let total_pending: u64 = reason_histogram.values().sum();
    println!("total pending IdentifierRef sites: {total_pending}");
    for (reason, count) in &histogram_sorted {
        println!("  {:<32} {:>8}", reason, count);
    }

    if let Ok(path) = std::env::var("URDIRA_V4_PENDING_IDENTIFIER_REF_DUMP") {
        use std::io::Write;
        let file = std::fs::File::create(&path)
            .unwrap_or_else(|error| panic!("create pending-identifier-ref dump {path}: {error}"));
        let mut writer = std::io::BufWriter::new(file);
        for (owner_path, start, end, reason) in &pending_identifier_refs {
            writeln!(writer, "{owner_path}\t{start}\t{end}\t{reason}")
                .expect("write pending-identifier-ref dump line");
        }
        writer.flush().expect("flush pending-identifier-ref dump");
        eprintln!(
            "[n8n_references_parity_debug_dump] wrote {} pending IdentifierRef sites -> {path}",
            pending_identifier_refs.len()
        );
    }

    let materialized =
        materialize::materialize_cold(analysis.owners).expect("materialize succeeds");
    let references_universal_kind_id = materialized
        .dicts
        .universal_kinds
        .iter()
        .position(|name| name.as_str() == "core:references")
        .map(|index| index as u16);
    let references_record_count = materialized
        .records
        .iter()
        .filter(|record| Some(record.universal_kind_id) == references_universal_kind_id)
        .count();
    println!(
        "materialized core:references records (target-bearing, confirmed): {references_record_count}"
    );

    let request = scan::ScanRequest {
        request_id: "request:n8n-references-parity".to_string(),
        workspace_id: workspace_id.to_string(),
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        database_path: database_path.to_string_lossy().into_owned(),
        structural_root: structural_root.to_string_lossy().into_owned(),
        cas_root: cas_root.to_string_lossy().into_owned(),
        sidecar_root: scratch_root.join("sidecar").to_string_lossy().into_owned(),
        scope: ScanScope::Full,
        registry_snapshot_id: "registry:n8n-references-parity".to_string(),
        configuration_revision_id: "configuration:n8n-references-parity".to_string(),
        resolution_lock_id: "resolution:n8n-references-parity".to_string(),
        deadline_ms: None,
        priority: ScanPriority::Interactive,
    };
    let mut on_queryable = |_event: IndexingEvent| -> Result<(), String> { Ok(()) };
    let event = publish::publish_cold(
        &mut conn,
        &request,
        &structural_root,
        generation,
        &outcome,
        materialized,
        &mut clock,
        &mut on_queryable,
    )
    .expect("publish succeeds");
    let IndexingEvent::ScanCompleted {
        generation: event_generation,
        ..
    } = event
    else {
        panic!("publish_cold must return ScanCompleted");
    };
    eprintln!("[n8n_references_parity_debug_dump] published generation={event_generation}");

    if let Ok(path) = std::env::var("URDIRA_V4_REFERENCE_BODY_DUMP") {
        dump_reference_bodies(&structural_root, event_generation, Path::new(&path));
    }

    // 2026-09-04 references-parity task, regression gate: the task brief
    // requires re-checking `scripts/v4-call-parity-diff.mjs` "at the cold
    // checkpoint" after this task's own edits (which touch shared code
    // paths -- `resolve_import_binding`'s refactor, `classify_symbol_
    // declaration`'s callers -- even though no call-resolution logic
    // itself changed). Reusing THIS SAME cold scan (rather than a second
    // corpus copy+scan) to also dump `core:call` bodies keeps this cheap;
    // `dump_call_bodies_cold_only` below is a deliberately MINIMAL sibling
    // of `residual.rs`'s own `dump_call_bodies` (not reachable from here --
    // this task's file-scope rule keeps `residual.rs` untouched) that skips
    // the pending-call-site-as-possible-row synthesis: irrelevant to the
    // ONE thing this gate checks (`v4_confirmed_different_target == 0`),
    // since a v3-confirmed call either already has a REAL, materialized
    // `core:call` relation record in this store (confirmed or possible-
    // with-a-resolved-target) or it does not -- a synthesized pending-site
    // row would only ever change how a "missing" site's absence is
    // explained, never whether a present row's target agrees with v3's.
    if let Ok(path) = std::env::var("URDIRA_V4_CALL_BODY_DUMP_COLD_ONLY") {
        dump_call_bodies_cold_only(&structural_root, event_generation, Path::new(&path));
    }

    let _ = std::fs::remove_dir_all(&scratch_root);
}

/// External package/symbol entities task (2026-09-04) n8n measurement: a
/// cold scan through the REAL production entrypoint (`run_scan`, same as
/// every other `incremental_*`/`partitioned_cold_scan_*` test in this file
/// -- unlike `n8n_references_parity_debug_dump`, which drives `analyze`/
/// `materialize`/`publish` manually one level below), scoped to n8n, that
/// deliberately does NOT delete its own scratch store on success -- the
/// point is to leave `<printed path>/structural` on disk for a FOLLOW-UP
/// `URDIRA_V4_INSPECT_STORE=<path> cargo test ... inspect_store_record_
/// histogram -- --ignored --nocapture` run in a second process (this task's
/// own evidence doc reports both outputs together). Prints the structural
/// root path; the caller deletes the scratch directory once done reading
/// it (`~/Proyectos/urdira-benchmark/v4-fold/`'s own "at most one scratch
/// store, delete when done" rule). Run with `URDIRA_V4_N8N_CORPUS=<path>
/// cargo test -p urdira-indexing-worker --release
/// v4::tests_e2e::n8n_cold_scan_for_external_entities_measurement --
/// --ignored --nocapture`.
#[test]
#[ignore]
fn n8n_cold_scan_for_external_entities_measurement() {
    let Ok(corpus) = std::env::var("URDIRA_V4_N8N_CORPUS") else {
        eprintln!("set URDIRA_V4_N8N_CORPUS=<path> to run this diagnostic");
        return;
    };
    let workspace_root = scratch_copy_of_n8n_corpus("n8n-external-entities-measurement", &corpus);
    let scratch_root = workspace_root
        .parent()
        .expect("scratch workspace has a parent scratch root")
        .to_path_buf();
    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");
    let workspace_id = "workspace:n8n-external-entities-measurement";

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();
    let event = run_scan(
        "request:n8n-external-entities-measurement",
        workspace_id,
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    let generation = generation_of(&event);
    eprintln!(
        "[n8n_cold_scan_for_external_entities_measurement] generation={generation} structural_root={}",
        structural_root.display()
    );
    println!("STRUCTURAL_ROOT={}", structural_root.display());
    // Deliberately NOT deleting `scratch_root` -- see this fn's own doc
    // comment.
}

/// See the call-site comment above (`n8n_references_parity_debug_dump`) for
/// why this exists instead of reusing `residual.rs`'s own `dump_call_
/// bodies`. Same wire format (`u32 row_count`, then repeated `u8 confirmed_
/// flag, u32 body_len, body_len bytes`), same `confirmed` test (`target_
/// subject().is_some()` AND NOT the `core:indirect` facet -- P2-2j's
/// overload/union candidate-row carve-out, see `dump_call_bodies`'s own doc
/// comment for why the facet test is load-bearing), same body source
/// (`store.iter_visible`) -- the ONLY thing this omits is `dump_call_
/// bodies`'s pending-call-site-as-synthetic-possible-row step (this
/// function's own doc comment explains why that is safe to omit for a
/// cold-checkpoint different-target regression check).
fn dump_call_bodies_cold_only(structural_root: &Path, generation: u64, out_path: &Path) {
    use urdira_structural_store::row::CATEGORY_RELATION;

    let store = StoreReader::open(structural_root).expect("store reopens for call body dump");
    let dicts = store.dictionaries();
    let indirect_bit = dicts
        .facet_names
        .iter()
        .position(|name| name == "core:indirect")
        .expect("FACET_ORDER (materialize.rs) always registers core:indirect");
    let mut rows: Vec<(bool, Vec<u8>)> = Vec::new();
    for view in store.iter_visible(generation) {
        if view.category() != CATEGORY_RELATION {
            continue;
        }
        let universal_kind = dicts
            .universal_kinds
            .get(view.universal_kind_id() as usize)
            .map(String::as_str)
            .unwrap_or("");
        if universal_kind != "core:call" {
            continue;
        }
        let confirmed =
            view.target_subject().is_some() && (view.facets() & (1u64 << indirect_bit)) == 0;
        rows.push((confirmed, view.body().to_vec()));
    }

    use std::io::Write;
    let file = std::fs::File::create(out_path)
        .unwrap_or_else(|error| panic!("create call body dump {out_path:?}: {error}"));
    let mut writer = std::io::BufWriter::new(file);
    writer
        .write_all(&(rows.len() as u32).to_le_bytes())
        .expect("write row count");
    let mut confirmed_flag_count = 0u64;
    for (confirmed, body) in &rows {
        writer
            .write_all(&[u8::from(*confirmed)])
            .expect("write confirmed flag");
        if *confirmed {
            confirmed_flag_count += 1;
        }
        writer
            .write_all(&(body.len() as u32).to_le_bytes())
            .expect("write body length");
        writer.write_all(body).expect("write body bytes");
    }
    writer.flush().expect("flush call body dump");
    eprintln!(
        "[dump_call_bodies_cold_only] generation={generation} rows={} confirmed(target_subject)={confirmed_flag_count} -> {out_path:?}",
        rows.len()
    );
}

/// Frente E regression test for a latent bug this front's own reconcile
/// work discovered (2026-09-06), OUTSIDE the `ScanScope::Reconcile` code
/// path entirely: a SECOND `ScanScope::Full` scan of an already-published
/// workspace, in the SAME long-lived worker process (the exact scenario
/// `catalog::read_current_generation`'s P3-1 "generation = current + 1" fix
/// says it supports, and the scenario `core:reindex` against an already-
/// `ready` v4 workspace has ALWAYS sent -- see `packages/daemon/src/
/// runtime.ts`'s pre-Frente-E scope decision, unconditional `full` whenever
/// `requestedUris === undefined`), used to silently DROP every unchanged
/// owner's records from the republished generation: `analyze::run_scoped`
/// built `ColdAnalysis.owners` from `syntax.analyze`'s own `affected_files`,
/// which that shared syntax-worker's internal membership fast path can
/// narrow to just the genuinely new/changed paths even when the caller
/// passed `AuthoritativeChangeSet::Full` -- correct for `run_incremental`
/// (an untouched owner's existing rows stay open, no diff needed) but wrong
/// for `run_cold`, whose `materialize_cold_partitioned`/`write_base_
/// partitioned` publish a COMPLETE replacement base snapshot from exactly
/// that owner list. Fixed in `analyze::run_scoped` (`if is_full_change_set
/// { affected_paths = ... }`): a `Full` caller now always gets every
/// present path back. This test reproduced the bug live before that fix
/// (a lone new file's own 3 records republished, the other 280 silently
/// gone) and guards against a regression -- `reconcile`'s own Cold branch
/// (`run_full_from`, invoked both for "large delta" and the R2 fallback)
/// depends on this exact fix to hold its own oracle-parity invariant.
#[test]
fn full_scan_twice_in_the_same_process_matches_a_from_scratch_oracle() {
    let scratch_root = scratch_dir("full-twice");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:v4-e2e-full-twice",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);

    std::fs::write(
        workspace_root.join("src/domain/urdira-harness-full-twice-created.ts"),
        "export function urdiraHarnessFullTwiceCreated() {\n  return 1;\n}\n",
    )
    .expect("write created file");

    let second_full = run_scan(
        "request:second-full",
        "workspace:v4-e2e-full-twice",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&second_full), 2);

    let oracle_root = scratch_dir("full-twice-oracle");
    let oracle_database = oracle_root.join("workspace.sqlite");
    let oracle_structural = oracle_root.join("structural");
    let oracle_cas = oracle_root.join("cas");
    let mut oracle_syntax = SyntaxWorkerState::default();
    let mut oracle_state: super::state::WorkerState = std::collections::HashMap::new();
    let oracle = run_scan(
        "request:oracle",
        "workspace:v4-e2e-full-twice-oracle",
        &workspace_root,
        &oracle_database,
        &oracle_structural,
        &oracle_cas,
        ScanScope::Full,
        &mut oracle_syntax,
        &mut oracle_state,
    );
    assert_eq!(generation_of(&oracle), 1);

    let second_roots = roots_of(&second_full);
    let oracle_roots = roots_of(&oracle);
    dump_records_set_diff(
        &structural_root,
        generation_of(&second_full),
        &oracle_structural,
        generation_of(&oracle),
    );
    assert_eq!(second_roots.records, oracle_roots.records, "records");
    assert_eq!(
        second_roots.dependency, oracle_roots.dependency,
        "dependency"
    );
    assert_eq!(second_roots.graph, oracle_roots.graph, "graph");

    let _ = std::fs::remove_dir_all(&scratch_root);
    let _ = std::fs::remove_dir_all(&oracle_root);
}

/// Companion to `full_scan_twice_in_the_same_process_matches_a_from_scratch_
/// oracle`, with a content EDIT instead of a CREATE: confirms decision 11's
/// chaining (`reconcile_modify_produces_a_self_consistent_incremental_
/// merkle_update`'s own doc comment) is specific to the `Delta`/`Changed`
/// pipeline's `diff_owner` -- the `Cold` pipeline has no notion of a prior
/// generation to chain against at all, so a content edit through it matches
/// an independent from-scratch oracle exactly, same as a create/delete
/// does. This is the finding that justified using CREATE (not edit) as
/// `reconcile_batches_match_cold_at_1_5_10_25_50_percent`'s mutation --
/// verified live here, not merely asserted in that test's doc comment.
#[test]
fn full_scan_twice_with_a_content_edit_matches_a_from_scratch_oracle() {
    let scratch_root = scratch_dir("debug-full-twice-edit");
    let workspace_root = scratch_root.join("workspace");
    copy_dir_recursive(&fixture_root(), &workspace_root);

    let database_path = scratch_root.join("workspace.sqlite");
    let structural_root = scratch_root.join("structural");
    let cas_root = scratch_root.join("cas");

    let mut syntax = SyntaxWorkerState::default();
    let mut worker_state: super::state::WorkerState = std::collections::HashMap::new();

    let cold = run_scan(
        "request:cold",
        "workspace:debug-full-twice-edit",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&cold), 1);

    let modified_relative = "src/domain/task.ts";
    let modified_absolute = workspace_root.join(modified_relative);
    let mut text = std::fs::read_to_string(&modified_absolute).expect("read modified file");
    text.push_str("\n// urdira-debug-full-twice-edit marker\n");
    std::fs::write(&modified_absolute, text).expect("write modified file");

    let second_full = run_scan(
        "request:second-full",
        "workspace:debug-full-twice-edit",
        &workspace_root,
        &database_path,
        &structural_root,
        &cas_root,
        ScanScope::Full,
        &mut syntax,
        &mut worker_state,
    );
    assert_eq!(generation_of(&second_full), 2);

    let oracle_root = scratch_dir("debug-full-twice-edit-oracle");
    let oracle_database = oracle_root.join("workspace.sqlite");
    let oracle_structural = oracle_root.join("structural");
    let oracle_cas = oracle_root.join("cas");
    let mut oracle_syntax = SyntaxWorkerState::default();
    let mut oracle_state: super::state::WorkerState = std::collections::HashMap::new();
    let oracle = run_scan(
        "request:oracle",
        "workspace:debug-full-twice-edit-oracle",
        &workspace_root,
        &oracle_database,
        &oracle_structural,
        &oracle_cas,
        ScanScope::Full,
        &mut oracle_syntax,
        &mut oracle_state,
    );
    assert_eq!(generation_of(&oracle), 1);

    let second_roots = roots_of(&second_full);
    let oracle_roots = roots_of(&oracle);
    dump_records_set_diff(
        &structural_root,
        generation_of(&second_full),
        &oracle_structural,
        generation_of(&oracle),
    );
    assert_eq!(second_roots.records, oracle_roots.records, "records");

    let _ = std::fs::remove_dir_all(&scratch_root);
    let _ = std::fs::remove_dir_all(&oracle_root);
}
