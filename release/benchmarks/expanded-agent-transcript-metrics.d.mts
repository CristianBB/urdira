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
  mcp_component_bytes: McpComponentBytes;
  mcp_component_classification: Record<string, unknown>;
}

export interface McpResponseComponents extends McpComponentBytes {
  classification: Record<string, unknown>;
}

export function analyzeExpandedTranscript(events: unknown[], arm: string, task?: unknown): ExpandedTranscriptMetrics;
export function classifyMcpResponseComponents(item: unknown): McpResponseComponents | null;
export function isShellSourceReadCommand(command: string): boolean;
export function analyzeUrdiraPipelineContract(events: unknown[]): any;
