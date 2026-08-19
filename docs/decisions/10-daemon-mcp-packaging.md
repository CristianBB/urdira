# Daemon, MCP Integration, and Packaging

Status: **Approved**  
Last updated: 2026-08-19
Depends on: Query API, workspace model, storage architecture, and lifecycle configuration

## Decision objective

Define the local process architecture, MCP adapter, workspace registry access, installation, updates, and supported operating environments.

## Existing constraints

- One local daemon may maintain multiple concurrent workspaces.
- MCP queries explicitly include `workspaceId` for one workspace or the complete participant list for an approved comparison; connection state never selects source scope implicitly.
- The MCP tool surface is small and its schemas are concise and self-explanatory.
- Workspace discovery is available through global index status.
- Urdira does not modify source files or expose arbitrary commands.
- MCP exposes active plugin, resolution-lock, capability, and activation-attempt status but cannot mutate plugin state.
- Runtime plugin contracts, registry contracts, package versions, capability contracts, stored-index decoders, and public query API versions negotiate independently under exact persisted locks.
- Urdira ships one core-owned local code embedding provider, but no model weights or preinstalled model pack. The approved 0.1 flow downloads `Xenova/all-MiniLM-L6-v2` only during an explicitly confirmed configuration operation, reports the download to the user, and remains offline during startup, indexing, querying, pagination, and replay. This 2026-08-13 owner decision in [decision 18](18-semantic-model-pack.md) supersedes earlier preinstalled-pack requirements. Language-plugin packages cannot contain embedding models, tokenizers, renderers, segmenters, generators, or inference runtimes.
- One canonical deterministic model-pack manifest and its digest-addressed asset set define the logical installation independent of delivery. Every asset records its exact digest, decoded byte length, media type, and semantic role, and every declared asset is mandatory for that pack identity. The local content-addressed store deduplicates identical blobs across packs.
- An offline distribution may bundle the manifest and all blobs. An explicit online administrative installation may retrieve the same blobs using delivery locators stored outside the canonical manifest. URLs, mirrors, credentials, transport headers, compression, and archive layout are non-authoritative and cannot change pack identity.
- Pack publication is atomic after complete local verification. The daemon never downloads models during startup, indexing, query execution, pagination, or replay; missing local content produces explicit unavailable state until administrative repair.
- Model-pack installation uses no signature, key, trust-store, certificate, or publisher-authentication mechanism. The administrator explicitly authorizes one exact canonical manifest digest. Digests establish byte identity and integrity only; claimed authorship, provenance, licensing, evaluation, catalog placement, and source URL remain unauthenticated statements. A conflicting manifest under the same pack ID and version is rejected rather than resolved by publisher claims or delivery origin.
- Canonical pack coordinates are `model_pack_id + model_pack_version + manifest_digest`. IDs are stable namespaced identifiers within the local installation, versions use normalized SemVer 2.0.0, and manifests are immutable. The digest omits only its own field. Exact-triple reinstall is idempotent; changing any canonical field requires a new version; reusing coordinates with another digest is a hard collision.
- The manifest directly embeds a non-empty, duplicate-free, canonically ID-ordered set of complete `EmbeddingProfile` definitions. Urdira validates and recomputes every `profile_digest` before reading model assets. Profile definitions are never hidden in an asset or fetched separately. Exact profile definitions across packs are registry-deduplicated with pack-reference accounting only when their complete four-role runtime-requirement sets and both runtime-configuration envelopes are also identical; any definition, runtime, or configuration difference under one profile ID rejects the candidate installation.
- Every manifest asset uses `ModelPackAssetEntry` and has no local ID or canonical path. Exact decoded bytes are addressed only by `content_digest`; length and media type validate storage, while the closed semantic role describes use. Entries are canonically ordered by role and digest. Built-in declarative model/tokenizer manifests reference shards and subordinate blobs directly by digest, with explicit shard order, same-pack closure, and acyclic references.
- `ModelPackManifest` is a closed seven-field model containing only `manifest_schema_version`, pack ID and SemVer, complete embedded profiles, complete assets, exact required core runtime components, and `manifest_digest`. The digest covers the other six fields. Publisher and delivery metadata are not accepted in the canonical manifest.
- Each `ModelPackRuntimeRequirement` binds one embedded profile and one of exactly four roles—document renderer, query renderer, segmenter, or generator—to an exact platform-neutral component ID, behavior release, behavior digest, and contract version. Every profile has all four roles exactly once. Packs contain no build IDs, implementation digests, platform alternatives, ranges, fallbacks, or executable implementations.
- Each embedded profile has exactly one `segmenter` and one `generator` `ModelPackRuntimeConfiguration` asset using deterministic Urdira CBOR. The envelope repeats the exact requirement coordinates, selects the exact closed configuration schema pinned by the core component contract, carries a fully typed value, and digests all envelope fields except the digest itself. Asset and logical digests verify independently. Segment and vector projections, materializations, and query bindings retain the corresponding exact configuration digest; no environment, path, arbitrary flag, platform detection, or adaptive default may change behavior.
- A `ModelAssetManifest` is a canonical-CBOR `model_manifest` asset that binds provider, model, immutable revision, closed engine architecture and format, ordered configuration digests, and non-empty ordered weight-shard digests. Its logical `model_identity_digest` must equal the profile field; its separate asset content digest covers the complete encoded bytes. All referenced blobs are same-pack, role-correct, and explicit.
- A `TokenizerAssetManifest` is a canonical-CBOR `tokenizer_manifest` asset binding tokenizer ID, immutable revision, closed engine format, optional ordered configuration digests, and non-empty ordered tokenizer-data digests. The lists are disjoint, same-pack, role-correct, and positionally interpreted by the format. Its logical digest matches the profile while its separate content digest covers encoded bytes. Segmenter and generator must support the exact tokenizer format.
- An `input_template` asset is direct strict UTF-8 `text/plain`, not another manifest. Document and query contracts resolve it by recomputed `template_digest`; the storage `content_digest` covers the same bytes under another domain. Renderer version and contract version exclusively define the closed placeholders and escaping rules. Templates cannot include files, assets, environment values, URLs, commands, or code.
- The first release has no built-in pack supply. Its configured neural profile binds the exact provider/model revision and local runtime identity defined by the semantic wiring decision.
- `model_pack_id + model_pack_version` creates a permanent local coordinate reservation for one manifest digest. Each uninterrupted installation and each supplied profile are separate monotonic occurrences. Removing and later reinstalling exact content creates new occurrences, while a conflicting digest remains rejected permanently.
- Installation derives the portable portion of `EmbeddingProfileExecutableBinding` from the exact profile digest, four behavior requirements, two runtime configurations, and complete operational asset closure. Several active pack supplies may share it. Workspace activation adds four exact local builds to create an executable binding. New configurations require an active supply and compatible builds; already pinned work may retain its executable binding after the last supply ends.
- Install and repair work remains staged and invisible until one atomic transaction publishes all registry records and storage roots. Cancellation or failure leaves no partial installation. Removal releases roots but never deletes blobs directly; global reachability collection decides when content is safe to reclaim. Corruption or missing bytes marks only affected profiles unavailable until exact repair succeeds.
- Runtime builds are local Urdira component records outside model packs. Activating a profile resolves exactly one currently selectable build for each portable requirement and commits all four build IDs and implementation digests into the executable binding. Old builds remain retained while pinned work needs them. A cross-platform move without identical builds preserves structural data but rebuilds semantic materializations under a new binding.

## Process architecture

One Urdira daemon owns one configured data root and maintains all workspaces registered there. It contains the workspace scheduler, source providers, canonical validator, storage engine, projection workers owned by the core, semantic runtime, query engine, cursor cache, and local administrative coordinator. Language and framework plugins execute only in supervised child workers under the approved isolation contract.

The product exposes MCP directly through `urdira mcp`. That command is the coding agent's single server entry point: it serves MCP on stdio, starts the matching per-user daemon when none exists, or attaches to the compatible daemon already maintaining the selected data root. The agent never installs, configures, addresses, or reasons about a second Urdira protocol or process.

The MCP boundary and CLI do not open workspace databases, read repositories, load plugins, generate embeddings, issue their own cursors, or infer workspace scope. Internally they delegate durable work to the daemon so watchers, indexes, workers, cursor caches, and concurrent agents survive one MCP stdio process. That delegation channel is a private implementation boundary, not a supported public API.

The daemon separates four scheduler pools: source observation, structural analysis, semantic projection, and queries. Publication remains serialized per workspace, while read queries and independent workspaces execute concurrently. Query admission has priority over background semantic work; source deletion and freshness barriers have priority over ordinary background indexing.

## Startup, discovery, and single instance

The data root contains a fixed endpoint descriptor and an operating-system lock file. POSIX hosts bind an owner-restricted local socket under that root; Windows derives a deterministic named-pipe identity from the same endpoint path so no filesystem socket is attempted. Startup acquires an exclusive non-advisory process lock where available, creates a random boot ID, binds the local endpoint, writes a descriptor containing only protocol versions, endpoint identity, process ID, boot ID, and start time, then marks readiness after catalog and current-snapshot verification.

A second process first connects and performs the handshake. If the existing daemon responds, the second exits successfully and reports its endpoint. If the descriptor exists but connection fails, the process verifies the OS lock and process identity; it may replace stale endpoint metadata only after acquiring the lock. PID reuse or descriptor age alone never authorizes takeover.

Startup phases are `locking`, `catalog_verification`, `workspace_recovery`, `provider_reconciliation`, and `ready`. The local query endpoint becomes available after catalog verification and serves last-known-good snapshots while individual workspaces recover. Status exposes each workspace phase. Mutating administrative operations wait for global readiness; read-only queries need only the selected verified snapshot.

The daemon is normally started on demand by the first `urdira mcp` or CLI request and may optionally be registered as a per-user background service. There is no machine-wide multi-user daemon in the initial architecture.

Before forwarding a request, `urdira mcp` verifies that the live daemon belongs to the same operating-system user, data root, engine build, and compatible private interface. When no live daemon exists, it starts the daemon from its own exact engine installation and waits for verified readiness. Compatible concurrent MCP servers share it.

If a different live engine build owns the data root, automatic replacement is permitted only through a daemon-granted restart lease. The old daemon grants that lease only while it is idle: no publication or migration transaction is open, no administrative operation is active, and no other client or retained in-flight request depends on that process. The lease blocks new admission, performs graceful shutdown, releases the ownership lock, and allows `urdira mcp` to start its matching build. A lease denial, timeout, active transaction, active client, incompatible storage requirement, or ownership mismatch leaves the old process untouched and makes every Urdira tool call return `core:daemon_restart_required` until the user completes the explicit update/restart action. Urdira never sends optimistic private requests to an incompatible daemon and never kills a live process merely because a PID or endpoint exists.

## Private daemon boundary

The daemon interface is intentionally not a public Urdira protocol. Its framing, encoding, transport, handshake, and message layout are implementation details that may change with the engine build and are not part of plugin, MCP, query, storage, or compatibility contracts.

Every implementation must nevertheless preserve these invariants: the channel is local and owner-restricted; peer, engine build, data root, and compatibility are verified before domain payloads; requests and responses are typed, bounded, correlated, cancellable, and explicitly workspace-scoped; unknown versions and fields fail closed; progress and operation errors remain distinct; the MCP boundary never opens storage or runs plugins; and daemon restart recovery preserves committed snapshots and ready cursor executions. Cross-user and remote daemon access are unsupported.

## MCP server

The coding agent launches `urdira mcp` as one stdio MCP server. The MCP module is packaged in the Urdira executable and has no independently configured endpoint, daemon version, or workspace session. It targets the stable MCP `2026-07-28` modern protocol era through the stable v2 line of the official TypeScript SDK, explicitly serves compatible 2025-era clients through the v2 `serveStdio` factory, and exposes the four approved tools: `urdira_query`, `urdira_analyze_change`, `urdira_build_context`, and `urdira_index_status`. MCP connection state selects wire-era behavior only; every source-reading call validates explicit scope. The exact binding is authoritative in the [MCP server contract](../protocol/mcp-adapter-contract.md).

Tool input schemas are generated from the authoritative public API schema registry as JSON Schema 2020-12. Every object sets `additionalProperties: false`; every union has a discriminator; every agent-visible field has a concise description covering meaning, presence, default, limits, units, ordering, interaction, and cursor behavior. Shared definitions are generated once and schema snapshots are conformance-tested against the logical models. The tools intentionally do not advertise `outputSchema`: completed calls return `resultType: complete` with one compact plain-text block in `content[0].text` (or the explicit debug JSON rendering), because the current MCP adapter contract requires agents to consume the compact text projection and does not emit `structuredContent`. The official SDK emits the negotiated legacy wire shape on legacy connections. Urdira operation failures use typed `isError: true` tool results, while malformed MCP envelopes remain JSON-RPC protocol errors.

The tool description for `urdira_query` tells the agent to use one pipeline or recipe when later steps depend on earlier results, rather than spending another MCP turn. It includes a compact semantic-to-callers example and a registry-discovery-to-filter example. Continuation uses the same tool with `ContinuationRequest`; the agent never reconstructs or decodes cursor claims.

Over stdio, `notifications/cancelled` maps the referenced MCP request to its private daemon cancellation identity and produces no later MCP response for that request. Cancellation cancels only the active request before manifest readiness or the current hydration operation. It does not delete a ready execution, cancel automatic workspace indexing, remove data, or mutate source. Transport loss leaves a ready cached execution usable through any already returned cursor until expiry; a not-yet-ready unreferenced execution may be cancelled by policy.

Modern MCP request metadata is carried in every JSON-RPC request; it selects MCP behavior only and never supplies hidden Urdira scope. The adapter implements `server/discover`, advertises only the static tools capability, and uses no `initialize`/`initialized` handshake or MCP session identifier on modern connections. A legacy opening uses the initialization lifecycle required by its negotiated 2025-era revision through the official v2 SDK path, pins that connection's wire era, and remains isolated from modern behavior and Urdira scope.

An optional future network MCP transport must be a separate security design. The initial daemon does not bind TCP, HTTP, WebSocket, or a remotely reachable MCP endpoint.

## Progress and cancellation

Workspace status exposes source observation watermark, latest published generation, freshness state, candidate phase, total and completed artifact/projection work, semantic coverage counts, current issue summaries, and estimated completion only when a bounded estimate exists. Progress counters are monotonic within one candidate; a replan creates a new candidate identity instead of moving counters backward.

Automatic indexing is continuous and is not cancellable from read-only MCP. Administrative CLI may suspend a workspace or cancel one candidate. Cancellation waits for safe request boundaries, marks the candidate cancelled, preserves the current snapshot, and releases staged work through ordinary cleanup. Resuming performs reconciliation and creates a new candidate.

Plugin/model installation, migration, backup, restore, verification, repair, and purge expose their own persisted administrative operation progress. Their cancellation semantics are those approved in the lifecycle specification.

## Multi-client isolation and quotas

All accepted clients belong to the same verified local OS user but receive independent connections, request IDs, cancellation namespaces, rate limits, and temporary resource accounts. One client cannot cancel another client's work using a guessed ID. Cursor possession plus exact original workspace scope is required for continuation, but cursors are not treated as cross-user security credentials because cross-user access is denied at transport.

Snapshot and result data are shared safely through immutable execution bindings. Response budgets, query work budgets, concurrent query count, and query-cache admission are enforced per connection and globally. Administrative operations require the CLI client kind; workspace add/configure use an interactive detection proposal, destructive operations use an interactive or explicitly scripted confirmation contract, and idempotent daemon stop is direct. MCP connections are never authorized for them.

## Crash and restart

The process manager may restart the daemon automatically after unexpected exit with bounded exponential backoff. On startup the daemon applies the approved WAL, candidate, publication, migration, installation, and GC recovery protocols before declaring affected workspaces fresh.

Client requests active at the crash fail with a transport error. Ready query executions whose catalog and manifest commits verify remain continuable after restart because cursors name persisted executions and do not bind the old boot ID. Materializing executions without a committed ready manifest fail and are collected. Already published snapshots remain authoritative.

Repeated daemon crashes stop automatic restart after the platform service threshold and preserve state for manual inspection. Repeated crashes in one plugin quarantine that exact build without taking down the daemon or other workspaces.

## CLI scope

The `urdira` CLI provides:

- read-only `status`, `workspace list/show`, `query`, `continue`, `verify status`, and schema/version inspection;
- administrative `workspace register/relocate/suspend/resume/remove/purge`;
- `plugin inspect/install/activate/upgrade/downgrade/rollback/remove` from explicit local packages;
- `model-pack inspect/install/repair/remove` from offline bundles or explicit authorized downloads;
- `backup`, `restore`, `verify`, `repair`, `migrate`, `gc`, and retention-pin management; and
- `daemon start/stop/status/logs`.

The dependency-free bootstrap additionally provides `runtime prepare/status`. Runtime preparation is the sole package-manager exception: after dry-run and explicit confirmation it may install only the exact engine-matched `@urdira/runtime` package from the fixed public npm registry into Urdira's versioned private runtime root, under the closed warning and lifecycle-script policy in decision 09. It exposes no package, version, registry, npm-option, or script-approval input. The composed runtime itself never invokes a package manager.

Neither layer offers general shell execution, build/test execution, source editing, patching, Git checkout, hook invocation, arbitrary package-manager execution, or arbitrary plugin methods. `query` uses the same public API and exact schemas as MCP. Destructive or executable-state commands resolve exact targets, print the dry-run plan, and require the lifecycle confirmation contract.

CLI syntax is validated before daemon resolution. `daemon stop` is a direct idempotent command: it never starts a missing daemon, contacts an existing endpoint when present, and otherwise returns `already_stopped`. `workspace add` and `workspace configure` show their detected technology/plugin proposal and ask for interactive confirmation; `--dry-run` remains an optional preview, while destructive administrative operations retain explicit `--confirm`.

## Distribution

The first public entry package is the dependency-free `urdira` npm bootstrap, supported on Node.js `>=24.18.1`. `npm install --global urdira` therefore installs no transitive runtime package and emits no Urdira-owned deprecation or unreviewed-lifecycle-script warning. The composed application is published separately as the exact-versioned internal `@urdira/runtime` package, whose public dependency closure remains under `@urdira/*`. `@urdira/testkit`, source fixtures, benchmark transcripts, and development configuration are excluded. Scoped packages use public access, exact internal package versions, the MIT license, and the same repository provenance. The JavaScript/TypeScript analyzer keeps its independently governed package version instead of being rewritten to the application version.

`urdira --version`, `urdira --help`, and `urdira runtime status` work before runtime preparation. Any command requiring the composed application first presents the same runtime-preparation dry-run on an interactive terminal; it never prepares implicitly on a non-interactive CLI or MCP invocation. `urdira runtime prepare --confirm` is the explicit scriptable path. Preparation discloses the minimum npm version required for strict install-script enforcement, that ONNX Runtime, Sharp, Parcel Watcher, and protobuf execute their exact reviewed installation scripts, and that the current Transformers.js closure contains the known deprecated `boolean@3.2.0` package. The bootstrap captures npm output, records that acknowledged notice, rejects any other warning, validates the installed closure, and atomically activates the versioned runtime. Subsequent commands execute the exact private runtime entry point without package-manager access.

Neither npm package bundles Node.js. During confirmed runtime preparation, platform-native dependencies are selected by npm for the installation host and must pass the supported-platform CI and package smoke tests. Deterministic per-platform archives remain a secondary offline distribution and bypass npm runtime preparation: they contain the daemon, CLI, MCP adapter, schema registry, and required runtime dependency closure, but no model weights. Both delivery forms expose the same application and protocol contracts.

Publication is staged from the production allowlist rather than from the workspace manifests directly. The runtime package and complete dependency closure publish before the bootstrap, whose embedded runtime coordinate must match exactly. The staging gate rejects bootstrap dependencies, `workspace:*` ranges, private or test-only dependencies, missing license/readme files, source/test payloads, and version drift. Official npm publication uses npm trusted publishing with provenance after the package namespace and workflow are configured; the initial namespace bootstrap may require a one-time interactive publish by an organization owner.

No model pack is published or bundled in the 0.1 line. A future proposal to reintroduce one must first supersede the explicit rejection in decision 18.

Plugin packages contain one logical manifest and may contain several explicitly listed executable builds. Installation selects one verified compatible build; package and build digests are pinned separately. The initial project publishes no implicit online plugin dependency resolver. Administrators install an explicit local `.urdira-plugin` bundle whose complete closure is present.

Official archives may also be delivered directly or through common system package managers. Updates never occur during indexing or querying and are never silently downloaded by the daemon. Engine replacement stops the old daemon, verifies storage compatibility read-only, migrates if needed, and starts the new daemon; failed migration restores the previous executable and database checkpoint.

## Supported environments and watchers

The initial architecture targets current supported macOS, Linux, and Windows desktop/server releases on x86-64 and ARM64 where the full sandbox and deterministic runtime conformance suites pass. Exact minimum OS versions are release metadata rather than logical index identity.

- macOS uses FSEvents for hints plus file-identity and authoritative directory reconciliation.
- Linux uses inotify for hints; fanotify may be an optional verified backend, with the same reconciliation contract.
- Windows uses `ReadDirectoryChangesW` plus volume/file identity and authoritative reconciliation.

Watcher events are never trusted as complete state. Network-mounted, case-changing, normalization-changing, or unstable filesystems are supported only when the directory provider's stable-read and reconciliation tests pass; otherwise registration reports the provider as unsupported or degraded.

The storage and CAS root must support atomic same-filesystem rename, durable file sync, locking, and SQLite WAL semantics. Unsupported filesystems are rejected before mutable state is created.

## Independent version negotiation

The following axes remain independent and are all explicit:

- private daemon-interface compatibility bound to the exact engine build;
- MCP protocol revision and protocol era;
- MCP adapter schema/tool version;
- public query API version;
- canonical encoding and storage-format versions;
- registry contract version;
- plugin runtime contract version;
- plugin package version and executable-build digest;
- capability contract versions;
- source-provider and projection-generator contract versions;
- embedding profile, model-pack, portable behavior, and local runtime-build identities; and
- recipe and ranking-profile versions.

Modern MCP revision handling occurs independently at the MCP boundary on every request; it does not weaken private daemon compatibility. Workspace locks and snapshots resolve plugins, capabilities, registries, configuration, and semantic bindings independently. `urdira mcp` cannot make a different engine build interpret an unsupported stored contract, and a daemon upgrade cannot rewrite a retained lock silently.

The daemon supports the current public API and at least the immediately previous major when a lossless adapter exists. Removal of decoder or adapter support is blocked while retained snapshots or executions require it, unless the administrator first expires or exports that state explicitly. Status reports every blocking retained contract before upgrade.

## End-to-end acceptance

Packaging conformance first installs the bootstrap globally in a clean npm environment and requires an empty warning stream and zero dependency closure. It then proves dry-run/confirmation behavior, refuses non-interactive implicit preparation, prepares the exact runtime with only the disclosed known upstream notice, rejects an injected new warning, and proves atomic recovery from interrupted preparation. Runtime acceptance then launches two simultaneous adapters, proves single-daemon behavior, discovers multiple workspaces without implicit selection, executes and paginates a composed query, restarts the daemon between pages, isolates a crashing plugin, recovers an interrupted publication, validates peer permissions, verifies that archives contain no model weights, and rejects every incompatible version axis with its exact error.

## Completion criteria

A coding agent can discover workspaces, issue explicitly scoped queries, paginate results, and survive daemon restarts through the documented installation and independent protocol-version handling. Implementation acceptance requires the end-to-end scenarios above.

## Native semantic containment amendment

The daemon never loads the native ONNX binding. A persistent neural query host
owns it, and each semantic maintenance reconciliation runs in a one-shot child
that opens and closes storage before returning its result. IPC is correlated
and bounded; abort cooperates for two seconds on POSIX and ten seconds on
Windows, then escalates to `SIGTERM` and `SIGKILL` one second later. The longer
Windows grace preserves the child's committed-progress counters across slower
process IPC and shutdown. Query-host crashes reject in-flight work and are
restarted lazily, with a three-crashes-per-sixty-seconds circuit breaker and a
sixty-second cooldown. Shutdown drains or terminates every semantic child.
