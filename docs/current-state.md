# Current implementation and evidence

Reviewed: 2026-09-14. This is an implementation inventory, not a new product
contract or a release certification. Follow the [product foundation](product-foundation.md)
for normative decisions and the [architecture map](architecture.md) for code paths.

## Version and deployment boundary

The repository still declares application/bootstrap version **0.3.3**. The
changes after that version are recorded in [Unreleased](../CHANGELOG.md#unreleased);
this document does not establish that they have been published to npm.
The JS/TS plugin declares **0.6.0**, the native binding API is **17**, and the
v4 segment header format is **6**. These identify different compatibility
boundaries; v4 storage is not a package version or a new MCP API version.

Newly registered workspaces default to v4 (`index_contract = 0x34`), with a
native structural store and SQLite catalog, lexical, and semantic databases.
`URDIRA_V4=0` selects the retained v3 (`0x33`) pipeline for new registrations.
A supported existing v3 workspace keeps its own format. One installation can
serve both formats, but their structural readers, histories, and digest
recipes are not interchangeable. There is no automatic v3-to-v4 conversion.
See [versioning](versioning.md) for format selection and outdated-data recovery.

## Implemented capabilities

| Area | Current behavior | Authority and implementation |
|---|---|---|
| Source acquisition | Explicit workspace scope; directory/Git providers; catalog and CAS; exact source versions and reverse dependencies | [Decision 04](decisions/04-workspace-snapshot-incremental-indexing.md), `urdira-source-frontier` |
| v4 cold and incremental indexing | One persistent Rust composition worker owns catalog, analysis, materialization, immutable segment writes, Merkle updates, and snapshot publication | [Decision 29](decisions/29-v4-rust-owned-scan-pipeline.md), `urdira-indexing-worker/src/v4/` |
| Reconciliation | An authoritative walk computes added/changed/deleted paths; unchanged content with changed metadata stays a no-op; at most 1% delta uses incremental publication, otherwise cold; failed delta attempts fall back to cold | [Decision 29](decisions/29-v4-rust-owned-scan-pipeline.md), `v4/scan.rs`, `v4/catalog.rs` |
| Incremental correctness | Import candidate/reverse indexes, pending importers, re-export barrels, ambient globals, written type surfaces, and sibling-conformance dependencies widen the affected owner set when needed | [Decision 28](decisions/28-v4-rust-semantics-and-residual-checker.md), [reconcile evidence](evidence/2026-09-06-v4-reconcile-threshold.md) |
| JS/TS semantics | Oxc parsing/binding, hybrid resolution and unconditional v4 typeflow; namespace/export/alias and JS-to-TS specifier handling; explicit uncertainty and candidate bounds | [Decision 28](decisions/28-v4-rust-semantics-and-residual-checker.md), syntax-worker and typeflow crates |
| Source spans and identity | Entity spans cover declarations including relevant modifiers/decorators; identifier positions retain identity and checker lookup; declaration source is usable for body/signature retrieval and embedding | [Decision 11](decisions/11-content-derived-record-identity.md), [span evidence](evidence/2026-09-07-v4-entity-declaration-spans.md) |
| Residual checker | Opt-in `URDIRA_V4_RESIDUAL=1`; background pinned tsgo checker can publish confirmed relations, inferred types and diagnostics in `semantic_upgrade` generations; bounded continuations retain unresolved work | [Decision 28](decisions/28-v4-rust-semantics-and-residual-checker.md), `v4/residual.rs` |
| Structural queries | Indexed record/identity/name/kind/owner/adjacency lookups, native pushdown for references, impact, related tests and architecture; multi-participant comparison | [Public query contract](protocol/public-query-contract.md), native and canonical query ports |
| Query composition | Typed dependent pipelines and registered recipes; persisted manifests; forward/backward cursors; character and item paging budgets; explicit resource/selector errors | [Decision 03](decisions/03-query-algebra-public-api.md), `query-execution.ts`, `cursor-cache.ts` |
| Lexical search | FTS5 candidate lookup with exact byte verification; exact fallback when the projection cannot serve the selected snapshot; v4 sidecar reconciliation connected | [Architecture](architecture.md#lexical-and-semantic-sidecars), `lexical-reconciler.ts` |
| Semantic materialization | Native v4 entity source, full declaration inputs, token-bounded segments, artifact-vector reuse, segment cache, sharded child processes, materialized coverage, and resumable entity enumeration | [Decisions 16](decisions/16-semantic-search-wiring.md) / [17](decisions/17-entity-grain-semantic-documents.md), `semantic-v4-wiring.ts`, `semantic-reconciler.ts` |
| Semantic retrieval | Exact generation/provider-bound vector scans; resident contiguous-buffer native top-K for eligible float32 lanes; exact filtered/chunked fallback; explicit coverage and affected-set pagination | [Decision 06](decisions/06-semantic-search-ranking.md), [semantic registry](semantic/core-semantic-reasons.md) |
| Daemon lifecycle | Scan failure becomes visible degraded state; last valid snapshot remains available subject to admission; startup detects orphaned data; explicit purge rechecks eligibility | [Administration contract](protocol/workspace-administration-contract.md), [robustness evidence](evidence/2026-09-08-v4-daemon-robustness.md) |
| Index packs | Explicit v4 export/import is daemon/CLI-wired; binary pack preserves native data, rekeys catalog workspace identity and reconciles destination source; no pack registry or automatic network distribution | [Decisions 23](decisions/23-index-pack.md) / [30](decisions/30-index-pack-distribution.md) |
| Agent context delivery | Explicit-seed context roots, deterministic definition/caller/test ordering, page-local source sharing, exact source identity, envelope-aware page fitting, and immutable portable continuations | [Decision 19](decisions/19-agent-search-integration.md), [Public query contract](protocol/public-query-contract.md) |
| Agent and human interfaces | Three read-only MCP tools; prompt and pre-tool hooks for supported agents; explicit query scope, compact default text, client-controlled context budgets; CLI administration and foreground loopback web interface | [MCP contract](protocol/mcp-adapter-contract.md), [README](../README.md) |

`core:index_status` is a top-level status operation. Attempting to evaluate it
through the subject-producing query engine is rejected with
`core:non_subject_operation`; use `urdira_index_status` instead. Semantic
coverage and affected-page results are structured views, with their own
set-identity rules, not arbitrary entity selections.

## Defaults that affect interpretation

- **Residual checking is off by default.** `URDIRA_V4_RESIDUAL=1` enables it.
  The pass budget defaults to 120,000 ms for cold work and 20,000 ms for
  incremental work; `URDIRA_V4_RESIDUAL_BUDGET_MS=0` removes that budget.
  A budgeted pass can publish partial progress and resume remaining roots;
  it is not a guarantee of complete TypeScript parity or a hard process deadline.
- **Reconcile threshold is 0.01.** `URDIRA_V4_RECONCILE_THRESHOLD` overrides
  the measured policy; explicit `urdira reindex` forces a full scan.
  Reconciliation still walks the workspace even when it proves a no-op.
- **Semantic workers are child processes.** The default shard count is
  `min(2, max(1, floor(cpuCount / 4)))`; `URDIRA_SEMANTIC_WORKERS` remains
  subject to the same CPU-derived cap. Benchmarks using three shards through
  a raw daemon harness do not establish the default CLI configuration's latency.
- **The local provider is the default.** `Xenova/all-MiniLM-L6-v2` assets are
  acquired only during explicit configuration and then used offline. An
  explicitly configured HTTP provider sends document segments and query text
  to the endpoint; endpoint/model/dimensions are selected at daemon startup.
- **macOS watchers have a file-descriptor budget.** Automatic selection uses
  kqueue for small workspaces and fs-events above 2,000 files; an explicit
  backend override can change that selection.
- **Ordinary compact snippets default to zero.** The MCP `snippet_lines`
  rendering option is opt-in (0–3). `urdira_context` separately defaults to a
  6,000-character per-snippet projection, 30,000 source characters, 20 context
  lines, a 40,000-character response page and the public 50-item response
  default. Every value is a replaceable client option; logical membership is
  not truncated to satisfy those hydration and page choices.

## Retained performance evidence

These are separate historical experiments on an Apple-silicon development
host, not a fresh benchmark of the reviewed commit. Corpus inclusion,
record counts, provider configuration and measurement boundaries differ;
do not combine them into a single SLA or an unqualified v3/v4 speedup.

| Measurement | Retained result | Boundary / qualification | Evidence |
|---|---|---|---|
| n8n cold, 3 runs | median worker `total_ms` **23.369 s**; wall **25.22 s**; reported median peak RSS **6.11 GiB** | 2,197,882 records; shared-host load above the preferred gate was retained and disclosed; worker timing is not daemon readiness | [F.3](evidence/2026-09-07-v4-f3-cold-incremental-floors-parity-threshold.md) |
| VS Code cold, 3 runs | median worker **27.588 s**; wall **29.96 s** | 4,475,240 records; per-run peak RSS 13.84, 14.18, 14.12 GiB (arithmetic median **14.12 GiB**; the original summary labels 14.18 as median) | [VS Code campaign §1](evidence/2026-09-07-v4-vscode-campaign.md) |
| Worker increments | sub-second results for edit/create/delete/rename in the documented worker campaign | Does not establish sub-second end-to-end durable publication; daemon-observed tails remain separate | [final worker/daemon measurements](evidence/2026-09-05-v4-final-measurements.md) |
| VS Code references | about **160 s → 0.4 s** | Pipeline seed binding fix; indexed query measurement, not every operation or cold start | [Q-1](evidence/2026-09-08-v4-vscode-query-latency.md) |
| Impact / identity queries | about **2.5–3.7 s → 0.2 s** | Indexed identity lookup; full n8n and VS Code samples in report | [Q-4](evidence/2026-09-08-v4-identity-lookup-and-compare.md) |
| Full n8n semantic materialization | about **35–37 minutes** | Local ONNX embedding from zero; structural readiness is earlier; corpus and shard settings are report-specific | [S-H](evidence/2026-09-08-v4-semantic-sweep-and-full-scale-latency.md), [S-I](evidence/2026-09-08-v4-semantic-native-scan-latency.md) |
| n8n semantic / hybrid queries | p99 **134.99 / 178.33 ms**, from **1,722.2 / 2,192.7 ms** | Warm, fully embedded corpus; 20 requests per operation after warm-up; no path filter/snippets; explicit 3-shard harness; historical baseline reused | [S-I](evidence/2026-09-08-v4-semantic-native-scan-latency.md) |
| VS Code pack | **25.459 s** import-plus-no-op-reconcile; **1.57 GB** compressed pack | Transfer at 50 MB/s adds ~31.42 s; fails the half-cold-time distribution gate | [Decision 30](decisions/30-index-pack-distribution.md) |

### Current directed agent-context evidence

The latest accepted Urdira-only samples use frozen tasks, `gpt-5.6-luna`,
structural readiness and fully disabled semantic indexing. A served prompt or
pre-tool hook counts as Urdira use. Competitor values are retained medians from
the frozen comparison campaign and were not rerun.

| Repository | Accepted Urdira sample | Correctness | Structural readiness | Comparable tokens | Retained baseline | Reduction |
|---|---:|---|---:|---:|---:|---:|
| Playwright | v72 | strict grader; independent focused validation 2/2 | **4.917 s** | **569,904** | 628,159 | **9.3%** |
| Prisma | v69 | strict grader; 260 independent tests and typecheck | **7.424 s** | **666,427** | 882,221 | **24.5%** |
| VS Code | v86 | strict grader and independent validation; frozen Luna task, structural-only readiness and semantic off | **29,536 ms (29.536 s)** | **970,632** | 1,193,155 | **18.7%** |

Playwright v72 and Prisma v69 are accepted samples from the same context-density
campaign. VS Code v86 is the accepted post-repair provider sample after the
earlier v70 integration failure; it uses the task-matched provider baseline
median of 1,193,155 comparable tokens. V86 is one directed observation, not a
statistical ranking across repositories. See the [v69/v70 record](evidence/2026-09-13-current-urdira-context-density-benchmark.md#current-prisma-v69-and-vs-code-v70-samples),
[v71/v72 record](evidence/2026-09-14-agent-context-density.md), and
[V86 evidence](evidence/2026-09-14-prompt-hook-context-reuse.md).

The August agent-comparison reports remain useful historical evidence but
predate v4 and its September query fixes. The September 8 snippet experiment
retained the ordinary compact-renderer default of no inline snippets; see
[snippet evidence](evidence/2026-09-08-agent-benchmark-inline-snippets.md).

## Limitations and open work

- The bundled structural analyzer is JavaScript/TypeScript. The public model
  remains language-neutral; this is not a claim of production support for
  other languages.
- The retained cold targets (`Queryable` ≤8 s, `ScanCompleted` ≤12 s) and
  ≤3 GiB memory target remain unmet. Worker timing improvements do not close
  the daemon durable-tail finding or provide cross-platform release qualification.
- The final September 9 comparison reports zero different call/reference
  targets on the unreduced n8n comparison, with `confirmed_combined=161,802`.
  The reduced VS Code comparison retains **80 reference / 23 call** target
  differences. This is scoped target agreement, not full compiler coverage;
  external library targets, unresolved sites and checker limitations remain.
  See [the evolving parity evidence](evidence/2026-09-07-v4-vscode-campaign.md).
- The 13,737 `rpc_error` parity-scoped sites and 105,635 raw sites describe
  an older residual census, not a refreshed current count. Historical
  anomalies without a new reproduction are not automatically current defects.
- Compaction has a merge/publish/refcount mechanism, but automated thresholds
  and identity-chain retention stubs remain follow-up work. Structural
  verification does not substitute for source-to-record semantic parity or
  certify identity text solely from unchanged digest leaves.
- v4 structural digests exclude asynchronous vectors; semantic coverage and
  provider identity require separate validation. `metric` has no producer
  and uses the empty-set root. The manifest carries records/dependency roots;
  graph/metric roots also live in tree files and catalog rows.
- Page fitting measures the rendered MCP envelope and may expose a smaller
  prefix of the same immutable execution. An individually oversized source
  projection still fails explicitly with its required minimum and a valid
  recovery path; it is never omitted and reported as complete.
- The accepted Playwright, Prisma, and VS Code context-density rows are one
  sample per task. VS Code v86 is the post-repair provider observation; its
  task-matched token comparison is directional evidence, not a statistical
  claim about all workspaces.
- The v4 raw structural-addon loader and unremeasured fork-envelope checks
  remain documented integration/verification limitations. Explicit pack
  import/export is wired; automatic v4 donor-fork selection is a separate path.
- v3 remains compiled and served. Removing it or changing existing workspace
  format requires a separate compatibility change. Package versions and
  release qualification must be resolved before publishing the v4 changes.

## Review coverage

The [documentation reconciliation record](evidence/2026-09-09-documentation-reconciliation.md)
lists the source/contract conflicts corrected in this refresh and its actual
verification results. Historical reports retain the facts they measured;
current guides link to later evidence instead of silently rewriting history.
