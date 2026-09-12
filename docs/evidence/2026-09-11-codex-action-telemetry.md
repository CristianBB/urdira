# Codex action telemetry

The expanded transcript metrics retain the existing definitions for MCP calls,
shell discovery, repository reads, and repository context characters. They now
also inventory completed Codex action items separately: web searches, file
changes, integration or hook errors, and completed item types that are not in
the known action schema.

Web searches and file changes are not repository reads. Their counters must not
be added to MCP, shell, source-read, or context-character totals. MCP response
component accounting remains limited to the typed MCP response envelope.

The post-index and expanded report renderers expose the same action telemetry.
This makes installed integrations observable when an agent chooses web search
or an editor action without changing historical comparison metrics. The parser
uses completed events only, so an item started and completed once contributes a
single action.

Focused tests cover v6-equivalent counts (9 web searches, 9 file changes, no
MCP or shell calls), v5-equivalent counts (2 web searches, 6 file changes, 18
shell calls), and an unknown item type. No benchmark was executed for this
change.
