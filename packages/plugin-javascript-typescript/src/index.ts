export {
  JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
  JAVASCRIPT_TYPESCRIPT_NAMESPACE,
  JAVASCRIPT_TYPESCRIPT_VERSION,
  TYPESCRIPT_COMPILER_VERSION,
  JAVASCRIPT_EXTENSIONS,
  TYPESCRIPT_EXTENSIONS,
  PROJECT_CONFIGURATION_FILES,
  JAVASCRIPT_TYPESCRIPT_CAPABILITIES,
  JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES,
  LARGE_SYNTAX_CORPUS_FILE_THRESHOLD,
  LARGE_SYNTAX_CORPUS_BYTE_THRESHOLD,
  JS_TS_IMPORT_SPECIFIER_PATTERN,
  languageForPath,
  scriptKindForPath,
  discoverProjects,
  analyzeSyntaxProject,
  analyzeBoundedSyntaxProject,
  analyzeSyntaxDependencyGraph,
  extractImportSpecifiers,
  resolveSyntaxDependencyGraph,
  isLargeSyntaxCorpus,
  analyzeProject,
  JsTsAnalysisSession,
  type AnalyzerFile,
  type DiscoveredProject,
  type JsTsAnalysisBuildKind,
  type JsTsAnalysisResult,
  type JsTsDependencyClosure,
  type JsTsDirectDependency,
  type JsTsDiagnostic,
  type JsTsEntity,
  type JsTsLanguage,
  type JsTsRelation,
  type JsTsScriptKind,
  type JsTsSessionAnalyzeResult,
} from "./analyzer.js";
export {
  createJavascriptTypescriptWorker,
  durableAnalysisCacheKey,
  largeSyntaxManifestKey,
  syntaxDependencyGraphCachePath,
  writeSyntaxDependencyGraphCache,
  type JavascriptTypescriptWorkerDescriptor,
  type JavascriptTypescriptWorkerTransport,
} from "./worker.js";
export { createJavascriptTypescriptThreadTransport, type JavascriptTypescriptThreadDescriptor } from "./thread-transport.js";
export {
  JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY,
  JSTS_SEMANTIC_PROCESS_MAX_MESSAGE_BYTES,
  JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION,
  createJavascriptTypescriptSemanticProcessTransport,
  type JavascriptTypescriptSemanticProcessDescriptor,
  type JavascriptTypescriptSemanticProcessTransport,
  type JavascriptTypescriptSemanticWorkerDescriptor,
} from "./semantic-process-transport.js";
export {
  createJavascriptTypescriptProcessTransport,
  type JavascriptTypescriptProcessDescriptor,
  type JavascriptTypescriptProcessTransport,
} from "./process-transport.js";
export {
  createIndexingCoreProcessTransport,
  type IndexingCoreProcessDescriptor,
  type IndexingCoreProcessTransport,
  type IndexGenerationRequest,
  type IndexingEvent,
} from "./indexing-core-process-transport.js";
export {
  MAX_RUST_WORKER_FRAME_CHUNK_BYTES,
  MAX_RUST_WORKER_MESSAGE_BYTES,
  RUST_WORKER_PROTOCOL_IDENTITY,
  RUST_WORKER_PROTOCOL_VERSION,
  RustWorkerFrameDecoder,
  decodeRustWorkerMessage,
  encodeRustWorkerMessage,
  type DecodedRustWorkerMessage,
  type RustWorkerFrameOptions,
} from "./rust-protocol.js";
export {
  JSTS_RUST_SYNTAX_BUILD_IDENTITY,
  RUST_SYNTAX_FACT_PAGE_MAX_BYTES,
  RUST_SYNTAX_FACT_PAGE_MAX_ROWS,
  RUST_SYNTAX_FACT_GROUP_MAX_BYTES,
  RUST_SYNTAX_FACT_GROUP_MAX_OWNERS,
  createRustSyntaxAnalyzeRequest,
  createRustSyntaxCommitAnalysisRequest,
  createRustSyntaxFactsRequest,
  createRustSyntaxFactsGroupRequest,
  createRustSyntaxHandshake,
  validateRustSyntaxWorkerMessage,
  type RustSyntaxAnalysisResult,
  type RustSyntaxAnalyzeInput,
  type RustSyntaxAnalyzeRequest,
  type RustSyntaxDirectImport,
  type RustSyntaxFactCursor,
  type RustSyntaxCommitAnalysisRequest,
  type RustSyntaxFactsRequest,
  type RustSyntaxFactsResult,
  type RustSyntaxFactsGroupRequest,
  type RustSyntaxFactsGroupResult,
  type RustSyntaxHostMessage,
  type RustSyntaxSourceInput,
  type RustSyntaxWorkerMessage,
} from "./syntax-protocol.js";
export {
  buildJavascriptTypescriptFactDelta,
  buildJavascriptTypescriptFactDeltaStream,
  buildJavascriptTypescriptNativeFactDeltaStream,
  buildJavascriptTypescriptNativeFactDeltaHeader,
  prepareJavascriptTypescriptNativeFactDeltaStream,
  prepareJavascriptTypescriptProjectedFactDeltaStream,
  prepareJavascriptTypescriptFactDeltaStream,
  javascriptTypescriptNativeProjectionOwner,
  JAVASCRIPT_TYPESCRIPT_NATIVE_PROJECTION_PROFILE,
  type PreparedJavascriptTypescriptFactDeltaStream,
  type JavascriptTypescriptFactDeltaInput,
  type JavascriptTypescriptNativeFactDeltaInput,
} from "./fact-delta.js";
export { javascriptTypescriptProposedDependencyId, javascriptTypescriptProposalRecordKey } from "./proposal-identity.js";
export { iterateNativeFactDeltaBatches, assertNativeFactDeltaBatchBudget } from "./native-batches.js";
export {
  JAVASCRIPT_TYPESCRIPT_DEPENDENCY_ROLES,
  JAVASCRIPT_TYPESCRIPT_PAYLOAD_SCHEMAS,
  JAVASCRIPT_TYPESCRIPT_RECORD_KINDS,
  createJavascriptTypescriptInstalledBundle,
  createJavascriptTypescriptRegistryContribution,
  type JavascriptTypescriptContributionInput,
  type JavascriptTypescriptPackageAsset,
  type JavascriptTypescriptNativeRuntimeInput,
} from "./registry-contribution.js";

export interface BundledPluginCatalogEntry {
  readonly plugin_id: typeof JAVASCRIPT_TYPESCRIPT_PLUGIN_ID;
  readonly plugin_version: typeof JAVASCRIPT_TYPESCRIPT_VERSION;
  readonly namespace: typeof JAVASCRIPT_TYPESCRIPT_NAMESPACE;
  readonly language_ids: readonly ["javascript", "typescript"];
  readonly package_digest: string;
  readonly analysis_digest: string;
  readonly verified: true;
  readonly structural_stage_definitions: readonly import("@urdira/contracts").PluginStructuralStageDeclaration[];
}

import { createHash } from "node:crypto";
import { JAVASCRIPT_TYPESCRIPT_NAMESPACE, JAVASCRIPT_TYPESCRIPT_PLUGIN_ID, JAVASCRIPT_TYPESCRIPT_VERSION, TYPESCRIPT_COMPILER_VERSION, JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES } from "./analyzer.js";
import { JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY as SEMANTIC_PROCESS_BUILD_IDENTITY } from "./semantic-process-transport.js";
import { JSTS_RUST_SYNTAX_BUILD_IDENTITY as RUST_SYNTAX_BUILD_IDENTITY } from "./syntax-protocol.js";

function coordinateDigest(label: string): string {
  return `sha256:${createHash("sha256").update(`${label}\0${JAVASCRIPT_TYPESCRIPT_PLUGIN_ID}\0${JAVASCRIPT_TYPESCRIPT_VERSION}\0${TYPESCRIPT_COMPILER_VERSION}\0${RUST_SYNTAX_BUILD_IDENTITY}\0${SEMANTIC_PROCESS_BUILD_IDENTITY}`).digest("hex")}`;
}

export const bundledPluginCatalogEntry: BundledPluginCatalogEntry = Object.freeze({
  plugin_id: JAVASCRIPT_TYPESCRIPT_PLUGIN_ID,
  plugin_version: JAVASCRIPT_TYPESCRIPT_VERSION,
  namespace: JAVASCRIPT_TYPESCRIPT_NAMESPACE,
  language_ids: ["javascript", "typescript"] as const,
  package_digest: coordinateDigest("package"),
  analysis_digest: coordinateDigest("analysis"),
  verified: true,
  structural_stage_definitions: JAVASCRIPT_TYPESCRIPT_STRUCTURAL_STAGES,
});
