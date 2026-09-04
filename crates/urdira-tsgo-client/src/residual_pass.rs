//! Task P1-D-b: turns the P1-D-a client + resolver into a complete
//! "residual pass" runner — windows over the full sorted root list, a
//! multi-lane (multi-process) split across those windows, lib.d.ts
//! resolution wired in via `crate::virtual_fs::LayeredFs`, and a typed
//! `Vec<(owner, span) -> outcome>` result a caller can turn into rows. This
//! module is still a LIBRARY — not wired into the indexing worker (that is
//! P1-D-c, after the incremental delta publish this pass is meant to feed
//! exists).
//!
//! # Window model
//!
//! Mirrors `packages/plugin-javascript-typescript/src/analyzer.ts`'s
//! `activateRustSemanticWindow` (~2112-2148): the full, sorted list of root
//! paths is cut into fixed-size contiguous windows
//! ([`WindowPlan::build`]); each window becomes one tsgo project (`files:
//! window.roots` in a synthetic project-config document — the checker's
//! own module resolution still sees every OTHER file too, because the
//! caller's `VirtualFs` holds the whole workspace map regardless of which
//! window is currently open, exactly like the Node analyzer's `fileMap`
//! staying complete while only `files` narrows).
//!
//! # Lane model
//!
//! Mirrors the checker-lane split in `crates/urdira-indexing-worker/src/
//! main.rs` (`semantic_parallelism`, the contiguous `chunks(block_size)`
//! partitioning in `compute_hybrid_semantics`): `windows` are split into
//! `lanes` CONTIGUOUS blocks, one `TsgoClient` (one OS child process) per
//! lane, each lane working through its blocks' windows sequentially —
//! `updateSnapshot` for the next window, resolve every owner in it,
//! `release` the previous snapshot. Lanes run on their own `std::thread`
//! (blocked on that thread's own child-process I/O, not CPU-bound), joined
//! at the end.
//!
//! # Outcome classification
//!
//! A resolved declaration is classified [`SiteOutcome::WorkspaceTarget`] or
//! [`SiteOutcome::External`] by checking whether its path falls under one
//! of the `VirtualFs`'s "real lib roots" (see `crate::virtual_fs::
//! LayeredFs`) — the one on-disk location this crate ever reads from for a
//! residual pass. Anything the resolver could not resolve at all becomes
//! [`SiteOutcome::Unresolved`], carrying the resolver's own reason string.

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::binary::TsgoBinary;
use crate::client::{ClientError, TsgoClient};
use crate::node::identifier_text_at;
use crate::proto::{FileChanges, UpdateSnapshotParams};
use crate::resolver::{PendingSite, ResidualResolver, Resolution, SiteKind};
use crate::trivia::to_utf16;
use crate::virtual_fs::{LayeredFs, OverlayFs, VirtualFs};

/// One contiguous, fixed-size slice of the full sorted root list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    /// Position of this window in `WindowPlan::windows` — stable, 0-based,
    /// independent of how the plan is later split across lanes.
    pub index: usize,
    pub roots: Vec<String>,
}

/// A full-corpus window plan: every root file assigned to exactly one
/// window, in sorted order, no gaps or overlaps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowPlan {
    pub windows: Vec<Window>,
}

impl WindowPlan {
    /// The Node analyzer's own default (`URDIRA_RUST_SEMANTIC_WINDOW_SIZE`'s
    /// fallback, `analyzer.ts` ~2124).
    pub const DEFAULT_WINDOW_SIZE: usize = 512;

    /// Splits `sorted_root_paths` (already deduplicated and sorted — this
    /// function trusts the caller's order and does not re-sort, matching
    /// `activateRustSemanticWindow`'s own precondition that `rootNames` is
    /// maintained sorted) into contiguous windows of at most `window_size`
    /// roots each. The last window may be shorter. An empty input produces
    /// an empty plan (zero windows), not one empty window.
    pub fn build(sorted_root_paths: &[String], window_size: usize) -> Self {
        assert!(window_size > 0, "window_size must be positive");
        let windows = sorted_root_paths
            .chunks(window_size)
            .enumerate()
            .map(|(index, roots)| Window {
                index,
                roots: roots.to_vec(),
            })
            .collect();
        Self { windows }
    }
}

/// Where a resolved declaration target lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SiteOutcome {
    /// Resolved to a declaration inside the workspace snapshot (any file
    /// reachable through the caller's `VirtualFs` that is NOT under one of
    /// its real lib roots) — the shape a caller maps to an entity id via
    /// [`crate::entity_index::EntityIndex`].
    WorkspaceTarget {
        path: String,
        name_start_utf16: i32,
        decl_start: i32,
        decl_end: i32,
        /// The declaration node's own `SyntaxKind` number
        /// (`crate::node::syntax_kind`) — see `ResolvedDeclaration::
        /// decl_kind`'s doc comment.
        kind_hint: u32,
    },
    /// Resolved to a declaration inside one of the real lib roots (a
    /// TypeScript default-lib `.d.ts` file) — a built-in global
    /// (`Array`, `Promise`, ...), never a workspace entity.
    External {
        /// The lib file's own basename (e.g. `"lib.es5.d.ts"`), not its
        /// full host-filesystem path — the exact directory a lib file lives
        /// under is a resolution-time accident of this machine's installed
        /// `typescript` package, not something a caller's entity graph
        /// should ever encode.
        lib_file: String,
        /// The resolved symbol's own name, read directly out of the lib
        /// file's text at the resolver's `name_identifier_start` (see
        /// `crate::node::identifier_text_at`) rather than round-tripping
        /// through another checker request. Empty string if, unexpectedly,
        /// no identifier starts there (not observed in practice — every lib
        /// declaration this crate has resolved names a plain identifier).
        symbol_name: String,
    },
    /// The resolver could not resolve this site at all — see
    /// `crate::resolver::Resolution::Unresolved`'s doc comment for the
    /// (non-exhaustive) reasons this can happen.
    Unresolved { reason: String },
}

/// One pending site's outcome, in the input site's own terms (owner, span,
/// kind) plus the classified result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSite {
    pub owner_path: String,
    pub start_utf16: i32,
    pub end_utf16: i32,
    pub site_kind: SiteKind,
    pub outcome: SiteOutcome,
}

/// Fixed configuration for one `ResidualPass::run` call — the parts that do
/// not vary window-to-window (contrast `Window::roots`, which does).
pub struct ResidualPassConfig {
    pub binary: TsgoBinary,
    /// `--cwd` tsgo is spawned with; also the root every virtual path in
    /// the caller's `VirtualFs` should be rooted under (matching
    /// `TsgoClient::spawn`'s own `root` parameter).
    pub root: String,
    /// Virtual path for the synthetic per-window project-config document
    /// this pass writes into an internal `OverlayFs` layered over the
    /// caller's `fs`. Must be a path the caller's `fs` would consider to
    /// live inside an existing, `directoryExists`-answering directory
    /// (ordinarily `root` itself) — this pass never creates directories,
    /// only overrides one file's content.
    pub project_config_path: String,
    /// `compilerOptions` for every window's synthetic project (the same
    /// object for every window in this pass — a full residual pass over one
    /// workspace snapshot has one compiler-options set, same as
    /// `activateRustSemanticWindow`'s `this.rustSemanticCompilerOptions`).
    pub compiler_options: serde_json::Value,
    /// Real, on-disk directories layered under the caller's virtual `fs`
    /// (`crate::virtual_fs::LayeredFs`) — ordinarily exactly one entry, the
    /// resolved tsgo platform package's `lib/` directory holding every
    /// `lib.*.d.ts` file (see that module's doc comment). A path resolving
    /// under one of these is classified `SiteOutcome::External` rather than
    /// `WorkspaceTarget`.
    pub lib_roots: Vec<String>,
}

#[derive(Debug)]
pub enum ResidualPassError {
    Client(ClientError),
    /// `updateSnapshot` for a window did not produce a project for this
    /// pass's own config path — would indicate a malformed config document
    /// or an `fs` that cannot serve `project_config_path`'s own directory.
    NoProjectForWindow {
        lane: usize,
        window_index: usize,
    },
    /// A lane's worker thread panicked rather than returning an error.
    LanePanicked {
        lane: usize,
    },
}

impl std::fmt::Display for ResidualPassError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResidualPassError::Client(e) => write!(f, "{e}"),
            ResidualPassError::NoProjectForWindow { lane, window_index } => write!(
                f,
                "lane {lane}: tsgo did not open a project for window {window_index}"
            ),
            ResidualPassError::LanePanicked { lane } => {
                write!(f, "lane {lane} worker thread panicked")
            }
        }
    }
}

impl std::error::Error for ResidualPassError {}

/// Per-window telemetry a caller (ordinarily a bench, not production code)
/// can use to understand where time and memory went — see
/// `ResidualPass::run_instrumented`. Not returned by the plain `run`, which
/// most callers should use.
#[derive(Debug, Clone)]
pub struct WindowStats {
    pub lane: usize,
    pub window_index: usize,
    pub roots: usize,
    pub snapshot_ms: f64,
    pub sites_resolved: usize,
    /// The lane's child tsgo process id, sampled right after this window's
    /// `updateSnapshot` returned (`crate::residual_pass::sample_rss_kb`) —
    /// present only when the `ps` sampling succeeded (e.g. absent on a
    /// platform without a `ps -o rss=` equivalent).
    pub child_rss_kb: Option<u64>,
}

/// Aggregate stats for one `ResidualPass::run_instrumented` call: one
/// `WindowStats` per window actually opened, across every lane.
#[derive(Debug, Clone, Default)]
pub struct PassStats {
    pub windows: Vec<WindowStats>,
}

/// Runs a residual pass: resolves every pending site under `pending_by_owner`
/// whose owner appears in `plan`, across `lanes` parallel tsgo child
/// processes, and returns every result in one deterministic (owner path,
/// then start) order regardless of which lane or window produced it.
pub struct ResidualPass;

impl ResidualPass {
    pub fn run(
        plan: &WindowPlan,
        lanes: usize,
        pending_by_owner: &BTreeMap<String, Vec<PendingSite>>,
        fs: Arc<dyn VirtualFs>,
        config: &ResidualPassConfig,
    ) -> Result<Vec<ResolvedSite>, ResidualPassError> {
        Self::run_instrumented(plan, lanes, pending_by_owner, fs, config).map(|(sites, _)| sites)
    }

    /// Like `run`, but also returns per-window timing/RSS telemetry
    /// (`PassStats`) — the shape `tests/bench_residual_pass.rs` needs to
    /// report a snapshot-latency distribution and per-lane memory, without
    /// every production caller of `run` paying for (or seeing) that detail.
    pub fn run_instrumented(
        plan: &WindowPlan,
        lanes: usize,
        pending_by_owner: &BTreeMap<String, Vec<PendingSite>>,
        fs: Arc<dyn VirtualFs>,
        config: &ResidualPassConfig,
    ) -> Result<(Vec<ResolvedSite>, PassStats), ResidualPassError> {
        let lanes = lanes.max(1);
        if plan.windows.is_empty() {
            return Ok((Vec::new(), PassStats::default()));
        }
        let block_size = plan.windows.len().div_ceil(lanes).max(1);
        let blocks: Vec<&[Window]> = plan.windows.chunks(block_size).collect();

        let (mut all, mut stats) = std::thread::scope(
            |scope| -> Result<(Vec<ResolvedSite>, PassStats), ResidualPassError> {
                let handles: Vec<_> = blocks
                    .into_iter()
                    .enumerate()
                    .map(|(lane_index, block)| {
                        let fs = Arc::clone(&fs);
                        scope.spawn(move || {
                            run_lane(lane_index, block, pending_by_owner, fs, config)
                        })
                    })
                    .collect();
                let mut all = Vec::new();
                let mut stats = PassStats::default();
                for (lane_index, handle) in handles.into_iter().enumerate() {
                    let (lane_sites, lane_stats) = handle
                        .join()
                        .map_err(|_| ResidualPassError::LanePanicked { lane: lane_index })??;
                    all.extend(lane_sites);
                    stats.windows.extend(lane_stats);
                }
                Ok((all, stats))
            },
        )?;

        all.sort_by(|a, b| {
            a.owner_path
                .cmp(&b.owner_path)
                .then(a.start_utf16.cmp(&b.start_utf16))
        });
        stats.windows.sort_by(|a, b| {
            a.lane
                .cmp(&b.lane)
                .then(a.window_index.cmp(&b.window_index))
        });
        Ok((all, stats))
    }
}

/// Samples a process's resident set size via `ps -o rss= -p <pid>` (KB on
/// both macOS and Linux). Best-effort: `None` on any failure (no `ps`, the
/// process already exited, an unsupported platform) rather than an error —
/// this is telemetry, never load-bearing for correctness.
fn sample_rss_kb(pid: u32) -> Option<u64> {
    let output = std::process::Command::new("ps")
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

/// Runs one lane's contiguous block of windows sequentially against one
/// long-lived `TsgoClient`, returning both its resolved sites and its own
/// per-window telemetry.
fn run_lane(
    lane_index: usize,
    windows: &[Window],
    pending_by_owner: &BTreeMap<String, Vec<PendingSite>>,
    fs: Arc<dyn VirtualFs>,
    config: &ResidualPassConfig,
) -> Result<(Vec<ResolvedSite>, Vec<WindowStats>), ResidualPassError> {
    let mut out = Vec::new();
    let mut stats = Vec::new();
    if windows.is_empty() {
        return Ok((out, stats));
    }

    let overlay = Arc::new(OverlayFs::new(fs));
    let layered: Arc<LayeredFs> = Arc::new(LayeredFs::new(
        overlay.clone() as Arc<dyn VirtualFs>,
        config.lib_roots.clone(),
    ));
    let layered_dyn: Arc<dyn VirtualFs> = layered.clone();
    let mut client = TsgoClient::spawn(&config.binary, &config.root, Arc::clone(&layered_dyn))
        .map_err(ResidualPassError::Client)?;
    client.initialize().map_err(ResidualPassError::Client)?;

    // Small per-lane cache of already-decoded lib file text, so classifying
    // several `External` sites in the same lib file (common — most lib
    // globals a real corpus references live in a handful of `lib.es5.d.ts`/
    // `lib.dom.d.ts`-shaped files) does not re-read the file from disk once
    // per site.
    let mut lib_texts: std::collections::HashMap<String, std::sync::Arc<Vec<u16>>> =
        std::collections::HashMap::new();

    let mut previous_snapshot: Option<u64> = None;
    for window in windows {
        let config_json = serde_json::json!({
            "compilerOptions": config.compiler_options,
            "files": window.roots,
        })
        .to_string();
        overlay.set(config.project_config_path.clone(), config_json);

        let params = UpdateSnapshotParams {
            open_projects: vec![config.project_config_path.clone()],
            file_changes: previous_snapshot.map(|_| FileChanges::Summary {
                changed: vec![config.project_config_path.clone()],
                created: Vec::new(),
                deleted: Vec::new(),
            }),
            ..Default::default()
        };
        let snapshot_start = std::time::Instant::now();
        let snapshot = client
            .update_snapshot(&params)
            .map_err(ResidualPassError::Client)?;
        let snapshot_ms = snapshot_start.elapsed().as_secs_f64() * 1000.0;
        let project = snapshot
            .projects
            .iter()
            .find(|p| p.config_file_name == config.project_config_path)
            .ok_or(ResidualPassError::NoProjectForWindow {
                lane: lane_index,
                window_index: window.index,
            })?
            .id
            .clone();

        let mut window_sites: Vec<PendingSite> = Vec::new();
        for root in &window.roots {
            if let Some(sites) = pending_by_owner.get(root) {
                window_sites.extend(sites.iter().cloned());
            }
        }
        if !window_sites.is_empty() {
            let mut resolver = ResidualResolver::new(
                &client,
                Arc::clone(&layered_dyn),
                snapshot.snapshot,
                project,
            );
            let resolutions = resolver.resolve(&window_sites);
            for (site, resolution) in window_sites.iter().zip(resolutions) {
                out.push(classify(site, resolution, layered.as_ref(), &mut lib_texts));
            }
        }

        stats.push(WindowStats {
            lane: lane_index,
            window_index: window.index,
            roots: window.roots.len(),
            snapshot_ms,
            sites_resolved: window_sites.len(),
            child_rss_kb: sample_rss_kb(client.pid()),
        });

        if let Some(previous) = previous_snapshot {
            let _ = client.release(previous);
        }
        previous_snapshot = Some(snapshot.snapshot);
    }
    if let Some(previous) = previous_snapshot {
        let _ = client.release(previous);
    }
    let _ = client.shutdown();
    Ok((out, stats))
}

fn classify(
    site: &PendingSite,
    resolution: Resolution,
    fs: &LayeredFs,
    lib_texts: &mut std::collections::HashMap<String, std::sync::Arc<Vec<u16>>>,
) -> ResolvedSite {
    let outcome = match resolution {
        Resolution::Unresolved { reason } => SiteOutcome::Unresolved { reason },
        Resolution::Resolved(decl) => {
            // Case-insensitive match (`LayeredFs::matching_real_root`'s own
            // doc comment): tsgo canonicalizes absolute paths to lowercase
            // on a case-insensitive host filesystem, so `decl.path` here may
            // already differ in case from `config.lib_roots`'s original
            // spelling even though it is the exact same file.
            let is_lib = fs.matching_real_root(&decl.path).is_some();
            if is_lib {
                let text = lib_texts.entry(decl.path.clone()).or_insert_with(|| {
                    std::sync::Arc::new(
                        fs.read_file(&decl.path)
                            .map(|content| to_utf16(&content))
                            .unwrap_or_default(),
                    )
                });
                let symbol_name =
                    identifier_text_at(text, decl.name_identifier_start).unwrap_or_default();
                let lib_file = std::path::Path::new(&decl.path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| decl.path.clone());
                SiteOutcome::External {
                    lib_file,
                    symbol_name,
                }
            } else {
                SiteOutcome::WorkspaceTarget {
                    path: decl.path,
                    name_start_utf16: decl.name_identifier_start,
                    decl_start: decl.decl_start,
                    decl_end: decl.decl_end,
                    kind_hint: decl.decl_kind,
                }
            }
        }
    };
    ResolvedSite {
        owner_path: site.owner_path.clone(),
        start_utf16: site.start,
        end_utf16: site.end,
        site_kind: site.kind,
        outcome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("/w/f{i:04}.ts")).collect()
    }

    #[test]
    fn window_plan_splits_into_contiguous_fixed_size_windows() {
        let plan = WindowPlan::build(&paths(5), 2);
        assert_eq!(plan.windows.len(), 3);
        assert_eq!(plan.windows[0].roots, vec!["/w/f0000.ts", "/w/f0001.ts"]);
        assert_eq!(plan.windows[1].roots, vec!["/w/f0002.ts", "/w/f0003.ts"]);
        assert_eq!(plan.windows[2].roots, vec!["/w/f0004.ts"]);
        assert_eq!(plan.windows[0].index, 0);
        assert_eq!(plan.windows[2].index, 2);
    }

    #[test]
    fn window_plan_exact_multiple_has_no_short_final_window() {
        let plan = WindowPlan::build(&paths(4), 2);
        assert_eq!(plan.windows.len(), 2);
        assert_eq!(plan.windows[1].roots.len(), 2);
    }

    #[test]
    fn window_plan_empty_input_is_zero_windows() {
        let plan = WindowPlan::build(&[], 512);
        assert!(plan.windows.is_empty());
    }

    #[test]
    fn window_plan_default_window_size_matches_the_node_analyzer_default() {
        assert_eq!(WindowPlan::DEFAULT_WINDOW_SIZE, 512);
    }

    #[test]
    #[should_panic(expected = "window_size must be positive")]
    fn window_plan_rejects_zero_window_size() {
        WindowPlan::build(&paths(1), 0);
    }
}
