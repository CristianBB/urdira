# Final Architecture Consistency Audit

Status: **Passed**  
Audited: 2026-08-08  
Scope: every authoritative Urdira architecture, registry, protocol, taxonomy, and product-foundation document

## Authority

This report records verification evidence; it does not define product semantics. Any conflict is resolved in favor of the linked authoritative decision, model, registry, or protocol document and requires this audit to be rerun.

## Mechanical results

Fresh checks from the project root produced:

| Check | Result |
|---|---:|
| Authoritative Markdown documents | 25 |
| Internal links missing | 0 |
| Unbalanced fenced blocks | 0 |
| JSON examples parsed / invalid | 24 / 0 |
| Universal model inventory rows | 400 |
| Duplicate model names | 0 |
| Provisional models | 0 |
| Named model heads absent from inventory | 0 |
| Stable operations / absent public contracts | 17 / 0 |
| Intent recipes | 11 |
| Canonical schema definitions / duplicates | 46 / 0 |
| Model-reference / inline schemas | 3 / 43 |
| Referenced schemas absent from registry | 0 |
| Canonical comparators / unresolved references | 18 / 0 |
| Modeled digest or legacy-hash fields / missing contracts | 142 / 0 |
| Initial operation-error codes | 46 |

The six `ArtifactChange.change_kind` values are enum members, not model inventory rows.

The operation count includes `core:find_records`. The recipe count includes the eight original task recipes plus `core:semantic_to_callers@1`, `core:resolve_and_find_references@1`, and `core:definition_to_instances@1`.

## Semantic collision results

No blocking collision remains. The audit verified these single authorities:

- candidate lifecycle and terminal states: the universal model;
- source-provider calls and absence authority: the universal model plus incremental-indexing behavior;
- plugin worker calls, staged-record identity, access manifests, and lookup invalidation: the plugin contract;
- canonical Schema IR coordinates: the core canonical-schema registry;
- every digest field: the digest-field registry;
- agent-queryable definition families: the universal registry model and public query contract;
- source-analysis and semantic completeness capabilities: the core taxonomy;
- operation arguments and wrappers: the public query contract;
- composed stages, guards, outputs, ranking bindings, and streams: the core intent-recipe registry;
- MCP behavior: the MCP server contract; and
- private daemon coordination: the daemon architecture, which exposes no second public protocol.

Historical capability aliases (`core:parsing`, `core:type_analysis`, `core:call_graph`, and `core:dependency_resolution`) were removed. The taxonomy now contains thirteen source-analysis capabilities and one core-only `core:semantic_retrieval` completeness capability. Language plugins cannot offer the latter. The public registry selector remains the intentional agent-queryable subset of the larger administrative registry-type union.

Candidate, cursor, source-provider, registry, recipe, and digest searches found no authoritative state, field, operation, or method using the rejected legacy identifiers `planned`, `ready_to_publish`, `artifact_classes`, the four obsolete provider method names, `projection_hash`, `response_budget_hash`, or `definition_to_references`. Their appearance in historical plans or this audit sentence is non-normative.

## End-to-end traces

| Scenario | Verified outcome |
|---|---|
| Stable file update | A watch hint causes stable read/reconciliation, complete invalidation, a generation-neutral candidate, atomic publication, and a new immutable snapshot. |
| Deletion then identical reappearance | Authoritative absence publishes first, closes old lifecycles, and reappearance publishes a later generation with new occurrence and lifecycle identities despite identical bytes. |
| Dynamic plugin cross-file read | The core context SDK returns only pinned base/staged views and automatically records the exact artifact access in the accepted manifest. |
| Empty lookup then matching addition | The empty result-set digest and selector dependency persist; later membership change invalidates the owning scope. |
| Consumed record changes | A record input adds its proved transitive artifact closure; any contributing artifact change invalidates the consumer. |
| Prerequisite enricher read | A dependent work item reads a locally validated staged record through its staged ID; no premature canonical record ID exists. |
| Plugin upgrade | Registry resolution, compatibility assessment, work planning, candidate indexing, and snapshot/registry/lock publication remain one atomic transition. |
| Two plugins supply identical language definitions | Byte-identical definition coordinates deduplicate to one language definition with two supplier occurrences. |
| Conflicting language definitions | Activation fails atomically with the exact compatibility issue before candidate publication. |
| Semantic materialization updating | Structural state remains usable; semantic coverage is pinned and reported partial with pending affected artifacts. |
| Semantic query over partial coverage | Retrieval is exact over the declared pinned vector set, while the response explicitly states that intended source-scope candidates may be missing. |
| Discovered definition to records | Only kind, facet, and language definitions pass the typed binder; `core:find_records` then enumerates exact structural membership. Empty discovery yields empty instances, never all records. |
| Symbol resolution to references | Confirmed declarations alone feed batchable reference lookup; possible candidates remain separate, multiple confirmed declarations union with provenance, and empty resolution yields empty references. |
| Registry `used` pagination | Each parent slice binds an immutable `RegistryUsageSet`; its forward/backward cursor remains usable after the parent result stream is exhausted. `none` and `used` do not disable other streams. |
| Frozen global status | Initial status capture persists exact workspace and issue sets; continuations never observe later live mutations. |
| Cursor after daemon restart | A committed ready execution and opaque cursor hydrate from persisted claims after restart without recomputation or reranking. |
| Incompatible live daemon | `urdira mcp` replaces it only through an idle restart lease; otherwise every tool returns `core:daemon_restart_required` and the live process is untouched. |
| Concurrent workspaces and agents | Explicit workspace IDs, immutable snapshot bindings, independent queues, and serialized per-workspace publication prevent cross-worktree or cross-agent scope confusion. |
| Commit succeeded but acknowledgement was lost | The committed current tuple is authoritative; recovery marks the candidate published and resumes cleanup without allocating or publishing another generation. |

## MCP verification

The MCP contract was rechecked on 2026-08-08 against the official [MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28), the official [TypeScript SDK repository](https://github.com/modelcontextprotocol/typescript-sdk), and its [v2 stdio serving API](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html). The official SDK identifies v2 as the stable line implementing MCP 2026-07-28 and exposes the split server package and `serveStdio` API used by the architecture.

## Conclusion

The architecture is internally closed and ready for implementation planning. Release-bound selections such as exact dependency versions, bundled model-pack coordinates, benchmark corpus commits, and minimum operating-system versions remain implementation/release gates rather than architecture gaps.
