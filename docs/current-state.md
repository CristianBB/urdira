# Current implementation and evidence

Reviewed: 2026-09-15. This is an implementation inventory, not a new product
contract or a release certification. Follow the [product foundation](product-foundation.md)
for normative decisions and the [architecture map](architecture.md) for code paths.

## Definitive agent campaign status (2026-09-15)

The authorized v5 series is **blocked after two campaign-1 cell attempts**.
The baseline has a failed retained manifest with `model_invoked=true`, which
means the Codex process was launched but does not establish a successful model
interaction. Its transcript is empty; the timing sidecar exposes one observed
turn and zero MCP/command calls, while token, cost, correctness, coverage,
efficiency, and distribution measurements are `null`. The Urdira cell
returned exit 1 without a retained manifest, so `model_invoked=null` and its
status is `blocked`. Forty-three cells were not attempted. Of the 18 readiness
probes, six campaign-1 probes are blocked by the stop after the two cell
attempts, while the twelve campaign-2 and campaign-3 probes were not
attempted. The authoritative stop ledger is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/campaign-1/campaign-stop-ledger.json`
(`sha256=4226c3b53ece6137c8c32b3ba18b687d799aa39b1e955b48b019ea37e3db0e24`).

Earlier preflight diagnostics, separate from authorized v5, retain a path/hash
collision: the first audit's declared cell-manifest
hash is `d1d98ebb54361d95a876eefb55bc2f8f1650134c770951059f39807502870e13`,
but its path points at the current second-attempt manifest, whose hash is
`181ae2436700ea753588215d3be708c58ea903034d1c918c26f6810eeefa881c`.
The complete planned 45-cell and 18-probe matrix, with unavailable fields
represented as `null` and attempted observations called out separately, is in
the [dated benchmark report](benchmarks/definitive-agent-benchmark-results-2026-09-15.md).

The complete partial state table is
`/Users/Cristian/BenchmarkResults/urdira-renderer-analysis-revision-20260915/partial-plan-table-v2.json`
(`sha256=a9cd99468a8c078f4358a30182a1ab8eeeb584406faea4cd39ecfba77094f4a4`).
The report-only renderer revision is
`/Users/Cristian/BenchmarkResults/urdira-renderer-analysis-revision-20260915/analysis-revision-v3.json`
(`sha256=369f5bdd9c42bc7f9997c5d089f93d13778a48ee49463e5a27ba22dbc42441f7`).
Its partial JSON and Markdown renders have SHAs
`8bc8421d949d94084f08d4e6053ae0ebb7d566528a3e1039d980191d90cb5467` and
`92f93c6a48e653b0d3e8165338261813c57548621efe86a57e001664f6997873`;
both are diagnostic and fail the incomplete 15-cell/6-probe gate.

Preparation evidence is kept separate from those campaign attempts. The
retained v3 record
(`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/dependency-worktree-validation-v3.json`,
`sha256=f134f45df6e912541535d869fa560bff946f8ac2eb23f625acc2edfc5ed5ceeb`)
is a blocked offline install with `ERR_PNPM_NO_OFFLINE_TARBALL` for
`@biomejs/biome/-/biome-2.5.8.tgz`; it records no runner or model invocation.
The later v4 per-worktree validation
(`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/dependency-worktree-validation-v4.json`,
`sha256=7e1ec668265773ca0142fe0b9965326150e448148deb6fc7bcba5628e6882148`)
passed for exactly the three selected repositories: all were ready, no
dependency or runtime artifacts were missing, cleanup succeeded `3/3`, and no
global cache, runner, or model was used. Independent review found no blockers.
This preparation pass does not authorize a new series; the existing no-retry
stop and explicit-user-authorization gate remain in force.

The prepared v5 freeze proposal is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/series-freeze-proposal.json`
(`sha256=9328d888cc30f11799faa305ed33db965e44d882780eb049626f6df9ba47a89e`),
with reference-verification sidecar
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/proposal-reference-verification.json`
(`sha256=30458467475c0ba85f4b9a75b307acb0ded0824fe366d4ccb204d8ff98b470bf`).
The proposal carries 68 references; its verification sidecar checks 71
references including additional gate and retention references, six plan
manifests, 45 planned cells and 18
planned readiness probes, but `proposal-not-executed` and
`model_invoked=false`. The proposal binds release binding v6
(`/Users/Cristian/BenchmarkResults/urdira-final-release-binding-20260915-v6.json`,
`sha256=352e9d7d49760178864ce64c015918e5d80861d167ab0c7b0e92bc30b691b6fc`)
and cleanup checkpoint v7
(`/Users/Cristian/BenchmarkResults/urdira-phase0-cleanup-checkpoint-20260915-luna-post-release-v7.json`,
`sha256=93525acf8a1a46e3b84a7bf069cd0484d9163105bd270764f2c2574e4589224d`).
The current v8 verify, package, acceptance, and diff-check records all exit
`0`. Their retained records are under
`/Users/Cristian/BenchmarkResults/urdira-gates-20260915-v8/`:

| Gate | Exit SHA-256 | stdout log SHA-256 | stderr log SHA-256 |
|---|---|---|---|
| `pnpm verify` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `adcb5d4078644907dac388606828ad9c7af119a140fcd1c1569866c3cf38d96e` | `2293a8217f4f0912132672b3148c0b66a9c14efe7d15e9776a5235490a2ce430` |
| `pnpm package:release` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `07efd646a402b386c8b4b54d60a525bd665998e9f26074cb631009b52abaf5bc` | `ea66be16e7e8d99813ccbe29de831ed1a434fa5ed0fe84885d5972795dd56d36` |
| `pnpm release:acceptance` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `75e7679588e35d6848a279372662a6f1e0cb78e2aa4a4ea797a1b5eb928b1879` | `62ebcde7919e6bb90c422dad33e37186b824101f687188029ab75bc90f42580e` |
| `git diff --check` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

The earlier v7 `pnpm verify` record remains historical: it exited `1` because
`tests/expanded-benchmark-smoke.test.ts:181` expected an outdated runner
snippet; its exit SHA is
`4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865`.
The v8 gates validate repository and release artifacts only; they add no
measurements and do not lift the blocked 45-cell/18-probe campaign status.
The final cleanup checkpoint is
`/Users/Cristian/BenchmarkResults/urdira-phase0-cleanup-checkpoint-20260915-luna-post-gates-v10.json`
(`sha256=6be8cb16b6a5aa6459f99f5fbf81faecd25bbf9be2a74575c24542dad2883eec`):
free bytes were `367785205760` against the `53687091200` threshold, with zero
owned processes and zero residue; three source clones, their dependency roots,
and two extraction roots were deleted. Raw data, the archive, release-binding
metadata, and frozen harness metadata were retained. The v5 proposal and
preflight artifacts are historical evidence, not current readiness; a new
execution would require reprovisioning and a new freeze.

The separate historical offline appendix reprocessed 47 retained raw rows:
40 had matched host token evidence, 7 lacked host evidence, 34 were successful
historical outcomes, and 13 were failed or blocked. It is not campaign or
readiness evidence and is not combined with current-state capability claims.
The corrected v6 artifacts remain at
`/Users/Cristian/BenchmarkResults/urdira-definitive-offline-20260915-metrics-final-v6`.

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

The canonical status and reporting contract for the pending three-campaign
comparison is [the 2026-09-15 derived benchmark report](benchmarks/definitive-agent-benchmark-results-2026-09-15.md).
It does not replace the accepted directed observations above. The comparison
remains incomplete until original artifacts have been analyzed and rendered,
all rows are shown by repository/task/arm, unavailable fields are `null`, and
the final table is published to the user.

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
