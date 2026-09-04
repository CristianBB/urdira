# P1-D-a: `urdira-tsgo-client` — Rust client for the tsgo async API

Scope: a Rust JSON-RPC client for the TypeScript 7 ("tsgo", the Go port of
the TypeScript checker) `--api --async` mode, so a future background
residual-resolution pass in the indexing worker can talk to the checker
directly from Rust without spawning the Node semantic worker
(`packages/plugin-javascript-typescript`). New crate only:
`crates/urdira-tsgo-client/` (added to the root `Cargo.toml` `members`,
alongside several other crates other agents added in the same session —
left untouched). Nothing outside the new crate was modified except that one
`Cargo.toml` line and this doc. Not wired into the daemon/worker yet — that
is a later task.

## 1. Files

New:
- `crates/urdira-tsgo-client/Cargo.toml`
- `crates/urdira-tsgo-client/src/lib.rs` — module list, re-exports, crate-level docs (scope, versioning risk).
- `crates/urdira-tsgo-client/src/binary.rs` — `TsgoBinary::discover`, `TsgoVersion`, `URDIRA_TSGO_BINARY` override.
- `crates/urdira-tsgo-client/src/rpc.rs` — `Content-Length`-framed JSON-RPC 2.0 codec (`read_message`/`write_request`/`write_response`/`write_error_response`).
- `crates/urdira-tsgo-client/src/virtual_fs.rs` — `VirtualFs` trait + `MapFs` (in-memory impl for tests/bench).
- `crates/urdira-tsgo-client/src/proto.rs` — typed request/response shapes for the subset of the API this crate uses.
- `crates/urdira-tsgo-client/src/client.rs` — `TsgoClient` (spawn, reader thread, callback dispatch, typed methods, shutdown).
- `crates/urdira-tsgo-client/src/node.rs` — `RemoteSourceFile` (binary AST decoder), `NodeHandle`, `SourceFileCache`.
- `crates/urdira-tsgo-client/src/trivia.rs` — `skip_trivia`, `to_utf16`.
- `crates/urdira-tsgo-client/src/resolver.rs` — `ResidualResolver`, `PendingSite`, `Resolution`.
- `crates/urdira-tsgo-client/oracle/tsgo-oracle.mjs` — Node oracle (`typescript/unstable/async`) used by the integration test.
- `crates/urdira-tsgo-client/tests/oracle_resolve.rs` — cross-language oracle test (real binary + real Node client).
- `crates/urdira-tsgo-client/tests/bench_tsgo.rs` — `#[ignore]`d perf smoke test against the n8n corpus.
- `crates/urdira-tsgo-client/tests/fixtures/mini/{base,derived,main}.ts` — a tiny crate-local fixture (alias import + explicit constructor + local `extends`), added because the shared `task-planner` fixture has no case exercising those without pulling in `lib.d.ts` (see §6).

Modified:
- `Cargo.toml` (root) — added `"crates/urdira-tsgo-client"` to `members`.
- `Cargo.lock` — new dep resolved: `base64 0.22.1`.

The shared fixture `tests/fixtures/codebases/typescript/task-planner/src`
was read but never modified (it is depended on, with exact-value
assertions, by many other tests — see `tests/oracle_resolve.rs`'s module
doc).

## 2. Protocol as implemented

`tsgo --api --async --cwd <root> --callbacks=readFile,fileExists,directoryExists,getAccessibleEntries,realpath`
speaks JSON-RPC 2.0 over stdio with LSP-style `Content-Length:\r\n\r\n`
framing (the same framing `vscode-jsonrpc`'s stream reader/writer use,
which the real Node client is built on
— `dist/api/async/client.js`). `crates/urdira-tsgo-client/src/rpc.rs` is a
from-scratch ~80-line implementation of just that framing (no `vscode-jsonrpc`
dependency): headers until a blank line, `Content-Length` picked out
case-insensitively, exact-length body read, `serde_json` for the body
itself.

Requests we send have an integer id (`AtomicU64` starting at 1); responses
carry that id back with `result` or `error`. Server-to-client requests (the
FS callbacks) carry their OWN id space — captured live below, tsgo uses
**string** ids like `"api1"`, `"api2"` for these, not integers. This crate
never assumes an id shape for callback requests: `RawMessage::id` is a raw
`serde_json::Value` echoed back verbatim in the response, so the two id
spaces (ours: integers; tsgo's own: `"apiN"` strings) never need to be
compared or unified.

### Captured request/response sample

Captured by hand-driving the real binary (no Rust/Node client involved —
raw framing + `json` module) with a two-file virtual project
(`/workspace/a.ts` + a synthetic project config), to see the exact wire
shapes independent of either client's own assumptions:

```
>>> initialize
Content-Length: 67
{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": null}

<<< response
{"jsonrpc":"2.0","id":1,"result":{"useCaseSensitiveFileNames":false,"currentDirectory":"/workspace"}}

>>> updateSnapshot
Content-Length: 116
{"jsonrpc": "2.0", "id": 2, "method": "updateSnapshot", "params": {"openProjects": ["/workspace/__project__.json"]}}

<<< callback (note the STRING id)
{"jsonrpc":"2.0","id":"api1","method":"readFile","params":"/workspace/__project__.json"}
>>> our response
{"jsonrpc": "2.0", "id": "api1", "result": {"content": "{\"compilerOptions\": {}, \"files\": [\"/workspace/a.ts\"]}"}}

<<< callback
{"jsonrpc":"2.0","id":"api2","method":"fileExists","params":"/workspace/a.ts"}
>>> {"jsonrpc": "2.0", "id": "api2", "result": true}

<<< callback (see §6 — this is the default lib file, an ABSOLUTE REAL PATH)
{"jsonrpc":"2.0","id":"api3","method":"realpath","params":"/Users/.../lib.es2025.full.d.ts"}
>>> {"jsonrpc": "2.0", "id": "api3", "result": "/Users/.../lib.es2025.full.d.ts"}  (our realpath is the identity fn)

<<< callback
{"jsonrpc":"2.0","id":"api4","method":"directoryExists","params":"/workspace"}
>>> {"jsonrpc": "2.0", "id": "api4", "result": true}

<<< callback
{"jsonrpc":"2.0","id":"api5","method":"readFile","params":"/Users/.../lib.es2025.full.d.ts"}
>>> {"jsonrpc": "2.0", "id": "api5", "result": {"content": null}}   <- not in our virtual FS, so: not found

<<< callback (module-format detection walking up the tree)
{"jsonrpc":"2.0","id":"api6","method":"fileExists","params":"/workspace/package.json"}
>>> {"jsonrpc": "2.0", "id": "api6", "result": false}
{"jsonrpc":"2.0","id":"api7","method":"directoryExists","params":"/"}
>>> {"jsonrpc": "2.0", "id": "api7", "result": true}
{"jsonrpc":"2.0","id":"api8","method":"fileExists","params":"/package.json"}
>>> {"jsonrpc": "2.0", "id": "api8", "result": false}

<<< callback
{"jsonrpc":"2.0","id":"api9","method":"readFile","params":"/workspace/a.ts"}
>>> {"jsonrpc": "2.0", "id": "api9", "result": {"content": "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n"}}

<<< final response to id=2
{"jsonrpc":"2.0","id":2,"result":{"snapshot":1,"projects":[{"id":"/workspace/__project__.json","configFileName":"/workspace/__project__.json","rootFiles":["/workspace/a.ts"],"compilerOptions":{"configFilePath":"/workspace/__project__.json"}}]}}
```

Method names/params for every request this crate sends
(`getSourceFile`, `getSymbolsAtLocations`, `getSymbolAtLocation`,
`getSymbolsAtPositions`, `getAliasedSymbol`, `getResolvedSignature`,
`getTypeAtLocations`, `typeToString`, `release`) were transcribed from the
`apiRequest("methodName", {...})` call sites in
`node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/dist/api/async/api.js`
— there is no published schema for any of this; see §7.

Binary (`getSourceFile`, `typeToTypeNode`, `signatureToSignatureDeclaration`)
responses arrive as `{"data": "<base64>"}`; `client.rs`'s
`get_source_file` decodes the base64 (hand-rolled via the `base64` crate,
the one new dependency this crate adds) and hands the bytes to
`node::RemoteSourceFile::decode`.

## 3. Decoder layout

Transcribed from `dist/api/node/protocol.js` (offsets/constants) and how
`dist/api/node/node.js`/`node.generated.js`/`node.infrastructure.js` use
them:

- Header (44 bytes): byte 0 = `metadata` u32, whose top byte is
  `PROTOCOL_VERSION` (`5` for `typescript@7.0.2`) — the ONLY version marker
  anywhere in this wire format (see §7). `node::RemoteSourceFile::decode`
  asserts it against the caller's expected value and returns a typed
  `DecodeError::UnsupportedProtocolVersion` on mismatch, something the real
  JS client does **not** do (it never checks this field at all).
  Bytes 24/28/32/40 are the string-table-offsets/string-table/extended-data/
  node-table section offsets (u32 each); bytes 4-19 (content hash) and 20-23
  (parse options key) are not used by this crate.
- Node table: `NODE_LEN = 28` bytes per entry — `kind`(u32)@0, `pos`(i32)@4,
  `end`(i32)@8, `next`(u32)@12, `parent`(u32)@16, `data`(u32)@20,
  `flags`(u32)@24, all little-endian. Node index 0 is a nil sentinel, index
  1 is always the `SourceFile`. `KIND_NODE_LIST = 0xFFFFFFFF` marks a
  synthetic list container (its own `data` field holds the list length,
  not encoded via `NODE_DATA_TYPE_*`).
- **Children without `childProperties`**: rather than port the generated
  per-`SyntaxKind` child-property table (`protocol.generated.js`), this
  decoder reuses the SAME trick the real client's own `RemoteNode.hasChildren()`/
  `forEachChild()` use: a node has children iff the very next table slot's
  `parent` field points back at it (`has_children`), and children are found
  by following the `next`-pointer sibling chain starting at `index + 1`
  (`children`), transparently flattening `NodeList` containers and skipping
  `JSDoc` nodes — exactly what `node.forEachChild(visitNode)` (single-arg
  form, no `visitList`) does. This is the one design choice that made the
  decoder tractable without generating ~2000 lines of per-kind metadata: it
  gives correct, generic child enumeration for `descend_to_span`'s
  containment descent.
- Extended data: only `fileName`/`path` (u32 string-table indices at
  extended-data-record offset `+4`/`+8`) are read, for building `NodeHandle`s
  (`"{index}.{kind}.{path}"`, `dist/api/node/node.js`'s `getNodeId`/
  `parseNodeHandle`) and looking up the right cached `RemoteSourceFile`.
  Everything else in the extended-data/structured-data sections
  (`referencedFiles`, `imports`, msgpack-encoded reference lists, ...) is
  unimplemented — out of scope for a resolver that only needs declaration
  spans and names.
- String decoding (`get_string`) is plain lossy UTF-8, not the real client's
  WTF-8 decoder (which reconstructs lone UTF-16 surrogates from a 3-byte
  `ED [A0-BF] [80-BF]` sequence). This is safe ONLY because this crate never
  decodes arbitrary source text out of the binary payload — every
  position-based operation (`node_start`, `descend_to_span`) uses the
  CALLER's own UTF-16 buffer for the file (the exact same text already
  handed to tsgo via `VirtualFs::read_file`), and `get_string` is only ever
  called for the two short, path-shaped strings above.

Unit-tested in `node.rs` against a hand-built minimal payload (header +
2-node table + a fileName/path string pair) matching the real encoder's
byte layout exactly (`build_minimal_payload`); end-to-end decoding of a
payload actually produced by the real binary is exercised by
`tests/oracle_resolve.rs` (every `Resolved` declaration in that test came
from decoding a real `getSourceFile` response).

## 4. Trivia skipper

`trivia::skip_trivia` is a conservative Rust port of
`skipTrivia` (`dist/ast/scanner.js:358`), used by `node_start`
(`getTokenPosOfNode`'s non-JSDoc branch, `dist/ast/astnav.js:253`) to turn a
node's `pos` (includes leading trivia) into its real token start. Handles:
ASCII whitespace, `//`/`/* */` comments, a `pos == 0` shebang, and JSDoc
mode's post-newline `*` consumption. Documented, deliberate gaps (see the
module doc): conflict-marker trivia (`<<<<<<<` etc.) and the full Unicode
`Zs` whitespace category are not recognized — neither occurs in any fixture
here. 12 unit tests cover each branch plus edge cases (unterminated block
comment to EOF, shebang only at position 0, empty text).

## 5. Resolver semantics vs `analyzer.ts`

`ResidualResolver::resolve` groups `PendingSite`s by `owner_path`, and per
owner group: descends each site's `[start, end)` span to its innermost
containing node (`descend_to_span`, port of `analyzer.ts`'s
`descendToPendingSiteSpan`, `packages/plugin-javascript-typescript/src/analyzer.ts:1494-1510`),
collects one "lookup node" per site, and issues ONE batched
`getSymbolsAtLocations` for the whole group (mirrors
`checker.getSymbolAtLocation(identifierNodes)`,
`analyzer.ts:1721`) before doing any per-site resolution.

Per site kind:
- **`IdentifierRef`**: the descended node itself is the lookup node.
  Resolution is `analyzer.ts`'s `resolvedDeclaration`
  (`analyzer.ts:~1801-1823`): alias hop via `getAliasedSymbol` when
  `symbol.flags & SymbolFlags.Alias` (`0x200000`, checked against a
  transcribed constant in `proto::symbol_flags`), then
  `valueDeclaration ?? declarations[0]`.
- **`Call`**: `resolve_call` mirrors `analyzer.ts:~1900-1930` (`directCallDeclaration`
  shortcut, then `getResolvedSignature(node).declaration`, then a fallback
  to the callee's own resolved declaration). One deliberate deviation:
  `analyzer.ts` reuses a callee symbol already fetched incidentally by its
  full-file identifier walk; this crate has no such walk to piggyback on
  per site, so it fetches the callee's symbol itself via the SAME batched
  `getSymbolsAtLocations` call as every other site in the owner group — a
  walk-order optimization `analyzer.ts` had available and this API shape
  does not, not a semantic difference (§6 confirms the two converge to the
  same answer for every oracle-tested site).
- **`Heritage`**: the pending site's span already bounds one listed type's
  own expression (an `ExpressionWithTypeArguments`'s `expression`, matching
  oxc's per-type span, not the whole `implements A, B` clause) —
  `heritage_expression` normalizes `descend_to_span`'s result to that
  expression node (unwrapping `ExpressionWithTypeArguments` if the site's
  span was the whole `Foo<T>` rather than just `Foo`), then resolves it the
  same way as `IdentifierRef`. `analyzer.ts`'s `nearestHeritageClause`
  (`analyzer.ts:~1521-1525`) is deliberately NOT ported: it exists there
  only to find the RELATION SOURCE entity (`entityForDeclaration(node.parent)`)
  for building a full relation graph, which is out of scope here (this
  crate resolves TARGETS only, no diagnostics, no entity/relation graph).

Identity anchor (`name_identifier_start`) mirrors `analyzer.ts:1787-1793`:
the name node's own start, or (for a `Constructor`, which has no name node)
`constructorKeywordStart`'s target — the `constructor` keyword's position,
found here by a plain word-scan for the literal token `"constructor"`
rather than a real scanner (`node::RemoteSourceFile::constructor_keyword_start`;
this crate has no scanner at all, only the trivia skipper). One heuristic
NOT in `analyzer.ts`: `name_start` finds the name node by looking for the
first immediate `Identifier`/`PrivateIdentifier` child (`children()`,
single level) rather than a `.name` property lookup, because the decoder
does not port `childProperties`. This agrees with `.name` for every
plain-named declaration (class/interface/function/method/property/enum/
simple-identifier variable) and was verified exactly against the oracle for
5 of the 9 tested sites (the other 4 are `Call`/`Heritage`, whose targets in
this test happen to also be plain-named declarations, so all 9 exercised
it). Known, documented divergence: a `ComputedPropertyName` key or a
destructuring binding has no immediate `Identifier` child, so `name_start`
returns `None` and the caller falls back to the declaration's own start —
matching `analyzer.ts`'s `nameNode === undefined` branch, but NOT what a
real `.name` lookup on those shapes would find. No fixture here exercises
that path; it is a known gap, not a verified-safe approximation.

## 6. Oracle test results

`tests/oracle_resolve.rs` runs 9 sites total across two fixtures, comparing
this crate's `ResidualResolver` against `oracle/tsgo-oracle.mjs` (the real
`typescript@7.0.2` `typescript/unstable/async` client, run against the same
real tsgo binary, resolving the same sites via an independently-written
algorithm — see that script's module doc for exactly how each site kind is
resolved there). **All 9 match exactly** (path, name-identifier start, decl
start, decl end) — `cargo test -p urdira-tsgo-client --test oracle_resolve`,
2 tests, both passing, run live against the real binary at
`node_modules/.pnpm/@typescript+typescript-darwin-arm64@7.0.2/.../lib/tsc`.

`tests/fixtures/codebases/typescript/task-planner/src` (read-only, shared
fixture), 6 sites:
1. `identifier_ref` — `TaskRepository` type annotation in
   `task-service.ts`'s constructor param → `InterfaceDeclaration` in
   `task-repository.ts`.
2-4. `call` — `this.repository.{findById,save,create}(...)`, each a
   `PropertyAccessExpression` callee (so `directCallDeclaration` does not
   apply — `!isIdentifier(expression)`) → each resolves via
   `getResolvedSignature` to the matching `MethodSignature` in the
   INTERFACE (`task-repository.ts`), not the concrete
   `InMemoryTaskRepository` class — structural/interface-typed dispatch,
   crossing files.
5. `heritage` — `implements TaskRepository` in
   `in-memory-task-repository.ts` → the same `InterfaceDeclaration` as
   site 1 (confirmed identical span in both).
6. `call` — `new TaskService(repository)` in `main.ts`. **Discrepancy from
   my own initial assumption**: I expected the `directCallDeclaration`
   shortcut to fire here (a plain, non-alias, single-declaration class
   identifier) and resolve to the `ClassDeclaration`. It did not — both
   this crate and the independently-written oracle algorithm fell through
   to `getResolvedSignature`, landing on the `Constructor` declaration
   instead (kind 177, not 264). I could not fully pin down from the wire
   traffic alone why the shortcut's precondition failed for a
   `NewExpression` callee specifically (a plausible explanation:
   `getSymbolAtLocation` on a `new`-expression's callee identifier may
   report `declarations` differently than a plain reference would — this
   is exactly the kind of async-API-vs-assumption gap the task asked to be
   documented rather than papered over). What matters for correctness:
   BOTH programs, running the identical two-tier algorithm against the
   identical checker, agree on the final answer, so `resolve_call`'s
   behavior is validated regardless of which branch actually fired.

`crates/urdira-tsgo-client/tests/fixtures/mini` (new, crate-local, 3 files),
3 sites — added specifically to cover paths the shared fixture cannot
without pulling in `lib.d.ts` (§3's `readFile` trace shows the default lib
file is served from an ABSOLUTE REAL PATH the virtual FS does not have, so
`extends Error` would resolve nothing — see the risk noted below):
1. `heritage` — `extends Base` (a local, lib-free base class) →
   `ClassDeclaration`.
2. `call` — `new AliasedBase("hello")` where `AliasedBase` is an
   `import { Base as AliasedBase }` — the `Alias` flag correctly routes
   past the direct shortcut into `getResolvedSignature`, landing on
   `Base`'s explicit `Constructor` (kind 177) → exercises
   `constructor_keyword_start` for real (name-identifier start = the
   `constructor` keyword's own position, not the declaration's start).
3. `identifier_ref` — `AliasedBase.name` (a plain value reference to the
   aliased binding) → alias-hop in `resolve_via_symbol`/`get_aliased_symbol`
   → the same `Base` `ClassDeclaration` as site 1.

Not oracle-tested (documented gap, not a claim of correctness): a direct
call through a plain identifier whose declaration count is not exactly 1
falling through the shortcut for reasons OTHER than the `new`-expression
case above; `ComputedPropertyName`/destructuring name-start fallback (§5).

## 7. Bench

`cargo test -p urdira-tsgo-client --test bench_tsgo -- --ignored --nocapture`,
one real run against `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`,
a 512-`.ts`-file window (sorted-deterministic slice of the corpus,
`node_modules`/`.git`/`dist`/`build`/`coverage` skipped), read directly into
the virtual FS (no real-disk fallback), `compilerOptions`
`{module: ESNext, moduleResolution: Bundler, target: ES2022, skipLibCheck: true}`.
1,000 synthetic `a.b(` member-access call sites found by a plain
character scan (`find_member_call_sites` — no `regex` dependency; a span
ending right at the `(` rather than the true matching `)` still lands
`descend_to_span` on the enclosing `CallExpression`, since neither the
callee nor any argument's span contains it — see that function's doc
comment), resolved via ONE `ResidualResolver::resolve` call over the whole
window (the real production usage shape).

```
window: 512 files (target 512)
collected 1000 member-call sites across 512 files
spawn+initialize: 44.8 ms
updateSnapshot (512 files): 322.2 ms
resolve 1000 sites: 432.9 ms total, 0.433 ms/site mean, 130/1000 resolved
child RSS after updateSnapshot: 120848 KB (118.0 MB)
child RSS after resolve: 178848 KB (174.7 MB)
per-owner-batch per-site ms: p50=0.327 p95=1.482 (n=275 owner batches)
```

Only 130/1000 sites resolved — expected, not a bug: the n8n corpus imports
many external packages (`n8n-workflow`, third-party libs) whose type
declarations are not in this 512-file virtual-FS window at all, so a large
fraction of the synthetic `a.b(` scan's matches land on values whose type
is unresolved (`any`/error type). Toggling `noResolve` on/off changed
neither timing nor the resolved count in a repeat run, confirming the
bottleneck is genuinely "the target file isn't in the window", not module
resolution overhead.

Machine load during the run was moderate: debug build (no `--release`),
single run, no n8n indexing/daemon process active
(`pgrep -fl "urdira-indexing-worker|n8n-incremental-preflight"` returned
nothing beforehand).

## 8. Risks

- **Unversioned wire protocol beyond one byte** (§2, §3): every method
  name, request/response field name, and the binary header/node-table
  layout was reverse-engineered from `typescript@7.0.2`'s own JS reference
  client source, not a published schema — because none exists. The single
  `PROTOCOL_VERSION` byte this crate DOES check only covers the binary AST
  payload shape, not the JSON-RPC method surface at all. Pin:
  `typescript@7.0.2` / `@typescript/typescript-darwin-arm64@7.0.2` (this
  repo's exact installed version, confirmed live via
  `binary::discover`'s own test). A `typescript` package upgrade should
  re-run `tests/oracle_resolve.rs` before trusting this crate again; a
  wire-shape change that this crate's typed `proto.rs` structs can't parse
  will surface as a `serde_json` deserialization error (not silent
  corruption) since every response type is deserialized strictly.
- **Default lib files are not served** (§2, §6): confirmed live in the
  captured wire trace — tsgo asks for the default lib file
  (`lib.es2025.full.d.ts`) at its ABSOLUTE REAL FILESYSTEM PATH (not a
  `/workspace`-rooted virtual path), and this crate's virtual FS
  (authoritative, no real-disk fallback) answers "not found". Any
  resolution that needs a lib global (`Array`, `Promise`, `Error`,
  built-in string/array methods, ...) will silently fail to resolve rather
  than erroring — a `Call`/`Heritage`/`IdentifierRef` site landing on such
  a symbol becomes `Unresolved`, not wrong. A production integration
  wanting lib coverage would need to special-case those specific absolute
  paths in its `VirtualFs` (pass them through to the real filesystem, or
  pre-load their content once at startup) — deliberately not done here to
  keep this crate's FS model simple and fully virtual; documented as a
  known gap rather than worked around.
- **`name_start`'s child-scan heuristic** (§5): correct for every
  plain-named declaration shape tested; not verified for
  `ComputedPropertyName`/destructuring-pattern names, where it silently
  falls back to the declaration's own start rather than failing loudly.
- **Callee-symbol-fetch reuse gap** (§5): `resolve_call`'s per-site callee
  fetch (vs. `analyzer.ts`'s incidental walk-order reuse) means this
  crate's batching is per-OWNER-FILE, not per-FULL-WALK the way
  `analyzer.ts`'s is; correctness is unaffected (§6's oracle agreement),
  only the query-count constant differs slightly from the Node path this
  crate is meant to eventually replace.
- **RSS growth under load** (§7): child RSS roughly 1.5x'd (118 MB → 178 MB)
  resolving 1,000 sites over a 512-file window; not measured against a
  larger window or a longer-lived process (repeated `updateSnapshot`
  calls, the real incremental-edit shape) — a follow-up task, not this
  one's scope.
