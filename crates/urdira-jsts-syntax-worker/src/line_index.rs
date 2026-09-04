//! A4 (line numbers task, 2026-09-05): a UTF-16-code-unit line index over one
//! file's own source text, built once per parse and carried on
//! [`crate::SyntaxFileResult`] so every `ProposedRecord` producer in this
//! crate can turn a `(start, end)` span -- ALWAYS UTF-16 code-unit offsets
//! here (`Utf8ToUtf16::convert_program` runs before any span this crate ever
//! reads, see `parse_source`) -- into 1-based `start_line`/`end_line` numbers
//! WITHOUT re-scanning the file per record.
//!
//! Line semantics deliberately mirror TypeScript's own `computeLineStarts`
//! (`packages/typescript/src/compiler/scanner.ts`), the function that backs
//! every editor's line/column display and `getLineAndCharacterOfPosition`:
//! a line break is `\n`, `\r\n` (counted ONCE, never as two lines), a lone
//! `\r`, or the two Unicode line/paragraph separators `\u{2028}`/`\u{2029}`.
//! `end_line` is the line of the `end` offset treated as EXCLUSIVE -- the
//! line the last INCLUDED code unit (`end - 1`) is on, computed by looking
//! up `end` directly against each line's own start offset (see [`LineIndex::
//! line_of`]'s doc comment for why that is the same thing without a
//! separate "off by one" case).
use serde::Serialize;

/// `starts_utf16[i]` is the UTF-16 code-unit offset where line `i + 1`
/// begins (`starts_utf16[0]` is always `0`, matching every file's own line 1
/// starting at its very first code unit -- including an EMPTY file, which
/// still has exactly one line). Strictly increasing by construction (each
/// entry is pushed only immediately after consuming a line-break sequence
/// that itself advanced the running offset), so a binary search
/// (`partition_point`) is enough to answer [`LineIndex::line_of`] without a
/// linear scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LineIndex {
    starts_utf16: Vec<u32>,
}

impl LineIndex {
    /// Builds the index from `text` (ORIGINAL UTF-8 source, not yet
    /// UTF-16-converted -- this walks `text.chars()` itself and sums each
    /// character's own `char::len_utf16()`, so the offsets it produces line
    /// up with `Utf8ToUtf16::convert_program`'s own output exactly, the same
    /// way `SyntaxCollector::new(&source.path, text.encode_utf16().count()
    /// as u32)` already does for the file's total length). One pass, O(n).
    pub fn from_text(text: &str) -> Self {
        let mut starts_utf16 = Vec::with_capacity(text.len() / 32 + 1);
        starts_utf16.push(0u32);
        let mut offset: u32 = 0;
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            offset = offset.saturating_add(c.len_utf16() as u32);
            let is_line_break = match c {
                '\n' => true,
                '\r' => {
                    // `\r\n` is ONE line break, not two: consume the `\n`
                    // right here (rather than letting the next loop
                    // iteration see it and push a second, phantom, empty
                    // line) so `starts_utf16` never records a break inside
                    // a `\r\n` pair.
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                        offset = offset.saturating_add(1);
                    }
                    true
                }
                '\u{2028}' | '\u{2029}' => true,
                _ => false,
            };
            if is_line_break {
                starts_utf16.push(offset);
            }
        }
        Self { starts_utf16 }
    }

    /// 1-based line number containing UTF-16 code-unit `offset_utf16`.
    /// `offset_utf16` may be treated as either an inclusive start or an
    /// exclusive end -- both read the same way here: the line whose OWN
    /// start is the greatest one `<= offset_utf16`. For an exclusive `end`
    /// that lands exactly on a line-break boundary (a span that ends right
    /// AT a newline, e.g. a statement whose trailing `;` is the last
    /// character before the line break), `offset_utf16` still equals the
    /// PRIOR line's own upper bound, one past its last code unit, which is
    /// `< ` the next line's start -- so it correctly resolves to the line
    /// the span's own content is actually on, never the line after.
    /// `offset_utf16` at or past the file's own total length resolves to
    /// the last line, exactly like `end == text.len()` (end of file) should.
    pub fn line_of(&self, offset_utf16: u32) -> u32 {
        self.starts_utf16
            .partition_point(|&start| start <= offset_utf16) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::LineIndex;

    #[test]
    fn empty_file_has_one_line() {
        let index = LineIndex::from_text("");
        assert_eq!(index.line_of(0), 1);
    }

    #[test]
    fn ascii_multiline() {
        // line 1: "ab"  (offsets 0..2, break at 2)
        // line 2: "cd"  (offsets 3..5, break at 5)
        // line 3: "e"   (offsets 6..7)
        let text = "ab\ncd\ne";
        let index = LineIndex::from_text(text);
        assert_eq!(index.line_of(0), 1); // 'a'
        assert_eq!(index.line_of(1), 1); // 'b'
        assert_eq!(index.line_of(2), 1); // end of "ab" (exclusive), still line 1
        assert_eq!(index.line_of(3), 2); // 'c'
        assert_eq!(index.line_of(4), 2); // 'd'
        assert_eq!(index.line_of(5), 2); // end of "cd" (exclusive), still line 2
        assert_eq!(index.line_of(6), 3); // 'e'
        assert_eq!(index.line_of(7), 3); // end of file (exclusive end == length)
    }

    #[test]
    fn multibyte_before_break() {
        // "café\nx": 'c','a','f' are 1 UTF-16 unit each, 'é' (U+00E9, BMP) is
        // also 1 UTF-16 unit -- but 5 UTF-8 BYTES total for "café" (é is
        // 2 UTF-8 bytes) vs. 4 UTF-16 units, the exact split the A4 task
        // calls out. Line 1 is "café" (units 0..4, break at 4), line 2 is
        // "x" (unit 5).
        assert_eq!("café".len(), 5); // UTF-8 byte length
        assert_eq!("café".encode_utf16().count(), 4); // UTF-16 unit length
        let text = "café\nx";
        let index = LineIndex::from_text(text);
        assert_eq!(index.line_of(0), 1); // 'c'
        assert_eq!(index.line_of(3), 1); // 'é' (last unit of "café")
        assert_eq!(index.line_of(4), 1); // end of "café" (exclusive), still line 1
        assert_eq!(index.line_of(5), 2); // 'x'
    }

    #[test]
    fn crlf_counts_as_one_break() {
        // "a\r\nb": 'a' (unit 0), \r\n (units 1..3, ONE break), 'b' (unit 3).
        let text = "a\r\nb";
        let index = LineIndex::from_text(text);
        assert_eq!(index.line_of(0), 1); // 'a'
        assert_eq!(index.line_of(1), 1); // '\r' itself, still line 1
        assert_eq!(index.line_of(3), 2); // 'b', start of line 2
    }

    #[test]
    fn lone_cr_is_a_break() {
        // "a\rb": a lone \r (no following \n) is still its own line break.
        let text = "a\rb";
        let index = LineIndex::from_text(text);
        assert_eq!(index.line_of(0), 1); // 'a'
        assert_eq!(index.line_of(2), 2); // 'b', start of line 2
    }

    #[test]
    fn unicode_line_and_paragraph_separators_are_breaks() {
        let text = "a\u{2028}b\u{2029}c";
        let index = LineIndex::from_text(text);
        assert_eq!(index.line_of(0), 1); // 'a'
        assert_eq!(index.line_of(2), 2); // 'b' (after U+2028, 1 UTF-16 unit)
        assert_eq!(index.line_of(4), 3); // 'c' (after U+2029, 1 UTF-16 unit)
    }

    #[test]
    fn offset_at_end_of_file_resolves_to_last_line() {
        let text = "one\ntwo\nthree";
        let index = LineIndex::from_text(text);
        let total_units = text.encode_utf16().count() as u32;
        assert_eq!(index.line_of(total_units), 3);
    }
}
