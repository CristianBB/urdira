# Decision 23: Index pack bootstrap

Status: approved and implemented
Last updated: 2026-08-24

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
