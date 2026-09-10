# Protocol for one profiled Prisma structural pass

Status: preparation only. This document defines a future single pass; no Urdira process, benchmark cell, or profiling recording was started while preparing it.

## Fixed target and gates

Use the same Prisma corpus commit as the valid structural diagnostic:

```text
0f37454eec96b193e8b20e8f569e453acd2af644
```

Create a new detached checkout and keep it until all evidence is closed. Use short paths for both the checkout and Urdira data root to avoid the prior Unix socket failure:

```text
worktree=<temporary-checkout>
data_root=<temporary-data-root>
```

Immediately before the host performs `core:workspace_add`, the wrapper must record and assert all of the following:

1. `realpath(worktree)` exists and is a directory.
2. `git -C worktree rev-parse HEAD` equals `0f37454eec96b193e8b20e8f569e453acd2af644`.
3. `worktree/package.json` exists.
4. `git -C worktree ls-files | wc -l` is greater than 1,000; record the exact count.
5. `git -C worktree status --short` is empty after checkout preparation.
6. `data_root/daemon.sock` is measured before startup and remains below the host's Unix socket-path limit; the proposed path is 23 bytes.

If any gate fails, do not call `workspace_add` and preserve the gate failure as a preflight result. Once the gate passes and workspace registration starts, run exactly one pass and do not retry.

## Urdira mode

Use the current release worker and recapture all artifact fingerprints immediately before the pass. Keep the existing release diagnostic settings:

```text
URDIRA_DATA_ROOT=<temporary-data-root>
URDIRA_INDEXING_CORE_WORKER_PATH=<release-worker>/urdira-indexing-worker
URDIRA_SEMANTIC_INDEX=0
URDIRA_SEMANTIC_MATERIALIZATION=0
URDIRA_ANALYSIS_WORKERS=1
URDIRA_ANALYSIS_POOL_MAX=1
URDIRA_STRUCTURAL_CONCURRENCY=1
URDIRA_RECONCILIATION_SWEEP_INTERVAL_MS=0
URDIRA_DEBUG_TIMING=1
URDIRA_STORAGE_DEBUG_TIMING=1
```

The host must use `semantic_index: false`, no semantic descriptor, and the structural `current/equivalent` readiness boundary. Do not start a Codex agent, attach an MCP client, or issue a query. The pass ends at the structural readiness marker. Semantic SQLite and semantic sidecar bytes must be recorded as zero.

Record these fingerprints and mtimes in `preflight.json`: indexing worker, release/prebuild syntax worker, release/prebuild native addon, plugin distribution, app distribution, daemon distribution, MCP distribution, runner, and current Rust/TypeScript source roots. Include the repository HEAD, status, dirty-diff digest, host settings, and exact environment. If a required worker is older than its source tree or cannot be tied to the current checkout, stop before `workspace_add`; a rebuild may be performed once before the pass, with its command and resulting hash recorded.

## Profiling tool availability on this macOS host

The following availability check was performed without starting a target process and without installing anything:

| Tool | Availability | Observed path/version note |
| --- | --- | --- |
| `sample` | available | supports PID, duration, interval, `-wait`, `-mayDie`, `-fullPaths`, and `-file` |
| `xctrace` | available | resolved by `xcrun` to the Xcode developer tool; `record` supports Time Profiler, PID attach, output `.trace`, and time limits |
| Instruments CLI (`instruments`) | unavailable | `xcrun --find instruments` did not find it |
| `cargo-instruments` | unavailable | not installed |
| `flamegraph` / `cargo-flamegraph` | unavailable | not installed |
| Cargo | available | cargo 1.98.0; no profiling subcommand was present |

### Preferred recording

Use `xctrace` Time Profiler attached to the indexing worker PID once the worker has appeared, with a bounded recording covering the cold structural scan:

```bash
xctrace record --template "Time Profiler" --attach "$WORKER_PID" \
  --time-limit 120s --output "$OUT/profile/urdira-indexing-worker.trace" \
  --no-prompt
```

The wrapper should start this recording after discovering the worker PID and before the expensive resolve phase. The trace is the primary CPU call-tree artifact for Rust code. If the worker finishes before the recording starts or `xctrace` rejects the attach, retain the failure and do not rerun the indexing pass; the internal timing log remains the authoritative stage breakdown for that pass.

Use `sample` as the pre-declared fallback only when `xctrace` is unavailable or attach fails before any samples are collected:

```bash
sample "$WORKER_PID" 60 10 -mayDie -fullPaths \
  -file "$OUT/profile/urdira-indexing-worker.sample.txt"
```

This fallback is a statistical snapshot rather than a trace and must be labelled accordingly. Do not mix a partial `sample` file with a successful `.trace` as if they were equivalent.

## PID, child, and resource capture

The wrapper owns one process tree: wrapper, the Node host runner, and the Rust indexing worker. Record for each PID the start time, parent PID, command line, executable realpath, and SHA-256. Discover children from `ps -axo pid=,ppid=,rss=,pcpu=` every 500 ms, using the existing `sampleProcessTree` logic, and save the complete time series outside the repository. Keep the profiler PID separate from the measured Urdira tree; the profiler itself must not be included in process-tree RSS or CPU.

The result manifest must include:

* wall time from wrapper start to host close;
* time to queryable and time to durable structural readiness;
* peak and mean process-tree RSS, aggregate CPU, process count, and sample count through readiness;
* worker-only peak RSS/CPU if available from the profiler or worker timing output;
* profiler start/end times, target PID, command, template, sample interval, time limit, exit status, and any attach error;
* hashes and byte sizes of `.trace`, `.sample.txt`, host log, internal timing log, result JSON, preflight, and gate files.

The profiler introduces overhead and may perturb scheduling. Do not compare its absolute wall/RSS/CPU values directly with unprofiled historical rows. Publish the profile as a diagnostic run and report the profiler mode, interval, and artifact size. No separate overhead-control pass is authorized by this protocol.

## Internal timing and result extraction

Keep `URDIRA_DEBUG_TIMING=1` and `URDIRA_STORAGE_DEBUG_TIMING=1`. Parse the host log for catalog walk/apply, typeflow, facts, resolver setup, hybrid semantics, materialize pass 1 and pass 2 subphases, publish, scan-orchestrator totals, queryable, completed durable, and `BENCH_HOST_READY`. Capture the counts for observations, files, owners, records, dependencies, subjects, pending sites, and graph entries.

Preserve Urdira's distinction between `run_cold_total`, queryable, and host readiness. Do not infer per-query latency, function-level causality, or semantic work from this pass. A profile can identify sampled stacks for candidate routines, but causal attribution still requires a controlled follow-up that is outside this one-pass protocol.

## Closure and cleanup

After `BENCH_HOST_READY`, request the host's normal shutdown and wait up to the declared bounded interval. If an owned host or worker remains, terminate only those PIDs and record the signal. Close the profiler before deleting its target process. Write and hash the manifest and raw artifacts before cleanup. Then remove only `<temporary-checkout>`, `<temporary-data-root>`, and owned profiler processes. Leave the output directory and all evidence intact.
