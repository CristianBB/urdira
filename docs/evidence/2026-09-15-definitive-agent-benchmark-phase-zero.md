# Definitive agent benchmark Phase 0 evidence

Date: 2026-09-15. This note records the offline and release-binding work
completed before the definitive three-campaign measurement. It does not claim
that the 45 agent cells or 18 readiness probes were executed.

## Frozen protocol

- Repository commit at the first check: 65996d9b7ba617221040f286e693953c77bd0c1a; the initial short status was empty.
- Model: gpt-5.6-luna; Node: v24.18.1; semantic indexing: disabled.
- Scope: playwright/affected-tests-deterministic, prisma/wire-name-validation,
  and vscode/language-provider-registration-idempotence; five arms and 15
  entries per campaign, three sequential campaigns (45 cells total).
- Readiness: cold and warm Urdira probes for each selected repository per
  campaign (18 total), retaining the same pair checkout and data root for the
  warm restart. A cold failure blocks the warm row without retry.
- Failure policy: retain the complete failed cell, run unconditional cleanup,
  and continue only after a clean checkpoint; cleanup residue, owned
  processes, invalid manifests, or insufficient free space block the next
  entry.

## Offline replay and normalization

Replay ran before any model invocation. The first retained attempt is
/Users/Cristian/BenchmarkResults/urdira-context-replay-20260915-offline.json.
The corrected replay is
/Users/Cristian/BenchmarkResults/urdira-context-replay-20260915-offline-v2.json:
47 raw transcript rows, including the real interrupted transcript, with bare
hook-audit.jsonl excluded as an audit sidecar. Its exact SHA-256 is
1b1e5abc254d88582cd9e2df852d8158a309e94aec74c74ddb57f382572383bb.

The association manifest is
/Users/Cristian/BenchmarkResults/urdira-context-raw-association-20260915.json
with SHA-256
f71e27fb7c7665efc780f5a11b2a70faadc2d7e26706570ac13a9e5d33661e13.
Normalized output is
/Users/Cristian/BenchmarkResults/urdira-context-normalized-20260915-v2/manifest.tsv
with SHA-256
2053a46edd1fa0992a36d426088221ffe5a4d5f140fb470c751fb6c3049187c1.
Historical token totals remain diagnostic until provider counter semantics and
the common input/output/reasoning/cached-input policy are closed by the metrics
owner; unavailable values remain null.

## Release binding and installed smoke

The preliminary archive was
release/artifacts/urdira-darwin-arm64-0.3.3.tar.gz, 183,781,585 bytes, with
SHA-256
a16d2caf830ba753d3eb4207f5b72b994bd99bc5906f7d0e28ee0b5d9765af3b.
The binding record, including the extracted-root verification, worker
execution, and scoped structural query, is
/Users/Cristian/BenchmarkResults/urdira-release-binding-20260915.json.
The exact component digests recorded in the binding evidence and this note are:

| Component | SHA-256 |
|---|---|
| CLI and app | 9c965219f42d50312f56bd99a600c848467effd059607c11eafd30c9c59c1c80 |
| MCP | 1f8ac69ec0954f5e92f6ebdbebc33bba87145c990a3659dcd04a16cb67c5acf6 |
| Plugin | 6fa58ea6994946ac2081d38fda222b1d76bc3085391e323a64de60cbe1224194 |
| Hooks | 13bbba397546be76ff8385879997fa1169d121b9d506af92a0e29d190d8ba0a1 |
| Native addon | b1d845972b40d5270b97e719b1f03d0afd4e94c278556a3f223530e62b5f72eb |
| Indexing worker | 1a77ddd4be6b202fc6d1f97faa43c27652aff0636a9755c454c9330cb5070375 |
| Syntax worker | 7607a1c39fe898481f5dd5f4bbde87ddb0b997fa8902b941aef5b359595637f1 |
| Native manifest | e3a3be512aa6219e097cd325046124742a4e64f95ce621ff7d1bc3a6630efb8d |
| Launcher binary | 5d82f2ee8f199c8eacc46863b93d2c2c13757f592b60febff27ecc58799720 |
| Launcher | bc888015b70484adf913268248c6d63e874fc3e77e2504279bfd02e65ce5fa5a |
| Release manifest | c255cd1b2e50c04f8fcb084429ad0d96d5cc6f0ce68089626fa61de8a18630f7 |
| Checksums | 87cedae470fea2525d9e9bbe0cdfc974a6d4798cb141f9bb353d552f9e7ee76f |

The first installed CLI attempt exposed a native optional-dependency failure;
the runner now binds URDIRA_NATIVE_ROOT to the verified archive closure and
fails closed on archive/extracted-byte mismatch, missing components, tampering,
or path escape. After all workers' changes were integrated,
`CI=true pnpm verify`, `URDIRA_RELEASE_TARGET=darwin-arm64 pnpm package:release`,
and `URDIRA_RELEASE_TARGET=darwin-arm64 pnpm release:acceptance` all passed.
The final archive is `release/artifacts/urdira-darwin-arm64-0.3.3.tar.gz`,
183,782,805 bytes, SHA-256
`7698189127b606062579471c7adb25f9c5878141fe6bc0a80b8757e92eb33d9a`.
It was extracted to
`/Users/Cristian/BenchmarkResults/urdira-release-extract-20260915-final-fsctFC`
and bound byte-for-byte by
`/Users/Cristian/BenchmarkResults/urdira-final-release-binding-20260915.json`.
That extraction root was later removed after its component hashes were retained
in the final cleanup manifest; the immutable archive and binding record remain.
The final installed archive smoke passed, including the actual indexing worker;
the log is
`/Users/Cristian/BenchmarkResults/urdira-final-native-archive-smoke-20260915.stdout.log`.
The no-model installed worker and scoped `core:search_text` query passed with
`URDIRA_SEMANTIC_INDEX=0`; stdout/stderr are retained under
`/Users/Cristian/BenchmarkResults/urdira-final-installed-scoped-query-20260915-v3.*`.

## Regression evidence

Implemented and tested: immutable release binding, per-cell cleanup manifests
with bytes and raw df, `BENCH_MIN_FREE_BYTES=53687091200`, process ownership metadata,
timeout and signal cancellation paths, immutable frozen task/prompt checks,
direct 15-entry orchestration, and the real no-model cold/warm readiness
executor against an extracted archive. The runner records the bounded
supervisor timeout, retains raw Codex host sessions for each arm in the run
output, and derives counter semantics only from matching labeled host fields.
The ownership regression discovered during the first retained preflight attempt
now uses the effective user observed in `ps` and excludes the inventory probe
itself; the focused regression suite is 20/20. Focused validation completed with:

    CI=true pnpm exec vitest run tests/benchmark-cleanup.test.ts tests/benchmark-release-binding.test.ts tests/definitive-agent-campaign.test.ts tests/replay-agent-context.test.ts tests/benchmark-token-evidence.test.ts tests/benchmark-process-tree.test.ts tests/expanded-benchmark-smoke.test.ts tests/expanded-agent-report.test.ts tests/expanded-agent-timing.test.ts tests/expanded-agent-transcript-metrics.test.ts
    11 benchmark files, 2544 tests passed in the complete gate
    node --check <owned benchmark modules>
    git diff --check
    CI=true pnpm exec eslint <owned benchmark modules and tests>

The complete gate passed with 166 test files, 2,544 tests passed, 17 skipped,
and repository line coverage 90.13% (31,570/35,024). Its retained logs are
`/Users/Cristian/BenchmarkResults/urdira-phase0-verify-20260915-v3.stdout.log`
and `.stderr.log`; package and acceptance logs are retained under
`/Users/Cristian/BenchmarkResults/urdira-phase0-package-release-20260915.*`
and `/Users/Cristian/BenchmarkResults/urdira-phase0-release-acceptance-20260915.*`.
The comparator preflight is now closed from the historical frozen manifests.
The immutable record is
`/Users/Cristian/BenchmarkResults/urdira-comparator-preflight-20260915.json`:
codebase-memory-mcp v0.9.0 is at
`/Users/Cristian/.local/bin/codebase-memory-mcp` (SHA-256
`f3daacd56baa05ea43d965c14d1d34459390315faf91d1aa4fd92dea4144a79b`),
CodeGraph v1.6.0 is at
`/Users/Cristian/BenchmarkTools/codegraph-2026-09-09/node_modules/@colbymchenry/codegraph/npm-shim.js`
(SHA-256
`80419260f06862d7a422d13ef69e3b24c7a21dbef4309bce41db02ad642b1877`), and
tgrep v1.0.5 was rebuilt from commit
`d55b022023518646c90742f4761488dc95633b73` at
`/Users/Cristian/BenchmarkTools/tgrep-2026-09-10/target/release/tgrep`
(SHA-256
`231b4d1c835df8d257f36af400a466617c3b6bd6b42e34fa0a244e779aa235d9`).
The version probe logs are
`/Users/Cristian/BenchmarkResults/urdira-comparator-version-probe-20260915.*`
(SHA-256 `9996716d8bed8cc8d6853e78d639b0df60e90330b0d563532933a7e15a29715f`
for stdout; stderr is the empty-file digest); the immutable comparator manifest
SHA-256 is `9809de01b14fbdc6bff37c7dc247fccc801bf89db9f6c05df6d661d2379c4098`.
The historical Codex executable digest was
`a30ec314bbd0e3721632234d07db7c99855db3b9f1e32dbe8c791947f07e7629`; the
current pinned host executable was probed separately as v0.154.0-alpha.6.2 with
SHA-256 `ecad78dbf98adb89ec475edac86630406cbe59d9f3070b17d88065f136b94bcb`,
so the drift is retained rather than silently relabeled. No credentials or model
task was started. The frozen repository roots were prepared after the Phase 0 gates at
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/repos/{playwright,prisma,vscode}`
with the exact handoff commits and clean status, then removed after their commit
and tree hashes were recorded. Two campaign-1 preflight
attempts were then retained under `campaign-1-preflight-failure/` and
`campaign-1/`; both stopped before `prepareArm`/Codex because the source
checkouts had 110 missing dependency links. Their ledger is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/preflight-attempt-ledger.json`
(SHA-256
`210a98e91cd89d0a57936cc6f11eb5302d2a9576668efc7085928ea7f7c6ae36`). No
model or readiness probe was invoked. The post-attempt cleanup checkpoint is
`/Users/Cristian/BenchmarkResults/urdira-phase0-cleanup-checkpoint-20260915-luna-campaign-blocked-v4.json`
(SHA-256
`76071b8c60e948c1c850300bcb95448cd12fb41b68934808d66a688e23eb0189`), with
free space `366805753856` bytes and zero owned processes/residues.

## Offline dependency and freeze proposal

The three exact definitive tasks were prepared from their frozen lockfiles with
`ignore-scripts` and the pinned Node `v24.18.1`; no runner, Codex process, or
model was started. Direct `inspectAgentValidationEnvironment` checks now pass
for Playwright `affected-tests-deterministic`, Prisma `wire-name-validation`,
and VS Code `language-provider-registration-idempotence` with zero missing
dependencies or runtime artifacts. The validation record is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/dependency-validation.json`
(SHA-256
`00556af674546a088d5aa8ac0a169e4187725527b806376b02504b55a2bb72cd`).
The initial ambient npm/Node mismatch diagnostics remain retained in that
record; successful installs used the exact Node bin directory.

The superseding unexecuted 45-run/18-probe proposal is retained at
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v3/series-freeze-proposal.json`
(SHA-256
`0f0b027032b07123f5b8b4fa0eaf01ab1cf667b81a57889d87cc15e92f197455`). The
prior v2 proposal remains retained and is explicitly superseded. v3 contains
three 15-cell manifests and three six-probe manifests, rotated arm orders,
exact roots/commits/model/Node/release/comparator/dependency hashes, current
harness source hashes after the ownership correction, and excludes the two
invalid preflight attempts. The post-preparation cleanup checkpoint is
`/Users/Cristian/BenchmarkResults/urdira-phase0-cleanup-checkpoint-20260915-luna-dependency-prep-v4.json`
(SHA-256
`e4595355b650ba00806b8175f97a7522fdac016dbbca2b74625c008a4930bf55`), with
free space `364123762688` bytes and zero owned processes/residues. The shared process-inventory regression is validated by 21 focused tests; the
runner termination branch now filters to owner and ancestry verified processes,
while readiness uses the same helper and retains unknown entries as blockers.
ESLint, `git diff --check`, and `CI=true pnpm typecheck` pass. The full release
gates must be rerun after independent review of this correction.
The latest cleanup checkpoint after comparator preparation is
`/Users/Cristian/BenchmarkResults/urdira-phase0-cleanup-checkpoint-20260915-luna-final-v2.json`;
it records the 50 GiB guard, registered comparator and release roots, retained
artifacts, raw `df` evidence, process inventory, and zero residues. Free space
was `367666434048` bytes and the checkpoint SHA-256 is
`82620892fcd6d2056c56ce00bfacf488c4e24aa6027562595009e32eafedccf2`; the
previous qualifying checkpoint remains
`/Users/Cristian/BenchmarkResults/urdira-context-cleanup-checkpoint-20260915-luna-v6-qualifying.json`
with SHA-256
`73f562635e3c3bef2be1c38dfc019248e694b2c8bd9e2e2f07b17b37976a057a`. The
final binding record SHA-256 is
`525d2e8041a106def2a28c65ebb17c70221ad4782b4b3ee74c35e9cc6db44afe`.
Gate log digests are: verify stdout
`0b84c43a12a0b3b6c23f8ceaf570f6a3ca5f4027d28bb77efec37b9473839967`, verify
stderr `5b60927717f3159d276f5e0116ef3c19e2fd03472ae0a0b7ddd0b47129bcbfea`,
package stdout `4c0955f92e68fee834a5c61514bddfa2598ba41c08e3fab31d3d5d974da2b4f2`,
package stderr `ea66be16e7e8d99813ccbe29de831ed1a434fa5ed0fe84885d5972795dd56d36`,
acceptance stdout `0f1b88ae796ac69af842a57d6a5f4071326dd7d76d40d03f863f69d8fca3c874`,
and acceptance stderr `62ebcde7919e6bb90c422dad33e37186b824101f687188029ab75bc90f42580e`.

The consolidated renderer input is deliberately a later immutable step:
assemble-definitive-agent-audit.mjs accepts exactly the three per-campaign
selected-15 audits and three selected-6 readiness manifests, then emits
selected-45 with expected_runs 45 and readiness_expected_probes 18. No
historical audit is accepted by that assembler.

## Post-review worktree preparation

The first dependency validation only inspected the prepared source clones. A
fresh `git worktree add` does not carry ignored `node_modules`, so that record
was insufficient for a cell preflight. The orchestrator now calls
`materializeAgentDependencyClosure` immediately after each worktree is created
and before the cell runner or readiness daemon. The helper installs the frozen
lock roots in the fresh worktree, validates the exact task paths there, records
manager versions, lockfile bytes and SHA-256 digests, dependency-link
realpaths, cache/store paths and bytes, setup time, and a closure digest. The
same preparation and validation path is used for readiness pairs.

Package caches, the pnpm store, and Corepack state are scoped under each
worktree's `.bench-cache` directory. Prisma uses `pnpm@10.27.0` with
`--frozen-lockfile`; npm uses its observed runtime version with `npm ci` and no
offline restriction. Worktree cleanup removes those roots, and no source
checkout or global cache is modified. A setup failure is retained before any
runner invocation with `model_invoked: false`; readiness retains both cold and
warm rows, with the warm row blocked and all measurements null.

The initial isolated-cache validation intentionally retained its Prisma
offline failure at
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/dependency-worktree-validation-v3.json`
(SHA-256
`f134f45df6e912541535d869fa560bff946f8ac2eb23f625acc2edfc5ed5ceeb`). The
corrected direct validation of all three fresh worktrees passed with zero
missing dependencies or runtime artifacts:
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/dependency-worktree-validation-v4.json`
(SHA-256
`7e1ec668265773ca0142fe0b9965326150e448148deb6fc7bcba5628e6882148`). All
three detached worktrees were removed after validation, and the source clones
remain clean. The post-preparation cleanup checkpoint is
`/Users/Cristian/BenchmarkResults/urdira-phase0-cleanup-checkpoint-20260915-luna-post-dependency-v6.json`
(SHA-256
`42e3552962d9a4b474ca36ec91c5015c8c088a3954678599b538f91d751b0324`), with
50 GiB minimum-free-space guard, `364106903552` free bytes, no owned
processes, and no registered residue. The first checkpoint attempt found only
two empty validation-worktree directories and is retained as a blocked
diagnostic; it did not find a process or data residue.

The post-review regression suite is 28 tests passed across the dependency and
definitive orchestrator tests. `CI=true pnpm typecheck`, focused ESLint,
`node --check` for the operational modules, and `git diff --check` pass. The
45 cells and 18 readiness probes remain unexecuted pending user approval of a
new measurement series.

## Final Phase 0 gates and frozen proposal v5

After the worktree and cache correction, the complete gates passed sequentially:

| Gate | Result | Evidence |
|---|---|---|
| `CI=true pnpm verify` | exit 0 | `/Users/Cristian/BenchmarkResults/urdira-gates-20260915-v5/verify.stdout.log` SHA-256 `f2e63b2cc59b9091fcdbb1bce16f38ce9e43628c520fcc65d26ba0c03184f825`; stderr SHA-256 `9cb9e890d4e3f6edc59545a44ec14db27393bb6055b2ff6670f03efab9078858` |
| `URDIRA_RELEASE_TARGET=darwin-arm64 pnpm package:release` | exit 0 | stdout SHA-256 `c0d808b5186afba26c534930b16c09867816015fce269aa55c093e7da4c1fed6` |
| `URDIRA_RELEASE_TARGET=darwin-arm64 pnpm release:acceptance` | exit 0 | stdout SHA-256 `52ac9c4bbb80db623093991ccc82a1b9868cb749709315ae7830f0ea8744bc29`; stderr SHA-256 `62ebcde7919e6bb90c422dad33e37186b824101f687188029ab75bc90f42580e` |
| `git diff --check` | exit 0 | empty stdout/stderr, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

The archive generated by the package gate is 183,783,464 bytes. It is retained
at `/Users/Cristian/BenchmarkResults/urdira-final-release-archive-20260915-v5.tar.gz`
with SHA-256
`157a9e293a895cf35460d9628f8dca8cbd1e238a59d2625f7f2e685f2df31a2d`; the
extracted root is
`/Users/Cristian/BenchmarkResults/urdira-release-extract-20260915-v5-sqwUSo`.
The immutable binding against that archive is
`/Users/Cristian/BenchmarkResults/urdira-final-release-binding-20260915-v6.json`
with SHA-256
`352e9d7d49760178864ce64c015918e5d80861d167ab0c7b0e92bc30b691b6fc`.
It validates the archive bytes against CLI, MCP, app, plugin, hooks, addon,
indexing worker, syntax worker, native manifest, launcher, release manifest,
and checksums.

With `URDIRA_NATIVE_REQUIRED=1`, `URDIRA_NATIVE_ROOT` bound to that extraction,
and `URDIRA_SEMANTIC_INDEX=0`, an installed smoke registered a temporary
workspace, reached `structural_ready` with complete/current structural data,
and returned one complete scoped `core:search_text` match. The smoke retained
`model_invoked: false` and its evidence is
`/Users/Cristian/BenchmarkResults/urdira-final-installed-scoped-query-20260915-v6.json`
with SHA-256
`f8b78299bf338f1b43827a1adcf7d32cd821d7ba0cd29b110fb8cc8a13e8026d`. The
temporary workspace/data root was removed by the passing cleanup checkpoint
`/Users/Cristian/BenchmarkResults/urdira-phase0-cleanup-checkpoint-20260915-luna-post-release-v7.json`
with SHA-256
`93525acf8a1a46e3b84a7bf069cd0484d9163105bd270764f2c2574e4589224d`; it
recorded 143,869,771 bytes before cleanup, zero owned processes/residue, raw
`df`, and 363,173,650,432 free bytes against the 53,687,091,200-byte guard.

The immutable, unexecuted proposal superseding v4 is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/series-freeze-proposal.json`
with SHA-256
`9328d888cc30f11799faa305ed33db965e44d882780eb049626f6df9ba47a89e`.
Its automatic reference verification is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/proposal-reference-verification.json`
with SHA-256
`30458467475c0ba85f4b9a75b307acb0ded0824fe366d4ccb204d8ff98b470bf`:
71 external references were recomputed and matched, including six campaign
manifests, release components, the two retained preflight attempts, dependency
validation v4, offline replay artifacts, and cleanup evidence. The proposal
declares `model_invoked: false`, `executed_campaigns: 0`, and
`executed_readiness_probes: 0`; the 45/18 series still requires user approval.

## Campaign-1 stop and retention correction

The user subsequently authorized the new v5 series. Campaign 1 started exactly
two cells and then stopped without retrying or starting another cell. The
baseline row is a retained model/grader failure with `model_invoked: true`,
`exit_code: 2`, `grader_exit_code: 1`, an empty transcript, zero turns/calls,
and no host token evidence. The retained flag records Codex process
invocation; it does not prove that a model request or inference occurred.

The Urdira row returned exit 1 with `model_invoked: null`: its dependency setup
and cleanup passed, a timing sidecar exists with zero turns/calls, but no runner
manifest or preflight-failure artifact exists. Its original child stdout/stderr
are unavailable because the orchestrator kept them only in memory and persisted
only code/signal. The exact failure is therefore unknown and is not inferred as
`model_invoked: false`. The audit, stop ledger, recovered tool transcript, and
cleanup checkpoint are retained under
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/campaign-1/`;
the diagnostic SHA-256 is
`21234af91cf08b1685f7210e5432b6115abeafa0a654a8269ef954cd842fe3cf`.

The pinned Codex CLI is `0.154.0-alpha.6.2`. A help-only probe shows that
`codex exec -a never --help` exits 2 with `unexpected argument '-a' found`,
while the frozen runner passed `-a never` to both `exec` and `resume`. This is a
plausible explanation for the baseline exit 2, not a confirmed reconstruction
because the original stderr was lost. The diagnostic artifact is
`campaign-1-baseline-cli-diagnostic.json` (SHA-256
`15940cb795b80ccc65115f96d899cf199fee3046000695acd9c54b6d3ff7ed49`).

The orchestrator now durably spools child stdout/stderr from process start,
records paths, byte counts, SHA-256 digests, timeout state, and capture errors,
terminates the owned child if spooling fails, and blocks a zero-exit cell when
capture is incomplete. The runner also replaces the unsupported `-a never`
flag in both `exec` and `resume`, preserving the full-access/no-prompt intent
with the pinned CLI's supported switch and correct global/subcommand ordering.
The focused regression suite passes 24/24 and `pnpm typecheck` passes; the
final harness revision evidence is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/harness-revision-v8-diagnostic.json`
(SHA-256
`88dec5d383548ee11d435273cf9e64c42843d94baf0373bafd98f16c4e543783`). This
correction is a new harness revision and does not modify the v5
proposal/archive refs or authorize a retry. No further campaign cell, model,
or readiness probe was started.

## Post-gates owned-resource cleanup

The final cleanup manifest is
`/Users/Cristian/BenchmarkResults/urdira-phase0-cleanup-checkpoint-20260915-luna-post-gates-v10.json`
with SHA-256
`6be8cb16b6a5aa6459f99f5fbf81faecd25bbf9be2a74575c24542dad2883eec`. It records
the source commits and tree hashes before removing the three session-owned
repository clones, the dependency-validation roots, and both release extraction
roots. The source clone sizes before cleanup were 524,587,008 bytes (Playwright),
1,655,922,688 bytes (Prisma), and 2,896,642,048 bytes (VS Code). Each clone had
clean status and the frozen commits recorded in the manifest. The extraction
roots were each 585,097,216 bytes; the archive SHA-256 was
`157a9e293a895cf35460d9628f8dca8cbd1e238a59d2625f7f2e685f2df31a2d`, and the
component/checksum hashes remain in the v6 binding and v10 manifest.

After cleanup those candidate roots are absent with zero bytes. The retained raw
campaign roots are `campaign-1`, `campaign-1-preflight-failure`, `campaign-2`,
and `campaign-3`; no raw attempt directory was removed. The post-cleanup free
space is 367,785,205,760 bytes against the 53,687,091,200-byte guard, with no
owned processes or process residue. Global caches, pre-existing iteration roots,
the immutable archive, binding, gate logs, and raw diagnostics were preserved.
The v5 proposal now serves as historical provenance; any future series must
freshly provision its source roots from the recorded commits.
