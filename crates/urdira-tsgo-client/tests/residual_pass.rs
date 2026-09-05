//! Integration tests for task P1-D-b (`crate::residual_pass` +
//! `crate::virtual_fs::LayeredFs`/`OverlayFs` + `crate::entity_index`) —
//! against the REAL tsgo binary. C.4 (2026-09-05): every test here is
//! `#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]` and calls
//! `binary::discover_for_tests`, which panics (with guidance) rather than
//! silently skipping when the binary is not discoverable — a test that
//! "needs tsgo" must never report `ok` without actually exercising the RPC
//! path (see `binary::discover_for_tests`'s own doc comment for why).
//!

//! Covers exactly the risks the task brief called out:
//! - **Lib resolution**: `[1, 2].map(...)` resolves to a declaration inside
//!   a real `lib.*.d.ts` file, classified `SiteOutcome::External`, not a
//!   workspace entity.
//! - **Cross-window resolution**: with `window_size = 1` (one file per
//!   window/project), a site in `a.ts`'s own window (which therefore does
//!   NOT list `b.ts` as a root) still resolves to a declaration in `b.ts` —
//!   `getSourceFile`/module resolution reaches it via the import graph
//!   regardless of window boundaries, exactly like
//!   `analyzer.ts`'s `activateRustSemanticWindow` relies on (the full
//!   source map stays available; only `files:` narrows).
//! - **Lanes**: the same pending sites resolved via 1 lane vs. 2 lanes
//!   (split across the 3-window plan) produce byte-for-byte identical
//!   output, in the same deterministic (owner, start) order.
//! - **Entity-id mapping**: `EntityIndex` maps a resolved `WorkspaceTarget`
//!   back to a caller-supplied entity id by exact `(path, name start)`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use urdira_tsgo_client::binary::{self, TsgoBinary};
use urdira_tsgo_client::entity_index::EntityIndex;
use urdira_tsgo_client::residual_pass::{
    ResidualPass, ResidualPassConfig, SiteOutcome, WindowPlan,
};
use urdira_tsgo_client::resolver::{PendingSite, SiteKind};
use urdira_tsgo_client::virtual_fs::{MapFs, VirtualFs};

const VIRTUAL_ROOT: &str = "/workspace";
const CONFIG_PATH: &str = "/workspace/__residual_pass_test__.json";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root should exist")
}

/// The resolved platform package's `lib/` directory — holds both the
/// native binary and every `lib.*.d.ts` file side by side (confirmed live
/// for this repo's pinned `typescript@7.0.2`; see
/// `docs/evidence/2026-09-03-v4-p1d-b-residual-pass.md` §1).
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

/// Finds the UTF-16 `[start, end)` span of the `occurrence`-th (1-based)
/// occurrence of `needle` in `text`. Panics (test setup error) if there are
/// fewer than `occurrence` occurrences. Copied from `tests/oracle_resolve
/// .rs`'s own helper of the same name/behavior (kept test-local rather than
/// shared, matching that file's own choice not to export test helpers from
/// the crate).
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

const A_TS: &str = r#"import { Base } from "./b";

export function consume(x: Base): number {
  return [1, 2].map((n) => n).length + x.value;
}
"#;

const B_TS: &str = r#"export class Base {
  value = 1;
}
"#;

const C_TS: &str = r#"import { Base } from "./b";

export function makeBase(): Base {
  return new Base();
}
"#;

fn virtual_path(name: &str) -> String {
    format!("{VIRTUAL_ROOT}/{name}")
}

/// Builds the 3-file, 3-window (`window_size = 1`) fixture shared by every
/// test below: `a.ts` (lib call + cross-window identifier ref to `b.ts`),
/// `b.ts` (the cross-window target, no pending sites of its own), `c.ts`
/// (a cross-window `Call` site via `new Base()`).
fn build_fixture() -> (
    Arc<dyn VirtualFs>,
    WindowPlan,
    BTreeMap<String, Vec<PendingSite>>,
) {
    let mut fs = MapFs::new();
    fs.insert(virtual_path("a.ts"), A_TS);
    fs.insert(virtual_path("b.ts"), B_TS);
    fs.insert(virtual_path("c.ts"), C_TS);
    fs.insert(virtual_path("package.json"), r#"{"type":"module"}"#);
    let fs: Arc<dyn VirtualFs> = Arc::new(fs);

    let root_names = vec![
        virtual_path("a.ts"),
        virtual_path("b.ts"),
        virtual_path("c.ts"),
    ];
    let plan = WindowPlan::build(&root_names, 1);
    assert_eq!(plan.windows.len(), 3, "expected one window per file");
    assert_eq!(plan.windows[0].roots, vec![virtual_path("a.ts")]);
    assert_eq!(plan.windows[1].roots, vec![virtual_path("b.ts")]);
    assert_eq!(plan.windows[2].roots, vec![virtual_path("c.ts")]);

    let (map_start, map_end) = find_utf16_span(A_TS, "[1, 2].map((n) => n)", 1);
    let (base_type_start, base_type_end) = find_utf16_span(A_TS, "Base", 2); // 1st occurrence is the import specifier
    let (new_base_start, new_base_end) = find_utf16_span(C_TS, "new Base()", 1);

    let pending_by_owner = BTreeMap::from([
        (
            virtual_path("a.ts"),
            vec![
                PendingSite {
                    owner_path: virtual_path("a.ts"),
                    start: map_start,
                    end: map_end,
                    kind: SiteKind::Call,
                    reason: "lib_member_call".to_string(),
                },
                PendingSite {
                    owner_path: virtual_path("a.ts"),
                    start: base_type_start,
                    end: base_type_end,
                    kind: SiteKind::IdentifierRef,
                    reason: "cross_window_type_annotation".to_string(),
                },
            ],
        ),
        (
            virtual_path("c.ts"),
            vec![PendingSite {
                owner_path: virtual_path("c.ts"),
                start: new_base_start,
                end: new_base_end,
                kind: SiteKind::Call,
                reason: "cross_window_new_expression".to_string(),
            }],
        ),
    ]);

    (fs, plan, pending_by_owner)
}

fn run_pass(lanes: usize) -> Vec<urdira_tsgo_client::residual_pass::ResolvedSite> {
    let tsgo = binary::discover_for_tests(&repo_root());
    let (fs, plan, pending_by_owner) = build_fixture();
    let config = ResidualPassConfig {
        lib_roots: vec![lib_root_dir(&tsgo)],
        binary: tsgo,
        root: VIRTUAL_ROOT.to_string(),
        project_config_path: CONFIG_PATH.to_string(),
        compiler_options: compiler_options(),
        fetch_semantics: false,
        deadline: None,
    };
    ResidualPass::run(&plan, lanes, &pending_by_owner, fs, &config)
        .expect("residual pass should succeed")
}

#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn resolves_lib_globals_external_and_cross_window_targets_workspace() {
    let results = run_pass(1);
    assert_eq!(results.len(), 3, "expected exactly 3 resolved sites");

    let map_site = results
        .iter()
        .find(|r| r.owner_path == virtual_path("a.ts") && r.site_kind == SiteKind::Call)
        .expect("the lib member-call site should be present");
    match &map_site.outcome {
        SiteOutcome::External {
            lib_file,
            symbol_name,
        } => {
            assert!(
                lib_file.ends_with(".d.ts") && lib_file.starts_with("lib."),
                "expected a lib.*.d.ts file, got {lib_file:?}"
            );
            assert_eq!(symbol_name, "map");
        }
        other => panic!("expected [1, 2].map(...) to resolve as External, got {other:?}"),
    }

    let identifier_ref_site = results
        .iter()
        .find(|r| r.owner_path == virtual_path("a.ts") && r.site_kind == SiteKind::IdentifierRef)
        .expect("the cross-window identifier_ref site should be present");
    match &identifier_ref_site.outcome {
        SiteOutcome::WorkspaceTarget { path, .. } => {
            assert_eq!(
                path,
                &virtual_path("b.ts"),
                "the `x: Base` type annotation in a.ts's own window (which does not list b.ts \
                 as a root) should still resolve into b.ts via module resolution"
            );
        }
        other => {
            panic!("expected the Base type annotation to resolve as WorkspaceTarget, got {other:?}")
        }
    }

    let new_expression_site = results
        .iter()
        .find(|r| r.owner_path == virtual_path("c.ts"))
        .expect("the cross-window new-expression call site should be present");
    match &new_expression_site.outcome {
        SiteOutcome::WorkspaceTarget { path, .. } => {
            assert_eq!(path, &virtual_path("b.ts"));
        }
        other => {
            panic!("expected `new Base()` in c.ts to resolve as WorkspaceTarget, got {other:?}")
        }
    }

    // Deterministic output order: owner path, then start.
    let mut sorted = results.clone();
    sorted.sort_by(|a, b| {
        a.owner_path
            .cmp(&b.owner_path)
            .then(a.start_utf16.cmp(&b.start_utf16))
    });
    assert_eq!(
        results, sorted,
        "ResidualPass::run must already return sorted output"
    );
}

#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn one_lane_and_two_lanes_agree_exactly() {
    let one_lane = run_pass(1);
    let two_lanes = run_pass(2);
    assert_eq!(
        one_lane, two_lanes,
        "splitting the same 3-window plan across 1 vs. 2 lanes must not change the result"
    );
}

#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn entity_index_maps_a_resolved_workspace_target_back_to_a_caller_entity_id() {
    let results = run_pass(1);
    let identifier_ref_site = results
        .iter()
        .find(|r| r.owner_path == virtual_path("a.ts") && r.site_kind == SiteKind::IdentifierRef)
        .expect("the cross-window identifier_ref site should be present");
    let SiteOutcome::WorkspaceTarget {
        path,
        name_start_utf16,
        ..
    } = &identifier_ref_site.outcome
    else {
        panic!(
            "expected a WorkspaceTarget outcome, got {:?}",
            identifier_ref_site.outcome
        );
    };

    // The caller's own entity table would have named `Base`'s class
    // declaration by its "class" identity, anchored at the SAME name-start
    // position the resolver computed (`analyzer.ts`'s `stableId` /
    // `semantic_sites.rs`'s `declaration_id` -- both `jsts:{kind}:{path}:
    // {start}:{name}`); the exact start value must come from independent
    // computation (here, the known offset of `Base` in b.ts's own text) to
    // make this a real check, not a tautology against the resolver's own
    // output.
    let (expected_name_start, _) = find_utf16_span(B_TS, "Base", 1);
    assert_eq!(
        *name_start_utf16, expected_name_start,
        "resolver's name_identifier_start should match b.ts's own `Base` identifier position"
    );

    let entity_id = format!("jsts:class:{path}:{expected_name_start}:Base");
    let index = EntityIndex::build([(path.clone(), *name_start_utf16, entity_id.clone())]);
    assert_eq!(
        index.lookup_workspace_target(&identifier_ref_site.outcome),
        Some(entity_id.as_str())
    );
    assert_eq!(index.lookup(path, 999_999), None);
}

/// F4 4.2: a `deadline` already in the past — deterministic regardless of
/// how long `updateSnapshot`/resolve actually take (a monotonic clock only
/// moves forward, so `Instant::now() >= deadline` is guaranteed true the
/// very first time `run_lane` checks it, before it ever opens window 0).
/// Verifies `run_instrumented`'s own truncation reporting end to end: zero
/// sites resolved, `truncated == true`, and `remaining_roots` names every
/// root in the plan (nothing was ever opened) — not a stale/partial list.
#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn deadline_already_past_truncates_before_the_first_window() {
    let tsgo = binary::discover_for_tests(&repo_root());
    let (fs, plan, pending_by_owner) = build_fixture();
    let config = ResidualPassConfig {
        lib_roots: vec![lib_root_dir(&tsgo)],
        binary: tsgo,
        root: VIRTUAL_ROOT.to_string(),
        project_config_path: CONFIG_PATH.to_string(),
        compiler_options: compiler_options(),
        fetch_semantics: false,
        deadline: Some(std::time::Instant::now() - std::time::Duration::from_secs(1)),
    };
    let (resolved, stats) =
        ResidualPass::run_instrumented(&plan, 1, &pending_by_owner, fs, &config)
            .expect("a truncated pass is still Ok, never an error");
    assert!(
        resolved.is_empty(),
        "no window should have opened at all: {resolved:?}"
    );
    assert!(stats.truncated, "expected the pass to report truncation");
    assert_eq!(stats.windows.len(), 0, "no window telemetry recorded");
    assert_eq!(stats.windows_total, 3);
    let mut remaining = stats.remaining_roots.clone();
    remaining.sort();
    let mut expected: Vec<String> = plan.windows.iter().flat_map(|w| w.roots.clone()).collect();
    expected.sort();
    assert_eq!(
        remaining, expected,
        "every root should still be pending -- nothing was ever opened"
    );
}

/// F4 4.2's core correctness property ("dos pases publican lo mismo que
/// uno sin cota"): splitting the SAME 3-window fixture into a first pass
/// over only window 0's roots and a follow-up pass over the remaining two
/// windows' roots (exactly what `residual.rs::schedule`'s re-trigger does
/// with `ResidualOutcome::remaining_roots`) must produce the identical
/// resolved-site set as one unbounded pass over the whole plan — proving
/// the window/plan abstraction is split-order-independent, which is the
/// actual invariant a truncated-then-resumed residual pass relies on
/// (deterministically, with no dependency on real wall-clock timing).
#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn splitting_the_plan_across_two_passes_matches_one_unbounded_pass() {
    let tsgo = binary::discover_for_tests(&repo_root());
    let (fs, plan, pending_by_owner) = build_fixture();

    let config_for = |binary: TsgoBinary| ResidualPassConfig {
        lib_roots: vec![lib_root_dir(&binary)],
        binary,
        root: VIRTUAL_ROOT.to_string(),
        project_config_path: CONFIG_PATH.to_string(),
        compiler_options: compiler_options(),
        fetch_semantics: false,
        deadline: None,
    };

    let unbounded_config = config_for(tsgo);
    let mut unbounded = ResidualPass::run(
        &plan,
        1,
        &pending_by_owner,
        Arc::clone(&fs),
        &unbounded_config,
    )
    .expect("unbounded pass should succeed");
    unbounded.sort_by(|a, b| {
        a.owner_path
            .cmp(&b.owner_path)
            .then(a.start_utf16.cmp(&b.start_utf16))
    });

    // "First generation": only window 0 (`a.ts`).
    let first_plan = WindowPlan {
        windows: plan.windows[..1].to_vec(),
    };
    let tsgo_again = binary::discover_for_tests(&repo_root());
    let first_config = config_for(tsgo_again);
    let mut split: Vec<_> = ResidualPass::run(
        &first_plan,
        1,
        &pending_by_owner,
        Arc::clone(&fs),
        &first_config,
    )
    .expect("first (window-0-only) pass should succeed");

    // "Second generation": exactly the remaining roots (`b.ts`, `c.ts`) --
    // the same shape `residual.rs::schedule`'s re-trigger builds from
    // `ResidualOutcome::remaining_roots`.
    let remaining_roots: Vec<String> = plan.windows[1..]
        .iter()
        .flat_map(|w| w.roots.clone())
        .collect();
    let second_plan = WindowPlan::build(&remaining_roots, 1);
    let tsgo_third = binary::discover_for_tests(&repo_root());
    let second_config = config_for(tsgo_third);
    let second = ResidualPass::run(&second_plan, 1, &pending_by_owner, fs, &second_config)
        .expect("second (resumed) pass should succeed");
    split.extend(second);
    split.sort_by(|a, b| {
        a.owner_path
            .cmp(&b.owner_path)
            .then(a.start_utf16.cmp(&b.start_utf16))
    });

    assert_eq!(
        unbounded, split,
        "two passes (window 0, then the remaining windows) must publish exactly what one \
         unbounded pass over the whole plan would"
    );
}

const INTRA_WINDOW_CALL_TS: &str = r#"export function run(): number {
  return [1, 2].map((n) => n).length;
}
"#;

/// Number of no-pending-site filler roots in window 1 -- large enough that
/// their aggregate semantics-fetch cost dominates the fixed per-lane
/// startup cost (child process spawn + `initialize()`, ~200ms on this
/// machine, paid once by window 0) by a comfortable margin, giving check
/// point `(b)`'s calibrated deadline many roots' worth of room to land
/// strictly between two of them rather than exactly at a window boundary.
const FILLER_ROOT_COUNT: usize = 500;

/// One filler root's content: `n` exported functions/interfaces (`n` in
/// the name only to keep every file's text distinct enough that `tsgo`
/// cannot short-circuit identical parses) -- real semantic surface for
/// `fetch_exported_types`/`fetch_owner_diagnostics` to walk, unlike a
/// single trivial declaration, so each root's own fetch cost is non-
/// negligible relative to system-clock/RPC jitter.
fn filler_text(seed: usize) -> String {
    let mut text = String::new();
    for i in 0..12 {
        text.push_str(&format!(
            "export function value_{seed}_{i}(input: number): number {{\n  return input + {i};\n}}\n\n"
        ));
        text.push_str(&format!(
            "export interface Shape_{seed}_{i} {{\n  x: number;\n  y: number;\n  label: string;\n}}\n\n"
        ));
    }
    text
}

/// Builds the fixture for
/// `intra_window_deadline_truncates_mid_semantics_fetch_and_a_resumed_
/// pass_matches_unbounded`: window 0 = `a.ts` alone (the ONLY file with a
/// real pending call site, used for calibration too), window 1 =
/// `FILLER_ROOT_COUNT` filler roots with NO pending sites of their own
/// (wide and heavy enough to give check point `(b)` many places to land
/// strictly between two roots), window 2 = `f.ts` alone (structurally
/// identical to `a.ts`, so it always has real call/heritage work left for
/// the resumed pass). Windows are built BY HAND rather than via
/// `WindowPlan::build` (which only produces uniform-size windows), since
/// this fixture deliberately needs window 1 wider than windows 0/2.
fn build_intra_window_fixture() -> (
    Arc<dyn VirtualFs>,
    WindowPlan,
    BTreeMap<String, Vec<PendingSite>>,
) {
    let mut fs = MapFs::new();
    fs.insert(virtual_path("a.ts"), INTRA_WINDOW_CALL_TS);
    let filler_names: Vec<String> = (0..FILLER_ROOT_COUNT)
        .map(|i| format!("filler_{i:03}.ts"))
        .collect();
    for (i, name) in filler_names.iter().enumerate() {
        fs.insert(virtual_path(name), filler_text(i));
    }
    fs.insert(virtual_path("f.ts"), INTRA_WINDOW_CALL_TS);
    fs.insert(virtual_path("package.json"), r#"{"type":"module"}"#);
    let fs: Arc<dyn VirtualFs> = Arc::new(fs);

    let plan = WindowPlan {
        windows: vec![
            urdira_tsgo_client::residual_pass::Window {
                index: 0,
                roots: vec![virtual_path("a.ts")],
            },
            urdira_tsgo_client::residual_pass::Window {
                index: 1,
                roots: filler_names.iter().map(|n| virtual_path(n)).collect(),
            },
            urdira_tsgo_client::residual_pass::Window {
                index: 2,
                roots: vec![virtual_path("f.ts")],
            },
        ],
    };

    let (map_start_a, map_end_a) = find_utf16_span(INTRA_WINDOW_CALL_TS, "[1, 2].map((n) => n)", 1);
    let (map_start_f, map_end_f) = find_utf16_span(INTRA_WINDOW_CALL_TS, "[1, 2].map((n) => n)", 1);

    let pending_by_owner = BTreeMap::from([
        (
            virtual_path("a.ts"),
            vec![PendingSite {
                owner_path: virtual_path("a.ts"),
                start: map_start_a,
                end: map_end_a,
                kind: SiteKind::Call,
                reason: "lib_member_call".to_string(),
            }],
        ),
        (
            virtual_path("f.ts"),
            vec![PendingSite {
                owner_path: virtual_path("f.ts"),
                start: map_start_f,
                end: map_end_f,
                kind: SiteKind::Call,
                reason: "lib_member_call".to_string(),
            }],
        ),
    ]);

    (fs, plan, pending_by_owner)
}

/// C.1's core correctness property, CALIBRATED rather than hard-coded.
/// Deviates from the plan's own simplest recipe ("measure window 1 alone,
/// deadline = 1.5x that") in ONE respect, found live while writing this
/// test: on this machine, a fresh `TsgoClient` spawn + `initialize()`
/// handshake (paid once per lane, before window 0 even opens) dominates
/// window 0's own wall time and varies by HUNDREDS of milliseconds between
/// independent process spawns (observed 211ms and 632ms for the identical
/// window-0-alone fixture, back to back) -- while the checker's own
/// STEADY-STATE per-root cost, once warm, is only a few milliseconds. A
/// naive "1.5x window 0's absolute duration" deadline is therefore
/// dominated by spawn jitter, not by real per-root work, and lands
/// unpredictably. This test instead measures window 1's own INCREMENTAL
/// cost by DIFFERENCING two calibration runs (`run(window 0 alone)` vs.
/// `run(window 0 + window 1)`), which cancels out most of the absolute
/// spawn-time offset (both runs pay a similar, if not identical, spawn
/// cost), then makes window 1 wide/heavy enough (`FILLER_ROOT_COUNT`
/// filler roots) that half of its own incremental cost is a multi-second
/// margin -- comfortably larger than the spawn-jitter residual left after
/// differencing -- so the calibrated deadline reliably lands strictly
/// BETWEEN two of window 1's roots (check point `(b)`) rather than at a
/// window boundary (check point `(a)`) or past the end of the whole plan.
/// Verifies both halves of C.1: `WindowStats::partial` on the cut-off
/// window, and that a resumed pass over exactly `remaining_roots` plus the
/// truncated pass's own output publishes byte-for-byte what one unbounded
/// pass would (the same invariant `splitting_the_plan_across_two_passes_
/// matches_one_unbounded_pass` verifies for check point `(a)` alone).
#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn intra_window_deadline_truncates_mid_semantics_fetch_and_a_resumed_pass_matches_unbounded() {
    let tsgo = binary::discover_for_tests(&repo_root());
    let (fs, plan, pending_by_owner) = build_intra_window_fixture();

    let config_for =
        |binary: TsgoBinary, deadline: Option<std::time::Instant>| -> ResidualPassConfig {
            ResidualPassConfig {
                lib_roots: vec![lib_root_dir(&binary)],
                binary,
                root: VIRTUAL_ROOT.to_string(),
                project_config_path: CONFIG_PATH.to_string(),
                compiler_options: compiler_options(),
                fetch_semantics: true,
                deadline,
            }
        };

    // Calibration point 1: window 0 alone (`a.ts`) -- dominated by this
    // spawn's own client-startup cost.
    let calibration_plan_0 = WindowPlan {
        windows: plan.windows[..1].to_vec(),
    };
    let calibration_config_0 = config_for(tsgo, None);
    let calibration_0_start = std::time::Instant::now();
    let _ = ResidualPass::run(
        &calibration_plan_0,
        1,
        &pending_by_owner,
        Arc::clone(&fs),
        &calibration_config_0,
    )
    .expect("calibration pass over window 0 alone should succeed");
    let window0_duration = calibration_0_start.elapsed();

    // Calibration point 2: window 0 + window 1 together, a SEPARATE spawn
    // -- its own startup cost is not identical to calibration point 1's,
    // but differencing the two still cancels most of the shared "startup +
    // window 0" component, leaving an estimate of window 1's own
    // incremental cost that is far less sensitive to spawn jitter than
    // either absolute duration alone.
    let tsgo_calibration_01 = binary::discover_for_tests(&repo_root());
    let calibration_plan_01 = WindowPlan {
        windows: plan.windows[..2].to_vec(),
    };
    let calibration_config_01 = config_for(tsgo_calibration_01, None);
    let calibration_01_start = std::time::Instant::now();
    let _ = ResidualPass::run(
        &calibration_plan_01,
        1,
        &pending_by_owner,
        Arc::clone(&fs),
        &calibration_config_01,
    )
    .expect("calibration pass over window 0 + window 1 should succeed");
    let window01_duration = calibration_01_start.elapsed();
    let window1_incremental_duration = window01_duration.saturating_sub(window0_duration);
    eprintln!(
        "[intra_window_deadline] calibration: window0={window0_duration:?} \
         window0+1={window01_duration:?} window1_incremental={window1_incremental_duration:?}"
    );

    // Unbounded reference pass over the whole plan -- the ground truth
    // `truncated pass + resumed pass` must reproduce exactly.
    let tsgo_unbounded = binary::discover_for_tests(&repo_root());
    let unbounded_config = config_for(tsgo_unbounded, None);
    let mut unbounded = ResidualPass::run(
        &plan,
        1,
        &pending_by_owner,
        Arc::clone(&fs),
        &unbounded_config,
    )
    .expect("unbounded pass should succeed");
    unbounded.sort_by(|a, b| {
        a.owner_path
            .cmp(&b.owner_path)
            .then(a.start_utf16.cmp(&b.start_utf16))
    });

    // The real, truncated run: deadline at window 0's own calibrated
    // duration PLUS half of window 1's own incremental cost, set right
    // before THIS run starts (not before calibration).
    let tsgo_truncated = binary::discover_for_tests(&repo_root());
    let deadline =
        std::time::Instant::now() + window0_duration + window1_incremental_duration.mul_f64(0.5);
    let truncated_config = config_for(tsgo_truncated, Some(deadline));
    let (mut first_pass, stats) = ResidualPass::run_instrumented(
        &plan,
        1,
        &pending_by_owner,
        Arc::clone(&fs),
        &truncated_config,
    )
    .expect("a truncated pass is still Ok, never an error");
    eprintln!(
        "[intra_window_deadline] truncated={} windows_done={} remaining_roots={}",
        stats.truncated,
        stats.windows.len(),
        stats.remaining_roots.len()
    );

    assert!(
        stats.truncated,
        "expected the calibrated deadline to truncate the pass"
    );
    assert_eq!(
        stats.windows.len(),
        2,
        "window 0 and window 1 should have opened; window 2 should never open: {:?}",
        stats.windows
    );
    assert!(
        !stats.windows[0].partial,
        "window 0 (calibration reference) should complete fully before the deadline: {:?}",
        stats.windows[0]
    );
    assert!(
        stats.windows[1].partial,
        "window 1 should be cut off mid-semantics-loop (check point (b)), not fully done: {:?}",
        stats.windows[1]
    );

    let filler_roots: Vec<String> = plan.windows[1].roots.clone();
    let mut remaining = stats.remaining_roots.clone();
    remaining.sort();
    assert!(
        !remaining.is_empty(),
        "at least f.ts (window 2, never opened) must be in remaining_roots"
    );
    assert!(
        remaining.len() <= filler_roots.len() + 1,
        "remaining_roots can be at most window 1's {} roots + window 2's 1 root: {remaining:?}",
        filler_roots.len()
    );
    // Landing strictly BETWEEN two roots of window 1 (check point (b), not
    // a window boundary) means at least one filler root was processed
    // (present in `stats.types`/`stats.diagnostics`, absent from
    // `remaining`) and at least one was not (present in `remaining`) --
    // the calibration's whole point. If EVERY filler root ended up in
    // `remaining`, the deadline landed at window 1's own start (a
    // mis-calibration indistinguishable from check point (a)); if NONE
    // did, window 1 finished fully and the truncation must have happened
    // at check point (a) for window 2 instead -- either way the `partial`
    // assertion above already catches it, but this pins down *why*.
    let filler_remaining = remaining
        .iter()
        .filter(|r| filler_roots.contains(r))
        .count();
    assert!(
        filler_remaining > 0 && filler_remaining < filler_roots.len(),
        "expected the deadline to land strictly between two filler roots of window 1: \
         {filler_remaining}/{} filler roots remaining, remaining={remaining:?}",
        filler_roots.len()
    );
    assert!(
        remaining.contains(&virtual_path("f.ts")),
        "window 2 never opened -- f.ts must always be in remaining_roots: {remaining:?}"
    );
    assert!(
        !remaining.contains(&virtual_path("a.ts")),
        "window 0 completed fully -- a.ts must never be in remaining_roots: {remaining:?}"
    );
    for root in &remaining {
        assert!(
            root == &virtual_path("f.ts") || filler_roots.contains(root),
            "unexpected root in remaining_roots: {root}"
        );
    }

    // Resume: a second pass restricted to exactly `remaining_roots`, the
    // same shape `residual.rs::schedule`'s re-trigger builds from
    // `ResidualOutcome::remaining_roots`.
    let tsgo_resumed = binary::discover_for_tests(&repo_root());
    let resumed_plan = WindowPlan::build(&remaining, remaining.len().max(1));
    let resumed_config = config_for(tsgo_resumed, None);
    let second_pass = ResidualPass::run(&resumed_plan, 1, &pending_by_owner, fs, &resumed_config)
        .expect("resumed pass should succeed");

    first_pass.extend(second_pass);
    first_pass.sort_by(|a, b| {
        a.owner_path
            .cmp(&b.owner_path)
            .then(a.start_utf16.cmp(&b.start_utf16))
    });
    assert_eq!(
        unbounded, first_pass,
        "a truncated pass plus a resumed pass over remaining_roots must publish exactly what \
         one unbounded pass over the whole plan would"
    );
}
