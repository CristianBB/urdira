# Urdira Documentation

Urdira separates normative product contracts from evidence that verifies an
implementation or release.

## Start here

1. Read the [product foundation](product-foundation.md) for the current product
   boundary and specification index.
2. Use the [current architecture](architecture.md) to follow the implemented
   package, indexing, readiness, query, cursor, and MCP paths.
3. Read the relevant current specification in [decisions](decisions/).
4. Follow its links to the owning protocol, logical-digest rule, taxonomy,
   diagnostic registry, indexing registry, semantic registry, or compatibility
   contract.
   For Urdira's native indexing/storage lineage and destructive v3 boundary,
   also read [native pipeline and relational storage](decisions/21-native-pipeline-relational-storage.md), [v3 optimization](decisions/22-v3-optimization.md), [index pack](decisions/23-index-pack.md), [local web interface](decisions/24-local-web-interface.md), and [Rust native acceleration](decisions/25-rust-native-acceleration.md).
   For the v4 structural/digest/semantic pipeline (the default for newly
   added workspaces; opt out with `URDIRA_V4=0`, destructive and
   non-migrated relative to v3), read
   [v4 structural store](decisions/26-v4-structural-store.md),
   [v4 merkle bucket digests](decisions/27-v4-merkle-bucket-digests.md),
   [v4 Rust semantics and residual checker](decisions/28-v4-rust-semantics-and-residual-checker.md),
   and [v4 Rust-owned scan pipeline](decisions/29-v4-rust-owned-scan-pipeline.md).
   [Index pack distribution](decisions/30-index-pack-distribution.md) closes
   the question of a further distributed pack-transport layer (rule R20):
   none is built, since import already costs more than half of a cold scan.
   The private language-neutral cold/incremental route is defined by the
   [structural indexing fast path](protocol/structural-indexing-fast-path.md).
   The measured state of the v4 program as of 2026-09-05 (cold 27.7 s on
   n8n, sub-second worker-only increments, gates met/not met, open items,
   and the decisions pending for the owner) is summarized, in Spanish and
   non-normatively, in the
   [v4 campaign summary](evidence/2026-09-05-v4-campaign-summary.md); it
   predates the reconcile scan scope, the residual checker, end-to-end
   semantic wiring, workspace orphan detection, and the v4 index pack, all
   added in the 2026-09-06 through 2026-09-09 evidence files (e.g.
   [reconcile threshold](evidence/2026-09-06-v4-reconcile-threshold.md),
   [semantic close](evidence/2026-09-07-v4-semantic-close.md), and
   [VS Code campaign](evidence/2026-09-07-v4-vscode-campaign.md)), which
   report n8n cold at 23.4 s and VS Code cold at 30.0 s.
5. Use [audits](audits/), [evidence](evidence/), and public benchmark reports
   only as verification. They cannot introduce product behavior.
   The current Rust-core indexing transition is summarized in the
   [evidence-backed fresh-session handoff](evidence/2026-08-29-rust-core-indexing-handoff.md);
   it remains non-normative evidence. The implemented cutover contract is
   defined by the amendments in Decisions 21, 22, 25 and the structural fast
   path protocol.
6. Use the [release process](release.md) for qualification and publication.

Contributors and coding agents must also read [AGENTS.md](../AGENTS.md),
[CONTRIBUTING.md](../CONTRIBUTING.md), and
[architecture/manifest.json](../architecture/manifest.json).

## Authority

The authority order is:

1. current specifications linked by the product foundation;
2. registries, protocols, schemas, and serialization contracts linked by those
   decisions; and
3. audits, phase evidence, release reports, and benchmarks as non-normative
   verification.

If authoritative documents conflict, resolve the conflict in the owning
current specification before changing implementation or public documentation.

The current v3 native pipeline is defined by
[`decisions/21-native-pipeline-relational-storage.md`](decisions/21-native-pipeline-relational-storage.md).
Its destructive v3 storage, digest, pipeline, and migration boundary is refined
by [`decisions/22-v3-optimization.md`](decisions/22-v3-optimization.md).
Optional cross-machine bootstrap of a new workspace is governed by
[`decisions/23-index-pack.md`](decisions/23-index-pack.md).
The loopback UI, CLI HTTP adapter, and structured MCP web profile are governed
by [`decisions/24-local-web-interface.md`](decisions/24-local-web-interface.md).
Schema IR generates relational table metadata; typed worker arenas and the
length-prefixed Protobuf chunk contract are used only at their documented
boundaries.

For a v4 workspace (the default for newly added workspaces; an existing
workspace not yet on v4 keeps its v3 index until it is removed and
re-added, or until `recreateOutdatedWorkspaceDatabase` recreates a
genuinely outdated one -- see `versioning.md`), the structural store, digest
recipes, semantic model, and scan pipeline described above are entirely
superseded by
[`decisions/26-v4-structural-store.md`](decisions/26-v4-structural-store.md),
[`decisions/27-v4-merkle-bucket-digests.md`](decisions/27-v4-merkle-bucket-digests.md),
[`decisions/28-v4-rust-semantics-and-residual-checker.md`](decisions/28-v4-rust-semantics-and-residual-checker.md),
and
[`decisions/29-v4-rust-owned-scan-pipeline.md`](decisions/29-v4-rust-owned-scan-pipeline.md).
v3 and v4 never share a writable data root, a reader, or a digest recipe;
there is no compatibility reader in either direction (see `versioning.md`).
Per workspace, v4 keeps the same `<safeId>.sqlite` catalog file as v3 (now
holding only the catalog/snapshot/control-plane tables) and adds four
siblings: `<safeId>.structural/` (the native segment store: `MANIFEST`,
`base-<g>/`, `delta-<g>.seg`, `merkle/*.tree`), `<safeId>.sidecar/` (the
working directory `WorkspaceScanRequest.sidecar_root` points at),
`<safeId>.lexical.sqlite` (lexical FTS, ATTACHed onto the catalog
connection for queries), and `<safeId>.semantic.sqlite` (vectors) -- see
[`decisions/26-v4-structural-store.md`](decisions/26-v4-structural-store.md)
for the exact layout.

| Location | Purpose | Authority |
|---|---|---|
| `decisions/` | Current product and architecture specifications | Normative |
| `versioning.md` | Semver policy and runtime consequences | Normative |
| `protocol/` | Public operations, recipes, errors, and MCP binding | Normative |
| `serialization/` | Current logical digests, schemas, comparison, and validation errors | Normative |
| `taxonomy/`, `diagnostics/`, `indexing/`, `semantic/`, `compatibility/` | Closed registries | Normative |
| `audits/`, `evidence/` | Architecture and phase verification | Evidence |
| `release.md`, `reports/`, `../release/benchmarks/` | Release procedure and published benchmark evidence | Operational/evidence |

Historical implementation plans, private agent/editor configuration, raw
benchmark transcripts, and host-local paths are intentionally not part of the
public repository. All public documentation and code comments are written in
English.
