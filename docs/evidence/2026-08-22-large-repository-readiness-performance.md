# Large-repository readiness performance

Date: 2026-08-22

## Scope and acceptance

This evidence qualifies the destructive Urdira v3 indexing path against every
large repository in the expanded TypeScript corpus. The acceptance condition
was eight sequential Urdira/TypeScript cells, all reaching source-first
structural readiness below the 5,000,000 KiB host RSS guard and all passing the
repository grader. Semantic indexing remained disabled, as specified by the
benchmark arm.

The frozen repositories were:

- `microsoft/TypeScript` at `b465fdbfe175304d9b977da137b2c178ae1091d3`;
- `microsoft/playwright` at `644132a6326cb12b0549b0f3c57071143c22b2bb`;
- `prisma/prisma` at `0f37454eec96b193e8b20e8f569e453acd2af644`;
- `microsoft/vscode` at `038b9225c82c6b75172beda6081c64887692538c`.

Runtime: Node `v24.18.1`, model `gpt-5.6-luna`, one sequential sample per
cell. Command:

```bash
node release/benchmarks/run-expanded-agent-benchmark.mjs \
  --samples 1 \
  --arms urdira-typescript \
  --output-dir /tmp/urdira-expanded-urdira-v21-final-20260822 \
  --node /Users/Cristian/.nvm/versions/node/v24.18.1/bin/node
```

The campaign gate passed with `expected_runs=8`, `successful_runs=8`, and
`failed_runs=0`. The raw audit SHA-256 is
`f005f58bd7add8c496ab060e185be78c101ed466daf995c7f3a7fc078630693a`.
Raw transcripts and host logs remain outside the repository; the derived,
sanitized report is committed as
`release/benchmarks/expanded-typescript-agent-benchmark-results-2026-08-22.json`.

## Final measurements

| Repository / task | Readiness | Peak RSS KiB | SQLite bytes | CAS bytes | Grader |
|---|---:|---:|---:|---:|---|
| TypeScript / transpile diagnostic | 42.172 s | 2,764,384 | 556,506,592 | 37,154,866 | passed |
| TypeScript / project event hook | 41.944 s | 2,818,080 | 587,988,448 | 38,366,155 | passed |
| Playwright / affected tests | 60.738 s | 1,497,344 | 673,033,720 | 29,134,777 | passed |
| Playwright / reporter isolation | 62.268 s | 1,893,760 | 698,482,720 | 29,134,061 | passed |
| Prisma / wire-name validation | 111.620 s | 1,619,376 | 1,045,631,920 | 45,425,448 | passed |
| Prisma / Mongo value-set transform | 118.882 s | 1,679,680 | 1,045,800,240 | 45,397,492 | passed |
| VS Code / registry notification | 469.065 s | 4,260,144 | 5,355,332,280 | 222,632,044 | passed |
| VS Code / provider idempotence | 467.016 s | 4,365,792 | 5,360,752,464 | 222,637,358 | passed |

This is one sample per cell. It establishes that every benchmark repository is
usable within the explicit memory guard; it is not a three-run P95 result.

## Performance changes

The accepted implementation preserves the public query surface, provenance,
closed registries, deterministic digests, immutable snapshots, pagination,
and failure semantics while removing corpus-sized hot-path retention:

- the JavaScript/TypeScript source-first stage performs bounded syntax analysis
  without constructing a type checker;
- large workspaces stream one owner request and accepted FactDelta at a time;
- CAS and FactDelta persistence use bounded batches and compact integer staging
  namespaces;
- initial publication streams occurrences, stores each canonical record body
  once, batches identity writes, and rebuilds empty secondary indexes in the
  publication transaction;
- the canonical record-set digest is an ordered O(1)-auxiliary-memory stream;
- large initial identity arrays use a closed seven-string transport tuple and
  are reconstructed and reverified by the publication authority.

Against the v16 campaign, the six cells that already reached readiness improved
from 199.7–334.7 s to 41.9–118.9 s: approximately 64.5% to 80.4% lower
readiness. The v16 VS Code cells stopped at the RSS guard before readiness;
both final cells now complete with 634,208–739,856 KiB of guard margin. Initial
VS Code publication in the final campaign measured 278.9–280.9 s.

The first complete pre-tuple campaign reached six of eight cells: one
TypeScript task failed its literal grader contract and one VS Code task exceeded
the memory guard by 31,168 KiB. The benchmark prompt now names the required
`onProjectEvent` hook explicitly, matching the existing deterministic grader,
and compact identity transport removed the remaining VS Code retention. The
final eight-cell campaign reran every repository with the same build and task
contract after both corrections; no retry result was substituted into it.

The complete repository gate subsequently found and corrected a v3 workspace
fork regression: identity assignment ownership is now derived through the
immutable record during fork copy, matching the v3 physical schema. That path
requires an existing donor workspace and does not execute in the benchmark's
fresh, isolated data roots; the indexed first-scan path measured above is
unchanged. The fork end-to-end regressions and exact multi-identity lookup are
included in the final 1,593-test gate below.

## Verification

Targeted verification performed during implementation:

- canonical/materialisation/publication tests: 179/179 passed;
- FactDelta/publication/storage tests: 174/174 passed;
- compact identity transport materialisation/publication tests: 134/134
  passed;
- `pnpm typecheck`: passed.

Final gates on Node `v24.18.1`:

- `pnpm verify`: passed; architecture and lint passed, 88 files / 1,593 tests
  passed, repository line coverage was 90.03%, critical branches and semantic
  regions were 100%, typecheck and publication hygiene passed;
- `pnpm package:release`: passed; five target archives were generated and
  inspected;
- `pnpm release:acceptance`: passed; install, unit, contract, integration,
  end-to-end, crash, corruption, security, watcher, benchmark, and package
  inspection gates all passed.
