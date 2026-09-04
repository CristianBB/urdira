# P4-d: user-facing status surfaces for the v4 readiness lane model

Implements task P4-d of the v4 plan: surfaces v4's lane model (structural
`queryable_generation`/`durable_generation`, lexical/semantic completed
generations, last-scan kind/paths/timings) through `core:index_status`,
`urdira_index_status` (MCP), `urdira index` (CLI), and the workspace
card in the web UI. Additive only, API version stays 3. Not committed, per
task instructions.

Machine: macOS arm64, Node 24.18.1.

## 1. What changed

### `packages/daemon/src/runtime.ts` (`core:index_status` payload shaping)

- `WorkspaceReadiness` gained a required `storage_format: "v3" | "v4"`,
  set once per branch: `"v4"` in `v4WorkspaceReadinessFrom`, `"v3"` in
  `workspaceReadiness`'s own v3 branch.
- A new module-level map `v4LastScanSummaries` records the last
  successfully completed v4 scan's `{ kind, changed_paths?, timings }`,
  populated in `runV4WorkspaceScan` right where `v4LastScanTimelines` is
  already updated (same success path; `scope` there is whichever request
  actually succeeded -- the original one, or the `Full` retry after a
  `Changed` rejection).
- A new pure function `v4StatusFields(readiness, semanticView,
  lastScanSummary, scanTimeline)` derives the additive top-level fields
  below from state that already exists (`WorkspaceReadiness`,
  `v4LastScanSummaries`, the existing `v4Timeline` lookup, and the
  workspace's `SemanticMaterializationStatusView` for `profile_id`) and is
  spread into `buildStatusView`'s return object, alongside the pre-existing
  `readinessPayload(readiness)` and `last_scan_timeline` fields (both kept
  unchanged for backward compatibility).

New fields on every workspace in `core:index_status`'s `workspaces[]`:

```
storage_format: "v3" | "v4"
structural: { queryable_generation?: number, durable_generation?: number, queryable: boolean }
lexical:    { completed_generation?: number, current: boolean }
semantic:   { completed_generation?: number, current: boolean, profile_id?: string }
last_scan?: { kind: "full" | "changed", changed_paths?: number, timings: ScanTimings, timeline?: Record<string, number> }  // v4 only
search_text_ready: boolean
search_semantic_ready: boolean
```

Derivation rules (see `v4StatusFields`'s doc comment for the full
reasoning):

- `structural.queryable` is `structural_queryable_generation !== undefined`
  for v4, or mirrors `structural_ready` for v3 (v3 has no separate
  queryable-vs-durable phase).
- `lexical.current` is `lexical_completed_generation >=
  structural_durable_generation` for v4 (both must be defined), or mirrors
  `structural_ready` for v3 (v3 never tracks a lexical completed
  generation at all).
- `semantic.current` mirrors `semantic_ready` for v3, and is always `false`
  for v4 (semantic maintenance is not wired for v4 yet -- accurate, not a
  placeholder).
- `search_text_ready = source_ready && lexical.current` -- `search_text`
  is source-frontier gated (always *available* once source is ready) but
  its results stay partial until the lexical sidecar catches up; this
  boolean folds that into one answer.
- `search_semantic_ready` mirrors `semantic_ready`/`semantic.current`
  exactly.
- `last_scan` is emitted only for a v4 workspace that has completed at
  least one scan; a v3 workspace never has it (no `ScanTimings` breakdown
  exists for a v3 scan).

### `packages/contracts/src/models.ts`

Added optional fields to `WorkspaceIndexStatusView` mirroring the wire
shape above (`storage_format`, `structural`, `lexical`, `semantic`,
`last_scan`, `search_text_ready`, `search_semantic_ready`), plus the small
supporting types `WorkspaceStructuralLaneView`, `WorkspaceLexicalLaneView`,
`WorkspaceSemanticLaneView`, `WorkspaceScanTimingsView`,
`WorkspaceLastScanView`. Purely additive/optional; API version is
unaffected (this repo's `WorkspaceIndexStatusView` is a hand-maintained
documentation type, not machine-checked field-for-field against the
runtime payload -- the pre-existing v4 fields from task P2-7
(`structural_queryable_generation` etc.) were never added there either, so
this follows the existing convention rather than inventing a new one).

### `packages/mcp/src/index.ts` (`urdira_index_status`)

`renderIndexStatusText` gained a v4-only block (gated on
`workspace["storage_format"] === "v4"`, so a v3 render is byte-for-byte
unchanged): one line per lane (structural/lexical/semantic) with
generation(s) and a "(lagging)" tag, a `last_scan` summary line
(kind/changed_paths/wall_ms), and a hint line whenever `search_text`/
`search_semantic` is not yet caught up. The tool description gained one
sentence about the v4 lane fields.

### `packages/cli/src/index.ts` (`urdira index`)

Previously `urdira index` (and every other read-only command) printed raw
JSON regardless of `--json` -- there was no human rendering at all. Added
`formatIndexStatusTable`/`indexStatusRow`: a column-aligned table
(`WORKSPACE STATUS FORMAT STRUCTURAL LEXICAL SEMANTIC LAST_SCAN`) for
human (non-`--json`) output; `--json` is unchanged and still prints the
raw daemon payload verbatim. `CliResult.data` (what a scripted caller
reading the return value sees, as opposed to `stdout`) is unaffected by
this either way.

### `packages/web/src/client/workspace-health.ts` / `main.tsx`

Added a pure function `workspaceV4Lanes(indexStatus)` that returns
`undefined` for a v3 workspace (or a missing/legacy `index_status`) and,
for v4, a small `{ structural, lexical, semantic, last_scan? }` view with
a `current: boolean` per lane and the last scan's kind/paths/wall time
plus its `queryable_at_ms`/`completed_at_ms` timeline milestones. Wired
into the workspace card in `main.tsx`: a new `.v4-lane-row` renders below
the existing Source/Structure/Semantic `.frontier-row`, styled amber
(`.lagging`) when a lane has not caught up, green (`.ready`) otherwise. A
v3 card's markup is unchanged (the block only renders when
`workspaceV4Lanes` returns a value). Styles added to `styles.css`.

## 2. Example outputs (captured live against the code in this change, not hand-written)

Fixture payload used for all three below: a v4 workspace at structural
generation 3 (queryable and durable both caught up), lexical lagging at
generation 2, semantic never started, and a `changed`-scope last scan over
4 paths taking 812ms.

### MCP `urdira_index_status` (default text render)

```
workspace_id=workspace-v4-example (urdira): ready, freshness=current
  query_scope={"scope_type":"single_workspace","workspace_id":"workspace-v4-example"}
  ready: source=yes, structural=yes, semantic=no
  structural: queryable_gen=3, durable_gen=3
  lexical: completed_gen=2 (lagging)
  semantic: completed_gen=- (lagging)
  last_scan: kind=changed, changed_paths=4, wall_ms=812
  hint: search_text will report partial until lexical catches up
  hint: search_semantic is unavailable until semantic indexing catches up
  use now: find_artifacts, search_text, get_source
  wait for structural: resolve_symbol, find_references
```

### CLI `urdira index` (human table)

```
WORKSPACE                      STATUS  FORMAT  STRUCTURAL  LEXICAL          SEMANTIC         LAST_SCAN
workspace-v4-example (urdira)  ready   v4      q3/d3       gen 2 (lagging)  gen - (lagging)  changed (4 paths), 812ms
```

### CLI `urdira index --json` (raw payload passthrough)

```json
{"workspaces":[{"workspace_id":"workspace-v4-example","display_root":"urdira","workspace_status":"ready","freshness_status":"current","source_ready":true,"structural_ready":true,"semantic_ready":false,"storage_format":"v4","structural":{"queryable_generation":3,"durable_generation":3,"queryable":true},"lexical":{"completed_generation":2,"current":false},"semantic":{"current":false},"last_scan":{"kind":"changed","changed_paths":4,"timings":{"total_ms":812,"catalog_ms":120,"parse_ms":300,"materialize_ms":250,"write_ms":90,"fsync_ms":30,"lexical_ms":22}},"search_text_ready":false,"search_semantic_ready":false,"available_operations":["core:find_artifacts","core:search_text","core:get_source"],"blocked_operations":["core:resolve_symbol","core:find_references"],"plugins":[],"capabilities":[]}]}
```

## 3. Tests added

- `tests/phase-daemon-v4-scan.test.ts`: two new integration tests against a
  real `DaemonRuntime` with a fake `RustWorkspaceScanTransport` (same
  harness the existing P2-7 tests use, no cargo/real worker needed) --
  (a) a v4 workspace reports `storage_format: "v4"`, matching structural
  generations, `search_semantic_ready: false`, a `last_scan` with the fake
  transport's own timings, a stable lexical-lagging state (this fake
  transport writes no real catalog rows, so `reconcileLexicalProjection`
  genuinely never completes -- a legitimate negative-path assertion, not a
  flaky one), and a `changed`-scope scan after a watcher-driven edit; (b) a
  v3 workspace reports `storage_format: "v3"` and omits `last_scan`
  entirely.
- `tests/phase15-workspace-control.test.ts` (`MCP index status v3`
  describe block): a text-render snapshot-style test asserting every new
  line (lane generations, lagging tags, last-scan summary, both hints) for
  a v4 payload, plus a test pinning that a v3 payload's render carries
  none of the new lines.
- `tests/phase12-cli.test.ts`: `urdira index` renders the table for human
  output (checks header row, generation cells, "lagging") and passes the
  identical raw payload through unchanged for `--json`; a no-workspaces
  fixture prints the existing plain message.
- `tests/phase24-web.test.ts`: `workspaceV4Lanes` unit tests -- the v4
  projection (generation labels, `current` flags, last-scan timeline
  fields) and the `undefined` case for a v3/missing/absent `index_status`.
  `packages/web` has no DOM/component-render test harness (only pure
  `src/client/*` functions are unit-tested from the repo root, per every
  existing `tests/phase24-web.test.ts` case) -- no rendered-`main.tsx`
  component test was added, matching the existing convention; the pure
  `workspaceV4Lanes` function is what `main.tsx`'s JSX calls, so its logic
  is fully covered.

## 4. Verification run in this session

```
npx tsc --noEmit -p packages/daemon/tsconfig.json     # clean
npx tsc --noEmit -p packages/mcp/tsconfig.json         # clean
npx tsc --noEmit -p packages/cli/tsconfig.json         # clean
npx tsc --noEmit -p packages/contracts/tsconfig.json   # clean
npx tsc --noEmit -p packages/web/tsconfig.json         # clean
npx tsc --noEmit -p packages/web/tsconfig.client.json  # clean
pnpm -r build                                          # all packages Done
npx eslint <every touched src/test file>               # clean, no findings
```

```
npx vitest run \
  tests/phase-daemon-v4-scan.test.ts tests/phase12-cli.test.ts \
  tests/phase24-web.test.ts tests/phase15-workspace-control.test.ts \
  tests/phase13-mcp.test.ts tests/phase12-daemon-protocol.test.ts \
  tests/phase12-daemon-scheduler.test.ts tests/contracts.test.ts \
  tests/phase-daemon-indexing-integration.test.ts tests/phase-daemon-scan-aggregation.test.ts \
  tests/architecture-guardrails.test.ts tests/npm-packaging.test.ts \
  tests/documentation-current-state.test.ts
# Test Files  13 passed (13)
#      Tests  297 passed (297)
```

`pgrep -f "cargo|v4-scan|urdira-indexing-worker"` was checked before every
multi-minute command in this session and was empty throughout (the fake
transport used by `tests/phase-daemon-v4-scan.test.ts` needs neither cargo
nor the real worker binary).

## 5. Scope notes / what was intentionally NOT touched

- No Rust crate, `packages/engine/src/native-structural-store-binding.ts`,
  `packages/plugin-javascript-typescript/src/registry-contribution.ts`,
  `tests/native-query-snapshot-port.test.ts`, or
  `tests/v4-daemon-e2e.test.ts` were read for editing purposes or modified
  (owned by the concurrent P2-2i task); `indexing-core-process-transport.ts`
  was read-only, to learn the existing `ScanTimings`/`ScanScope` wire
  shapes already defined there.
- `apps/urdira/src/index.ts` was left untouched (not in this task's owned
  package list, and shows as already modified by other in-flight work at
  session start).
- Semantic maintenance is still not wired for v4 (`runV4WorkspaceScan`'s
  own doc comment, unchanged by this task) -- `semantic.current`/
  `search_semantic_ready` are always `false` for a v4 workspace today,
  which is the accurate current state, not a placeholder this task left
  behind.
- No commit was made, per task instructions.
