# N.4: agent benchmark for inline snippets (R14)

Plan `generic-waddling-hartmanis.md` §0 (R13/R14) and §5.2. Repo
`~/Proyectos/urdira`, main `934b330` at task start (verify green; Frente N's
inline snippets already merged with `snippet_lines` default 1). Worked
directly on main, without worktree isolation, adding only benchmark evidence
and the R14-mandated code change. No `pnpm install` was run anywhere in this
session.

## Setup

All packages were rebuilt from `main@934b330` via the individual
`pnpm --filter <pkg> build` steps used by the `test` script (contracts,
canonical, security, storage, plugin-sdk, plugin-javascript-typescript,
engine, embedding-local, `tsc --build packages/daemon`, cli, mcp) plus
`tsc --build apps/urdira` (needed for `apps/urdira/dist/index.js`, which the
benchmark's MCP entrypoint imports directly). Every step returned `rc=0` and
several were TypeScript no-ops, confirming `apps/urdira/dist` and
`packages/mcp/dist` were already current for `934b330`.

Benchmark harness assets copied and adapted from
`~/Proyectos/urdira-benchmark/bench-2026-08-14-rerun/` (the arm6
"text+policy+pipelines" run) into a fresh directory,
`~/Proyectos/urdira-benchmark/bench-2026-09-08/`:

- `task.md` -- byte-identical to the rerun's task.md (the box-selection
  "center" mode task, 6 numbered requirements).
- `urdira-guide3-v2.md` -- byte-identical policy+guide prompt, with the
  workspace id substituted for this session's freshly registered workspace.
- `analyze-run.mjs`, `grade.sh`, `mcp-call.mjs` -- copied verbatim (paths
  inside `grade.sh` repointed at the new bench directory).
- `host.mjs`, `mcp-entry.mjs`, `mcp-urdira.json` -- same `runUrdiraMcp`
  entrypoint pattern as the original bench, pointed at
  `~/Proyectos/urdira/apps/urdira/dist/index.js` (current main) and a fresh
  `URDIRA_DATA_ROOT` under `~/Proyectos/urdira-benchmark/bench-2026-09-08/data`;
  `URDIRA_INDEXING_CORE_WORKER_PATH` set explicitly to
  `~/Proyectos/urdira/release/native/darwin-arm64/urdira-indexing-worker`
  (running the daemon straight from the repo's own `dist`, not an installed
  runtime, does not auto-resolve the packaged native worker path).
- Model: `~/.urdira/models/Xenova` copied into the fresh data root's
  `models/` before first use, so configure-time download never fires.

**Corpus**: the same excalidraw checkout as the runbook,
`~/Proyectos/urdira-benchmark/excalidraw` at `c5a50d2` (verified via
`git log -1`), used through a freshly created detached worktree of that same
commit dedicated to this session (outside the repo, not itself published;
the runbook's own convention of resetting one worktree between sequential
runs was followed, see "Traps" below).

**Daemon**: started against the fresh data root, workspace registered via
`workspace-add --dry-run --confirm --json`, reached `workspace_status:
"ready"` / `search_text_ready: true` well before either agent run (structural
scan ~1.2s on this small corpus; semantic embedding was still building at
run time, which is fine -- neither the historical arm6 run nor these two new
runs ever call `core:search_hybrid`/`core:search_semantic`, confirmed by
grepping their `--mcp` audits for those operation names, 0 hits in all
three).

**Trap found**: the guide's example call shape hardcodes
`"api_version":1`; the current schema requires `"api_version":3` (`packages/
mcp/src/index.ts`'s `queryRequestSchema` fixes it as `const: 3`). This is
purely a stale literal in an example string inside the copied guide text --
it did not affect either agent run (both runs' own tool calls used
`api_version: 3` correctly, presumably inferred from the tool's schema
`const` rather than the example text) but is worth fixing in the durable
guide asset if it is reused again.

## Runs

Two sequential runs of the arm, launched via `nohup`, foreground-polled with
`until ! kill -0 <pid>; do sleep 30; done` (repeated across multiple ≤9-minute
tool calls per the harness's per-call cap), never launched in parallel (the
memory's documented contamination trap for simultaneous runs). Between runs
the worktree was reset (`git checkout -- .` + `git clean -fd packages
excalidraw-app`) and a fresh `search_text` query confirmed `freshness_status:
"current"` before launching run 2 -- the same reset-then-verify regression
test the runbook calls out (the reset itself once triggered a publication
wedge in the pre-fix 2026-08-14 environment; no such wedge occurred here).

Exact invocation (both runs, `run-N.jsonl`/`run-N.err` differing only by N):

```
claude -p "$(cat task.md)" \
  --model sonnet \
  --output-format stream-json --verbose \
  --dangerously-skip-permissions \
  --mcp-config mcp-urdira.json \
  --strict-mcp-config \
  --setting-sources project \
  --disallowedTools "WebFetch" "WebSearch" \
  --max-budget-usd 15 \
  --append-system-prompt "$(cat urdira-guide3-v2.md)"
```

Grading: `grade.sh <worktree> <label>` (yarn test:typecheck +
`vitest run packages/excalidraw/tests/selection.test.tsx
packages/excalidraw/tests/lasso.test.tsx` against a patched copy of the
parent excalidraw checkout, then revert) plus the runbook's manual
requirement-4 check, `grep -c center packages/excalidraw/data/restore.ts`
in the patched tree.

### Run 1

- `rc=0`, wall 627s (~10.5 min).
- `typecheck_rc=0`, `tests_rc=0` (62 passed, 1 pre-existing skip).
- Diff touched: `packages/element/src/bounds.ts`,
  `packages/element/tests/bounds.test.ts`,
  `packages/excalidraw/components/main-menu/DefaultItems.tsx`,
  `packages/excalidraw/lasso/utils.ts`, `packages/excalidraw/locales/en.json`
  (only en.json, per requirement 5), `packages/excalidraw/tests/lasso.test.tsx`,
  `packages/excalidraw/tests/selection.test.tsx`, `packages/excalidraw/types.ts`.
- **`grep -c center packages/excalidraw/data/restore.ts` = 0** -- requirement
  4 (persistence/restore, "invalid values must still fall back to the
  existing default") was NOT implemented: `restoreAppState` still passes
  `boxSelectionMode` straight through with no allow-list, so an invalid
  stored value would not fall back to `"contain"`. Functionally the type
  extension still lets `"center"` round-trip correctly (the only case
  exercised by the test suite), but the defensive requirement text is
  unmet. This is the exact same gap the runbook says both original
  2026-08-14 urdira runs had, before the arm6 fix.
- `analyze-run.mjs`: 75 turns, `$2.6621`, 27 `urdira_query` calls (6 errors,
  122,781 result chars -> 4,547 chars/call), `urdira_index_status` 0 calls,
  32 `Read` calls (105,496 chars -> 3,297 chars/call), 13 `Edit`, 1 `Bash`.

### Run 2

- `rc=0`, wall 901s (~15 min).
- `typecheck_rc=0`, `tests_rc=0` (64 passed, 1 pre-existing skip).
- Diff touched the identical file set as run 1.
- **`grep -c center packages/excalidraw/data/restore.ts` = 0** -- same
  requirement-4 gap as run 1.
- `analyze-run.mjs`: 116 turns, `$4.1949`, 43 `urdira_query` calls (9 errors,
  117,411 result chars -> 2,731 chars/call), 1 `urdira_index_status` call,
  47 `Read` calls (138,782 chars -> 2,953 chars/call), 16 `Edit`, 6 `Bash`.

## Comparison against the historical arm6 baseline

**Discrepancy with the plan text, decided in implementation (§0, "decidido
en implementación", not returned as a question):** the plan (§5.2 and R14's
own wording) says to compare against "las 3 corridas existentes del brazo 6"
in `bench-2026-08-14-rerun/`. That directory (and every other benchmark
directory under `~/Proyectos/urdira-benchmark/`) was searched exhaustively
(`urdira-g6*`, cost/turn-count greps across all `.json`/`.log` files) and
contains exactly **one** run of arm6 (`urdira-g6-run.jsonl` /
`urdira-g6-grade.json`, `wall_s=531`), not three. This is consistent with the
2026-08-14 session memory, which records arm6 as a single completed run
after the pipeline/staleness fixes (`c06dc11`+`a5d9620`), not a repeated
measurement. It also predates the inline-snippets mechanism entirely (it
ran before Frente N existed), so it is exactly the "without snippets"
reference point R14 needs -- there is just one of it, not three. Used as
the sole historical baseline below; R14's arithmetic (`1.10 x mean(brazo
6)`) uses that single value as the mean.

| corrida | correctas | turnos | coste $ | Read calls | Read avg chars | urdira_query calls | urdira avg chars | total chars |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| brazo 6 (historical, no snippets, 1 run) | 5/6 (restore.ts OK; req 4 explicitly implemented via `ALLOWED_BOX_SELECTION_MODES`) -- all 6 reqs met | 90 | $6.1024 | 28 | 10,664 | 42 | 1,384 | 360,477 |
| N.4 run 1 (snippets ON, default `snippet_lines: 1`) | 5/6 (req 4 missed) | 75 | $2.6621 | 32 | 3,297 | 27 | 4,547 | 231,511 |
| N.4 run 2 (snippets ON, default `snippet_lines: 1`) | 5/6 (req 4 missed) | 116 | $4.1949 | 47 | 2,953 | 43 | 2,731 | 272,927 |

(brazo 6's own requirement tally corrected above: it satisfied all 6
requirements, including 4; both N.4 runs satisfied 5 of 6, missing only 4.
"correctas" in R14's sense means "all 6 requirements met" -- brazo 6 = yes,
both N.4 runs = no.)

## R14 verdict

R14: *"Se mantienen ON si 6/6 correctas en ambas Y coste <= 1,10 x media
brazo 6; si no, default `snippet_lines = 0` (opt-in) y se documenta."*

- **Cost gate**: `1.10 x $6.1024 = $6.7126`. Both new runs ($2.6621 and
  $4.1949) are comfortably under that ceiling. Cost gate PASSES.
- **Correctness gate**: neither run 1 nor run 2 hit 6/6 -- both missed task
  requirement 4 (the `restore.ts` allow-list), the exact same defensive gap
  the *original* pre-arm6 2026-08-14 runs had, before that specific fix was
  made. Correctness gate FAILS.

R14's condition is a conjunction (`Y`); the cost gate passing does not
offset the correctness gate failing. **Decision: `snippet_lines` defaults to
0 (opt-in).**

This is not attributed to the snippet mechanism causing worse code (nothing
in the mechanism touches file-editing behavior); it is simply that this
benchmark's agent, run twice on current infrastructure, reverted to the
same pattern the pre-fix historical runs had. R14 is written as an outcome
gate, not a causal diagnosis, and is applied exactly as written.

**Confound noted for the record**: the historical arm6 run predates this
session by nearly a month and was captured under whatever model snapshot
`--model sonnet` resolved to at the time; the two 2026-09-08 runs resolve
`--model sonnet` to Claude Sonnet 5 today (`model_usage` in both
`analyze-run.mjs` outputs). Turn count and per-call chars are still
comparable (they are governed by the harness/tool contract, not the model
snapshot), but the absolute cost gap between $6.10 (historical) and
$2.66-$4.19 (today) is not attributable to snippets alone -- pricing and
model behavior both shifted between the two measurements. This does not
change the R14 verdict, which turns on the correctness gate, not the cost
gap.

## Code change applied (R14 fallback)

- `packages/mcp/src/index.ts`: `DEFAULT_SNIPPET_LINES` changed from `1` to
  `0`; `snippetLinesFieldSchema`'s description, the `RenderQueryOptions`
  doc comment, `renderQueryPageText`'s doc comment, and
  `isCompactSnippetStyle`'s doc comment updated to describe the new
  opt-in default instead of the old default-on behavior. The rendering
  mechanism itself (SNIPPET_POLICY hydration, `formatDescriptorLine`'s
  compact-snippet branch, shedding order) is unchanged -- only the default
  value of the hidden `snippet_lines` option flipped.
- `tests/phase13-mcp.test.ts`: the four existing tests that exercised the
  compact-snippet mechanism via the *default* call shape (no explicit
  `snippet_lines`) now pass `snippet_lines: 1` explicitly, so they continue
  to test the mechanism itself rather than silently degrading into
  no-ops under the new default. Added one new test asserting the new
  default: an ordinary `urdira_query` call with no `snippet_lines` field
  renders no compact snippet line at all. `pnpm --filter @urdira/mcp build`
  and `vitest run tests/phase13-mcp.test.ts` both green (54/54) after the
  change.
- `docs/decisions/01-universal-data-model.md`: the 2026-09-06 Frente N
  amendment's "Acceptance (R14, pending)" bullet replaced with the decided
  outcome and a pointer to this evidence doc.

## Traps for a future rerun

- The bench directory's `mcp-urdira.json`/`host.mjs` need
  `URDIRA_INDEXING_CORE_WORKER_PATH` set explicitly when running the daemon
  straight out of the repo's own `apps/urdira/dist` (not an installed
  `@urdira/runtime`): the packaged-native-path auto-resolution only works
  for an installed runtime layout, and the daemon otherwise refuses to
  start production structural indexing with "the TypeScript structural
  writer is not a production fallback."
- The CLI's `query --payload` takes the bare `{api_version, scope,
  expression, options}` object, not the `{"request_type":"query","query":
  {...}}` envelope the MCP tool itself accepts -- useful for a quick smoke
  probe via the CLI instead of the MCP stdio round trip, but the two shapes
  are not interchangeable.
- `file` reported `tests/phase13-mcp.test.ts` as `data` (not ASCII text) to
  BSD `grep` on this machine, which silently returned zero matches for
  plain `grep -n` on that file even though the pattern was present; `grep
  -a` (or a small Python scan) is required for that file specifically.
- The E-P0n agent's own `vitest` worker process was running concurrently on
  this machine throughout both benchmark runs (a separate, unrelated task);
  this benchmark measures agent behavior and cost, not wall-clock latency,
  so the shared CPU load does not invalidate the turn/cost/correctness
  numbers above, only the absolute wall-clock durations.
