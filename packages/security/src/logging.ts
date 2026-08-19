import { randomUUID } from "node:crypto";

export interface LogEventInput { readonly event_code: string; readonly workspace_id?: string; readonly request_id?: string; readonly execution_id?: string; readonly candidate_id?: string; readonly duration_ms?: number; readonly count?: number; readonly message?: unknown; readonly source_text?: string; readonly snippet?: string; readonly artifact_path?: string; readonly [key: string]: unknown; }
export interface SafeLogEvent { readonly event_code: string; readonly event_id: string; readonly workspace_id?: string; readonly request_id?: string; readonly execution_id?: string; readonly candidate_id?: string; readonly duration_ms?: number; readonly count?: number; readonly message?: string; readonly artifact_path?: string; }

const credentialKeyPattern = /(?:aws_[a-z0-9_]*|authorization|bearer|credential|client_secret|access_token|refresh_token|token|secret|password|api[_-]?key|private[_-]?key)/iu;

function redactStructuredCredentials(message: string): string {
  return message.replace(/(["'])([^"']*(?:aws_[a-z0-9_]*|authorization|bearer|credential|client_secret|access_token|refresh_token|token|secret|password|api[_-]?key|private[_-]?key)[^"']*)\1\s*:\s*(?:"(?:\\.|[^"\\])*"|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|true|false|null)/giu, (_match, quote: string, key: string) => `${quote}${key}${quote}:"[REDACTED_CREDENTIAL]"`);
}

function jsonFragmentEnd(message: string, start: number): number | undefined {
  const opening = message[start];
  const stack = [opening === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < message.length; index += 1) {
    const character = message[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === "{" || character === "[") stack.push(character === "{" ? "}" : "]");
    else if (character === "}" || character === "]") {
      if (stack.at(-1) !== character) return undefined;
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  return undefined;
}

function redactEmbeddedJsonFragments(message: string): string {
  let output = "";
  let copiedThrough = 0;
  let index = 0;
  while (index < message.length) {
    const character = message[index];
    if (character === "{" || character === "[") {
      const end = jsonFragmentEnd(message, index);
      if (end !== undefined) {
        try {
          const parsed: unknown = JSON.parse(message.slice(index, end));
          if (parsed !== null && typeof parsed === "object") {
            output += message.slice(copiedThrough, index);
            output += JSON.stringify(redactStructuredValue(parsed));
            copiedThrough = end;
            index = end;
            continue;
          }
        } catch { /* Ordinary text can contain balanced, non-JSON delimiters. */ }
      }
    }
    index += 1;
  }
  return output + message.slice(copiedThrough);
}

function redactMessageText(message: string): string {
  return redactStructuredCredentials(message)
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, "[REDACTED_PEM]")
    .replace(/Authorization\s*:\s*Bearer\s+[^\s,;]+/giu, "Authorization: Bearer [REDACTED_CREDENTIAL]")
    .replace(/(?:AWS_[A-Z0-9_]*|authorization|bearer|credential|client_secret|access_token|refresh_token)\s*[:=]\s*[^\s,;]+/giu, "[REDACTED_CREDENTIAL]")
    .replace(/path\s*=\s*[^\s,;]+/giu, "path=[REDACTED_PATH]")
    .replace(/(?:token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,;]+/giu, "[REDACTED_CREDENTIAL]")
    .replace(/(^|[\s("'`])(?:\.\.?[\\/])+(?:[^\s"'`,;)]*)/gu, "$1[REDACTED_PATH]")
    .replace(/(^|[\s("'`])(?:\/[^\s"'`,;)]*|[A-Za-z]:[\\/][^\s"'`,;)]*|\\\\[^\s"'`,;)]*)/gu, "$1[REDACTED_PATH]")
    .replace(/(^|[\s("'`=:#])(?:[A-Za-z0-9_.-]+\/)+(?:[A-Za-z0-9_.-]+)(?=$|[\s"'`,;)}\]])/gu, "$1[REDACTED_PATH]")
    .slice(0, 512);
}

function redactStructuredValue(value: unknown, key?: string): unknown {
  if (key !== undefined && credentialKeyPattern.test(key)) return "[REDACTED_CREDENTIAL]";
  if (typeof value === "string") return redactMessageText(redactEmbeddedJsonFragments(value));
  if (Array.isArray(value)) return value.map((item) => redactStructuredValue(item));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactStructuredValue(entryValue, entryKey)]));
  return value;
}

function safeMessage(message: unknown): string {
  const serialized = typeof message === "string" ? redactEmbeddedJsonFragments(message) : (() => {
    try { return JSON.stringify(redactStructuredValue(message)); } catch { return "[REDACTED_STRUCTURED_VALUE]"; }
  })();
  return redactMessageText(serialized ?? "[REDACTED_STRUCTURED_VALUE]");
}

export function safeLogEvent(event: LogEventInput): SafeLogEvent {
  const output: SafeLogEvent = {
    event_code: event.event_code,
    event_id: `event:${randomUUID()}`,
    ...(event.workspace_id ? { workspace_id: event.workspace_id } : {}),
    ...(event.request_id ? { request_id: event.request_id } : {}),
    ...(event.execution_id ? { execution_id: event.execution_id } : {}),
    ...(event.candidate_id ? { candidate_id: event.candidate_id } : {}),
    ...(typeof event.duration_ms === "number" ? { duration_ms: event.duration_ms } : {}),
    ...(typeof event.count === "number" ? { count: event.count } : {}),
    ...(event.message !== undefined ? { message: safeMessage(event.message) } : {}),
  };
  return output;
}
