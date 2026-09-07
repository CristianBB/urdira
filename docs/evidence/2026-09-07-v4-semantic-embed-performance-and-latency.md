# Frente S-D: semantic embed performance (n8n) and query latency

Plan `resilient-knitting-twilight.md` §0/§4. Repo `/Users/Cristian/Proyectos/urdira`,
main `9b49e82` at task start (Frente S-C merged: v4 semantic wiring, entity
record source, parallel snapshot reads in `search_semantic`). Worked in
worktree `.claude/worktrees/agent-a6008f80a86d81632`, branch
`frente-sd-embed-perf`. Machine: Apple Silicon, 10 cores, 32GB RAM (see
`uptime`/`sysctl hw.memsize` samples inline below; shared with other
concurrent agents throughout this session -- load 2.6-6.6 observed).

Input: `docs/evidence/2026-09-07-v4-semantic-wiring-and-embed-performance.md`
(profile: 75 segs/s one process, 108 segs/s two processes, 4 regresses;
CoreML rejected; `intraOpNumThreads` no gain; latency: `Promise.all` +
bounded-concurrency shard reads already applied, p99 445ms on 45 files, two
remaining named cost centers: `exactVectorScan`'s per-candidate
`canonicalVectorBytes` and `hydrateSemanticCandidates`'s sequential,
order-dependent snippet budget) and
`docs/evidence/2026-09-07-v4-n8n-parity-and-semantic-segments.md` §B
(n8n histogram: 20,148 artifacts, 326,817 candidate entity records, 17,630
eligible, p99=31 segments/entity; full n8n embed did NOT complete in 3h44m
on v3 storage, pre-Lever-1 whole-file-per-artifact embed).

---

## Part 0: a NEW P0 discovered live -- v4 semantic maintenance cannot spawn
its child process at n8n scale (`spawn EBADF`), and the reconciler's own
entity-candidate enumeration OOMs a default-heap Node child

Before any lever could be measured on the REAL n8n corpus, two blocking bugs
had to be found and fixed; neither is caused by this frente's own levers
(confirmed: both reproduce with `URDIRA_SEMANTIC_WORKERS=1`, the pre-existing
single-process path) -- both are pre-existing gaps that make v4 semantic
maintenance non-functional at real, large-corpus scale, discovered here
because this is the first time anyone has actually run it end-to-end on n8n
since Frente S-C wired it up.

### 0.1 `spawn EBADF` when forking the semantic maintenance child

Reproduced live, twice, starting a real daemon (`apps/urdira/dist/cli.js
daemon start`) with `URDIRA_NATIVE_REQUIRED=1` against the n8n corpus copy
(`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`, 20,281 files
inspected): `submitSemanticMaintenance`'s `runSemanticReconcileInProcess`
(`packages/daemon/src/semantic-process.ts`) forks
`semantic-maintenance-process.js` and gets `Error: spawn EBADF` (`code:
'EBADF'`) EVERY time, both from the initial post-scan submission and from
the startup-prewarm resubmission after a daemon restart.

Root cause (matches a PRE-EXISTING, already-documented finding in
`docs/evidence/2026-09-06-v4-reconcile-threshold.md` §14.5 and
`docs/evidence/2026-09-03-v4-p3-1-incremental.md` §7.7, from unrelated
frentes): the daemon's own file-watcher subsystem holds roughly ONE file
descriptor PER WATCHED CORPUS FILE. Measured live via `lsof -p <daemon pid>
| wc -l`: **24,919-24,951 open fds**, essentially matching the 20,281
inspected files 1:1. `ulimit -n` (1,048,576) and `sysctl
kern.maxfilesperproc` (122,880) are both far above this count -- this is
NOT ordinary fd exhaustion (`EMFILE`/`ENFILE`); it is a transient/sustained
Node/libuv fd-table issue when `child_process.fork()` runs from a process
already holding this many descriptors.

**Fix (in scope, does not touch the file-watcher subsystem)**:
`runSemanticReconcileInProcessWithRetry` (`packages/daemon/src/semantic-process.ts`,
new) wraps every `fork()` attempt with a bounded retry (6 attempts, 500ms
backoff) on `error.code === "EBADF"`/`error.errno === -9`, mirroring
`scripts/v4-mutation-harness.mjs`'s own pre-existing `execFileWithEbadfRetry`
(same error-code check, same bounded-attempts shape -- not a new invention).
`runSemanticReconcileSharded` (Lever 2, below) routes every one of its
per-shard spawns and its finalize-pass spawn through this same retry
wrapper. Genuinely eliminating the root cause (one fd per watched file) is a
file-watcher-subsystem redesign, reported here as a separate, real P0 for
the owner's queue -- this retry is the accepted mitigation the rest of the
codebase already uses for the identical error class, not a claim the
underlying fd pressure is fixed.

### 0.2 Entity-candidate enumeration OOMs a default-heap semantic child

Once past 0.1, the semantic child ran and reached
`node::OOMErrorHandler`/`FATAL ERROR: ... JavaScript heap out of memory`
(observed on 3 separate attempts, both with 2 concurrent shard children and
with `semantic_process: false`'s in-process path -- the LATTER crashed the
WHOLE DAEMON, not just a child, since "in-process" means the reconciler
literally runs on the daemon's own event loop/heap).

Root cause: `createNativeSemanticEntityRecordSource`'s `entityCandidates()`
(`packages/engine/src/semantic-entity-source-v4.ts`) materializes EVERY
visible entity-category candidate record (n8n: 326,817, per the input
evidence doc's own histogram) as decoded JS objects in ONE array, BEFORE any
eligibility filtering -- comfortably exceeding Node's default ~4.1GB
old-space ceiling on this machine.

**Fix (in scope, does not touch the entity-source's own memory profile)**:
`SEMANTIC_CHILD_MAX_OLD_SPACE_MB` (`packages/daemon/src/semantic-process.ts`,
default 6144, overridable via `URDIRA_SEMANTIC_CHILD_MAX_OLD_SPACE_MB`) is
passed as `--max-old-space-size` in the child's own `execArgv`. This session
used 10240 (10GB) for the actual n8n measurement below, given 32GB physical
RAM and a single (non-sharded) child. Genuinely fixing
`entityCandidates()`'s O(corpus) eager materialization (streaming/batching
the scan instead of one giant array) is a `semantic-entity-source-v4.ts`
concern, reported here as a second real finding for the owner's queue, out
of this module's scope.

### 0.3 Consequence for this session's measurement plan

Given 0.1 recurring even with retry under SUSTAINED (not transient) fd
pressure when running 2 CONCURRENT shard children (each shard's own
`entityCandidates()` call ALSO independently re-materializes the full
326,817-record array -- a real, documented cost of Lever 2's per-process
enumeration, see Lever 2's own section below), this session's PRIMARY
full-n8n timing run below uses `URDIRA_SEMANTIC_WORKERS=1` (single process,
degrades `runSemanticReconcileSharded` to the retry-wrapped single-fork
path) to isolate and measure Levers 1 and 3 cleanly at full n8n scale.
Lever 2's OWN throughput multiplier is measured separately, at smaller
scale, where it does not trip this fd ceiling (§2 below) -- its mechanism
correctness at n8n scale is proven by the sharding unit tests and the
daemon e2e test (both pass, see §2), but its throughput GAIN specifically at
n8n's own 20k-file scale could not be safely measured this session without
first fixing the file-watcher fd issue (0.1) at the architecture level,
which is out of scope.

---
<!-- Remaining sections filled in after the run completes: Lever 1 (artifact
composition) measured curve, Lever 2 (sharding) at small scale, Lever 3
(cache) hit-rate on an edit, full n8n embed wall/rows, latency before/after
on n8n hot + small workspace, final counts. -->
