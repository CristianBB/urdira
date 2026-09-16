/** Pure source-window helpers used by query hydration and text matches. */

export function lineStart(text: string, index: number): number {
  const newline = text.lastIndexOf("\n", index - 1);
  return newline === -1 ? 0 : newline + 1;
}

export function lineEnd(text: string, index: number): number {
  const newline = text.indexOf("\n", index);
  return newline === -1 ? text.length : newline + 1;
}

/** Truncates UTF-16 text without leaving an unpaired surrogate. */
export function truncateWithoutSplittingSurrogatePair(text: string, limit: number): string {
  if (limit >= text.length) return text;
  if (limit <= 0) return "";
  const trailing = text.charCodeAt(limit - 1);
  const boundary = trailing >= 0xd800 && trailing <= 0xdbff ? limit - 1 : limit;
  return text.slice(0, boundary);
}

export function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text[cursor] === "\n") line += 1;
  return line;
}

export function extendSpanForContext(text: string, start: number, end: number, contextLines: number): { readonly start: number; readonly end: number } {
  if (contextLines <= 0) return { start, end };
  let extendedStart = lineStart(text, start);
  let extendedEnd = lineEnd(text, Math.max(end - 1, start));
  for (let line = 0; line < contextLines; line += 1) {
    if (extendedStart > 0) extendedStart = lineStart(text, extendedStart - 1);
    if (extendedEnd < text.length) extendedEnd = lineEnd(text, extendedEnd);
  }
  return { start: extendedStart, end: extendedEnd };
}
