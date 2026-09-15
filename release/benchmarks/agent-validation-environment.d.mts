export interface AgentValidationEnvironment {
  shell: string;
  node_version: string | null;
  missing_dependencies: string[];
  missing_runtime_artifacts?: string[];
}
export interface AgentDependencySetup {
  repository_id: string;
  source_root: string;
  worktree: string;
  prepared_roots: Array<{ relative_path: string; root: string; root_realpath: string; lockfile: string; source_lockfile: string; lockfile_bytes: number; lockfile_sha256: string; manager: string; manager_version: string; dependency_links: Array<{ path: string; realpath: string }>; cache_root: string; cache_environment: Record<string, string>; cache_bytes: number }>;
  closure_sha256: string;
  commands: Array<{ cwd: string; command: string; args: string[]; env: Record<string, string>; code: number; signal: string | null; stdout: string; stderr: string }>;
  setup_elapsed_ms: number;
}
export function assessAgentValidationEnvironment(observation: AgentValidationEnvironment): AgentValidationEnvironment & { ready: boolean; reasons: string[] };
export function inspectAgentValidationEnvironment(worktree: string, targetPaths: string[], shell?: string, nodeExecutable?: string): ReturnType<typeof assessAgentValidationEnvironment>;
export function materializeAgentDependencyClosure(options: { repositoryId: string; repositoryRoot: string; worktree: string; nodeExecutable?: string; run?: (command: string, args: string[], options?: Record<string, unknown>) => Promise<{ code: number; signal?: string | null; stdout?: string; stderr?: string }> | { code: number; signal?: string | null; stdout?: string; stderr?: string } }): Promise<AgentDependencySetup>;

export function isCurrentStructuralFrontier(entry: Record<string, unknown> | undefined): boolean;
