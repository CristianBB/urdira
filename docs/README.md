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
   The private language-neutral cold/incremental route is defined by the
   [structural indexing fast path](protocol/structural-indexing-fast-path.md).
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
