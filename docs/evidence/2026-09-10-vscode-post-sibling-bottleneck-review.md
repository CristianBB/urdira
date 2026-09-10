# VS Code post-sibling bottleneck review

Date: 2026-09-10  
Status: analysis of retained evidence; no additional indexing pass was run.

## Evidence boundary

This review uses the retained `microsoft/vscode` structural pass at commit
`038b9225c82c6b75172beda6081c64887692538c`. Semantic indexing,
materialization, and sidecar creation were disabled. A retained earlier profile
reached a complete, current, ready frontier in 57.859 seconds; that profile is
not a measurement of the final implementation below.

The retained pre-change v4 pass used the same commit and structural-only
contract. Its hybrid phase was 779.777 seconds, cold worker total 785.601
seconds, and host readiness 820.366 seconds. The implementation described
below is now present in the working tree, but no post-change VS Code pass has
been run yet. The effect on those timings is therefore pending the single
declared VS Code evidence pass.

## Retained diagnostic cost profile

| Area | Retained pre-change observation | Interpretation |
|---|---:|---|
| Hybrid semantics | 14.862 s wall | Resolver reference point |
| Typeflow lookup | 2,493,632 calls / 112.102 aggregate CPU-s | Inclusive and parallel; do not add to member time |
| Member walk | 1,629,857 calls / 95.165 aggregate CPU-s | 58.388 us per measured call |
| Sibling conformance | 375,458 calls / 7.354 aggregate CPU-s | 19.588 us per measured call |
| Materialize pass 1 | 7.294 s | 5,447,239 input records |
| Materialize pass 2 | 8.992 s | 5,446,322 output records |
| Base durable write | 11.774 s | 2.120 GB body bytes reach the page cache |
| Publish call | 14.441 s | Includes the base write |

The aggregate resolver counters overlap: `member_walk` is measured inside a
`typeflow_lookup`, and owners run concurrently. They identify hot paths but do
not sum to wall time.

These are retained pre-change observations and are not a measurement of the
implementation described below. A post-change pass is required before any
improvement or regression claim can be made.

## Resolver findings

`resolve_static_member_reference` and `resolve_call_target_typeflow` both use
recursive `type_of_expression` resolution. A member expression that is also a
call callee can therefore resolve its receiver more than once. The two paths
apply different `instanceof` narrowing policy, so a shared global cache would
be unsound unless its key represented the complete local narrowing state.

`ProgramIndex::members` scans each reached container's member vector linearly,
recursively walks `extends` and sometimes `implements`, and finally sorts and
deduplicates the result. The final implementation adds an allocation-free own
member fast path: a unique own match returns immediately, while an own miss
continues into the existing walk without rescanning that receiver's own member
table. No post-change timing claim is made here.

The final implementation addresses the boolean
`has_known_subclass_override` path. When an outer member lookup misses the
receiver and its complete `extends` chain, it reuses `conformance_children`,
filters edges to direct `extends` relationships, and returns on the first
matching own member. The candidate-producing `sibling_extends_overrides`
operation retains its existing complete sorted and deduplicated result.

The boolean search keeps the existing cycle and depth bounds and does not add a
second persistent reverse index, synchronization, or transitive-closure
memory. This review records the design and its safety boundary; its measured
benefit remains pending the single VS Code pass.

## Recommended order

1. Add diagnostic counts for direct-member hits, inherited searches, and
   `has_known_subclass_override` calls. These counters remain opt-in under the
   existing semantic-performance flag.
2. Verify the final boolean subclass check's filtered traversal of
   `conformance_children`, returning on the first matching member. Keep the
   candidate-producing `sibling_extends_overrides` API unchanged.
3. Verify the allocation-free direct-member fast path to `members`, with the
   miss path continuing from the already-inspected container rather than
   rescanning it.
4. Run the single VS Code structural evidence pass. Only pursue contextual expression
   memoization if member-walk time remains dominant.
5. Treat materialization separately. Pass 2's largest components are assemble
   (3.479 s), subject resolution (2.549 s), and dictionary work (1.345 s).
   Any further resolver win is ultimately capped by the 16.286-second
   materialization and 11.774-second durable-write work now visible.

## Required correctness gates

The reverse traversal must match the existing extends-only result on ordinary,
diamond, cyclic, wide, depth-32, and depth-33 graphs. Incremental add, replace,
and remove sequences must remain equal to a fresh `ProgramIndex::build`.
Member lookup tests must retain own-member precedence, overload ambiguity,
unresolved-ancestor uncertainty, implements fallback, deterministic candidate
ordering, and the current pending rather than guessed behavior.

No change should introduce a process-global member cache. A generation-local
cache would still need explicit invalidation for changed containers, heritage,
imports, reexports, and affected descendants. The final implementation uses
the existing reverse index and local own-member fast path instead. Its measured
effect is pending the single VS Code structural pass.
