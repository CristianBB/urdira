# Storage and Projection Architecture

Status: **Approved and implemented for Urdira v3**
Last updated: 2026-08-20
Depends on: Universal data model, incremental indexing semantics, and [Decision 21](21-native-pipeline-relational-storage.md)

## Decision objective

Map the canonical logical model to local persistent storage and rebuildable specialized projections.

## Existing constraints

- The canonical fact model is the source of truth.
- Graph, relational, lexical, vector, metrics, artifact, and query-cache structures are specialized projections.
- All knowledge projections support invalidation by owner artifact.
- Query executions retain compact manifests rather than complete rendered responses.
- The product is local and open source.
- The destructive v3 data root has no v1, v2, or early-preview v3 decoder or
  in-place migration. Portable logical persistence is relational and digests
  are generated from Schema IR fields.
- Before write activation, the engine verifies the exact v3 application ID,
  format marker, schema fingerprint, and required SQLite features. Any
  unsupported root remains unopened and returns
  `core:index_contract_unsupported`.

## Approved decisions

All logical model fields live exclusively in the [universal data model](01-universal-data-model.md). This specification owns their physical implementation.

- Canonical records and source catalog state are authoritative. Graph, lexical, semantic, metric, dependency, and query structures are derived projections.
- Projection records are granular, source-owned, dependency-backed, and temporally versioned with the same half-open convention as canonical records. Their complete reverse-indexed inputs may include artifact versions, canonical records, and other projections.
- An unchanged projection remains open. Source, owner, generator, generator-version, configuration, or payload changes close it and create another occurrence.
- Historical snapshots retain the exact projections, generator identities, and configuration required to answer their advertised capabilities. A newer generator is never substituted silently.
- Current-only physical indexes may optimize open-record lookup without changing historical semantics.
- Generation manifests reference digest-covered, pageable change sets rather than embedding unbounded arrays. Candidate templates use bounded ordered staging rows instead of aggregate segment blobs.
- Query executions retain one snapshot lease per immutable workspace binding and stable result manifests. Cursor expiry atomically releases the complete lease set and never switches any participant to another snapshot.
- Physical deletion is mark-and-sweep reachability collection. Current snapshots, pins, leases, active candidates, and recovery checkpoints are roots.
- GC uses an epoch and lease-acquisition barrier, waits for earlier readers, and is resumable and idempotent.
- Shared content blobs are deleted only after global reachability proves that no workspace or retained execution references them.
- An active model-pack installation roots its complete declared asset set. An executable embedding-profile binding retained by a configuration, materialization, snapshot, or query execution roots its operational model-pack asset closure and the exact local runtime-build implementation closures. Released supplies, portable bindings without active or retained use, and permanent coordinate reservations are not byte roots.
- Model-pack removal only releases roots. Model and tokenizer blobs, templates, and runtime configurations are reclaimed by the same epoch and reader barrier as other shared content; metadata-only pack assets may become unreachable earlier than operational profile assets.
- Runtime-component build upgrades close old builds for new selection without rewriting retained bindings. A build cannot be physically removed while any materialization, snapshot, configuration, or query execution pins its implementation digest.
- Minimal snapshot-expiration metadata remains after payload collection to distinguish expiration from an unknown identifier.
- Logical embedding vectors store canonical digest-covered bytes rather than physical vector-database identifiers. Physical stores may deduplicate those bytes while retaining independent source-owned projection occurrences.
- Semantic materializations are immutable and snapshot-pinned. Projection-only generations may advance pending embedding coverage without mutating an earlier snapshot or exposing superseded vectors.
- Every physical index and optimization used by a public operation must preserve the exact candidates, scores, deterministic ordering, and completeness semantics of its logical contract. Approximate or sampled physical retrieval cannot implement an exact public operation.
- Query-cache persistence stores immutable ordered manifests after discovery, traversal, scoring, fusion, and reranking complete. Cursor reads only hydrate slices of those manifests; eviction or expiry never triggers implicit recomputation against a newer snapshot or ranking contract.

## Selected storage stack

The initial implementation uses SQLite in WAL mode for transactional metadata, canonical records, source catalogs, registries, projections, reverse indexes, and query manifests, plus a digest-addressed filesystem store for immutable large bytes. It embeds no external database service and has no mandatory vector database or graph database.

There is one small installation catalog database and one independently movable database per workspace. A workspace database contains every snapshot-pinned logical object needed to interpret that workspace, including retained registry and configuration values; shared immutable byte payloads live in the installation CAS. Cross-workspace queries open each workspace database in a read transaction after atomically acquiring all logical leases. No operation performs a distributed write across workspaces.

SQLite requirements are WAL journaling, full synchronous durability for publication commits, foreign keys, strict tables, defensive mode, trusted-schema disabled, explicit busy deadlines, and one serialized writer per workspace. Readers use snapshot transactions and never block source analysis outside short publication checkpoints. The serialized writer has foreground and background lanes: query-manifest and structural publication work is foreground, while semantic vector commits are background and yield between bounded commits. The exact minimum SQLite version and compile options are part of the engine compatibility manifest.

## Physical canonical layout

Common record-envelope columns are stored as typed columns: workspace, record, category, concrete and universal kind, owner artifact and version, source-span coordinates, producer and versions, schema version, valid-from and valid-to generation, record digest, logical-body digest and logical-body byte length. In v3 the logical body itself is one deterministic canonical payload on the occurrence; queries decode only selected bodies. Facets, identities and dependencies remain relational and indexed, and every owner and dependency lookup required by the logical model has a covering index.

Closed category tables store entity identity, relation identity, fact subject, evidence subjects, and diagnostic identity. Repeated typed values use child tables with explicit ordinals or set keys; semantics never depend on SQLite row order. Schema-IR-owned columns and child rows are the operational source of truth; no duplicate generic project payload is retained.

Identity tables separate lifecycle identity from immutable record occurrences. Their physical rows reference the immutable record and derive owner artifact/version through it instead of duplicating both strings. Open-current partial indexes accelerate `valid_to_generation IS NULL`; historical queries use generation interval indexes. Closing a record updates only its lifecycle interval under the publication transaction; immutable occurrence payload and digest never change.

Source artifacts, versions, tombstones, observations, reverse dependencies, generation manifests, and projection envelopes use typed columns and child tables. Large immutable source content belongs in CAS, while logical digests are recomputed incrementally from the relational values.

## Graph projection

The graph is a rebuildable relational adjacency projection over canonical relation arguments and selected entity/fact links. Each edge row contains workspace, source subject, relation record, relation kind, role, target subject, evidence class, owner artifact, source artifact versions, valid interval, and deterministic edge key. N-ary relations remain canonical relation records; adjacency rows never replace their argument structure.

Inbound and outbound covering indexes support direct neighbors. Bounded traversal uses a deterministic frontier ordered by depth, relation selector order, participant ordinal, and canonical subject bytes. Recursive SQL may implement simple traversals, while the query engine uses an in-process frontier for typed paths, evidence aggregation, cycle policy, and work budgets. Both must pass the same conformance vectors.

Shortest-path operations use breadth-first expansion over the exact eligible graph. A visited key includes subject plus operation-defined path state. Limits may reject an exact operation but cannot truncate it into a successful approximate result.

## Lexical and regular-expression indexes

Exact artifact text remains in the CAS. Urdira builds a deterministic FTS5 trigram candidate index in SQLite. Tokenization pins its Unicode tables, case-folding behavior, normalization form, and language-neutral boundary version. Language plugins may contribute canonical symbol names and aliases but cannot supply the public lexical matcher or ranking.

Literal search uses FTS5 as a candidate accelerator and verifies every match against exact pinned bytes. Safe regular expressions use a core-owned linear-time engine with a versioned dialect; unsupported constructs are rejected. FTS5 candidates are always verified, and expressions without a safe FTS5 prefilter scan the complete selected text scope. Therefore the derived index cannot change public matching semantics.

FTS5 is the v3 implementation accelerator for literal candidates. Native BM25 values, locale collation, and database row order never determine public ordering. The core calculates versioned lexical ranks using deterministic integer or exact-rational features.

## Content-addressed storage

The CAS key is the approved digest algorithm plus digest of exact decoded bytes. The physical path is derived from that validated digest under a fixed single-level prefix layout (256 leaf directories); caller-provided paths never influence it. A `.layout` marker in the CAS root pins this layout version; opening a pre-flattening two-level root is rejected (`core:index_contract_unsupported`) rather than reinterpreted, per the destructive-only migration policy. Each object stores byte length and media-domain metadata in SQLite, while the file contains only immutable bytes.

Writes stream to a private temporary file in the CAS filesystem, compute digest and length, atomically install (link) it without replacing conflicting content, then durably flush the installed file and the installed namespace entry before publishing references in SQLite. Batch writers (`putMany`/`putStreamsMany`) defer each blob's file fsync out of the per-blob install loop into one batched pass over every freshly installed file, run before the batched directory-fsync pass (a directory entry must never be journaled durable before the file content it names is) -- a measured APFS batch of 2,000 small files went from ~11.6s fsync'd interleaved with writes to ~0.85s fsync'd afterward in one pass, because the filesystem journal batches concurrent fsyncs far more cheaply than it does per-write interleaved ones. This is purely a scheduling change: every fresh blob's bytes and dirent are still durable before the call that installed them resolves, and nothing references a blob in SQLite until the caller's own commit, which happens strictly after that call resolves. Independent source writes use bounded configurable concurrency (`URDIRA_CAS_PUT_CONCURRENCY`, default 16); this changes only scheduling, not each blob's durability order. Native providers may attach a post-read boundary validator so CAS remains the single authoritative stream hash pass. The same platform durability adapter protects staging catalogs and backup/restore publication. POSIX adapters fsync each freshly installed file once per batch, then fsync each containing directory once per batch. The Windows adapter reopens a newly installed file with write access and flushes that file handle because the Node runtime cannot obtain the `FILE_FLAG_BACKUP_SEMANTICS` directory handle required by Win32 for a directory flush. Either adapter treats a flush failure as a storage error before publishing any reference in SQLite. An existing key is reused only after length and digest verification. A key containing different bytes is an integrity failure, never an overwrite.

Source content, model assets, tokenizer data, vector shards, and other immutable large blobs use the CAS. Operational record tables retain no aggregate project payload: each occurrence stores only its own bounded canonical body, which is independently digest-checked against the typed envelope.

## Exact vector boundary

Canonical vector bytes and their projection envelopes are stored logically in workspace SQLite. Physical vector payloads are packed into immutable digest-addressed shards with a SQLite row mapping each projection occurrence to shard, ordinal, profile, executable binding, dimensions, and vector digest.

The initial exact retrieval engine scans every eligible vector in each lane, applying hard filters before distance evaluation. Shards are grouped by exact vector-space and executable-binding identity and memory-mapped read-only. Parallel workers evaluate disjoint canonical ordinal ranges; merge order is deterministic.

Distance implementations obey the profile's element type, normalization, and metric. Accumulation order, widening, rounding, non-finite rejection, and tie comparison are versioned. Floating-point implementations disable contraction and use a reference order; SIMD or GPU kernels are legal only after bit-for-bit conformance across the supported corpus. Approximate nearest-neighbor indexes may exist only for offline experiments and cannot answer an initial public operation.

## Query-execution cache

Ready `QueryExecution` metadata and stream descriptors live in the installation catalog; immutable manifest entries and compact hydration references live in digest-addressed manifest segments. Each execution stores its complete binding set, plan hash, projection hash, response-budget contract, stream totals, completeness, registry bundle references, lease set, creation time, and fixed expiry.

Ready `IndexStatusExecution` metadata and its three immutable ordered safe-view sets use the same catalog/cache boundary but never share cursor kinds with queries. Status creation copies the selected workspace, activation-issue, and candidate-issue projections at one `observed_at`; later control-plane changes do not rewrite them. These copied sets are retention roots until fixed expiry and do not acquire source snapshot leases merely to render status. `RegistryUsageSet` manifests are query-execution-owned and bind their exact parent hydrated slices independently from later summary hydration.

Discovery, traversal, scoring, fusion, reranking, and ordering finish before `ready`. The first page and every later page hydrate manifest ordinals only. Backward and forward tokens therefore share one stored execution and never repeat ranking.

Default execution lifetime is 30 minutes and does not slide on access. The default cache capacity is 2 GiB excluding source/model/vector CAS objects. Admission reserves estimated manifest space before expensive execution. Expired executions are removed first; completed failed executions and expired manifests then use least-recently-created order. A non-expired ready execution is not evicted under ordinary pressure: a new query is rejected with a resource-limit error instead of invalidating promised cursors. Emergency administrative eviction is explicit, auditable, and returns `core:query_execution_evicted`.

Execution expiry or eviction deletes tokens and manifests transactionally and releases all participant leases together. Manifest storage never retains raw query vectors and retains original query text only when local privacy policy explicitly enables it.

## Transaction and publication protocol

Candidate work writes private staged objects under its candidate ID. Per-delta gates validate inputs before dependent enrichers may observe staged record views. Whole-candidate validation and projection precede sealing one immutable generation-neutral `CandidateMaterialization` on entry to `ready`. Pre-transaction verification recomputes its materialization and candidate digests, foreign references, replacement sets, and projection sets; it cannot preassign a numeric generation, publication time, snapshot ID, generation manifest ID, or generation-dependent digest.

One workspace SQLite transaction then:

1. verifies the current tuple still equals the frozen base;
2. assigns the next gapless generation and one publication timestamp;
3. finalizes every candidate template into source changes, record opens and closures, identity assignments, dependencies, projections, capability state, change sets, the generation manifest, and the snapshot;
4. computes and verifies every generation-dependent digest and storage constraint;
5. installs the complete snapshot, registry, lock, and configuration tuple;
6. changes the candidate to `published`; and
7. swaps the sole `WorkspaceCurrentState` tuple.

Commit is the visibility and recovery authority. Any failure rolls back the entire transaction and consumes no generation. CAS objects installed before the transaction remain unreachable if it aborts; later GC collects them. No current pointer can reference an uncommitted object. If commit succeeded but acknowledgement failed, recovery confirms the candidate as published and never republishes or marks it failed. Cleanup, catalog summaries, and watcher acknowledgements happen after commit and are idempotent.

## Physical schema migrations

Storage format has an independent monotonic version. The implemented v3
startup path verifies application ID, format, required SQLite features, and
schema fingerprint, then chooses only `compatible` or `unsupported`. It never
lets SQLite perform implicit type or collation changes and does not attach a
legacy root.

There is no current small-additive, rewrite, shadow-copy, or table-backfill
migration lane into v3. An operator may inventory and back up a legacy root out
of process, but activation requires a fresh v3 root and source reindexing. CAS
objects may be reused only after complete workspace-scope, byte-length, and
SHA-256 verification.

Any future in-place migration capability requires a new approved decision and
lossless adapters for every reachable logical value. Such a future migration
could change physical tables, indexes, compression, sharding, or cache
encoding, but could not change logical IDs, digests, validity intervals,
result order, or retained interpretation.

## Integrity, repair, backup, and rebuild

Cheap integrity checks run at every open: SQLite quick check, schema fingerprint, current-tuple references, WAL state, CAS length, and manifest roots. Full verification recomputes relational logical-value digests, set roots, dependency closure, projection digests, CAS hashes, vector-shard mappings, and snapshot manifests. A background scrub verifies a rotating sample daily and every reachable object at least once per configurable 30-day interval.

Corrupt mandatory data makes the affected snapshot unavailable; Urdira never serves unchecked substitutes. Repair proceeds in this order:

1. restore an exact verified object from a local backup or duplicate CAS copy;
2. rebuild a derived projection from retained canonical inputs;
3. rebuild a queryable current snapshot from retained source versions and exact analyzer/runtime contracts; or
4. reindex the live provider into a new workspace generation after explicit acknowledgement that historical equivalence cannot be restored.

Canonical records are never reconstructed from graph, lexical, or vector projections. Missing historical source or executable contracts can make exact historical rebuild impossible; status reports that limitation and preserves expiration/corruption metadata.

Backups use SQLite's consistent backup API plus a CAS reachability manifest captured under a retention pin. A portable backup includes workspace databases, catalog metadata needed for interpretation, registry/configuration objects, and every reachable CAS object. Restore verifies first and publishes no partial workspace.

## Compaction and garbage collection

Ordinary SQLite checkpointing is incremental and avoids blocking active snapshot readers. Database page reclamation uses incremental vacuum. Large table or shard compaction writes replacements, verifies them, and swaps references transactionally; it never rewrites logical objects in place.

Global mark-and-sweep uses the approved roots and reader barrier. It runs when unreachable estimated bytes exceed 512 MiB, when database free pages exceed 20%, or once every 24 hours, whichever occurs first. These are configurable scheduling defaults, not deletion authority. Sweep processes bounded batches and is resumable from `GarbageCollectionEpoch`.

Mark includes current snapshots, policy-retained snapshots, pins, leases, candidates, recovery checkpoints, active model-pack installations, retained executable bindings, and active query executions. It traces workspace databases before shared CAS. Only objects absent from the captured transitive closure and still unreachable after the barrier may be deleted. Reference counts are hints and never sole proof.

## Storage conformance

Acceptance requires crash injection before and after every publication step, byte-for-byte logical export comparison across migrations, exact graph and lexical reference queries against exhaustive fixtures, exact vector results across supported architectures, cursor replay during concurrent publication, backup/restore round trips, CAS collision simulation, corruption localization, and resumable GC tests.

## Completion criteria

The architecture satisfies incremental update, deterministic query, snapshot retention, pagination, and local deployment requirements with a defined migration and recovery strategy. Implementation acceptance requires the storage conformance suite above.
