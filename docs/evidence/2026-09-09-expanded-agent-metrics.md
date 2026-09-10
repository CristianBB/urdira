# Expanded agent benchmark measurement instrumentation

Date: 2026-09-09  
Status: implemented and verified without executing a benchmark campaign

## Scope

The next baseline, Urdira, codebase-memory MCP, and CodeGraph comparison now
records the agreed cell outcomes and efficiency measurements. Urdira readiness
ends at the current complete structural frontier. Semantic indexing,
materialization, and semantic-sidecar creation are excluded; creation of a
semantic sidecar rejects the cell.

## Recorded evidence

- repository grader result, declared changed-path coverage, required-pattern
  coverage, focused-test presence, and declared omissions;
- observed discovery before the first edit and after every edit batch, with the
  selected MCP/non-MCP tool recorded without making it a gate;
- repository-discovery calls, returned context characters, and the bounded
  declared-target unattributed-context proxy;
- test, typecheck, and lint attempts with numeric exit codes, with unknown
  outcomes retained when the transcript has no exit code;
- setup, agent, and total wall time; turns; input, cached input, output, and
  reasoning tokens; disclosed estimated-cost rate card; MCP counts and errors;
- one comparable cell-runner-and-descendants process-tree RSS/CPU scope for all
  arms, plus Urdira host-only readiness diagnostics;
- Urdira structural readiness, catalog/lexical/structural/Rust-sidecar/CAS
  bytes, copy telemetry where emitted, and an asserted zero semantic size;
- host capacity/load, source state and diff digest, corpus/tooling hashes,
  executable hashes, and effective runtime controls in the audit environment
  manifest.

Missing measurements remain `null`. Grader success, executed tests, and the
unattributed-context proxy are reported as distinct concepts.

## Verification

The focused transcript, process-tree, semantic-sidecar, smoke-scope, and report
tests exercise the measurement boundary and serialization. The full repository
gate is recorded in the handoff for this change.
