# Latency, isolation, and agent integration evidence

This increment records the implementation evidence available in the repository
checkout. Workspace scans already emit durable stage timings for enumeration,
source cataloging, plugin analysis, sealing, publication, and total readiness;
storage debug timing additionally reports publication sub-buckets when
`URDIRA_STORAGE_DEBUG_TIMING=1` is enabled.

Queries are admitted through the daemon's foreground `query` scheduler lane,
with a reserved global slot ahead of lower-priority semantic work. Structural
readiness is reported immediately after the structural publication commit;
lexical and semantic reconciliation remains asynchronous.

The bridge contract and installer have focused coverage for supported Glob
translation, unsupported Grep fail-open behavior, dry-run installation, and
managed uninstall. The focused query/scheduler/storage/bridge suites pass and
`pnpm package:release` passes for all configured targets after filtering
platform-specific optional native dependencies during archive staging.

Verification was rerun with the repository-supported Node `v24.18.1` runtime:
`pnpm verify` passes all 73 test files and 1,481 tests, including the 100%
critical-branch coverage gate. `pnpm package:release` passes all five targets,
and `pnpm release:acceptance` passes install, unit, contract, integration, E2E,
crash, corruption, security, watcher, benchmark, and package-inspection gates.
The earlier failures under Node `v24.14.0` were runtime compatibility failures,
not unresolved publication or manifest defects.

Real-client acceptance with current Claude Code, Codex, and OpenCode releases
and independent Tier S/M latency measurements remain operational follow-up
evidence; they are not fabricated by the repository test suite.
