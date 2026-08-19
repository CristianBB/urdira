export interface SecretMetadata { readonly normalized_path: string; readonly media_type: string; }
export interface SecretPolicy { readonly explicit_secret_paths?: readonly string[]; readonly max_scan_bytes?: number; }
export interface SecretDetection { readonly rule_code: string; readonly start_byte: number; readonly end_byte: number; readonly confidence?: "high" | "medium"; }

const tokenPattern = /(?:token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*([^\s#'"`]+)/giu;
const dotenvPath = /(?:^|\/)(?:\.env(?:\.[^/]*)?|credentials|config\.json|\.npmrc|\.pypirc|\.netrc)$/iu;

function byteOffset(text: string, characterOffset: number): number {
  return Buffer.byteLength(text.slice(0, characterOffset), "utf8");
}

export function classifySecret(metadata: SecretMetadata, bytes: Uint8Array, policy: SecretPolicy = {}): readonly SecretDetection[] {
  const detections: SecretDetection[] = [];
  if (policy.explicit_secret_paths?.includes(metadata.normalized_path) || /(?:BEGIN (?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY|BEGIN PGP PRIVATE KEY BLOCK)/u.test(Buffer.from(bytes).toString("utf8", 0, Math.min(bytes.byteLength, policy.max_scan_bytes ?? 1_048_576)))) {
    detections.push({ rule_code: "secret:private_key_or_explicit_path", start_byte: 0, end_byte: Math.min(bytes.byteLength, policy.max_scan_bytes ?? 1_048_576), confidence: "high" });
  }
  if (dotenvPath.test(metadata.normalized_path)) {
    const text = Buffer.from(bytes).toString("utf8", 0, Math.min(bytes.byteLength, policy.max_scan_bytes ?? 1_048_576));
    const assignment = /(^|\n)\s*[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*([^\n]*)/gu;
    for (const match of text.matchAll(assignment)) {
      const whole = match[0];
      const value = match[2] ?? "";
      const startCharacter = (match.index ?? 0) + whole.length - value.length;
      if (value.trim() !== "") detections.push({ rule_code: "secret:dotenv_assignment", start_byte: byteOffset(text, startCharacter), end_byte: byteOffset(text, startCharacter + value.length), confidence: "high" });
    }
  }
  const text = Buffer.from(bytes).toString("utf8", 0, Math.min(bytes.byteLength, policy.max_scan_bytes ?? 1_048_576));
  for (const match of text.matchAll(tokenPattern)) {
    const value = match[1] ?? "";
    const startCharacter = (match.index ?? 0) + match[0].length - value.length;
    detections.push({ rule_code: "secret:token_assignment", start_byte: byteOffset(text, startCharacter), end_byte: byteOffset(text, startCharacter + value.length), confidence: "medium" });
  }
  return detections.sort((left, right) => left.start_byte - right.start_byte || left.end_byte - right.end_byte);
}
