# Sibling-conformance reverse-index validation

Date: 2026-09-10  
Status: one directed structural validation pass of the direct reverse-index
prototype. No full campaign, agent, MCP client, or query was run. After this
pass, adversarial review replaced the query's plain visited set with
minimum-depth tracking and borrowed entity IDs. That follow-up prevents a
long path from masking a shorter path and removes per-visit ID clones; it was
verified by focused and integrated tests but was deliberately not followed by
a second full-corpus pass.

## Protocol

The pass used the same `prisma/prisma` commit and structural-only contract as
the final profiled reference:

`0f37454eec96b193e8b20e8f569e453acd2af644`, `URDIRA_SEMANTIC_INDEX=0`,
semantic materialization disabled, one analysis worker, one analysis pool lane,
one structural lane, and zero reconciliation sweep interval. The current
Urdira checkout was copied to a private temporary source root, where the
worker was built with:

```bash
RUSTUP_TOOLCHAIN=1.98.0 \
  CARGO_TARGET_DIR=<temporary-build-root> \
  cargo build --release --locked -p urdira-indexing-worker
```

The worker ran once through the existing host wrapper until a complete,
current structural frontier was observed. The temporary worker emitted only
diagnostic counters; production source files were not modified. Raw evidence is
preserved in the benchmark archive under
`luna-sibling-optimized-20260910/evidence/urdira-prisma-sibling-optimized.host.log`:

SHA-256: `d83a4a8f6244d097f9590dd61a67597cfc8c5d558e5ea1ff69000fe37c57d391`.

The generated result is retained beside it as
`urdira-prisma-sibling-optimized.result.json` (SHA-256
`e67b8cda3a578bad3a8560a85e7a0638b7c9d64d06a3a392e554ec717d3a87c5`).

## Validation results

| Metric | Optimized pass | Final profiled reference | Delta |
|---|---:|---:|---:|
| typeflow full extraction | 67 ms | 66 ms | +1.5% |
| typeflow index build | 159 ms | 150 ms | +6.0% |
| reverse conformance index build | 831 us | unavailable | new telemetry |
| `hybrid_semantics` | 6,215 ms | 42,224 ms | **-85.28%** |
| `run_cold_total` | 7,109 ms | 43,094 ms | **-83.50%** |
| queryable frontier | 12,671 ms | 48,496 ms | **-73.87%** |
| completed durable | 12,855 ms | 48,644 ms | **-73.57%** |
| host structural readiness | 13,563 ms | 49,197 ms | **-72.43%** |

The reverse index contained 54,206 containers, 802 non-empty ancestor buckets,
and 1,196 direct reverse edges. The existing semantic telemetry recorded
18,685 sibling-conformance calls and 472 microseconds aggregate sibling time,
compared with 369,946,570 microseconds in the reference. Typeflow lookup time
fell from 395,478,584 to 24,199,194 microseconds, and member-walk time from
309,061,439 to 15,663,683 microseconds.

The telemetry converts every individual call duration to integer microseconds
before aggregation. Most optimized lookups therefore contribute zero and the
472-microsecond aggregate is at the timer's reporting floor; it must not be
used to claim an exact speedup ratio. The matched `hybrid_semantics` and cold
wall timings above are the meaningful end-to-end comparison.

The relevant semantic and publication counts were identical between passes:

| Count | Optimized | Reference |
|---|---:|---:|
| affected paths / hybrid owners | 4,510 / 4,510 | 4,510 / 4,510 |
| semantic sites | 1,014,192 | 1,014,192 |
| typeflow lookups | 359,077 | 359,077 |
| sibling-conformance calls | 18,685 | 18,685 |
| materialize input records | 793,652 | 793,652 |
| materialized records | 793,088 | 793,088 |
| dependencies / subjects | 8,008 / 119,036 | 8,008 / 119,036 |
| pending sites | 173,027 | 173,027 |
| graph entries | 674,048 | 674,048 |
| semantic SQLite / Rust sidecar bytes | 0 / 0 | 0 / 0 |

This establishes parity for the observed structural counts and candidate
resolution invocation count. The pass did not independently dump every
candidate ID; the existing reverse-index oracle tests remain the correctness
check for exact result equality.

## Resource and storage observations

The 500 ms process-tree sampler recorded, through the readiness boundary, peak
RSS of 4,383,216 KiB, maximum aggregate CPU of 926.4%, mean aggregate CPU of
373.0%, and two processes. The reference recorded 4,682,208 KiB peak RSS,
937.2% maximum CPU, and 799.4% mean CPU through readiness. These are one-pass
observations, not a distribution or P95 claim.

Optimized storage was 2,924,544 bytes catalog SQLite, 166,834,176 bytes
lexical SQLite, 793,382,672 bytes structural store, 45,391,284 bytes CAS,
zero semantic/sidecar bytes, and 1,047,610,095 bytes total. The structural
store, CAS, and semantic byte counts match the reference; the lexical/catalog
and total byte differences are retained as observed run-to-run differences.

The wrapper remained alive while its shutdown path drained after readiness and
was then terminated with `SIGTERM`; its 266.226-second wrapper lifetime is
therefore excluded from the readiness and scan metrics above.

## Post-pass implementation verification

Adversarial review found that a plain visited set could process a convergent
node through a long path before a shorter one and then suppress valid bounded
descendants. The final query records the minimum observed depth per borrowed
entity ID and revisits a node only when the new path is shorter. Focused tests
cover that diamond, cycles, 40 direct implementers, depths 32 and 33, pass-2
`CallMember` heritage, `extends` to `implements` replacement, removal, and
incremental-index equality with a fresh build.

The final implementation passed:

```text
cargo fmt --all -- --check
cargo check -p urdira-jsts-typeflow --tests
cargo clippy -p urdira-jsts-typeflow --all-targets -- -D warnings
cargo test -p urdira-jsts-typeflow --lib                 # 79 passed
cargo test -p urdira-jsts-syntax-worker --lib            # 338 passed, 1 ignored
cargo check -p urdira-indexing-worker
git diff --check
```

The measured direct reverse-index prototype adds a small cold-build step and
reduces `hybrid_semantics` by 85.28% in this matched directed pass, while the
sibling timer reaches its per-call reporting floor and all listed counts stay
unchanged.
The post-pass minimum-depth/borrowed-ID change retains the same direct index
and result contract; its exact full-corpus timing is not claimed here. This is
validation evidence for the selected design, not a release or multi-sample
performance claim.
