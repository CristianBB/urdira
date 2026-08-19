import { createHash } from "node:crypto";
import { version as TYPESCRIPT_VERSION } from "typescript";
import { createVirtualFileSystem, type FileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
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
import type { Project as TypescriptProject } from "typescript/unstable/sync";
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
// bootstrap and sanitized public metadata; analyzer output is unchanged.
export const JAVASCRIPT_TYPESCRIPT_VERSION = "0.3.2" as const;
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
 * Build only the facts that are valid after structural stage 1.  This keeps
 * the TypeScript program construction (which is cheap) but deliberately never
 * asks for a checker, symbols, signatures, types, or diagnostics.  Stage 1 is
 * therefore useful while the expensive semantic walk is still pending.
 */
export function analyzeSyntaxProject(input: { readonly files: readonly AnalyzerFile[]; readonly root_names?: readonly string[]; readonly compiler_options?: Readonly<Record<string, unknown>> }): JsTsAnalysisResult {
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
      const id = stableId(kind, path, start, name);
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

export function analyzeProject(input: { readonly files: readonly AnalyzerFile[]; readonly root_names?: readonly string[]; readonly compiler_options?: Readonly<Record<string, unknown>> }): JsTsAnalysisResult {
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
    const checker = project.checker;
    const entities: JsTsEntity[] = [];
    const relations: JsTsRelation[] = [];
    const diagnostics: JsTsDiagnostic[] = [];
    const entityByNode = new Map<string, JsTsEntity>();
    const entityById = new Map<string, JsTsEntity>();
    const moduleByPath = new Map<string, JsTsEntity>();
    // Direct (one-hop) import/export edges between scanned files' own paths,
    // and the set of files whose closure cannot be trusted as complete --
    // populated alongside the "core:import"/"core:export" relations below
    // (`walk`'s import/export branch), then reduced to a transitive closure
    // per file after every source file has been walked (see
    // `dependencyClosures`, near the end of this function).
    const directImportEdges = new Map<string, Set<string>>();
    const incompleteClosureFiles = new Set<string>();
    // Type-string extraction (`typeOf`, below) calls into the checker's type
    // resolution machinery, which is expensive when done for every declaration
    // in a file (most declarations are locals and parameters, never surfaced
    // to a query). Restrict it to the file's actual exported surface: a
    // top-level declaration the checker resolves as a module export, or a
    // direct member of such a declaration (a method/property of an exported
    // class or interface). This set is recomputed per source file below.
    let exportedDeclarations = new Set<Node>();
    const isExported = (node: Node): boolean => exportedDeclarations.has(node) || (node.parent !== undefined && exportedDeclarations.has(node.parent));
    const nodeKey = (node: Node): string => `${relativePath(node.getSourceFile().fileName)}:${node.getStart(node.getSourceFile())}`;
    const nameOf = (node: Node): string | undefined => {
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
      const id = stableId(kind, path, start, name);
      const existing = entityById.get(id);
      if (existing !== undefined) return existing;
      const inferredType = kind === "parameter" || !isExported(node) ? undefined : typeOf(node);
      const entity: JsTsEntity = { id, name, kind, universal_kind: universalKind, path, start, end, ...(parent === undefined ? {} : { parent_id: parent.id, qualified_name: `${parent.qualified_name ?? parent.name}.${name}` }), ...(inferredType === undefined ? {} : { type: inferredType }) };
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
    for (const file of sourceFiles) {
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
        entities.push(moduleEntity);
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
    // Runs the identical symbol-resolution steps as `targetForNode`, but
    // reports only whether the checker resolved `node` to SOME real
    // declaration -- in or out of the frozen project -- rather than whether
    // that declaration happens to be one of our own tracked entities. A call
    // target resolving to a declaration outside the frozen project (a
    // library function, a DOM/Node built-in, an ambient `.d.ts` type, ...)
    // is an expected analysis boundary, not a coverage gap -- the same
    // reasoning the import/export handling above already applies ("an
    // unresolved bare specifier is an ordinary external dependency, not a
    // closure gap"). Used below to keep `jsts:unresolved_call` honest: it
    // should fire only when the checker could not establish ANY call
    // target at all (e.g. dynamic dispatch through an `any`/computed
    // expression), never merely because the resolved target is external.
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
      relations.push({ id: `${JAVASCRIPT_TYPESCRIPT_NAMESPACE}:${kind}:${path}:${start}:${end}:${source.id}:${target?.id ?? "unresolved"}`, kind: `core:${kind}`, source_id: source.id, ...(target === undefined ? {} : { target_id: target.id }), path, start, end, classification });
      // Closure edges are derived from EVERY cross-file relation this
      // analyzer ever emits (not only "core:import"/"core:export"): a
      // "core:call"/"core:references"/"core:inherits"/"core:implements"
      // relation can legitimately target a file reached only through
      // re-exports or checker-resolved aliasing, not a literal import
      // statement in `path` itself. Deriving closure edges here, in the one
      // function every relation kind funnels through, is what makes the
      // closure a guaranteed superset of everything `crossArtifactDependencies`
      // (`packages/plugin-javascript-typescript/src/fact-delta.ts`) will ever
      // need to resolve for a delta built from this file -- rather than a
      // narrower, import-statement-only view that could miss a target.
      if (target !== undefined && target.path !== path) {
        const edges = directImportEdges.get(path) ?? new Set<string>();
        edges.add(target.path);
        directImportEdges.set(path, edges);
      }
    };
    const walk = (node: Node): void => {
      if (isImportDeclaration(node) || isExportDeclaration(node)) {
        const specifier = (node as Node & { readonly moduleSpecifier?: Node }).moduleSpecifier;
        if (specifier !== undefined) {
          const sourceModule = moduleByPath.get(relativePath(node.getSourceFile().fileName));
          const targetModule = moduleTarget(specifier);
          if (sourceModule !== undefined) {
            relate(isImportDeclaration(node) ? "import" : "export", sourceModule, targetModule, node, targetModule === undefined ? "possible" : "confirmed");
            if (targetModule === undefined) {
              // An unresolved specifier only makes this file's closure
              // untrustworthy if it looked like it should have resolved
              // locally (relative to this file, i.e. within the scanned
              // corpus) -- an unresolved bare specifier (a package name) is
              // an ordinary external dependency, not a closure gap. Likewise
              // a relative specifier naming a non-source ASSET (a .woff2
              // font, a .json locale, a stylesheet, an image): such a file
              // can never be part of this analyzer's corpus, so its content
              // can never affect any analysis output, and treating it as a
              // gap is not merely pointless but actively harmful --
              // incompleteness propagates transitively, and one widely
              // imported module with a font import (measured: App.tsx on a
              // real 665-file repository) poisoned 380/665 files' closures,
              // defeating both affected-owner narrowing and the incremental
              // analysis session's re-walk narrowing on every edit.
              const specifierText = (specifier as Node & { readonly text?: string }).text;
              if (typeof specifierText === "string" && specifierText.startsWith(".") && !relativeAssetSpecifier(specifierText)) incompleteClosureFiles.add(sourceModule.path);
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
        // `ownerAt` only returns entities whose `universal_kind` is
        // `core:callable` (function/method/constructor/accessor
        // declarations) -- a call at module top level, or nested inside a
        // `const foo = () => {...}`/function-expression initializer (whose
        // entity is `core:value`, since arrow/function expressions are not
        // separately entity-tracked), climbs past every ancestor without
        // ever finding one, so `owner` is `undefined` and the entire call
        // edge used to be dropped silently (Bug Group 4.1). Falling back to
        // the owning MODULE entity -- exactly the fallback the sibling
        // `core:references` handling above already uses for its `source`
        // -- keeps every call site attributable to something, at the cost
        // of attributing nested-in-value-initializer calls to the module
        // rather than to the (untracked) arrow/function-expression itself.
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
          // `declarationResolved` is true when the checker DID establish a
          // real call target, just one outside the frozen project (a library
          // call, a built-in, ...) -- see `hasResolvedDeclaration`'s doc
          // comment. Only the genuine "no target at all" case is worth
          // flagging as incomplete `core:call_relationships` coverage;
          // otherwise ordinary code (which calls out to its runtime and
          // dependencies constantly) would always read back as "partial".
          if (target === undefined && !declarationResolved) diagnostics.push({ code: "jsts:unresolved_call", message: "The TypeScript checker could not establish a unique call target.", path: relativePath(node.getSourceFile().fileName), start: node.getStart(node.getSourceFile()), end: node.getEnd() });
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
    for (const file of sourceFiles) {
      const source = program.getSourceFile(virtualPath(file.path));
      if (source !== undefined) walk(source);
      if (/\b(?:eval|Function)\s*\(/u.test(file.text)) diagnostics.push({ code: "jsts:dynamic_runtime_code", message: "Runtime code generation is not statically resolvable.", path: file.path });
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
    const diagnosticText = (message: unknown): string => typeof message === "string" ? message : message !== null && typeof message === "object" && "text" in message ? diagnosticText((message as { text: unknown }).text) : String(message);
    for (const diagnostic of [...program.getSyntacticDiagnostics(), ...program.getBindDiagnostics(), ...program.getSemanticDiagnostics()]) {
      if (diagnostic.fileName === undefined || !rootNames.includes(relativePath(diagnostic.fileName))) continue;
      diagnostics.push({ code: "jsts:compiler_diagnostic", compiler_code: diagnostic.code, message: diagnosticText(diagnostic.text), path: relativePath(diagnostic.fileName), start: diagnostic.pos, end: diagnostic.end });
    }
    entities.sort((left, right) => left.id.localeCompare(right.id));
    relations.sort((left, right) => left.id.localeCompare(right.id));
    diagnostics.sort((left, right) => `${left.path}\0${left.start ?? -1}\0${left.code}`.localeCompare(`${right.path}\0${right.start ?? -1}\0${right.code}`));
    // Reduce the direct import/export edges collected during `walk`, above,
    // into a transitive closure per scanned file: a plain reachability
    // search over `directImportEdges`, always including the file itself.
    // Incompleteness propagates transitively -- if any file reachable from
    // `file.path` (including itself) had an unresolved local-looking
    // specifier, `file.path`'s own closure cannot be trusted either, since
    // whatever that unresolved import would have pulled in is invisible to
    // this search.
    const dependencyClosures: Record<string, JsTsDependencyClosure> = {};
    for (const file of sourceFiles) {
      const visited = new Set<string>([file.path]);
      const stack = [file.path];
      let complete = true;
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (incompleteClosureFiles.has(current)) complete = false;
        for (const next of directImportEdges.get(current) ?? []) {
          if (!visited.has(next)) { visited.add(next); stack.push(next); }
        }
      }
      dependencyClosures[file.path] = { files: [...visited].sort(), complete };
    }
    return { language: rootNames.some((path) => languageForPath(path) === "javascript") && !rootNames.some((path) => languageForPath(path) === "typescript") ? "javascript" : "typescript", entities, relations, diagnostics, complete: diagnostics.length === 0, dependency_closures: dependencyClosures };
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

/** A mutable, in-memory `FileSystem` for the TS 7 API backed directly by a
 * `Map<virtual path, text>` -- unlike `createVirtualFileSystem` (immutable,
 * snapshotted once at construction), later `map.set(...)` calls are visible
 * to the API on its NEXT `updateSnapshot({fileChanges:...})`, which is what
 * lets a session apply a content-only edit without rebuilding the API or
 * its underlying Go-server project state. Directory listings are computed
 * once from the map's INITIAL keys: a session never adds or removes map
 * entries after construction (root-set changes always rebuild via a brand
 * new map instead), so a static listing stays correct for this map's whole
 * lifetime. */
function createMutableFileSystem(map: Map<string, string>): FileSystem {
  const directories = new Set<string>();
  for (const path of map.keys()) {
    let directory = path;
    while (directory.includes("/")) {
      directory = directory.slice(0, directory.lastIndexOf("/"));
      if (directory.length > 0) directories.add(directory);
    }
  }
  return {
    fileExists: (fileName) => map.has(fileName),
    directoryExists: (directoryName) => directories.has(directoryName),
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
    readFile: (fileName) => map.get(fileName),
    realpath: (path) => path,
    getAccessibleEntries: (directoryName) => {
      // `undefined` (not an empty listing) for a directory outside this
      // map's own tree -- matches `createVirtualFileSystem`'s behavior,
      // letting the real filesystem's own directory listing take over for
      // anything this virtual workspace doesn't itself contain.
      if (!directories.has(directoryName)) return undefined;
      const files: string[] = [];
      const subdirectories = new Set<string>();
      for (const path of map.keys()) {
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
 * Runs `analyzeProject`'s pass-1 (entity collection) + pass-2 (relation/walk
 * diagnostics) + per-file compiler diagnostics over exactly
 * `filesToProcess`, against an already-built `project`'s live program and
 * checker. This is intentionally a near-verbatim copy of `analyzeProject`'s
 * own walk logic (not a refactor of it -- `analyzeProject` must stay
 * byte-for-byte unchanged) generalized to a restricted file set:
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
}): JsTsWalkPassOutput {
  const { project, virtualRoot, filesToProcess, entityByNode, entityById, moduleByPath } = params;
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
    const id = stableId(kind, path, start, name);
    const existing = entityById.get(id);
    if (existing !== undefined) return existing;
    const inferredType = kind === "parameter" || !isExported(node) ? undefined : typeOf(node);
    const entity: JsTsEntity = { id, name, kind, universal_kind: universalKind, path, start, end, ...(parent === undefined ? {} : { parent_id: parent.id, qualified_name: `${parent.qualified_name ?? parent.name}.${name}` }), ...(inferredType === undefined ? {} : { type: inferredType }) };
    pushTo(entitiesByFile, path, entity);
    entityById.set(id, entity);
    entityByNode.set(nodeKey(node), entity);
    if (parent !== undefined) pushTo(relationsByFile, path, { id: `${JAVASCRIPT_TYPESCRIPT_NAMESPACE}:contains:${parent.id}:${entity.id}`, kind: "core:contains", source_id: parent.id, target_id: entity.id, path, start, end, classification: "confirmed" });
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
    if (target !== undefined && target.path !== path) {
      const edges = directEdgesByFile.get(path) ?? new Set<string>();
      edges.add(target.path);
      directEdgesByFile.set(path, edges);
    }
  };
  const walk = (node: Node): void => {
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
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
 * Global, order-independent merge step shared by a session's full and
 * incremental builds: flattens per-file entity/relation/diagnostic maps
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
  private fileMap: Map<string, string> | undefined;
  private everBuilt = false;
  private rootNames: readonly string[] = [];
  private compilerOptionsSnapshot: Readonly<Record<string, unknown>> = {};
  private memo = new Map<string, JsTsFileMemo>();

  /**
   * `analyze` decides, on every call, whether the given inputs can take the
   * incremental path (this session already built or was seeded, root_names
   * and compiler_options are unchanged, and no more than
   * `INCREMENTAL_CHANGE_RATIO_BAILOUT` of root files changed content) or
   * must take a full rebuild (first call ever, a root-set change, a
   * `compiler_options` change, or the bailout ratio).
   */
  analyze(input: { readonly files: readonly AnalyzerFile[]; readonly root_names?: readonly string[]; readonly compiler_options?: Readonly<Record<string, unknown>> }): JsTsSessionAnalyzeResult {
    const rootNames = [...(input.root_names ?? input.files.map((file) => file.path).filter((path) => languageForPath(path) !== undefined))].sort();
    const sourceFiles = input.files.filter((candidate) => rootNames.includes(candidate.path)).sort((left, right) => left.path.localeCompare(right.path));
    const hasJavaScript = rootNames.some((path) => languageForPath(path) === "javascript");
    const compilerOptions = { ...(hasJavaScript ? { allowJs: true, checkJs: true } : {}), ...(input.compiler_options ?? {}) };

    if (!this.everBuilt) return this.fullBuildResult(sourceFiles, rootNames, compilerOptions);
    if (!sameStringArray(this.rootNames, rootNames)) return this.fullBuildResult(sourceFiles, rootNames, compilerOptions);
    if (stableOptionsJson(this.compilerOptionsSnapshot) !== stableOptionsJson(compilerOptions)) return this.fullBuildResult(sourceFiles, rootNames, compilerOptions);

    const changedPaths = new Set<string>();
    for (const file of sourceFiles) {
      const memo = this.memo.get(file.path);
      if (memo === undefined || memo.content_hash !== fileContentDigest(file.text)) changedPaths.add(file.path);
    }
    if (rootNames.length > 0 && changedPaths.size / rootNames.length > INCREMENTAL_CHANGE_RATIO_BAILOUT) return this.fullBuildResult(sourceFiles, rootNames, compilerOptions);

    return this.buildIncremental(sourceFiles, rootNames, compilerOptions, changedPaths);
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
  }

  /** Disposes any live checker/API (killing the Go server child) and resets
   * this session to never-built state. Safe to call on an unbuilt/already
   * seeded-only session. */
  close(): void {
    this.api?.close();
    this.api = undefined;
    this.fileMap = undefined;
    this.memo = new Map();
    this.everBuilt = false;
    this.rootNames = [];
    this.compilerOptionsSnapshot = {};
  }

  private fullBuildResult(sourceFiles: readonly AnalyzerFile[], rootNames: readonly string[], compilerOptions: Readonly<Record<string, unknown>>): JsTsSessionAnalyzeResult {
    const result = this.buildFull(sourceFiles, rootNames, compilerOptions);
    return { result, build: "full", rewalked: sourceFiles.map((file) => file.path) };
  }

  /** Full whole-project rebuild: closes any live API and constructs a brand
   * new mutable-FS-backed one, discarding the entire previous memo. Mirrors
   * `analyzeProject`'s own construction sequence exactly (same virtual
   * config shape, same `updateSnapshot({openProjects:[...]})` call), just
   * over a mutable rather than immutable `FileSystem`, so this session can
   * keep applying incremental edits to it afterwards. */
  private buildFull(sourceFiles: readonly AnalyzerFile[], rootNames: readonly string[], compilerOptions: Readonly<Record<string, unknown>>): JsTsAnalysisResult {
    this.api?.close();
    this.api = undefined;
    this.fileMap = undefined;
    const virtualRoot = SESSION_VIRTUAL_ROOT;
    const configPath = `${virtualRoot}/${SESSION_CONFIG_FILE}`;
    const map = new Map<string, string>(sourceFiles.map((file) => [`${virtualRoot}/${file.path}`, file.text]));
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
      const walkOutput = walkFiles({ project, virtualRoot, filesToProcess: sourceFiles, entityByNode, entityById, moduleByPath });
      const analysis = assembleAnalysis(sourceFiles, rootNames, walkOutput.entitiesByFile, walkOutput.relationsByFile, walkOutput.diagnosticsByFile, walkOutput.directEdgesByFile, walkOutput.directIncompleteFiles, entityById);
      const memo = new Map<string, JsTsFileMemo>();
      for (const file of sourceFiles) {
        // Hash warm-up: the program/AST is right here, so pay this cost once
        // per file now rather than leaving it to the first future edit. This
        // is what lets THAT edit's `buildIncremental` gate be capable from
        // the very first post-full-scan call.
        const source = project.program.getSourceFile(`${virtualRoot}/${file.path}`);
        const { semantic_hash, guard_hash } = computeSemanticHashes(file.text, source === undefined ? [] : collectOpaqueSpans(file.text, source), languageForPath(file.path) === "javascript");
        memo.set(file.path, {
          content_hash: fileContentDigest(file.text),
          closure_files: analysis.dependency_closures[file.path]?.files ?? [file.path],
          closure_complete: analysis.dependency_closures[file.path]?.complete ?? false,
          entities: walkOutput.entitiesByFile.get(file.path) ?? [],
          relations: walkOutput.relationsByFile.get(file.path) ?? [],
          diagnostics: walkOutput.diagnosticsByFile.get(file.path) ?? [],
          direct_edges: walkOutput.directEdgesByFile.get(file.path) ?? [],
          semantic_hash,
          guard_hash,
        });
      }
      this.memo = memo;
      this.api = api;
      this.fileMap = map;
      this.rootNames = rootNames;
      this.compilerOptionsSnapshot = compilerOptions;
      this.everBuilt = true;
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
  private buildIncremental(sourceFiles: readonly AnalyzerFile[], rootNames: readonly string[], compilerOptions: Readonly<Record<string, unknown>>, changedPaths: ReadonlySet<string>): JsTsSessionAnalyzeResult {
    const virtualRoot = SESSION_VIRTUAL_ROOT;
    const configPath = `${virtualRoot}/${SESSION_CONFIG_FILE}`;
    const virtualPath = (path: string): string => `${virtualRoot}/${path}`;
    const filesByPath = new Map(sourceFiles.map((file) => [file.path, file]));
    let freshApi = false;
    if (this.api === undefined || this.fileMap === undefined) {
      const map = new Map<string, string>(sourceFiles.map((file) => [`${virtualRoot}/${file.path}`, file.text]));
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
        if (memo === undefined || !memo.closure_complete || changedPaths.has(file.path)) phase1Set.add(file.path);
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
      const phase1Output = walkFiles({ project, virtualRoot, filesToProcess: phase1Files, entityByNode: entityByNode1, entityById: entityById1, moduleByPath: moduleByPath1 });

      // Gate: only `changedPaths` files can be impactful -- the other
      // phase-1 members (incomplete-closure files) never themselves widen
      // the rewalk, they just always re-walk their OWN output.
      const impactful = new Set<string>();
      const freshHashesByPath = new Map<string, { readonly semantic_hash: string; readonly guard_hash: string }>();
      for (const path of changedPaths) {
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
      if (impactful.size > 0) {
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
        phase2Output = walkFiles({ project, virtualRoot, filesToProcess: dFiles, entityByNode: entityByNode2, entityById: entityById2, moduleByPath: moduleByPath2 });
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
      const analysis = assembleAnalysis(sourceFiles, rootNames, entitiesByFile, relationsByFile, diagnosticsByFile, finalDirectEdgesByFile, directIncompleteFiles, entityByIdFinal);

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
            direct_edges: walkOutput.directEdgesByFile.get(file.path) ?? [],
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
      const rewalked = [...phase1Set, ...D].sort((left, right) => left.localeCompare(right));
      return { result: analysis, build: "incremental", rewalked, impactful_changed_paths: [...impactful].sort((left, right) => left.localeCompare(right)) };
    } finally {
      project?.checker.dispose();
    }
  }
}
