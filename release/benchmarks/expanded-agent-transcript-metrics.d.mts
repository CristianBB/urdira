export interface McpComponentBytes {
  tool_envelope: number | null;
  model_visible_serialized: number | null;
  source_text: number | null;
  hydration: number | null;
  records: number | null;
  evidence: number | null;
  registry: number | null;
}

export interface ExpandedTranscriptMetrics {
  [key: string]: unknown;
  completed_tool_output: {
    mcp: TransportTextOutput;
    hook: TransportTextOutput;
    shell: TransportTextOutput;
    tgrep: TransportTextOutput;
    total_characters: number | null;
    full_model_context_characters: null;
  };
  mcp_component_bytes: McpComponentBytes;
  mcp_component_classification: Record<string, unknown>;
  context_efficiency: ContextEfficiency;
  context_lead: {
    first_repository_discovery_transport: "mcp" | "hook" | "shell" | null;
    first_repository_discovery_source: "urdira" | "other_mcp" | "shell" | null;
    configured_before_shell: boolean | null;
    configured_calls_before_first_edit: number;
    configured_characters_before_first_edit: number;
    mcp_calls_before_first_edit: number;
    hook_calls_before_first_edit: number;
    shell_source_calls_before_first_edit: number;
    mcp_characters_before_first_edit: number;
    hook_characters_before_first_edit: number;
    shell_source_characters_before_first_edit: number;
    configured_character_share_before_first_edit: number | null;
  };
}

export interface TransportTextOutput {
  calls: number;
  missing_output_calls: number;
  known_characters: number;
  characters: number | null;
}

export interface ContextEfficiency {
  record_id_occurrences: number | null;
  unique_record_ids: number | null;
  unique_record_ratio: number | null;
  exact_repeated_output_characters: number;
  exact_shell_output_repeated_after_mcp_characters: number;
  shell_source_line_overlap_characters: number | null;
  shell_source_reads: {
    total_calls: number;
    before_first_mcp_calls: number;
    after_first_mcp_calls: number;
    overlapping_calls: number;
    nonoverlapping_calls: number;
  };
  continuations_offered: number;
  continuations_attempted: number;
  continuations_consumed: number;
  continuations_not_observed_consumed: number;
  unused_hydration_characters: null;
  used_artifact_positions: Array<{ path: string; basis: string; first_typed_context_position: { event_index: number; ordinal: number } | null }> | null;
  relevant_results_per_thousand_characters: null;
  contributing_context_ratio: null;
  completeness_preserved: null;
  observations: Array<{ event_index: number; transport: string; characters: number; exact_output_repeated: boolean }>;
}

export interface McpResponseComponents extends McpComponentBytes {
  classification: Record<string, unknown>;
}

export function analyzeExpandedTranscript(events: unknown[], arm: string, task?: unknown, options?: { workspace_root?: string; hook_audit?: unknown[] }): ExpandedTranscriptMetrics;
export function analyzeCodexActions(events: unknown[]): Record<string, unknown>;
export function analyzeContextEfficiency(events: unknown[], options?: { workspace_root?: string }): ContextEfficiency;
export function classifyMcpResponseComponents(item: unknown): McpResponseComponents | null;
export function isShellSourceReadCommand(command: string): boolean;
export function analyzeUrdiraPipelineContract(events: unknown[]): any;
