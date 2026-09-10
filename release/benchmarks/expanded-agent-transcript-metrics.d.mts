export interface TranscriptTaskContract {
  readonly required_patterns?: readonly {
    readonly path: string;
    readonly regex: string;
  }[];
}

export interface VerificationAttempt {
  readonly kind: "test" | "typecheck" | "lint";
  readonly command: string;
  readonly exit_code: number | null;
  readonly passed: boolean | null;
  readonly output_characters: number;
}

export interface ExpandedTranscriptMetrics {
  readonly repository_read_calls: number;
  readonly configured_repository_read_calls: number;
  readonly assigned_tgrep_calls: number;
  readonly repository_context_characters: number;
  readonly context_calls_attributed_to_declared_targets: number | null;
  readonly context_calls_unattributed_to_declared_targets: number | null;
  readonly context_characters_unattributed_to_declared_targets: number | null;
  readonly assigned_discovery_before_edit: boolean;
  readonly assigned_rediscovery_after_each_edit: boolean;
  readonly observed_discovery_calls: number;
  readonly observed_discovery_before_edit: boolean;
  readonly observed_post_edit_discovery_calls: number;
  readonly observed_rediscovery_after_each_edit: boolean;
  readonly observed_tool_usage: {
    readonly mcp_calls: number;
    readonly shell_calls: number;
    readonly tgrep_calls: number;
  };
  readonly verification_attempts: readonly VerificationAttempt[];
  readonly test_attempts: number;
  readonly test_passes: number;
  readonly test_failures: number;
  readonly test_results_unknown: number;
}

export interface UrdiraPipelineCall {
  readonly event_index: number;
  readonly valid: boolean;
  readonly kind: string;
  readonly has_dependency: boolean;
  readonly has_discovery_source_dependency: boolean;
  readonly reason: string | null;
  readonly status: string | undefined;
  readonly accepted: boolean;
}

export interface UrdiraPipelineContractMetrics {
  readonly composition_shape_valid: boolean | null;
  readonly query_calls: number;
  readonly direct_operation_calls: number;
  readonly pipeline_calls: number;
  readonly recipe_calls: number;
  readonly composition_calls: number;
  readonly valid_composition_calls: number;
  readonly valid_dependency_calls: number;
  readonly valid_discovery_source_calls: number;
  readonly malformed_composition_calls: number;
  readonly malformed_reasons: readonly (string | null)[];
  readonly composition_before_first_edit: boolean;
  readonly composition_after_edit_calls: number;
  readonly calls: readonly UrdiraPipelineCall[];
}

export function analyzeExpandedTranscript(
  events: readonly unknown[],
  arm: string,
  task?: TranscriptTaskContract,
): ExpandedTranscriptMetrics;

export function analyzeUrdiraPipelineContract(
  events: readonly unknown[],
): UrdiraPipelineContractMetrics;

export const SHELL_SOURCE_READ: RegExp;
export function isShellSourceReadCommand(command: string): boolean;
