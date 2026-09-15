export function buildCodexMcpArgs(options: { readonly arm: string; readonly codebaseMemory?: string | null; readonly codegraph?: string | null; readonly benchmarkTimeoutMs: number }): readonly string[];
export function buildCodexExecArgs(options: { readonly model: string; readonly worktree: string; readonly integrated?: boolean; readonly mcpArgs?: readonly string[] }): readonly string[];
export function buildCodexResumeArgs(options: { readonly model: string; readonly worktree: string; readonly sessionId: string; readonly integrated?: boolean; readonly mcpArgs?: readonly string[] }): readonly string[];
export function effectiveCodexHome(options?: { readonly env?: Record<string, string | undefined>; readonly home?: string }): string;
export function resolveCodexAuthRoute(options: { readonly parentCodexHome: string; readonly isolatedCodexHome: string }): {
  readonly ok: boolean;
  readonly route?: string;
  readonly failure?: string;
  readonly parent_codex_home?: string;
  readonly isolated_codex_home?: string;
  readonly source_auth_path?: string;
  readonly isolated_auth_path?: string;
  readonly source_bytes?: number;
  readonly source_mode?: number;
  readonly error?: string;
};
export function validateCodexArgv(options: { readonly codex: string; readonly model: string; readonly worktree: string; readonly sessionId?: string; readonly integrated?: boolean; readonly mcpArgs?: readonly string[] }): {
  readonly ok: boolean;
  readonly binary_path: string;
  readonly binary_version: string | null;
  readonly binary_version_status: number | null;
  readonly binary_version_stderr: string | null;
  readonly binary_sha256: string | null;
  readonly first: { readonly args: readonly string[]; readonly status: number | null; readonly signal: string | null; readonly stdout: string; readonly stderr: string; readonly error: string | null };
  readonly resume: { readonly args: readonly string[]; readonly status: number | null; readonly signal: string | null; readonly stdout: string; readonly stderr: string; readonly error: string | null };
};
