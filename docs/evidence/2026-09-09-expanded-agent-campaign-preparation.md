# Expanded agent campaign preparation — 2026-09-09

Scope: document the four-arm agent comparison procedure; no campaign executed.

Update: the global smoke-scope limitation below was subsequently fixed; see
[scoped smoke evidence](2026-09-09-expanded-agent-smoke-scope.md). The next smoke
uses only the selected repositories (all eight tasks for the full corpus).

## Sources and findings

Read the README, documentation authority guide, product foundation, Decision 08,
release guide, architecture manifest, frozen expanded corpus, August 27 derived
reports, driver, cell runner, grader, renderer, and audit merger.

The [runbook](../benchmarks/expanded-agent-campaign.md) is the operational entry
point. It preserves the eight-task Urdira smoke, fresh worktrees/data roots,
three sequential instructions, and the distinction between 32 cells and the
planned 96 samples. The Urdira arm is now pipeline-first: a valid pipeline or
registered recipe with a data dependency is required before the first edit and
after every edit batch. urdira_context is supplementary and cannot satisfy
that gate.

Recorded discrepancies and limitations:

- August 27 reports claim fresh comparators and 32/32 grader passes; the older
  README/release narrative claims reused comparators and five failed rows.
  Historical provenance remains unresolved; no source data was rewritten.
- One driver error says six smoke runs; actual validation requires eight tasks.
- The driver continues after failed cells, lacks manual pause/resume, and removes
  worktrees before human diff review. Strict cell-by-cell supervision and patch
  retention need preparation before launch.
- Three samples do not establish independent campaigns; the reporting flag
  does not execute or verify multiple campaigns.
- The grader is a pattern/attribution check, not proof that repository tests pass.
- The frozen September smoke predates the pipeline-first grader contract. Its
  direct-operation-heavy transcripts are retained as historical evidence but
  are invalid for the next campaign's Urdira composition gate; they must not be
  silently relabeled or rerun.
- Runtime paths, agent CLI compatibility, v4 readiness, inherited settings,
  comparator binaries, repository dependencies, and v4 storage telemetry still
  require live preflight verification. This document is not launch clearance.

## Next campaign checklist

- [ ] Freeze build/corpus/tool versions, environment, rate card and output roots.
- [ ] Complete repository verification and confirm matching built/native artifacts.
- [ ] Verify frozen clones, fresh-worktree test dependencies and tool availability.
- [ ] Prepare strict per-cell review and diff retention if that workflow is required.
- [ ] Run and audit the selected-task Urdira smoke with the intended current build.
- [ ] Run a fresh four-arm campaign under the declared sample count.
- [ ] Audit transcripts, actual tests, all failures, metrics and cleanup.
- [ ] Publish sanitized reports with provenance and limitations.

Documentation verification:

- `pnpm check:publication`: passed, 1,061 files checked.
- `pnpm check:architecture`: passed, 16 workspace packages.
- `git diff --check`: passed.
- Full `pnpm verify` and release gates were not run during documentation-only
  preparation; they remain required before a qualified implementation handoff
  or campaign build acceptance.
No benchmark timing, correctness, or release-qualification result is claimed.
