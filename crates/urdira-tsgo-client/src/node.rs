//! Decoder for the binary AST payload `getSourceFile` returns (the `data`
//! field of a `SourceFileResponse`, base64-decoded by the caller before it
//! reaches this module).
//!
//! Layout transcribed from
//! `dist/api/node/protocol.js` (offsets/constants) and
//! `dist/api/node/node.js`/`node.generated.js`/`node.infrastructure.js`
//! (how those offsets are used — header, node table, string table, and the
//! `next`-pointer sibling-chain traversal `forEachChild` relies on, which
//! this module reuses for `descend_to_span` instead of porting the
//! generated `childProperties` table). See the crate-level docs for what is
//! deliberately NOT ported (structured/extended data beyond `fileName`/
//! `path`, emit, msgpack-encoded reference lists).
//!
//! # Position units
//!
//! `pos`/`end` on every node are UTF-16 code unit offsets into the source
//! file's text — the checker is a port of code written against JS strings,
//! which are UTF-16 sequences, and never converted to byte offsets or code
//! points. This module always takes the caller's own copy of the file text
//! (as `&[u16]`, see `crate::trivia::to_utf16`) for anything position-based
//! (`node_start`, `descend_to_span`), rather than decoding the source file's
//! own text out of the binary payload's string table — the two are the same
//! bytes (the caller handed tsgo this exact text via `VirtualFs::read_file`
//! when it built the snapshot), and skipping the round trip through the
//! string table's WTF-8 encoding sidesteps having to implement WTF-8
//! decoding to `u16` (this crate's `getString` only ever decodes short,
//! plain-ASCII path strings — see `fn get_string` below — for which lossy
//! UTF-8 decoding is exact).

use std::collections::HashMap;

use crate::trivia::skip_trivia;

pub const PROTOCOL_VERSION: u8 = 5;

const HEADER_OFFSET_STRING_TABLE_OFFSETS: usize = 24;
const HEADER_OFFSET_STRING_TABLE: usize = 28;
const HEADER_OFFSET_EXTENDED_DATA: usize = 32;
const HEADER_OFFSET_NODES: usize = 40;
const HEADER_SIZE: usize = 44;

const NODE_LEN: usize = 28;
const NODE_OFFSET_KIND: usize = 0;
const NODE_OFFSET_POS: usize = 4;
const NODE_OFFSET_END: usize = 8;
const NODE_OFFSET_NEXT: usize = 12;
const NODE_OFFSET_PARENT: usize = 16;
const NODE_OFFSET_DATA: usize = 20;
const NODE_OFFSET_FLAGS: usize = 24;

const KIND_NODE_LIST: u32 = 0xFFFF_FFFF;
const NODE_DATA_TYPE_MASK: u32 = 0xC000_0000;
const NODE_DATA_TYPE_EXTENDED: u32 = 0x8000_0000;
const NODE_EXTENDED_DATA_MASK: u32 = 0x00FF_FFFF;

/// `SyntaxKind` values this crate reasons about by number, transcribed from
/// `dist/enums/syntaxKind.enum.js` (TypeScript 7.0.2). Not a full port of
/// the enum — only the kinds `ResidualResolver` and its tests reference.
pub mod syntax_kind {
    pub const IDENTIFIER: u32 = 79;
    pub const PRIVATE_IDENTIFIER: u32 = 80;
    pub const CONSTRUCTOR_KEYWORD: u32 = 136;
    /// `PropertySignature` (an interface/type-literal member declaration,
    /// e.g. `interface Baz { sigProp: number; }`) — verified live against a
    /// real tsgo session (P1-D-f), the same way `METHOD_DECLARATION`/
    /// `CONSTRUCTOR` below were, not guessed from classic `tsc`'s own
    /// (differently-numbered) `SyntaxKind` enum.
    pub const PROPERTY_SIGNATURE: u32 = 172;
    pub const PROPERTY_DECLARATION: u32 = 173;
    /// `Parameter` -- verified live, P1-D-f. NOT a class/interface member at
    /// all (a function/method/arrow parameter declaration, e.g. the `resolve`
    /// in `new Promise((resolve) => ...)`), but `ResidualResolver` can and
    /// does resolve a call's callee straight to one of these (a parameter
    /// used as a callback, later invoked) -- `analyzer.ts`'s own v3 entity
    /// producer (`addEntity`, `packages/plugin-javascript-typescript/src/
    /// analyzer.ts:462`) gives this its own `"parameter"` kind word, never
    /// folding it into the generic member label the way this crate's
    /// `member_kind_name` used to before P1-D-f's parity diff caught the
    /// mismatch live (`jsts:parameter:...` in v3 vs `jsts:member:...` in v4
    /// for the exact same declaration -- a large share of that diff's
    /// `v4_confirmed_different_target` bucket, a pure identity-label
    /// mismatch, not a wrong resolution).
    pub const PARAMETER: u32 = 170;
    /// `VariableDeclaration` -- verified live, P1-D-f. Needed for
    /// `RemoteSourceFile::declaration_name_with_kind`'s "climb to the
    /// enclosing named binding" fallback: `const foo = async () => {...}`
    /// resolves a call to `foo()` to the ARROW FUNCTION's own declaration
    /// node (no name of its own), not the `VariableDeclaration` that
    /// actually carries the name `foo` -- see that method's own doc comment.
    pub const VARIABLE_DECLARATION: u32 = 261;
    /// `ArrowFunction` -- verified live, P1-D-f (same context as
    /// `VARIABLE_DECLARATION` above).
    pub const ARROW_FUNCTION: u32 = 220;
    /// `FunctionExpression` (`const g = function() {...}`) -- same context,
    /// verified live, P1-D-f.
    pub const FUNCTION_EXPRESSION: u32 = 219;
    /// `MethodSignature` (an interface/type-literal method declaration,
    /// e.g. `interface Baz { sigMethod(): void; }`) — verified live, P1-D-f.
    pub const METHOD_SIGNATURE: u32 = 174;
    pub const METHOD_DECLARATION: u32 = 175;
    /// Verified live, P1-D-f (a class's own `get`/`set` accessor
    /// declaration).
    pub const GET_ACCESSOR: u32 = 178;
    pub const SET_ACCESSOR: u32 = 179;
    pub const CONSTRUCTOR: u32 = 177;
    pub const PROPERTY_ACCESS_EXPRESSION: u32 = 212;
    pub const CALL_EXPRESSION: u32 = 214;
    pub const NEW_EXPRESSION: u32 = 215;
    pub const EXPRESSION_WITH_TYPE_ARGUMENTS: u32 = 234;
    pub const CLASS_DECLARATION: u32 = 264;
    pub const HERITAGE_CLAUSE: u32 = 299;
    pub const SOURCE_FILE: u32 = 307;
    pub const JSDOC: u32 = 315;
}

/// `NodeFlags.JSDoc` (`dist/enums/nodeFlags.enum.js`), the one flag bit this
/// crate reads: it selects `skipTrivia`'s `inJSDoc` mode in `getStart` for
/// nodes synthesized while parsing a JSDoc comment.
const NODE_FLAG_JSDOC: u32 = 0x0040_0000;

#[derive(Debug)]
pub enum DecodeError {
    TooShort { len: usize, need: usize },
    UnsupportedProtocolVersion { found: u8, expected: u8 },
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::TooShort { len, need } => {
                write!(
                    f,
                    "source file payload too short: {len} bytes, need at least {need}"
                )
            }
            DecodeError::UnsupportedProtocolVersion { found, expected } => write!(
                f,
                "tsgo binary protocol version {found} does not match the version this client was \
                 built against ({expected}); the wire format is unversioned beyond this single byte, \
                 so a mismatch here means decoding below is unsafe to trust"
            ),
        }
    }
}

impl std::error::Error for DecodeError {}

/// A decoded `getSourceFile` binary payload: the node table plus the two
/// extended-data strings (`fileName`, `path`) this crate needs to build
/// node handles. See the module doc for what is intentionally not decoded.
pub struct RemoteSourceFile {
    data: Vec<u8>,
    offset_string_table_offsets: u32,
    offset_string_table: u32,
    offset_nodes: u32,
    node_count: usize,
    pub protocol_version: u8,
    pub file_name: String,
    pub path: String,
}

impl std::fmt::Debug for RemoteSourceFile {
    /// Deliberately omits the raw `data` payload (can be megabytes for a
    /// large file) — this is for test-failure messages, not full fidelity.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteSourceFile")
            .field("path", &self.path)
            .field("file_name", &self.file_name)
            .field("protocol_version", &self.protocol_version)
            .field("node_count", &self.node_count)
            .field("bytes", &self.data.len())
            .finish()
    }
}

fn read_u32(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
}

fn read_i32(data: &[u8], offset: usize) -> i32 {
    i32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
}

impl RemoteSourceFile {
    /// Decodes a `getSourceFile` binary payload (already base64-decoded).
    /// `expected_protocol_version` is normally `PROTOCOL_VERSION`; a caller
    /// exercising version-mismatch handling can pass something else.
    pub fn decode(data: Vec<u8>, expected_protocol_version: u8) -> Result<Self, DecodeError> {
        if data.len() < HEADER_SIZE {
            return Err(DecodeError::TooShort {
                len: data.len(),
                need: HEADER_SIZE,
            });
        }
        let metadata = read_u32(&data, 0);
        let protocol_version = (metadata >> 24) as u8;
        if protocol_version != expected_protocol_version {
            return Err(DecodeError::UnsupportedProtocolVersion {
                found: protocol_version,
                expected: expected_protocol_version,
            });
        }
        let offset_string_table_offsets = read_u32(&data, HEADER_OFFSET_STRING_TABLE_OFFSETS);
        let offset_string_table = read_u32(&data, HEADER_OFFSET_STRING_TABLE);
        let offset_extended_data = read_u32(&data, HEADER_OFFSET_EXTENDED_DATA);
        let offset_nodes = read_u32(&data, HEADER_OFFSET_NODES);
        if (offset_nodes as usize) > data.len() {
            return Err(DecodeError::TooShort {
                len: data.len(),
                need: offset_nodes as usize,
            });
        }
        let node_count = (data.len() - offset_nodes as usize) / NODE_LEN;

        let mut file = RemoteSourceFile {
            data,
            offset_string_table_offsets,
            offset_string_table,
            offset_nodes,
            node_count,
            protocol_version,
            file_name: String::new(),
            path: String::new(),
        };

        // SourceFile is always node index 1 (index 0 is the nil sentinel);
        // its `data` field (NODE_DATA_TYPE_EXTENDED) holds the extended-data
        // record offset, whose first two u32 slots are the fileName/path
        // string-table indices (`node.generated.js`'s `fileName`/`path`
        // getters, offsets +4/+8 from the record start).
        if node_count > 1 {
            let source_file_data = file.data_field(1);
            if source_file_data & NODE_DATA_TYPE_MASK == NODE_DATA_TYPE_EXTENDED {
                let record = offset_extended_data + (source_file_data & NODE_EXTENDED_DATA_MASK);
                let file_name_index = read_u32(&file.data, record as usize + 4);
                let path_index = read_u32(&file.data, record as usize + 8);
                file.file_name = file.get_string(file_name_index);
                file.path = file.get_string(path_index);
            }
        }
        Ok(file)
    }

    fn node_byte_offset(&self, index: usize) -> usize {
        self.offset_nodes as usize + index * NODE_LEN
    }

    pub fn node_count(&self) -> usize {
        self.node_count
    }

    pub fn kind(&self, index: usize) -> u32 {
        read_u32(&self.data, self.node_byte_offset(index) + NODE_OFFSET_KIND)
    }

    pub fn pos(&self, index: usize) -> i32 {
        read_i32(&self.data, self.node_byte_offset(index) + NODE_OFFSET_POS)
    }

    pub fn end(&self, index: usize) -> i32 {
        read_i32(&self.data, self.node_byte_offset(index) + NODE_OFFSET_END)
    }

    pub fn next_index(&self, index: usize) -> u32 {
        read_u32(&self.data, self.node_byte_offset(index) + NODE_OFFSET_NEXT)
    }

    pub fn parent_index(&self, index: usize) -> u32 {
        read_u32(
            &self.data,
            self.node_byte_offset(index) + NODE_OFFSET_PARENT,
        )
    }

    pub fn data_field(&self, index: usize) -> u32 {
        read_u32(&self.data, self.node_byte_offset(index) + NODE_OFFSET_DATA)
    }

    pub fn flags(&self, index: usize) -> u32 {
        read_u32(&self.data, self.node_byte_offset(index) + NODE_OFFSET_FLAGS)
    }

    pub fn is_node_list(&self, index: usize) -> bool {
        self.kind(index) == KIND_NODE_LIST
    }

    /// Mirrors `RemoteNode.hasChildren()`: true iff there is a following
    /// node slot and it is parented directly to `index` (rather than to
    /// some ancestor, which is what a node with no children looks like once
    /// the *next* sibling in encoding order belongs to an enclosing node).
    pub fn has_children(&self, index: usize) -> bool {
        if index + 1 >= self.node_count {
            return false;
        }
        self.parent_index(index + 1) as usize == index
    }

    /// Flattened immediate children of `index`, in source order, with
    /// `NodeList` containers transparently flattened into their elements
    /// and `JSDoc` nodes skipped — exactly what `node.forEachChild(visitNode)`
    /// (single-argument form, no `visitList`) yields, which is the only
    /// form `analyzer.ts`'s checker-side traversal (`descendToPendingSiteSpan`)
    /// uses.
    pub fn children(&self, index: usize) -> Vec<usize> {
        let mut result = Vec::new();
        if !self.has_children(index) {
            return result;
        }
        let mut next = index + 1;
        loop {
            if self.is_node_list(next) {
                // A NodeList's own children start right after it, same
                // "next-pointer chain" shape, and its `data` field holds the
                // list length (not needed here — we simply walk `next`
                // pointers until they land back outside the list, exactly
                // as `RemoteNodeList.forEachNode` does).
                let mut list_next = next + 1;
                let list_len = self.data_field(next) as usize;
                for _ in 0..list_len {
                    if self.kind(list_next) != syntax_kind::JSDOC {
                        result.push(list_next);
                    }
                    let advance = self.next_index(list_next);
                    if advance == 0 {
                        break;
                    }
                    list_next = advance as usize;
                }
            } else if self.kind(next) != syntax_kind::JSDOC {
                result.push(next);
            }
            let advance = self.next_index(next);
            if advance == 0 {
                break;
            }
            next = advance as usize;
        }
        result
    }

    /// `getTokenPosOfNode`'s non-JSDoc, non-"missing" branch: skip leading
    /// trivia from `pos(index)`, honoring `NodeFlags.JSDoc` the same way the
    /// real checker does. `text` is the caller's own UTF-16 buffer for this
    /// file (see the module doc for why this crate never decodes text out
    /// of the binary payload itself).
    pub fn node_start(&self, index: usize, text: &[u16]) -> i32 {
        let pos = self.pos(index).max(0) as usize;
        let end = self.end(index);
        if self.pos(index) == end && self.pos(index) >= 0 {
            // `nodeIsMissing`: a zero-width node's `pos` IS its start; skipping
            // trivia would incorrectly walk past it into the next token.
            return self.pos(index);
        }
        let in_jsdoc = self.flags(index) & NODE_FLAG_JSDOC != 0;
        skip_trivia(text, pos, in_jsdoc) as i32
    }

    /// Heuristic stand-in for the checker's `.name` property access
    /// (`analyzer.ts`'s `identityStart` computation), since this crate's
    /// decoder does not port `childProperties` (the per-`SyntaxKind` table
    /// naming which child is which). Returns the start of the first
    /// immediate `Identifier`/`PrivateIdentifier` child, which agrees with
    /// `.name` for every plain-named declaration (classes, interfaces,
    /// functions, methods, properties, enums, variables with a simple
    /// identifier binding).
    ///
    /// Known divergences (documented, not fixed — narrow and rare in
    /// practice): a `ComputedPropertyName` key (`[expr]() {}`) or a
    /// destructuring binding (`const { a, b } = x`) has no immediate
    /// Identifier child at all, so this returns `None` for those (the
    /// caller then falls back to the declaration's own start, matching
    /// `analyzer.ts`'s `nameNode === undefined` branch) rather than the
    /// real `.name` node's position.
    pub fn name_start(&self, index: usize, text: &[u16]) -> Option<i32> {
        for child in self.children(index) {
            let kind = self.kind(child);
            if kind == syntax_kind::IDENTIFIER || kind == syntax_kind::PRIVATE_IDENTIFIER {
                return Some(self.node_start(child, text));
            }
        }
        None
    }

    /// Port of `analyzer.ts`'s `constructorKeywordStart`
    /// (`packages/plugin-javascript-typescript/src/analyzer.ts:701`), which
    /// runs a real scanner from the constructor declaration's start to find
    /// the `constructor` keyword token (skipping any access-modifier
    /// keywords first). This crate has no scanner, so it instead scans
    /// `text` word-by-word from `node_start(index)` for the literal token
    /// `"constructor"` bounded by non-identifier characters on both sides —
    /// sufficient because a `ConstructorDeclaration`'s only possible leading
    /// tokens before the `constructor` keyword are access-modifier keywords
    /// (`public`/`private`/`protected`), which contain no `"constructor"`
    /// substring, so the first whole-word match is unambiguously the
    /// keyword itself, not decoration or a differently-cased property.
    pub fn constructor_keyword_start(&self, index: usize, text: &[u16]) -> i32 {
        let mut pos = self.node_start(index, text) as usize;
        let needle: Vec<u16> = "constructor".encode_utf16().collect();
        while pos < text.len() {
            pos = skip_trivia(text, pos, false);
            if pos >= text.len() {
                break;
            }
            if is_identifier_start(text[pos]) {
                let word_start = pos;
                let mut word_end = pos;
                while word_end < text.len() && is_identifier_part(text[word_end]) {
                    word_end += 1;
                }
                if text[word_start..word_end] == needle[..] {
                    return word_start as i32;
                }
                pos = word_end;
                continue;
            }
            // Punctuation between modifiers is not expected before
            // `constructor`, but advance defensively rather than looping
            // forever on unexpected input.
            pos += 1;
        }
        self.node_start(index, text)
    }

    /// Port of `descendToPendingSiteSpan`
    /// (`packages/plugin-javascript-typescript/src/analyzer.ts:1494-1510`):
    /// descends from `cursor`'s last frame (rewinding first to the deepest
    /// ancestor still containing `[start, end)`) to the innermost child
    /// whose span contains it, mutating `cursor` in place the same way the
    /// TS original does so repeated calls for span-sorted sites reuse the
    /// common-ancestor prefix instead of re-descending from the root.
    /// `cursor[0]` must be the source file's node index (1).
    pub fn descend_to_span(
        &self,
        cursor: &mut Vec<usize>,
        text: &[u16],
        start: i32,
        end: i32,
    ) -> usize {
        while cursor.len() > 1 {
            let frame = *cursor.last().unwrap();
            if self.node_start(frame, text) <= start && end <= self.end(frame) {
                break;
            }
            cursor.pop();
        }
        loop {
            let current = *cursor.last().unwrap();
            let mut next: Option<usize> = None;
            for child in self.children(current) {
                if self.node_start(child, text) <= start && end <= self.end(child) {
                    next = Some(child);
                    break;
                }
            }
            match next {
                None => return current,
                Some(child) => cursor.push(child),
            }
        }
    }

    /// Reads a string-table entry the way `RemoteNode.getString` does:
    /// `[offsets[index], offsets[index+1])` into the string table byte
    /// pool. This crate only ever calls it for `fileName`/`path` (short,
    /// plain file-path text), so plain (lossy) UTF-8 decoding is used
    /// rather than porting the real client's WTF-8 decoder — see the
    /// module doc's "Position units" section for why arbitrary source text
    /// is never round-tripped through this path at all.
    fn get_string(&self, index: u32) -> String {
        let start = read_u32(
            &self.data,
            self.offset_string_table_offsets as usize + index as usize * 4,
        );
        let end = read_u32(
            &self.data,
            self.offset_string_table_offsets as usize + (index as usize + 1) * 4,
        );
        let bytes = &self.data[self.offset_string_table as usize + start as usize
            ..self.offset_string_table as usize + end as usize];
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn is_identifier_start(ch: u16) -> bool {
    (ch < 128 && (ch as u8 as char).is_ascii_alphabetic()) || ch == b'_' as u16 || ch == b'$' as u16
}

fn is_identifier_part(ch: u16) -> bool {
    is_identifier_start(ch) || (ch < 128 && (ch as u8 as char).is_ascii_digit())
}

/// Reads the identifier (or private-identifier, `#`-prefixed) token starting
/// exactly at UTF-16 offset `start` in `text`, or `None` if `start` is out
/// of range or does not begin an identifier. Used by
/// `crate::residual_pass` to recover a human-readable symbol name for an
/// `External` (lib-file) resolution target from `ResolvedDeclaration::
/// name_identifier_start` alone, without a scanner or a second checker
/// round trip — the same identifier-boundary rules `name_start`/
/// `constructor_keyword_start` above already use.
pub fn identifier_text_at(text: &[u16], start: i32) -> Option<String> {
    if start < 0 {
        return None;
    }
    let mut pos = start as usize;
    if pos >= text.len() {
        return None;
    }
    let leading_hash = text[pos] == b'#' as u16;
    if leading_hash {
        pos += 1;
    }
    let word_start = pos;
    if pos >= text.len() || !is_identifier_start(text[pos]) {
        return None;
    }
    while pos < text.len() && is_identifier_part(text[pos]) {
        pos += 1;
    }
    let from = if leading_hash {
        start as usize
    } else {
        word_start
    };
    String::from_utf16(&text[from..pos]).ok()
}

/// A node handle string, `"{index}.{kind}.{path}"`
/// (`dist/api/node/node.js`'s `getNodeId`/`parseNodeHandle`), used to
/// address a specific AST node in server requests (`getSymbolsAtLocations`,
/// `getResolvedSignature`, ...) and in symbol/signature responses
/// (`declarations`, `valueDeclaration`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeHandle {
    pub index: u32,
    pub kind: u32,
    pub path: String,
}

impl NodeHandle {
    pub fn new(index: u32, kind: u32, path: impl Into<String>) -> Self {
        Self {
            index,
            kind,
            path: path.into(),
        }
    }

    pub fn to_wire(&self) -> String {
        format!("{}.{}.{}", self.index, self.kind, self.path)
    }

    pub fn parse(handle: &str) -> Option<Self> {
        let first_dot = handle.find('.')?;
        let rest = &handle[first_dot + 1..];
        let second_dot = rest.find('.')?;
        let index: u32 = handle[..first_dot].parse().ok()?;
        let kind: u32 = rest[..second_dot].parse().ok()?;
        let path = rest[second_dot + 1..].to_string();
        Some(NodeHandle { index, kind, path })
    }
}

impl std::fmt::Display for NodeHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_wire())
    }
}

/// Cache of decoded `RemoteSourceFile`s keyed by path, so a resolver walking
/// many pending sites across a window of files fetches each file's AST
/// exactly once regardless of how many declarations/references land in it.
#[derive(Default)]
pub struct SourceFileCache {
    files: HashMap<String, std::sync::Arc<RemoteSourceFile>>,
}

impl SourceFileCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, path: &str) -> Option<std::sync::Arc<RemoteSourceFile>> {
        self.files.get(path).cloned()
    }

    pub fn insert(&mut self, path: String, file: std::sync::Arc<RemoteSourceFile>) {
        self.files.insert(path, file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hand-builds a minimal single-node (SourceFile only, no children)
    /// binary payload matching the real encoder's layout, to unit-test the
    /// header/node-table decoder without spawning tsgo. `tests/oracle_*.rs`
    /// covers decoding a payload captured from the real binary.
    fn build_minimal_payload(file_name: &str, path: &str) -> Vec<u8> {
        let mut string_bytes = Vec::new();
        let mut offsets = Vec::new();
        let push_string = |s: &str, bytes: &mut Vec<u8>, offsets: &mut Vec<u32>| {
            let start = bytes.len() as u32;
            bytes.extend_from_slice(s.as_bytes());
            let end = bytes.len() as u32;
            offsets.push(start);
            offsets.push(end);
        };
        push_string(file_name, &mut string_bytes, &mut offsets); // index 0..1 -> fileName
        push_string(path, &mut string_bytes, &mut offsets); // index 2..3 -> path

        let offset_string_table_offsets = HEADER_SIZE as u32;
        let offset_string_table = offset_string_table_offsets + (offsets.len() as u32) * 4;
        let offset_extended_data = offset_string_table + string_bytes.len() as u32;
        // Extended data record: [reserved, fileNameIndex, pathIndex, ...]
        let extended_data: [u32; 3] = [0, 0, 2];
        let offset_structured_data = offset_extended_data + (extended_data.len() as u32) * 4;
        let offset_nodes = offset_structured_data; // no structured data

        let mut buf = vec![0u8; offset_nodes as usize];
        let metadata = (PROTOCOL_VERSION as u32) << 24;
        buf[0..4].copy_from_slice(&metadata.to_le_bytes());
        buf[HEADER_OFFSET_STRING_TABLE_OFFSETS..HEADER_OFFSET_STRING_TABLE_OFFSETS + 4]
            .copy_from_slice(&offset_string_table_offsets.to_le_bytes());
        buf[HEADER_OFFSET_STRING_TABLE..HEADER_OFFSET_STRING_TABLE + 4]
            .copy_from_slice(&offset_string_table.to_le_bytes());
        buf[HEADER_OFFSET_EXTENDED_DATA..HEADER_OFFSET_EXTENDED_DATA + 4]
            .copy_from_slice(&offset_extended_data.to_le_bytes());
        buf[HEADER_OFFSET_NODES..HEADER_OFFSET_NODES + 4]
            .copy_from_slice(&offset_nodes.to_le_bytes());

        let mut pos = offset_string_table_offsets as usize;
        for value in &offsets {
            buf[pos..pos + 4].copy_from_slice(&value.to_le_bytes());
            pos += 4;
        }
        buf[offset_string_table as usize..offset_string_table as usize + string_bytes.len()]
            .copy_from_slice(&string_bytes);
        let mut pos = offset_extended_data as usize;
        for value in &extended_data {
            buf[pos..pos + 4].copy_from_slice(&value.to_le_bytes());
            pos += 4;
        }

        // Node index 0: nil sentinel (all zero, already zeroed).
        // Node index 1: SourceFile, no children, data = EXTENDED | 0 (record at offset 0).
        let sf_offset = offset_nodes as usize + NODE_LEN; // index 1
        buf.extend(std::iter::repeat_n(0u8, NODE_LEN * 2)); // indices 1 (sf) ... but we only fill index 1 below
        buf[sf_offset + NODE_OFFSET_KIND..sf_offset + NODE_OFFSET_KIND + 4]
            .copy_from_slice(&syntax_kind::SOURCE_FILE.to_le_bytes());
        buf[sf_offset + NODE_OFFSET_POS..sf_offset + NODE_OFFSET_POS + 4]
            .copy_from_slice(&0i32.to_le_bytes());
        buf[sf_offset + NODE_OFFSET_END..sf_offset + NODE_OFFSET_END + 4]
            .copy_from_slice(&0i32.to_le_bytes());
        let data_field = NODE_DATA_TYPE_EXTENDED; // extended data record offset 0
        buf[sf_offset + NODE_OFFSET_DATA..sf_offset + NODE_OFFSET_DATA + 4]
            .copy_from_slice(&data_field.to_le_bytes());
        buf
    }

    #[test]
    fn decodes_header_and_extended_strings() {
        let payload = build_minimal_payload("/root/a.ts", "/root/a.ts");
        let file = RemoteSourceFile::decode(payload, PROTOCOL_VERSION).unwrap();
        assert_eq!(file.protocol_version, PROTOCOL_VERSION);
        assert_eq!(file.file_name, "/root/a.ts");
        assert_eq!(file.path, "/root/a.ts");
        assert_eq!(file.kind(1), syntax_kind::SOURCE_FILE);
        assert!(!file.has_children(1));
    }

    #[test]
    fn rejects_unexpected_protocol_version() {
        let payload = build_minimal_payload("/a.ts", "/a.ts");
        let err = RemoteSourceFile::decode(payload, PROTOCOL_VERSION + 1).unwrap_err();
        assert!(matches!(
            err,
            DecodeError::UnsupportedProtocolVersion { .. }
        ));
    }

    #[test]
    fn rejects_too_short_payload() {
        let err = RemoteSourceFile::decode(vec![0u8; 4], PROTOCOL_VERSION).unwrap_err();
        assert!(matches!(err, DecodeError::TooShort { .. }));
    }

    #[test]
    fn node_handle_round_trips_through_wire_format() {
        let handle = NodeHandle::new(12, 214, "/root/a.ts");
        let wire = handle.to_wire();
        assert_eq!(wire, "12.214./root/a.ts");
        assert_eq!(NodeHandle::parse(&wire).unwrap(), handle);
    }

    #[test]
    fn identifier_text_at_reads_plain_identifiers() {
        let text = to_utf16_test("  map(x) {}");
        assert_eq!(identifier_text_at(&text, 2), Some("map".to_string()));
    }

    #[test]
    fn identifier_text_at_reinstates_leading_hash() {
        let text = to_utf16_test("class C { #field = 1; }");
        let start = "class C { ".len() as i32;
        assert_eq!(identifier_text_at(&text, start), Some("#field".to_string()));
    }

    #[test]
    fn identifier_text_at_rejects_out_of_range_or_non_identifier() {
        let text = to_utf16_test("foo");
        assert_eq!(identifier_text_at(&text, 100), None);
        assert_eq!(identifier_text_at(&text, -1), None);
        let punct = to_utf16_test(".foo");
        assert_eq!(identifier_text_at(&punct, 0), None);
    }

    fn to_utf16_test(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn node_handle_path_may_contain_dots() {
        let handle = NodeHandle::new(1, 79, "/root/pkg.name/a.ts");
        let wire = handle.to_wire();
        assert_eq!(NodeHandle::parse(&wire).unwrap(), handle);
    }
}
