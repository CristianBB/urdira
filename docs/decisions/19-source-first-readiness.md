# Source-First Readiness and Layered Publication

Status: **Approved**

## Decision

Urdira publishes the generic source catalog before language-plugin analysis. A
source snapshot contains the exact visible artifact identities, versions,
digests, content references, provider watermark, and lexical coverage. A
structural snapshot references exactly one source snapshot; semantic
materialization references exactly one structural snapshot.

Language-plugin absence or failure therefore cannot invalidate source
discovery. It makes structural capabilities `unavailable` or `unknown` and
keeps the source snapshot queryable. A crash after source publication leaves
that source snapshot visible and never exposes a partial structural
publication.

## Agent-visible readiness

The v3 index-status response derives these booleans; they are not independent
stored flags:

- `source_ready`: source availability is `available`, completeness is
  `complete`, and freshness is `equivalent` to current source.
- `structural_ready`: structural availability and completeness are complete,
  and the structural snapshot is based on the current source snapshot.
- `semantic_ready`: semantic availability and completeness are complete, and
  the materialization is based on the current structural snapshot.

Layer fields use closed values:

- `availability`: `available | unavailable`;
- `completeness`: `complete | partial | unknown | unsupported | stale`;
- `build_state`: `not_started | building | idle | failed | disabled`;
- `freshness`: `equivalent | changes_pending | degraded`.

`partial` means that queryable partial data exists. `unknown` means that the
capability must not be treated as queryable. `changes_pending` means a newer
source generation is being reconciled; `degraded` means the last valid
snapshot remains available but current coverage cannot be proven.

The status response also exposes `operation_availability`, including the
required layer, retryability, reason code, and retry delay for blocked
operations. Source-safe operations are `core:find_artifacts`, source-projection
`core:search_text`, and artifact-selector `core:get_source`. Pipelines and
recipes inherit the strongest layer required by any stage.

## Compatibility

Index Status API v1 and v2 retain their existing structural-snapshot behavior.
MCP defaults to v3 and does not advertise an output schema. Query API v1
retains the structural-snapshot requirement. Query API v2 may bind source-safe
operations to a `source-snapshot:<generation>` identifier; structural queries
continue to require a structural snapshot.

The authoritative response shapes are `SourceSnapshot`,
`WorkspaceReadinessView`, `IndexLayerReadinessView`, and
`OperationAvailabilityView`, carried by the generated fields on
`WorkspaceIndexStatusView` and `WorkspaceCapabilityStatusView` in the
contracts package. The MCP tool descriptions and server instructions repeat
the exact state meanings so an agent can act without guessing.
