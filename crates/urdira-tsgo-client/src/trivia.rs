//! A conservative port of the TypeScript scanner's `skipTrivia`
//! (`node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/dist/ast/scanner.js:358`),
//! used to turn a node's `pos` (which includes leading trivia — whitespace
//! and comments the parser attached to the node rather than its previous
//! sibling) into its `getStart()` (the first token's actual position),
//! exactly the way `getTokenPosOfNode`
//! (`dist/ast/astnav.js:253`) does for the ordinary, non-JSDoc case:
//! `skipTrivia(text, node.pos, /*stopAfterLineBreak*/ false,
//! /*stopAtComments*/ false, /*inJSDoc*/ !!(node.flags & NodeFlags.JSDoc))`.
//!
//! Operates on UTF-16 code units (`&[u16]`), matching the checker's own
//! position units (`crate::node`'s doc comment) — a JS string is a UTF-16
//! code unit sequence, and `node.pos`/`node.end` index into it directly.
//!
//! # Known deviations from the real scanner
//!
//! - Conflict-marker trivia (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>` at
//!   start of line) is not recognized; a real conflict marker left in
//!   source under test would stop trivia-skipping one character early,
//!   which does not occur in any oracle fixture. Documented here rather
//!   than silently risking a mismatch: a resolver that hits this would see
//!   a name-identifier start off by a few bytes into the marker line.
//! - `isWhiteSpaceLike` for non-ASCII code points is approximated by the
//!   small set of Unicode space separators the scanner itself special-cases
//!   (`scanner.js`'s `isWhiteSpaceSingleLine`), not the full Unicode `Zs`
//!   category. Source using an exotic Unicode space character as
//!   leading trivia (vanishingly rare in real code) could disagree by one
//!   code unit.
//! - Shebang (`#!...`) is only recognized at `pos == 0` and only descends
//!   into it when trivia-skipping starts there — matching the scanner,
//!   which also gates shebang recognition on absolute position 0.

/// Skips leading trivia starting at UTF-16 offset `pos` in `text`, mirroring
/// `skipTrivia(text, pos, stopAfterLineBreak=false, stopAtComments=false,
/// inJSDoc)`. Returns the offset of the first non-trivia code unit (which
/// may be `text.len()` if the file ends in trivia).
pub fn skip_trivia(text: &[u16], pos: usize, in_jsdoc: bool) -> usize {
    if text.is_empty() {
        return pos;
    }
    let len = text.len();
    let mut pos = pos.min(len);
    let mut can_consume_star = false;
    loop {
        if pos >= len {
            return pos;
        }
        let ch = text[pos];
        match ch {
            CR => {
                if peek(text, pos + 1) == Some(LF) {
                    pos += 1;
                }
                pos += 1;
                can_consume_star = in_jsdoc;
                continue;
            }
            LF => {
                pos += 1;
                can_consume_star = in_jsdoc;
                continue;
            }
            TAB | VTAB | FORM_FEED | SPACE => {
                pos += 1;
                continue;
            }
            SLASH => {
                if peek(text, pos + 1) == Some(SLASH) {
                    pos += 2;
                    while pos < len && !is_line_break(text[pos]) {
                        pos += 1;
                    }
                    can_consume_star = false;
                    continue;
                }
                if peek(text, pos + 1) == Some(ASTERISK) {
                    pos += 2;
                    while pos < len {
                        if text[pos] == ASTERISK && peek(text, pos + 1) == Some(SLASH) {
                            pos += 2;
                            break;
                        }
                        pos += 1;
                    }
                    can_consume_star = false;
                    continue;
                }
                return pos;
            }
            HASH => {
                if pos == 0 && is_shebang(text) {
                    pos = scan_shebang(text);
                    continue;
                }
                return pos;
            }
            ASTERISK => {
                if can_consume_star {
                    pos += 1;
                    can_consume_star = false;
                    continue;
                }
                return pos;
            }
            _ => {
                if ch > MAX_ASCII && is_extra_whitespace(ch) {
                    pos += 1;
                    continue;
                }
                return pos;
            }
        }
    }
}

fn peek(text: &[u16], index: usize) -> Option<u16> {
    text.get(index).copied()
}

fn is_line_break(ch: u16) -> bool {
    ch == LF || ch == CR || ch == LINE_SEPARATOR || ch == PARAGRAPH_SEPARATOR
}

/// Non-ASCII whitespace the scanner treats as trivia
/// (`isWhiteSpaceSingleLine` in `scanner.js`), beyond line breaks (handled
/// separately above via `is_line_break`, not this function).
fn is_extra_whitespace(ch: u16) -> bool {
    matches!(
        ch,
        0x00A0 // NBSP
            | 0x1680
            | 0x2000
            ..=0x200A
            | 0x202F
            | 0x205F
            | 0x3000
            | 0xFEFF // BOM
            | LINE_SEPARATOR
            | PARAGRAPH_SEPARATOR
    )
}

fn is_shebang(text: &[u16]) -> bool {
    peek(text, 0) == Some(HASH) && peek(text, 1) == Some(BANG)
}

fn scan_shebang(text: &[u16]) -> usize {
    let mut pos = 2;
    while pos < text.len() && !is_line_break(text[pos]) {
        pos += 1;
    }
    pos
}

const CR: u16 = 0x000D;
const LF: u16 = 0x000A;
const TAB: u16 = 0x0009;
const VTAB: u16 = 0x000B;
const FORM_FEED: u16 = 0x000C;
const SPACE: u16 = 0x0020;
const SLASH: u16 = b'/' as u16;
const ASTERISK: u16 = b'*' as u16;
const HASH: u16 = b'#' as u16;
const BANG: u16 = b'!' as u16;
const MAX_ASCII: u16 = 0x007F;
const LINE_SEPARATOR: u16 = 0x2028;
const PARAGRAPH_SEPARATOR: u16 = 0x2029;

/// Converts a UTF-8 Rust string to the UTF-16 code unit buffer the checker's
/// positions index into.
pub fn to_utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skip(text: &str, pos: usize) -> usize {
        skip_trivia(&to_utf16(text), pos, false)
    }

    #[test]
    fn skips_ascii_whitespace() {
        assert_eq!(skip("   foo", 0), 3);
    }

    #[test]
    fn skips_line_comment() {
        assert_eq!(skip("// hi\nfoo", 0), 6);
    }

    #[test]
    fn skips_block_comment() {
        assert_eq!(skip("/* hi */foo", 0), 8);
    }

    #[test]
    fn skips_unterminated_block_comment_to_eof() {
        let text = "/* never closes";
        assert_eq!(skip(text, 0), to_utf16(text).len());
    }

    #[test]
    fn skips_shebang_only_at_position_zero() {
        assert_eq!(skip("#!/usr/bin/env node\nfoo", 0), 20);
    }

    #[test]
    fn does_not_treat_hash_as_shebang_mid_file() {
        // pos starts mid-file at the '#'; not position 0 in the buffer sense
        // this function checks (it checks absolute index 0 of `text`), so a
        // '#' anywhere but the very start of the buffer is returned as-is.
        let text = "x; #!not-a-shebang";
        let idx = text.find('#').unwrap();
        assert_eq!(skip(text, idx), idx);
    }

    #[test]
    fn stops_at_non_trivia_immediately() {
        assert_eq!(skip("foo", 0), 0);
    }

    #[test]
    fn combines_whitespace_and_comments() {
        assert_eq!(skip("  /* a */  // b\n  foo", 0), 18);
    }

    #[test]
    fn jsdoc_mode_consumes_leading_stars_after_newline() {
        // Mirrors the scanner's canConsumeStar behavior used for JSDoc
        // comment bodies: after a line break, a run of '*' is trivia too.
        let text = "\n * foo";
        let utf16 = to_utf16(text);
        assert_eq!(skip_trivia(&utf16, 0, true), 4);
    }

    #[test]
    fn empty_text_returns_pos() {
        assert_eq!(skip_trivia(&[], 0, false), 0);
    }
}
