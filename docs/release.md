# Release Process

This document is the operational checklist for Urdira 0.3.x. The normative
distribution contract is [decision 10](decisions/10-daemon-mcp-packaging.md);
the non-waivable qualification gates are [decision 08](decisions/08-performance-reliability-evaluation.md).

## Release channels

The primary public entry package is the dependency-free `urdira` bootstrap on
npm. The composed application is `@urdira/runtime` with its production
dependency closure under `@urdira/*`; it is prepared only after explicit user
confirmation. Packages are public and require Node.js `>=24.18.1`.
Deterministic platform archives are the offline distribution and contain a
private Node runtime plus the exact Rust addon, syntax worker, and launcher for
one target. Destination machines do not compile native code.

The source manifests remain private to prevent an accidental publish from a
workspace directory. `pnpm package:npm` creates clean public manifests in
`release/npm/staging`, packs them into `release/npm/tarballs`, and writes a
machine-readable manifest containing integrity values and publication order.

Urdira v3 release qualification also verifies the native indexing boundary:
CAS stream length/hash checks, transferable `FactDeltaBatch` arenas, atomic
SQLite staging and retry recovery, relational logical digests, the streaming
record-set digest, IPC Protobuf framing budgets, and explicit rejection of
pre-v3 and early-preview v3 roots. No CBOR or Base64 integration is part of
the release surface.

The current expanded TypeScript evidence report records one sequential sample
for each of 32 cells across TypeScript, Playwright, Prisma, and VS Code. The
Urdira arm was rerun on 2026-08-26; baseline, codebase-memory, and CodeGraph
rows are reused from the prior audited campaign and are marked as such. A
readiness control is not a successful agent task: every Urdira run must be
accompanied by stage timings, observed peak RSS, SQLite/CAS sizes, copy telemetry when
available, a repository grader result, and transcript attribution before it
enters the release aggregate. The current [Markdown report](../release/benchmarks/expanded-typescript-agent-benchmark-results-2026-08-27.md)
and [JSON report](../release/benchmarks/expanded-typescript-agent-benchmark-results-2026-08-27.json)
contain the derived measurements and failure details.

The expanded benchmark runner measures RSS but deliberately has no benchmark
memory limit and never kills a host for crossing a threshold. Only a genuine
operating-system termination is classified as an OOM/infrastructure failure.

The previous Urdira reruns were retired after their rows were invalidated; their
derived reports are not current release evidence. New runs must be generated
with the reproducible campaign below and retained only when their manifests,
grader results, transcript attribution, and cleanup records pass the stated
acceptance rules.

The reproducible comparative campaign is driven by
`release/benchmarks/run-expanded-agent-benchmark.mjs`. It supports the four
arms (native baseline, codebase-memory, CodeGraph, and checkout-built Urdira
with `urdira:javascript_typescript`), the quick-local, deep-cross-file, and
staged-incremental scenarios, and repository selection through
`--repositories`. Each cell uses a detached worktree and isolated index/data
root, records cleanup evidence, and must pass the smoke gate before additional
independent samples are launched. Benchmark invocations use the repository's
built `apps/urdira/dist/index.js` and Node.js `>=24.18.1`; the globally
installed `urdira` CLI is not part of the benchmark runtime.

### Native acceleration campaign

Decision 25 qualification uses the executable
`scripts/run-native-acceleration-campaign.mjs` harness. One invocation records
one independent paired campaign on the current host. It runs the declared
baseline and candidate controllers in the declared order, measures cold-index
wall time externally from controller launch through `prepare` and
`cold_index`, sends exactly 60 mutation requests sequentially, computes
incremental P95 with the nearest-rank method, and samples the complete
controller process tree into checksummed NDJSON while deriving peak RSS. It
compares the baseline and candidate visible-set digest after the cold index and
after every mutation; any mismatch aborts without producing a qualifying
report. The runner also recomputes corpus coordinates, binds every executable
input by digest, and refuses dirty Git worktrees.

A qualifying host must match the Decision 08 reference profile: 8 physical
cores, 16 GiB RAM, local NVMe storage, a six-core indexing ceiling, and an
8 GiB process-tree RSS ceiling. Runs on other hardware are engineering
prequalification only and cannot satisfy the release gate.

The campaign manifest is explicit and host-specific. It has this shape:

```json
{
  "schema_version": 2,
  "campaign_id": "darwin-arm64-01",
  "target": "darwin-arm64",
  "corpus": {
    "digest": "sha256:<64 lowercase hexadecimal characters>",
    "mutation_trace_digest": "sha256:<64 lowercase hexadecimal characters>",
    "baseline_path": "/absolute/path/to/baseline-corpus-copy",
    "candidate_path": "/absolute/path/to/candidate-corpus-copy"
  },
  "sample_count": 60,
  "execution_order": ["baseline", "candidate"],
  "rss_sample_interval_ms": 100,
  "qualification": {
    "cache_state": "cold",
    "cache_preparation": "documented host-specific cold-cache procedure",
    "background_load": "dedicated idle reference host",
    "resource_limits": {
      "cpu_cores": 6,
      "memory_bytes": 8589934592,
      "enforcement": "documented host-specific enforcement"
    }
  },
  "timeouts": {
    "prepare_ms": 600000,
    "cold_index_ms": 3600000,
    "mutation_ms": 300000,
    "shutdown_ms": 30000
  },
  "lanes": {
    "baseline": {
      "command": {
        "executable": "/absolute/path/to/node-or-controller",
        "args": ["/absolute/path/to/controller.mjs", "--config", "/absolute/path/to/baseline-controller.json"],
        "cwd": "/absolute/working/directory",
        "environment": {
          "NODE_ENV": "production",
          "URDIRA_SEMANTIC_INDEX": "0",
          "URDIRA_NATIVE_REQUIRED": "0",
          "URDIRA_INDEXING_CORE_ORACLE": "1"
        }
      },
      "provenance": {
        "revision": "<exact 40-character lowercase Git object id>",
        "build_id": "<exact baseline build>",
        "configuration_digest": "sha256:<controller config bytes>",
        "controller_executable_digest": "sha256:<bound executable, script and command>",
        "runtime_module_digest": "sha256:<built runtime module bytes>",
        "cargo_lock_digest": "sha256:<Cargo.lock bytes>",
        "native_manifest_digest": null,
        "native_closure_digest": null
      }
    },
    "candidate": {
      "command": {
        "executable": "/absolute/path/to/node-or-controller",
        "args": ["/absolute/path/to/controller.mjs", "--config", "/absolute/path/to/candidate-controller.json"],
        "cwd": "/absolute/working/directory",
        "environment": {
          "NODE_ENV": "production",
          "URDIRA_SEMANTIC_INDEX": "0",
          "URDIRA_NATIVE_REQUIRED": "1",
          "URDIRA_NATIVE_ROOT": "/absolute/release/archive/native"
        }
      },
      "provenance": {
        "revision": "<exact 40-character lowercase Git object id>",
        "build_id": "<exact candidate build>",
        "configuration_digest": "sha256:<controller config bytes>",
        "controller_executable_digest": "sha256:<bound executable, script and command>",
        "runtime_module_digest": "sha256:<same built runtime module bytes as baseline>",
        "cargo_lock_digest": "sha256:<same Cargo.lock bytes as baseline>",
        "native_manifest_digest": "sha256:<native/manifest.json bytes>",
        "native_closure_digest": "sha256:<verified target closure>"
      }
    }
  }
}
```

Executables, working directories, corpus copies, commands, arguments, and
environment entries must all be explicit. The controller receives only the
manifest environment; the harness never inherits the caller's environment.
Do not put credentials in a benchmark environment because the exact command
manifest is retained in the report. Each command working directory must be a
clean repository at its declared revision. The baseline and candidate paths
must be separate mutable copies of the same frozen tier-L corpus. The runner
recomputes file, logical-line, and byte counts and rejects a corpus outside
Decision 08 tier L.

Prepare the shared deterministic mutation trace outside both mutable corpus
copies, then validate it independently against each pristine copy:

```bash
pnpm prepare:native-acceleration-trace \
  --corpus /absolute/path/to/frozen-corpus \
  --trace /absolute/path/to/mutation-trace.json \
  --trace-id typescript-frozen-60

pnpm prepare:native-acceleration-trace \
  --validate \
  --corpus /absolute/path/to/baseline-corpus-copy \
  --trace /absolute/path/to/mutation-trace.json
```

Trace generation discovers suitable files from the corpus and writes exactly
60 declared mutations: content, import, create, delete, rename, `tsconfig`, and
package-manifest changes. Every step includes before/after bytes and the complete
resulting corpus digest. Generation and validation do not mutate the corpus;
`.git` is excluded automatically because repository-administration bytes are
not indexed source and can change during otherwise read-only Git operations.
The prepared TypeScript trace for commit
`b465fdbfe175304d9b977da137b2c178ae1091d3` is retained at
``release/benchmarks/native-acceleration/typescript-b465fdb-60.trace.json``,
with base corpus digest
`sha256:58726c8df3bcd2552271dbc321cacb9fa563d736c1b90d6718c483fa8e0b6b34`
and trace digest
`sha256:1f8d4fe2659637b3b4bc67eb7fdcf3df1d978c65342dc605b8d5e977c95f5c92`.

Each lane command invokes the foreground controller with an absolute config
path, for example `node scripts/native-acceleration-controller.mjs --config
/absolute/baseline-controller.json`. The closed controller config records its
lane, mutable corpus copy, shared trace, empty lane-specific data root, absolute
built runtime module, explicit technology/plugin selection, and polling budget:

```json
{
  "schema_version": 2,
  "lane": "baseline",
  "corpus_path": "/absolute/path/to/baseline-corpus-copy",
  "mutation_trace_path": "/absolute/path/to/mutation-trace.json",
  "data_root": "/absolute/path/to/empty-baseline-data-root",
  "runtime_module": "/absolute/checkout/apps/urdira/dist/index.js",
  "workspace_selection": {
    "selected_technology_ids": ["typescript"],
    "selected_plugin_ids": ["urdira:javascript_typescript"]
  },
  "qualification": {
    "mode": "qualifying",
    "corpus_tier": "L",
    "cache_state": "cold",
    "applied_limits": {
      "max_indexing_cores": 6,
      "max_rss_bytes": 8589934592
    },
    "capture_phase_timings": true
  },
  "polling": { "interval_ms": 100, "readiness_timeout_ms": 3600000 }
}
```

Use an equivalent candidate config with `lane: "candidate"`, its own corpus and
data roots, and the same trace/runtime revision. The campaign manifest environment
selects the lane behavior: the frozen historical baseline explicitly disables
native acceleration, while the candidate sets `URDIRA_NATIVE_REQUIRED=1` and the
exact `URDIRA_NATIVE_ROOT`. The controller starts Urdira in its foreground process,
keeps supervised children in the measured tree, waits for a new complete
structurally-ready snapshot after every mutation, and reads the authoritative
`canonical_record_set_digest` directly from that immutable snapshot.

Each controller is a persistent foreground process using newline-delimited
JSON on stdin and stdout. Stdout is reserved for protocol responses; diagnostic
output belongs on stderr. The harness sends, in order, `prepare`, `cold_index`,
60 `incremental_mutation` requests carrying indices 0 through 59, and
`shutdown`. Every response echoes `schema_version`, `request_id`, and
`status: "ok"`. The `prepare` response must confirm `corpus_digest` and
`mutation_trace_digest`. Cold and mutation responses must contain the exact
`visible_set_digest` as a lowercase SHA-256 value. The cold response also
contains ordered timings for runtime load, daemon start, workspace add,
readiness, and digest calculation. Every mutation response contains its index
and ordered timings for mutation application, readiness, and digest
calculation. These 63 exact responses per lane are retained in the protocol
log and verified by the release gate. The controller must keep all measured
daemons and workers in its process tree until shutdown; detached or
pre-existing services are not valid campaign subjects.

Run each campaign with absolute input and output paths:

```bash
pnpm benchmark:native-acceleration \
  --manifest /absolute/path/to/campaign.json \
  --report /absolute/path/to/native-acceleration-report.json
```

Use a new campaign ID and `--append` for the second and third independent runs
on a reference host, counterbalancing lane order across the three runs. Repeat
on `darwin-arm64` and `linux-x64-gnu`; do not merge campaigns with different
corpus, mutation trace, runner, build, or host identity. The harness writes the
closed schema-version-2 report, a `.sha256` sidecar, and checksummed per-lane
protocol, stderr, and RSS-series evidence. Evaluate the combined report of
exactly six campaigns with:

```bash
pnpm check:native-performance \
  /absolute/path/to/native-acceleration-report.json
```

The harness records measurements; it never manufactures missing samples,
replaces failed mutations, or infers commands, corpus identity, target, or
configuration. A command failure, timeout, malformed protocol message,
unavailable RSS measurement, digest mismatch, duplicate campaign ID, or host
target mismatch fails closed.
The gate independently verifies the report self-digest and sidecar, all raw
artifacts, 60 times and 61 visible-set digests per lane, controller v2 phase
timings, absolute tier-L limits, and the 25/40/25 relative-improvement gates.
Interrupting the harness terminates the active controller process group and its
measured daemon/checker/worker descendants before the harness exits; an
interrupted run never writes qualifying campaign evidence.

### Structural indexing performance preflight

Run structural indexing with `--debug-timing` only for diagnostic or evidence
captures. The flag enables non-overlapping source/CAS, worker-wait,
FactDelta-acceptance, SQLite-staging, accumulation, and publication timing with
counts and nearest-rank P50/P95/P99. It never changes public responses.
Readiness within the daemon is event-driven with a one-second safety poll; an
external campaign controller may continue polling the public status surface.

Before a complete n8n run, execute only the deterministic 512-owner slice bound
to the corpus digest approved by Decision 08. Its wall time must reconcile with
the non-overlapping subspans within five percent, and the grouped path must
match the scalar oracle's owner/result/digest sequence exactly. The 1,000-owner
slice is admissible only after the exact 512-owner result is below 45 seconds.
Run one cold n8n index only after both bounded preflights pass. The
20-cold/60-mutation P95 suite requires separate explicit authorization after
that single run is reviewed.

The preflight exercises the language-neutral
[structural indexing fast path](protocol/structural-indexing-fast-path.md), not
a JavaScript/TypeScript-only publication lane. A future production language
adapter must pass the same cold/incremental, owner-group, typed-staging,
crash/replay, digest and query-equivalence gates before its repository-scale
performance result is admissible.

The semantic-oracle executable must negotiate its documented private protocol
identity. Protocol 1.9 requires an explicit absolute core-addon path whenever
native structural acceleration is active, rejects an ambient, relative or
API-incompatible binding, and drains several owner streams as Rust-sealed
canonical row frames per bounded continuation instead of issuing one process
round trip per owner or serializing nested row graphs. The receiving core must
decode and revalidate those logical rows before creating its own typed staging
projection. Its current build identity additionally requires the closed native
observation profile: prepared owner observations are partitioned at 4,096 rows,
cross Node-API once per physical partition, and return only canonical rows plus
compact identity headers before framing with independent owner identities.
Focused release tests must prove one native call per eligible physical group,
scalar fail-closed behavior, and exact owner ordering across continuation
boundaries before a 512-owner run is admissible.

### Exact vector top-K activation validation

The query engine selects the native exact-vector kernel whenever the verified
production native closure is active. It validates the exact target/API binding,
canonical packed vectors, result membership, cardinality, ranks, and portable
UTF-8 tie ordering. Native errors or malformed results fail the query closed;
they never trigger a silent TypeScript retry.

Run the fixed five-sample 100K and 1M paired benchmark against the exact addon
selected for the target. An optional checksummed attribution report records
the kernel's share of real end-to-end query time and incremental peak RSS:

```bash
pnpm benchmark:exact-vector-top-k \
  --addon /absolute/path/to/urdira-native.node \
  --attribution /absolute/path/to/query-attribution.json \
  --output /absolute/path/to/exact-vector-top-k-evidence.json \
  --samples 5
```

The harness compares the N-API kernel with an exact TypeScript oracle, including
UTF-8 identifier tie-breaking for squared-L2 and cosine cases. It writes an
immutable report and `.sha256` sidecar. Re-evaluate a retained report without
rerunning the workload with:

```bash
pnpm benchmark:exact-vector-top-k \
  --gate /absolute/path/to/exact-vector-top-k-evidence.json
```

The result is `activate` when the real N-API addon passes exact ordered-result
and tie equivalence, the large end-to-end path improves by at least 15 percent,
and the 100K path regresses by no more than 5 percent. The 2x-throughput or
30-percent-RSS target and 20-percent real-query attribution remain diagnostics
for optimization and rollback review rather than activation blockers.

The current darwin-arm64 microkernel evidence is retained in
``release/reports/exact-vector-top-k-darwin-arm64-2026-08-28.json``.
It confirms exact ordered equivalence and a 31.65 percent large end-to-end
improvement, but only 1.47x kernel throughput and 9.32 percent peak-RSS
reduction, with no qualifying real-query attribution. Its decision is therefore
`activate`; the missing attribution and stretch-target miss remain explicit in
the report checks and are not presented as a whole-query performance claim.

Query-operation diagnostics are enabled by the existing `--debug-timing`
switch. They retain at most 1,024 samples per operation and emit duration,
rows, decoded and serialized logical bytes, copy count, event-loop delay and
RSS distributions with P50/P95/P99 plus lifetime totals. Campaign-specific
composition may inject exact process-tree/resource probes; the default probe
uses process RSS and a Node event-loop delay histogram. These diagnostics are
stderr/progress evidence only and never change a public query response.

## One-time external setup

1. Create the public npm organization `@urdira` and verify that the unscoped
   `urdira` package name is controlled by the release owner.
2. Authenticate an npm account with two-factor authentication for the initial
   namespace bootstrap.
3. Configure npm trusted publishing for the exact public GitHub repository and
   release workflow. The workflow requires `id-token: write`; no long-lived npm
   token belongs in the repository.
4. Protect release tags and require the verification jobs.

See npm's official documentation for
[organizations](https://docs.npmjs.com/creating-an-organization/),
[public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/),
and [trusted publishing](https://docs.npmjs.com/trusted-publishers/).

Creating the organization and publishing public scoped packages is free under
npm's public-package plan. The repository does not create the organization or
publish on behalf of a local verification run.

## Local qualification

Use the pinned runtime from `.nvmrc` and a clean checkout:

Node must resolve to `24.18.1` and npm must be at least `11.16.0`; runtime
preparation fails closed when the strict install-script policy is unavailable.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm preflight:windows
pnpm check:native
pnpm test:native
pnpm audit:native
pnpm verify
pnpm audit --prod
pnpm package:npm:smoke
URDIRA_RELEASE_TARGET=<host-target> pnpm package:release
URDIRA_RELEASE_TARGET=<host-target> URDIRA_SKIP_INSTALL=1 pnpm release:acceptance
git diff --check
```

`<host-target>` is one of the five closed release targets. Native qualification
is target-scoped: each native runner builds and accepts only its own closure;
an all-target acceptance run requires verified artifacts from all five native
runners to be present.

CI runs the complete coverage, audit, publication, and npm-package gates once
on Ubuntu and the complete ordinary test suite once on macOS. A separate
five-target matrix builds and executes the Rust closure on `darwin-arm64`,
`darwin-x64`, `linux-arm64-gnu`, `linux-x64-gnu`, and `win32-x64`, then packages
only that target's verified native files. Windows also runs the focused
portability preflight.

Native binding API v17 is the required exact private handshake
(`NATIVE_API_VERSION` in `packages/native/src/loader.ts` and
`crates/urdira-native-node/src/lib.rs`; the loader rejects any other value,
older or newer, before work). It retains the Rust-sealed typed
structural-publication projection and exact UCE body payload, independent
receiving-core validation of opaque canonical FactDelta rows, the closed
native observation-profile dispatcher, and the resident vector top-K kernel
used by the semantic query path. Semantic process protocol 1.9 requires
`structuralObservationBatch`; older addons are rejected before work. Release
packaging and acceptance must reject a mismatched binding version rather than
silently reconstructing nested rows in the host or selecting the typed
publication lane with an incomplete native contract.

A v4-format workspace (the default for newly added workspaces since
2026-09-04; see `versioning.md`) additionally requires the `urdira-indexing-worker`
Rust binary to run its scan pipeline. `scripts/native-release.mjs` packages it
under `indexing_core_worker` in the platform archive; the daemon discovers it
as a sibling of the verified syntax worker or through
`URDIRA_INDEXING_CORE_WORKER_PATH`.

Required outcomes:

- architecture, lint, type, generated-contract, test, and coverage gates pass;
- the production dependency audit reports no known vulnerabilities;
- all 20 npm tarballs contain only their declared production payload,
  `README.md`, `LICENSE`, and package
  metadata, with no `workspace:*`, testkit, fixture, source, or private path;
- a clean global npm prefix installs only the `urdira` bootstrap with no
  dependencies and no npm warning, then a separate temporary project installs
  the complete runtime closure under its exact reviewed script policy;
- `urdira --version` / `urdira --help` work before preparation, and the
  composed runtime CLI passes its own version/help smoke checks;
- deterministic archives pass inspection and acceptance; and
- the Rust/TypeScript golden vectors, worker handshake, crash containment, and
  target checksum checks pass on every release target; and
- publication hygiene finds no tracked editor/agent configuration, historical
  implementation plan, broken documentation link, host-local path, or stale
  package name.

## Stable qualification

Passing the local suite is necessary but not sufficient for a stable tag.
Before publication, archive release evidence showing:

- zero failures across correctness, determinism, crash, corruption, migration,
  watcher, and security scenarios;
- full/incremental equivalence and cursor replay at 100%;
- the 20-workspace / 50-client concurrent stress scenario;
- every declared P95 latency and resource ceiling across three independent
  runs and no unexplained regression above 10%; for the named n8n cutover, the
  2 GiB RSS value is an advisory budget and an individual exact sample remains
  admissible when its agreed time gate passes, while any overage is retained in
  the report; and
- the native cutover gate reports at least 25 percent lower cold P50/P95, 40
  percent lower complete incremental P95, and 25 percent lower peak
  process-tree RSS on both reference targets; and
- benchmark inputs, runner version, raw-measurement digest, environment, and
  report digest.

The committed Vite campaigns are comparative agent-task evidence. They do not
replace the reliability, stress, or three-run P95 gates above. A flaky run is a
failure until its cause is identified.

## Publication

Review `release/npm/manifest.json`, then publish in its generated topological
order. The complete scoped runtime closure, including `@urdira/runtime`, must
publish before the dependency-free `urdira` bootstrap. Scoped packages require
public access. For a one-time interactive namespace bootstrap:

```bash
npm publish release/npm/tarballs/<package>.tgz --access public
```

After every package exists and trusted publishing is configured, release tags
should use the protected provenance-enabled workflow. Never publish from
`apps/` or `packages/` directly.

After publication, install `urdira` into a fresh global prefix and require an
empty npm warning stream. Verify version/help and the unprepared runtime
status, inspect `urdira runtime prepare --dry-run`, then confirm preparation.
Start `urdira mcp`, register a disposable JavaScript/TypeScript workspace,
confirm index readiness, execute one explicitly scoped query, and verify
pagination. Record bootstrap/runtime package integrity values, the preparation
manifest, and the release tag in the release notes.

Native indexing cutover is qualified in stages: direct Rust-core replay for
8/32/128 owners, real JS/TS groups for 16/64 owners, integrated 128-owner
preflight, one 512-owner run, then 1,000 owners and a cold n8n run. Exact
visible-set/digest equivalence, measured RSS and temporary storage, WAL/lock
evidence, and the documented <=45 s admission projection must pass before a
release archive may claim native structural readiness. The n8n 2 GiB RSS figure
is an advisory budget for this admission decision: a sample that exceeds it is
not rejected when its agreed time gate and exact-output checks pass, but the
measured overage remains release evidence and an optimization item.

The native staging helper copies `urdira-indexing-worker` into the platform
archive when the build produced it (`indexing_core_worker` in
`scripts/native-release.mjs`); see the v4 packaging note above for binary
discovery. Since v4 is now the default format for new workspaces, a release
build must run `pnpm build:native` with the `urdira-indexing-worker` crate
included so the archive is not missing it.

## Rollback

npm versions are immutable. Do not overwrite or reuse a published version.
If a package is unusable, deprecate the affected version with a concise reason,
fix forward under a new semver version, and preserve the evidence needed to
understand the incident. Data-format or migration failures additionally follow
the recovery and compatibility contracts before a replacement release ships.
