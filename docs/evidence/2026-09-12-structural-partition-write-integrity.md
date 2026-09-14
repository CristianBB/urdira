# Structural partition write integrity

Date: 2026-09-12. Authority: [decision 26](../decisions/26-v4-structural-store.md).

## Retained failure

The fresh VS Code sample 1 on the previously qualified installed runtime failed
its first `urdira_context` call with `core:execution_failed`: the header checksum
for `base/records.digests` was `46eef28844adc01c`, while the reader computed
`cf40430e0451692e`. The source and structural readiness gate had passed. The
agent fell back to shell. This sample fails integration acceptance regardless
of its resulting edit or compiler result.

Artifacts are retained under
`/Users/Cristian/BenchmarkResults/urdira-agent-iteration-20260912/`.
The immutable store was cloned to `vscode-failed-structural`; the transcript,
manifest, host logs, patch and untracked test were retained separately.
`vscode-zero-digests.json` records 28 all-zero record digests among 8,716,073
rows. `vscode-digest-boundaries.json` places both corrupt regions exactly at
partition starts: rows 2,178,928 and 5,448,820. The unexpected zero regions end
at 4,096-byte boundaries. This is lost data, not merely a checksum presentation
problem. The failed store is not repaired or reused for a fresh sample.

## Repair

Logical disjointness does not prevent adjacent writes from sharing physical
blocks. The retained offsets are consistent with an uninitialized boundary-block
race; they do not establish an independently traced kernel defect. Physical
preallocation previously authorized concurrent writes to one file.

Both base-writer paths now share a per-file mutex covering each complete
positional write, including short-write retries. Encoding, hashing, secondary
indexes and writes to independent files remain parallel. This removes concurrent
same-file writes without depending on filesystem allocation behavior. There is
no format, query schema, checksum formula or cursor-order change, and readers
continue to reject corrupt data. Any throughput cost must be measured separately.

## Validation scope

The new byte-for-byte unaligned partition fixture and the larger 10 GiB write
stress test were written before the repair. Both passed on the old implementation;
they did not reproduce the corpus failure and must not be represented as failing
regressions. The retained actual corpus is the failure reproduction. Both tests
also pass after serialization. The small case checks every byte across eight
rounds rather than only the first byte of aligned writes; the large case is an
explicit ignored stress test. A fresh complete corpus and actual query are still
required in addition to these bounded tests and the normal verification gates.

The decision's old sentence saying empty checksum partitions were skipped was
also stale: both existing writers and the reader include all 16 hashes, with
`hash([])` for an empty partition. The documentation now states that existing
formula. No checksum bytes or reader compatibility changed in this repair.

## Verified installed rebuild

`CI=true pnpm verify` passes: 2,425 TypeScript tests pass, 15 are skipped,
with 160 passing test files and two skipped files. Repository line coverage is
90.33% (30,289/33,531), critical branches 100% (15/15), semantic regions 100%.
The complete native checks and tests also pass. A subsequent focused metric/report
run passes 27 tests; lint and `git diff --check` pass. Both
`CI=true URDIRA_RELEASE_TARGET=darwin-arm64 pnpm package:release` and
`CI=true URDIRA_RELEASE_TARGET=darwin-arm64 pnpm release:acceptance` pass,
including all 11 release gates.

The qualified runtime is retained in the artifact root's `integrity-repair/`:

- Archive SHA-256: `20391c46a22cad9cc70a00800eca9455591ccc25717c8dcf2ba207c29ee61711`.
- Worker SHA-256: `d323428923ed8d73b04d55da2405ae788bf2bb9785f8329c9c92af03382d7738`.
- `accepted-runtime-attestation.json` matches 219 composed runtime modules with
  the extracted archive and retains HEAD, dirty patch and untracked-source hashes.
- `accepted-release-report.json` retains the passed release gates.

The actual installed CLI registers the freshly prepared frozen VS Code worktree
into a new `/tmp/u2d/fixvsprobe` data root. Once source and structural frontiers
are complete/current or equivalent on the same source snapshot, the MCP probe
replays the formerly failing context request with only its explicit workspace
scope rebound. It succeeds: six results, 19,052 rendered characters, complete
index coverage and explicitly incomplete page coverage with continuation. A
separate full-body request returns both requested files in one complete page
(20,972 rendered characters), without truncated source. These sizes describe
the observation and are not acceptance thresholds.

`vscode-installed-mcp-probe.json` retains requests and responses. The probe uses
the installed stdio MCP launcher and does not retrieve source through shell.
`fresh-store-verification.json` and its log record a successful `StoreReader`
`verify_all()` over the entire rebuilt store, including the variable-length hot
files. The identical verifier continues to reject the retained original store
with its original mismatch. The saved original digest file has SHA-256
`239bd3dcd398483f54522d38280e9a16266f1f09b1cd3161fcc2ad5eb402ae3e`.

This demonstrates the repaired installed path on a full corpus, while preserving
failure detection. It is not a statistical claim about write speed or agent
adoption; the subsequent Luna sample is retained separately.
