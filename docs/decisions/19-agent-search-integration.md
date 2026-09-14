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
do not weaken the MCP contract. Urdira is expected to supply the main
repository context; a focused native source read remains valid when it verifies
changed or generated state or fills a concrete gap. Native reads are measured
by purpose, timing, and overlap instead of being treated as failures merely
because they occurred.

A native search intercepted by an installed Urdira hook is Urdira usage even
when the bridge correctly falls back to the host. Benchmarks retain an
append-only audit sidecar with one content-free record per interception,
including the decision and typed fallback reason. A served response also
carries the stable `[urdira hook served]` marker. Measurement keeps direct MCP,
served hook output, hook fallback, and executed shell transport distinct. For
a Codex replacement-file command, the audited payload bytes belong to hook
transport and are subtracted once from the command output together with the
served marker; any native segment in the same command remains shell transport.
Each audited interception is counted once and a denied native command is not
counted as executed shell. Trust notices do not count as interceptions.

The public MCP surface exposes `urdira_context` as one of three read-only tools.
It lowers to the registered `core:build_context` operation with a bounded
structural-readiness wait by default, so it adds a task-oriented entry point
without adding a second context semantic. Its replaceable defaults provide a
wider source window than a direct lookup, and relevant snippets are clipped
around the requested declaration. Deterministic context order prefers a typed
source declaration over a same-name JavaScript duplicate, retaining both in
the immutable manifest and continuations.

MCP discovery keeps the closed schema structure but omits repeated nested field
descriptions from the advertised copy. Concise tool descriptions state each
tool's role, while compact server instructions contain the validated request
examples once together with tool choice, pagination, pipeline data flow, and
registry-derived operation/output identifiers. Detailed validation remains
authoritative at the adapter and engine boundaries.

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

The Claude Code and Codex installers register a `UserPromptSubmit` hook. With a
prompt and working directory, it resolves the workspace explicitly, executes
one `core:build_context` query against the current structural snapshot, and
injects an agent-facing projection before the model processes the prompt. The
hook removes absolute, home-relative, and Windows-style path spans before
selecting a seed, then ranks code-shaped candidates by occurrence, specificity,
and original order. It supplies the selected identifier as an explicit symbol
seed.
That seed defines the context root while the complete task text remains
available for ordering, preventing common incidental names such as
`onDidChange` from widening a precise class request across the workspace. The
projection contains exact source identities and ranges, coalesces exact and
partially overlapping ranges from the same artifact version within the page,
retains every result association, reports index
and page coverage separately, and includes a portable continuation when more
results exist. The hook's response budget is a client integration decision:
`URDIRA_AGENT_PROMPT_CONTEXT_MAX_CHARACTERS` overrides the public 40,000
character default. If `core:build_context` reports
`core:coverage_incomplete` with the declared `core:search_text` source-safe
fallback, or reports `core:selector_unresolvable`, the bridge retains the typed
diagnostic and executes that explicitly scoped lexical query. The rendered
packet reports the original diagnostic, `coverage=partial`, independent source
search and page coverage, and a literal `MORE` continuation when available.
If the fallback cannot produce a usable packet, the hook uses static
primary-context guidance; it never claims that repository context is empty.
A hook payload without either its prompt or working directory cannot form an
explicitly scoped query and uses the same static guidance without starting a
daemon. Complete Claude Code and Codex prompt payloads resolve the daemon and
request indexed context before model admission.
The prompt query requests `definitions`, `tests`, `implementations`, `callers`,
and `contracts`. Its source projection is `relevant`, with up to the smaller of
12,000 characters or the selected prompt budget per snippet, the selected
prompt budget across snippets, and 12 context lines. Its item allowance uses
`URDIRA_AGENT_PROMPT_CONTEXT_MAX_ITEMS` or the public 50-item default. These are
replaceable client-integration choices; they do not change context membership
or introduce engine facet quotas.
The packet includes the exact query scope and treats its supplied test sources
as the default focused test locations. The agent considers a continuation only
after identifying a concrete fact missing from the edit or focused validation.
The literal `MORE` envelope is accepted by
`urdira query --payload <json> --json`, allowing hook-first clients to continue
the immutable execution without loading the complete MCP catalog into every
model interaction.
An unresolvable follow-up prompt is handled separately: the hook reports that
no new seed resolved and tells the agent to reuse the conversation's existing
repository context, without describing the current index as stale. After a
successful packet, the client integration stores only session identity,
explicit workspace scope and snapshot metadata, the prompt hash and selected seed
in a temporary cache with a TTL of 24 hours; it never stores source bodies or
continuation payloads. A clear same-session
follow-up may reuse that packet even when it contains an incidental identifier,
while an explicit missing-detail request (for example, a named caller or a
question) always performs a new Urdira query. Prompt source blocks precede the
result index and use snapshot-local artifact version and range identity for
deduplication, so equal text from distinct files is not collapsed. Codex
`PreToolUse` also maps a simple line-projected `sed -n` source
read to `core:get_source`; it falls through when the indexed projection cannot
faithfully satisfy the requested range.
For Codex, served `PreToolUse` text is written to a mode-0600 temporary file.
The rewritten command only reads that exact file, avoiding destructive shell
syntax that host approval layers can reject. Later hook invocations remove
stale Urdira output directories internally, so a host transcript does not
repeat the complete source in both the command argument and stdout or
accumulate unbounded temporary output.
The existing `PreToolUse` hooks still replace supported searches with Urdira
results and fail open for inputs they cannot translate.

The Codex installer provisions the prompt hook and adds its global guidance
once through the `developer_instructions` value of `~/.codex/config.toml`.
Writing the same guidance into `~/.codex/AGENTS.md` caused Codex to resend it in
a second message on every model round, so upgrades remove that older managed
block while preserving all user-owned AGENTS.md content. The installer patches
only its marked block in the additive value, preserves existing instructions,
comments and configuration, and never sets `model_instructions_file`.
Uninstallation removes only that block. Invalid configuration fails before
installation writes. The discovery rule is active even when a named agent or
skill is not selected. In code mode it names the exact deferred
`tools.mcp__urdira__urdira_index_status`,
`tools.mcp__urdira__urdira_context`, and
`tools.mcp__urdira__urdira_query` callables and tells Codex not to enumerate
`ALL_TOOLS`; this avoids transmitting the full MCP catalog merely to discover a
known tool name.
The prompt integration uses the public 50-item query default and a 40,000
character default. Both values are replaceable client defaults, not engine
quotas. Matching the ordinary item default prevents a focused result set from
being forced onto a long continuation by an integration-specific item quota;
the character budget still bounds the initial page and exposes a continuation
when the result is genuinely broader. Lexical test evidence keeps its possible classification but
hydrates from the smallest containing indexed callable when available, so an
occurrence near the beginning of a test does not truncate the assertions that
make the example usable.
Once a populated prompt packet is present, its inline guidance treats that
packet as the completed first Urdira action and does not repeat deferred MCP
tool names. This keeps named missing-detail and continuation recovery
available through the persistent integration instructions without prompting a
second lookup of an already supplied symbol.
It also provisions the optional `urdira_explorer` agent with product guidance
that starts read-heavy discovery
through explicitly scoped Urdira MCP calls, follows literal continuation requests
when the task needs remaining results, and accepts current complete coverage as
sufficient. Before declaring Urdira unavailable, the guidance requires an
explicit `urdira_index_status` call and bases availability only on its concrete
response; any exact error is preserved before fallback. The guidance asks
Urdira to provide the main context and permits focused native reads for
verification, generated or unindexed state, and identified missing details.
It discourages rereading unchanged source already supplied by Urdira. Editing,
testing, building, and Git remain native task actions. This guidance does not
require a pipeline or alter the public MCP contract.
The Codex installer does not provision an auto-discovered skill. Prompt and
pre-tool hooks already inject the same product guidance, and a second skill
load adds a model cycle before the agent can use the supplied source. Upgrades
remove the former managed `urdira-discovery` skill while preserving any
unmanaged file at that path.
Before invoking an exact-file test selector, the guidance also requires the
repository's compile step after editing when that runner consumes generated
output. The repository remains authoritative for which compile task produces
that output; the integration does not invent a universal build command.
Noisy successful builds write their complete output to a temporary log and
return one success line to the model. Failed builds return a bounded diagnostic
tail and the log location, preserving failure evidence without carrying routine
progress output through later turns. Validation wrappers use task-specific exit
variables rather than zsh's reserved `status` parameter. A follow-up with no
intervening relevant edit reuses an already successful build or test instead of
rerunning it only to restate the handoff.

For a faithfully translatable Codex shell search, the `PreToolUse` hook returns
`permissionDecision: "allow"` with `updatedInput.command` rewritten to print the
indexed Urdira result and its stable served marker. The original native search
therefore does not execute. Quoted regular-expression operators remain part of
the search pattern, and multiple explicit search paths become one indexed path
filter. A terminal numeric `head` pipeline (`head -N` or `head -n N`) is an
explicit line projection and is applied to the fully rendered Urdira result.
An exact `2>/dev/null` stderr discard is accepted at the end of the search or
immediately before that terminal `head`, because it does not change the result.
If one match line alone exceeds the host-selected character budget, the bridge
preserves its path and line, declares the source-text projection, and directs
exact recovery through an Urdira source read.
The bridge renders the daemon's canonical result bundle, including its nested
`primary_result`; a non-empty page that cannot produce a native-equivalent line
fails open instead of being served as an empty search. A page with remaining
results is served with the current page and an executable `MORE:` portable
continuation envelope, so all remaining results stay accessible without
presenting the page as complete. The current page is self-contained. An
explicit terminal `head` projection is complete when its requested line count
has already been satisfied. Declared truncation is served only when the page
also carries a portable cursor, in which case the `MORE:` envelope exposes the
remaining results. Pagination without a portable cursor, truncation without a
continuation, and a rendered page that exceeds the host output limit fail open
rather than hiding a projection limit.
Independent `rg`, recursive `grep`, and line-projected `sed -n` segments
separated by semicolons or conditional `&&` may also be translated. Separators
and native segments retain their original order and semantics. A segment that
is unsupported or cannot be served faithfully stays native while independently
translatable segments use Urdira. Other shell control operators outside quotes
and unsupported options remain native.
Ripgrep exclusion globs remain native because the public structural path
filter is inclusion-only. The bridge must not reinterpret an exclusion as a
positive filter or replace a valid native search with a falsely complete empty
Urdira result.

Installation owns only entries marked with the Urdira managed-version marker,
preserves unrelated configuration, refuses unmanaged OpenCode tool collisions,
and removes an entry only when it still matches the managed shape.
The application supplies its exact launcher (executable and argument prefix)
when installing integrations. Managed hooks and MCP entries retain that launcher
instead of resolving another installation through the host PATH. Reinstallation
refreshes managed hook entries, including legacy PATH-based entries, without
duplicating them or replacing unrelated hooks. Library callers may supply an
explicit launcher; the legacy library default remains `urdira`.

The adapter bindings follow the current host contracts: Claude Code
`UserPromptSubmit` context injection plus `PreToolUse` hook JSON and
`permissionDecision` response shape
([hooks reference](https://code.claude.com/docs/en/hooks)), Codex user
`~/.codex/hooks.json` `UserPromptSubmit`/`PreToolUse` matcher groups,
`additionalContext` prompt injection, `updatedInput` command replacement, and
explicit hook-audit loading by benchmark graders and derived reports, plus the
trust-review flow
([hooks configuration](https://github.com/openai/codex/blob/main/codex-rs/config/src/hook_config.rs),
[PreToolUse output schema](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/pre-tool-use.command.output.schema.json)),
and OpenCode global custom tools under `~/.config/opencode/tools`. Those tools
override the host's `grep` and `glob` names, receive the session directory from
the tool context, and pass it as explicit Urdira workspace scope
([custom tools](https://opencode.ai/docs/custom-tools/)). Cursor uses its
user-level `~/.cursor/hooks.json` `preToolUse` hook
([hooks reference](https://docs.cursor.com/hooks)). VS Code/Copilot uses the
user-level `~/.copilot/hooks/urdira.json` `PreToolUse` hook
([hooks reference](https://code.visualstudio.com/docs/agent-customization/hooks)).

Agent guidance must not require exhausting an unrelated broad result before
starting work. Complete index coverage is not a claim that all task context
has been read: page coverage and source projection limits remain separate.
Reuse supplied source, and request missing information through Urdira before
using host discovery for a concrete unavailable datum. A native read can also
verify changed, generated, transformed, or otherwise unindexed state.
An empty indexed search or an absent structural test relation is not missing
coverage. Agents should vary indexed search terms, locate artifacts and retrieve
their source through Urdira. Native source retrieval is not an integration
failure by itself. Evaluation must distinguish shell verification and new
information from exact or partial repetition of source already returned by
Urdira.

Context tools accept the same closed `ContinuationRequest` envelope already
used by `urdira_query`, as an alternative to their initial intent request.
Mixed intent/continuation fields are rejected. They delegate to the same
continuation resolver and signed scope/budget checks; no connection scope or
pending-result queue is introduced. Rendered MORE instructions identify
`urdira_query` as the canonical destination, while reuse of the originating
context tool is compatible and does not restart the query.
