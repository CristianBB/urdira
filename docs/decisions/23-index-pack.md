# Decision 23: Index Pack (cross-machine workspace bootstrap)

Status: implemented (engine-level export/import + daemon/CLI wiring). Numbering
note: the decisions directory has a duplicate `19-*` pair
(`19-agent-search-integration.md`, `19-source-first-readiness.md`) and no
`20-*`; this doc takes the next unused number, `23`, without renumbering
anything else (out of scope for this change — flagged here as requested, not
fixed).

## Problem

Workspace fork (decision 12) bootstraps a content-identical workspace from a
`ready` donor **on the same installation** by bulk-copying the donor's
currently-visible canonical rows instead of re-running plugin analysis. It
never helps across machines: a fresh VS Code install, a new CI runner, or a
teammate's laptop has no local donor at all, so every one of them pays the
full from-zero pipeline (~280s on the benchmark repository) even when a
byte-identical index was already computed somewhere else minutes earlier.

An index pack is fork's cross-machine sibling: an export of a `ready`
workspace's canonical index as a single distributable file, and an import
path that bootstraps a **never-scanned** workspace from that file the same
way a fork does — reusing fork's own bulk-copy/publish/verify/rollback
machinery almost wholesale — with one new obligation fork never had: the pack
crossed a trust boundary, so the import path must not simply believe what the
pack claims.

## Carrier format

**Deviation from the plan's literal "gzip tar" framing, documented up
front:** this repository has no `tar`/`tar-stream` dependency anywhere (model
packs, the closest precedent — `packages/security/src/model-packs.ts` — are
never archived into a single file at all; they are downloaded as a manifest
plus independently-fetched, content-addressed blob files over HTTP/`file:`,
see `packages/security/src/download.ts`). Introducing a new dependency for a
single feature, or hand-rolling POSIX tar framing (permissions, symlinks,
padding) that this all-JSON payload has no use for, was rejected in favor of
a format with the same functional shape at a fraction of the surface area:

**A single gzip stream of newline-delimited JSON "lines"** (`packages/engine/src/index-pack.ts`,
`PackWriter`/`readPackLines`). The first line is always
`{"kind":"manifest","manifest":{...}}`; every subsequent line is
`{"kind":<section>,"rows":[...]}`, batched at `PACK_BATCH_ROWS` (500) rows per
line, for one of: `multiset`, `records`, `value_nodes`, `facets`,
`identities`, `dependencies`, `projections`, `capability_state`; the stream
ends with `{"kind":"end"}` as a truncation guard. Both directions are
genuinely streaming and bounded-memory: `exportIndexPack` never holds more
than one page (`SQL_PAGE_ROWS` = 1000) of a table's rows in memory at a time
(keyset-paginated by `record_id` for the dominant `record_occurrences` table;
`LIMIT`/`OFFSET` for the others, which are one-row-per-file or smaller in
every real workspace and not worth keyset complexity today — see "Deferred"),
and `attemptIndexPackImport` consumes the gzip stream one line at a time via
`node:readline` over `zlib.createGunzip()`, inserting each batch into a
scratch SQLite file as it arrives rather than materializing the whole pack.

**Manifest-first, not manifest-last.** Row counts are computed via cheap
`COUNT(*)` queries (reusing the same visibility predicate as the data
queries) *before* any row is streamed, specifically so the manifest —
carrying every compatibility gate — can be the very first line `attemptIndexPackImport`
reads. This lets an incompatible or corrupt pack be rejected after
reading a few hundred bytes, before touching the target's own source layer at
all. (An earlier version of this code computed counts *while* streaming and
wrote the manifest last; that made every import fail immediately with
"missing manifest header line" and is why this ordering is called out
explicitly — a real bug this file's own test suite caught.) The streaming
loops still re-derive each section's row count as they go and assert it
matches the manifest's declared count at the end of export, catching drift
between the count pass and the data pass (e.g. a concurrent write to the
donor) rather than shipping a pack whose own manifest lies about its
contents.

**Known cost of this deviation:** BLOB columns (`body_payload`, `bytes_value`)
are hex-encoded for JSON transport, not base64 — this repository's
architecture guardrails (`scripts/check-architecture.mjs`'s
`checkNativePipelineContracts`, a regression guard tied to decision 21's
removal of base64/CBOR encoding from the native pipeline) forbid
`toString("base64")`/`Buffer.from(..., "base64")` anywhere in package `src`
trees. Hex costs exactly 2x pre-compression instead of base64's ~1.33x; gzip
recovers some of that back (hex text still compresses reasonably), but a pack
is measurably larger on disk than an equivalent tar+base64 (or raw binary)
container would be. Accepted for v1 as the price of staying dependency-free
and guardrail-compliant; a real binary framing (length-prefixed raw bytes,
no hex) is the natural follow-up if pack size becomes a real constraint.

### Manifest fields (`IndexPackManifest`)

```
schema_version, created_at (caller-supplied, never Date.now() — reproducible exports),
pack_id, donor_workspace_id, donor_generation,
compatibility: { storage_format_version, identity_format, resolved_plugins_digest, analysis_configuration_digest },
row_counts: { multiset, records, value_nodes, facets, identities, dependencies, projections, capability_state },
multiset_digest,           // digestBytes over multisetKey(...)'s canonical JSON text
donor_snapshot_anchor: { canonical_record_set_digest, projection_set_digests, capability_state_digest, source_state_digest },
manifest_digest,           // digestBytes(canonicalBytes(manifest minus this field)) — model-pack's own manifestDigest() pattern
```

Row bodies carry **owner/dependency/source references as `normalized_uri`
strings, never the donor's own `artifact_id`/`artifact_version_id`/
`record_id`-adjacent internal ids** (except `record_id`/`projection_record_id`
themselves, which are portable — content-derived per decision 11, or
self-referential within one export's own projection set). This is the same
principle decision 11's de-salting rests on: nothing in a pack should assume
the importer will mint identical internal ids to the donor's, only that it
observes the same *content* at the same *path*.

## Trust model

**Local fork trusts stored digests outright** (`workspace-fork.ts`'s doc
comment: same installation, same trust domain — decision 11 blesses
independent identical minting, but a same-machine donor's rows were already
verified once, at *its own* publish time). **An index pack crossed a machine
boundary and was authored by whoever built it**, so `attemptIndexPackImport`
adds an untrusted recompute pass fork never needed
(`verifyCopiedRecordIntegrity`, `index-pack.ts`):

1. **`body_digest` is recomputed from `body_payload`**, never trusted from
   the pack's claim: `decodeCanonical(body_payload)` then
   `digestRelationalValue(...)`, compared against the row's own `body_digest`
   column. This is the same recipe `CanonicalOccurrenceRepository.put` uses
   at ordinary publish time (`packages/storage/src/repositories.ts`,
   `packages/storage/src/relational-values.ts`), so it is exact.
2. **`record_id`/`record_digest` self-consistency, not full recomputation.**
   `record_digest`'s true recipe (`memoizeRecordOpens`/`parseRecordOpens`,
   `publication-authority.ts`) is `canonicalSha256` of the plugin's *original,
   pre-decomposition* `ProposedRecord` (`record_without_validity`) — a value
   the decomposed `record_occurrences`/`record_value_nodes` storage columns
   do not retain enough of to reconstruct byte-exactly (facets, the exact
   producer-supplied shape, etc. are not guaranteed 1:1 recoverable). Instead
   this enforces what *is* checkable from storage alone: every copied
   `record_id` must match `record:[0-9a-f]{64}` (the plain "first open" id
   shape) and must equal `record:${record_digest.slice(7)}` — i.e., id and
   digest must be mutually self-consistent, and a **chain-salted** id (the
   form decision 11 uses for a *replacement* open, salted with the previous
   record's id — see `candidate-materialization.ts`'s `hasSalt` branch) must
   never appear in a pack, since a pack only ever describes generation-1
   first opens. This is a documented, deliberate limitation, not an
   oversight — see "Deferred" below.
3. **Ownership closure against real local content**, run *before* any row is
   copied, not as part of the recompute pass: every `owner_normalized_uri`/
   `dependency_normalized_uri`/`source_normalized_uris` entry a pack's rows
   reference must appear in the pack's own declared multiset, and that
   multiset must exactly equal the importer's *own, freshly re-enumerated and
   re-hashed* local source tree (see "Multiset realism" below). This is the
   actual ground-truth check — the only one checked against something the
   pack author does not control.
4. **Dependencies/projections are always re-minted**, never trusted from the
   pack — `bulkCopyDependencies`/`bulkCopyProjections` (reused verbatim from
   `workspace-fork.ts`) recompute `content_digest`/`dependency_entry_id`/
   `projection_record_id` from the remapped, target-owned ids, exactly as a
   local fork does.
5. **A final anchor cross-check**: after copying, `fastPackVerify` recomputes
   `canonical_record_set_digest`/`projection_set_digests` from what actually
   landed in the target (`computeForkSnapshotDigestFields`, reused verbatim)
   and compares against the pack's own declared `donor_snapshot_anchor`. This
   proves the copy is *internally consistent with what the manifest claims*
   — it does **not** prove the manifest's claims are truthful (the pack
   author controls both), which is exactly why (1)–(3) above exist
   independently of this check.

### Why no signing in v1, and the upgrade path

With every check above, an index pack is **a pure performance hint that
cannot inject content it did not itself receive independent corroboration
for**: body content is validated against its own digest (1), record ids
against their own digest (2), and — the check that actually matters for
"can this pack lie about what a file contains" — every row's owner is
validated against the **importer's own local disk**, hashed independently by
the *importer*, not read from the pack (3). An attacker controlling a pack
file can, at absolute worst, cause an import to be rejected (denial of
bootstrap-speed, falling back to the always-correct full scan) — they cannot
make the importer publish content for a file whose real local bytes hash to
something else, because (3)'s ownership closure is checked against a hash the
importer computed itself, not one the pack supplied. Given that, a signature
scheme in v1 would add operational cost (key distribution, revocation, a
verification step every import pays) without closing a threat model gap the
recompute pass does not already close. **Upgrade path**, if the trust model
ever needs to say "this pack came from a specific, attested build/CI job"
rather than merely "this pack's claims are internally consistent": add a
detached signature over `manifest_digest` (the manifest already canonically
excludes itself from its own digest input, so this is a drop-in addition,
not a format break) plus a verifying-key allowlist injected the same way
`URDIRA_INDEX_PACK`'s kill switch is — an opt-in daemon option, defaulting to
"unsigned packs accepted" so existing packs and the CLI workflow above keep
working.

## All-or-nothing import, no partial seeding

`attemptIndexPackImport` mirrors `attemptWorkspaceFork`'s outcome contract
exactly: `{status:"imported", ...} | {status:"skipped", reason}`, **never**
throws, and any failure after the target's own source layer is durably
committed rolls back *everything* this attempt wrote
(`rollbackForkPublication`, reused verbatim) before returning `"skipped"`.
There is no partial-import mode. This is decision 11's chain-salting made
concrete: a *replacement* record open's id is salted by its *previous*
record's id (`hasSalt`/`newRecordId` in `candidate-materialization.ts`), so
canonical-row identity is only unambiguous for a clean, from-nothing
generation 1 — exactly what both a fork and a pack import mint. Importing
"most of" a pack and leaving the rest for a normal scan to fill in would mean
that scan's own first real generation-2 publish computes replacement ids
salted against a generation-1 state that is *itself* only partially real,
silently producing ids that do not match what a genuine full scan (or a
complete import) would have minted for the same content. All-or-nothing
avoids ever constructing that state, at the cost of an import that fails
closed (full rollback, full fallback scan) rather than degrading gracefully
— the same tradeoff decision 12 already made for fork, inherited here
unchanged.

## Compatibility axes

Checked in `attemptIndexPackImport`, in order, each a hard skip on mismatch
(no partial-compatible mode):

| Axis | Pack side | Target side | Why |
|---|---|---|---|
| `storage_format_version` | `workspace_meta` key `storage_format_version` at export | same key, target's own already-open database | a pack minted under a different on-disk schema contract cannot be safely re-inserted into today's tables |
| `identity_format` | `workspace_meta` key `identity_format` | same | decision 11's content-derived id derivation; a pre-format-2 pack's ids would not mean what today's code expects |
| `resolved_plugins_digest` | `sortedResolvedPluginsDigest` of the donor's persisted `plugin_resolution_lock.resolved_plugins` | same function over the target's own `plugin.resolution_lock` | the *only* thing plugin analysis output actually depends on (see decision 12's own reasoning for `donorPluginResolutionMatches`, reused verbatim here) — folds in plugin id, version, and (for the JS/TS plugin) its bundled TypeScript compiler version, since all three are inputs to each resolved plugin's own digest. A **separate, independently-tracked `typescript_compiler_version` axis was considered and deliberately not added**: it would be redundant with this digest for the only plugin that has one today, and inventing a plugin-agnostic axis name for a JS/TS-specific concept was not worth the complexity for v1 — flagged here rather than silently dropped. |
| `analysis_configuration_digest` | donor's persisted `workspace_configuration_revision.analysis_configuration_digest` | target's own `plugin.configuration.analysis_configuration_digest` | decision 15's durable-analysis-cache axis; a pack analyzed under different plugin configuration would produce different facts for identical source text |
| multiset (content) | full `[normalized_uri, content_hash]` list + digest | importer's own fresh enumeration of its root | see below — the actual ground-truth check, not a "compatibility" axis in the same sense as the others but gated identically (hard skip, no partial) |

## Multiset realism and bounded-diff reporting

Decision 12's own hard-won lesson (the husky-untracked-shims incident:
"clean + same git commit" is a true statement about *tracked* content only,
and two checkouts can have more/fewer *scanned-but-untracked* files even at
identical HEADs) applies at least as strongly across machines, where there is
no shared git history to even offer a preference hint. An index pack import
therefore runs the **exact same unconditional, complete multiset equality
check** fork uses (`multisetKey` over `[normalized_uri, content_hash]` pairs,
reused verbatim) — no git fast path at all for packs, since there is no
local donor worktree to compare against, only the importer's own freshly
enumerated root.

On a mismatch, the skip reason is not a bare "content differs": `multisetDiff`
(`index-pack.ts`) reports, each list bounded to `max_diff_entries` (default
20, `IndexPackImportOptions.max_diff_entries`): entries only in the pack,
entries only in the target's local root, and entries present on both sides
with different content hashes — e.g. `(d) removing one multiset entry`'s test
asserts the skip reason names the specific removed uri, and
`(f) content mismatch`'s test asserts it names the specific extra local file.
This is a genuine operational requirement, not a nicety: without it, a
mismatched pack import degrades to "silently falls back to a full scan with
no diagnostic," which is exactly the failure mode decision 12's own incident
report identifies as the reason a bounded diff is required at all.

## Provenance

A fork's `candidate_state.trigger_kind` is hardcoded `"core:workspace_fork"`
(`buildForkPublicationPlan`, `publication-authority.ts`). `ForkPublicationPlanInput`
gained an optional `triggerKind` field (default `"core:workspace_fork"`,
every pre-existing caller unaffected) so an index pack import can publish
with `trigger_kind: "core:index_pack_import"` instead — the same O(1)
publication shape, distinct provenance. A snapshot's `candidate_state` row
can therefore always be read back to tell a local same-machine fork apart
from an imported distributable pack. The pack's own `manifest_digest` and
`pack_id` are not separately persisted as a distinct provenance record in
this v1 (a natural, cheap follow-up: a `control_plane_state` row keyed
`index_pack_provenance:<candidate_id>` carrying `{pack_id, manifest_digest,
donor_workspace_id}`, mirroring how `plugin_resolution_lock`/
`workspace_configuration_revision` rows are already persisted) — flagged as
deferred, not silently dropped.

## How `bulkCopy*` reuse was achieved

`workspace-fork.ts`'s `bulkCopyRecordsAndIdentities`/`bulkCopyDependencies`/
`bulkCopyProjections` took a full `WorkspaceDatabase` donor parameter, but
structurally only ever touch `.workspaceId` and `.database.{filename,all,get,run}`.
Their donor parameter type was narrowed to a new exported `ForkDonorHandle`
interface (`{workspaceId, database: Pick<SqliteDatabase, "filename"|"all"|"get"|"run">}`)
— every real fork call site (a genuine `WorkspaceDatabase`) satisfies this
structurally with zero changes, and it is the only change those three
functions needed to become reusable. `attemptIndexPackImport` then builds a
throwaway `ScratchDonorDatabase`: a `PRAGMA foreign_keys = OFF` SQLite file
(opened directly via `node:sqlite`'s `DatabaseSync`, not the production
worker-thread-backed connection — this is a small, ephemeral, single-import
scratch file, not the target database) containing only the six tables those
three functions actually read (`record_occurrences`, `record_value_nodes`,
`record_facets`, `identity_assignments`, `artifact_dependencies`,
`projection_occurrences`), populated directly from the pack's streamed rows
with fabricated-but-stable per-uri ids
(`stableId("index-pack-donor-artifact[-version]", {uri[, content_hash]})`).
Foreign keys are off specifically so this scratch file never needs
`source_artifacts`/`artifact_versions`/`content_blobs`/`source_observations`
rows at all — those fabricated ids exist purely as an internal join key for
`buildFullArtifactMap` (also reused verbatim) to remap onto the *target's*
real, freshly enumerated artifact ids; they never appear in what gets
published. `commitForkSourceLayer`, `enumerateForkRoot`,
`computeForkSnapshotDigestFields`, `buildForkPublicationPlan`,
`publicationTransactionCommands`, and `rollbackForkPublication` are all
reused completely unmodified (the last three already public from
`@urdira/storage`; the engine-internal ones — plus `multisetKey`,
`sortedResolvedPluginsDigest`, `stableId`, `digest`,
`isKnownPreexistingVerifyGap`, `visibleCapabilityStateEntries`, and the
`ForkContext`/`ForkEnumeration`/`ForkSourceLayer`/`DonorVisibleArtifact`/
`DonorRowMap`/`ForkPublicationIds` types — gained `export`). `fastPackVerify`
is a new function, not a reuse of `fastForkVerify`: it sources its "expected"
values from the pack's manifest anchors instead of a live donor's
`repositories.snapshots`, since an import has no live donor database to read
back from.

`isKnownPreexistingVerifyGap` (the same pre-existing `StorageMaintenance.verify()`
gaps documented on that function in `workspace-fork.ts` — registry digest,
plugin-resolution-lock CAS reference, freshness-checkpoint shape,
empty-projection-set digest) is reused for `attemptIndexPackImport`'s own
`verify_mode: "full"` path too: these gaps affect any normally scanned
workspace, not something either copy path introduces.

## RPC / CLI shapes

- **`core:index_pack_export`** (`packages/daemon/src/runtime.ts`): read-only
  on the workspace's own index (never touches `workspace_registry` or any
  published generation; its only side effect is a file written to local
  disk). `{workspace: <id-or-root>, out: <path>, "require-git-clean"?: "true"}`
  → `{workspace_id, out_path, pack_id, manifest_digest, row_counts}`.
  Requires the workspace to be `"ready"`. CLI: `urdira index-pack-export
  <workspace> --out <path> [--require-git-clean]`, added to
  `MUTATING_COMMANDS` (not because it mutates anything, but because
  `READ_ONLY_COMMANDS`' dispatch hardcodes a no-positional-args rule for
  `status`/`index` that does not fit two args + `--out`; the
  preview/confirm dance it inherits is a harmless formality for a genuinely
  idempotent, non-destructive export).
- **Import has no separate verb.** `core:workspace_add` gained an optional
  `values["index-pack"]` field (CLI: `--index-pack <path>` on
  `workspace-add`), registered into a `workspace_id -> pack_path` side
  channel (`pendingIndexPackPaths`, mirroring the existing `pendingScans`
  coalescing map's placement in `runtime.ts`) *before* `scheduleWorkspaceScan`
  is called, consumed exactly once by the first-ever-scan branch. This is the
  simpler-and-correct shape the plan asked for: import is only ever valid on
  a genuinely fresh, never-scanned workspace, which `workspace-add` is the
  only command that creates — a standalone `index-pack-import` verb would
  need to duplicate `workspace-add`'s own path-resolution/registration logic
  for no benefit.
- **Runtime hook order** (`runtime.ts`, beside the existing fork hook): on a
  genuine first scan, try a local fork first (cheaper, no untrusted-recompute
  pass, decision 12's existing behavior, untouched), then — only if a pack
  path was registered for this workspace — try the pack import, then fall
  back to `runProgressiveWorkspaceScan`. Both attempts are independently
  kill-switchable (`DaemonRuntimeOptions.workspace_fork` /
  `.index_pack`, env `URDIRA_WORKSPACE_FORK` / `URDIRA_INDEX_PACK`, both
  default ON) and independently verify-mode-selectable
  (`.workspace_fork_verify` / `.index_pack_verify`, env `URDIRA_FORK_VERIFY`
  / `URDIRA_INDEX_PACK_VERIFY`, both default `"fast"`).

## Tests

`tests/phase-index-pack.test.ts` (engine-level, no daemon — mirrors
`tests/phase-workspace-fork.test.ts`'s own `createDurableStorage`-direct
harness pattern for its bug-2/bug-4 regressions). The two files' shared
harness (plugin-registry preparation, the JS/TS plugin provider stand-in,
engine-level workspace registration) was extracted into
`tests/helpers/fork-harness.ts` — a **plain module, not a re-import of the
other `.test.ts` file**: importing a vitest test file for its helpers would
also re-execute every `describe`/`it` it declares as a side effect of module
evaluation, silently double-running that file's own suite.
`tests/phase-workspace-fork.test.ts` was left completely untouched (verified
via `git diff`) rather than refactored to source its own copies from the new
helper module, to carry zero risk to its already-passing suite.

- **(a) round-trip**: export a donor pack, import into a **second,
  independent `DurableStorage` data root** (simulating a fresh machine — no
  shared registry, no local donor) with byte-identical seeded files →
  `"imported"`, `verify_mode: "full"` passes, the imported snapshot's
  `canonical_record_set_digest` equals the donor's, and the imported
  `record_id` set is byte-identical to the donor's.
- **(b) tamper: mutated `body_payload` byte** → `"skipped"`, and the fallback
  `runFullWorkspaceScan` on the same (rolled-back) workspace publishes
  normally, mirroring decision 12's own bug-2 rollback regression test.
- **(c) tamper: forged `record_id`** → `"skipped"` (self-consistency check),
  fallback scan succeeds.
- **(d) tamper: removed multiset entry** (with the manifest's own row count
  and digest kept internally consistent, so the failure is the *content*
  multiset-vs-local-root mismatch, not an earlier row-count self-check) →
  `"skipped"`, reason names the specific removed uri.
- **(e) tamper: wrong `resolved_plugins_digest` axis** → `"skipped"` before
  any durable write (the gate fires before `commitForkSourceLayer`), reason
  mentions `plugin_version`; fallback scan succeeds without needing a
  rollback (there was nothing to roll back).
- **(f) fallback: local root has an extra file the pack does not** →
  `"skipped"`, reason names the specific extra local uri, fallback scan
  succeeds and reaches `"ready"`.

Run: `pnpm run typecheck` (full monorepo, clean) · `tests/phase-index-pack.test.ts`
(6/6) · `tests/phase-workspace-fork.test.ts` (11/11, unmodified, run both
standalone and inside the full suite) · `tests/phase15-workspace-control.test.ts`
+ `tests/phase9-publication.test.ts` (127/127, `triggerKind` addition
regression coverage) · `tests/contracts.test.ts` (74/74) ·
`tests/architecture-guardrails.test.ts` (56/56, after the base64→hex fix
below) · full `vitest run`: **1687/1688**, the one failure
(`phase-workspace-fork.test.ts`'s pre-existing "(bug 3)" test, a file this
change never touched) reproduces only under full-suite concurrent load and
passes cleanly every time it is run in isolation — pre-existing flakiness
under resource contention, not a regression (confirmed by rerunning that file
alone twice, 11/11 both times, immediately before and after the full run).

## Deferred / known limitations (reported honestly, not silently dropped)

- **`record_digest` full recomputation** is not attempted (see "Trust model"
  #2) — only id/digest self-consistency and id-shape validation. Closing this
  fully would require either (a) plugins persisting their pre-decomposition
  `ProposedRecord` JSON somewhere durable (a real storage-format change, well
  beyond this feature), or (b) accepting that this axis stays a
  self-consistency check rather than ground truth, same as it is today.
- **Pack-level provenance is not a separate persisted row** (see
  "Provenance") — recoverable today only by cross-referencing
  `candidate_state.trigger_kind = 'core:index_pack_import'` plus whatever the
  operator externally remembers about which pack was used.
- **Export's non-`record_occurrences` tables use `LIMIT`/`OFFSET`**, not
  keyset pagination — `O(n²)` total read cost for a genuinely huge
  `record_value_nodes`/`artifact_dependencies`/`projection_occurrences` set.
  Not a concern at today's real-workload scale (v3 stores the canonical body
  once in `body_payload`; `record_value_nodes` is a near-empty legacy
  fallback path in practice — see the schema comment on that table) but
  flagged as the first thing to fix if a very large, dependency-dense
  workspace's export gets slow.
- **The scratch donor SQLite file runs on the main thread** via `node:sqlite`'s
  synchronous `DatabaseSync`, not the production worker-thread-backed
  connection — fine for the fixture-scale workspaces this feature's own
  tests exercise, but a real perf lever to revisit (batch inserts inside
  explicit transactions, or move the scratch build to a worker) before this
  is exercised against a hundreds-of-thousands-of-records pack.
- **No standalone `index-pack-import` CLI verb** — see "RPC / CLI shapes":
  `workspace-add --index-pack <path>` is the only import entry point in v1,
  a deliberate simplification, not an oversight.
- **No signature scheme** — see "Trust model" for why, and the upgrade path
  if that changes.
