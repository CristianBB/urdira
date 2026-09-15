export interface TokenEvidenceInput {
  readonly transcriptPath?: string;
  readonly transcriptEvents?: readonly Record<string, unknown>[];
  readonly hostSessionPaths?: readonly (string | { readonly path: string; readonly sha256?: string })[];
}

export interface TokenEvidence {
  readonly status: "matched" | "mismatch" | "missing_host";
  readonly counter_mode: "per_turn" | "cumulative" | null;
  readonly root_turn_ids: readonly string[];
  readonly transcript_sha256: string | null;
  readonly match: { readonly source: string | null; readonly version_only: false; readonly [key: string]: unknown };
  readonly source: { readonly host_sessions: readonly Record<string, unknown>[]; readonly [key: string]: unknown };
  readonly errors: readonly string[];
}

export function deriveHostTokenEvidence(input?: TokenEvidenceInput): TokenEvidence;
