# MCP Server Contract

Status: Approved initial contract  
Verified against MCP: 2026-07-28  
Last verified: 2026-08-26

## Purpose

This document is the authoritative transport contract for exposing Urdira through the Model Context Protocol. A coding agent configures and launches exactly one command, `urdira mcp`; no separate adapter package, daemon endpoint, private protocol, or workspace session is exposed. The local browser uses the same factory through `urdira web` at its token-free same-origin `/mcp` route. Internally either composition may attach to Urdira's durable per-user daemon, but that boundary cannot appear in schemas or configuration.

The initial implementation targets the stable `2026-07-28` MCP revision and the stable v2 line of the official TypeScript SDK. It uses `McpServer` and `registerTool` from the split `@modelcontextprotocol/server` package and the current `serveStdio(factory, options)` entry point from `@modelcontextprotocol/server/stdio`. It must not use the superseded manual `StdioServerTransport` plus `server.connect(transport)` wiring or build new code on the legacy monolithic `@modelcontextprotocol/sdk` v1 API.

An implementation release pins exact SDK package versions in its lockfile and records the supported MCP revisions in release metadata. Before each release, CI checks the current stable MCP specification and official TypeScript SDK release line. Adopting a later MCP revision requires a compatibility review and conformance update; it never silently changes Urdira public API semantics.

## Engine attachment and startup

`urdira mcp` verifies the data root, operating-system owner, exact engine build, and private-interface compatibility before forwarding any Urdira operation. It starts its matching daemon when none is live and shares a compatible existing daemon across simultaneous agent processes.

A different live engine build is never contacted optimistically. The MCP server may request a private restart lease, which the daemon can grant only when no publication, migration, administrative operation, other client, or in-flight request makes restart unsafe. A granted lease drains admission and performs graceful replacement. If a lease is unavailable, the MCP server remains available for MCP discovery and tool schemas but every Urdira tool returns `core:daemon_restart_required` with the detected build, required build, data root identity, blocking reason, and recovery actions. It never kills the live process or edits its ownership metadata.

## Protocol era and discovery

MCP `2026-07-28` is the primary modern, stateless protocol era. Urdira implements it as follows:

- There is no `initialize`/`initialized` handshake and no MCP session identifier.
- Every request carries `io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities`, and any client identity supplied by the client in request `_meta`.
- The adapter implements `server/discover` and advertises exact supported MCP revisions, `serverInfo`, and only the capabilities it actually implements. `serverInfo.name` is `urdira`; `serverInfo.version` is the exact Urdira runtime release version and is release-authority tested against every publishable manifest.
- The adapter rejects an unsupported modern revision with MCP `UnsupportedProtocolVersionError`, including the exact supported revisions.
- MCP request metadata selects protocol behavior only. It never selects a Urdira workspace, snapshot, query execution, cursor, plugin, or configuration.

The initial stdio adapter is dual-era for coding-agent interoperability. It calls `serveStdio` with the legacy posture explicitly set to `serve`, rather than relying on an SDK default. A modern opening selects the `2026-07-28` per-request-metadata behavior; a legacy opening selects the SDK's supported 2025-era `initialize` lifecycle for that stdio connection. Both paths build the same five-tool server from the same factory and preserve identical Urdira domain semantics. Legacy connection state may select only MCP wire behavior and must never select a workspace, snapshot, query execution, cursor, plugin, or configuration.

Removing legacy support or changing the selected legacy revisions is a release compatibility decision with explicit conformance evidence. It does not change the Urdira public query API, but it must be announced because it can prevent an older host from connecting.

## Advertised capabilities

The initial adapter advertises only the MCP `tools` server capability. It does not advertise resources, resource subscriptions, prompts, completion, sampling, roots, elicitation, logging, Tasks, MCP Apps, or any other extension.

The adapter also sets the top-level `instructions` field of the initialize/discover result. It is a deterministic, progressively disclosed agent manual in this order: a four-step quick start, a five-tool decision guide, expression selection, a minimal direct query, the pipeline mental model and executable examples, readiness and result guidance, then the exact operation and recipe catalogs. The pipeline section defines `arguments` as static inputs, `bindings` as typed edges from an earlier `{stage_id, output}` to a downstream argument, `outputs` as the final exposed streams, complete-set propagation, topological ordering, and scalar-cardinality failure. It includes tested `search -> source`, `resolve -> references`, and `resolve -> references -> source` examples plus recovery guidance for invalid output names, selector shapes, readiness, and cursors.

The exact operation signatures and recipe catalog in `instructions` are generated directly from the same registries used to validate requests. Every registered operation must appear once in the categorized usage guide; missing guidance or duplicate coverage fails server construction. `instructions` is plain descriptive text, not a capability, and advertising it does not imply resources, prompts, or any other extension.

The tool set is static for the lifetime of an adapter release and is returned in deterministic name order. The adapter explicitly advertises `tools.listChanged: false`; it does not rely on the SDK default, because registering the first tool otherwise enables list-change support. Tool additions, removals, or incompatible schema changes require a new adapter release and process restart. On modern connections, `tools/list` uses the MCP `2026-07-28` list-response shape, including `resultType`, cache metadata supported by the SDK, and MCP's opaque `nextCursor` when the catalog ever exceeds one page. The SDK emits the negotiated legacy list shape on legacy connections. Any MCP list cursor is a transport catalog cursor and has no relationship to Urdira query cursors.

The five tool names are:

- `urdira_query`
- `urdira_context`
- `urdira_analyze_change`
- `urdira_build_context`
- `urdira_index_status`

Names are unique, case-sensitive, stable within the API major, and restricted to MCP's portable tool-name character set.

## Tool definitions

Every tool definition contains:

- a stable `name` and concise human-readable `title`;
- a concise `description` explaining when to use it, how it differs from the other four tools, explicit workspace scope, continuation behavior, and Urdira's read-only guarantee; `urdira_query` also carries a self-contained pipeline primer so clients that omit server instructions still receive the essential binding rules;
- an `inputSchema` generated from the authoritative Urdira public schema;
- annotations `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`.

In the default `agent` profile no tool declares an `outputSchema`. A 2026-08-14 benchmark found that Claude Code's MCP client reads only `structuredContent` -- never the `content[0].text` block below -- whenever a tool's `tools/list` entry carries an `outputSchema`. The compact agent rendering therefore remains the complete compatibility surface. In the `web` profile, the same internal successful-or-operation-error union is passed to `registerTool` as `outputSchema`, and calls return the matching validated `structuredContent` for browser consumption. Profiles never change tool names, input schemas, domain requests, or result semantics.

`urdira_index_status` defaults to Index Status API v3. Its readiness fields are
actionable: `source_ready` means a complete equivalent source catalog,
`structural_ready` means complete structural facts based on that source, and
`semantic_ready` means complete semantic materialization based on the current
structural snapshot. `availability`, `completeness`, `freshness`, and
`build_state` use the closed values documented by the source-first readiness
decision. Agents should follow `operation_availability`; they must not infer
that `partial` means unavailable or that `unknown` is queryable.
The compact rendering includes a copy-ready `query_scope` object for every
workspace. Clients reuse that object byte-for-byte; `workspace_id` is opaque
and must not be retyped, abbreviated, normalized, or synthesized.

The `inputSchema` uses JSON Schema 2020-12. Every object is closed with `additionalProperties: false`, every union has an explicit discriminator, and every agent-visible field has the description required by the public query contract. Pipeline schema descriptions explicitly distinguish static stage `arguments`, dependency `bindings`, topological stage order, operation-specific stream names, and final declared `outputs`. The generated schema is validated using the SDK's supported schema integration and retained as a release fixture so that SDK upgrades cannot alter it silently.

MCP annotations are descriptive hints, not the security boundary. The daemon protocol and Urdira authorization rules independently enforce that all five operations are read-only.

## Tool calls and results

On a modern connection, `tools/call` follows the MCP `2026-07-28` result model:

- A completed call returns `resultType: "complete"`.
- In the agent profile no result carries `structuredContent`, so a client is guaranteed to find the full result in `content`. In the web profile the complete wrapper is also returned in `structuredContent`; `content` remains equivalent.
- `content` contains exactly one text block. By default it is Urdira's compact, grep-like plain-text rendering of the public wrapper value; an undocumented `render: "json"` debug argument (accepted at runtime but never advertised in any schema, description, or the server instructions) instead puts the complete JSON-serialized wrapper in that same text block.
- A successful Urdira operation sets `isError: false` or omits it when the SDK's exact type permits omission.
- A recoverable Urdira `OperationError` returns the typed error wrapper as compact JSON in `content[0].text` and sets `isError: true`. The agent therefore receives the registered diagnostic code, retryability, recovery actions, and closed details needed to correct the call.

Arguments that fail the advertised tool `inputSchema` are rejected by the official SDK before the handler runs and return a bounded, safe `isError: true` tool result so the agent can correct the arguments. Because no valid Urdira request exists at that point, this SDK-owned validation result is not required to contain an Urdira `OperationError` wrapper.

MCP protocol errors are reserved for MCP-level failures: invalid JSON or JSON-RPC structure, an unknown method or tool, a malformed `tools/call` envelope rather than invalid tool arguments, an unsupported protocol revision, or an unrecoverable adapter failure before a valid Urdira operation result exists. Domain failures such as an unknown workspace, stale cursor, incomplete required coverage, unavailable index, or invalid operation interaction are Urdira `OperationError` tool results rather than JSON-RPC errors.

The adapter never returns `input_required`: Urdira's MCP surface is read-only, non-interactive, and all required query choices are explicit in the original call. It does not opt any tool into task-augmented execution.

On a legacy connection, the official v2 SDK emits the wire shape required by the negotiated 2025-era revision. The logical Urdira wrapper, typed operation-error content, explicit workspace scope, cursor semantics, ordering, and completeness are identical across eras. Era adaptation cannot add or remove a domain field or reinterpret an Urdira result.

## Urdira result pagination

Urdira result pagination is application-level state carried through explicit tool arguments and results:

- An initial `urdira_query` call materializes and scores the complete ordered result manifest before returning its first page.
- A returned Urdira cursor is an opaque, persistent handle to that execution, snapshot binding, stream, projection, and position.
- Continuation calls invoke `urdira_query` again with the `continuation` request variant and the exact original workspace scope.
- Forward and backward continuation tokens, expiration, cache reuse, and error behavior remain those of `QueryResultPage` and `ContinuationRequest`.
- `urdira_index_status` likewise accepts explicit initial and continuation variants. Its workspace, activation-issue, and candidate-issue cursors hydrate one frozen `IndexStatusExecution` and never observe later control-plane mutation.
- Query and status cursors have disjoint kinds. Passing either token to the other tool returns `core:cursor_kind_mismatch` without attempting hydration.
- Registry mode `used` gives each hydrated parent slice one immutable `registry_usage_set_id`; its cursor continues that exact definition set even when all parent result streams are summary-only. Mode `none` disables only registry hydration, while every other selected stream remains pageable.
- The agent must not decode, edit, compare semantically, or confuse these tokens with MCP `tools/list` cursors.

This explicit-handle design is required by modern MCP because protocol connections have no session state. Adapter restarts do not invalidate a ready Urdira execution that remains retained by the daemon.

## Progress

When a client includes an MCP `progressToken`, the adapter may translate bounded daemon progress into rate-limited `notifications/progress` messages. It must preserve the exact client token, emit monotonically increasing progress values for that request, omit `total` when it is not known, and stop notifications when the call completes or is cancelled.

Progress is advisory and cannot alter the query plan, result membership, ordering, completeness, timeout, or response budget. Indexing progress that outlives the request remains visible through `urdira_index_status`; it is not represented as unsolicited MCP progress.

## Cancellation and process lifecycle

Over stdio, the client cancels an active call with `notifications/cancelled` referencing the JSON-RPC request ID. The adapter maps that request to its private daemon cancellation identity, stops work as soon as practical, releases request-local resources, and sends no later response or progress message for the cancelled MCP request.

Cancellation affects only the active query materialization or hydration described by the daemon contract. It never deletes a ready cached execution, cancels continuous indexing, changes a workspace, or performs administration. Unknown, malformed, late, or already-completed cancellation notifications are ignored as required by MCP.

The MCP server exits promptly when stdin reaches EOF. Stdout contains only newline-delimited UTF-8 JSON-RPC messages with no embedded newlines; diagnostics go to stderr. An unexpected MCP-server exit loses in-flight MCP requests but does not corrupt daemon state or invalidate retained ready query executions.

## stdio binding

The `urdira mcp` command uses the official TypeScript SDK v2 `serveStdio` factory entry point with explicit dual-era serving. The coding-agent host launches this one Urdira subprocess and communicates through stdin/stdout. The MCP server:

- reads one valid JSON-RPC request or notification per line from stdin;
- writes one valid JSON-RPC response or notification per line to stdout;
- never writes banners, logs, stack traces, or human-readable diagnostics to stdout;
- writes bounded, secret-safe operational diagnostics to stderr only;
- carries all modern MCP metadata in the JSON-RPC request body because stdio has no HTTP header layer;
- never exposes any private daemon framing, encoding, endpoint, build negotiation, or lifecycle message on the MCP stream.

Daemon delegation is an implementation detail. MCP request IDs, progress tokens, and cancellation IDs are translated into private correlated identities and are never reused as authority tokens.

## Security and privacy

The adapter validates MCP envelopes and generated tool schemas before forwarding a request. It applies response and concurrency ceilings, sanitizes all agent-visible output, and preserves the path and secret-handling rules of the security specification. MCP results contain normalized workspace-relative paths or approved safe URIs, never absolute host paths, daemon sockets, cache paths, environment values, credentials, stack traces, or plugin scratch data.

No MCP authorization layer is required for either local binding. Local authority derives from the operating-system user launching the adapter and the owner-restricted daemon channel. The Streamable HTTP binding is available only inside foreground `urdira web`; it binds exclusively to `127.0.0.1`, validates same-origin and Host headers, has no CORS or remote-bind mode, and does not expose daemon IPC.

## Conformance gates

An adapter release must pass:

- official SDK protocol tests for the exact pinned v2 packages and supported MCP revision;
- modern `server/discover`, unsupported-version, `tools/list`, and `tools/call` fixtures;
- legacy `initialize`, era pinning, tool-list equivalence, tool-call equivalence, and unsupported-revision fixtures through the same `serveStdio` factory;
- deterministic tool ordering and schema snapshot tests;
- JSON Schema 2020-12 validation for every minimal, maximal, and invalid public fixture;
- agent-profile no-`outputSchema`/no-`structuredContent` byte-compatibility tests and web-profile schema/structured-content equivalence tests;
- loopback Streamable HTTP tests using the pinned official client without application credentials, including discovery, tool calls, errors, cancellation, and cursors;
- protocol-error versus `OperationError` mapping tests;
- MCP catalog-cursor and Urdira result-cursor separation tests;
- progress monotonicity, cancellation race, stdin EOF, stdout purity, and adapter restart tests;
- compatible daemon sharing, no-daemon startup, safe idle replacement, busy incompatible-daemon refusal, and `core:daemon_restart_required` fixtures;
- a release audit against the current stable MCP specification and official TypeScript SDK migration notes.

Any mismatch is a release blocker. MCP compatibility is an adapter property; it cannot be repaired by weakening or silently changing Urdira's domain contracts.

## Normative upstream references

- [MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP versioning and compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP stdio binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
- [MCP tools contract](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP progress](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress)
- [MCP cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation)
- [Official TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk)
- [Official TypeScript SDK v2 tool errors](https://ts.sdk.modelcontextprotocol.io/v2/servers/errors.html)
- [Official TypeScript SDK v2 stdio serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html)
- [Official TypeScript SDK v2 legacy-client support](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html)
