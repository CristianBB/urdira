import type { QueryScope, SourceSpan } from "@urdira/contracts";
import type { CanonicalQueryRecord, CanonicalQuerySnapshotPort } from "./canonical-query-data-port.js";
import { extendSpanForContext, lineEnd, lineNumberAt, lineStart, truncateWithoutSplittingSurrogatePair } from "./source-snippet-utils.js";

export interface SourceSnippetValue {
  readonly text: string;
  readonly span: SourceSpan;
  readonly truncated: boolean;
  readonly redacted: boolean;
  readonly redactions: readonly [];
}
// Adversarial review 2026-09-06 (Frente N): `sourceSnippet`'s two truncation
// points below (`maxCharactersPerSnippet`, `remainingBudget`) previously cut
// with a plain `String.prototype.slice(0, limit)`. For any line whose
// content puts a UTF-16 surrogate pair (an astral character -- most emoji,
// some CJK extension characters) exactly on that boundary, a plain slice
// keeps the high surrogate and drops its low surrogate, leaving a lone
// (unpaired) surrogate in `snippet.text`. That string round-trips through
// JSON fine (JSON allows unpaired surrogates as `\uXXXX` escapes) but is
// invalid Unicode text once decoded by a consumer that enforces well-formed
// UTF-16/UTF-8 (a strict `TextEncoder`/`JSON.parse` reviver, a terminal that
// rejects WTF-8, `Buffer.from(text, "utf8")` substituting U+FFFD, ...) --
// exactly the "line >200 chars" truncation case Frente N's adversarial
// review asked to check "¿corta en medio de un code point UTF-16 surrogate?".
export async function sourceSnippet(snapshots: CanonicalQuerySnapshotPort, scope: QueryScope, record: CanonicalQueryRecord, mode: "signature" | "relevant" | "body" | "line", maxCharactersPerSnippet: number, contextLines: number, remainingBudget: number): Promise<SourceSnippetValue | undefined> {
  if (remainingBudget <= 0) return undefined;
  const file = await snapshots.artifact_text?.(scope, record.owner_artifact_version_id);
  if (file === undefined) return undefined;
  const bodyStart = record.body["start"];
  const bodyEnd = record.body["end"];
  const canonicalSpan = record.primary_source_span;
  // A source-catalog artifact represents the complete file and therefore has
  // no entity span. Treat its implicit span as the full artifact; requiring a
  // structural container solely to manufacture start=0/end=file.length would
  // defeat source-ready direct artifact reads and force a full corpus load.
  const wholeArtifact = record.category === "artifact_subject";
  const start = typeof bodyStart === "number" ? bodyStart : canonicalSpan === undefined ? wholeArtifact ? 0 : undefined : Number(canonicalSpan.start_byte);
  const end = typeof bodyEnd === "number" ? bodyEnd : canonicalSpan === undefined ? wholeArtifact ? file.text.length : undefined : Number(canonicalSpan.end_byte);
  if (typeof start !== "number" || typeof end !== "number" || start < 0 || end < start) return undefined;
  if (end > file.text.length) return undefined;
  const text = file.text;
  let coreEnd = end;
  // E-P0j adversarial review (2026-09-07, fix-ep0j-review): "signature"
  // used to always cut the first line starting at `start` -- correct back
  // when `start` was the identifier's own span (pre-Frente-E-P0j), but
  // `start` is now the WHOLE declaration span, which for a class/interface
  // member can begin at that member's own leading decorator(s)
  // (`@Injectable()\n  method() {}` -- `ClassElement::span()`/the Rust
  // producer's own `decl_start` include the decorator; confirmed live,
  // `decl_span_covers_member_decorators_but_not_a_top_level_declarations_own_leading_decorator`,
  // `urdira-jsts-syntax-worker`). Left as `start`, "signature" mode would
  // render `@Injectable()` instead of the member's actual signature line --
  // exactly the fidelity regression Frente E-P0j's own consumer review
  // (`docs/evidence/2026-09-07-v4-entity-declaration-spans.md` §3) missed
  // (its only worked example was a plain `export function foo(...)`, never
  // a decorated member). `body["name_start"]` (additive as of that same
  // task) is the identifier's own position within `[start, end)` when
  // present -- anchoring the signature's line on IT instead, when in
  // range, recovers the real signature line (`method() {` or `value:
  // number = 1;`) regardless of what precedes it on an earlier line.
  // Falls back to `start` unchanged (byte-identical to before this fix)
  // when `name_start` is absent/out of range -- an older record predating
  // this field, a non-jsts subject, or a degenerate span (module/external
  // entities, whose `name_start === start`, changes nothing either way).
  const nameStart = record.body["name_start"];
  const signatureAnchor = mode === "signature" && typeof nameStart === "number" && Number.isFinite(nameStart) && nameStart >= start && nameStart < end
    ? lineStart(text, nameStart)
    : start;
  if (mode === "signature") {
    const newline = text.indexOf("\n", signatureAnchor);
    coreEnd = newline === -1 || newline >= end ? end : newline;
  }
  // Plan 2026-09-06 (Frente N, SNIPPET_POLICY): "line" always renders the
  // FULL source line the span starts on -- not merely `[start, coreEnd)`
  // (which, for a reference occurrence, is often just the identifier
  // token) -- regardless of `contextLines` (inline policy snippets always
  // call this with `contextLines: 0`, since "one more line of context"
  // would defeat R13's one-line-per-bundle budget accounting).
  let { start: sliceStart, end: sliceEnd } = mode === "line"
    ? { start: lineStart(text, start), end: lineEnd(text, Math.max(coreEnd - 1, start)) }
    : extendSpanForContext(text, signatureAnchor, coreEnd, contextLines);
  const effectiveLimit = Math.min(maxCharactersPerSnippet, remainingBudget);
  const coreLength = coreEnd - signatureAnchor;
  // Context is useful only if it still contains the requested declaration.
  // When surrounding lines exceed the caller's projection, center the bounded
  // window around that declaration instead of returning only the earliest
  // leading lines. The projection remains exact and explicitly truncated.
  let contextClipped = false;
  if (mode !== "line" && sliceEnd - sliceStart > effectiveLimit && coreLength <= effectiveLimit) {
    contextClipped = true;
    const surrounding = effectiveLimit - coreLength;
    const before = Math.floor(surrounding / 2);
    sliceStart = Math.max(sliceStart, signatureAnchor - before);
    sliceEnd = Math.min(sliceEnd, sliceStart + effectiveLimit);
    if (sliceEnd < coreEnd) {
      sliceEnd = coreEnd;
      sliceStart = Math.max(0, sliceEnd - effectiveLimit);
    }
  }
  let snippetText = text.slice(sliceStart, sliceEnd);
  let truncated = contextClipped;
  if (snippetText.length > maxCharactersPerSnippet) { snippetText = truncateWithoutSplittingSurrogatePair(snippetText, maxCharactersPerSnippet); truncated = true; }
  if (snippetText.length > remainingBudget) { snippetText = truncateWithoutSplittingSurrogatePair(snippetText, remainingBudget); truncated = true; }
  const useStoredLines = contextLines === 0 && canonicalSpan !== undefined;
  return {
    text: snippetText,
    span: {
      artifact_version_id: canonicalSpan?.artifact_version_id ?? record.owner_artifact_version_id,
      start_byte: String(sliceStart),
      end_byte: String(sliceEnd),
      start_line: useStoredLines && canonicalSpan?.start_line !== undefined ? canonicalSpan.start_line : String(lineNumberAt(text, sliceStart)),
      end_line: useStoredLines && canonicalSpan?.end_line !== undefined ? canonicalSpan.end_line : String(lineNumberAt(text, Math.max(sliceEnd - 1, sliceStart))),
    },
    truncated,
    redacted: false,
    redactions: [],
  };
}
