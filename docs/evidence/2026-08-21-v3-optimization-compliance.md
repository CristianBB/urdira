# Urdira v3 optimisation compliance evidence

This record accompanies Decision 22 and separates code-level verification from
the workload acceptance campaign. It was produced with Node `24.18.1`.

## Verified in the repository

- Pipeline stages are validated as a dependency DAG, execute independent
  frontiers concurrently, pass complete upstream handles, reject ambiguous
  scalar bindings, and spool intermediate sets in an execution-scoped SQLite
  store. Final pipeline streams are appended to the immutable cursor manifest
  and signed cursor continuations preserve completeness without re-execution.
- Handle-native set/filter/join/deduplicate/select paths use canonical subject
  identities. Relation joins build indexed key maps once rather than probing a
  nested matching scan.
- Logical digest writers and fanout-16 Merkle roots are used for source,
  record, dependency and plugin projection set digests. Relational value
  digests hash the logical value directly instead of flattening a complete row
  array. Digest metrics expose bytes, leaves, nodes, ordering and rereads.
- FactDelta and source fragments enforce the 4 MiB/4096-row limits; SQLite
  writes use the conservative variable budget. v3 migration rejects old data
  roots and preserves a verified backup/CAS reuse path.
- `urdira_context` is exposed as the task-oriented composite MCP wrapper and
  v3 freshness/frontier options are carried through the public schema.
- Worker failures, cancellation, cursor replay, publication, migration,
  source indexing and benchmark preflight have typed tests.
- The v3 boundary is destructive: the v1-to-v2 migration module/CLI route and
  generic `candidate_staged_rows` lane were removed. Legacy roots are only
  inventoried for a verified backup and fresh reindex; the v3 worker writes
  exclusively to typed staging lanes.
- Publication-side relational value writes now use a bounded batch writer with
  hard limits of 1,024 rows, 13,312 parameters, and 4 MiB estimated payload.
  Oversized individual rows fail before publication rather than bypassing the
  memory budget. Publication supplies rows through a lazy iterator, so the
  limit also applies while flattening a single large logical value.
- Handle-native relation joins now prefer the indexed `graph_edges` projection
  with bounded subject-id chunks; when that optional projection is absent the
  complete record-based fallback remains authoritative. The SQLite query port
  also exposes bounded record batches for operations that need a corpus scan,
  and the relation cache retains identities/endpoints rather than decoded
  payloads.
- Cursor manifest segments use an idempotent immutable CAS insert and verify
  the committed digest/storage reference after the transaction, so a retry
  after a crash cannot duplicate or silently replace a segment.

The bounded writer was measured independently with one million synthetic value
rows: it retained no workspace-sized command array (977 bounded INSERT
commands were emitted and the post-GC RSS stayed near 140 MiB). The previous
per-row command path retained approximately 614 MiB of heap for the same row
count. This is a microbenchmark, not a full-workspace acceptance result.

## Verification runs

The following commands passed after the changes in this worktree:

```text
pnpm check:architecture
pnpm lint
CI=true PATH=/Users/Cristian/.nvm/versions/node/v24.18.1/bin:$PATH pnpm verify
pnpm package:release
CI=true PATH=/Users/Cristian/.nvm/versions/node/v24.18.1/bin:$PATH pnpm release:acceptance
```

The final release suite reported all unit, contract, integration, e2e, crash,
corruption, security, watcher, benchmark and package-inspection gates passed.

## Acceptance still requiring a fresh workload run

The historical expanded report is not evidence for the post-change P95 values.
The full sequential 60/60 agent campaign, workspace-size matrix and memory/WAL
measurements must be rerun against this exact build before claiming the numeric
targets in Decision 22 (calls per task, index P95, RSS, WAL, source characters,
turns and total session time). A preflight or the release benchmark does not
substitute for that campaign.

The compatibility boundary for legacy array-only data ports and the durable
manifest CAS write remain explicit final boundaries; they preserve behaviour,
but should be included in the large (100k/1M subject) pipeline campaign before
removing the compatibility path.

## Lexical accelerator removal

The v3 implementation now removes the legacy `lexical_trigrams` table, lookup
index, writer, query fallback, migration adapter, and maintenance repair path.
FTS5 is the sole candidate accelerator. Every candidate is still verified
against the exact CAS-backed lexical document, while short patterns use the
bounded exact scan path; therefore removal of the redundant projection does
not change exactness, provenance, completeness, or public query capability.
Shadow migrations copy the FTS5 content rows explicitly because the virtual
table is excluded from the relational digest. The focused storage, maintenance,
query, indexing, and pipeline tests pass with assertions that the legacy table
is absent.

## FactDelta memory boundary

The production JS/TS worker transport now sends one raw FactDelta and lets the
host derive native batches through a one-batch iterator after acceptance. Each
batch is receipt-checked and persisted immediately. Accepted deltas are then
compacted to identity, provenance, dependencies, completeness claims,
replacement sets, and validated staging bindings before candidate sealing;
large provider proposal arrays are no longer retained in the host. The default
direct-plugin response mode remains available for callers that explicitly need
the historical batch response.

The large-workspace follow-up removes the remaining corpus-sized owner-plan
allocation. Workspaces above 4,096 source artifacts or 128 MiB are processed
with one bounded owner stream; the request envelope and closure-sized file
references are released before the next owner is planned. This is a memory
boundary only: the same worker operation, manifest, replacement scope,
acceptance, ordering, and sealing contracts are used.
