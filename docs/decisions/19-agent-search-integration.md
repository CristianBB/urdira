# Coding-agent search integration and context isolation

Status: **Accepted**

Urdira remains a read-only, explicitly scoped intelligence surface. The first
native search adapters are Claude Code, Codex, OpenCode, Cursor, and VS Code
with GitHub Copilot and are enabled only by a user-level, idempotent installer.
Adapters translate supported lexical, file-discovery, and semantic search calls
to the corresponding Urdira
operations; every uncertain, stale,
unsupported, out-of-scope, timed-out, or over-budget case falls back to the
native host operation. These native host hooks are optional integrations and
do not weaken the MCP contract: an agent validating or benchmarking Urdira
must use an available Urdira operation for repository discovery and source
reading rather than silently degrading to host tools.

The public MCP surface also exposes `urdira_context` as its fifth read-only
tool. It lowers to the registered `core:build_context` operation with a bounded
structural-readiness wait by default, so it adds a task-oriented entry point
without adding a second context semantic.

Urdira's MCP server is also a supported local stdio integration for Cursor,
Cursor Agent CLI, VS Code with GitHub Copilot Chat, Cline, Roo Code, and Claude
Desktop. The CLI installer writes each client's supported local configuration;
Roo Code receives a project `.roo/mcp.json` and the other MCP clients receive
their per-user settings file. Cursor additionally receives a native
`preToolUse` adapter for its
`Grep`, `Search Files`, and `Codebase` tools, mapped to Urdira's lexical,
artifact, and semantic lanes respectively. If a lane is unavailable,
incomplete, or the request is unsupported, the hook falls back to the native
host operation; it never approximates semantic search as lexical search. Native
hook installation never rewrites an IDE's MCP settings. MCP-only
clients are still fully configured by the same `urdira agent install` command.

The shared bridge contract is `AgentSearchRequest`/`AgentSearchDecision`.
Multi-query discovery executes in a child context and returns only a bounded
`DiscoveryDigestView` with freshness, completeness, findings, evidence
locations, truncation, semantic coverage, and follow-up hints. One-shot search
calls remain inline.

The Codex installer also provisions a managed block in the user-level
`~/.codex/AGENTS.md`, which Codex loads as global developer instructions, so
the discovery rule is active even when a named agent or skill is not selected.
It also provisions the `urdira_explorer` agent and the `urdira-discovery` skill
with product guidance that starts read-heavy discovery
through explicitly scoped Urdira MCP calls, follows opaque continuation cursors
when requested facets are incomplete, and accepts current complete coverage as
sufficient. Before declaring Urdira unavailable, the guidance requires an
explicit `urdira_index_status` call and bases availability only on its concrete
response; any exact error is preserved before fallback. Native shell discovery is reserved for absent or incomplete indexed
data; editing, testing, building, and Git remain native task actions. This
guidance does not require a pipeline or alter the public MCP contract.

Installation owns only entries marked with the Urdira managed-version marker,
preserves unrelated configuration, refuses unmanaged OpenCode tool collisions,
and removes an entry only when it still matches the managed shape.

The adapter bindings follow the current host contracts: Claude Code
`PreToolUse` hook JSON and `permissionDecision` response shape
([hooks reference](https://code.claude.com/docs/en/hooks)), Codex user
`~/.codex/hooks.json` matcher groups and trust-review flow
([hooks configuration](https://github.com/openai/codex/blob/main/codex-rs/config/src/hook_config.rs)),
and OpenCode global custom tools under `~/.config/opencode/tools`
([custom tools](https://opencode.ai/docs/custom-tools/)). Cursor uses its
user-level `~/.cursor/hooks.json` `preToolUse` hook
([hooks reference](https://docs.cursor.com/hooks)). VS Code/Copilot uses the
user-level `~/.copilot/hooks/urdira.json` `PreToolUse` hook
([hooks reference](https://code.visualstudio.com/docs/agent-customization/hooks)).
