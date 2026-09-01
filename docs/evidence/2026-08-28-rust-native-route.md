# Rust native route implementation evidence

Date: 2026-08-28

## Scope verified

- Rust is the exclusive owner of JavaScript/TypeScript source decoding,
  Oxc parsing, declaration/import extraction, direct and reverse graph state,
  affected-set calculation, and stage-one fact/dependency construction.
- Native-bound TypeScript stages reject work without the exact
  Rust-authoritative changed/affected scope. Owner requests narrow that scope
  to the verified transitive closure without selecting a second analysis key.
- A Rust-authoritative workspace retains one TypeScript checker even when the
  development worker count is configured above one.
- After checker preparation, owner publication and stage three reuse verified
  content hashes and metadata without rereading or decoding the same CAS blobs.
- Stable partial source observations advance source generation. A repeated
  watcher hint with no source transition returns equivalent without creating,
  analyzing, sealing, or publishing a candidate.

## Real native quick sample

Host: macOS arm64, Node 24.18.1, native addon and persistent Rust worker,
59-file JavaScript/TypeScript fixture. `URDIRA_ANALYSIS_WORKERS=4` was set to
prove that the native route still admitted one checker. This sample is
diagnostic evidence, not the three-campaign acceptance result.

| Phase | Cold plugin analysis | Cold total | Incremental plugin analysis | Incremental total |
|---|---:|---:|---:|---:|
| Rust structural stage 1 | 200 ms | 576 ms | 20 ms | 183 ms |
| TypeScript semantic stage 2 | 399 ms | 529 ms | 34 ms | 152 ms |
| TypeScript type stage 3 | 213 ms | 353 ms | 25 ms | 148 ms |

The incremental stage-three checker work itself was 5 ms. Its remaining
approximately 107 ms seal plus publication cost shows that the immediate hot
path after this migration is ordered digest sealing and SQLite publication,
not repeated TypeScript parsing. A duplicate watcher hint completed as an
equivalent source reconciliation in 25 ms and did not enter Rust, TypeScript,
sealing, or publication.

Compared with the immediately preceding native route sample before the final
exclusive-scope fix, cold staged indexing fell from 1,700 ms to 1,458 ms
(14.2%). The cold semantic-stage plugin cost fell from 655 ms to 399 ms
(39.1%) because owner publication no longer selected a second legacy
TypeScript analysis key.

## Verification

`pnpm verify` passed after the final implementation:

- Rust: 29 tests passed; `fmt` and `clippy -D warnings` passed.
- TypeScript: 116 test files passed, 2 skipped; 1,892 tests passed, 6 skipped.
- Coverage: 90.37% lines; critical branches 100%; semantic regions 100%.
- Typecheck, lint, architecture, coverage gate, publication hygiene, and
  `git diff --check` passed.
- A separate real native controller run completed all 60 sequential mutations.

The exact vector kernel remains active. Its retained darwin-arm64 report shows
1.47x large-workload kernel throughput, 31.65% end-to-end improvement, 9.32%
peak-RSS reduction, exact ordered equivalence, and no small-query regression.

## Remaining release evidence

The implementation and host-native route are complete, but five-target release
qualification is not. Local `pnpm package:release` failed closed when the
`darwin-x64` addon, worker, launcher, and private Node closure were absent. The
same real packaging and acceptance campaign must run on darwin-x64,
linux-arm64-gnu, linux-x64-gnu, and win32-x64; cross-compilation alone is not
release evidence. The three independent macOS-arm64/Linux-x64 performance and
whole-process RSS campaigns required by Decision 25 also remain pending.

