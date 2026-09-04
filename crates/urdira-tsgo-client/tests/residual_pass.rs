//! Integration tests for task P1-D-b (`crate::residual_pass` +
//! `crate::virtual_fs::LayeredFs`/`OverlayFs` + `crate::entity_index`) —
//! against the REAL tsgo binary (skips, printing why, rather than failing,
//! when it is not discoverable, matching `tests/oracle_resolve.rs`'s own
//! policy).
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

fn discover_binary() -> Option<TsgoBinary> {
    match binary::discover(&repo_root()) {
        Ok(b) => Some(b),
        Err(e) => {
            eprintln!("skipping: tsgo binary not discoverable: {e}");
            None
        }
    }
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
    let Some(tsgo) = discover_binary() else {
        return Vec::new();
    };
    let (fs, plan, pending_by_owner) = build_fixture();
    let config = ResidualPassConfig {
        lib_roots: vec![lib_root_dir(&tsgo)],
        binary: tsgo,
        root: VIRTUAL_ROOT.to_string(),
        project_config_path: CONFIG_PATH.to_string(),
        compiler_options: compiler_options(),
        fetch_semantics: false,
    };
    ResidualPass::run(&plan, lanes, &pending_by_owner, fs, &config)
        .expect("residual pass should succeed")
}

#[test]
fn resolves_lib_globals_external_and_cross_window_targets_workspace() {
    let results = run_pass(1);
    if results.is_empty() {
        return; // tsgo not available; already logged by discover_binary().
    }
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
fn one_lane_and_two_lanes_agree_exactly() {
    let one_lane = run_pass(1);
    if one_lane.is_empty() {
        return; // tsgo not available.
    }
    let two_lanes = run_pass(2);
    assert_eq!(
        one_lane, two_lanes,
        "splitting the same 3-window plan across 1 vs. 2 lanes must not change the result"
    );
}

#[test]
fn entity_index_maps_a_resolved_workspace_target_back_to_a_caller_entity_id() {
    let results = run_pass(1);
    if results.is_empty() {
        return; // tsgo not available.
    }
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
