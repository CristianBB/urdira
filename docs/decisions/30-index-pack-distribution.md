# Decision 30: index pack distribution (rule R20)

Status: **Closed (2026-09-07 — rule R20, plan `generic-waddling-hartmanis.md` §0)**
Last updated: 2026-09-09
Depends on: [Index pack](23-index-pack.md), [v4 structural store](26-v4-structural-store.md), [v4 merkle bucket digests](27-v4-merkle-bucket-digests.md), [v4 Rust-owned scan pipeline](29-v4-rust-owned-scan-pipeline.md)

## Context

Decision 23 defines the v3 index-pack container (gzip/NDJSON row carrier).
Decision 26 adds a separate, v4-specific binary container
(`urdira-index-pack-v4`, schema version 1) and its own export/import path
(`exportV4IndexPack`/`importV4IndexPack`), because v4 has no per-row
representation of its structural corpus — it is a binary mmap segment
store, not SQLite rows. Both v3 and v4 export/import are self-contained
and tested, but neither was, as of decision 26, wired into any daemon RPC
or into a distribution layer that would let one machine's index pack be
fetched and imported by another over a network (a "pack store" — `Frente
C`/`D5` in the plan). This decision records the owner-authorized
evaluation of whether building that distribution layer is worth it, and
closes the question by rule rather than leaving it open indefinitely.

## Rule R20

From plan `generic-waddling-hartmanis.md` §0: a pack-distribution layer is
justified only if, at real repository scale,

```
pack_bytes / (50 MB/s) + import_wall + reconcile_wall(noop) < 0.5 * cold_v4_wall
```

**and** the imported workspace's query results are byte-identical to a
freshly cold-scanned one (`different == 0` on the standing v3/v4 parity
oracle). The left-hand side approximates "fetch the pack over a modest
network link, then bring it current with a no-op reconcile"; the right-hand
side is half of what a plain cold scan already costs on the same machine.
If distributing a pack is not at least twice as fast as just re-scanning,
building the transport and storage layer for it (`Frente C`, a `PackStore`)
is not worth the complexity.

## Measurement (VS Code corpus, 2026-09-07)

`docs/evidence/2026-09-07-v4-vscode-campaign.md` §6-§7 measured every term
against a real `ready` v4 VS Code workspace (18,049-file frontier):

| term | value | source |
|---|---:|---|
| `pack_bytes` | 1,571,126,244 (1.57 GB gzip; decompresses to 3,913,041,719 bytes) | §6.1 |
| `pack_bytes / (50 MB/s)` | 31.42 s (decimal MB/s; 29.97 s under a MiB/s reading — the conclusion is insensitive to which convention is used) | §7 |
| `import_wall + reconcile_wall(noop)` | 25.459 s (`ready_elapsed_ms` for a same-tree import against a fresh data root, whose scan lands as `scope: reconcile`, `mode: "noop"`, `total_ms: 3,451`; `import_wall` itself is not separately instrumented — approximated as `ready_elapsed_ms - reconcile_wall ≈ 22.0 s`) | §6.2 |
| **LHS** | 56.88 s (31.42 + 25.459; 56.43 s under the MiB/s reading) | §7 |
| `cold_v4_wall` (VS Code, median) | 29.96 s (`docs/evidence/2026-09-07-v4-vscode-campaign.md` §1) | §1, §7 |
| **RHS** (`0.5 * cold_v4_wall`) | 14.98 s | §7 |

`56.88 s < 14.98 s` is false by a factor of **~3.8x**. The gate fails even
in the most favorable case for distribution — dropping the transfer term
entirely (as if the pack were already local, zero transfer cost) still
leaves `import_wall + reconcile_wall(noop) = 25.459 s > 14.98 s`. The root
cause is structural, not a measurement artifact: v4's cold scan is now fast
enough (~30 s at VS Code scale) that the pack mechanism's own fixed
overhead — staging copy, Merkle re-verification, workspace-identity
rewrite, and a reconcile scan that always re-walks the whole corpus even
in the no-op case (decision 29's "Reconcile: git-aware catch-up") — can no
longer clear half that bar, regardless of how the pack bytes themselves are
transported. This conclusion does not depend on the `different == 0`
parity gate at all: the numeric gate alone fails by a wide enough margin
that parity was not the deciding factor.

## Decision

**C (pack transport/distribution) is CLOSED. D5 (a dedicated `PackStore` /
distribution layer) is not implemented.** Per R20's own text, the pack
transport work item (`Frente C`, §8 of the evidence document) was not
attempted in the measurement session, and no `pack-store.ts` or equivalent
code exists. What ships today is exactly what decisions 23 and 26 already
define: local, single-machine export/import (v3's NDJSON/gzip carrier and
v4's `urdira-index-pack-v4` binary container), reachable through the
`core:index_pack_export`/`workspace-add --index-pack` surface, with no
network fetch, no remote pack registry, and no cross-machine orphan
detection. A pack exported on one machine can still be copied by hand
(e.g. `scp`, a shared filesystem) and imported on another — that mechanism
is unaffected by this closure, only the idea of building dedicated product
infrastructure around it is rejected.

## Consequences

- No engineering time is spent on a `PackStore`, pack registry, or network
  transport for index packs unless a future re-measurement shows the
  inequality flip (e.g. a much slower network link where the transfer term
  dominates differently, or a much larger corpus where cold-scan cost grows
  faster than pack-import overhead).
- Distributing a v4 workspace between machines today means either a fresh
  cold scan on the destination machine, or a manual pack copy + import
  (decision 26's `exportV4IndexPack`/`importV4IndexPack`), whichever is
  more convenient operationally — both are equally correct, and R20 found
  the manual pack copy is not reliably faster.
- The v4 import path's own reconcile-after-import behavior (an imported
  database already carries `generation > 0`, so the daemon runs a
  `reconcile`, not a `full`, scan even on `isFirstScan`) is retained
  regardless of this closure — it is required correctness (bringing an
  imported snapshot current with the destination's actual tree), not
  itself part of the rejected distribution layer.

## Reopening this decision

A future re-measurement could reopen R20 if either side of the inequality
moves materially: a slower or metered network (raising the effective
transfer rate below 50 MB/s in practice), a much larger corpus (where cold
scan cost grows faster than the fixed import/reconcile overhead), or a
cheaper import path (e.g. an `import_wall` that skips the full-corpus
reconcile walk for a freshly-imported, provably-untouched tree). Absent
new measurement, this decision stands.
