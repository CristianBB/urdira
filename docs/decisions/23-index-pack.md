# Decision 23: Index pack bootstrap

Status: Accepted
Last updated: 2026-09-08
Related: [decision 30](30-index-pack-distribution.md) evaluates and closes the
separate question of a cross-machine pack distribution/sharing layer on top
of the mechanism below; this decision stays scoped to the pack format and
its local export/import mechanism.

Two independent pack containers exist today, gated on the workspace's
structural store: the v3 pack (schema version 1, gzip/NDJSON row replay,
"## Carrier and manifest" through "## Known limitations" below) for a
workspace on the legacy SQLite structural tables, and the v4 pack
("## v4 pack format" below) for a workspace on the native structural store
(`crates/urdira-structural-store`). They share the same bootstrap contract
(first-generation only, untrusted input, rollback-to-scan on any failure)
but are structurally unrelated file formats with independent code paths.

## Decision

Urdira may export the current `ready` generation of a workspace as one
portable index pack and use that pack to bootstrap a content-identical, newly
registered workspace on another installation. The pack is an optional
first-generation acceleration path. It does not change workspace identity,
query behavior, provenance, completeness, ordering, or the ordinary scan
contract.

Import is allowed only through `workspace-add --index-pack <path>` before the
target has completed its first scan. A same-installation workspace fork is
attempted first because it remains inside the local trust domain. If no fork is
available, Urdira may attempt the pack. Any incompatibility, corruption,
source mismatch, verification failure, cancellation, or publication failure
rolls back the attempt and continues through the normal progressive scan.
Import must never leave a partially published generation or a workspace that
cannot fall back.

## Carrier and manifest

Schema version 1 is a gzip-compressed, newline-delimited JSON stream. The
manifest is the first line, bounded row batches follow, and an explicit end
record detects truncation. Export and import stream the carrier; neither may
materialize the full pack in memory.

The manifest commits to:

- its schema version, reproducible creation time, pack identity, donor
  workspace, and donor generation;
- storage, identity, resolved-plugin, and analysis-configuration compatibility;
- exact row counts for every transported section;
- the normalized source-path/content multiset;
- the donor's canonical-record, projection, capability-state, and source-state
  anchors; and
- a digest over the complete manifest excluding the digest field itself.

Transported owner and dependency references use normalized source URIs rather
than donor-local artifact identifiers. Portable content-derived record and
projection identifiers remain unchanged. Binary relational values use the
closed version-1 hex representation; transport bytes do not participate in
logical ids, ordering, or digests.

The carrier is deliberately not the native worker or storage format. It is a
portable boundary representation used only by this feature. SQLite remains
the relational authority and CAS remains the immutable content authority after
publication.

## Export

`core:index_pack_export` and
`urdira index-pack-export <workspace> --out <path> [--require-git-clean]`
operate on one explicitly selected `ready` workspace. Export is read-only with
respect to Urdira state; its only side effect is the requested local file.

The exporter uses bounded pages for corpus-scale sections, writes one section
batch at a time, and rechecks emitted row counts against the manifest. A source
or generation drift during export fails the operation instead of producing a
self-inconsistent pack. `--require-git-clean` is an optional operator policy
and does not redefine workspace identity.

## Import trust boundary

An index pack is untrusted even when its transport and manifest digests match.
Import therefore verifies all of the following before it can become the
current generation:

1. The manifest shape, digest, schema, and compatibility axes are exact.
2. The local target's normalized path/content multiset equals the pack's
   multiset, with bounded mismatch reporting.
3. Every record body decodes and reproduces its declared body digest; record
   identifiers and record digests satisfy their closed self-consistency rules.
4. Row counts, owner mappings, dependencies, projection anchors, canonical
   record-set anchor, capability-state anchor, and source-state anchor agree
   after copy.
5. The ordinary immutable-row, generation, publication, and current-pointer
   checks succeed in the same transaction used by workspace-fork publication.

Target source catalog capture is deferred to the persistent Rust indexing core
and committed through its closed source-index protocol. Pack import therefore
shares the production writer and recovery boundary with ordinary scans; the
TypeScript source commit remains an explicit test/oracle route only.

Per-record body verification normally runs in one or two bounded workers while
the scratch donor is being streamed and the target source layer is being
cataloged. Corruption is rejected before bulk copy or publication. The
target-side verifier remains the correctness fallback when stream verification
is disabled or unavailable. Worker concurrency is an implementation
optimization only: worker failure skips the import and triggers the full scan;
it never weakens a check.

The scratch donor database is isolated from the target. Bulk copy may
temporarily drop and rebuild empty-target secondary indexes inside the target
publication transaction, but SQLite rollback must restore both schema and rows
on failure. Primary-key ordering and bounded insert transactions affect cost,
not logical ordering or durability.

## Operational controls

The feature is opt-in per workspace registration. These environment controls
are recovery and diagnosis levers, not alternate semantics:

- `URDIRA_INDEX_PACK=0` disables import attempts;
- `URDIRA_INDEX_PACK_STREAM_VERIFY=0` forces target-side record verification;
- `URDIRA_INDEX_PACK_VERIFY` selects the registered fast or full post-copy
  verification mode; and
- the existing workspace-fork controls remain independent.

No import path is inferred from the current directory, daemon connection, Git
branch, or process state. The workspace root and pack path are explicit
arguments. Pack import performs no network access and has no signature or
remote trust-discovery scheme.

## Failure flow

```text
new workspace
  -> compatible local donor? -> verified local fork -> ready
  -> explicit index pack?     -> verify stream and local source
                              -> atomic copy and post-copy verify -> ready
                              -> any failure -> rollback
  -> progressive source/plugin scan -> ready or typed scan failure
```

The pack attempt is never retried blindly after a failure. The ordinary scan
is the authoritative fallback and retains the same source-first and progressive
publication behavior defined by Decisions 20–22.

## Known limitations

- Version 1 has no signature scheme. Operators distribute packs through a
  channel they choose; Urdira still treats every pack as untrusted input.
- The target source tree must be enumerated and content-checked. A pack avoids
  plugin analysis and most publication construction, not source identity
  verification.
- The gzip/NDJSON/hex carrier prioritizes a small dependency surface and exact
  validation over minimum file size. Other carrier formats or schema versions
  are unsupported.
- Import remains a first-generation operation; there is no merge into an
  already published workspace and no standalone import verb.

## Verification evidence

Normative behavior is covered by `tests/phase-index-pack.test.ts`, the
workspace-fork rollback suite, publication tests, and the release verification
gate. Current non-normative performance and live corruption evidence is in
[`../evidence/2026-08-24-index-pack-codec-performance.md`](../evidence/2026-08-24-index-pack-codec-performance.md)
and
[`../evidence/2026-08-24-readiness-queue-implementation.md`](../evidence/2026-08-24-readiness-queue-implementation.md).

## Rust-owned pack copy on the v3 path

Pack bulk-copy and its target publication transaction remain a
compatibility/oracle implementation. A daemon with the persistent Rust
composition worker consumes the pending pack request and deliberately falls
through to the normal Rust generation; the engine also rejects an injected
Rust writer at the legacy import boundary. Thus no production pack attempt
can open a second TypeScript structural writer. A Rust-native pack-copy
command can restore this optimization later while retaining the same
verification and publication contracts.

## v4 pack format

Everything above this section describes the v3 pack (schema version 1,
tagged-NDJSON row replay). A workspace with a native structural store
(`readStructuralStore(db) === "native"`) has no row-level relational
representation to replay -- its corpus is a binary segment store
(`crates/urdira-structural-store`) -- so it uses a wholly separate, simpler
pack container instead, gated entirely apart from the v3 code path above and
now wired into the daemon end to end.

**Container.** A `.urdira-index-pack-v4` file: gzip-compressed, a `u32`
little-endian length prefix, one JSON manifest, then every listed file's
bytes concatenated in the manifest's own order. The manifest is
`{format:"urdira-index-pack-v4", schema_version:1, workspace_id, generation,
roots, canonical_record_set_digest, source_state_digest, files}`, where
`files` lists `workspace.sqlite` (the catalog), everything under the donor's
`structural/` directory (segments, dictionaries, `merkle/*.tree`), and
everything under its Rust-side `sidecar/` directory (`sidecar_root`, the
`WorkspaceScanRequest` parameter -- distinct from, and unrelated to, the
TypeScript lexical/semantic sidecar FILES below). `exportV4IndexPack`/
`importV4IndexPack` (`packages/engine/src/index-pack.ts`) stream every file
through rather than buffering it, since a single `merkle/<set>.tree` file is
a fixed ~35.8 MB regardless of corpus size.

**Derivatives excluded.** The pack never includes `<db>.lexical.sqlite` or
`<db>.semantic.sqlite` -- both are TypeScript-managed sidecar DATABASES
(`sidecarDatabasePathFor`), entirely different from the Rust `sidecar_root`
directory the pack does carry, and both are cheap to regenerate locally
(`submitLexicalMaintenance`/`submitSemanticMaintenance`, already triggered
after any v4 scan completes, import included). Shipping them would only
grow the pack for content the importing installation rebuilds anyway.

**Re-pinning `workspace_id` (R17).** Two installations mint independent
workspace ids for what may be the same canonical root, so import always
rewrites the donor's id to the importing installation's own:
`rewriteV4WorkspaceIdentity` (generic over every TEXT column and
workspace-id-templated key across the v4 catalog schema, shared with the
local v4 fork primitive in `workspace-fork.ts`) handles every column except
one -- `workspace_meta.value` is a canonical-encoded BLOB, not TEXT, so
`importV4IndexPack` also runs a direct `UPDATE workspace_meta SET value = ?
WHERE key = 'workspace_id'` with the target id (a no-op `UPDATE` if that row
does not exist yet -- it is not created here; `storage.openWorkspace`'s
`bindWorkspaceIdentity` mints it on first open, same as any freshly
bootstrapped v4 workspace). `recomputeV4SnapshotDigestsAfterRewrite`
recomputes each `snapshots.snapshot_digest` afterward, since its envelope
covers the identity fields the rewrite just changed. Without this, opening
the imported catalog under its new id would throw
`storage:workspace_binding_mismatch`.

**Daemon wiring.** `core:index_pack_export` now branches on
`readStructuralStore`: a native workspace runs
`index-pack-export-v4-worker-thread.ts` (the same worker-thread-per-export
pattern as the v3 path) calling `exportV4IndexPack` with `structuralRoot`/
`sidecarRoot` resolved from `structuralStoreDirFor`/`sidecarScanDirFor`;
the RPC additionally requires no scan in flight for the workspace (`status
=== "ready"` alone does not imply this for v4 -- a background `reconcile`
can run without ever leaving `"ready"`). The response reports
`{workspace_id, out_path, generation, bytes, roots}`.

`workspace-add --index-pack <path>` registers the pack path exactly as it
already did for v3 (`pendingIndexPackPaths`); `runV4WorkspaceScan`'s
first-scan branch now consumes it: it imports into a disjoint staging area
(`<db>.import-staging-<uuid>` -- the exact suffix the orphan sweep already
classifies as "in progress" for up to an hour, decision H/orphan-sweep's R15
rule), and only on a verified import does it atomically `rename` the staged
database/structural/sidecar paths over the ones `ensureV4Workspace` just
bootstrapped. A failed import (corrupt pack, a Merkle mismatch, any I/O
error) never touches those paths at all -- the staging directory is
discarded and the scan proceeds as an ordinary `full` scan, exactly as if no
pack had been requested. This is the same "never leave a partially published
generation, never leave a workspace that cannot fall back" invariant this
decision's v3 section states, applied to the v4 container.

**Reconcile follow-up, not full (R17).** A successful import skips `full`
entirely, even though it is technically the workspace's first scan: the
imported catalog already carries a generation greater than zero and a real
frontier to diff against, so the scan sent to the worker uses `scope:
{kind: "reconcile"}` (Frente E, `docs/decisions/29-v4-rust-owned-scan-
pipeline.md`'s amendment) -- an authoritative walk of the LOCAL tree,
diffed against the donor's imported frontier, republishing the difference.
`core:index_status`'s `last_scan.kind` reads `"reconcile"` for this scan,
with `last_scan.reconcile` carrying the usual `ReconcileSummary`. If the
reconcile itself fails, the existing "requires a prior generation"
retry-to-`full` still applies.

**Discovered limitation: the first post-import reconcile always measures
`mode: "cold"` today, even for a byte-identical donor tree.** Live evidence
(`URDIRA_DEBUG_TIMING=1` against the real worker): `crates/urdira-source-
frontier/src/walker.rs`'s `metadata_digest` hashes `byte_length, ctime_ms,
device, inode, mode, mtime_ms` -- by that module's own doc comment, this is
deliberately scoped to the SAME-MACHINE incremental-scan equivalence rule
("only ever compares a value this same crate produced against an earlier
one it produced"), not cross-machine portability. `delta.rs`'s `classify`
requires BOTH `content_hash` and `metadata_digest` to match for
"equivalent"; a copy onto a different machine (or a different local
directory) always gets a fresh inode/mtime, so metadata_digest can never
match the donor's persisted value regardless of real content equality.
`reconcile` therefore measures 100% "changed" for every real cross-machine
import and correctly, safely falls through to `cold` -- which still
re-derives and republishes everything from scratch, so the result is
byte-correct (verified below), just not faster than an ordinary `full`
scan. `noop`/`delta` reconcile modes are consequently unreachable after an
index-pack import as currently shipped; the fix (relaxing `classify` to a
content-hash-only equivalence, which costs nothing extra since the walker
already computes both fields unconditionally) belongs to Frente E's
already-merged `delta.rs`/`walker.rs`, not this frente's disjoint file
zone -- recorded here as a follow-up, not implemented in this pass.

**Verification.** `tests/index-pack-v4.test.ts` covers the re-pin in
isolation (import to a different workspace id, `workspace_meta` updated,
snapshot digests recomputed, roots independently re-verified, and
`storage.openWorkspace` opens the result without a binding mismatch).
`tests/phase-daemon-v4-index-pack.test.ts` covers the daemon wiring
end-to-end against the real worker binary: export produces a valid v4
manifest; `workspace-add --index-pack` over a byte-identical tree reaches
`ready` via `reconcile` (never `full`) and answers `core:find_references`
identically to the donor; over a tree with one locally-changed file it
still reaches `ready` via `reconcile` and correctly resolves the new local
symbol (absent from the donor's own snapshot), proving the `cold` fallback
never silently serves stale donor data; and a corrupt pack falls back to a
`full` scan and still reaches `ready`.

## Export timeout and progress reporting

Live evidence (`docs/evidence/2026-09-07-v4-vscode-campaign.md` §6.0/§9 item 3): `core:index_pack
_export` on a 3.6GB VS Code-scale store measured 63.5s (clean) to 109s (under concurrent load) --
but `apps/urdira/src/index.ts`'s `longRunning` deadline list (the set of admin RPC calls that get
`adminRequestTimeoutMs`, default 300s, instead of the IPC transport's own hardcoded 30s default)
never included `core:index_pack_export`. A plain CLI-driven export therefore aborted at exactly
30,002ms with `core:ipc_timeout` on anything past that floor, confirmed live; the campaign had to
call `DaemonClient` directly with an explicit long `deadline_at`, bypassing the CLI's own timeout
policy, to measure the export at all.

**Considered and rejected: a detached `{operation_id, status: "running"}` + separate poll RPC**
(the shape this task's own plan text described first). Rejected for THIS pass in favor of the
mechanism below -- both give a caller an effectively unbounded wait with live progress, but the
poll-RPC shape additionally survives the CLI process itself being killed mid-export (a genuinely
separate, larger feature: the export would need to keep running fully detached from any particular
RPC connection, and a NEW caller would need to be able to discover and re-attach to an
already-running export by id). That is flagged below as a real follow-up, not implemented here --
this pass closes the P0 (a legitimate export aborting on a hardcoded internal deadline) without
introducing a new stateful server-side operation registry needing its own lifecycle/TTL/cleanup
policy on top of the one `WorkspaceRegistry.beginReconciliation`'s `reconciliation_operation_id`
already has for a different purpose (correlating a scan, never for fetching a RESULT by id -- there
is no existing "poll a result by operation_id" RPC anywhere in this codebase to reuse verbatim, per
research findings in this pass's own report).

**Mechanism actually shipped.** Two independent, additive changes:

1. **The deadline is caller-controlled, not a fixed short default.** `core:index_pack_export` is
   now in `runUrdira`'s own per-call deadline computation (`apps/urdira/src/index.ts`): by default it
   gets `INDEX_PACK_EXPORT_DEFAULT_TIMEOUT_MS` (24 hours -- the same ceiling `admin_request_timeout
   _ms` itself is validated against elsewhere in this same function), so "sin límite de tiempo" holds
   in practice. A new CLI option, `index-pack-export --timeout <seconds>` (`packages/cli/src/
   index.ts`'s descriptor + `OPTION_NAMES`), overrides that default when the caller wants a real
   bound -- read straight out of the same `values.timeout` field the daemon RPC handler's own
   `payload.values` already carries every other free-form option in (`--require-git-clean`, `--out`),
   no new payload shape needed. Compatibility: `core:index_pack_export`'s response shape is
   unchanged for a caller that finishes inside any deadline, short or long -- this is purely a
   deadline-computation change on the CLI-transport side, not a protocol change.
2. **Real progress, not silence.** `packages/daemon/src/runtime.ts`'s `core:index_pack_export`
   handler now starts a 1-second `setInterval` (cleared unconditionally in a `finally`) that `stat`s
   the growing output file and calls `context.reportProgress({phase: "index_pack_export", completed:
   <bytes written>, total: <best-effort estimate>, message})` -- the SAME streamed-IPC-frame
   mechanism `core:workspace_preview`'s file-discovery progress already uses (`LocalIpcServer`'s
   `reportProgress`/`IpcProgress`, `packages/daemon/src/protocol.ts`), so no new wire format was
   needed either. `total` is a one-time, best-effort estimate (`structural/` directory size via a new
   local `directorySizeBytesForProgressEstimate` recursive walk, plus the sqlite catalog's own file
   size) computed once before the v4 export call starts; every I/O error during that estimate is
   swallowed (`total` is simply omitted, never fatal to the export itself) -- §6.4 of the evidence doc
   measured the compressed pack at ~44% of this exact sum on a real 3.6GB VS Code-scale store, so the
   estimate is directionally useful even though the final pack is smaller (gzip).

**Result shape** (`{pack_path, bytes, generation, roots, export_wall_ms}`, the design's own naming):
`pack_path` was added as a new field on both the v4 and v3 (legacy NDJSON) export result branches,
alongside the pre-existing `out_path` (kept, not removed, for backward compatibility -- any existing
caller reading `out_path` keeps working unchanged). `export_wall_ms` (`Date.now()` around the whole
handler body, both branches) is new on both branches too.

**`import_wall_ms`.** A separate, previously-reported gap (§9 item 4 of the same evidence doc): no
product-exposed metric isolated a pack import's own cost (`importPendingV4IndexPack`'s stat +
native copy/verify + atomic rename) from the `reconcile` scan that always follows it (see "Reconcile
follow-up, not full (R17)" above) -- the campaign could only approximate it as `ready_elapsed_ms -
reconcile_wall`. `importPendingV4IndexPack` now returns `{imported, import_wall_ms, pack_bytes?}`
(measuring its own whole function body, regardless of success/failure/rollback) instead of a bare
`boolean`; `runV4WorkspaceScan` threads this into a new `V4LastScanSummary.import` field, set only
when the scan followed a pack import, surfaced as `last_scan.import` in `core:index_status`'s v4
status fields (`v4StatusFields`, `packages/daemon/src/runtime.ts`) and rendered as one extra clause
on the MCP `urdira_index_status` renderer's existing `last_scan:` line
(`import=ok|failed (<pack_bytes> bytes, import_wall_ms=<ms>)`).

**Verification.** `tests/app-runtime.test.ts` (new test) uses a fake `LocalIpcServer` (no real
export work) to observe the exact `deadline_at` `runUrdira` sends for `core:index_pack_export` --
confirms the ~24h default, confirms `--timeout 5` overrides it to ~5s, and confirms an
`index_pack_export` progress phase is forwarded to `on_progress`. `tests/phase-daemon-v4-index-pack
.test.ts` (extended) asserts `pack_path`/`export_wall_ms` on a real export against the real worker
binary, and asserts `last_scan.import.{imported, import_wall_ms, pack_bytes}` after a real pack
import reaches `ready`.

**Follow-up not implemented in this pass** (flagged, per the "considered and rejected" note above):
a genuinely detached export that survives the initiating CLI process being killed, discoverable by a
NEW caller via an `operation_id`. Today's mechanism (an effectively unbounded deadline plus live
progress on the SAME connection) closes the P0 this task authorized fixing; a detached/resumable
export is a materially larger feature (a server-side operation registry with its own
lifecycle/cleanup policy) that was out of this task's own time budget.

## Historial de cambios

- **2026-08-24** (feat: index pack + campaign-2 readiness levers): initial v3 pack decision (schema
  version 1, gzip/NDJSON carrier, `workspace-add --index-pack`).
- **2026-08-31** (Rust cutover): pack bulk-copy on the v3 path stays a compatibility/oracle
  implementation; a daemon running the persistent Rust composition worker falls through to an
  ordinary Rust generation instead of opening a second structural writer.
- **2026-09-06** (plan `generic-waddling-hartmanis.md` §7.1, Frente P-1): added the v4 pack format
  for workspaces on the native structural store — a distinct container, `workspace_id` re-pinning,
  and a `reconcile` follow-up scan instead of `full` after import.
- **2026-09-08** (Frente D-1, `docs/evidence/2026-09-07-v4-vscode-campaign.md`): `core:index_pack
  _export` given a caller-controlled deadline (`INDEX_PACK_EXPORT_DEFAULT_TIMEOUT_MS`, 24h default,
  `--timeout`) instead of the transport's hardcoded 30s, live progress reporting, and
  `export_wall_ms`/`import_wall_ms` metrics.
