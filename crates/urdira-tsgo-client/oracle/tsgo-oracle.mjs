// Oracle for `tests/oracle_resolve.rs`: resolves the same hand-picked sites
// against the REAL Node reference client (`typescript/unstable/async`,
// `typescript@7.0.2`'s own JS wrapper around the same tsgo binary and wire
// protocol `urdira-tsgo-client` talks to directly) that this crate's
// `ResidualResolver` was built to replace. The Rust test compares its own
// resolutions against this script's output; a mismatch means the Rust
// client's decoding/resolution logic disagrees with the real checker, not
// just with this crate's own understanding of it.
//
// `identifier_ref`/`heritage` sites resolve via `checker.getSymbolAtPosition`
// at a single anchor position — a position-based lookup, deliberately NOT
// exercising this crate's own `descend_to_span`. `call` sites instead
// descend the real `Node` tree from the call's full span (this script's own
// `descendToSpan`, structurally the same algorithm as
// `RemoteSourceFile::descend_to_span`/`analyzer.ts`'s
// `descendToPendingSiteSpan`) and run the SAME two-tier resolution
// `ResidualResolver::resolve_call` does (direct-declaration shortcut, then
// `getResolvedSignature`, then a symbol-based fallback) — using
// `getSymbolAtPosition` for a call site would only ever reach the callee's
// OWN symbol (e.g. a class for `new Foo()`), never the specific overload
// `getResolvedSignature` picks (e.g. a particular constructor), so the two
// algorithms are not interchangeable for that site kind and the oracle must
// match the implementation's, not take a shortcut of its own.
//
// Usage: node tsgo-oracle.mjs <sourceDir> <sitesJsonPath>
// `sourceDir` is scanned directly for `.ts` files (recursively); site file
// paths in the sites JSON are relative to it. Each site has `file`, `kind`
// (`identifier_ref` | `call` | `heritage`), `searchText` (defines the
// site's span: just an anchor point for `identifier_ref`/`heritage`, the
// whole call expression's text for `call`), optional `symbolAnchor` (a
// narrower substring, searched for starting at `searchText`'s position, for
// the exact identifier `getSymbolAtPosition` should click — only meaningful
// for `identifier_ref`/`heritage`), and optional `occurrence` (1-based,
// default 1, for disambiguating a `searchText` that occurs more than once).
// Prints one JSON array (one entry per input site) to stdout.

import fs from "node:fs";
import path from "node:path";
import { API, SymbolFlags } from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";

const [, , sourceDir, sitesJsonPath] = process.argv;
if (!sourceDir || !sitesJsonPath) {
  console.error("usage: node tsgo-oracle.mjs <sourceDir> <sitesJsonPath>");
  process.exit(2);
}

const sites = JSON.parse(fs.readFileSync(sitesJsonPath, "utf8"));

function collectTsFiles(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, base, out);
    } else if (entry.name.endsWith(".ts")) {
      const rel = path.relative(base, full).split(path.sep).join("/");
      out[`/workspace/${rel}`] = fs.readFileSync(full, "utf8");
    }
  }
}

// Site file paths (both here and in the Rust test) are relative to
// `sourceDir`, mapped under the virtual root at the same relative path
// (e.g. `sourceDir/services/task-service.ts` ->
// `/workspace/services/task-service.ts`).
const files = {};
collectTsFiles(sourceDir, sourceDir, files);
files["/workspace/package.json"] = JSON.stringify({ type: "module" });

const rootNames = Object.keys(files).filter((f) => f.endsWith(".ts"));
const configPath = "/workspace/__oracle_project__.json";
files[configPath] = JSON.stringify({
  compilerOptions: {
    module: "NodeNext",
    moduleResolution: "NodeNext",
    target: "ES2022",
    strict: false,
  },
  files: rootNames,
});

function utf16IndexOfOccurrence(text, needle, occurrence) {
  let idx = -1;
  for (let i = 0; i < occurrence; i++) {
    idx = text.indexOf(needle, idx + 1);
    if (idx === -1) return -1;
  }
  return idx;
}

function constructorKeywordStart(text, from) {
  const re = /\bconstructor\b/g;
  re.lastIndex = from;
  const match = re.exec(text);
  return match ? match.index : from;
}

const IDENTIFIER_KIND = 79;
const CONSTRUCTOR_KIND = 177;

/** First immediate child of `node`, or `undefined` if it has none — using
 * `forEachChild`'s own early-return protocol (a truthy callback result
 * stops iteration and becomes the call's return value). */
function firstChild(node) {
  return node.forEachChild((child) => child);
}

/** Same algorithm as `RemoteSourceFile::descend_to_span`
 * (`crates/urdira-tsgo-client/src/node.rs`) and `analyzer.ts`'s
 * `descendToPendingSiteSpan`, without the cursor-reuse optimization (this
 * script resolves too few sites per run for it to matter): from `node`,
 * repeatedly step into the first immediate child whose span contains
 * `[start, end)`, stopping when none does. */
function descendToSpan(node, start, end) {
  for (;;) {
    let next;
    node.forEachChild((child) => {
      if (next !== undefined) return undefined;
      if (child.getStart() <= start && end <= child.getEnd()) {
        next = child;
      }
      return undefined;
    });
    if (next === undefined) return node;
    node = next;
  }
}

/** Mirrors `ResidualResolver::resolve_call`
 * (`crates/urdira-tsgo-client/src/resolver.rs`): the direct
 * single-non-alias-declaration shortcut first, then `getResolvedSignature`,
 * then the callee's own resolved declaration (alias hop included) as a last
 * resort. Returns a resolved declaration `Node`, or `undefined`. */
async function resolveCallNode(callNode, project) {
  const callee = firstChild(callNode);
  let calleeSymbol;
  if (callee?.kind === IDENTIFIER_KIND) {
    calleeSymbol = await checker.getSymbolAtLocation(callee);
    if (calleeSymbol && (calleeSymbol.flags & SymbolFlags.Alias) === 0 && calleeSymbol.declarations.length === 1) {
      const handle = calleeSymbol.valueDeclaration ?? calleeSymbol.declarations[0];
      return handle.resolve(project);
    }
  }
  const signature = await checker.getResolvedSignature(callNode);
  if (signature?.declaration) {
    return signature.declaration.resolve(project);
  }
  if (callee) {
    calleeSymbol ??= await checker.getSymbolAtLocation(callee);
    return resolveSymbolToDeclarationNode(calleeSymbol, project);
  }
  return undefined;
}

async function resolveSymbolToDeclarationNode(symbol, project) {
  if (!symbol) return undefined;
  if ((symbol.flags & SymbolFlags.Alias) !== 0) {
    try {
      const aliased = await checker.getAliasedSymbol(symbol);
      if (!(await checker.isUnknownSymbol(aliased))) symbol = aliased;
    } catch {
      // The direct symbol remains authoritative, matching analyzer.ts.
    }
  }
  const handle = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return handle ? handle.resolve(project) : undefined;
}

const vfs = createVirtualFileSystem(files);
const api = new API({ fs: vfs });
const snapshot = await api.updateSnapshot({ openProjects: [configPath] });
const project = snapshot.getProjects().find((candidate) => candidate.configFileName === configPath);
if (!project) {
  console.error("oracle: tsgo did not create a project for the synthetic config");
  process.exit(1);
}
const checker = project.checker;
const program = project.program;

const results = [];
for (const site of sites) {
  const filePath = `/workspace/${site.file}`;
  const text = files[filePath];
  if (text === undefined) {
    results.push({ error: `unknown fixture file: ${site.file}` });
    continue;
  }
  const spanStart = utf16IndexOfOccurrence(text, site.searchText, site.occurrence ?? 1);
  if (spanStart === -1) {
    results.push({ error: `search text not found: ${JSON.stringify(site.searchText)} in ${site.file}` });
    continue;
  }

  let declNode;
  try {
    if (site.kind === "call") {
      // `.length` is UTF-16 code units, matching the fixtures (plain
      // ASCII) exactly; a non-ASCII fixture would need surrogate-pair-aware
      // counting instead.
      const end = spanStart + site.searchText.length;
      const sourceFile = await program.getSourceFile(filePath);
      const callNode = descendToSpan(sourceFile, spanStart, end);
      declNode = await resolveCallNode(callNode, project);
    } else {
      // identifier_ref / heritage: a single anchor position, resolved via
      // getSymbolAtPosition (see the module doc for why this differs from
      // the `call` branch).
      const anchorText = site.symbolAnchor ?? site.searchText;
      const pos = text.indexOf(anchorText, spanStart);
      if (pos === -1) {
        results.push({ error: `symbol anchor not found: ${JSON.stringify(anchorText)} in ${site.file}` });
        continue;
      }
      const symbol = await checker.getSymbolAtPosition(filePath, pos);
      if (!symbol) {
        results.push({ error: "no symbol at position" });
        continue;
      }
      declNode = await resolveSymbolToDeclarationNode(symbol, project);
    }
  } catch (error) {
    results.push({ error: `resolution threw: ${error?.stack ?? error}` });
    continue;
  }

  if (!declNode) {
    results.push({ error: "no declaration resolved" });
    continue;
  }
  const declFile = declNode.getSourceFile();
  const declStart = declNode.getStart(declFile);
  const declEnd = declNode.getEnd();
  let nameStart;
  if (declNode.kind === CONSTRUCTOR_KIND) {
    nameStart = constructorKeywordStart(declFile.text, declStart);
  } else if (declNode.name) {
    nameStart = declNode.name.getStart(declFile);
  } else {
    nameStart = declStart;
  }
  results.push({
    path: declFile.path,
    nameIdentifierStart: nameStart,
    declStart,
    declEnd,
    declKind: declNode.kind,
  });
}

await api.close();
process.stdout.write(JSON.stringify(results));
