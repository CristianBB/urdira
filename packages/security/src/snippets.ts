import type { SecretDetection } from "./secrets.js";

export interface SnippetLimits { readonly max_characters: number; }
export interface SnippetRedaction { readonly source_span: { readonly start_byte: number; readonly end_byte: number }; readonly output_start_character: number; readonly output_end_character: number; readonly reason_code: string; }
export interface RedactedSnippet { readonly text: string; readonly truncated: boolean; readonly redacted: boolean; readonly redactions: readonly SnippetRedaction[]; }

function byteToCharacterIndex(text: string, byteOffset: number, roundUp: boolean): number {
  const clamped = Math.max(0, Math.min(Buffer.byteLength(text, "utf8"), byteOffset));
  let bytes = 0;
  let index = 0;
  for (const character of text) {
    const length = Buffer.byteLength(character, "utf8");
    if (clamped === bytes) return index;
    if (clamped < bytes + length) return roundUp ? index + character.length : index;
    bytes += length;
    index += character.length;
  }
  return text.length;
}

export function redactSnippet(text: string, detections: readonly SecretDetection[], limits: SnippetLimits): RedactedSnippet {
  const byteLength = Buffer.byteLength(text, "utf8");
  const ordered = detections.filter((detection) => detection.start_byte < byteLength && detection.end_byte > detection.start_byte).sort((left, right) => left.start_byte - right.start_byte);
  let cursorByte = 0;
  let output = "";
  const redactions: SnippetRedaction[] = [];
  for (const detection of ordered) {
    const startByte = Math.max(cursorByte, detection.start_byte);
    const endByte = Math.min(byteLength, detection.end_byte);
    const start = byteToCharacterIndex(text, startByte, false);
    const end = Math.min(text.length, byteToCharacterIndex(text, endByte, true));
    if (end <= start) continue;
    output += text.slice(byteToCharacterIndex(text, cursorByte, false), start);
    const outputStart = output.length;
    output += "[REDACTED]";
    redactions.push({ source_span: { start_byte: startByte, end_byte: endByte }, output_start_character: outputStart, output_end_character: output.length, reason_code: detection.rule_code });
    cursorByte = endByte;
  }
  output += text.slice(byteToCharacterIndex(text, cursorByte, false));
  const truncated = output.length > limits.max_characters;
  return { text: truncated ? output.slice(0, Math.max(0, limits.max_characters)) : output, truncated, redacted: redactions.length > 0, redactions };
}
