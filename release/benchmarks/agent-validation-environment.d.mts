export interface AgentValidationEnvironment {
  shell: string;
  node_version: string | null;
  missing_dependencies: string[];
  missing_runtime_artifacts?: string[];
}
export function assessAgentValidationEnvironment(observation: AgentValidationEnvironment): AgentValidationEnvironment & { ready: boolean; reasons: string[] };
export function inspectAgentValidationEnvironment(worktree: string, targetPaths: string[], shell?: string, nodeExecutable?: string): ReturnType<typeof assessAgentValidationEnvironment>;

export function isCurrentStructuralFrontier(entry: Record<string, unknown> | undefined): boolean;
