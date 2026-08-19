# Workspace Fork

Status: **Approved**
Last updated: 2026-08-12
Depends on: [Content-Derived Record Identity](11-content-derived-record-identity.md), workspace and storage/projection architecture, incremental indexing semantics

## Decision objective

When a newly added workspace's tree is content-identical to an already-`ready`
workspace on the same installation (the donor), bootstrap the new workspace by
copying the donor's currently-visible canonical rows instead of re-running
plugin analysis over content the donor already indexed. This is the fork
primitive decision 11 was written to make possible: git worktrees of a repo
already indexed once are the primary motivating case, but the predicate this
decision implements does not require git at all.

This decision covers the *implementation* of the fork; decision 11 covers why
it is safe (content-derived, workspace-free canonical-layer ids mean two
workspaces indexing identical content independently mint identical
`record_id`/`identity_id` values without either copying anything from the
other).

## Donor discovery and content identity

A candidate donor is any other registered workspace with `status: "ready"`
and an identical `selected_plugin_ids` set. Content identity is established by
**one unconditional check**, with git used only to order which candidate is
tried first:

1. **Content-hash check (authoritative, always run).** The fork target's own
   freshly built source layer (see below) is compared, as a sorted
   `(normalized_uri, content_hash)` multiset, against each remaining candidate
   donor's currently-visible `artifact_versions` (a narrow, typed-column-only
   query, `donorVisibleArtifacts` — see the performance note below). An exact
   multiset match is a content-identity match; this runs for **every**
   candidate donor, not only when a git-based hint fails to confirm one.
2. **Git preference hint (ordering only, not trusted alone).** `peeledHeadFor`
   (`packages/engine/src/git-providers.ts`) reads the peeled HEAD commit and
   git common directory for the new root and each candidate donor's root; a
   donor sharing both with the new root is tried first in step 1's loop, ahead
   of every other candidate. This exists purely to make the common case (the
   donor an operator actually intends, e.g. a `git worktree add` of the same
   commit) resolve in one content-hash comparison instead of iterating every
   ready workspace on the installation.

   An earlier version of this implementation trusted "clean + same peeled HEAD
   commit" (via `administrativeState`, which additionally reads and SHA-1s
   every tracked file to determine dirtiness) as *proof* the trees were
   byte-identical and skipped the content-hash check entirely for a
   git-matched donor. A real end-to-end run against a real 981-file repository
   (excalidraw) disproved that premise: this feature's own scanner enumerates
   everything under a workspace root except `node_modules/**`/`.git/**`/
   `dist/**`/`.urdira/**` — it does not honor `.gitignore` — so a donor
   checkout that had gone through `npm install` (leaving gitignored,
   post-install generated files like husky's `.husky/_/*` hook shims sitting
   outside those excludes) had *more* scanned files than a fresh `git worktree
   add` checkout of the identical commit, even though both were clean at the
   same HEAD. "Clean + same commit" is a true statement about tracked content
   only; it says nothing about untracked-but-scanned content. The fix: demote
   the git check to a preference hint only, and make the content-hash multiset
   check unconditional for every candidate — dirtiness became irrelevant to
   drop from the hint entirely, since a dirty tree simply will not pass the
   (now-always-run) multiset check regardless.

   `peeledHeadFor` also deliberately does **not** run `administrativeState`'s
   `status_matrix`/tree-vs-worktree byte comparison at all (no per-file
   dirtiness determination, no `git-providers.ts` blob reads) — on the same
   981-file repository with two ready donors present, this alone cut the
   `donor_match` stage of a fork attempt from ~113s to a small fraction of a
   second, since `administrativeState`'s dirty check reads and SHA-1s every
   tracked file, per worktree, per donor. Combined with `donorVisibleArtifacts`
   (a narrow query returning just `artifact_id`/`artifact_version_id`/
   `normalized_uri`/`content_hash`, instead of `WorkspaceSourceIndexRepository.currentOccurrences`'s
   full canonical-decode of every visible `SourceArtifact`/`ArtifactVersionRecord`),
   this made `donor_match` proportional to the number of *candidate donors*
   and their file counts, not to a full per-file git status computation
   repeated per donor — the dominant real-world cost with 2+ ready donors on
   an installation, since earlier forks are themselves donors for later ones.

A matched donor is additionally required to have resolved an equivalent
plugin set to the new workspace's own resolution — this is the load-bearing
check that plugin resolution is equivalent between the two workspaces (if it
isn't, the donor's analysis output could differ from what this workspace's
own plugin selection would produce, even with identical content).

The phase-2 spec that motivated this decision names this check as
`registry_snapshots.registry_digest` equality. This implementation does
**not** compare that field literally: in the current `@urdira/plugin-sdk`
registry model, `registry_digest` is workspace-salted (both
`registry_snapshot_id` and every `namespace_binding.workspace_id` feed it),
so it can never be equal across two genuinely distinct workspaces even when
they resolve byte-identical plugin content — comparing it as specified would
make this predicate permanently false and the fork feature inert. What
actually determines whether plugin analysis output would differ is the
*resolved plugin set* (`PluginResolutionLock.resolved_plugins`: plugin
id/version/declaration/contribution/analysis digests, none of which are
workspace-salted), so `donorPluginResolutionMatches`
(`packages/engine/src/workspace-fork.ts`) compares that set instead, read back
from the donor's own persisted `control_plane_state` row for its current
`plugin_resolution_lock` — the same row `assertPublicationImmutableRows`
(`packages/storage/src/publication-authority.ts`) treats as authoritative.
This was discovered empirically while writing this feature's own tests (two
workspaces resolving the identical plugin selection through the identical
in-process plugin catalog still produced different `registry_digest` values),
not assumed from reading the spec alone.

The phase-2 spec also names a separate "plugin catalog fingerprint" check;
this implementation does not check it independently. A daemon process has
exactly one plugin catalog for its entire lifetime, and the resolved plugin
set is itself derived from resolving that catalog against the workspace's
selection — so resolved-plugin-set equality is a strict, stronger guarantee
than catalog-fingerprint equality for any two workspaces scanned by the same
daemon process, which is the only case this feature handles (there is no
cross-installation fork).

## Shipped variant: source layer always reads and hashes bytes

The phase-2 spec allows two variants for the fork's own source layer (stage
1): skip byte reads entirely for the git fast path (verify CAS blob presence
instead of rewriting), or — if that cannot be done without contortions — read
and hash bytes normally, "still fast". **This implementation ships the second
variant for both the git fast path and the fallback predicate.**

`GenericSourceIndexer.apply` (`packages/engine/src/source-indexer.ts`) has no
supported path to accept a pre-computed `content_hash` and skip reading and
hashing the underlying bytes — its `read` callback's result is always
independently re-verified against `digestBytes` of the decoded bytes, with no
bypass flag. Building a parallel, byte-skipping source-cataloging path would
mean either fabricating self-consistent `read` responses (which still forces
a hash computation, just not a second filesystem read) or writing
`SourceIndexCommitInput` rows directly, bypassing `GenericSourceIndexer`
entirely and re-deriving its invariants (id minting, watermark handling,
tombstone closure) by hand. Given decision 11's actual performance target is
the *canonical layer* — the plugin-analysis and per-record materialization
work a fork skips entirely — and the source layer's enumerate+read+hash cost
is a small, already-parallelized (`io_concurrency`) fraction of a full scan's
wall time, this was judged not worth the correctness risk of a second,
less-tested source-cataloging path for v1. The fork's savings come entirely
from skipping plugin analysis (`WorkspaceScanPluginProvider.analyze`, the
dominant cost on large workspaces per prior benchmarking) and from
skipping `CandidateMaterializer.seal()`'s from-scratch record/identity/
dependency/projection materialization, replacing it with a direct copy of the
donor's already-materialized rows through the existing publish machinery.

A follow-up that teaches the source layer to trust a donor's content hash
under the git fast path (verifying CAS blob presence via `ContentAddressedStore.has`
instead of reading the workspace's own files) remains open; it was scoped out
of v1 for the reason above, not forgotten.

## Fork execution

Implemented in `packages/engine/src/workspace-fork.ts`, `attemptWorkspaceFork`.
Order:

1. **Source layer**, built normally, in two phases. `enumerateForkRoot`
   (`DirectorySourceProvider.enumerate` only, the same hard-coded excludes
   `node_modules/**`/`.git/**`/`dist/**`/`.urdira/**` as a normal scan) runs
   first and unconditionally, writing nothing durable yet — enumeration alone
   already computes every observation's content hash, which is enough for
   both the git fast path's cross-check and the content-hash fallback
   predicate below. Only once a donor match *and* a plugin-resolution match
   are both confirmed does `commitForkSourceLayer` read and hash every file's
   bytes and commit them via `GenericSourceIndexer.apply` — stage 1 of an
   ordinary `runFullWorkspaceScan`, duplicated here (not factored out of
   `workspace-indexing-session.ts`) so this feature never risks destabilizing
   the already-tested normal scan path.

   This two-phase split is load-bearing, not an optimization: an earlier
   version of this implementation committed the source layer unconditionally
   before donor matching, on the theory that the work is "never wasted" (a
   fallback to `runFullWorkspaceScan` would just find it already done). That
   is true for the source layer in isolation, but it broke the fallback scan
   itself: `runFullWorkspaceScan` reads "what was already cataloged" *before*
   its own enumerate, so when a fork attempt had already durably written the
   source layer and then skipped (no donor, or a plugin-resolution mismatch),
   the fallback's `SourceCandidatePlanner` saw every file as already
   cataloged and unchanged and took its "equivalent, nothing to publish" fast
   path — which assumes a prior published snapshot exists. None did, so it
   produced an empty snapshot id, which `WorkspaceRegistry.markReady` rejects
   outright (`engine:workspace_snapshot_required`), permanently stuck in
   `"indexing"`. This surfaced immediately in this decision's own acceptance
   tests before it ever reached production. Not committing until every
   predicate has already passed avoids ever creating that state; the (rare)
   remaining case — a fork commits successfully but then fails `verify()` —
   is handled by `rollbackForkPublication` (below) also purging the source
   layer it committed, not just the canonical/publication rows.
2. **Canonical layer, bulk-copied directly (not through the candidate template
   machinery).** For the matched donor's currently-visible rows
   (`valid_to_generation IS NULL` at the donor's own current generation) in
   `record_occurrences`, `identity_assignments`, `artifact_dependencies`, and
   `projection_occurrences` (+ `projection_occurrence_dependencies`, rebuilt
   automatically from the copied source-id arrays, not copied directly):
   - A uri-keyed map from the donor's currently-visible `artifact_versions`
     (by `normalized_uri`) to the fork target's own freshly minted
     `artifact_id`/`artifact_version_id` is built first
     (`buildFullArtifactMap`, `workspace-fork.ts`).
   - `record_occurrences` and `identity_assignments` — the two large tables
     whose payload columns (`record_payload`; `assignment_payload`, never
     decoded by any reader) are safe to copy byte-for-byte per decision 11 —
     are bulk-copied via a single native cross-database `INSERT ... SELECT`
     (`bulkCopyRecordsAndIdentities`): the fork target's connection `ATTACH`es
     the donor's own sqlite file read-only-in-intent, joins against a small
     temp `fork_artifact_map` table (populated in batched `INSERT`s from the
     uri map above) to rewrite owner/span columns, and lets SQLite itself copy
     every other column verbatim inside the engine — no row is ever decoded,
     re-canonicalized, or re-digested in JS. `record_id`/`record_digest` are
     never recomputed; they are copied exactly as the donor stored them, which
     is the fork property decision 11 exists to guarantee. Every copied row is
     a first open in the target workspace's own history
     (`open_reason_code`/`assignment_kind` forced to "created", no
     `previous_record_id`), regardless of what the donor's own edit history
     looked like. This replaces an earlier design that routed every copied row
     through `WorkspaceDatabase.publishCandidate`'s ordinary
     `CandidateRecordOpenTemplate`/`CandidateMaterializer` machinery, which
     re-parsed and re-canonically-digested every record in JS
     (`memoizeRecordOpens` alone measured ~25s at 177k records on a real
     981-file repository) — exactly the cost the byte-copy design was always
     meant to skip; see the "Bulk-copy publication layer" note below for why
     this needed a companion change to the publication side too.
   - `artifact_dependencies` rows **are** re-canonicalized in JS
     (`bulkCopyDependencies`), unlike records/identities: `dependency_payload`
     is actually decoded by real query code (`WorkspaceProjectionRepository`'s
     dependency reads, `packages/storage/src/projections.ts`), so it must
     reflect the fork's rewritten owner/dependency ids, not the donor's. This
     table is small relative to records (nine scalar columns, no record
     body), so a JS loop over the donor's already-open connection, batched
     into large multi-row `INSERT`s, stayed cheap without needing `ATTACH`.
     `dependency_entry_id` is re-minted from the rewritten ids.
   - `projection_occurrences` rows are similarly rebuilt in JS
     (`bulkCopyProjections`): owner columns and `source_artifact_version_ids`
     rewritten through the uri map, `projection_record_id` **re-minted** (not
     copied verbatim — nothing in this codebase specifies a stable,
     workspace-independent minting formula for it), and self-referential
     `source_projection_record_ids` rewritten through a donor-id → fork-id
     remap built for exactly this generation's copy. A projection whose
     remapped source arrays are all empty is dropped rather than published
     dangling. In every real installation this codebase currently indexes
     this table is empty (the bundled JS/TS plugin emits no projections), so
     this path is exercised by this feature's own tests, not yet by real
     workloads — unlike records/dependencies, there was no real-world timing
     pressure to bulk-`ATTACH`-copy it, so it stayed a JS loop.
   - Not copied: `lexical_*` (the async post-ready reconciler rebuilds them
     from CAS), `graph_edges`/`metric_projections`/`vector_*` (no production
     writer exists for these yet), `candidate_*` history, `capability_state_entries`
     (the fork publishes an empty set; a forked workspace's capability/
     completeness reporting reads as empty until its next real rescan — the
     same "completeness always reports partial" cosmetic gap already
     documented elsewhere, not a new one), `candidate_lookup_dependencies`
     (query-invalidation bookkeeping; the first real incremental publish
     after a fork rebuilds whatever it needs from scratch), retention/
     lifecycle tables, journal, snapshots, registry, control plane.
3. **Publication layer, minted fresh through a narrower, fork-specific plan —
   not `buildCandidatePublicationPlan`.** `buildForkPublicationPlan`
   (`packages/storage/src/publication-authority.ts`, `@internal`-exported via
   `@urdira/storage`'s `index.ts` alongside `buildPublicationTransactionCommands`/
   `computeForkSnapshotDigestFields`/`snapshotDigest`) builds only the O(1)
   publication-layer command groups — `candidate_state` (inserted
   `'published'` directly, no queued/publishing state-machine dance),
   `registry`/control-plane rows, a materialization row with honestly
   zero-entry template descriptors (the real rows were bulk-copied directly,
   never passing through a template), the generation manifest, the snapshot,
   the publication journal, and the CAS-guarded `workspace_current_state`
   swap (a fork always mints a genuine generation 1, so only the "insert if
   absent" CAS branch applies, never "update if matches"). This deliberately
   does **not** reuse `buildCandidatePublicationPlan`: that function's cost is
   dominated by exactly the per-record work
   (`memoizeRecordOpens`/`assertPublicationImmutableRows`/`recordOpenCommands`)
   the bulk-copy above exists to skip, and it has no way to treat "canonical
   rows already present in the database" as valid input — it only ever
   *writes* rows from a template array. Every immutable row this new plan
   builds still goes through the *same* `checkedPublicationCommand`
   transaction-checkpoint + `assert_transaction_changes` + idempotent-replay
   `ON CONFLICT ... DO UPDATE ... WHERE (byte-identical)` guard pattern
   `buildCandidatePublicationPlan` itself uses (reused directly, not
   reimplemented), and the final current-state swap keeps the identical CAS
   guard. `snapshot_digest`, `canonical_record_set_digest`, and
   `projection_set_digests` are computed by `computeForkSnapshotDigestFields`
   with one SQL pass over the just-copied rows' `record_id`/`record_digest`
   pairs (plus the existing, shared `projectionSetDigestEntries`), not a
   re-digest of any payload. Combined, this replaced the earlier
   `publishCandidate`-based publish and cut the measured `copy_build` +
   `publish` stages from ~68.7s to well under 10s on the 981-file/177k-record
   benchmark. `trigger_kind: "core:workspace_fork"` still marks a candidate's
   provenance as a fork; `publication_kind` stays `"activation"`.
4. **Verify, before ready — fast by default, full opt-in.**
   `WorkspaceForkOptions.verify_mode` (`"fast"` default, `"full"` opt-in,
   threaded from `URDIRA_FORK_VERIFY=full` via `apps/urdira/src/index.ts` →
   `DaemonRuntimeOptions.workspace_fork_verify` → `runtime.ts`) chooses which
   gate runs against the forked database before the workspace is ever marked
   `"ready"`.
   - **`"full"`** (this feature's own tests always request this explicitly) runs
     the original `StorageMaintenance.verify()` — a whole-database walk,
     measured ~23s on the 981-file/177k-record benchmark.
   - **`"fast"`** (`fastForkVerify`, `workspace-fork.ts`, the production
     default) checks: row-count equality between the donor's own visible set
     and the fork's newly published generation, across every bulk-copied
     table; a byte-compare spot check of 50 randomly sampled copied records
     against their donor counterpart (content-derived `record_id`s mean any
     mismatch here is unambiguous corruption, never a legitimate difference);
     and a self-consistency check of the freshly written snapshot's own
     `snapshot_digest` against its own stored payload. This is a narrower
     guarantee than full `verify()` — not a superset — traded deliberately for
     speed on the production default; a handful of indexed queries and 50 row
     comparisons versus a whole-database walk.

   Either way, a verify failure is logged loudly and the fork's own
   generation-1 rows are deleted in a best-effort rollback
   (`rollbackForkPublication`) — safe because the workspace's own database has
   no other reader or writer at this point (`registry.markReady` has not yet
   been called) — before returning a `"skipped"` outcome. This is a
   deliberate strengthening beyond the phase-2 spec's "falls back to full
   scan" language: without a rollback, a subsequent full scan would run as an
   *incremental* scan against an already-published-but-unverified generation
   1, and its content-hash-diff planner would never re-touch any row whose
   *content* did not change — meaning a corrupt copy could persist forever
   instead of being genuinely re-derived by the fallback scan. The rollback
   also purges the source layer this fork attempt committed (`artifact_versions`/
   `source_artifacts`/`source_observations`/`source_observation_batches`/
   `source_index_state`), for the same reason the enumerate-before-commit
   ordering above exists: leaving it behind would make the fallback full
   scan's own stage 1 believe this workspace's files are already cataloged
   with nothing left to publish. `rollbackForkPublication` deletes rows by
   generation number and by the ids in `ForkPublicationIds` — these ids must
   be derived identically to how `buildForkPublicationPlan` derives its own
   internal ids (all `<kind>:${candidateId}`, including the materialization
   id, which an earlier version of this rollback computed via an independent
   `stableId(...)` hash instead — a mismatch that would have left the
   actually-inserted `candidate_materializations` row orphaned instead of
   rolled back on any post-publish failure).

   **`verify()` has five pre-existing gaps**, all confirmed -- by running
   `verify()` against a workspace scanned only through the ordinary
   `runFullWorkspaceScan` path, no fork involved -- to affect any real,
   normally-scanned workspace, not something a fork's canonical-row copy
   introduces: a `plugin_resolution_lock` control-plane row treated as
   referencing CAS content it never actually does; a `workspace_freshness_checkpoint`
   row shape verify()'s closure check does not accept from anyone, fork or
   not; a `registry_namespace_bindings` round-trip that no production scan
   path populates at all (`copyDonorAndPublish` narrows this one, via
   `RegistryRepository.putSnapshot`, without fully closing it -- see that
   call site's comment); an `artifact_dependencies` payload-reconstruction
   check that no dependency producer in this codebase could satisfy as
   written (`CandidateRecordDependencyTemplate` is typed to omit exactly the
   two fields verify() expects present); and an empty-projection-set digest
   mismatch. `isKnownPreexistingVerifyGap` (`packages/engine/src/workspace-fork.ts`)
   documents each precisely and filters only these out of the fork's own
   verify() gate -- every other component (the actual canonical-row copy,
   projection rows, snapshot/manifest digests, source catalog, CAS content
   the fork's own writes reference) must still report zero failures. This
   is the single most significant finding of this change outside the fork
   feature itself: apparently nothing before this had ever run `verify()`
   against a real, production-shaped scan with dependencies and a registry
   present, only narrower hand-built fixtures -- flagged here for whoever
   picks up `StorageMaintenance.verify()` next, not fixed, since none of the
   five gaps are specific to forking and fixing them safely means touching
   shared storage code this change does not otherwise need to.
5. **Ready.** `markReady` is called with the fork's own new snapshot id, the
   same call-site pattern `scheduleWorkspaceScan` already uses for a normal
   scan's result, followed by the same post-ready query-cache warm and
   lexical-maintenance submission.

## Wiring

`packages/daemon/src/runtime.ts`'s `scheduleWorkspaceScan` attempts a fork
immediately after resolving the workspace's plugin provider and before
calling `runFullWorkspaceScan`, gated on `priorSnapshotId === undefined` (a
genuine first-ever scan only — an incremental reconciliation of an
already-indexed workspace never attempts a fork) and the
`DaemonRuntimeOptions.workspace_fork` kill switch (`URDIRA_WORKSPACE_FORK=0`/
`false`/`off`/`no` disables it; unset or any other value leaves it on,
mirroring `URDIRA_LEXICAL_INDEX`'s existing kill-switch convention in
`apps/urdira/src/index.ts`). `attemptWorkspaceFork` never throws; any
`"skipped"` result or thrown error is logged as one `console.error` line and
falls through into the ordinary `runFullWorkspaceScan` call, so the existing
`scanInFlight`/`pendingScans` coalescing guards around the whole job are
unaffected — a fork attempt is just the first thing this job tries, not a
separate code path with its own concurrency story. `DaemonRuntimeOptions.workspace_fork_verify`
(`"fast" | "full"`, threaded into `attemptWorkspaceFork`'s `verify_mode`)
mirrors the same kill-switch convention via `URDIRA_FORK_VERIFY=full`
(`apps/urdira/src/index.ts`'s `workspaceForkVerifyMode`); any other value, or
unset, leaves `verify_mode` unset, which `attemptWorkspaceFork` itself
defaults to `"fast"`.

## Performance: real-world e2e timing (981-file/177k-record repository)

A real end-to-end run (excalidraw donor + a same-commit detached `git
worktree add` fork target, two ready donors present) measured the following
per-stage timings before and after the optimizations described above (stage
timing instrumentation lives in `workspace-fork.ts`'s `ForkContext.timings`
and its own success log line):

| stage | before | after | change |
| --- | --- | --- | --- |
| `donor_match` | 112.7s | well under 1s | `peeledHeadFor` + `donorVisibleArtifacts` (donor discovery section above) |
| `copy_build` + `publish` | 68.7s combined | well under 10s combined | bulk `ATTACH`+`INSERT...SELECT` copy + `buildForkPublicationPlan` (fork execution steps 2–3 above) |
| `verify` | 23.1s (`"full"`) | a handful of queries + 50 row comparisons (`"fast"`, the default) | `fastForkVerify` (fork execution step 4 above) |

The end-to-end fork attempt on this benchmark went from ~211s (slower than
the ~137s full scan it exists to beat) to well under the full-scan baseline.
`enumerate` and `source_commit` were not targeted by this round (both were
already small relative to the stages above — 648ms and 6.2s respectively on
this benchmark) and are unchanged from the "Shipped variant" section's
description.

## Lexical reconciler: event-loop stall between publish and query-readiness

Separate from the fork's own timing, the same benchmark showed the workspace
reaching `"ready"` (registry-visible, per step 5 above) at ~222s, but the
daemon's own status-poll HTTP handler did not get scheduled again until
~405s — roughly three minutes where something held the event loop
continuously with no scheduler checkpoint in between. The cause:
`reconcileLexicalProjection`'s (`packages/engine/src/lexical-reconciler.ts`)
step-3 loop calls `WorkspaceProjectionRepository.putLexicalDocument`
(`packages/storage/src/projections.ts`) once per newly-visible text document,
and `putLexicalDocument` computes `lexicalTrigrams` — a synchronous,
allocation-heavy byte-sliding-window scan over the *entire* normalized
document text (slicing a new `Uint8Array` and hex-encoding it per byte
position) — on the calling thread, not inside the `node:sqlite` worker any
`await` in the loop would otherwise be yielding into. `await`ing an
already-settled (or fast-settling) promise only drains the microtask queue;
it does not yield to pending I/O, so a loop of purely-`await`-ed calls can
still starve the event loop for as long as their combined *synchronous* work
takes — which, across hundreds of documents with no yield point between
them, was the observed ~3 minutes.

Fix: `yieldToEventLoop()` (`lexical-reconciler.ts`) — `setImmediate`,
specifically, not a resolved promise or `setTimeout(fn, 0)`, since
`setImmediate` queues onto the "check" phase, which runs after Node's I/O
callbacks for the current loop turn — called once per document in both the
step-2 (close stale) and step-3 (insert missing) loops. This bounds the
worst-case single stall to one document's own trigram computation (capped by
`max_document_bytes`, default 2MB) instead of every document in the pass
combined, at the cost of one `setImmediate` round-trip per document (negligible
relative to the trigram computation itself). This is a mitigation, not a
structural fix: the total CPU cost of trigram computation for a pass is
unchanged, and a single very large document (near the 2MB cap) can still
produce a multi-second stall on its own — a genuinely non-blocking trigram
computation would need to move the loop off the main thread entirely (a
worker thread, mirroring `URDIRA_ANALYSIS_THREAD`'s existing pattern for
plugin analysis), which was judged out of scope for this round.

## Fix: `.git/**` watcher noise racing a fork's donor-readiness read

While chasing an intermittent, load-dependent failure in this feature's own
test suite (a content-identical donor occasionally not found — the fork
falling back to a full scan for no legitimate reason — reproducing only under
full-suite parallel load, never in isolation), stage-by-stage debug tracing
found the actual mechanism: `git worktree add`'s own lock-file churn
(`.git/packed-refs.lock`, `.git/worktrees/<name>/locked`, created and removed
within the same git operation, before the fork target workspace is even
registered) arrives as a *trailing* filesystem event shortly after a donor
workspace's watch subscription starts. `WorkspaceWatcherManager`
(`packages/engine/src/watchers.ts`) treated this as an ordinary content
change and requested a reconcile with the lock paths as an advisory
`changedUris` hint. Because that reconcile arrived while the donor's own
first scan was still in flight, it was coalesced into exactly one guaranteed
follow-up rescan (`packages/daemon/src/runtime.ts`'s `pendingScans`) — and
that follow-up's `registry.beginReconciliation` call (which flips the
workspace's registry status back to `"indexing"`) runs *eagerly*, at
resubmission time, before the rescan itself gets a turn in the scheduler's
single-slot `"structural"` pool. If a newly-registered fork target's own scan
job happened to win that pool slot first (FIFO by submission order, and nothing
prevents a job submitted moments later by an unrelated workspace from beating
an already-eagerly-`"indexing"`-flagged one to the queue), the fork's
donor-matching read of the registry — a plain, synchronous
`candidate.status === "ready"` filter, correct by construction — observed the
donor as transiently not-ready, purely due to this queued-but-not-yet-run
lock-file-triggered rescan.

This is not fork-specific (any code that reads workspace readiness could
observe the same transient flicker) and not new in this round — the
underlying race in eager `beginReconciliation` timing predates this decision
entirely — but `.git/**` churn from real `git worktree add` usage is exactly
what a fork's own primary use case generates, and every `inclusion_rules`
configuration in this codebase (this feature's own `DEFAULT_FORK_INCLUSION`
included) excludes `.git/**` from scanning unconditionally, so a reconcile
whose only changed paths are under `.git/` was *always* guaranteed to be a
wasted, no-op ("equivalent") scan even before it started racing anything.
Fixed by excluding `.git/**` paths from the "changed"-hint branch in
`WorkspaceWatcherManager` (`watchers.ts`) regardless of `source_provider`
binding type — the existing `git_head`/`git_index`/`worktree_administration`
unsafe-reconcile classification (deliberately still full-rescan-worthy, since
a `.git/HEAD` change can signal a real branch switch) is untouched; only the
"safe, advisory hint" branch that plain lock-file noise was falling into is
filtered.

## Fix: incremental publish after a fork could fail dependency-owner validation

A real end-to-end run (excalidraw donor + fork target, a real content edit to
`packages/math/src/angle.ts` after a successful fork) hit
`core:dependency_validation_failed`/`owner_mismatch` on the fork target's very
next incremental rescan, thrown from
`candidate-materialization.ts`'s `validateBindings`. The scan's failure left
the workspace looking healthy (`runtime.ts`'s `priorSnapshotId !== undefined`
degrade-with-prior-snapshot path marks it `"ready"` at the fork's own prior
snapshot, and a subsequent watcher-triggered reconcile then republishes that
SAME prior generation via its own "equivalent, nothing to publish" fast
path) while the edit itself was silently never published.

**Root cause, confirmed by direct repro against both a forked AND an
ordinary, never-forked workspace: this is not fork-specific.**
`validateBindings` builds `promotedDependencies`' `owner_artifact_id`/
`owner_artifact_version_id` from the proposing record's replacement scope
(`owners.get(dependency.proposal_record_key)` — this scan's *fresh* owner),
then validates every dependency's owner against `ownerOf(dependency.record_id)`,
which prefers a *base* row's actual, immutable, already-stored owner when one
exists. Those two disagree exactly when the record a dependency is attached
to was *reused* this scan (decision 11: unchanged content keeps its existing
`record_id`, and — since a record row is immutable once opened — its stored
`owner_artifact_id`/`owner_artifact_version_id` are never rewritten) while
its *file* still changed enough to mint a new artifact_version_id — e.g. a
class whose own body is untouched, sitting in a file that gained an unrelated
sibling declaration. A plugin's fact-delta has no way to know in advance
whether a proposed record will turn out reused or freshly opened (that is
decided later, purely from the very same accepted deltas), so a scope-sourced
owner can legitimately go stale by validation time. This can happen on *any*
incremental scan, forked or not — confirmed by reproducing the identical
failure against a workspace that was scanned normally twice, no fork
involved. It surfaced here, and not earlier, only because no existing test
exercised a reused record with a re-proposed cross-file dependency at all:
this feature's own incremental-after-fork test (test (e), above) edited
`domain/errors.ts`, a file with zero outgoing cross-file dependencies.

**`artifact_dependencies` (the copied family implicated by the coordinator's
original hypothesis) turned out not to be the problem.** The copied rows
themselves are never re-validated by a later incremental `seal()` at all —
`input.record_dependencies` (the parameter `validateBindings` would read
existing/copied dependency rows from) is never populated by any production
caller; only `promotedDependencies` (this scan's own freshly proposed
dependencies) ever reach the validation loop. The forked workspace's fresh
generation-1 rows were fully correct; the bug was in how a *later, unrelated*
scan's own fact-delta got validated.

**Fix:** `promotedDependencies`' owner is now derived from
`ownerOf(recordId)` — the same "base row wins, else this scan's own
proposal" precedence `validateBindings` already used to validate externally
supplied dependencies — instead of from the scope's own (possibly
stale-on-reuse) owner. This keeps a freshly proposed dependency internally
consistent with whatever owner its record actually, currently has, whichever
branch (reused or freshly opened) that record took.

**`projection_occurrence_dependencies` audited, found clean.**
`CandidateProjectionDependencyTemplate` (the shape `projection_dependencies`
validates) carries no `owner_artifact_id`/`owner_artifact_version_id` fields
at all — only `{projection_record_id, source_type, source_id}`, checked for
existence/visibility (`knownProjections`/`allowedRecords`/`allowedArtifactVersions`),
never for ownership consistency against a separately stored entity. Projection
rows themselves (`validateProjection`) are validated for self-consistency
against their *own* proposing work item, not against a separately reused,
previously-stored entity, so the same mismatch shape cannot arise there
either. No production plugin emits projections yet (the bundled JS/TS plugin
does not), so this path remains exercised only by this feature's own tests.

Regression coverage: `tests/phase-workspace-fork.test.ts`'s "(bug 3)" test
forks the full task-planner fixture (not just `src/domain`, which has zero
cross-file dependencies), edits `in-memory-task-repository.ts` by appending
an unrelated sibling function (leaving `InMemoryTaskRepository`'s own
class — which owns real cross-file dependencies with cross-file spans —
byte-identical, hence reused), and asserts a genuinely new generation
publishes with the edit actually queryable — not merely that
`workspace_status` reads `"ready"`, which (per the incident above) can be
true even when the edit silently failed to publish. Confirmed to fail before
this fix and pass after.

## Fix: `storage:publication_conflict` on the *next* scan after a daemon restart

With the dependency-owner fix above applied, a real end-to-end run
(excalidraw donor + fork target, the same `packages/math/src/angle.ts` edit)
got one stage further — `seal()` succeeded — then `publish` immediately threw:

```
code: 'storage:publication_conflict'
at assertPublicationImmutableRows
```

on every retry, again silently losing the edit (the same "looks ready,
never actually published" failure mode described above).

**Diagnostic improvement made alongside the fix**: `assertPublicationImmutableRows`'s
own `conflict()` helper (`packages/storage/src/publication-authority.ts`)
used to throw with empty `details: {}`. It now attaches
`{table, row_id, mismatched_fields}` — `mismatched_fields` is a new exported
helper, `mismatchedFields(row, expected)`, that re-runs `rowMatches`'s own
per-column comparison and returns the column names that disagreed. Every
one of the function's ~16 conflict call sites was updated to pass the
table name and both sides of the comparison. This is what actually
localized the real conflict (see below) instead of requiring another round
of hand-instrumentation.

**Root cause, confirmed by direct repro against a perfectly ordinary
(never-forked) workspace — restarting the daemon between its first and
second scan, no fork or excalidraw-scale content involved at all**:
`plugin_resolution_lock:lock:${workspace_id}` (`control_plane_state`)
conflicted on its `payload` column. `resolution_lock_id`/
`registry_snapshot_id`/`configuration_revision_id` are pure functions of
`workspace_id` alone (no content salt — `apps/urdira/src/index.ts`'s own
`id_source`s), so they never change across repeated resolutions of the same
workspace. But `PluginResolutionLock.created_at` (`@urdira/plugin-sdk`'s
`resolution.ts`: `created_at: sourceValue(input.clock)`) and this
codebase's own `WorkspaceConfigurationRevision.created_at` construction
(`buildJavascriptTypescriptPluginProvider`'s `configuration` object) are
both stamped fresh from `clock()`/`now` on every resolution that doesn't
explicitly reuse a prior one. `createResolveJavascriptTypescriptPluginProvider`'s
in-process `prepared` cache (a plain `Map<workspace_id, ...>`) already
prevented re-resolution *within one daemon process's lifetime* — but it is
pure memory. A daemon restart between two scans of the same,
already-published workspace loses it, forcing a fresh resolution with a new
`created_at` under the *identical*, deterministically-keyed
`plugin_resolution_lock`/`workspace_configuration_revision` rows a prior
process already durably wrote. `assertPublicationImmutableRows` then throws
on that row's very next publish, on every retry, since the stored payload
permanently disagrees with what a fresh resolution now computes. **Not
fork-specific** — any workspace's second scan hits this if it happens to
run in a different daemon process than its first; it surfaced via forking
here only because the real e2e session's fork-then-edit-then-rescan
sequence happened to span a daemon restart (each round of this feature's
own fixes required a dist rebuild and daemon restart to pick up).

**Fix**, in `apps/urdira/src/index.ts`:
- `prepareJavascriptTypescriptRegistry` now reads back any already-persisted
  lock for this workspace (`readPersistedControlState`, a new small helper
  exported from `@urdira/engine`'s `plugin-resolution-continuity.ts`, kept
  in the engine layer rather than adding `apps/urdira` as a new direct
  `@urdira/storage`/`@urdira/canonical` dependency) and passes it as
  `existing_lock` to `PluginResolver.resolve`. `PluginResolver.resolve`'s
  own `preserveExistingLock` (`@urdira/plugin-sdk`'s `resolution.ts`) was
  *already built* for exactly this: given a still-compatible existing lock,
  it returns that lock verbatim — original `created_at` included — instead
  of minting a new one. This file's own caller simply never supplied
  `existing_lock` before. (If the existing lock is no longer compatible —
  e.g. a genuine bundled-plugin upgrade — `PluginResolver.resolve` fails
  outright with a `PLUGIN_VERSION_CONFLICT` issue rather than silently
  minting a divergent lock under the same id; this is not a new failure
  mode, since `registry_snapshot_id`/`resolution_lock_id` were already
  workspace-only-salted with no content salt, so a genuine plugin upgrade
  would already have hit the identical `storage:publication_conflict` later
  regardless — this fix just surfaces it earlier and more clearly.)
- `PluginRegistryAssembler.assemble`'s own successful output does not
  independently embed `clock()` anywhere (confirmed by reading
  `@urdira/plugin-sdk`'s `registry.ts`: `clock` is read only on its
  failure/issue path) — so once the lock feeding it is stable, the
  assembled registry snapshot is too; no separate registry read-back was
  needed.
- The `configuration` object's own `created_at` is now derived from the
  now-stable `prepared.lock.created_at` instead of the fresh `now` this
  function is also given for other, genuinely-per-call purposes (e.g. each
  `analyze_artifact` work item's own request timestamp, which legitimately
  should be fresh every scan and was left untouched).

**Why "(bug 3)"'s regression test didn't catch this**: that test (and this
file's other tests) use `phase-workspace-fork.test.ts`'s own test-only
`buildPluginProviderResolver`, which calls `prepareRegistry` fresh on every
call with **no in-process caching at all** — but stamps everything from a
module-level constant `now`, not `new Date()`. It can never exercise the
actual root cause (a fresh timestamp on every daemon *process start*)
because it has no notion of "daemon process lifetime" to begin with. Two
new tests close this gap:
- **"(bug 4)"**: forks a workspace, then directly asserts (via `rowMatches`/
  `mismatchedFields`, the same primitives `assertPublicationImmutableRows`
  itself uses) that the fork's own `registry_snapshots`/`control_plane_state`
  rows are byte-identical to what a fresh, independent encoding of the
  fork target's own `plugin.registry`/`resolution_lock`/`configuration`
  would produce. This is an unconditional invariant check, not dependent on
  reproducing the exact failure through a second scan — it fails
  immediately if any future change to the fork's own registry/control-plane
  writes (`copyDonorAndPublish`'s `putSnapshot` call,
  `buildForkPublicationPlan`'s `targetControlCommands`) introduces a
  divergence, rather than only surfacing on a real, hard-to-reproduce
  repository.
- **"(bug 5)"**: the direct end-to-end reproduction — uses the real
  `defaultDaemonOptions` plugin provider (not the lighter test harness) and
  a genuine `DaemonRuntime.stop()`/`DaemonRuntime.start()` restart between
  the fork and the incremental rescan. Confirmed to fail with the exact
  `storage:publication_conflict` before the `apps/urdira/src/index.ts` fix
  and pass after.

**Audit of the other fork-minted row families** (`candidate_state`,
`candidate_materializations`, `generation_manifests`, `snapshots`,
`candidate_publication_journal` — requested since `assertPublicationImmutableRows`
or a future replay can touch any of them): none share this divergence
class. Unlike `registry_snapshot_id`/`resolution_lock_id`/
`configuration_revision_id` (pure functions of `workspace_id` alone, hence
identical — and re-validated — across *every* scan of a workspace), these
tables' ids are all scoped to one specific scan attempt: the fork's own
`candidateId` is `stableId("workspace-fork-candidate", {workspace_id,
donor_workspace_id, observation_batch_id})`, and `observation_batch_id`
comes from that attempt's own fresh enumeration — never reused by a
*different* scan (fork or ordinary) of the same workspace, since a
different scan always re-enumerates and gets its own, different
`observation_batch_id`. A *retry of the same fork attempt* (same
`candidateId`, since the source tree hasn't changed) is the only scenario
where these ids could repeat — but `rollbackForkPublication` deletes every
row for that generation on any failure before a retry is ever attempted,
so a retry always starts from a clean slate with nothing to conflict
against. No fix needed for these tables.

## Incidental fix: `ISOMORPHIC_GIT_OBJECT_PORT` and linked worktrees

While testing the git fast path against a *real* `git worktree add` layout
(not just a plain single-checkout repository, which is all
`tests/phase7-providers.test.ts` exercised before this change), `administrativeState`
(and therefore `GitWorktreeSourceProvider` itself, and `GitReferenceSourceProvider`)
turned out unable to read any git object at all for a genuine linked worktree:
`ISOMORPHIC_GIT_OBJECT_PORT`'s `peel_commit`/`read_tree`/`read_blob`/`status_matrix`
all passed the worktree's own *private* git directory straight to
isomorphic-git, which is correct for a plain repository (where the private
and common directories are the same) but wrong for a linked worktree — a
linked worktree's private directory holds only its own `HEAD` and index;
every object lives in the *common* directory (referenced by a `commondir`
file), and isomorphic-git does not resolve that indirection itself. This was
a latent bug in already-merged, pre-phase-2 code, not something this decision
introduced — it would have affected any production use of a real git
worktree through `GitWorktreeSourceProvider`, independent of forking. Fixed
in `packages/engine/src/git-providers.ts` by resolving the common directory
(the module's existing, already-private `commonDirectoryFor`) before every
object-bearing isomorphic-git call; `resolve_ref` is deliberately left
un-redirected, since `HEAD` is genuinely per-worktree. The fix is a no-op for
every non-worktree repository (`commonDirectoryFor` falls back to the given
directory itself when no `commondir` file exists), confirmed by
`tests/phase7-providers.test.ts` passing unchanged.

## Non-goals

- No CLI surface. A fork is purely an automatic fast path of `workspace add`'s
  first scan.
- No cross-installation fork (donors are always other workspaces registered
  in the same `DurableStorage`/catalog).
- No attempt to make the source layer itself skip byte reads under the git
  fast path (see "Shipped variant" above) — left as a scoped-out follow-up.
- No copying of `capability_state_entries` or `candidate_lookup_dependencies`
  (see "Canonical layer, copied" above) — both are rebuildable, non-authoritative
  bookkeeping, not part of the queryable canonical/projection surface.
