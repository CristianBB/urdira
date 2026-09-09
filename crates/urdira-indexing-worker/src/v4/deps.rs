//! v4 artifact dependencies (plan §4.5's "Dependencias (`artifact_
//! dependencies`)... igual, desde las filas de imports resueltos"). Turns
//! the `ProposedRecordDependency`s `read_facts_group` already produces for
//! resolved imports (`urdira-jsts-syntax-worker`'s `read_facts` builds one
//! per resolved `DirectImport`, mirroring `project_owner`'s dependency loop
//! in `urdira-jsts-native-projection`) into `urdira_structural_store::
//! DependencyRow`s.
//!
//! `dependency_id` is NOT a v3 mirror: `urdira-structural-store`'s own
//! evidence doc documents `DependencyRow.dependency_id` as "not present in
//! the plan's §2.2 sketch... added here because delta closures need a key"
//! -- a deliberate addition by that crate, with no v3 precedent to
//! reproduce.
//!
//! **v2 (superseded by v3, both found live via real n8n-scale oracle
//! mismatches, never via inspection alone):**
//!
//! v1 hashed `record_ordinal` (which record this dependency attaches to)
//! instead of `owner_artifact`. P3-1 found this live: on the incremental
//! path, `record` is always `None` (this module's own documented
//! simplification -- the record ordinal a dependency would attach to is
//! only stable within ONE `materialize_generation` call's own `records`
//! vector, which `diff::diff_owner`'s "unchanged, keep" case can drop
//! entries from AFTER materialization already ran), so `record_ordinal_
//! for_id` was ALWAYS `NONE_U32` for every incrementally-opened dependency
//! row -- while a from-scratch cold oracle resolves a real ordinal for the
//! SAME edge, making `dependency_id` permanently diverge between the two
//! paths whenever an affected owner had any real dependency edge. v2 keyed
//! on `owner_artifact`/`dep_artifact` ORDINALS instead, fixing that
//! specific case.
//!
//! **v3 (superseded by v4 within the SAME P3-2 item 3 session -- v3 was
//! tried, measured, and found ALSO insufficient at n8n scale before v4 was
//! reached; kept here rather than silently erased since it's a genuine,
//! informative dead end):** v2 still embedded raw dictionary ORDINALS
//! (`owner_artifact`/`dep_artifact`, both `u32`s minted by `materialize.rs`'s
//! `OrdinalDict`), which is NOT canonical across two independently-built
//! stores whenever the underlying file SET differs (any create or delete).
//! `OrdinalDict` is append-only BY DESIGN (plan §2.2: "los ordinales son
//! estables entre generaciones: un delta solo añade") -- an incremental
//! store seeds every dictionary from the PRIOR generation's `Dictionaries`
//! (`OrdinalDict::from_existing`) and appends brand-new entries strictly at
//! the END, in WHATEVER order this generation's affected owners happen to
//! be processed in. An independent from-scratch cold oracle of the SAME
//! (post-mutation) file set instead assigns ordinals fresh, in
//! `owner_path`-sorted order, over the CURRENT set only -- a created file's
//! alphabetical position shifts every subsequent path's ordinal in the
//! oracle's numbering but not in the incremental store's (which never
//! renumbers existing entries). v3 hashed the STRING `(artifact_id,
//! artifact_version_id)` pairs instead of ordinals, reasoning (correctly)
//! that `structural_record_digest` (`urdira-native-core`) achieves
//! cross-scan comparability the same way -- but v3 was WRONG about WHICH
//! strings are actually comparable: measured live at n8n scale, EVERY ONE
//! of 35,527 live dependency edges mismatched between the incremental store
//! and an independent from-scratch oracle of IDENTICAL content (zero
//! overlap, not a handful of stragglers), because `artifact_id`
//! (`urdira-source-frontier::ids::artifact_id`) is salted with
//! `workspace_id` and `artifact_version_id` is ADDITIONALLY salted with the
//! scan's own `generation` (via `source_observation_id`'s `batch_id` ->
//! `observation_batch_id(workspace_id, generation)`) -- neither is stable
//! across two independent scans of the SAME content, regardless of
//! ordinals. `structural_record_digest` avoids this because `identity_key`
//! is built from the raw PATH (`stable_entity_id`), never from
//! `artifact_id`/`artifact_version_id` -- v4 (below) uses that same
//! PATH-based primitive for dependencies too.
//!
//! **v4 (P3-2 item 3, the version this module actually ships): keyed on
//! the raw PATH strings** (`owner_path`, threaded in from `materialize.rs`;
//! `dependency.dependency_target_path`, a new additive field on
//! `ProposedRecordDependency` populated from `urdira-jsts-syntax-worker`'s
//! own `resolved_dependencies` -- see that function's doc comment) --
//! `sha256("urdira:v4-dependency-id:v4\0" || len(owner_path) || owner_path
//! || len(dep_path) || dep_path || role)`, length-prefixed so `"ab"+"c"`
//! never collides with `"a"+"bc"`. Neither `workspace_id`- nor
//! `generation`-salted, so it is stable across ANY two scans (incremental
//! or from-scratch, same or different workspace_id) that agree on the SET
//! of source files and their content. **Confirmed live**:
//! `n8n_incremental_create_delete_roots_match_oracle` -- `records`,
//! `dependency`, AND `graph` roots all match a from-scratch n8n-scale
//! oracle exactly for create+delete after this fix (v3 alone was not
//! enough; the v3->v4 diagnosis above was reached by dumping the first 20
//! differing dependency edges per side from that same test, which showed
//! 100% divergence -- the smoking gun that ruled out "a few dangling
//! edges from the owner-granularity diff" and pointed straight at the
//! salted-string identity instead). `urdira-structural-store::merkle::
//! dependency_logical`/`dependency_logical_view` (the merkle SET's
//! "logical value", previously ordinal-keyed) derive from this now-fully-
//! canonical `dependency_id` instead -- see those functions' own doc
//! comments.

use super::ScanError;
use super::materialize::OrdinalDict;
use rustc_hash::FxHashMap;
use sha2::{Digest, Sha256};
use urdira_jsts_syntax_worker::ProposedRecordDependency;
use urdira_structural_store::DependencyRow;

const DEPENDENCY_ROLE_UNKNOWN: u8 = 0;
const DEPENDENCY_ROLE_RESOLUTION_INPUT: u8 = 1;
/// Frente E-P0f (2026-09-07, ambient-global-dependents integrity fix): a
/// consumer -> declaring-script dependency for an identifier that resolved
/// through `resolver::AmbientModuleIndex::resolve_global` (a script file's
/// un-imported top-level interface/const/etc, or a `declare global {}`
/// block) rather than through an ordinary `core:import`/`core:export`
/// relation -- see `urdira_jsts_syntax_worker::OwnerSemantics::
/// ambient_global_dependencies`'s own doc comment for the full root-cause
/// writeup and why this needs its own persisted `DependencyRow`, not just a
/// same-call revisit.
pub(super) const DEPENDENCY_ROLE_AMBIENT_GLOBAL_INPUT: u8 = 2;
/// E-P0q (2026-09-09, sibling-conformance-dependents integrity fix): a
/// consumer -> conformer dependency for a member read/call this owner's
/// typeflow-mediated resolution demoted (or capped, via `TooManyCandidates`)
/// through `ProgramIndex::sibling_conformance_overrides` -- see
/// `urdira_jsts_syntax_worker::OwnerSemantics::sibling_conformance_
/// dependencies`'s own doc comment for the full root-cause writeup (the
/// SAME shape `DEPENDENCY_ROLE_AMBIENT_GLOBAL_INPUT` already closes for a
/// different edge kind: a dependency that exists with NO backing `core:
/// import`/`core:export` relation for the ordinary reverse-dependent
/// closure to walk).
pub(super) const DEPENDENCY_ROLE_SIBLING_CONFORMANCE_INPUT: u8 = 3;

/// The `ProposedRecordDependency::dependency_role` text
/// `urdira-indexing-worker::v4::analyze::run_scoped`/`run_cold` set on every
/// `ProposedRecordDependency` built from `OwnerSemantics::ambient_global_
/// dependencies` -- shared here (rather than re-typed at each call site) so
/// the string `role_byte` matches below can never drift from what the
/// producer actually writes.
pub(super) const AMBIENT_GLOBAL_DEPENDENCY_ROLE: &str = "jsts:ambient_global_input";
/// E-P0q: see `DEPENDENCY_ROLE_SIBLING_CONFORMANCE_INPUT`'s own doc comment
/// -- the `ProposedRecordDependency::dependency_role` text `run_scoped` sets
/// on every dependency built from `OwnerSemantics::sibling_conformance_
/// dependencies`.
pub(super) const SIBLING_CONFORMANCE_DEPENDENCY_ROLE: &str = "jsts:sibling_conformance_input";

/// `dependency_role` is TEXT in v3 (`jsts:resolution_input`, per
/// `urdira-jsts-native-projection`'s `project_owner`); `DependencyRow.role`
/// is `u8`. Three roles exist in this pipeline's producers as of Frente
/// E-P0q -- promote to a dictionary if a fourth is ever introduced.
fn role_byte(role: &str) -> u8 {
    match role {
        "jsts:resolution_input" => DEPENDENCY_ROLE_RESOLUTION_INPUT,
        AMBIENT_GLOBAL_DEPENDENCY_ROLE => DEPENDENCY_ROLE_AMBIENT_GLOBAL_INPUT,
        SIBLING_CONFORMANCE_DEPENDENCY_ROLE => DEPENDENCY_ROLE_SIBLING_CONFORMANCE_INPUT,
        _ => DEPENDENCY_ROLE_UNKNOWN,
    }
}

/// Length-prefixed so `"ab"` + `"c"` never collides with `"a"` + `"bc"`.
fn hash_len_prefixed(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value.as_bytes());
}

/// v4 (P3-2 item 3, see this module's doc comment): keyed on the raw PATH
/// strings, never `artifact_id`/`artifact_version_id` (v3's own attempted
/// fix) and never a dictionary ordinal (v1/v2). Both `artifact_id`
/// (`urdira-source-frontier::ids::artifact_id`, salted with `workspace_id`)
/// and `artifact_version_id` (additionally salted with the scan's own
/// `generation` via `source_observation_id`/`observation_batch_id`) are
/// **scan-specific**, not just ordinal-space-specific -- confirmed live via
/// a real n8n-scale oracle run with v3's recipe: EVERY one of 35,527 live
/// dependency edges mismatched (zero overlap) between the incremental store
/// and an independent from-scratch oracle of identical content, because the
/// two scans used different `(workspace_id, generation)` salts even for
/// files whose content never changed. A raw PATH has neither salt -- the
/// exact primitive `jsts:entity_container`'s own module identity already
/// uses (`stable_entity_id(EntityKind::Module, path, 0, path)`), which is
/// why `records`/`graph` roots already compared correctly across such scans
/// while `dependency` did not.
fn dependency_id(owner_path: &str, dep_path: &str, role: u8) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"urdira:v4-dependency-id:v4\0");
    hash_len_prefixed(&mut hasher, owner_path);
    hash_len_prefixed(&mut hasher, dep_path);
    hasher.update([role]);
    hasher.finalize().into()
}

/// Builds every owner's `DependencyRow`s for a cold generation.
/// `pending` carries `(owner_artifact_ordinal, owner_version_ordinal,
/// owner_path, dependency)` per pending dependency (the two ordinals equal
/// today -- see `materialize.rs`'s module doc on why `dicts.artifacts` uses
/// one ordinal per owner; `owner_path` is P3-2 item 3's addition, needed
/// for a scan-independent `dependency_id`, see this function's own doc
/// comment). `record_ordinal_by_proposal_key` resolves which record this
/// dependency is attached to (`RecordRow.record`, `None` for the bare
/// `record:` sentinel v3 data quirk -- unreachable here since every
/// dependency this pipeline emits is attached to a real relation record,
/// but handled defensively). `artifacts` is the SAME ordinal dictionary
/// `materialize_cold` is still building: a dependency's target is
/// virtually always also a workspace owner already interned there (import
/// resolution only ever resolves within the workspace's own JS/TS set),
/// but this function still interns defensively rather than erroring, so an
/// edge case never aborts the whole scan.
///
/// F1 1.4: `artifact_paths` is that SAME `Dictionaries::artifact_paths`
/// vector both `materialize_cold_partitioned` and `materialize_generation`
/// build, aligned 1:1 by ordinal with `artifacts` -- passed here (instead
/// of being left untouched, as before this fix) so the rare case just
/// described (a dependency target artifact minted an ordinal `artifacts.
/// intern` had never seen as an owner) fills in that ordinal's REAL path
/// (`dependency.dependency_target_path`, already resolved to a workspace-
/// relative path by the syntax worker -- `resolved_dependencies`) instead
/// of leaving it as an empty-string/absent placeholder that permanently
/// forces that ordinal's identity key back onto the store's Raw
/// (non-reconstructed) encoding. Both call sites' own gap-fill code
/// (`materialize_generation`'s owner loop, `materialize_cold_partitioned`'s
/// `artifact_path_by_id` lookup) mint ordinals from the OWNER side only;
/// this is the dependency-side counterpart, using the exact same "resize
/// with empty padding up to the new ordinal, then push the real path"
/// pattern so a pre-existing ordinal already interned by this generation's
/// own owner loop is never touched (correctly skipped: `dep_ordinal <
/// artifact_paths.len()` in that case).
pub(super) fn materialize_dependencies(
    pending: Vec<(u32, u32, String, ProposedRecordDependency)>,
    record_ordinal_by_proposal_key: &FxHashMap<String, u32>,
    artifacts: &mut OrdinalDict<(String, String)>,
    artifact_paths: &mut Vec<String>,
    generation: u32,
) -> Result<Vec<DependencyRow>, ScanError> {
    let mut rows = Vec::with_capacity(pending.len());
    for (owner_artifact, owner_version, owner_path, dependency) in pending {
        let dep_pair = (
            dependency.dependency_artifact_id.clone(),
            dependency.dependency_artifact_version_id.clone(),
        );
        let dep_ordinal = artifacts.intern(&dep_pair);
        if (dep_ordinal as usize) >= artifact_paths.len() {
            artifact_paths.resize(dep_ordinal as usize, String::new());
            artifact_paths.push(dependency.dependency_target_path.clone());
        }
        let record = record_ordinal_by_proposal_key
            .get(&dependency.proposal_record_key)
            .copied();
        let role = role_byte(dependency.dependency_role);
        rows.push(DependencyRow {
            dependency_id: dependency_id(&owner_path, &dependency.dependency_target_path, role),
            record,
            owner_artifact,
            owner_version,
            dep_artifact: dep_ordinal,
            dep_version: dep_ordinal,
            role,
            valid_from: generation,
            valid_to: 0,
        });
    }
    Ok(rows)
}
