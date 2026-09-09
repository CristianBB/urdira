# Local web interface

Status: Accepted
Last updated: 2026-08-26
Depends on: [Daemon, MCP integration, and packaging](10-daemon-mcp-packaging.md), [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md), and [Configuration, security, and lifecycle](09-configuration-security-lifecycle.md)

## Decision

`urdira web` is a local, single-user composition root owned by the Urdira CLI.
It binds an HTTP listener only to `127.0.0.1`, serves the bundled React
application, exposes the registered CLI catalog under `/api/v1/cli`, exposes a
directory-only picker under `/api/v1/directories`, and mounts the public MCP
server at `/mcp` using Streamable HTTP. It is not an independently installed
server and it is not a daemon transport.

The private daemon remains IPC-only. `@urdira/web` depends on `@urdira/cli`,
`@urdira/mcp`, and public contracts; it never depends on the engine, storage,
or SQLite and never opens a workspace database. Administrative requests invoke
the same in-process CLI parser, descriptors, previews, confirmation gates, and
handlers as terminal requests. The web surface cannot construct a shell
command, start `web` or `mcp` recursively, or expose private daemon calls.

## CLI HTTP contract

The versioned local routes are:

- `GET /api/v1/cli/commands` for every closed `CliCommandDescriptor`;
- `POST /api/v1/cli/preview` for the ordinary CLI dry-run plus a one-use web
  proposal identifier and digest;
- `POST /api/v1/cli/execute` for registered commands only, with the matching
  proposal and digest when confirmation is required;
- `GET /api/v1/cli/operations/:id/events` for bounded SSE progress and terminal
  state;
- `DELETE /api/v1/cli/operations/:id` only when the descriptor permits
  cancellation; and
- `GET /api/v1/directories`, which returns directories but never files.

All request objects are closed and versioned. Command arguments are arrays and
registered options are values; neither is interpolated into a shell. `mcp` and
`web` appear as already-active service descriptors and are not executable from
this API.

When a registered CLI option accepts a closed value set, its descriptor's
`input_schema` advertises that set as an enum. The local UI derives selectors
from that schema instead of maintaining an independent parser. Agent status,
installation, and removal therefore expose `all` plus every supported client;
the agent hook exposes individual clients only, and integration scope exposes
the only supported value, `user`. Web-managed proposal identifiers and option
spellings that duplicate a positional argument are intentionally omitted from
the generated form, but remain part of the underlying CLI transport contract.

## MCP presentation profiles

The MCP domain tools and input schemas remain one shared implementation. The
`agent` presentation profile is the default selected by `urdira mcp`: it keeps
the five existing tools, compact `content[0].text`, and advertises neither
`outputSchema` nor `structuredContent`. This compatibility surface is frozen by
snapshot and byte-equivalence tests.

`urdira web` selects the `web` profile. Its `tools/list` entries advertise the
reserved structured output schema and successful or operation-error calls also
return schema-validated `structuredContent`. Text content remains equivalent.
The profile changes presentation only: scope, ordering, evidence, completeness,
readiness, result membership, truncation, and cursors are produced by the same
domain call. The hidden diagnostic `render` field is not advertised by either
profile and is not used by the web application.

## Workspace and Codebase navigation

Every worktree is an independent `Workspace`. `Codebase` is Urdira's explicit,
user-managed grouping for related worktrees and is unrelated to any external
codebase-memory product. Workspace registration persists the captured Git
common-repository identity, ref, revision, detached state, dirty state, and
capture time when Git is available.

Exact captured Git common-repository identity automatically groups worktrees;
non-Git directories receive an independent Codebase. Creating, renaming, or
manually assigning a Codebase remains an explicit confirmed CLI operation, and
unassigning creates a new independent project. The UI presents searchable
Project and Workspace selectors in a persistent top context bar, but every MCP
request still carries the selected `workspace_id` explicitly. Workspace removal
retains its recoverable tombstone; physical purge is a distinct advanced action.

## Local security boundary

The listener has no remote-bind option and emits no CORS policy. SPA, CLI API,
directory picker, and MCP share one origin. The local interface does not use a
session or bearer token: `/api/v1/*` and `/mcp` are available only through the
foreground command's loopback listener and are never exposed by a remote-bind
mode.

The server validates `Host`, `Origin`, method, media type, and request size. It
sets a same-origin CSP, `Referrer-Policy: no-referrer`, `X-Content-Type-Options:
nosniff`, and `Cache-Control: no-store` on dynamic responses. It never logs
directory paths. Directory navigation excludes files and symbolic
links; authoritative source-root, symlink, and inclusion checks remain in the
CLI preview and security contracts.

## User interface and packaging

`@urdira/web` bundles React 19.2.8, React DOM 19.2.8, Vite 8.2.2,
Cytoscape.js 3.34.1, and the official MCP client 2.0.0 without a CDN. The
application provides Workspaces, Search, Explorer, and Graph views, with CLI
and MCP grouped as advanced tools. Search maps lexical, semantic, and hybrid
presets to `core:search_text`, `core:search_semantic`, and
`core:search_hybrid`; each request carries object-shaped freshness with its
required frontier. Public results use cards, tables, trees, source views, and
structured Cytoscape nodes and edges. The MCP view is a schema-driven request
composer: advertised object fields, closed enums, booleans, variants, and
arrays become guided controls; operation-specific argument objects remain
directly editable as JSON. Common query templates provide valid starting
requests. A synchronized manual JSON mode permits the exact same parameters an
agent can submit, validates against the advertised schema, and reflects valid
manual changes back into the guided form. Raw schemas and responses remain in
an explicit technical inspector. The query composer also presents the two
normative API v3 dependency examples: text search bound into source retrieval,
and symbol resolution bound into reference discovery. Each example can be
loaded as an editable request and is shown as upstream stage output, downstream
argument binding, and declared final outputs. The guide states that bindings
pass the complete logical set and that scalar targets require exactly one
upstream result. These helpers construct ordinary `urdira_query` inputs and do
not add a web-only MCP operation, field, or response projection. Cursor,
coverage, readiness, and truncation information remains visible, and graph
sampling is labeled rather than presented as complete data.
Workspace cards and affected views expose the latest scan-failure code and
time. A safe `core:reindex` retry is offered through the registered CLI preview
and confirmation path. A failed scan does not disable the whole interface:
operations listed as available may explicitly pin the retained current
snapshot and report it as stale, while individually blocked operations show
their readiness reason before execution. Closed project, workspace,
indexed-artifact, and indexed-symbol choices use selectable controls; free text
is retained only for genuine search or open-ended contract fields.
Periodic no-change reconciliation is presented as **Checking for updates** via
the local administrative `indexing_activity`; **Indexing** is reserved for an
initial scan, explicit reindex, recovery, or watcher-triggered source change.
This distinction does not add a field to agent-profile MCP results.
Indexed-artifact and indexed-symbol controls are searchable without permitting
an arbitrary value to become query scope, and duplicate symbol labels retain
enough qualified context to be distinguishable. The primary visual result and
choice surfaces suppress generated build output while the exact structured
response remains available in the Advanced inspector. Wide or nested MCP and
CLI collections render as responsive key-value cards instead of compressing
their fields into unreadable columns. Exact operations expose staged progress;
query result groups expose their immutable total and persistent previous/next
navigation independently of response-budget truncation. Because continuation
responses need not carry a reverse cursor, the client retains already visited
immutable pages locally so Previous never reruns or reranks the query. Exact
text matches are grouped by source file while preserving every occurrence and
its indexed line. Search,
outline, source, reference, and architecture output uses operation-specific
presentation models. The primary view leads with a human name, translated kind,
workspace-relative path, source line, available snippet, and match explanation;
opaque identities remain available only in technical details. A selected symbol
retains its exact context artifact and indexed byte position when the downstream
operation accepts them; all outline continuation pages contribute to its
searchable choice list, and same-name occurrences are never collapsed. The
graph starts at depth one, displays human node and
relationship labels, exposes the same relationships in an accessible table,
offers continuation when another relation page exists, and provides fit and
zoom controls so expansion does not make the initial view unusably dense.
The interface provides persistent light and dark themes, honors the operating
system preference on first use, remains keyboard accessible, and adapts its
navigation and context controls for narrow viewports.

The package is part of the production allowlist and release dependency closure.
Conformance requires agent-profile compatibility, real loopback HTTP MCP
tests with the official client, CLI preview/confirmation integration, directory
privacy tests, architecture enforcement preventing storage dependencies, and
browser flows for workspace, query, navigation, graph, removal, and purge.
