# Coding-agent search integration and context isolation

Status: **Approved for implementation**

Urdira remains a read-only, explicitly scoped intelligence surface. The first
client adapters are Claude Code, Codex, and OpenCode and are enabled only by a
user-level, idempotent installer. Adapters translate supported Grep/Glob calls
to `core:search_text` and `core:find_artifacts`; every uncertain, stale,
unsupported, out-of-scope, timed-out, or over-budget case falls back to the
native host operation. No fifth MCP tool is introduced.

The shared bridge contract is `AgentSearchRequest`/`AgentSearchDecision`.
Multi-query discovery executes in a child context and returns only a bounded
`DiscoveryDigestView` with freshness, completeness, findings, evidence
locations, truncation, semantic coverage, and follow-up hints. One-shot search
calls remain inline.

Installation owns only entries marked with the Urdira managed-version marker,
preserves unrelated configuration, refuses unmanaged OpenCode tool collisions,
and removes an entry only when it still matches the managed shape.

The adapter bindings follow the current host contracts: Claude Code
`PreToolUse` hook JSON and `permissionDecision` response shape
([hooks reference](https://code.claude.com/docs/en/hooks)), Codex user
`~/.codex/hooks.json` matcher groups and trust-review flow
([hooks configuration](https://github.com/openai/codex/blob/main/codex-rs/config/src/hook_config.rs)),
and OpenCode global custom tools under `~/.config/opencode/tools`
([custom tools](https://opencode.ai/docs/custom-tools/)).
