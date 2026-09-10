# Expanded agent campaign pipeline contract — 2026-09-10

Scope: make composition usage measurable without directing the agent's tool
choice.

The prior cell runner supplied runner-specific discovery policy: it told the
agent how to use Urdira, prohibited shell source discovery, required a
post-edit reconciliation pattern, and added benchmark-only composition
guidance. Those smokes are therefore protocol-directed and cannot measure
natural agent adoption or strategy selection.

The runner now configures the Urdira MCP server and leaves tool selection to the
agent. The benchmark entrypoint passes only the isolated data root, inheriting
the production tool set and default `MCP_SERVER_INSTRUCTIONS`; it does not pass
benchmark instructions or compact mode. Pipelines, recipes, direct operations,
`urdira_context`, and ordinary tools are all valid choices. The transcript
grader exposes `composition_metrics` with pipeline, recipe, direct-operation,
valid-dependency, and malformed-attempt counts plus malformed reasons. These
metrics are observational and do not affect correctness when the agent does
not use Urdira or chooses a direct operation.

The frozen September smoke is retained without modification. Its transcripts
were produced under directed prompting and remain historical evidence; they
are not relabeled as natural-choice data and are not re-executed. The next
campaign should use the updated runner and grader so composition and
MCP/non-MCP usage are visible as agent choices.

Verification performed:

- static inspection confirmed runner policies, custom MCP instructions, and
  compact benchmark projection are absent;
- synthetic transcript tests cover valid dependency pipelines, valid direct
  operation calls, and malformed bindings;
- no benchmark cell or Urdira indexing run was executed.
