import { createHash } from "node:crypto";
import { version as TYPESCRIPT_VERSION } from "typescript";
import { createVirtualFileSystem, type FileSystem } from "typescript/unstable/fs";
import { API, SymbolFlags } from "typescript/unstable/sync";
import {
  createScanner,
  isCallExpression,
  isClassDeclaration,
  isConstructorDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isGetAccessorDeclaration,
  isHeritageClause,
  isIdentifier,
  isInterfaceDeclaration,
  isImportDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isModuleDeclaration,
  isParameterDeclaration,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isExportDeclaration,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  SyntaxKind,
} from "typescript/unstable/ast";
import type { Node, SourceFile as TypescriptSourceFile } from "typescript/unstable/ast";
import type { Project as TypescriptProject, Snapshot as TypescriptSnapshot, Symbol as TypescriptSymbol } from "typescript/unstable/sync";
import type { PluginCapabilityDeclaration } from "@urdira/contracts";

export const JAVASCRIPT_TYPESCRIPT_PLUGIN_ID = "urdira:javascript_typescript" as const;
export const JAVASCRIPT_TYPESCRIPT_NAMESPACE = "jsts" as const;
// 0.1.0 -> 0.2.0: relative asset-specifier imports (fonts, stylesheets,
// images, JSON data -- see RELATIVE_ASSET_EXTENSIONS) no longer mark a file's
// dependency closure incomplete. The bump matters beyond bookkeeping: this
// version feeds the durable analysis cache key (worker.ts's
// durableAnalysisCacheKey), so entries computed under the old semantics miss
// instead of serving stale `complete: false` closures, and the plugin-upgrade
// relock machinery (decision 14) republishes existing workspaces once.
// MINOR (not patch) by 0.x semver convention: the analyzer's OUTPUT changed
// (closure completeness flips for previously-poisoned files), which is a
// behavior-breaking revision for anything consuming the analysis -- the
// system itself treats this string as an opaque identity token (ANY change
// invalidates), but the number should still say what kind of change it was.
// Bump procedure and the major/minor/patch decision table: docs/versioning.md.
// 0.2.0 -> 0.3.0: module-top-level calls and calls nested inside a
// const-arrow/function-expression initializer (whose entity is core:value,
// not core:callable, so `ownerAt` never found a callable owner for them)
// now emit a `core:call` relation attributed to the owning module entity
// instead of being silently dropped. MINOR: the analyzer's OUTPUT changed
// (more call edges now exist, changing `core:call_relationships` coverage
// and any query built on it) -- same bump class as 0.1.0 -> 0.2.0.
// 0.3.1 -> 0.3.2: dependency refresh for the Urdira 0.2.0 release; analyzer
// semantics remain unchanged, but the package identity must not reuse the
// published 0.3.1 tarball with stale core dependency pins.
// 0.3.2 -> 0.3.3: dependency refresh for the Urdira 0.2.1 release; analyzer
// semantics remain unchanged, but the package identity must not reuse the
// published 0.3.2 tarball with stale core dependency pins.
// 0.3.3 -> 0.3.4: dependency refresh for the Urdira 0.2.2 release; analyzer
// semantics remain unchanged, but the package identity must not reuse the
// published 0.3.3 tarball with stale core dependency pins.
// 0.3.4 -> 0.4.0: Urdira v3 changes the analyzer's observable publication
// contract, native batch transport, and core dependency identities. MINOR:
// pre-1.0 output or behavior changes use the minor slot by policy.
// 0.4.0 -> 0.5.0 (Frente E-P0j, 2026-09-07): v4's Rust structural producer
// (`crates/urdira-jsts-syntax-worker`) now publishes an entity's `start`/
// `end` as its WHOLE DECLARATION span (modifiers/decorators/`export`
// through the closing, a variable's own declarator, a parameter's own
// annotation+default) instead of just its identifier's span -- a real
// output/digest change for every v4 entity record (identity, keyed on the
// identifier's position, is unaffected). This constant is a shared identity
// token across both the v3 TS analyzer and the v4 Rust pipeline's own
// plugin-resolution-lock/durable-cache gating (see `docs/versioning.md`'s
// "What the plugin version mechanically gates"), so bumping it here is what
// forces the one-time fleet republish every already-scanned v4 workspace
// needs to pick up the new span shape. MINOR: pre-1.0 output change.
export const JAVASCRIPT_TYPESCRIPT_VERSION = "0.5.0" as const;
export const TYPESCRIPT_COMPILER_VERSION = TYPESCRIPT_VERSION;

/** Ordered structural publication stages for the bundled analyzer. */
export const JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES = Object.freeze([
  { stage_id: "jsts:structural_stage_1", ordinal: 1, stage_count: 3, depends_on_stage_ids: Object.freeze([] as string[]), capabilities: Object.freeze(["core:syntax_structure", "core:symbol_declarations", "core:module_dependencies"]) },
  { stage_id: "jsts:structural_stage_2", ordinal: 2, stage_count: 3, depends_on_stage_ids: Object.freeze(["jsts:structural_stage_1"]), capabilities: Object.freeze(["core:symbol_resolution", "core:call_relationships", "core:inheritance_and_implementation"]) },
  { stage_id: "jsts:structural_stage_3", ordinal: 3, stage_count: 3, depends_on_stage_ids: Object.freeze(["jsts:structural_stage_2"]), capabilities: Object.freeze(["core:type_information", "core:control_flow", "core:data_flow", "core:effects", "core:test_relationships", "core:semantic_preparation"]) },
] as const);
const capabilityStage = new Map(JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES.flatMap((stage) => stage.capabilities.map((capability) => [capability, stage.stage_id] as const)));

export const JAVASCRIPT_EXTENSIONS = Object.freeze([".js", ".jsx", ".mjs", ".cjs"] as const);
export const TYPESCRIPT_EXTENSIONS = Object.freeze([".ts", ".tsx", ".mts", ".cts", ".d.ts", ".d.mts", ".d.cts"] as const);
export const PROJECT_CONFIGURATION_FILES = Object.freeze(["tsconfig.json", "jsconfig.json"] as const);

// Relative import specifiers ending in one of these extensions name files
// this analyzer can never include in its corpus (languageForPath rejects
// them), so their content can never affect any analysis output: an
// unresolved import of one is an ordinary external dependency -- exactly
// like an unresolved bare package specifier -- not a dependency-closure gap.
// Deliberately an explicit allowlist: an unknown dotted suffix (e.g. a
// module literally named `./config.viewport`) stays conservative and still
// marks the closure incomplete when unresolved.
const RELATIVE_ASSET_EXTENSIONS = Object.freeze([
  ".json", ".css", ".scss", ".sass", ".less", ".styl",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".webm", ".ogg", ".wav",
  ".txt", ".md", ".html", ".wasm", ".pdf", ".glb", ".gltf",
] as const);

function relativeAssetSpecifier(specifier: string): boolean {
  const base = specifier.slice(specifier.lastIndexOf("/") + 1).toLowerCase();
  return RELATIVE_ASSET_EXTENSIONS.some((extension) => base.endsWith(extension));
}

/** The language-neutral capability surface advertised by the bundled analyzer. */
export const JAVASCRIPT_TYPESCRIPT_CAPABILITIES: readonly PluginCapabilityDeclaration[] = Object.freeze([
  "core:syntax_structure", "core:symbol_declarations", "core:symbol_resolution", "core:type_information",
  "core:module_dependencies", "core:call_relationships", "core:inheritance_and_implementation", "core:control_flow",
  "core:data_flow", "core:effects", "core:test_relationships", "core:semantic_preparation",
].map((capability): PluginCapabilityDeclaration => {
  const publicationStageId = capabilityStage.get(capability);
  return ({
  plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
  plugin_version: JAVASCRIPT_TYPESCRIPT_VERSION,
  capability,
  capability_contract_version: "1.0.0",
  precision: ["core:call_relationships", "core:inheritance_and_implementation", "core:type_information"].includes(capability)
    ? "typed"
    : ["core:module_dependencies", "core:symbol_resolution", "core:test_relationships"].includes(capability)
      ? "resolved"
      : ["core:control_flow", "core:data_flow"].includes(capability)
        ? "flow_sensitive"
        : capability === "core:effects" ? "modeled" : "syntactic",
  coverage: {
    language_ids: ["javascript", "typescript"],
    artifact_kinds: ["source"],
    project_context_required: true,
    excluded_construct_codes: ["jsts:dynamic_runtime_code", "jsts:unsupported_syntax"],
  },
  limitations: [{
    limitation_code: "jsts:dynamic_runtime_code",
    applicable_language_ids: ["javascript", "typescript"],
    applicable_artifact_kinds: ["source"],
    applicable_construct_codes: ["jsts:dynamic_runtime_code"],
    resulting_status: "partial",
    description: "Runtime-generated code and reflective dispatch remain possible or unresolved.",
  }],
      ...(publicationStageId === undefined ? {} : { publication_stage_id: publicationStageId }),
  });
}));

export type JsTsLanguage = "javascript" | "typescript";
export type JsTsScriptKind = "js" | "jsx" | "ts" | "tsx";

export interface AnalyzerFile {
  readonly path: string;
  readonly text: string;
  readonly artifact_id?: string;
  readonly artifact_version_id?: string;
  readonly content_hash?: string;
}

export interface DiscoveredProject {
  readonly project_path: string;
  readonly config_path?: string;
  readonly root_names: readonly string[];
  readonly referenced_projects: readonly string[];
  readonly configuration_dependencies: readonly string[];
  readonly workspace_manifests: readonly string[];
  readonly compiler_options: Readonly<Record<string, unknown>>;
  readonly inferred: boolean;
}

export interface JsTsEntity {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly universal_kind: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly parent_id?: string;
  readonly qualified_name?: string;
  readonly type?: string;
  readonly is_test?: boolean;
}

export interface JsTsRelation {
  readonly id: string;
  readonly kind: string;
  readonly source_id: string;
  readonly target_id?: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly classification: "confirmed" | "possible";
}

export interface JsTsDiagnostic {
  readonly code: string;
  readonly compiler_code?: number;
  readonly message: string;
  readonly path: string;
  readonly start?: number;
  readonly end?: number;
}

/**
 * One scanned file's import-closure: the set of scanned files (identified by
 * their `AnalyzerFile.path`, always including the file itself) it
 * transitively imports or re-exports, derived from the ts.Program's resolved
 * module graph. `complete` is `false` when this file, or any file inside its
 * transitive closure, has a relative (`.`-prefixed) import specifier that
 * did not resolve to any scanned file -- a caller that narrows an access
 * manifest to a closure MUST treat an incomplete closure as "unknown, could
 * be anything" and fall back to the full file set instead of trusting it.
 */
export interface JsTsDependencyClosure {
  readonly files: readonly string[];
  readonly complete: boolean;
}

/**
 * Compact stage-1 dependency shape for large workspaces.  Unlike
 * `JsTsDependencyClosure`, this never materializes a transitive path array per
 * owner.  The host derives reverse reachability only when an incremental scan
 * actually needs it and analyzes one owner plus its direct targets at a time.
 */
export interface JsTsDirectDependency {
  readonly direct_files: readonly string[];
  readonly complete: boolean;
}

export interface JsTsAnalysisResult {
  readonly language: JsTsLanguage;
  readonly entities: readonly JsTsEntity[];
  readonly relations: readonly JsTsRelation[];
  readonly diagnostics: readonly JsTsDiagnostic[];
  readonly complete: boolean;
  /** Keyed by `AnalyzerFile.path`; see {@link JsTsDependencyClosure}. */
  readonly dependency_closures: Readonly<Record<string, JsTsDependencyClosure>>;
}

/**
 * Exact incremental scope produced by the bound Rust syntax worker. When it
 * is present, TypeScript remains responsible for program construction,
 * resolution, checker-backed relations, types and diagnostics, but must not
 * rebuild the import graph or the inverse affected closure.
 */
export interface JsTsRustSemanticScope {
  readonly authority: "urdira:jsts-syntax-worker";
  readonly changed_paths: readonly string[];
  readonly affected_paths: readonly string[];
}

// Hoisted so `isLargeSyntaxCorpus` (here) and the worker's OWN early
// durable-cache-check (`worker.ts`, before it even decodes `files` into
// `AnalyzerFile[]`) can never drift apart -- they used to duplicate this pair
// of literals (P3-3b). A host-side pre-seed (see `resolveSyntaxDependencyGraph`
// below, and `apps/urdira/src/index.ts`) also gates on these directly.
export const LARGE_SYNTAX_CORPUS_FILE_THRESHOLD = 512;
export const LARGE_SYNTAX_CORPUS_BYTE_THRESHOLD = 16 * 1024 * 1024;

/**
 * Stage 1 must remain useful on repositories whose source set is too large
 * for a project-wide TypeScript program to be a reasonable readiness gate.
 * This bounded lexer deliberately emits only syntax/declaration/module facts;
 * resolution, types, calls, and diagnostics remain owned by later stages.
 * Keeping the large-corpus path independent from the checker also means its
 * memory is proportional to the current source text and result batch rather
 * than to TypeScript's complete semantic graph.
 */
export function isLargeSyntaxCorpus(input: { readonly files: readonly AnalyzerFile[]; readonly root_names?: readonly string[] }): boolean {
  const rootNames = new Set(input.root_names ?? input.files.map((file) => file.path).filter((path) => languageForPath(path) !== undefined));
  let sourceFileCount = 0;
  let totalBytes = 0;
  for (const file of input.files) {
    if (!rootNames.has(file.path) || languageForPath(file.path) === undefined) continue;
    sourceFileCount += 1;
    totalBytes += Buffer.byteLength(file.text, "utf8");
  }
  return sourceFileCount >= LARGE_SYNTAX_CORPUS_FILE_THRESHOLD || totalBytes >= LARGE_SYNTAX_CORPUS_BYTE_THRESHOLD;
}

function resolveLargeSyntaxModule(available: ReadonlySet<string>, from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const parts = from.split("/"); parts.pop();
  for (const part of specifier.split("/")) { if (part === "" || part === ".") continue; if (part === "..") parts.pop(); else parts.push(part); }
  const base = parts.join("/");
  const extensions = [...JAVASCRIPT_EXTENSIONS, ...TYPESCRIPT_EXTENSIONS];
  for (const candidate of [base, ...extensions.map((extension) => `${base}${extension}`), ...extensions.map((extension) => `${base}/index${extension}`)]) if (available.has(candidate)) return candidate;
  return undefined;
}

// Shared with `analyzeBoundedSyntaxProject`'s own import scan, below, and
// exported (P3-3b) so a host-side pre-seed (`apps/urdira/src/index.ts`) can
// extract the identical specifier set from a file's text WITHOUT
// re-implementing the pattern -- the only way to extract specifiers is this
// one regex, used from exactly one place (`extractImportSpecifiers`).
export const JS_TS_IMPORT_SPECIFIER_PATTERN = /\b(import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/gu;

/** Every raw import/re-export specifier textually present in `text`, in source order (duplicates kept). */
export function extractImportSpecifiers(text: string): readonly string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(JS_TS_IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[2] ?? match[3];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

/**
 * Resolves an already-extracted per-file specifier set into the direct
 * import graph -- the pure "given specifiers, produce edges" half of
 * `analyzeSyntaxDependencyGraph` (below), split out so a host-side pre-seed
 * can call it directly once it knows the complete root-name set, without
 * ever needing file TEXT again (only the specifiers `extractImportSpecifiers`
 * already pulled out of it -- see that function and P3-3b). `sourceFiles`
 * must already be exactly the filtered+sorted root-name set (as
 * `analyzeSyntaxDependencyGraph` computes it); this function does no
 * filtering of its own so both callers share the identical edge-building
 * logic, not just the identical regex.
 */
export function resolveSyntaxDependencyGraph(sourceFiles: readonly string[], specifiersByPath: ReadonlyMap<string, readonly string[]>): Readonly<Record<string, JsTsDirectDependency>> {
  const available = new Set(sourceFiles);
  const graph: Record<string, JsTsDirectDependency> = {};
  for (const path of sourceFiles) {
    const direct = new Set<string>();
    let complete = true;
    for (const specifier of specifiersByPath.get(path) ?? []) {
      const targetPath = resolveLargeSyntaxModule(available, path, specifier);
      if (targetPath !== undefined) direct.add(targetPath);
      else if (specifier.startsWith(".") && !relativeAssetSpecifier(specifier)) complete = false;
    }
    graph[path] = { direct_files: [...direct].sort(), complete };
  }
  return graph;
}

/**
 * Scan only the direct import graph required to plan a large stage-1 pass.
 * It deliberately retains no declarations, relations, ASTs, transitive
 * closures, or source text after the worker response has been transferred.
 */
export function analyzeSyntaxDependencyGraph(input: { readonly files: readonly AnalyzerFile[]; readonly root_names?: readonly string[] }): Readonly<Record<string, JsTsDirectDependency>> {
  const rootNames = [...(input.root_names ?? input.files.map((file) => file.path).filter((path) => languageForPath(path) !== undefined))].filter((path) => languageForPath(path) !== undefined).sort();
  const rootNameSet = new Set(rootNames);
  const sourceFiles = input.files.filter((file) => rootNameSet.has(file.path)).sort((left, right) => left.path.localeCompare(right.path));
  const specifiersByPath = new Map(sourceFiles.map((file) => [file.path, extractImportSpecifiers(file.text)] as const));
  return resolveSyntaxDependencyGraph(sourceFiles.map((file) => file.path), specifiersByPath);
}

/** Always use the bounded, checker-free stage-1 scanner. */
export function analyzeBoundedSyntaxProject(input: { readonly files: readonly AnalyzerFile[]; readonly root_names?: readonly string[] }): JsTsAnalysisResult {
  const rootNames = [...(input.root_names ?? input.files.map((file) => file.path).filter((path) => languageForPath(path) !== undefined))].filter((path) => languageForPath(path) !== undefined).sort();
  const rootNameSet = new Set(rootNames);
  const sourceFiles = input.files.filter((file) => rootNameSet.has(file.path)).sort((left, right) => left.path.localeCompare(right.path));
  const available = new Set(sourceFiles.map((file) => file.path));
  const modules = new Map<string, JsTsEntity>();
  const entities: JsTsEntity[] = [];
  const relations: JsTsRelation[] = [];
  const directEdges = new Map<string, Set<string>>();
  const incomplete = new Set<string>();
  for (const file of sourceFiles) {
    const moduleEntity: JsTsEntity = { id: stableId("module", file.path, 0, file.path), name: file.path, kind: "module", universal_kind: "core:container", path: file.path, start: 0, end: file.text.length, ...(file.text.includes('from "node:test"') || file.text.includes("from 'node:test'") ? { is_test: true } : {}) };
    modules.set(file.path, moduleEntity); entities.push(moduleEntity);
  }
  const declarationPattern = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gu;
  const addRelation = (kind: string, source: JsTsEntity, target: JsTsEntity | undefined, path: string, start: number, end: number, classification: "confirmed" | "possible"): void => {
    relations.push({ id: `${JAVASCRIPT_TYPESCRIPT_NAMESPACE}:${kind}:${path}:${start}:${end}:${source.id}:${target?.id ?? "unresolved"}`, kind: `core:${kind}`, source_id: source.id, ...(target === undefined ? {} : { target_id: target.id }), path, start, end, classification });
  };
  for (const file of sourceFiles) {
    const moduleEntity = modules.get(file.path)!;
    for (const match of file.text.matchAll(declarationPattern)) {
      const name = match[2]; const declarationKind = match[1];
      if (name === undefined || declarationKind === undefined) continue;
      const start = match.index + match[0].lastIndexOf(name);
      if (start < 0) continue;
      const kind = declarationKind === "function" ? "function" : declarationKind === "class" ? "class" : declarationKind === "interface" ? "interface" : declarationKind === "type" ? "type" : declarationKind === "enum" ? "enum" : "variable";
      const universalKind = kind === "function" ? "core:callable" : kind === "variable" ? "core:value" : "core:type";
      const entity: JsTsEntity = { id: stableId(kind, file.path, start, name), name, kind, universal_kind: universalKind, path: file.path, start, end: start + name.length, parent_id: moduleEntity.id, qualified_name: `${file.path}.${name}` };
      entities.push(entity);
      addRelation("contains", moduleEntity, entity, file.path, start, start + name.length, "confirmed");
    }
    for (const match of file.text.matchAll(JS_TS_IMPORT_SPECIFIER_PATTERN)) {
      const specifier = match[2] ?? match[3]; if (specifier === undefined) continue;
      const targetPath = resolveLargeSyntaxModule(available, file.path, specifier); const target = targetPath === undefined ? undefined : modules.get(targetPath);
      const start = match.index; addRelation(match[1] === "export" ? "export" : "import", moduleEntity, target, file.path, start, start + match[0].length, target === undefined ? "possible" : "confirmed");
      if (targetPath !== undefined) {
        const edges = directEdges.get(file.path);
        if (edges === undefined) directEdges.set(file.path, new Set([targetPath]));
        else edges.add(targetPath);
      }
      else if (specifier.startsWith(".") && !relativeAssetSpecifier(specifier)) incomplete.add(file.path);
    }
  }
  entities.sort((left, right) => left.id.localeCompare(right.id)); relations.sort((left, right) => left.id.localeCompare(right.id));
  const dependencyClosures: Record<string, JsTsDependencyClosure> = {};
  for (const file of sourceFiles) {
    const visited = new Set<string>([file.path]); const stack = [file.path]; let complete = true;
    while (stack.length > 0) { const current = stack.pop()!; if (incomplete.has(current)) complete = false; for (const next of directEdges.get(current) ?? []) if (!visited.has(next)) { visited.add(next); stack.push(next); } }
    dependencyClosures[file.path] = { files: [...visited].sort(), complete };
  }
  return { language: rootNames.some((path) => languageForPath(path) === "javascript") && !rootNames.some((path) => languageForPath(path) === "typescript") ? "javascript" : "typescript", entities, relations, diagnostics: [], complete: true, dependency_closures: dependencyClosures };
}

/**
 * Build only the facts that are valid after structural stage 1.  This keeps
 * the TypeScript program construction (which is cheap) but deliberately never
 * asks for a checker, symbols, signatures, types, or diagnostics.  Stage 1 is
 * therefore useful while the expensive semantic walk is still pending.
 */
export function analyzeSyntaxProject(input: { readonly files: readonly AnalyzerFile[]; readonly root_names?: readonly string[]; readonly compiler_options?: Readonly<Record<string, unknown>> }): JsTsAnalysisResult {
  // The checker path remains valuable for ordinary projects. The threshold
  // is intentionally lower than the worker's one-process RSS ceiling: a few
  // thousand modest files can already make TypeScript's project graph
  // hundreds of megabytes before any useful stage-1 row is published.
  if (isLargeSyntaxCorpus(input)) return analyzeBoundedSyntaxProject(input);
  const rootNames = [...(input.root_names ?? input.files.map((file) => file.path).filter((path) => languageForPath(path) !== undefined))].sort();
  const sourceFiles = input.files.filter((candidate) => rootNames.includes(candidate.path)).sort((left, right) => left.path.localeCompare(right.path));
  const virtualRoot = "/urdira-workspace";
  const virtualPath = (path: string): string => `${virtualRoot}/${path}`;
  const relativePath = (path: string): string => path.startsWith(`${virtualRoot}/`) ? path.slice(virtualRoot.length + 1) : path;
  const hasJavaScript = rootNames.some((path) => languageForPath(path) === "javascript");
  const configPath = `${virtualRoot}/__urdira_project__.json`;
  const compilerOptions = { ...(hasJavaScript ? { allowJs: true, checkJs: true } : {}), ...(input.compiler_options ?? {}) };
  const virtualFiles: Record<string, string> = Object.fromEntries([
    ...sourceFiles.map((file) => [virtualPath(file.path), file.text] as const),
    [configPath, JSON.stringify({ compilerOptions, files: rootNames })],
  ]);
  const api = new API({ fs: createVirtualFileSystem(virtualFiles) });
  let project: TypescriptProject | undefined;
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configPath] });
    project = snapshot.getProjects().find((candidate) => candidate.configFileName === configPath);
    if (project === undefined) throw new Error("TypeScript did not create a project for the virtual configuration.");
    const program = project.program;
    const entities: JsTsEntity[] = [];
    const relations: JsTsRelation[] = [];
    const entityByNode = new Map<string, JsTsEntity>();
    const entityById = new Map<string, JsTsEntity>();
    const moduleByPath = new Map<string, JsTsEntity>();
    const directImportEdges = new Map<string, Set<string>>();
    const incompleteClosureFiles = new Set<string>();
    const nodeKey = (node: Node): string => `${relativePath(node.getSourceFile().fileName)}:${node.getStart(node.getSourceFile())}`;
    const nameOf = (node: Node): string | undefined => {
      // A `ConstructorDeclaration` has no `.name` node at all (`name?: never`
      // in the TS AST) -- synthesize "constructor" as its name, matching the
      // Rust syntax worker's `MethodDefinitionKind::Constructor` identity
      // (`DeclKind::Constructor`'s name is the literal "constructor" text).
      if (isConstructorDeclaration(node)) return "constructor";
      const value = (node as Node & { readonly name?: Node }).name;
      if (value === undefined) return undefined;
      const candidate = value as Node & { readonly text?: string; readonly escapedText?: string | number };
      if (typeof candidate.text === "string") return candidate.text;
      if (typeof candidate.escapedText === "string" || typeof candidate.escapedText === "number") return String(candidate.escapedText);
      return undefined;
    };
    const addEntity = (node: Node, parent: JsTsEntity | undefined): JsTsEntity | undefined => {
      const name = nameOf(node);
      if (name === undefined || name.length === 0) return undefined;
      const source = node.getSourceFile();
      const path = relativePath(source.fileName);
      const start = node.getStart(source);
      const end = node.getEnd();
      let kind: string;
      let universalKind: string;
      if (isFunctionDeclaration(node)) { kind = "function"; universalKind = "core:callable"; }
      else if (isClassDeclaration(node)) { kind = "class"; universalKind = "core:type"; }
      else if (isInterfaceDeclaration(node)) { kind = "interface"; universalKind = "core:type"; }
      else if (isTypeAliasDeclaration(node)) { kind = "type"; universalKind = "core:type"; }
      else if (isEnumDeclaration(node)) { kind = "enum"; universalKind = "core:type"; }
      else if (isModuleDeclaration(node)) { kind = "namespace"; universalKind = "core:type"; }
      else if (isVariableDeclaration(node)) { kind = "variable"; universalKind = "core:value"; }
      else if (isParameterDeclaration(node)) { kind = "parameter"; universalKind = "core:parameter"; }
      else if (isMethodDeclaration(node) || isMethodSignatureDeclaration(node)) { kind = "method"; universalKind = "core:callable"; }
      else if (isConstructorDeclaration(node)) { kind = "constructor"; universalKind = "core:callable"; }
      else if (isGetAccessorDeclaration(node)) { kind = "getter"; universalKind = "core:callable"; }
      else if (isSetAccessorDeclaration(node)) { kind = "setter"; universalKind = "core:callable"; }
      else if (isPropertyDeclaration(node)) { kind = "property"; universalKind = "core:value"; }
      else return undefined;
      // Identity uses the START OF THE NAME IDENTIFIER, not the declaration's
      // own start -- the same convention the Rust syntax worker uses
      // (`identifier.span.start`, crates/urdira-jsts-syntax-worker/src/lib.rs
      // `push_entity`). The entity's PUBLISHED span (`start`/`end` above,
      // `entity.start`/`entity.end` below) stays the full declaration span;
      // only the id changes. A constructor has no name node -- its identity
      // instead anchors on the "constructor" keyword (see
      // `constructorKeywordStart`), matching Rust's `PropertyKey` span there.
      const nameNode = (node as Node & { readonly name?: Node }).name;
      const identityStart = nameNode !== undefined ? nameNode.getStart(source) : isConstructorDeclaration(node) ? constructorKeywordStart(node, source) : start;
      const id = stableId(kind, path, identityStart, name);
      const existing = entityById.get(id);
      if (existing !== undefined) return existing;
      const entity: JsTsEntity = { id, name, kind, universal_kind: universalKind, path, start, end, ...(parent === undefined ? {} : { parent_id: parent.id, qualified_name: `${parent.qualified_name ?? parent.name}.${name}` }) };
      entities.push(entity);
      entityById.set(id, entity);
      entityByNode.set(nodeKey(node), entity);
      if (parent !== undefined) relations.push({ id: `${JAVASCRIPT_TYPESCRIPT_NAMESPACE}:contains:${parent.id}:${entity.id}`, kind: "core:contains", source_id: parent.id, target_id: entity.id, path, start, end, classification: "confirmed" });
      return entity;
    };
    const collect = (node: Node, parent: JsTsEntity | undefined): void => {
      const entity = addEntity(node, parent) ?? parent;
      node.forEachChild((child) => collect(child, entity));
    };
    const moduleTarget = (node: Node): JsTsEntity | undefined => {
      const specifier = (node as Node & { readonly text?: string }).text;
      if (typeof specifier !== "string" || !specifier.startsWith(".")) return undefined;
      const sourceParts = relativePath(node.getSourceFile().fileName).split("/");
      sourceParts.pop();
      for (const part of specifier.split("/")) {
        if (part === "." || part === "") continue;
        if (part === "..") sourceParts.pop();
        else sourceParts.push(part);
      }
      const base = sourceParts.join("/");
      const extensions = [...JAVASCRIPT_EXTENSIONS, ...TYPESCRIPT_EXTENSIONS];
      for (const candidate of [base, ...extensions.map((extension) => `${base}${extension}`), ...extensions.map((extension) => `${base}/index${extension}`)]) {
        const target = moduleByPath.get(candidate);
        if (target !== undefined) return target;
      }
      return undefined;
    };
    const relate = (kind: string, source: JsTsEntity, target: JsTsEntity | undefined, node: Node, classification: "confirmed" | "possible"): void => {
      const path = relativePath(node.getSourceFile().fileName);
      const start = node.getStart(node.getSourceFile());
      const end = node.getEnd();
      relations.push({ id: `${JAVASCRIPT_TYPESCRIPT_NAMESPACE}:${kind}:${path}:${start}:${end}:${source.id}:${target?.id ?? "unresolved"}`, kind: `core:${kind}`, source_id: source.id, ...(target === undefined ? {} : { target_id: target.id }), path, start, end, classification });
      if (target !== undefined && target.path !== path) (directImportEdges.get(path) ?? new Set<string>()).add(target.path);
    };
    for (const file of sourceFiles) {
      const source = program.getSourceFile(virtualPath(file.path));
      if (source === undefined) continue;
      let isTestModule = false;
      source.forEachChild((node) => {
        if (isImportDeclaration(node)) {
          const specifier = (node as Node & { readonly moduleSpecifier?: Node }).moduleSpecifier as Node & { readonly text?: string } | undefined;
          if (specifier?.text === "node:test") isTestModule = true;
        }
      });
      const moduleEntity: JsTsEntity = { id: stableId("module", file.path, 0, file.path), name: file.path, kind: "module", universal_kind: "core:container", path: file.path, start: 0, end: source.getEnd(), ...(isTestModule ? { is_test: true } : {}) };
      entities.push(moduleEntity);
      entityById.set(moduleEntity.id, moduleEntity);
      moduleByPath.set(file.path, moduleEntity);
      collect(source, moduleEntity);
    }
    for (const file of sourceFiles) {
      const source = program.getSourceFile(virtualPath(file.path));
      if (source === undefined) continue;
      const walk = (node: Node): void => {
        if (isImportDeclaration(node) || isExportDeclaration(node)) {
          const specifier = (node as Node & { readonly moduleSpecifier?: Node }).moduleSpecifier;
          const sourceModule = moduleByPath.get(file.path);
          const targetModule = specifier === undefined ? undefined : moduleTarget(specifier);
          if (sourceModule !== undefined && specifier !== undefined) {
            relate(isImportDeclaration(node) ? "import" : "export", sourceModule, targetModule, node, targetModule === undefined ? "possible" : "confirmed");
            const specifierText = (specifier as Node & { readonly text?: string }).text;
            if (targetModule === undefined && typeof specifierText === "string" && specifierText.startsWith(".") && !relativeAssetSpecifier(specifierText)) incompleteClosureFiles.add(file.path);
          }
        }
        node.forEachChild(walk);
      };
      walk(source);
    }
    entities.sort((left, right) => left.id.localeCompare(right.id));
    relations.sort((left, right) => left.id.localeCompare(right.id));
    const dependencyClosures: Record<string, JsTsDependencyClosure> = {};
    for (const file of sourceFiles) {
      const visited = new Set<string>([file.path]);
      const stack = [file.path];
      let complete = true;
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (incompleteClosureFiles.has(current)) complete = false;
        for (const next of directImportEdges.get(current) ?? []) if (!visited.has(next)) { visited.add(next); stack.push(next); }
      }
      dependencyClosures[file.path] = { files: [...visited].sort(), complete };
    }
    return { language: rootNames.some((path) => languageForPath(path) === "javascript") && !rootNames.some((path) => languageForPath(path) === "typescript") ? "javascript" : "typescript", entities, relations, diagnostics: [], complete: true, dependency_closures: dependencyClosures };
  } finally {
    api.close();
  }
}

function normalizedExtension(path: string): string {
  const lower = path.toLocaleLowerCase("en-US");
  if (lower.endsWith(".d.mts")) return ".d.mts";
  if (lower.endsWith(".d.cts")) return ".d.cts";
  if (lower.endsWith(".d.ts")) return ".d.ts";
  const dot = lower.lastIndexOf(".");
  return dot < 0 ? "" : lower.slice(dot);
}

export function languageForPath(path: string): JsTsLanguage | undefined {
  const extension = normalizedExtension(path);
  if ((TYPESCRIPT_EXTENSIONS as readonly string[]).includes(extension)) return "typescript";
  if ((JAVASCRIPT_EXTENSIONS as readonly string[]).includes(extension)) return "javascript";
  return undefined;
}

export function scriptKindForPath(path: string): JsTsScriptKind | undefined {
  const extension = normalizedExtension(path);
  if (extension === ".tsx") return "tsx";
  if (extension === ".jsx") return "jsx";
  if ((TYPESCRIPT_EXTENSIONS as readonly string[]).includes(extension)) return "ts";
  if ((JAVASCRIPT_EXTENSIONS as readonly string[]).includes(extension)) return "js";
  return undefined;
}

function jsonObject(text: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const withoutComments = text.replace(/\/\/[^\n\r]*/gu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
    const parsed: unknown = JSON.parse(withoutComments);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Readonly<Record<string, unknown>> : undefined;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function configCompilerOptions(config: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const compilerOptions = config["compilerOptions"];
  return compilerOptions !== null && typeof compilerOptions === "object" && !Array.isArray(compilerOptions)
    ? compilerOptions as Readonly<Record<string, unknown>>
    : {};
}

export function discoverProjects(files: readonly AnalyzerFile[]): readonly DiscoveredProject[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const configs = files.filter((file) => /(^|\/)(?:tsconfig|jsconfig)\.json$/u.test(file.path));
  const manifests = files.filter((file) => /(^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lock|bun\.lockb)$/u.test(file.path)).map((file) => file.path).sort();
  const projects: DiscoveredProject[] = [];
  const virtualRoot = "/urdira-workspace";
  const api = configs.length === 0 ? undefined : new API({ cwd: virtualRoot, fs: createVirtualFileSystem(Object.fromEntries(files.map((file) => [`${virtualRoot}/${file.path}`, file.text]))) });
  const normalizeRelative = (fromPath: string, target: string): string => {
    if (!target.startsWith(".")) return target;
    const parts = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")).split("/") : [];
    for (const part of target.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return parts.join("/");
  };
  const configurationDependencies = (config: AnalyzerFile): string[] => {
    const found = new Set<string>([config.path]);
    const visit = (current: AnalyzerFile): void => {
      const parsed = jsonObject(current.text);
      const extended = typeof parsed?.["extends"] === "string" ? [parsed["extends"] as string] : stringArray(parsed?.["extends"]);
      for (const entry of extended) {
        const base = normalizeRelative(current.path, entry);
        const candidates = [base, `${base}.json`, `${base}/tsconfig.json`];
        const match = candidates.map((candidate) => byPath.get(candidate)).find((candidate) => candidate !== undefined);
        if (match !== undefined && !found.has(match.path)) { found.add(match.path); visit(match); }
      }
    };
    visit(config);
    return [...found].sort();
  };
  try {
    for (const config of configs.sort((left, right) => left.path.localeCompare(right.path))) {
      const parsed = jsonObject(config.text);
      let members: string[] = [];
      let compilerOptions = configCompilerOptions(parsed ?? {});
      try {
        const response = api?.parseConfigFile(`${virtualRoot}/${config.path}`);
        members = (response?.fileNames ?? []).map((path) => path.startsWith(`${virtualRoot}/`) ? path.slice(virtualRoot.length + 1) : path).filter((path) => byPath.has(path) && languageForPath(path) !== undefined).sort();
        if (response !== undefined) compilerOptions = response.options;
      } catch {
        const configDirectory = config.path.includes("/") ? config.path.slice(0, config.path.lastIndexOf("/")) : "";
        const filesFromConfig = stringArray(parsed?.["files"]);
        const includes = stringArray(parsed?.["include"]);
        members = files.filter((file) => languageForPath(file.path) !== undefined && (
          filesFromConfig.some((entry) => (configDirectory.length === 0 ? entry : `${configDirectory}/${entry}`) === file.path) || includes.length === 0 || includes.some((pattern) => {
            const prefix = pattern.replace(/\*.*$/u, "");
            return pattern === "**/*" || file.path.startsWith(configDirectory.length === 0 ? prefix : `${configDirectory}/${prefix}`);
          })
        )).map((file) => file.path).sort();
      }
      const references = Array.isArray(parsed?.["references"])
        ? parsed["references"].filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry)).map((entry) => typeof entry["path"] === "string" ? normalizeRelative(config.path, entry["path"]) : "").filter(Boolean).sort()
        : [];
      projects.push({ project_path: config.path, config_path: config.path, root_names: [...new Set(members)].sort(), referenced_projects: references, configuration_dependencies: configurationDependencies(config), workspace_manifests: manifests, compiler_options: compilerOptions, inferred: false });
    }
  } finally {
    api?.close();
  }
  if (projects.length === 0) {
    const sourceFiles = files.filter((file) => languageForPath(file.path) !== undefined).map((file) => file.path).sort();
    if (sourceFiles.length > 0) projects.push({ project_path: ".", root_names: sourceFiles, referenced_projects: [], configuration_dependencies: [], workspace_manifests: manifests, compiler_options: {}, inferred: true });
  }
  return projects;
}

function stableId(kind: string, path: string, start: number, name: string): string {
  return `${JAVASCRIPT_TYPESCRIPT_NAMESPACE}:${kind}:${path}:${start}:${name}`;
}

/**
 * A `ConstructorDeclaration` has no `.name` node (`name?: never` in the TS
 * AST) -- it is the only `rustSemanticDeclarationShape` kind without one.
 * Its identity instead anchors on the "constructor" keyword itself, which
 * this scans for starting at the node's own start (skipping any preceding
 * accessibility modifier, e.g. `private constructor() {}`). This MUST match
 * the Rust syntax worker's identity for `MethodDefinitionKind::Constructor`
 * exactly: `key.span.start` there is the span of the `PropertyKey` for the
 * literal "constructor" text, never any preceding modifier
 * (crates/urdira-jsts-syntax-worker/src/semantic_sites.rs, `declaration_id`
 * call in `visit_method_definition`).
 */
function constructorKeywordStart(node: Node, source: TypescriptSourceFile): number {
  const scanner = createScanner(false);
  scanner.setText(source.text, node.getStart(source));
  for (;;) {
    const token = scanner.scan();
    if (token === SyntaxKind.EndOfFile) return node.getStart(source);
    if (token === SyntaxKind.ConstructorKeyword) return scanner.getTokenStart();
  }
}

export function analyzeProject(input: { readonly files: readonly AnalyzerFile[]; readonly root_names?: readonly string[]; readonly compiler_options?: Readonly<Record<string, unknown>> }): JsTsAnalysisResult {
  const rootNames = [...(input.root_names ?? input.files.map((file) => file.path).filter((path) => languageForPath(path) !== undefined))].sort();
  const sourceFiles = input.files.filter((candidate) => rootNames.includes(candidate.path)).sort((left, right) => left.path.localeCompare(right.path));
  const virtualRoot = "/urdira-workspace";
  const configPath = `${virtualRoot}/__urdira_project__.json`;
  const hasJavaScript = rootNames.some((path) => languageForPath(path) === "javascript");
  const compilerOptions = { ...(hasJavaScript ? { allowJs: true, checkJs: true } : {}), ...(input.compiler_options ?? {}) };
  const virtualFiles: Record<string, string> = Object.fromEntries([
    ...sourceFiles.map((file) => [`${virtualRoot}/${file.path}`, file.text] as const),
    [configPath, JSON.stringify({ compilerOptions, files: rootNames })],
  ]);
  const api = new API({ fs: createVirtualFileSystem(virtualFiles) });
  let project: TypescriptProject | undefined;
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configPath] });
    project = snapshot.getProjects().find((candidate) => candidate.configFileName === configPath);
    if (project === undefined) throw new Error("TypeScript did not create a project for the virtual configuration.");

    const entityByNode = new Map<string, JsTsEntity>();
    const entityById = new Map<string, JsTsEntity>();
    const moduleByPath = new Map<string, JsTsEntity>();
    const walkOutput = walkFiles({ project, virtualRoot, filesToProcess: sourceFiles, entityByNode, entityById, moduleByPath });
    return assembleAnalysis(sourceFiles, rootNames, walkOutput.entitiesByFile, walkOutput.relationsByFile, walkOutput.diagnosticsByFile, walkOutput.directEdgesByFile, walkOutput.directIncompleteFiles, entityById);
  } finally {
    project?.checker.dispose();
    api.close();
  }
}

// ---------------------------------------------------------------------------
// Incremental analysis session
// ---------------------------------------------------------------------------
//
// Measured on excalidraw-wt5 (665 source files, 7.6MB): building the TS 7 Go
// API program is ~240ms; the WALK (checker queries -- typeOf,
// getResolvedSignature, getSemanticDiagnostics -- plus extraction) is ~24s,
// 99% of `analyzeProject`'s cost. A persistent API alone wins nothing --
// `updateSnapshot({fileChanges:{changed:[...]}})` after a 1-file edit is
// already ~0ms (lazy) even without this session. The actual win is
// re-walking only the files an edit could possibly affect, and merging the
// result with memoized per-file output for everything else.
//
// Soundness: a file F's own pass-1 (entities, including checker-derived
// `type` strings on its exported surface) and pass-2 (relations + walk
// diagnostics) output depends ONLY on F's own content and the content of
// every file in F's dependency closure (`analyzeProject`'s `relate` doc
// comment above establishes the closure is a superset of every file whose
// content can influence F's output). So: given the previous analysis's
// per-file closures, a file only needs re-walking when ITS OWN previous
// closure intersects the set of files whose content just changed, or when
// its memo is missing/untrustworthy (see below). Every other file's
// memoized output is still exactly what a fresh walk would produce.
//
// `core:covers` relations and dependency closures are NEVER memoized -- both
// are pure, cheap, GLOBAL derivations (over merged `core:references` +
// `is_test` entity flags, and over merged direct import/export edges,
// respectively) recomputed after every merge, exactly like `analyzeProject`
// computes them once after its own single walk.
//
// Root-set changes (a file created/deleted/renamed) or a `compiler_options`
// change always take the full-rebuild path: TypeScript's module resolution
// means a newly created file can change an UNCHANGED file's own resolution
// results, so per-file memoization cannot be trusted across either kind of
// change. A heuristic bailout (>40% of root files changed content in one
// call) also forces a full rebuild, since at that point re-walking
// piecemeal is no longer cheaper than one whole-project walk.

/** One file's memoized pass-1/pass-2/compiler-diagnostic output, plus enough
 * of its previous dependency-closure state to know whether that output is
 * still trustworthy against a NEW set of changed files. */
interface JsTsFileMemo {
  readonly content_hash: string;
  /** This file's OWN previous dependency closure (always includes itself). */
  readonly closure_files: readonly string[];
  /**
   * Whether that closure was known-complete. A `false` here means this
   * file's true dependency set was unknown even at the time this memo was
   * captured (an unresolved relative import somewhere in its closure) --
   * such a file is NEVER memo-valid, and is always re-walked, regardless of
   * whether anything actually changed this round.
   */
  readonly closure_complete: boolean;
  /** This file's own entities (including its `core:module` entity). */
  readonly entities: readonly JsTsEntity[];
  /** This file's own `core:contains` + pass-2 relations. Never `core:covers`. */
  readonly relations: readonly JsTsRelation[];
  /** This file's own walk-time + per-file compiler diagnostics. */
  readonly diagnostics: readonly JsTsDiagnostic[];
  /** Cross-file target paths this file directly imports/exports/references/calls/extends/implements into. */
  readonly direct_edges: readonly string[];
  /**
   * `computeSemanticHashes(text, ...)` of this file's content the moment
   * this memo was captured -- `undefined` when no AST was available to
   * derive it from (`seedFromAnalysis`, a durable-cache hit with no live
   * program). The "dependent-visible change" gate (`buildIncremental`) can
   * only trust a file's projection/direct-edges as unchanged when BOTH
   * hashes are present and match a fresh recomputation; a missing hash
   * always fails the gate conservatively (one full-cost re-walk of THIS
   * file's dependents, then this memo entry gets fresh hashes and the gate
   * becomes capable for the next edit -- see `buildFull`'s doc comment).
   */
  readonly semantic_hash?: string;
  /** See `semantic_hash`; the guard-comment stream's digest (comments that
   * can affect semantics: JSDoc for JS/checkJs files, `///` directives and
   * `@ts-`/`@jsx` pragmas for TS files). */
  readonly guard_hash?: string;
}

export type JsTsAnalysisBuildKind = "full" | "incremental";

/** The result of one `JsTsAnalysisSession.analyze` call: the same shape
 * `analyzeProject` returns, plus session-only bookkeeping (never persisted,
 * never crosses the durable-cache or worker wire-protocol boundary) that
 * lets a caller report which path was taken and how much work it did. */
export interface JsTsSessionAnalyzeResult {
  readonly result: JsTsAnalysisResult;
  readonly build: JsTsAnalysisBuildKind;
  /** Paths actually re-walked this call (all root files for a full build). */
  readonly rewalked: readonly string[];
  /**
   * Changed paths (a subset of the incoming edit's changed files) whose
   * dependent-visible surface (semantic tokens, guard comments, entity
   * projection, direct edges -- see `buildIncremental`'s gate) actually
   * differs from what this session had memoized, so a dependent COULD see a
   * different result. `undefined` on a full build (every root file is
   * re-walked from scratch there; "impactful" only narrows an incremental
   * re-walk/republish, it never widens one). A caller (`worker.ts`,
   * `apps/urdira/src/index.ts`'s `isAffectedOwner`) that receives an actual
   * array -- even an EMPTY one -- may narrow owner republishing to files
   * whose closure intersects it; receiving `undefined` must keep today's
   * conservative "closure intersects changed set" behavior.
   */
  readonly impactful_changed_paths?: readonly string[];
}

const SESSION_VIRTUAL_ROOT = "/urdira-workspace";
const SESSION_CONFIG_FILE = "__urdira_project__.json";
/** Rule 2: re-walking piecemeal past this fraction of changed root files is
 * no longer cheaper than one whole-project walk. */
const INCREMENTAL_CHANGE_RATIO_BAILOUT = 0.4;

function fileContentDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Deterministic, key-order-independent JSON serialization -- used only to
 * compare two `compiler_options` objects for equality (array element order
 * still matters, which is conservative-safe: at worst a reordered-but-
 * equivalent array is treated as "changed", forcing an unnecessary but
 * harmless full rebuild). */
function stableOptionsJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.keys(input as Record<string, unknown>).sort().map((key) => [key, normalize((input as Record<string, unknown>)[key])]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/**
 * AST node kinds a naive (parser-free) token scan of the raw source text can
 * mislex -- a bare regex literal can absorb a following `//` as a division
 * operator then a comment, a template literal's substitution/tail can hide
 * an unbalanced `//` or backtick-lookalike sequence, and JSX text/attributes
 * lex under entirely different rules than the rest of the language. Treating
 * every OUTERMOST node of one of these kinds as one opaque, verbatim-text
 * span (see `collectOpaqueSpans`/`computeSemanticHashes` below) sidesteps
 * all of that: the naive scanner never has to get these right, it just
 * jumps straight from the span's start to its end.
 */
const OPAQUE_SPAN_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.TemplateExpression,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.JsxElement,
  SyntaxKind.JsxSelfClosingElement,
  SyntaxKind.JsxFragment,
]);

/**
 * Collects `[start, end)` spans (`node.getStart(sf)`/`node.getEnd()`) of the
 * OUTERMOST nodes in `sourceFileNode` whose kind is in `OPAQUE_SPAN_KINDS`,
 * sorted by start. Does not recurse into a collected node -- its whole span
 * is opaque, so nothing nested inside it (e.g. a template's `${...}`
 * substitution) needs its own entry. `source` mirrors `computeSemanticHashes`'s
 * own first parameter for a matching call shape; the spans themselves are
 * derived purely from the parsed AST, never from the raw text.
 */
function collectOpaqueSpans(source: string, sourceFileNode: TypescriptSourceFile): ReadonlyArray<readonly [number, number]> {
  const spans: Array<[number, number]> = [];
  const visit = (node: Node): void => {
    if (OPAQUE_SPAN_KINDS.has(node.kind)) {
      spans.push([node.getStart(sourceFileNode), node.getEnd()]);
      return;
    }
    node.forEachChild(visit);
  };
  sourceFileNode.forEachChild(visit);
  return spans.sort((left, right) => left[0] - right[0]);
}

/**
 * Drives a trivia-preserving TS7 scanner (`skipTrivia: false`, so comments
 * surface as their own tokens) over `text` and buckets everything into two
 * independent content streams, each collapsed to a sha256 digest:
 *
 *  - `semantic_hash`: every token that can affect a DEPENDENT's view of this
 *    file (identifiers, punctuation, literals, keywords -- everything the
 *    checker/parser actually consumes) plus the verbatim text of every
 *    `opaqueSpans` region (regex/template/JSX -- see `collectOpaqueSpans`).
 *    Plain comments are excluded: they can never change a resolved type, a
 *    signature, an entity's `id`/`kind`/`path`/`start`, or a direct edge.
 *  - `guard_hash`: comments that CAN affect semantics -- ALL comments when
 *    `isJavascriptFamily` (this analyzer runs JS under `checkJs`, so JSDoc
 *    comments feed inferred types) or, for TS files, only `///` triple-slash
 *    directives and comments containing a `@ts-`/`@jsx` pragma.
 *
 * A token whose start falls inside the next opaque span is never individually
 * tokenized -- see `collectOpaqueSpans`'s doc comment for why a mislexed
 * token is guaranteed to START inside its span, which is what makes this
 * span-boundary check sound without the scanner ever needing real parser
 * context.
 */
function computeSemanticHashes(text: string, opaqueSpans: ReadonlyArray<readonly [number, number]>, isJavascriptFamily: boolean): { readonly semantic_hash: string; readonly guard_hash: string } {
  const scanner = createScanner(false);
  scanner.setText(text);
  const semanticStream: string[] = [];
  const guardStream: string[] = [];
  let spanIndex = 0;
  for (;;) {
    const token = scanner.scan();
    if (token === SyntaxKind.EndOfFile) break;
    const tokenStart = scanner.getTokenStart();
    while (spanIndex < opaqueSpans.length && tokenStart >= opaqueSpans[spanIndex]![1]) spanIndex += 1;
    const span = opaqueSpans[spanIndex];
    if (span !== undefined && tokenStart >= span[0] && tokenStart < span[1]) {
      semanticStream.push(`opaque\0${text.slice(span[0], span[1])}`);
      scanner.resetTokenState(span[1]);
      continue;
    }
    if (token === SyntaxKind.WhitespaceTrivia || token === SyntaxKind.NewLineTrivia) continue;
    if (token === SyntaxKind.SingleLineCommentTrivia || token === SyntaxKind.MultiLineCommentTrivia) {
      const commentText = scanner.getTokenText();
      if (isJavascriptFamily || commentText.startsWith("///") || commentText.includes("@ts-") || commentText.includes("@jsx")) guardStream.push(commentText);
      continue;
    }
    semanticStream.push(`${token}\0${scanner.getTokenText()}`);
  }
  return {
    semantic_hash: createHash("sha256").update(semanticStream.join("\0")).digest("hex"),
    guard_hash: createHash("sha256").update(guardStream.join("\0")).digest("hex"),
  };
}

/**
 * A file's dependent-visible entity projection: just enough of each entity
 * (`id`/`kind`/`path`/`start` -- exactly the fields `walkFiles`' memo-
 * reconstruction maps key off of, see that function's doc comment) to detect
 * whether a dependent's cross-file lookups could resolve differently. `end`,
 * `type`, relations, and diagnostics are deliberately excluded -- none of
 * them are visible to a dependent's own walk. Entities arrive in
 * deterministic AST order for identical semantic content, so a plain ordered
 * join (not a sorted/keyed comparison) is the correct equality check.
 */
function entityProjection(entities: readonly JsTsEntity[]): string {
  return entities.map((entity) => `${entity.id}\0${entity.kind}\0${entity.path}\0${entity.start}`).join("\n");
}

/**
 * Backing store for `createMutableFileSystem`, holding both the virtual
 * `path -> text` map and a live, reference-counted directory index.
 *
 * T2 (docs/evidence/2026-09-02-file-creation-diagnosis.md): earlier this was
 * a bare `Map<string, string>` whose directory listing was computed ONCE
 * from its initial keys, on the documented assumption that "a session never
 * adds or removes map entries after construction (root-set changes always
 * rebuild via a brand new map instead)". `prepareRustSemanticState`'s
 * incremental add/remove-root path breaks that assumption on purpose (a
 * created/deleted file's path genuinely enters or leaves this store without
 * a full rebuild), so the directory index now has to stay live across
 * `set`/`delete` calls instead of being frozen at construction. `set`/`get`/
 * `has`/`keys`/`size` keep the plain `Map` shape every existing call site
 * already used.
 */
class MutableVirtualFileSystemStore {
  private readonly files = new Map<string, string>();
  private readonly directoryRefCounts = new Map<string, number>();

  constructor(initial?: Iterable<readonly [string, string]>) {
    if (initial !== undefined) for (const [path, text] of initial) this.set(path, text);
  }

  private eachAncestorDirectory(path: string, visit: (directory: string) => void): void {
    let directory = path;
    while (directory.includes("/")) {
      directory = directory.slice(0, directory.lastIndexOf("/"));
      if (directory.length > 0) visit(directory);
    }
  }

  set(path: string, text: string): void {
    if (!this.files.has(path)) this.eachAncestorDirectory(path, (directory) => this.directoryRefCounts.set(directory, (this.directoryRefCounts.get(directory) ?? 0) + 1));
    this.files.set(path, text);
  }

  delete(path: string): void {
    if (!this.files.delete(path)) return;
    this.eachAncestorDirectory(path, (directory) => {
      const count = this.directoryRefCounts.get(directory) ?? 0;
      if (count <= 1) this.directoryRefCounts.delete(directory); else this.directoryRefCounts.set(directory, count - 1);
    });
  }

  has(path: string): boolean { return this.files.has(path); }
  get(path: string): string | undefined { return this.files.get(path); }
  get size(): number { return this.files.size; }
  keys(): IterableIterator<string> { return this.files.keys(); }
  directoryExists(directoryName: string): boolean { return this.directoryRefCounts.has(directoryName); }
}

/** A mutable, in-memory `FileSystem` for the TS 7 API backed by a
 * `MutableVirtualFileSystemStore` -- unlike `createVirtualFileSystem`
 * (immutable, snapshotted once at construction), later `store.set(...)`/
 * `store.delete(...)` calls are visible to the API on its NEXT
 * `updateSnapshot({fileChanges:...})`, which is what lets a session apply a
 * content-only edit -- or, since T2, a root add/remove -- without rebuilding
 * the API or its underlying Go-server project state. */
function createMutableFileSystem(store: MutableVirtualFileSystemStore): FileSystem {
  return {
    fileExists: (fileName) => store.has(fileName),
    directoryExists: (directoryName) => store.directoryExists(directoryName),
    // `undefined` (NOT `null`) for a path this map doesn't track: per
    // `FileSystem.readFile`'s doc comment (`typescript/unstable/fs`),
    // `null` means "does not exist, never fall back to the real
    // filesystem" while `undefined` means "fall back" -- and falling back
    // is exactly what TypeScript's default library files (`lib.es5.d.ts`
    // and friends, never part of this virtual workspace's own map) need in
    // order to resolve at all. `createVirtualFileSystem` (used by
    // `analyzeProject`) returns `undefined` here for the identical reason;
    // returning `null` instead silently broke every ambient/global type
    // (e.g. `Error`) for every session build until this was caught by the
    // differential correctness tests.
    readFile: (fileName) => store.get(fileName),
    realpath: (path) => path,
    getAccessibleEntries: (directoryName) => {
      // `undefined` (not an empty listing) for a directory outside this
      // map's own tree -- matches `createVirtualFileSystem`'s behavior,
      // letting the real filesystem's own directory listing take over for
      // anything this virtual workspace doesn't itself contain.
      if (!store.directoryExists(directoryName)) return undefined;
      const files: string[] = [];
      const subdirectories = new Set<string>();
      for (const path of store.keys()) {
        if (!path.startsWith(`${directoryName}/`)) continue;
        const rest = path.slice(directoryName.length + 1);
        const slash = rest.indexOf("/");
        if (slash < 0) files.push(rest); else subdirectories.add(rest.slice(0, slash));
      }
      return { files, directories: [...subdirectories] };
    },
  };
}

interface JsTsWalkPassOutput {
  readonly entitiesByFile: ReadonlyMap<string, readonly JsTsEntity[]>;
  readonly relationsByFile: ReadonlyMap<string, readonly JsTsRelation[]>;
  readonly diagnosticsByFile: ReadonlyMap<string, readonly JsTsDiagnostic[]>;
  readonly directEdgesByFile: ReadonlyMap<string, readonly string[]>;
  /** Paths (always a subset of `filesToProcess`) whose walk this round found
   * a directly unresolved, locally-looking relative import specifier on. */
  readonly directIncompleteFiles: ReadonlySet<string>;
}

/**
 * Runs the shared pass-1 entity collection, pass-2 relation walk, and per-file
 * compiler diagnostics over exactly `filesToProcess` in an already-built
 * project. `analyzeProject` uses it for the complete source set; incremental
 * sessions use the same authority for only the files that require a fresh
 * walk:
 *
 *  - `entityByNode`/`entityById`/`moduleByPath` MUST already contain entries
 *    for every file OUTSIDE `filesToProcess` that a walked file might
 *    reference (the caller reconstructs these from memo for skipped files --
 *    see `JsTsAnalysisSession`'s doc comment for why that reconstruction is
 *    sound: a memoized entity's `id`/`path`/`start` alone are sufficient to
 *    rebuild the exact same lookup entries `collect` would have produced).
 *  - Only entries for `filesToProcess` are ADDED to those three maps, mirroring
 *    `analyzeProject`'s own two-phase loop (collect every file, THEN walk
 *    every file) restricted to this batch -- collect always completes for
 *    every file in this batch before any of them are walked, exactly like
 *    the original single-pass version.
 *  - `core:covers` relations and dependency closures are NOT computed here
 *    (global, order-independent, cheap -- recomputed once after every merge
 *    by `JsTsAnalysisSession`, never memoized per file).
 *
 * Every record this function produces carries the SAME `id`/`path`/`start`
 * fields `analyzeProject` would have produced for that exact node, so a
 * caller merging fresh output for `filesToProcess` with memoized output for
 * everything else, then globally re-sorting (entities/relations by `id`,
 * diagnostics by `path\0start\0code`), reproduces `analyzeProject`'s exact
 * result -- per-file processing order never affects the final sorted
 * arrays.
 */
function walkFiles(params: {
  readonly project: TypescriptProject;
  readonly virtualRoot: string;
  readonly filesToProcess: readonly AnalyzerFile[];
  readonly entityByNode: Map<string, JsTsEntity>;
  readonly entityById: Map<string, JsTsEntity>;
  readonly moduleByPath: Map<string, JsTsEntity>;
  readonly rust_authoritative_scope?: boolean;
}): JsTsWalkPassOutput {
  const { project, virtualRoot, filesToProcess, entityByNode, entityById, moduleByPath } = params;
  const rustAuthoritativeScope = params.rust_authoritative_scope === true;
  const program = project.program;
  const checker = project.checker;
  const virtualPath = (path: string): string => `${virtualRoot}/${path}`;
  const relativePath = (path: string): string => (path.startsWith(`${virtualRoot}/`) ? path.slice(virtualRoot.length + 1) : path);

  const entitiesByFile = new Map<string, JsTsEntity[]>();
  const relationsByFile = new Map<string, JsTsRelation[]>();
  const diagnosticsByFile = new Map<string, JsTsDiagnostic[]>();
  const directEdgesByFile = new Map<string, Set<string>>();
  const directIncompleteFiles = new Set<string>();

  function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
    const list = map.get(key);
    if (list === undefined) map.set(key, [value]); else list.push(value);
  }

  let exportedDeclarations = new Set<Node>();
  const isExported = (node: Node): boolean => exportedDeclarations.has(node) || (node.parent !== undefined && exportedDeclarations.has(node.parent));
  const nodeKey = (node: Node): string => `${relativePath(node.getSourceFile().fileName)}:${node.getStart(node.getSourceFile())}`;
  const nameOf = (node: Node): string | undefined => {
    // A `ConstructorDeclaration` has no `.name` node at all (`name?: never`
    // in the TS AST) -- synthesize "constructor" as its name, matching the
    // Rust syntax worker's `MethodDefinitionKind::Constructor` identity.
    if (isConstructorDeclaration(node)) return "constructor";
    const value = (node as Node & { readonly name?: Node }).name;
    if (value === undefined) return undefined;
    const candidate = value as Node & { readonly text?: string; readonly escapedText?: string | number };
    if (typeof candidate.text === "string") return candidate.text;
    if (typeof candidate.escapedText === "string" || typeof candidate.escapedText === "number") return String(candidate.escapedText);
    return undefined;
  };
  const typeOf = (node: Node): string | undefined => {
    try {
      const type = checker.getTypeAtLocation(node);
      return type === undefined ? undefined : checker.typeToString(type, node);
    } catch {
      return undefined;
    }
  };
  const addEntity = (node: Node, parent: JsTsEntity | undefined): JsTsEntity | undefined => {
    const name = nameOf(node);
    if (name === undefined || name.length === 0) return undefined;
    const source = node.getSourceFile();
    const path = relativePath(source.fileName);
    const start = node.getStart(source);
    const end = node.getEnd();
    let kind: string;
    let universalKind: string;
    if (isFunctionDeclaration(node)) { kind = "function"; universalKind = "core:callable"; }
    else if (isClassDeclaration(node)) { kind = "class"; universalKind = "core:type"; }
    else if (isInterfaceDeclaration(node)) { kind = "interface"; universalKind = "core:type"; }
    else if (isTypeAliasDeclaration(node)) { kind = "type"; universalKind = "core:type"; }
    else if (isEnumDeclaration(node)) { kind = "enum"; universalKind = "core:type"; }
    else if (isModuleDeclaration(node)) { kind = "namespace"; universalKind = "core:type"; }
    else if (isVariableDeclaration(node)) { kind = "variable"; universalKind = "core:value"; }
    else if (isParameterDeclaration(node)) { kind = "parameter"; universalKind = "core:parameter"; }
    else if (isMethodDeclaration(node) || isMethodSignatureDeclaration(node)) { kind = "method"; universalKind = "core:callable"; }
    else if (isConstructorDeclaration(node)) { kind = "constructor"; universalKind = "core:callable"; }
    else if (isGetAccessorDeclaration(node)) { kind = "getter"; universalKind = "core:callable"; }
    else if (isSetAccessorDeclaration(node)) { kind = "setter"; universalKind = "core:callable"; }
    else if (isPropertyDeclaration(node)) { kind = "property"; universalKind = "core:value"; }
    else return undefined;
    // Identity uses the START OF THE NAME IDENTIFIER, not the declaration's
    // own start -- see the matching comment in `analyzeSyntaxProject`'s own
    // `addEntity` above for the full rationale (Rust parity). The published
    // span (`start`/`end` above/below) stays the full declaration span. A
    // constructor has no name node -- its identity instead anchors on the
    // "constructor" keyword (see `constructorKeywordStart`).
    const nameNode = (node as Node & { readonly name?: Node }).name;
    const identityStart = nameNode !== undefined ? nameNode.getStart(source) : isConstructorDeclaration(node) ? constructorKeywordStart(node, source) : start;
    const id = stableId(kind, path, identityStart, name);
    const existing = entityById.get(id);
    if (existing !== undefined) return existing;
    const inferredType = kind === "parameter" || !isExported(node) ? undefined : typeOf(node);
    const entity: JsTsEntity = { id, name, kind, universal_kind: universalKind, path, start, end, ...(parent === undefined ? {} : { parent_id: parent.id, qualified_name: `${parent.qualified_name ?? parent.name}.${name}` }), ...(inferredType === undefined ? {} : { type: inferredType }) };
    pushTo(entitiesByFile, path, entity);
    entityById.set(id, entity);
    entityByNode.set(nodeKey(node), entity);
    if (!rustAuthoritativeScope && parent !== undefined) pushTo(relationsByFile, path, { id: `${JAVASCRIPT_TYPESCRIPT_NAMESPACE}:contains:${parent.id}:${entity.id}`, kind: "core:contains", source_id: parent.id, target_id: entity.id, path, start, end, classification: "confirmed" });
    return entity;
  };
  const collect = (node: Node, parent: JsTsEntity | undefined): void => {
    const entity = addEntity(node, parent) ?? parent;
    node.forEachChild((child) => collect(child, entity));
  };
  for (const file of filesToProcess) {
    const source = program.getSourceFile(virtualPath(file.path));
    if (source !== undefined) {
      let isTestModule = false;
      source.forEachChild((node) => {
        if (!isImportDeclaration(node)) return;
        const specifier = (node as Node & { readonly moduleSpecifier?: Node }).moduleSpecifier as Node & { readonly text?: string } | undefined;
        if (specifier?.text === "node:test") isTestModule = true;
      });
      const moduleEntity: JsTsEntity = {
        id: stableId("module", file.path, 0, file.path),
        name: file.path,
        kind: "module",
        universal_kind: "core:container",
        path: file.path,
        start: 0,
        end: source.getEnd(),
        ...(isTestModule ? { is_test: true } : {}),
      };
      pushTo(entitiesByFile, file.path, moduleEntity);
      entityById.set(moduleEntity.id, moduleEntity);
      moduleByPath.set(file.path, moduleEntity);
      try {
        const moduleSymbol = checker.getSymbolAtLocation(source);
        exportedDeclarations = new Set(moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol)
          .flatMap((symbol) => symbol.declarations ?? [])
          .map((handle) => handle.resolve(project))
          .filter((resolved): resolved is Node => resolved !== undefined));
      } catch {
        exportedDeclarations = new Set();
      }
      collect(source, moduleEntity);
    }
  }
  const targetForNode = (node: Node | undefined): JsTsEntity | undefined => {
    if (node === undefined) return undefined;
    const direct = entityByNode.get(nodeKey(node));
    if (direct !== undefined) return direct;
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol !== undefined) {
      try {
        const aliased = checker.getAliasedSymbol(symbol);
        if (!checker.isUnknownSymbol(aliased)) symbol = aliased;
      } catch { /* The direct symbol remains authoritative. */ }
    }
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    const resolved = declaration?.resolve(project);
    return resolved === undefined ? undefined : entityByNode.get(nodeKey(resolved));
  };
  const hasResolvedDeclaration = (node: Node | undefined): boolean => {
    if (node === undefined) return false;
    if (entityByNode.get(nodeKey(node)) !== undefined) return true;
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol !== undefined) {
      try {
        const aliased = checker.getAliasedSymbol(symbol);
        if (!checker.isUnknownSymbol(aliased)) symbol = aliased;
      } catch { /* The direct symbol remains authoritative. */ }
    }
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    return declaration?.resolve(project) !== undefined;
  };
  const ownerAt = (node: Node): JsTsEntity | undefined => {
    let current: Node | undefined = node.parent;
    while (current !== undefined) {
      const found = entityByNode.get(nodeKey(current));
      if (found?.universal_kind === "core:callable") return found;
      current = current.parent;
    }
    return undefined;
  };
  const moduleTarget = (node: Node): JsTsEntity | undefined => {
    try {
      const symbol = checker.getSymbolAtLocation(node);
      for (const declaration of symbol?.declarations ?? []) {
        const resolvedDeclaration = declaration.resolve(project);
        if (resolvedDeclaration === undefined) continue;
        const targetPath = relativePath(resolvedDeclaration.getSourceFile().fileName);
        const target = moduleByPath.get(targetPath);
        if (target !== undefined) return target;
      }
    } catch { /* Preserve the unresolved module relation below. */ }
    const specifier = (node as Node & { readonly text?: string }).text;
    if (typeof specifier !== "string" || !specifier.startsWith(".")) return undefined;
    const sourceParts = relativePath(node.getSourceFile().fileName).split("/");
    sourceParts.pop();
    for (const part of specifier.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") sourceParts.pop();
      else sourceParts.push(part);
    }
    const base = sourceParts.join("/");
    for (const candidate of [base, ...[...JAVASCRIPT_EXTENSIONS, ...TYPESCRIPT_EXTENSIONS].map((extension) => `${base}${extension}`), ...[...JAVASCRIPT_EXTENSIONS, ...TYPESCRIPT_EXTENSIONS].map((extension) => `${base}/index${extension}`)]) {
      const target = moduleByPath.get(candidate);
      if (target !== undefined) return target;
    }
    return undefined;
  };
  const relate = (kind: string, source: JsTsEntity, target: JsTsEntity | undefined, node: Node, classification: "confirmed" | "possible"): void => {
    const path = relativePath(node.getSourceFile().fileName);
    const start = node.getStart(node.getSourceFile());
    const end = node.getEnd();
    pushTo(relationsByFile, path, { id: `${JAVASCRIPT_TYPESCRIPT_NAMESPACE}:${kind}:${path}:${start}:${end}:${source.id}:${target?.id ?? "unresolved"}`, kind: `core:${kind}`, source_id: source.id, ...(target === undefined ? {} : { target_id: target.id }), path, start, end, classification });
    if (!rustAuthoritativeScope && target !== undefined && target.path !== path) {
      const edges = directEdgesByFile.get(path) ?? new Set<string>();
      edges.add(target.path);
      directEdgesByFile.set(path, edges);
    }
  };
  const walk = (node: Node): void => {
    if (!rustAuthoritativeScope && (isImportDeclaration(node) || isExportDeclaration(node))) {
      const specifier = (node as Node & { readonly moduleSpecifier?: Node }).moduleSpecifier;
      if (specifier !== undefined) {
        const sourceModule = moduleByPath.get(relativePath(node.getSourceFile().fileName));
        const targetModule = moduleTarget(specifier);
        if (sourceModule !== undefined) {
          relate(isImportDeclaration(node) ? "import" : "export", sourceModule, targetModule, node, targetModule === undefined ? "possible" : "confirmed");
          if (targetModule === undefined) {
            // Same asset-specifier exemption as `analyzeProject`'s own walk
            // (see the comment there) -- the two MUST stay in lockstep or the
            // differential tests fail.
            const specifierText = (specifier as Node & { readonly text?: string }).text;
            if (typeof specifierText === "string" && specifierText.startsWith(".") && !relativeAssetSpecifier(specifierText)) directIncompleteFiles.add(sourceModule.path);
          }
        }
      }
    }
    const owner = ownerAt(node);
    if (isIdentifier(node)) {
      const parent = node.parent;
      const declared = parent === undefined ? undefined : entityByNode.get(nodeKey(parent));
      const parentName = parent === undefined ? undefined : (parent as Node & { readonly name?: Node }).name;
      const isDeclarationName = declared !== undefined && parentName !== undefined && parentName.getStart(parentName.getSourceFile()) === node.getStart(node.getSourceFile()) && parentName.getEnd() === node.getEnd();
      if (!isDeclarationName) {
        const source = owner ?? moduleByPath.get(relativePath(node.getSourceFile().fileName));
        const target = targetForNode(node);
        if (source !== undefined && target !== undefined && source.id !== target.id) relate("references", source, target, node, "confirmed");
      }
    }
    if (isCallExpression(node)) {
      // Same module-entity fallback as `analyzeProject`'s own walk, and for
      // the same reason the sibling `core:references` handling above
      // already falls back to `moduleByPath` -- see that walk's doc
      // comment (Bug Group 4.1). The two walks MUST stay in lockstep or the
      // differential tests fail.
      const callOwner = owner ?? moduleByPath.get(relativePath(node.getSourceFile().fileName));
      if (callOwner !== undefined) {
        let target: JsTsEntity | undefined;
        let declarationResolved = false;
        try {
          const signature = checker.getResolvedSignature(node);
          const declaration = signature?.declaration?.resolve(project);
          declarationResolved = declaration !== undefined;
          target = declaration === undefined ? undefined : entityByNode.get(nodeKey(declaration));
          if (target === undefined) {
            const expression = (node as Node & { readonly expression?: Node }).expression;
            target = targetForNode(expression);
            if (target === undefined && !declarationResolved) declarationResolved = hasResolvedDeclaration(expression);
          }
        } catch { target = undefined; }
        relate("call", callOwner, target, node, target === undefined ? "possible" : "confirmed");
        if (target === undefined && !declarationResolved) pushTo(diagnosticsByFile, relativePath(node.getSourceFile().fileName), { code: "jsts:unresolved_call", message: "The TypeScript checker could not establish a unique call target.", path: relativePath(node.getSourceFile().fileName), start: node.getStart(node.getSourceFile()), end: node.getEnd() });
      }
    }
    if (isHeritageClause(node)) {
      const ownerEntity = entityByNode.get(nodeKey(node.parent));
      if (ownerEntity !== undefined) for (const type of (node as Node & { readonly types?: readonly Node[] }).types ?? []) {
        const target = targetForNode((type as Node & { readonly expression?: Node }).expression);
        const clauseText = node.getText(node.getSourceFile()).trimStart();
        relate(clauseText.startsWith("implements") ? "implements" : "inherits", ownerEntity, target, type, target === undefined ? "possible" : "confirmed");
      }
    }
    node.forEachChild(walk);
  };
  for (const file of filesToProcess) {
    const source = program.getSourceFile(virtualPath(file.path));
    if (source !== undefined) walk(source);
    if (/\b(?:eval|Function)\s*\(/u.test(file.text)) pushTo(diagnosticsByFile, file.path, { code: "jsts:dynamic_runtime_code", message: "Runtime code generation is not statically resolvable.", path: file.path });
  }
  const diagnosticText = (message: unknown): string => typeof message === "string" ? message : message !== null && typeof message === "object" && "text" in message ? diagnosticText((message as { text: unknown }).text) : String(message);
  for (const file of filesToProcess) {
    const target = virtualPath(file.path);
    for (const diagnostic of [...program.getSyntacticDiagnostics(target), ...program.getBindDiagnostics(target), ...program.getSemanticDiagnostics(target)]) {
      if (diagnostic.fileName === undefined) continue;
      const diagnosticPath = relativePath(diagnostic.fileName);
      // Per-file diagnostic calls should only ever report on the queried
      // file itself; this filter is a defensive no-op that also guards
      // against any diagnostic misattribution ever silently corrupting
      // ANOTHER file's memo entry.
      if (diagnosticPath !== file.path) continue;
      pushTo(diagnosticsByFile, diagnosticPath, { code: "jsts:compiler_diagnostic", compiler_code: diagnostic.code, message: diagnosticText(diagnostic.text), path: diagnosticPath, start: diagnostic.pos, end: diagnostic.end });
    }
  }
  return {
    entitiesByFile,
    relationsByFile,
    diagnosticsByFile,
    directEdgesByFile: new Map([...directEdgesByFile].map(([path, edges]) => [path, [...edges].sort()])),
    directIncompleteFiles,
  };
}

/**
 * Checker-only owner walk used after the Rust worker has become authoritative
 * for syntax facts and the dependency graph. It deliberately does not collect
 * contains/import/export relations, dependency edges, or a corpus-sized entity
 * table. Stable entity identities needed by checker relations are derived on
 * demand from the resolved declaration nodes; exported owner declarations are
 * retained only when their inferred type is required by structural stage 3.
 */
type RustSemanticDeclarationShape = { readonly kind: string; readonly universalKind: string };

function rustSemanticDeclarationShape(node: Node): RustSemanticDeclarationShape | undefined {
  if (isFunctionDeclaration(node)) return { kind: "function", universalKind: "core:callable" };
  if (isClassDeclaration(node)) return { kind: "class", universalKind: "core:type" };
  if (isInterfaceDeclaration(node)) return { kind: "interface", universalKind: "core:type" };
  if (isTypeAliasDeclaration(node)) return { kind: "type", universalKind: "core:type" };
  if (isEnumDeclaration(node)) return { kind: "enum", universalKind: "core:type" };
  if (isModuleDeclaration(node)) return { kind: "namespace", universalKind: "core:type" };
  if (isVariableDeclaration(node)) return { kind: "variable", universalKind: "core:value" };
  if (isParameterDeclaration(node)) return { kind: "parameter", universalKind: "core:parameter" };
  if (isMethodDeclaration(node) || isMethodSignatureDeclaration(node)) return { kind: "method", universalKind: "core:callable" };
  if (isConstructorDeclaration(node)) return { kind: "constructor", universalKind: "core:callable" };
  if (isGetAccessorDeclaration(node)) return { kind: "getter", universalKind: "core:callable" };
  if (isSetAccessorDeclaration(node)) return { kind: "setter", universalKind: "core:callable" };
  if (isPropertyDeclaration(node)) return { kind: "property", universalKind: "core:value" };
  return undefined;
}

/**
 * One `checker_pending` semantic site from Rust's E1a walk
 * (`crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`'s
 * `SemanticSite`), JSON-encoded over the wire under
 * `rust_hybrid_pending_sites`. Only the fields the localized descent below
 * actually consumes are typed here; `disposition` (always `"checker_pending"`
 * -- Rust already filtered to just these) and `reason` ride along on the
 * wire but drive no branching on the TypeScript side: every pending
 * `identifier_ref` site (whatever its reason -- member access, `this`, an
 * import binding, ...) resolves through the exact same generic
 * `isIdentifier` handling in `walkRustSemanticOwner`'s `visit`.
 */
export interface RustHybridPendingSite {
  readonly start_utf16: number;
  readonly end_utf16: number;
  readonly site_kind: "identifier_ref" | "call" | "heritage" | "typed_decl";
}

/**
 * E1c cutover (design doc E1, step 1 of the handoff): locates the AST node a
 * Rust-reported pending site's span `[start, end)` refers to by descending
 * via `forEachChild`, following the single child whose own span fully
 * CONTAINS the target -- O(depth) per site, never a subtree scan. Descent
 * stops at the innermost node with no such child.
 *
 * Containment, not exact span equality, is deliberate: it is what makes this
 * robust to the (harmless) span-convention differences between oxc and the
 * checker's own AST -- e.g. `export function foo() {}`'s TypeScript node
 * starts at "export" while oxc's (wrapped separately in an
 * `ExportNamedDeclaration`) starts at "function"; a parameterized heritage
 * type's TypeScript `ExpressionWithTypeArguments` span covers `Base<T>`
 * while oxc's `Heritage` site span covers only `Base`. In both cases the
 * narrower Rust span still sits fully inside the correct checker node, so
 * containment descent still lands on it, then (with no child narrower still
 * containing the target) correctly stops there.
 *
 * `cursor` carries the previous call's descent path (root-to-leaf,
 * `cursor[0]` always the file root). Rust's `pending_sites` arrive sorted by
 * `start` (`SemanticWalker::finish`'s own sort), so consecutive sites are
 * almost always siblings or near-siblings sharing a long common ancestor
 * chain (every site inside the same function, say) -- rewind the cursor only
 * up to the deepest frame that still contains the new target instead of
 * restarting from the root every time, then descend from there. Mutates
 * `cursor` in place (push/pop) so the caller's array IS the next call's
 * starting point; the returned node is always `cursor`'s new last entry.
 */
function descendToPendingSiteSpan(cursor: Node[], source: TypescriptSourceFile, start: number, end: number): Node {
  while (cursor.length > 1) {
    const frame = cursor[cursor.length - 1]!;
    if (frame.getStart(source) <= start && end <= frame.getEnd()) break;
    cursor.pop();
  }
  for (;;) {
    const current = cursor[cursor.length - 1]!;
    let next: Node | undefined;
    current.forEachChild((child) => {
      if (next !== undefined) return;
      if (child.getStart(source) <= start && end <= child.getEnd()) next = child;
    });
    if (next === undefined) return current;
    cursor.push(next);
  }
}

/**
 * A `heritage` site's span is the individual extended/implemented type's own
 * expression span (matching oxc's per-type-entry span), but the checker's
 * existing heritage-relation logic (`walkRustSemanticOwner`'s `visit`,
 * `isHeritageClause` branch) operates on the WHOLE `HeritageClause` node --
 * it loops over every type entry itself in one call. Walk up to that
 * ancestor so several sites from one multi-type clause (`implements A, B`)
 * resolve to, and dedupe onto, the very same node instead of re-running that
 * loop (and re-emitting every one of its relations) once per listed type.
 */
function nearestHeritageClause(node: Node): Node {
  let current: Node | undefined = node;
  while (current !== undefined && !isHeritageClause(current)) current = current.parent;
  return current ?? node;
}

interface OwnerPendingSiteResolution {
  readonly nodes: readonly Node[];
  readonly identifierNodes: readonly Node[];
  readonly declarationNodes: readonly Node[];
}

/**
 * E1c cutover: replaces the full-file `collectAll` preorder walk with the
 * localized, site-driven descent the design calls for (`nodes` below is
 * exactly what used to be `collectAll`'s flat node list, just bounded to the
 * sites Rust actually listed instead of every node in the file). Each
 * pending site resolves to exactly one AST node, deduped by identity -- a
 * multi-type heritage clause is the one case several sites legitimately
 * share a node (see `nearestHeritageClause`); without the dedup, a shared
 * node would be independently `visit()`-ed once per site that maps to it,
 * re-emitting its relations that many times over.
 *
 * `identifierNodes` additionally, opportunistically, includes a resolved
 * call's own callee identifier (mirroring `directCallDeclaration`'s own
 * extraction in `walkRustSemanticOwner`) purely so its symbol lookup stays
 * in the SAME batched `getSymbolAtLocation` call this function's caller
 * makes, instead of falling back to `getResolvedSignature`'s live,
 * per-call checker round trip. It is deliberately NOT added to `nodes`: it
 * must never be independently `visit()`-ed on its own account -- when Rust
 * resolved that identifier itself, it carries no pending site of its own
 * (E1a already published its `core:references` row), and reprocessing it
 * here would double-emit that same row.
 */
function resolveOwnerPendingSites(source: TypescriptSourceFile, pendingSites: readonly RustHybridPendingSite[]): OwnerPendingSiteResolution {
  const seen = new Set<Node>();
  const seenIdentifiers = new Set<Node>();
  const nodes: Node[] = [];
  const identifierNodes: Node[] = [];
  const declarationNodes: Node[] = [];
  // Shared, mutated in place by `descendToPendingSiteSpan` across the whole
  // (start-sorted) site list -- see that function's doc comment.
  const cursor: Node[] = [source];
  for (const site of pendingSites) {
    const descended = descendToPendingSiteSpan(cursor, source, site.start_utf16, site.end_utf16);
    const located = site.site_kind === "heritage" ? nearestHeritageClause(descended) : descended;
    if (seen.has(located)) continue;
    seen.add(located);
    nodes.push(located);
    if (isIdentifier(located) && !seenIdentifiers.has(located)) {
      seenIdentifiers.add(located);
      identifierNodes.push(located);
    }
    if (rustSemanticDeclarationShape(located) !== undefined) declarationNodes.push(located);
    if (isCallExpression(located)) {
      const callee = (located as Node & { readonly expression?: Node }).expression;
      if (callee !== undefined && isIdentifier(callee) && !seenIdentifiers.has(callee)) {
        seenIdentifiers.add(callee);
        identifierNodes.push(callee);
      }
    }
  }
  return { nodes, identifierNodes, declarationNodes };
}

interface RustSemanticGroupLookups {
  readonly symbol_by_node: ReadonlyMap<Node, TypescriptSymbol | undefined>;
  readonly inferred_type_by_node: ReadonlyMap<Node, string>;
  readonly exported_declarations: ReadonlySet<Node>;
  /** Preorder AST nodes collected while preparing the bounded owner group.
   * The semantic walk consumes this immutable list instead of recursively
   * traversing the same tree a second time just after bulk checker lookups. */
  readonly nodes_by_owner: ReadonlyMap<string, readonly Node[]>;
  /** Owners with no semantic candidates can bypass checker symbol/type calls.
   * Their compiler diagnostics are still attached by the owner walk. */
  readonly semantic_owner_has_nodes: ReadonlyMap<string, boolean>;
  /** Dynamic-runtime diagnostics are decided from the same source text pass
   * used for export gating; do not materialize that text a second time while
   * walking the owner after checker lookups. */
  readonly dynamic_runtime_code_by_owner: ReadonlyMap<string, boolean>;
}

function walkRustSemanticOwner(params: {
  readonly project: TypescriptProject;
  readonly virtualRoot: string;
  readonly files: readonly AnalyzerFile[];
  readonly owner: AnalyzerFile;
  readonly languageRootNames: readonly string[];
  readonly compilerDiagnostics?: readonly JsTsDiagnostic[];
  readonly groupLookups?: RustSemanticGroupLookups;
  /** Resolution caches shared by all owners in one prepared checker snapshot. */
  readonly resolvedBySymbol?: WeakMap<object, Node | undefined>;
  readonly resolvedByDeclaration?: WeakMap<Node, Node | undefined>;
  /** Stage 2 does not publish inferred-type rows; skip checker type queries
   * there and only enable them for the cumulative stage-3 projection. */
  readonly includeInferredTypes?: boolean;
  /** E1c cutover: this owner's `rust_hybrid_pending_sites`, when the caller
   * is walking it ungrouped (`groupLookups === undefined`). A grouped walk
   * gets its localized node list from `groupLookups.nodes_by_owner`
   * instead -- `beginRustSemanticOwnerGroup` already resolved every
   * owner's sites up front, this owner's included. */
  readonly pendingSites?: readonly RustHybridPendingSite[];
}): JsTsAnalysisResult {
  const { project, virtualRoot, files, owner, languageRootNames, compilerDiagnostics, groupLookups, includeInferredTypes = true } = params;
  const program = project.program;
  const checker = project.checker;
  const virtualPath = (path: string): string => `${virtualRoot}/${path}`;
  const relativePath = (path: string): string => path.startsWith(`${virtualRoot}/`) ? path.slice(virtualRoot.length + 1) : path;
  const source = program.getSourceFile(virtualPath(owner.path));
  if (source === undefined) throw new Error(`TypeScript did not retain the Rust-scoped owner ${owner.path}.`);

  // Empty/comment-only modules have no semantic rows to produce. The syntax
  // walk performed while opening the bounded group records this fact, so do
  // not pay for checker symbol/type calls merely to rediscover an empty
  // result. Diagnostics remain authoritative and are returned unchanged.
  if (groupLookups?.semantic_owner_has_nodes.get(owner.path) === false) {
    return {
      language: languageForPath(owner.path) ?? "typescript",
      entities: [],
      relations: [],
      diagnostics: compilerDiagnostics === undefined ? [] : [...compilerDiagnostics],
      complete: true,
      dependency_closures: {},
    };
  }

  const entitiesById = new Map<string, JsTsEntity>();
  const entitiesByNode = new Map<string, JsTsEntity>();
  const relations: JsTsRelation[] = [];
  const diagnostics: JsTsDiagnostic[] = [];
  const identifierNodes: Node[] = [];
  const declarationNodes: Node[] = [];
  const nodeKey = (node: Node): string => `${relativePath(node.getSourceFile().fileName)}:${node.getStart(node.getSourceFile())}`;
  // The checker returns the same AST node instance for repeated references in
  // a walk. Keep object-identity fast paths for the hot semantic traversal,
  // while retaining the stable path/start map below for declaration nodes
  // materialized by distinct checker wrappers.
  const entityByNodeObject = new WeakMap<Node, JsTsEntity>();
  const ownerByNodeObject = new WeakMap<Node, JsTsEntity>();
  const resolvedByNodeObject = new WeakMap<Node, Node | undefined>();
  const resolvedBySymbol = params.resolvedBySymbol ?? new WeakMap<object, Node | undefined>();
  const resolvedByDeclaration = params.resolvedByDeclaration ?? new WeakMap<Node, Node | undefined>();
  const nameOf = (node: Node): string | undefined => {
    // A `ConstructorDeclaration` has no `.name` node at all (`name?: never`
    // in the TS AST) -- synthesize "constructor" as its name, matching the
    // Rust syntax worker's `MethodDefinitionKind::Constructor` identity.
    if (isConstructorDeclaration(node)) return "constructor";
    const value = (node as Node & { readonly name?: Node }).name;
    if (value === undefined) return undefined;
    const candidate = value as Node & { readonly text?: string; readonly escapedText?: string | number };
    if (typeof candidate.text === "string") return candidate.text;
    if (typeof candidate.escapedText === "string" || typeof candidate.escapedText === "number") return String(candidate.escapedText);
    return undefined;
  };
  const kindOf = rustSemanticDeclarationShape;
  const moduleEntity = (file: TypescriptSourceFile): JsTsEntity => {
    const path = relativePath(file.fileName);
    const moduleId = stableId("module", path, 0, path);
    const existing = entitiesById.get(moduleId);
    if (existing !== undefined) return existing;
    let isTestModule = false;
    file.forEachChild((node) => {
      if (!isImportDeclaration(node)) return;
      const specifier = (node as Node & { readonly moduleSpecifier?: Node }).moduleSpecifier as Node & { readonly text?: string } | undefined;
      if (specifier?.text === "node:test") isTestModule = true;
    });
    const entity: JsTsEntity = { id: moduleId, name: path, kind: "module", universal_kind: "core:container", path, start: 0, end: file.getEnd(), ...(isTestModule ? { is_test: true } : {}) };
    entitiesById.set(entity.id, entity);
    return entity;
  };
  const exportedDeclarations = groupLookups?.exported_declarations ?? new Set<Node>();
  if (groupLookups === undefined) try {
      const moduleSymbol = checker.getSymbolAtLocation(source);
      for (const declaration of checker.getExportsOfModule(moduleSymbol!).flatMap((symbol) => symbol.declarations ?? [])) {
        const resolved = declaration.resolve(project);
        if (resolved !== undefined) (exportedDeclarations as Set<Node>).add(resolved);
      }
    } catch { /* A script without a module symbol simply has no exported type facts. */ }
  const isExported = (node: Node): boolean => exportedDeclarations.has(node) || (node.parent !== undefined && exportedDeclarations.has(node.parent));
  const collectLookupNodes = (node: Node): void => {
    if (isIdentifier(node)) identifierNodes.push(node);
    if (kindOf(node) !== undefined) declarationNodes.push(node);
    node.forEachChild(collectLookupNodes);
  };
  // E1c cutover: an ungrouped walk (no `groupLookups`) with pending sites on
  // hand resolves them the same way `beginRustSemanticOwnerGroup` does for a
  // grouped one, instead of `collectLookupNodes`'s full-file traversal.
  const localizedSites = groupLookups === undefined && params.pendingSites !== undefined
    ? resolveOwnerPendingSites(source, params.pendingSites)
    : undefined;
  const symbolByNode = groupLookups?.symbol_by_node ?? new Map<Node, TypescriptSymbol | undefined>();
  const inferredTypeByNode = groupLookups?.inferred_type_by_node ?? new Map<Node, string>();
  if (groupLookups === undefined) {
    if (localizedSites !== undefined) {
      identifierNodes.push(...localizedSites.identifierNodes);
      declarationNodes.push(...localizedSites.declarationNodes);
    } else {
      collectLookupNodes(source);
    }
    const symbols = checker.getSymbolAtLocation(identifierNodes);
    for (let index = 0; index < identifierNodes.length; index += 1) (symbolByNode as Map<Node, TypescriptSymbol | undefined>).set(identifierNodes[index]!, symbols[index]);
    const typedDeclarations = declarationNodes.filter((node) => {
      const shape = kindOf(node);
      return shape !== undefined && shape.kind !== "parameter" && isExported(node);
    });
    const types = checker.getTypeAtLocation(typedDeclarations);
    for (let index = 0; index < typedDeclarations.length; index += 1) {
      const type = types[index];
      if (type === undefined) continue;
      try { (inferredTypeByNode as Map<Node, string>).set(typedDeclarations[index]!, checker.typeToString(type, typedDeclarations[index])); }
      catch { /* An unavailable type remains absent, matching the legacy walk. */ }
    }
  }
  // Deliberately no per-call "should this compute an inferred type" toggle:
  // `includeInferredTypes` is a single, walk-wide constant (never varies by
  // caller intent within one owner), and `entityForDeclaration` caches by
  // `nodeKey`/object identity on FIRST TOUCH regardless of which caller
  // reaches a given declaration node first -- `ownerAt`, a reference's own
  // target resolution, and a heritage clause's source/target all reach
  // arbitrary declaration nodes as a SIDE EFFECT of walking something else
  // entirely, not just the node's own dedicated `visit()` call. A caller-
  // supplied `inferOwnerType` that defaulted to `false` (all but the
  // primary `visit()` call site) used to let one of those incidental
  // reaches "win" the cache with no type, permanently starving the
  // declaration's OWN later, correct, `include­InferredTypes`-aware visit --
  // latent even in the legacy full-file walk (order there just happens to
  // make it rare: a hoisted forward reference can trigger it too), but
  // routine under the cutover's span-order-sorted site processing, which
  // does not preserve "declaration before its own decorators" the way AST
  // pre-order recursion does (oxc's declaration span excludes decorators
  // entirely, so a `@Dec` identifier's own site can sort before its
  // annotated declaration's). Reading `includeInferredTypes` directly here
  // is free (the checker round trip already happened once, up front, for
  // every `typedDeclarations` entry; this is just a map lookup) and makes
  // the outcome independent of visit order, for every caller, always.
  const entityForDeclaration = (node: Node): JsTsEntity | undefined => {
    const objectCached = entityByNodeObject.get(node);
    if (objectCached !== undefined) return objectCached;
    const cached = entitiesByNode.get(nodeKey(node));
    if (cached !== undefined) {
      entityByNodeObject.set(node, cached);
      return cached;
    }
    const shape = kindOf(node);
    const name = nameOf(node);
    if (shape === undefined || name === undefined || name.length === 0) return undefined;
    const file = node.getSourceFile();
    const path = relativePath(file.fileName);
    const start = node.getStart(file);
    let parentNode = node.parent;
    let parent: JsTsEntity | undefined;
    while (parentNode !== undefined && parentNode !== file) {
      if (kindOf(parentNode) !== undefined && nameOf(parentNode) !== undefined) {
        parent = entityForDeclaration(parentNode);
        break;
      }
      parentNode = parentNode.parent;
    }
    parent ??= moduleEntity(file);
    const inferredType = includeInferredTypes && path === owner.path ? inferredTypeByNode.get(node) : undefined;
    // Identity uses the START OF THE NAME IDENTIFIER, not the declaration's
    // own start -- see the matching comment in `analyzeSyntaxProject`'s own
    // `addEntity` for the full rationale (Rust parity). The published span
    // (`start`/`end` below) stays the full declaration span. A constructor
    // has no name node -- its identity instead anchors on the "constructor"
    // keyword (see `constructorKeywordStart`).
    const nameNode = (node as Node & { readonly name?: Node }).name;
    const identityStart = nameNode !== undefined ? nameNode.getStart(file) : isConstructorDeclaration(node) ? constructorKeywordStart(node, file) : start;
    const entity: JsTsEntity = {
      id: stableId(shape.kind, path, identityStart, name), name, kind: shape.kind, universal_kind: shape.universalKind,
      path, start, end: node.getEnd(), parent_id: parent.id, qualified_name: `${parent.qualified_name ?? parent.name}.${name}`,
      ...(inferredType === undefined ? {} : { type: inferredType }),
    };
    entitiesByNode.set(nodeKey(node), entity);
    entityByNodeObject.set(node, entity);
    entitiesById.set(entity.id, entity);
    return entity;
  };
  const resolvedDeclaration = (node: Node | undefined): Node | undefined => {
    if (node === undefined) return undefined;
    if (resolvedByNodeObject.has(node)) return resolvedByNodeObject.get(node);
    let symbol = symbolByNode.has(node) ? symbolByNode.get(node) : checker.getSymbolAtLocation(node);
    if (symbol !== undefined && resolvedBySymbol.has(symbol)) {
      const cached = resolvedBySymbol.get(symbol);
      resolvedByNodeObject.set(node, cached);
      return cached;
    }
    const originalSymbol = symbol;
    if (symbol !== undefined && (symbol.flags & SymbolFlags.Alias) !== 0) {
      try {
        const aliased = checker.getAliasedSymbol(symbol);
        if (!checker.isUnknownSymbol(aliased)) symbol = aliased;
      } catch { /* The direct symbol remains authoritative. */ }
    }
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    const declarationNode = declaration as unknown as Node | undefined;
    const resolved = declarationNode === undefined ? undefined : resolvedByDeclaration.has(declarationNode)
      ? resolvedByDeclaration.get(declarationNode)
      : (declaration as { resolve: (project?: TypescriptProject) => unknown }).resolve(project) as Node | undefined;
    if (declarationNode !== undefined && !resolvedByDeclaration.has(declarationNode)) resolvedByDeclaration.set(declarationNode, resolved);
    if (symbol !== undefined) resolvedBySymbol.set(symbol, resolved);
    if (originalSymbol !== undefined && originalSymbol !== symbol) resolvedBySymbol.set(originalSymbol, resolved);
    resolvedByNodeObject.set(node, resolved);
    return resolved;
  };
  /**
   * A direct, non-aliased identifier with exactly one declaration has no
   * overload or contextual-signature choice for the checker to make. Its
   * resolved call target is therefore the declaration itself. Aliases,
   * overload sets and property/element access still require
   * getResolvedSignature because contextual resolution can change the visible
   * relation target.
   */
  const directCallDeclaration = (node: Node): Node | undefined => {
    const expression = (node as Node & { readonly expression?: Node }).expression;
    if (expression === undefined || !isIdentifier(expression)) return undefined;
    const symbol = symbolByNode.get(expression);
    if (symbol === undefined || (symbol.flags & SymbolFlags.Alias) !== 0 || symbol.declarations.length !== 1) return undefined;
    const handle = symbol.valueDeclaration ?? symbol.declarations[0];
    if (handle === undefined) return undefined;
    const declarationKey = handle as unknown as Node;
    if (resolvedByDeclaration.has(declarationKey)) return resolvedByDeclaration.get(declarationKey);
    const declaration = handle.resolve(project);
    resolvedByDeclaration.set(declarationKey, declaration);
    return declaration;
  };
  const ownerAt = (node: Node): JsTsEntity => {
    const cached = ownerByNodeObject.get(node);
    if (cached !== undefined) return cached;
    let current: Node | undefined = node.parent;
    while (current !== undefined) {
      const candidate = entityForDeclaration(current);
      if (candidate?.universal_kind === "core:callable") {
        ownerByNodeObject.set(node, candidate);
        return candidate;
      }
      current = current.parent;
    }
    const module = moduleEntity(node.getSourceFile());
    ownerByNodeObject.set(node, module);
    return module;
  };
  const relate = (kind: string, relationSource: JsTsEntity, target: JsTsEntity | undefined, node: Node, classification: "confirmed" | "possible"): void => {
    const path = relativePath(node.getSourceFile().fileName);
    const start = node.getStart(node.getSourceFile());
    const end = node.getEnd();
    relations.push({ id: `${JAVASCRIPT_TYPESCRIPT_NAMESPACE}:${kind}:${path}:${start}:${end}:${relationSource.id}:${target?.id ?? "unresolved"}`, kind: `core:${kind}`, source_id: relationSource.id, ...(target === undefined ? {} : { target_id: target.id }), path, start, end, classification });
  };
  const visit = (node: Node, recurse = true): void => {
    // Only owner declarations whose checker-derived type can become a stage-3
    // record are retained. Rust remains the sole producer of their structural
    // declaration records.
    if (kindOf(node) !== undefined) entityForDeclaration(node);
    if (isIdentifier(node)) {
      const parent = node.parent;
      const parentName = parent === undefined ? undefined : (parent as Node & { readonly name?: Node }).name;
      const isDeclarationName = parent !== undefined && kindOf(parent) !== undefined && parentName !== undefined
        && parentName.getStart(parentName.getSourceFile()) === node.getStart(node.getSourceFile()) && parentName.getEnd() === node.getEnd();
      if (!isDeclarationName) {
        const relationSource = ownerAt(node);
        const targetDeclaration = resolvedDeclaration(node);
        const target = targetDeclaration === undefined ? undefined : entityForDeclaration(targetDeclaration);
        if (target !== undefined && relationSource.id !== target.id) relate("references", relationSource, target, node, "confirmed");
      }
    }
    if (isCallExpression(node)) {
      const relationSource = ownerAt(node);
      let target: JsTsEntity | undefined;
      let declarationWasResolved = false;
      try {
        // `directCallDeclaration` already returns a FULLY RESOLVED node (its
        // own `handle.resolve(project)` call), unlike
        // `checker.getResolvedSignature(node)?.declaration`, which is still a
        // raw checker declaration that this walk must `.resolve()` itself.
        // Re-applying `.resolve()` to the already-resolved direct result
        // would throw (`resolve` is not a function on a resolved `Node`), so
        // the two sources are kept on their own branches instead of being
        // funneled through one shared "needs resolving" cache lookup.
        const directDeclaration = directCallDeclaration(node);
        const declaration = directDeclaration !== undefined ? directDeclaration : (() => {
          const signatureDeclaration = checker.getResolvedSignature(node)?.declaration;
          const signatureNode = signatureDeclaration as unknown as Node | undefined;
          const resolved = signatureNode === undefined ? undefined : resolvedByDeclaration.has(signatureNode)
            ? resolvedByDeclaration.get(signatureNode)
            : (signatureDeclaration as unknown as { resolve: (project?: TypescriptProject) => unknown }).resolve(project) as Node | undefined;
          if (signatureNode !== undefined && !resolvedByDeclaration.has(signatureNode)) resolvedByDeclaration.set(signatureNode, resolved);
          return resolved;
        })();
        declarationWasResolved = declaration !== undefined;
        target = declaration === undefined ? undefined : entityForDeclaration(declaration);
        if (target === undefined) {
          const expression = (node as Node & { readonly expression?: Node }).expression;
          const fallback = resolvedDeclaration(expression);
          declarationWasResolved ||= fallback !== undefined;
          target = fallback === undefined ? undefined : entityForDeclaration(fallback);
        }
      } catch { target = undefined; }
      relate("call", relationSource, target, node, target === undefined ? "possible" : "confirmed");
      if (target === undefined && !declarationWasResolved) diagnostics.push({ code: "jsts:unresolved_call", message: "The TypeScript checker could not establish a unique call target.", path: owner.path, start: node.getStart(node.getSourceFile()), end: node.getEnd() });
    }
    if (isHeritageClause(node)) {
      const relationSource = entityForDeclaration(node.parent);
      if (relationSource !== undefined) for (const type of (node as Node & { readonly types?: readonly Node[] }).types ?? []) {
        const declaration = resolvedDeclaration((type as Node & { readonly expression?: Node }).expression);
        const target = declaration === undefined ? undefined : entityForDeclaration(declaration);
        const clauseText = node.getText(node.getSourceFile()).trimStart();
        relate(clauseText.startsWith("implements") ? "implements" : "inherits", relationSource, target, type, target === undefined ? "possible" : "confirmed");
      }
    }
    if (recurse) node.forEachChild((child) => visit(child));
  };
  const preparedNodes = groupLookups?.nodes_by_owner.get(owner.path) ?? localizedSites?.nodes;
  if (preparedNodes === undefined) visit(source);
  else for (const node of preparedNodes) visit(node, false);
  const dynamicRuntimeCode = groupLookups === undefined
    ? /\b(?:eval|Function)\s*\(/u.test(source.getText())
    : groupLookups.dynamic_runtime_code_by_owner.get(owner.path) === true;
  if (dynamicRuntimeCode) diagnostics.push({ code: "jsts:dynamic_runtime_code", message: "Runtime code generation is not statically resolvable.", path: owner.path });
  if (compilerDiagnostics === undefined) {
    const diagnosticText = (message: unknown): string => typeof message === "string" ? message : message !== null && typeof message === "object" && "text" in message ? diagnosticText((message as { text: unknown }).text) : String(message);
    for (const diagnostic of [...program.getSyntacticDiagnostics(virtualPath(owner.path)), ...program.getBindDiagnostics(virtualPath(owner.path)), ...program.getSemanticDiagnostics(virtualPath(owner.path))]) {
      if (diagnostic.fileName === undefined || relativePath(diagnostic.fileName) !== owner.path) continue;
      diagnostics.push({ code: "jsts:compiler_diagnostic", compiler_code: diagnostic.code, message: diagnosticText(diagnostic.text), path: owner.path, start: diagnostic.pos, end: diagnostic.end });
    }
  } else {
    diagnostics.push(...compilerDiagnostics);
  }
  // Build per-file entity buckets linearly. Replacing a bucket with a spread
  // copy for every entity made a large owner with N declarations quadratic in
  // allocations even though the final order is already traversal order.
  const entitiesByFile = new Map<string, JsTsEntity[]>();
  for (const entity of entitiesById.values()) {
    const entries = entitiesByFile.get(entity.path);
    if (entries === undefined) entitiesByFile.set(entity.path, [entity]);
    else entries.push(entity);
  }
  const relationsByFile = new Map<string, readonly JsTsRelation[]>([[owner.path, relations]]);
  const diagnosticsByFile = new Map<string, readonly JsTsDiagnostic[]>([[owner.path, diagnostics]]);
  // The Rust-authoritative walk only emits the owner plus declarations reached
  // by checker relations. Keep the output manifest bounded to those files;
  // the caller still carries the complete prepared checker, so passing the
  // entire workspace here would only repeat O(workspace) flattening and
  // closure allocation for every owner.
  const neededPaths = new Set<string>([owner.path, ...entitiesByFile.keys(), ...relationsByFile.keys(), ...diagnosticsByFile.keys()]);
  const outputFiles = files.filter((file) => neededPaths.has(file.path));
  return assembleAnalysis(outputFiles, languageRootNames, entitiesByFile, relationsByFile, diagnosticsByFile, new Map(), new Set(), entitiesById, true);
}

/**
 * Global, order-independent merge step shared by ordinary full analysis and a
 * session's full and incremental builds. It flattens per-file maps
 * (whatever mix of fresh-walked and memoized-reused they came from) into
 * `analyzeProject`'s exact output shape -- derives `core:covers` relations,
 * sorts every array with the identical comparators `analyzeProject` uses,
 * and reduces `directEdgesByFile` into per-file transitive dependency
 * closures. Never memoized itself; always recomputed from the full merged
 * per-file maps.
 */
function assembleAnalysis(
  sourceFiles: readonly AnalyzerFile[],
  rootNames: readonly string[],
  entitiesByFile: ReadonlyMap<string, readonly JsTsEntity[]>,
  relationsByFile: ReadonlyMap<string, readonly JsTsRelation[]>,
  diagnosticsByFile: ReadonlyMap<string, readonly JsTsDiagnostic[]>,
  directEdgesByFile: ReadonlyMap<string, readonly string[]>,
  incompleteClosureFiles: ReadonlySet<string>,
  entityById: ReadonlyMap<string, JsTsEntity>,
  rustAuthoritativeScope = false,
): JsTsAnalysisResult {
  const entities: JsTsEntity[] = [];
  const relations: JsTsRelation[] = [];
  const diagnostics: JsTsDiagnostic[] = [];
  for (const file of sourceFiles) {
    for (const entity of entitiesByFile.get(file.path) ?? []) entities.push(entity);
    for (const relation of relationsByFile.get(file.path) ?? []) relations.push(relation);
    for (const diagnostic of diagnosticsByFile.get(file.path) ?? []) diagnostics.push(diagnostic);
  }
  const parentOf = (entity: JsTsEntity): JsTsEntity | undefined => entity.parent_id === undefined ? undefined : entityById.get(entity.parent_id);
  const testContainerOf = (entity: JsTsEntity): JsTsEntity | undefined => {
    let current: JsTsEntity | undefined = entity;
    while (current !== undefined) {
      if (current.is_test === true) return current;
      current = parentOf(current);
    }
    return undefined;
  };
  for (const reference of [...relations]) {
    if (reference.kind !== "core:references" || reference.target_id === undefined) continue;
    const source = entityById.get(reference.source_id);
    const target = entityById.get(reference.target_id);
    if (source === undefined || target === undefined || source.path === target.path) continue;
    const testContainer = testContainerOf(source);
    if (testContainer !== undefined) relations.push({
      id: `${JAVASCRIPT_TYPESCRIPT_NAMESPACE}:covers:${reference.path}:${reference.start}:${reference.end}:${testContainer.id}:${target.id}`,
      kind: "core:covers",
      source_id: testContainer.id,
      target_id: target.id,
      path: reference.path,
      start: reference.start,
      end: reference.end,
      classification: "confirmed",
    });
  }
  entities.sort((left, right) => left.id.localeCompare(right.id));
  relations.sort((left, right) => left.id.localeCompare(right.id));
  diagnostics.sort((left, right) => `${left.path}\0${left.start ?? -1}\0${left.code}`.localeCompare(`${right.path}\0${right.start ?? -1}\0${right.code}`));
  const dependencyClosures: Record<string, JsTsDependencyClosure> = {};
  for (const file of sourceFiles) {
    if (rustAuthoritativeScope) {
      // The host already retains the complete Rust graph and derives owner
      // manifests from it. These keys preserve the analysis/cache shape; the
      // deliberately incomplete singleton prevents accidental narrowing by a
      // consumer that did not negotiate Rust authority.
      dependencyClosures[file.path] = { files: [file.path], complete: false };
      continue;
    }
    const visited = new Set<string>([file.path]);
    const stack = [file.path];
    let complete = true;
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (incompleteClosureFiles.has(current)) complete = false;
      for (const next of directEdgesByFile.get(current) ?? []) {
        if (!visited.has(next)) { visited.add(next); stack.push(next); }
      }
    }
    dependencyClosures[file.path] = { files: [...visited].sort(), complete };
  }
  return {
    language: rootNames.some((path) => languageForPath(path) === "javascript") && !rootNames.some((path) => languageForPath(path) === "typescript") ? "javascript" : "typescript",
    entities,
    relations,
    diagnostics,
    complete: diagnostics.length === 0,
    dependency_closures: dependencyClosures,
  };
}

/**
 * A live, incremental JavaScript/TypeScript analysis session: holds a
 * mutable-FS-backed TS 7 API instance across calls, plus a per-file memo of
 * `analyzeProject`'s pass-1/pass-2/compiler-diagnostic output, so a
 * content-only edit re-walks only the files that edit could possibly
 * affect instead of re-running the whole-project walk.
 *
 * `analyze` ALWAYS returns a result that canonical-JSON deep-equals what a
 * fresh `analyzeProject` call over the same inputs would return -- see this
 * file's "Incremental analysis session" header comment for why the
 * per-file memoization is sound, and `tests/javascript-typescript-
 * incremental-analysis.test.ts` for the differential correctness suite that
 * enforces it.
 */
export class JsTsAnalysisSession {
  private api: API | undefined;
  private fileMap: MutableVirtualFileSystemStore | undefined;
  private rustSemanticSnapshot: TypescriptSnapshot | undefined;
  private rustSemanticProject: TypescriptProject | undefined;
  private rustSemanticOwnerGroupActive = false;
  private rustSemanticGroupLookups: RustSemanticGroupLookups | undefined;
  private rustSemanticCompilerDiagnosticsByPath: ReadonlyMap<string, readonly JsTsDiagnostic[]> | undefined;
  private rustSemanticConfigPath: string | undefined;
  private rustSemanticCompilerOptions: Readonly<Record<string, unknown>> = {};
  private rustSemanticWindowed = false;
  // Declaration resolution is stable for the lifetime of one TypeScript
  // snapshot. Reusing these caches across bounded owner groups avoids
  // repeating alias/declaration resolution for shared imports in every group
  // while keeping the cache scoped to this single checker instance.
  private rustSemanticResolvedBySymbol = new WeakMap<object, Node | undefined>();
  private rustSemanticResolvedByDeclaration = new WeakMap<Node, Node | undefined>();
  private everBuilt = false;
  private rootNames: readonly string[] = [];
  private compilerOptionsSnapshot: Readonly<Record<string, unknown>> = {};
  private memo = new Map<string, JsTsFileMemo>();
  private rustAuthoritativeScope = false;

  private resetRustSemanticResolutionCaches(): void {
    this.rustSemanticResolvedBySymbol = new WeakMap<object, Node | undefined>();
    this.rustSemanticResolvedByDeclaration = new WeakMap<Node, Node | undefined>();
  }

  /**
   * TypeScript's configured project eagerly binds every configured root. On a
   * very large cold workspace that makes the first checker request pay for the
   * whole corpus before Rust can consume its first bounded owner group. Keep
   * the complete source map available for module resolution, but configure
   * only the current owner window as roots. Imported declarations are still
   * loaded by the checker from that same map, and every owner is eventually
   * visited in exactly one window.
   */
  /* c8 ignore start -- exercised only by the >1,200-owner production gate. */
  private activateRustSemanticWindow(ownerPaths: readonly string[]): void {
    if (!this.rustSemanticWindowed || this.fileMap === undefined || this.api === undefined || this.rustSemanticConfigPath === undefined) return;
    const requested = [...new Set(ownerPaths)].sort();
    if (requested.length === 0 || requested.length > 32 || requested.some((path) => !this.rootNames.includes(path))) throw new Error("Rust semantic owner window is invalid.");
    // Keep several protocol groups in one checker project. The window is a
    // closed multiple of the 32-owner bridge bound, so normal owner ordering
    // crosses no window boundary; non-contiguous incremental requests are
    // added to the same window defensively. A larger window avoids rebuilding
    // the checker project once per small slice on a cold repository. RSS is
    // measured by the admission harness; an OOM remains a hard failure, while
    // an observed overage is retained as advisory evidence when the time and
    // digest gates pass.
    const configuredWindow = Number(process.env["URDIRA_RUST_SEMANTIC_WINDOW_SIZE"] ?? "512");
    const windowSize = Number.isSafeInteger(configuredWindow) && configuredWindow >= 512 && configuredWindow <= 4096 && configuredWindow % 32 === 0
      ? configuredWindow
      : 512;
    const first = this.rootNames.indexOf(requested[0]!);
    const windowStart = Math.floor(first / windowSize) * windowSize;
    const roots = [...new Set([...this.rootNames.slice(windowStart, windowStart + windowSize), ...requested])].sort();
    const config = JSON.stringify({ compilerOptions: this.rustSemanticCompilerOptions, files: roots });
    if (this.fileMap.get(this.rustSemanticConfigPath) === config && this.rustSemanticProject !== undefined && this.rustSemanticSnapshot !== undefined) return;
    this.fileMap.set(this.rustSemanticConfigPath, config);
    this.rustSemanticSnapshot?.dispose();
    const snapshot = this.api.updateSnapshot({ openProjects: [this.rustSemanticConfigPath], fileChanges: { changed: [this.rustSemanticConfigPath] } });
    const project = snapshot.getProjects().find((candidate) => candidate.configFileName === this.rustSemanticConfigPath);
    if (project === undefined) {
      snapshot.dispose();
      throw new Error("TypeScript did not create a project for the Rust semantic owner window.");
    }
    this.rustSemanticSnapshot = snapshot;
    this.rustSemanticProject = project;
    this.resetRustSemanticResolutionCaches();
    this.rustSemanticGroupLookups = undefined;
    this.rustSemanticCompilerDiagnosticsByPath = undefined;
  }
  /* c8 ignore stop */

  /**
   * `analyze` decides, on every call, whether the given inputs can take the
   * incremental path (this session already built or was seeded, root_names
   * and compiler_options are unchanged, and no more than
   * `INCREMENTAL_CHANGE_RATIO_BAILOUT` of root files changed content) or
   * must take a full rebuild (first call ever, a root-set change, a
   * `compiler_options` change, or the bailout ratio).
   */
  analyze(input: { readonly files: readonly AnalyzerFile[]; readonly root_names?: readonly string[]; readonly compiler_options?: Readonly<Record<string, unknown>>; readonly rust_semantic_scope?: JsTsRustSemanticScope }): JsTsSessionAnalyzeResult {
    const rootNames = [...(input.root_names ?? input.files.map((file) => file.path).filter((path) => languageForPath(path) !== undefined))].sort();
    const sourceFiles = input.files.filter((candidate) => rootNames.includes(candidate.path)).sort((left, right) => left.path.localeCompare(right.path));
    const hasJavaScript = rootNames.some((path) => languageForPath(path) === "javascript");
    const compilerOptions = { ...(hasJavaScript ? { allowJs: true, checkJs: true } : {}), ...(input.compiler_options ?? {}) };
    const rustScope = input.rust_semantic_scope;
    if (rustScope !== undefined) {
      const roots = new Set(rootNames);
      const changed = new Set(rustScope.changed_paths);
      const affected = new Set(rustScope.affected_paths);
      if ([...changed, ...affected].some((path) => !roots.has(path))) throw new TypeError("Rust semantic scope contains a path outside root_names.");
      if ([...changed].some((path) => !affected.has(path))) throw new TypeError("Rust semantic scope must include every changed path in affected_paths.");
    }

    if (!this.everBuilt) return this.fullBuildResult(sourceFiles, rootNames, compilerOptions, rustScope);
    if (this.rustAuthoritativeScope !== (rustScope !== undefined)) return this.fullBuildResult(sourceFiles, rootNames, compilerOptions, rustScope);
    if (!sameStringArray(this.rootNames, rootNames)) return this.fullBuildResult(sourceFiles, rootNames, compilerOptions, rustScope);
    if (stableOptionsJson(this.compilerOptionsSnapshot) !== stableOptionsJson(compilerOptions)) return this.fullBuildResult(sourceFiles, rootNames, compilerOptions, rustScope);

    const changedPaths = new Set<string>(rustScope?.changed_paths ?? []);
    if (rustScope === undefined) {
      for (const file of sourceFiles) {
        const memo = this.memo.get(file.path);
        if (memo === undefined || memo.content_hash !== fileContentDigest(file.text)) changedPaths.add(file.path);
      }
    }
    if (rootNames.length > 0 && changedPaths.size / rootNames.length > INCREMENTAL_CHANGE_RATIO_BAILOUT) return this.fullBuildResult(sourceFiles, rootNames, compilerOptions, rustScope);

    return this.buildIncremental(sourceFiles, rootNames, compilerOptions, changedPaths, rustScope);
  }

  /**
   * Prepares the TypeScript project required by checker-backed stages without
   * walking any source AST or materializing structural output. Rust has already
   * supplied the dependency graph, affected closure, declarations, and module
   * facts on this route; rebuilding those arrays here would be duplicate work.
   */
  prepareRustSemanticState(input: {
    readonly files: readonly AnalyzerFile[];
    readonly root_names: readonly string[];
    readonly compiler_options?: Readonly<Record<string, unknown>>;
    readonly rust_semantic_scope: JsTsRustSemanticScope;
  }): "full" | "incremental" {
    const rootNames = [...input.root_names].sort();
    const roots = new Set(rootNames);
    const sourceFiles = input.files.filter((candidate) => roots.has(candidate.path)).sort((left, right) => left.path.localeCompare(right.path));
    const hasJavaScript = rootNames.some((path) => languageForPath(path) === "javascript");
    const compilerOptions = { ...(hasJavaScript ? { allowJs: true, checkJs: true } : {}), ...(input.compiler_options ?? {}) };
    const changedPaths = new Set(input.rust_semantic_scope.changed_paths);
    const affectedPaths = new Set(input.rust_semantic_scope.affected_paths);
    if ([...changedPaths, ...affectedPaths].some((path) => !roots.has(path))) throw new TypeError("Rust semantic scope contains a path outside root_names.");
    if ([...changedPaths].some((path) => !affectedPaths.has(path))) throw new TypeError("Rust semantic scope must include every changed path in affected_paths.");

    // T2 (docs/evidence/2026-09-02-file-creation-diagnosis.md): a root-set
    // change on its own no longer disqualifies the live API/project from
    // being updated in place -- only losing the API/fileMap/scope entirely,
    // or an actual `compiler_options` change, does. Root additions and
    // removals are instead reconciled below (mirrored into the live
    // `MutableVirtualFileSystemStore` and the session config's own `files`
    // list), the same way a content edit already was. Rust's own incremental
    // add/remove-root path (T1) is what hands this method that shape:
    // `rust_semantic_scope.changed_paths` always includes every added root
    // (it needs fresh text) and `root_names` reflects every removal, so
    // nothing here has to re-derive which paths are new from scratch.
    const canUpdate = this.api !== undefined && this.fileMap !== undefined && this.rustAuthoritativeScope
      && stableOptionsJson(this.compilerOptionsSnapshot) === stableOptionsJson(compilerOptions);
    const virtualRoot = SESSION_VIRTUAL_ROOT;
    const configPath = `${virtualRoot}/${SESSION_CONFIG_FILE}`;
    const actuallyChangedPaths = new Set<string>();
    const createdPaths = new Set<string>();
    const deletedPaths = new Set<string>();
    let rootMembershipChanged = false;
    if (!canUpdate) {
      this.rustSemanticSnapshot?.dispose();
      this.rustSemanticSnapshot = undefined;
      this.rustSemanticProject = undefined;
      this.resetRustSemanticResolutionCaches();
      this.api?.close();
      const store = new MutableVirtualFileSystemStore(sourceFiles.map((file) => [`${virtualRoot}/${file.path}`, file.text] as const));
      store.set(configPath, JSON.stringify({ compilerOptions, files: rootNames }));
      this.fileMap = store;
      this.api = new API({ fs: createMutableFileSystem(store), ...(process.env["URDIRA_DEBUG_TIMING"] === "1" ? { collectTiming: true } : {}) });
    } else {
      const filesByPath = new Map(sourceFiles.map((file) => [file.path, file]));
      const priorRoots = new Set(this.rootNames);
      // Removed roots first: drop their text from the live store so a
      // later re-creation of the same path is correctly seen as `created`
      // (fresh text, not a no-op `changed` against stale leftovers) rather
      // than silently resurrecting whatever this store still held for it.
      for (const path of this.rootNames) {
        if (roots.has(path)) continue;
        this.fileMap!.delete(`${virtualRoot}/${path}`);
        deletedPaths.add(path);
        rootMembershipChanged = true;
      }
      for (const path of changedPaths) {
        const file = filesByPath.get(path);
        if (file === undefined) continue;
        const virtualPath = `${virtualRoot}/${path}`;
        const isNewRoot = !priorRoots.has(path);
        if (isNewRoot) rootMembershipChanged = true;
        if (this.fileMap!.get(virtualPath) !== file.text) {
          this.fileMap!.set(virtualPath, file.text);
          if (isNewRoot) createdPaths.add(path); else actuallyChangedPaths.add(path);
        } else if (isNewRoot) {
          // Text already present in the store (defensive: Rust always lists
          // an added root in `changed_paths`, so this should not happen) --
          // still needs to count as `created` so the project reopen below
          // actually picks the path up as a root.
          createdPaths.add(path);
        }
      }
      if (rootMembershipChanged) this.fileMap!.set(configPath, JSON.stringify({ compilerOptions, files: rootNames }));
    }
    const api = this.api!;
    this.rustSemanticConfigPath = configPath;
    this.rustSemanticCompilerOptions = compilerOptions;
    this.rustSemanticWindowed = rootNames.length > 1_200 && process.env["URDIRA_RUST_SEMANTIC_WINDOWED"] !== "0";
    if (this.rustSemanticWindowed) {
      // A root-free configured project supplies the compiler options while
      // keeping project activation cheap; beginRustSemanticOwnerGroup swaps
      // in each bounded root window immediately before its checker walk.
      this.fileMap!.set(configPath, JSON.stringify({ compilerOptions, files: [] }));
    }
    if (!canUpdate || actuallyChangedPaths.size > 0 || rootMembershipChanged || this.rustSemanticSnapshot === undefined || this.rustSemanticProject === undefined) {
      this.rustSemanticSnapshot?.dispose();
      const snapshot = api.updateSnapshot(!canUpdate
        ? { openProjects: [configPath] }
        : rootMembershipChanged
          // A root add/remove reopens `configPath` (already ref-counted
          // open, so this is a cheap reconfigure, not the full API/Program
          // teardown the `!canUpdate` branch above performs) -- the same
          // `openProjects` + `fileChanges.changed:[configPath]` pairing
          // `activateRustSemanticWindow` already relies on to pick up a
          // changed root list without a full rebuild. `created`/`deleted`
          // are included for the source paths themselves, on top of
          // whatever OTHER retained path's content also changed in this
          // same call.
          ? { openProjects: [configPath], fileChanges: {
              changed: [...actuallyChangedPaths].map((path) => `${virtualRoot}/${path}`).concat(configPath),
              ...(createdPaths.size > 0 ? { created: [...createdPaths].map((path) => `${virtualRoot}/${path}`) } : {}),
              ...(deletedPaths.size > 0 ? { deleted: [...deletedPaths].map((path) => `${virtualRoot}/${path}`) } : {}),
            } }
          : { fileChanges: { changed: [...actuallyChangedPaths].map((path) => `${virtualRoot}/${path}`) } });
      const project = snapshot.getProjects().find((candidate) => candidate.configFileName === configPath);
      if (project === undefined) {
        snapshot.dispose();
        throw new Error("TypeScript did not create a project for the Rust-authoritative semantic state.");
      }
      this.rustSemanticSnapshot = snapshot;
      this.rustSemanticProject = project;
      this.resetRustSemanticResolutionCaches();
      this.rustSemanticOwnerGroupActive = false;
      this.rustSemanticGroupLookups = undefined;
      this.rustSemanticCompilerDiagnosticsByPath = undefined;
      api.clearSourceFileCache();
    }
    this.memo = new Map();
    this.rootNames = rootNames;
    this.compilerOptionsSnapshot = compilerOptions;
    this.everBuilt = true;
    this.rustAuthoritativeScope = true;
    return canUpdate ? "incremental" : "full";
  }

  /** Analyze exactly one owner against the already-prepared full checker. */
  analyzeRustSemanticOwner(input: { readonly files: readonly AnalyzerFile[]; readonly owner_path: string; readonly include_inferred_types?: boolean; readonly pending_sites?: readonly RustHybridPendingSite[] }): JsTsAnalysisResult {
    if (this.api === undefined || this.fileMap === undefined || !this.rustAuthoritativeScope) throw new Error("Rust-authoritative semantic state has not been prepared.");
    const owner = input.files.find((file) => file.path === input.owner_path);
    if (owner === undefined) throw new TypeError("Rust-authoritative semantic owner is absent from the accepted input manifest.");
    if (!this.rootNames.includes(owner.path)) throw new TypeError("Rust-authoritative semantic owner is outside the prepared project.");
    const api = this.api;
    const project = this.rustSemanticProject;
    if (project === undefined || this.rustSemanticSnapshot === undefined) throw new Error("Rust-authoritative semantic snapshot has not been prepared.");
    let result: JsTsAnalysisResult;
    try {
      result = walkRustSemanticOwner({
        project,
        virtualRoot: SESSION_VIRTUAL_ROOT,
        files: input.files,
        owner,
        languageRootNames: this.rootNames,
        ...(this.rustSemanticCompilerDiagnosticsByPath === undefined ? {} : { compilerDiagnostics: this.rustSemanticCompilerDiagnosticsByPath.get(owner.path) ?? [] }),
        ...(this.rustSemanticGroupLookups === undefined ? {} : { groupLookups: this.rustSemanticGroupLookups }),
        resolvedBySymbol: this.rustSemanticResolvedBySymbol,
        resolvedByDeclaration: this.rustSemanticResolvedByDeclaration,
        ...(input.include_inferred_types === undefined ? {} : { includeInferredTypes: input.include_inferred_types }),
        ...(input.pending_sites === undefined ? {} : { pendingSites: input.pending_sites }),
      });
    } finally {
      if (!this.rustSemanticOwnerGroupActive) api.clearSourceFileCache();
    }
    return result;
  }

  /** Keep one checker snapshot for a bounded owner group and release remote
   * handles once when the group closes. The program is never reconstructed
   * merely because an owner counter crossed a threshold. */
  beginRustSemanticOwnerGroup(ownerPaths: readonly string[], includeInferredTypes = true, pendingSitesByOwner?: ReadonlyMap<string, readonly RustHybridPendingSite[]>): void {
    if (this.api === undefined || this.rustSemanticProject === undefined || this.rustSemanticSnapshot === undefined || !this.rustAuthoritativeScope) {
      throw new Error("Rust-authoritative semantic state has not been prepared.");
    }
    if (this.rustSemanticOwnerGroupActive) throw new Error("Rust-authoritative semantic owner groups cannot overlap.");
    const uniqueOwnerPaths = [...new Set(ownerPaths)];
    if (uniqueOwnerPaths.length === 0 || uniqueOwnerPaths.length > 32 || uniqueOwnerPaths.some((path) => !this.rootNames.includes(path))) {
      throw new Error("Rust-authoritative semantic owner group paths are invalid.");
    }
    this.activateRustSemanticWindow(ownerPaths);
    const project = this.rustSemanticProject;
    const checker = project.checker;
    const identifierNodes: Node[] = [];
    const declarationNodes: Node[] = [];
    const nodesByOwner = new Map<string, readonly Node[]>();
    const semanticOwnerHasNodes = new Map<string, boolean>();
    const dynamicRuntimeCodeByOwner = new Map<string, boolean>();
    const exportedDeclarations = new Set<Node>();
    const debugTiming = process.env["URDIRA_DEBUG_TIMING"] === "1";
    const descentStarted = debugTiming ? performance.now() : 0;
    // E1c cutover (design doc E1, step 5: "elimina el walk completo"): counts
    // to make the new path's win visible per group -- `resolvedSiteCount` is
    // what the localized descent actually visited (bounded by pending sites,
    // deduped), `pendingSiteOwners`/`legacyOwners` how the group split
    // between the two paths, and `legacyCollectAllNodeCount` the full-file
    // node count paid only by owners that fell back to `collectAll` (no
    // pending sites on hand for them -- flag off, or a group mixing both).
    let pendingSiteOwners = 0;
    let pendingSiteCount = 0;
    let resolvedSiteNodeCount = 0;
    let legacyOwners = 0;
    let legacyCollectAllNodeCount = 0;
    for (const path of uniqueOwnerPaths) {
      const source = project.program.getSourceFile(`${SESSION_VIRTUAL_ROOT}/${path}`);
      if (source === undefined) throw new Error(`TypeScript did not retain the Rust-scoped group owner ${path}.`);
      let nodes: readonly Node[];
      let ownerDeclarationNodes: readonly Node[];
      let hasSemanticNodes: boolean;
      // Exported declaration types are the only reason a declaration-only
      // owner needs the checker export table.  The syntactic marker is a
      // conservative fast gate (comments/strings may keep the query alive),
      // while ordinary private modules avoid an unnecessary remote checker
      // round trip entirely.  CommonJS forms are included because TypeScript
      // models `exports.foo`/`module.exports` without an `export` keyword.
      const sourceText = source.getText();
      const hasExportSyntax = /\bexport\b|\bexports?\s*(?:\.|\[)|\bmodule\s*(?:\.|\[)\s*["']?exports\b|\bObject\.defineProperty\s*\(\s*exports\b/u.test(sourceText);
      dynamicRuntimeCodeByOwner.set(path, /\b(?:eval|Function)\s*\(/u.test(sourceText));
      const pendingSites = pendingSitesByOwner?.get(path);
      if (pendingSites !== undefined) {
        // E1c cutover (design doc E1, step 1 of the handoff): Rust already
        // enumerated every site the checker still needs to look at for this
        // owner (`rust_hybrid_pending_sites`); descend straight to each
        // instead of re-walking the whole file with `collectAll`. Site
        // resolution/dedup semantics: `resolveOwnerPendingSites`'s own
        // doc comment. A pending site is never itself a declaration-name
        // identifier (Rust's `IdentifierReference`/`BindingIdentifier`
        // split already excludes those at the source, unlike `collectAll`'s
        // own explicit `isDeclarationName` guard above), so no equivalent
        // guard is needed here.
        const resolved = resolveOwnerPendingSites(source, pendingSites);
        nodes = resolved.nodes;
        ownerDeclarationNodes = includeInferredTypes ? resolved.declarationNodes : [];
        if (includeInferredTypes) declarationNodes.push(...resolved.declarationNodes);
        identifierNodes.push(...resolved.identifierNodes);
        // Matches `hybrid_owner_can_skip_checker`'s own predicate in
        // urdira-indexing-worker/src/main.rs: nothing pending means Rust
        // proved there is nothing left here for the checker to do.
        hasSemanticNodes = pendingSites.length > 0;
        pendingSiteOwners += 1;
        pendingSiteCount += pendingSites.length;
        resolvedSiteNodeCount += resolved.nodes.length;
      } else {
        const collected: Node[] = [];
        const collectedDeclarations: Node[] = [];
        let collectedHasSemanticNodes = false;
        const collectAll = (node: Node): void => {
          collected.push(node);
          if (isIdentifier(node)) {
            // The owner walk deliberately skips declaration-name identifiers;
            // resolving their symbols only adds checker work and retains
            // entries that can never be consumed.
            const parent = node.parent;
            const parentName = parent === undefined ? undefined : (parent as Node & { readonly name?: Node }).name;
            const isDeclarationName = parent !== undefined && rustSemanticDeclarationShape(parent) !== undefined && parentName !== undefined
              && parentName.getStart(parentName.getSourceFile()) === node.getStart(node.getSourceFile()) && parentName.getEnd() === node.getEnd();
            if (!isDeclarationName) {
              identifierNodes.push(node);
              collectedHasSemanticNodes = true;
            }
          }
          const declarationShape = rustSemanticDeclarationShape(node);
          if (includeInferredTypes && declarationShape !== undefined) {
            declarationNodes.push(node);
            collectedDeclarations.push(node);
          }
          // `super()` has no identifier child but still emits a call relation;
          // heritage clauses can likewise be represented without an identifier.
          if (isCallExpression(node) || isHeritageClause(node)) collectedHasSemanticNodes = true;
          node.forEachChild(collectAll);
        };
        collectAll(source);
        nodes = collected;
        ownerDeclarationNodes = collectedDeclarations;
        hasSemanticNodes = collectedHasSemanticNodes;
        legacyOwners += 1;
        legacyCollectAllNodeCount += collected.length;
      }
      nodesByOwner.set(path, Object.freeze([...nodes]));
      if (hasExportSyntax && ownerDeclarationNodes.some((node) => rustSemanticDeclarationShape(node)?.kind !== "parameter")) {
        try {
          const moduleSymbol = checker.getSymbolAtLocation(source);
          for (const declaration of checker.getExportsOfModule(moduleSymbol!).flatMap((symbol) => symbol.declarations ?? [])) {
            const resolved = declaration.resolve(project);
            if (resolved !== undefined) exportedDeclarations.add(resolved);
          }
        } catch { /* A script without a module symbol has no exported type facts. */ }
      }
      // An unexported declaration with an empty body contributes no semantic
      // row: structural declaration records are already owned by Rust, and
      // inferred types are emitted only for exported declarations. Keep the
      // checker-free fast path for this common private-helper shape while
      // retaining files with references, calls or heritage clauses above.
      if (includeInferredTypes && !hasSemanticNodes && declarationNodes.some((node) => {
        const shape = rustSemanticDeclarationShape(node);
        return shape !== undefined && shape.kind !== "parameter"
          && (exportedDeclarations.has(node) || (node.parent !== undefined && exportedDeclarations.has(node.parent)));
      })) hasSemanticNodes = true;
      semanticOwnerHasNodes.set(path, hasSemanticNodes);
    }
    const symbolByNode = new Map<Node, TypescriptSymbol | undefined>();
    // Avoid crossing the checker boundary for an empty lookup batch.  The
    // checker API still allocates a remote request for `[]`, which is common
    // for declaration-only owners and needlessly repeats once per bounded
    // Rust semantic group.
    if (identifierNodes.length > 0) {
      const symbols = checker.getSymbolAtLocation(identifierNodes);
      for (let index = 0; index < identifierNodes.length; index += 1) symbolByNode.set(identifierNodes[index]!, symbols[index]);
    }
    const typedDeclarations = declarationNodes.filter((node) => {
      const shape = rustSemanticDeclarationShape(node);
      return shape !== undefined && shape.kind !== "parameter" && (exportedDeclarations.has(node) || (node.parent !== undefined && exportedDeclarations.has(node.parent)));
    });
    const inferredTypeByNode = new Map<Node, string>();
    if (includeInferredTypes && typedDeclarations.length > 0) {
      const types = checker.getTypeAtLocation(typedDeclarations);
      for (let index = 0; index < typedDeclarations.length; index += 1) {
        const type = types[index];
        if (type === undefined) continue;
        try { inferredTypeByNode.set(typedDeclarations[index]!, checker.typeToString(type, typedDeclarations[index])); }
        catch { /* An unavailable type remains absent, matching the owner walk. */ }
      }
    }
    this.rustSemanticGroupLookups = {
      symbol_by_node: symbolByNode,
      inferred_type_by_node: inferredTypeByNode,
      exported_declarations: exportedDeclarations,
      nodes_by_owner: nodesByOwner,
      semantic_owner_has_nodes: semanticOwnerHasNodes,
      dynamic_runtime_code_by_owner: dynamicRuntimeCodeByOwner,
    };
    // Diagnostics are consumed only for the owners in the current bounded
    // group.  The previous implementation requested all syntactic/bind/
    // semantic diagnostics for the entire 512-root window on the first group,
    // then repeated that expensive project-wide walk after every window
    // activation.  Query the checker per owner instead and retain the results
    // across later groups in the same snapshot; this keeps the Rust bridge
    // bounded without rebuilding a corpus-sized diagnostic array.
    const diagnosticsByPath = new Map<string, JsTsDiagnostic[]>();
    for (const [path, diagnostics] of this.rustSemanticCompilerDiagnosticsByPath ?? []) diagnosticsByPath.set(path, [...diagnostics]);
    {
      const diagnosticText = (message: unknown): string => typeof message === "string" ? message : message !== null && typeof message === "object" && "text" in message ? diagnosticText((message as { text: unknown }).text) : String(message);
      const append = (diagnostic: { readonly fileName?: string | undefined; readonly code: number; readonly text: unknown; readonly pos?: number | undefined; readonly end?: number | undefined }): void => {
        if (diagnostic.fileName === undefined || !diagnostic.fileName.startsWith(`${SESSION_VIRTUAL_ROOT}/`)) return;
        const path = diagnostic.fileName.slice(SESSION_VIRTUAL_ROOT.length + 1);
        if (!this.rootNames.includes(path)) return;
        const converted: JsTsDiagnostic = {
          code: "jsts:compiler_diagnostic",
          compiler_code: diagnostic.code,
          message: diagnosticText(diagnostic.text),
          path,
          ...(diagnostic.pos === undefined ? {} : { start: diagnostic.pos }),
          ...(diagnostic.end === undefined ? {} : { end: diagnostic.end }),
        };
        const entries = diagnosticsByPath.get(path);
        if (entries === undefined) diagnosticsByPath.set(path, [converted]);
        else entries.push(converted);
      };
      for (const path of uniqueOwnerPaths) {
        if (diagnosticsByPath.has(path)) continue;
        const fileName = `${SESSION_VIRTUAL_ROOT}/${path}`;
        for (const diagnostic of this.rustSemanticProject.program.getSyntacticDiagnostics(fileName)) append(diagnostic);
        for (const diagnostic of this.rustSemanticProject.program.getBindDiagnostics(fileName)) append(diagnostic);
        for (const diagnostic of this.rustSemanticProject.program.getSemanticDiagnostics(fileName)) append(diagnostic);
        if (!diagnosticsByPath.has(path)) diagnosticsByPath.set(path, []);
      }
      this.rustSemanticCompilerDiagnosticsByPath = diagnosticsByPath;
    }
    this.rustSemanticOwnerGroupActive = true;
    if (debugTiming) {
      console.error(`[urdira] jsts site descent owners=${uniqueOwnerPaths.length} cutover_owners=${pendingSiteOwners} pending_sites=${pendingSiteCount} resolved_nodes=${resolvedSiteNodeCount} legacy_owners=${legacyOwners} legacy_ast_nodes=${legacyCollectAllNodeCount} elapsed_ms=${Math.round(performance.now() - descentStarted)}`);
    }
  }

  endRustSemanticOwnerGroup(): void {
    if (!this.rustSemanticOwnerGroupActive) return;
    this.rustSemanticOwnerGroupActive = false;
    this.rustSemanticGroupLookups = undefined;
    if (process.env["URDIRA_DEBUG_TIMING"] === "1") {
      try { console.error(`[urdira] tsgo timing ${JSON.stringify(this.api?.getTimingInfo())}`); } catch { /* diagnostics only */ }
    }
    // Keep the immutable source-file AST cache warm while it fits the Rust
    // worker's bounded-memory budget. Once the checker crosses the budget,
    // release hydrated source files without rebuilding the project/program;
    // this avoids retaining several gigabytes across all owner groups while
    // preserving the single authoritative semantic state.
    // Keep large workspaces below the product's process-tree budget while
    // avoiding repeated AST hydration on the bounded benchmark corpora. The
    // 512/1,000-owner gates fit in the measured worker envelope without
    // eviction; genuinely large workspaces retain a conservative limit so the
    // checker cannot grow without bound as owner count scales.
    //
    // The 800 MB floor below predates windowing: with rustSemanticWindowed
    // active (>1,200 roots) each lane's working set is bounded to ~one
    // window (512 roots, activateRustSemanticWindow above), not the whole
    // corpus, so a per-lane budget can be raised well past 800 MB without
    // approaching the tree-wide ceiling (6 lanes x 1.5 GB plus the Go heap
    // still sits under the 8 GiB budget). Without windowing the working set
    // genuinely is the whole corpus, so that path keeps the original 800 MB
    // floor. An explicit override always wins over either floor.
    const explicitLimitText = process.env["URDIRA_RUST_SEMANTIC_CACHE_RSS_LIMIT_BYTES"];
    const configuredLimit = Number(explicitLimitText ?? 800_000_000);
    const safeConfiguredLimit = Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : 800_000_000;
    const limit = explicitLimitText !== undefined
      ? safeConfiguredLimit
      : this.rustSemanticWindowed
        ? Math.max(safeConfiguredLimit, 1_500_000_000)
        : this.rootNames.length <= 1_200
          ? Math.max(safeConfiguredLimit, 3_000_000_000)
          : safeConfiguredLimit;
    if (process.memoryUsage().rss > limit) this.api?.clearSourceFileCache();
  }

  /**
   * Seeds this session's per-file memo from an already-computed
   * `JsTsAnalysisResult` (a durable-cache hit, or one loaded whole-project
   * analysis another workspace already produced) WITHOUT building any
   * API/program -- the lazy API build happens on this session's first
   * subsequent `analyze` call that takes the incremental path (~240ms, a
   * cheap program build; the walk itself still only covers whatever the
   * memo says needs re-walking).
   *
   * `compiler_options` is not part of `JsTsAnalysisResult`, so callers that
   * know it (the worker always does, at a durable-cache hit) should pass it
   * -- omitting it just means the FIRST subsequent `analyze` call with
   * different-looking compiler_options can't tell whether they actually
   * differ, so it conservatively treats them as changed and takes one
   * (still fully correct, just non-optimal) full rebuild.
   */
  seedFromAnalysis(analysis: JsTsAnalysisResult, files: readonly AnalyzerFile[], compilerOptions?: Readonly<Record<string, unknown>>): void {
    this.rustSemanticSnapshot?.dispose();
    this.rustSemanticSnapshot = undefined;
    this.rustSemanticProject = undefined;
    this.resetRustSemanticResolutionCaches();
    this.rustSemanticOwnerGroupActive = false;
    this.rustSemanticGroupLookups = undefined;
    this.rustSemanticCompilerDiagnosticsByPath = undefined;
    this.api?.close();
    this.api = undefined;
    this.fileMap = undefined;

    const rootNames = Object.keys(analysis.dependency_closures).sort();
    const filesByPath = new Map(files.map((file) => [file.path, file]));
    const entitiesByPath = new Map<string, JsTsEntity[]>();
    for (const entity of analysis.entities) {
      const list = entitiesByPath.get(entity.path);
      if (list === undefined) entitiesByPath.set(entity.path, [entity]); else list.push(entity);
    }
    const relationsByPath = new Map<string, JsTsRelation[]>();
    for (const relation of analysis.relations) {
      if (relation.kind === "core:covers") continue;
      const list = relationsByPath.get(relation.path);
      if (list === undefined) relationsByPath.set(relation.path, [relation]); else list.push(relation);
    }
    const diagnosticsByPath = new Map<string, JsTsDiagnostic[]>();
    for (const diagnostic of analysis.diagnostics) {
      const list = diagnosticsByPath.get(diagnostic.path);
      if (list === undefined) diagnosticsByPath.set(diagnostic.path, [diagnostic]); else list.push(diagnostic);
    }
    const entityById = new Map(analysis.entities.map((entity) => [entity.id, entity]));

    const memo = new Map<string, JsTsFileMemo>();
    for (const path of rootNames) {
      const file = filesByPath.get(path);
      if (file === undefined) continue;
      const relations = relationsByPath.get(path) ?? [];
      const directEdges = new Set<string>();
      for (const relation of relations) {
        if (relation.target_id === undefined) continue;
        const target = entityById.get(relation.target_id);
        if (target !== undefined && target.path !== path) directEdges.add(target.path);
      }
      const closure = analysis.dependency_closures[path];
      memo.set(path, {
        content_hash: fileContentDigest(file.text),
        closure_files: closure?.files ?? [path],
        closure_complete: closure?.complete ?? false,
        entities: entitiesByPath.get(path) ?? [],
        relations,
        diagnostics: diagnosticsByPath.get(path) ?? [],
        direct_edges: [...directEdges].sort(),
      });
    }
    this.memo = memo;
    this.rootNames = rootNames;
    this.compilerOptionsSnapshot = compilerOptions ?? {};
    this.everBuilt = true;
    this.rustAuthoritativeScope = false;
  }

  /** Disposes any live checker/API (killing the Go server child) and resets
   * this session to never-built state. Safe to call on an unbuilt/already
   * seeded-only session. */
  close(): void {
    this.rustSemanticSnapshot?.dispose();
    this.rustSemanticSnapshot = undefined;
    this.rustSemanticProject = undefined;
    this.resetRustSemanticResolutionCaches();
    this.rustSemanticOwnerGroupActive = false;
    this.rustSemanticGroupLookups = undefined;
    this.rustSemanticCompilerDiagnosticsByPath = undefined;
    this.api?.close();
    this.api = undefined;
    this.fileMap = undefined;
    this.memo = new Map();
    this.everBuilt = false;
    this.rootNames = [];
    this.compilerOptionsSnapshot = {};
    this.rustAuthoritativeScope = false;
  }

  private fullBuildResult(sourceFiles: readonly AnalyzerFile[], rootNames: readonly string[], compilerOptions: Readonly<Record<string, unknown>>, rustScope?: JsTsRustSemanticScope): JsTsSessionAnalyzeResult {
    const result = this.buildFull(sourceFiles, rootNames, compilerOptions, rustScope);
    return { result, build: "full", rewalked: sourceFiles.map((file) => file.path) };
  }

  /** Full whole-project rebuild: closes any live API and constructs a brand
   * new mutable-FS-backed one, discarding the entire previous memo. Mirrors
   * `analyzeProject`'s own construction sequence exactly (same virtual
   * config shape, same `updateSnapshot({openProjects:[...]})` call), just
   * over a mutable rather than immutable `FileSystem`, so this session can
   * keep applying incremental edits to it afterwards. */
  private buildFull(sourceFiles: readonly AnalyzerFile[], rootNames: readonly string[], compilerOptions: Readonly<Record<string, unknown>>, rustScope?: JsTsRustSemanticScope): JsTsAnalysisResult {
    this.rustSemanticSnapshot?.dispose();
    this.rustSemanticSnapshot = undefined;
    this.rustSemanticProject = undefined;
    this.resetRustSemanticResolutionCaches();
    this.rustSemanticOwnerGroupActive = false;
    this.rustSemanticGroupLookups = undefined;
    this.rustSemanticCompilerDiagnosticsByPath = undefined;
    this.api?.close();
    this.api = undefined;
    this.fileMap = undefined;
    const virtualRoot = SESSION_VIRTUAL_ROOT;
    const configPath = `${virtualRoot}/${SESSION_CONFIG_FILE}`;
    const map = new MutableVirtualFileSystemStore(sourceFiles.map((file) => [`${virtualRoot}/${file.path}`, file.text] as const));
    map.set(configPath, JSON.stringify({ compilerOptions, files: rootNames }));
    const api = new API({ fs: createMutableFileSystem(map) });
    let project: TypescriptProject | undefined;
    try {
      const snapshot = api.updateSnapshot({ openProjects: [configPath] });
      project = snapshot.getProjects().find((candidate) => candidate.configFileName === configPath);
      if (project === undefined) throw new Error("TypeScript did not create a project for the virtual configuration.");
      const entityByNode = new Map<string, JsTsEntity>();
      const entityById = new Map<string, JsTsEntity>();
      const moduleByPath = new Map<string, JsTsEntity>();
      const walkOutput = walkFiles({ project, virtualRoot, filesToProcess: sourceFiles, entityByNode, entityById, moduleByPath, ...(rustScope === undefined ? {} : { rust_authoritative_scope: true }) });
      const analysis = assembleAnalysis(sourceFiles, rootNames, walkOutput.entitiesByFile, walkOutput.relationsByFile, walkOutput.diagnosticsByFile, walkOutput.directEdgesByFile, walkOutput.directIncompleteFiles, entityById, rustScope !== undefined);
      const memo = new Map<string, JsTsFileMemo>();
      for (const file of sourceFiles) {
        // Hash warm-up: the program/AST is right here, so pay this cost once
        // per file now rather than leaving it to the first future edit. This
        // is what lets THAT edit's `buildIncremental` gate be capable from
        // the very first post-full-scan call.
        const source = rustScope === undefined ? project.program.getSourceFile(`${virtualRoot}/${file.path}`) : undefined;
        const hashes = rustScope === undefined
          ? computeSemanticHashes(file.text, source === undefined ? [] : collectOpaqueSpans(file.text, source), languageForPath(file.path) === "javascript")
          : undefined;
        memo.set(file.path, {
          content_hash: fileContentDigest(file.text),
          closure_files: analysis.dependency_closures[file.path]?.files ?? [file.path],
          closure_complete: analysis.dependency_closures[file.path]?.complete ?? false,
          entities: walkOutput.entitiesByFile.get(file.path) ?? [],
          relations: walkOutput.relationsByFile.get(file.path) ?? [],
          diagnostics: walkOutput.diagnosticsByFile.get(file.path) ?? [],
          direct_edges: rustScope === undefined ? walkOutput.directEdgesByFile.get(file.path) ?? [] : [],
          ...(hashes === undefined ? {} : hashes),
        });
      }
      this.memo = memo;
      this.api = api;
      this.fileMap = map;
      this.rootNames = rootNames;
      this.compilerOptionsSnapshot = compilerOptions;
      this.everBuilt = true;
      this.rustAuthoritativeScope = rustScope !== undefined;
      return analysis;
    } finally {
      project?.checker.dispose();
    }
  }

  /**
   * Content-only edit: applies the changed files' text directly to the live
   * mutable-FS map (or, for a session that only has a seeded memo and no
   * live API yet, lazily constructs one now over every root file's CURRENT
   * content -- a fresh ~240ms program build, not a rebuild of anything),
   * takes exactly ONE `updateSnapshot` call, then runs a TWO-PHASE walk:
   *
   *  - Phase 1 re-walks exactly `changedPaths` plus any file whose memo is
   *    missing/untrustworthy (`closure_complete: false`) -- the same
   *    unconditional-rewalk members `buildIncremental` has always had, never
   *    the wider "every file whose closure intersects `changedPaths`" set a
   *    single-phase walk would need. Every OTHER file's cross-file lookup
   *    entries are reconstructed from memo first (an entity's
   *    `id`/`path`/`start` alone are sufficient -- entityByNode's key is
   *    exactly `${path}:${start}`; module entities never get an
   *    entityByNode entry, matching `analyzeProject`'s own `collect` loop).
   *  - The GATE then asks, for each `f` in `changedPaths` only: did `f`'s
   *    dependent-visible surface (semantic tokens, guard comments, entity
   *    projection, direct edges -- see this file's header comment and
   *    `computeSemanticHashes`/`entityProjection`) actually change? A file
   *    whose gate PASSES cannot have altered any dependent's output --
   *    comments, whitespace, and (per the opaque-span handling) even
   *    content edits fully contained inside a regex/template/JSX span that
   *    don't change that span's own text are invisible to every dependent.
   *  - Phase 2 re-walks D: files outside phase 1 whose memo closure
   *    intersects the gate-failed ("impactful") set -- these are the only
   *    files whose OWN previously-memoized output (e.g. a `typeOf` result
   *    that resolved through an impactful dependency) could now be stale.
   *    D is computed against `impactful`, never against all of
   *    `changedPaths`, which is the whole point of the gate. Phase 2 reuses
   *    phase 1's FRESH entities for phase-1 files (not memo) when
   *    reconstructing its own lookup maps, since phase 1's walk already
   *    superseded those files' memo entries this call.
   *
   * Phase-1 files are never walked twice; D files' own text is provably
   * unchanged (D is disjoint from phase 1, which is a superset of
   * `changedPaths`), so reusing phase 1's fresh entities/memo for
   * everything outside D during phase 2 is sound. The final merge (per
   * file: phase-1 output, else phase-2 output, else memo) then feeds the
   * same global covers/sort/closure derivation `buildFull` uses.
   */
  private buildIncremental(sourceFiles: readonly AnalyzerFile[], rootNames: readonly string[], compilerOptions: Readonly<Record<string, unknown>>, changedPaths: ReadonlySet<string>, rustScope?: JsTsRustSemanticScope): JsTsSessionAnalyzeResult {
    const virtualRoot = SESSION_VIRTUAL_ROOT;
    const configPath = `${virtualRoot}/${SESSION_CONFIG_FILE}`;
    const virtualPath = (path: string): string => `${virtualRoot}/${path}`;
    const filesByPath = new Map(sourceFiles.map((file) => [file.path, file]));
    let freshApi = false;
    if (this.api === undefined || this.fileMap === undefined) {
      const map = new MutableVirtualFileSystemStore(sourceFiles.map((file) => [`${virtualRoot}/${file.path}`, file.text] as const));
      map.set(configPath, JSON.stringify({ compilerOptions, files: rootNames }));
      this.fileMap = map;
      this.api = new API({ fs: createMutableFileSystem(map) });
      freshApi = true;
    } else {
      for (const path of changedPaths) {
        const file = filesByPath.get(path);
        if (file !== undefined) this.fileMap.set(`${virtualRoot}/${path}`, file.text);
      }
    }
    const api = this.api;
    const snapshot = freshApi
      ? api.updateSnapshot({ openProjects: [configPath] })
      : api.updateSnapshot({ fileChanges: { changed: [...changedPaths].map((path) => `${virtualRoot}/${path}`) } });
    let project: TypescriptProject | undefined;
    try {
      project = snapshot.getProjects().find((candidate) => candidate.configFileName === configPath);
      if (project === undefined) throw new Error("TypeScript did not create a project for the virtual configuration.");

      // Phase 1 set: exactly today's unconditional-rewalk members. Only
      // files in HERE can widen phase 2 -- a file forced in by an
      // incomplete closure but whose own content didn't change is never
      // itself gated (the gate only runs over `changedPaths`, below).
      const phase1Set = new Set<string>();
      for (const file of sourceFiles) {
        const memo = this.memo.get(file.path);
        if (memo === undefined || (rustScope === undefined && !memo.closure_complete) || changedPaths.has(file.path)) phase1Set.add(file.path);
      }
      const phase1Files = [...phase1Set]
        .map((path) => filesByPath.get(path))
        .filter((file): file is AnalyzerFile => file !== undefined)
        .sort((left, right) => left.path.localeCompare(right.path));

      const entityByNode1 = new Map<string, JsTsEntity>();
      const entityById1 = new Map<string, JsTsEntity>();
      const moduleByPath1 = new Map<string, JsTsEntity>();
      for (const file of sourceFiles) {
        if (phase1Set.has(file.path)) continue;
        const memo = this.memo.get(file.path);
        if (memo === undefined) continue;
        for (const entity of memo.entities) {
          entityById1.set(entity.id, entity);
          if (entity.kind === "module") moduleByPath1.set(entity.path, entity);
          else entityByNode1.set(`${entity.path}:${entity.start}`, entity);
        }
      }
      const phase1Output = walkFiles({ project, virtualRoot, filesToProcess: phase1Files, entityByNode: entityByNode1, entityById: entityById1, moduleByPath: moduleByPath1, ...(rustScope === undefined ? {} : { rust_authoritative_scope: true }) });

      // Gate: only `changedPaths` files can be impactful -- the other
      // phase-1 members (incomplete-closure files) never themselves widen
      // the rewalk, they just always re-walk their OWN output.
      const impactful = new Set<string>();
      const freshHashesByPath = new Map<string, { readonly semantic_hash: string; readonly guard_hash: string }>();
      for (const path of rustScope === undefined ? changedPaths : []) {
        const file = filesByPath.get(path);
        if (file === undefined) continue;
        const source = project.program.getSourceFile(virtualPath(path));
        const opaqueSpans = source === undefined ? [] : collectOpaqueSpans(file.text, source);
        const fresh = computeSemanticHashes(file.text, opaqueSpans, languageForPath(path) === "javascript");
        freshHashesByPath.set(path, fresh);
        const memo = this.memo.get(path);
        const gatePasses = memo !== undefined
          && memo.semantic_hash !== undefined && memo.semantic_hash === fresh.semantic_hash
          && memo.guard_hash !== undefined && memo.guard_hash === fresh.guard_hash
          && entityProjection(memo.entities) === entityProjection(phase1Output.entitiesByFile.get(path) ?? [])
          && sameStringArray(memo.direct_edges, phase1Output.directEdgesByFile.get(path) ?? []);
        if (!gatePasses) impactful.add(path);
      }

      // Phase 2 set D: dependents (direct or transitive -- `closure_files`
      // is already the full transitive closure) of an impactful file, drawn
      // only from files phase 1 left untouched. Empty whenever the gate
      // passed for every changed file.
      const D = new Set<string>();
      if (rustScope !== undefined) {
        for (const path of rustScope.affected_paths) if (!phase1Set.has(path)) D.add(path);
      } else if (impactful.size > 0) {
        for (const file of sourceFiles) {
          if (phase1Set.has(file.path)) continue;
          const memo = this.memo.get(file.path)!;
          if (memo.closure_files.some((path) => impactful.has(path))) D.add(file.path);
        }
      }

      let phase2Output: JsTsWalkPassOutput | undefined;
      let entityByIdFinal = entityById1;
      if (D.size > 0) {
        const entityByNode2 = new Map<string, JsTsEntity>();
        const entityById2 = new Map<string, JsTsEntity>();
        const moduleByPath2 = new Map<string, JsTsEntity>();
        for (const file of sourceFiles) {
          if (D.has(file.path)) continue;
          if (phase1Set.has(file.path)) {
            for (const entity of phase1Output.entitiesByFile.get(file.path) ?? []) {
              entityById2.set(entity.id, entity);
              if (entity.kind === "module") moduleByPath2.set(entity.path, entity);
              else entityByNode2.set(`${entity.path}:${entity.start}`, entity);
            }
            continue;
          }
          const memo = this.memo.get(file.path)!;
          for (const entity of memo.entities) {
            entityById2.set(entity.id, entity);
            if (entity.kind === "module") moduleByPath2.set(entity.path, entity);
            else entityByNode2.set(`${entity.path}:${entity.start}`, entity);
          }
        }
        const dFiles = [...D]
          .map((path) => filesByPath.get(path))
          .filter((file): file is AnalyzerFile => file !== undefined)
          .sort((left, right) => left.path.localeCompare(right.path));
        phase2Output = walkFiles({ project, virtualRoot, filesToProcess: dFiles, entityByNode: entityByNode2, entityById: entityById2, moduleByPath: moduleByPath2, ...(rustScope === undefined ? {} : { rust_authoritative_scope: true }) });
        entityByIdFinal = entityById2;
      }

      const entitiesByFile = new Map<string, readonly JsTsEntity[]>();
      const relationsByFile = new Map<string, readonly JsTsRelation[]>();
      const diagnosticsByFile = new Map<string, readonly JsTsDiagnostic[]>();
      const finalDirectEdgesByFile = new Map<string, readonly string[]>();
      for (const file of sourceFiles) {
        if (phase1Set.has(file.path)) {
          entitiesByFile.set(file.path, phase1Output.entitiesByFile.get(file.path) ?? []);
          relationsByFile.set(file.path, phase1Output.relationsByFile.get(file.path) ?? []);
          diagnosticsByFile.set(file.path, phase1Output.diagnosticsByFile.get(file.path) ?? []);
          finalDirectEdgesByFile.set(file.path, phase1Output.directEdgesByFile.get(file.path) ?? []);
        } else if (D.has(file.path)) {
          entitiesByFile.set(file.path, phase2Output!.entitiesByFile.get(file.path) ?? []);
          relationsByFile.set(file.path, phase2Output!.relationsByFile.get(file.path) ?? []);
          diagnosticsByFile.set(file.path, phase2Output!.diagnosticsByFile.get(file.path) ?? []);
          finalDirectEdgesByFile.set(file.path, phase2Output!.directEdgesByFile.get(file.path) ?? []);
        } else {
          const memo = this.memo.get(file.path)!;
          entitiesByFile.set(file.path, memo.entities);
          relationsByFile.set(file.path, memo.relations);
          diagnosticsByFile.set(file.path, memo.diagnostics);
          finalDirectEdgesByFile.set(file.path, memo.direct_edges);
        }
      }

      // Files left untouched by BOTH phases provably never need a direct-
      // incomplete entry: if any file reachable from such a file G had one,
      // G's OWN previous closure would have been `complete: false` (the
      // direct flag for a file is always checked against ITSELF first in
      // the closure BFS below, and closures are transitively closed), which
      // forces G into `phase1Set` via the `!memo.closure_complete` branch --
      // contradiction. So only `phase1Output`/`phase2Output`'s own
      // `directIncompleteFiles` (necessarily subsets of `phase1Files`/
      // `dFiles`) can ever be non-empty.
      const directIncompleteFiles = new Set<string>([...phase1Output.directIncompleteFiles, ...(phase2Output?.directIncompleteFiles ?? [])]);
      const analysis = assembleAnalysis(sourceFiles, rootNames, entitiesByFile, relationsByFile, diagnosticsByFile, finalDirectEdgesByFile, directIncompleteFiles, entityByIdFinal, rustScope !== undefined);

      // Memo rebuild: phase-1/D files get fresh walk values (their own
      // output just changed); `changedPaths` files additionally get the
      // freshly computed hashes (unconditionally -- even a gate-PASS file's
      // hashes get refreshed to the new text's values, which just happen to
      // equal the old ones for a purely-cosmetic edit). Every other file's
      // memo entry -- including a phase-1 member forced in only by an
      // incomplete closure, whose own text never changed this round -- is
      // carried forward completely unchanged.
      const newMemo = new Map<string, JsTsFileMemo>();
      for (const file of sourceFiles) {
        if (phase1Set.has(file.path) || D.has(file.path)) {
          const walkOutput = phase1Set.has(file.path) ? phase1Output : phase2Output!;
          const hashes = freshHashesByPath.get(file.path);
          newMemo.set(file.path, {
            content_hash: fileContentDigest(file.text),
            closure_files: analysis.dependency_closures[file.path]?.files ?? [file.path],
            closure_complete: analysis.dependency_closures[file.path]?.complete ?? false,
            entities: walkOutput.entitiesByFile.get(file.path) ?? [],
            relations: walkOutput.relationsByFile.get(file.path) ?? [],
            diagnostics: walkOutput.diagnosticsByFile.get(file.path) ?? [],
            direct_edges: rustScope === undefined ? walkOutput.directEdgesByFile.get(file.path) ?? [] : [],
            ...(hashes === undefined ? {} : hashes),
          });
        } else {
          newMemo.set(file.path, this.memo.get(file.path)!);
        }
      }
      this.memo = newMemo;
      this.rootNames = rootNames;
      this.compilerOptionsSnapshot = compilerOptions;
      this.everBuilt = true;
      this.rustAuthoritativeScope = rustScope !== undefined;
      const rewalked = [...phase1Set, ...D].sort((left, right) => left.localeCompare(right));
      return { result: analysis, build: "incremental", rewalked, ...(rustScope === undefined ? { impactful_changed_paths: [...impactful].sort((left, right) => left.localeCompare(right)) } : {}) };
    } finally {
      project?.checker.dispose();
    }
  }
}
