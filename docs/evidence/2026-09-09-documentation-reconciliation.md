# Documentation reconciliation — 2026-09-09

Status: Complete; documentation review, not a new performance campaign.

## Scope and authority

Reviewed the 201 local commits after `origin/main`, ending at `2a3733c`,
against the current source, configuration, tests, and retained evidence.
The earlier metadata-only history rewrite preserved every commit tree and
merge parent relationship. Commit identifiers embedded in older evidence
refer to the pre-rewrite history; the [commit identifier map](2026-09-09-commit-metadata-map.json)
connects all 201 commits to their current identifiers, with tree equality
rechecked during this review. The measurements themselves were not rerun.

Decisions and their linked contracts remain normative. This review corrects
stale descriptions of already implemented behavior; it does not authorize a
new storage, query, semantic, or security design. Historical measurements are
kept as dated evidence rather than relabeled as current verification.

## Conflicts recorded before documentation changes

| Documents / claim | Current source or later approved contract | Resolution |
|---|---|---|
| README describes residual checking without its opt-in boundary | Decision 28; `v4/scan.rs` checks `URDIRA_V4_RESIDUAL`, default off | State the opt-in, budgets, continuation and remaining uncertainty. |
| Decisions 26/29 say v4 semantic maintenance is absent | Decision 16; `semantic-v4-wiring.ts`, runtime maintenance dispatch | Replace stale absence claims with the implemented native entity source and sidecar lifecycle. |
| Decision 26 says identity lookup scans and packs are unwired | Native query port and daemon import/export dispatch; Decisions 23/25 | Document indexed identities, bounded fallbacks, and wired explicit pack import/export. |
| Decisions 13/27 disagree on the v4 vector digest family | Decision 27 and `v4/publish.rs` / `v4-verify.ts`: dependency, graph, metric; async vectors separate | Make the v3/v4 scope explicit in both decisions. |
| Versioning and several guides say v3/v4 cannot share a data root or daemon | Runtime routes each workspace using its persisted format | Distinguish shared installation from incompatible per-workspace structural formats. |
| README conflates worker `total_ms`, wall time, and queryable latency | F.3 and VS Code measurement tables | Name the measured boundary and sample scope, and retain unmet gates. |
| Architecture diagram reverses embedding dependency and describes per-segment Merkle roots | Package manifests; Decision 27 | Correct dependency direction and generation-visible set roots. |
| Offline-only claims ignore the configured HTTP embedding provider | Decisions 16/18 and application provider selection | Scope offline operation to the local provider; document explicit HTTP document/query requests. |
| Decision 28/29 open lists include fixed aliases, pending importers, span, harness and pack work | Recent commits and focused regression tests | Separate completed work from unresolved or unremeasured historical findings. |
| Changelog stops at 0.3.3, security text at 0.1.x | Root/runtime manifests still 0.3.3; 201 later local commits | Add an Unreleased entry; do not invent a publication or release version. |

## Review coverage and changes

- Entry points: root README, documentation index, product foundation, current
  architecture, and the new implementation inventory.
- Contributor/release guidance: AGENTS, CONTRIBUTING, SECURITY, CHANGELOG,
  versioning, release process, and the native component inventory. All 15 Cargo
  workspace crates are represented, with their actual direct dependencies.
- Normative reconciliation: language/plugin scope; local versus HTTP embedding;
  v3/v4 digest boundaries; v4 storage, semantics, residual checking, publication,
  query selectors/paging and workspace administration. Existing closed schema
  values remain unchanged. Current decisions use English change-history headings.
- Evidence interpretation: separate worker, wall, daemon, embedding and query
  boundaries; retain unmet goals and scoped parity differences. Correct the
  current VS Code RSS median from the original per-run observations without
  altering the historical report. Mark identity-compression proportions as
  preceding full declaration spans rather than applying them to current output.
- Historical reports and published changelog entries retain their original
  observations. The commit map restores traceability after the metadata rewrite.
  Neither identical Git trees nor this review certify historical binary identity.

No runtime source, test, generated schema, package version or dependency was
changed. No new full-corpus indexing, embedding, or comparative agent benchmark
was run. Release packaging and acceptance are outside this documentation-only
refresh; the new Unreleased entry is not publication approval or qualification.

## Verification

- `CI=true pnpm verify` — **PASS**, exit 0. Completed architecture checks,
  native artifact builds, Rust formatting/clippy, workspace native tests,
  explicitly enabled tsgo residual suites, lint, TypeScript build and coverage
  tests, forced typecheck, coverage gate and publication hygiene.
- Vitest: **147 files / 2,269 tests passed**, 2 files / 15 tests skipped.
  The existing skip policy was unchanged.
- Coverage gate: repository lines **90.16%** (29,024/32,192, gate rounding),
  critical branches **100%** (15/15), semantic regions **100%**. The raw Vitest
  text reporter truncates the same line fraction to 90.15%.
- `pnpm check:architecture` — **PASS**, 16 TypeScript packages. A separate
  read-only comparison against Cargo manifests verified all **15 native
  components**, their direct production dependencies and acyclic layer order.
- `pnpm check:publication` — **PASS**, 1,059 files, including relative Markdown
  link targets and publication hygiene.
- A read-only heading-anchor check over **47 current-guide Markdown files**
  found **zero unresolved local heading links**.
- `git diff --check` — **PASS**.

Environment: Node.js 24.18.1, pnpm 11.20.0, Cargo 1.98.0 on macOS arm64.
These checks validate this documentation/inventory update and the existing
suite; they do not remeasure corpus performance, close the documented release
qualification gaps, or establish that skipped cases passed.
