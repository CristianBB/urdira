export function retainCodexHostSessions(home: string, destination: string): {
  sessions: Array<{ path: string; sha256: string }>;
  blocked_shell_attempts: Array<{ session: string; call_id: string | null; text: string }>;
  malformed_lines: number;
} | null;
