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
  languageForPath,
  scriptKindForPath,
  discoverProjects,
  analyzeSyntaxProject,
  analyzeProject,
  JsTsAnalysisSession,
  type AnalyzerFile,
  type DiscoveredProject,
  type JsTsAnalysisBuildKind,
  type JsTsAnalysisResult,
  type JsTsDependencyClosure,
  type JsTsDiagnostic,
  type JsTsEntity,
  type JsTsLanguage,
  type JsTsRelation,
  type JsTsScriptKind,
  type JsTsSessionAnalyzeResult,
} from "./analyzer.js";
export { createJavascriptTypescriptWorker, type JavascriptTypescriptWorkerDescriptor } from "./worker.js";
export { createJavascriptTypescriptThreadTransport, type JavascriptTypescriptThreadDescriptor } from "./thread-transport.js";
export { buildJavascriptTypescriptFactDelta, type JavascriptTypescriptFactDeltaInput } from "./fact-delta.js";
export {
  JAVASCRIPT_TYPESCRIPT_DEPENDENCY_ROLES,
  JAVASCRIPT_TYPESCRIPT_PAYLOAD_SCHEMAS,
  JAVASCRIPT_TYPESCRIPT_RECORD_KINDS,
  createJavascriptTypescriptInstalledBundle,
  createJavascriptTypescriptRegistryContribution,
  type JavascriptTypescriptContributionInput,
  type JavascriptTypescriptPackageAsset,
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

function coordinateDigest(label: string): string {
  return `sha256:${createHash("sha256").update(`${label}\0${JAVASCRIPT_TYPESCRIPT_PLUGIN_ID}\0${JAVASCRIPT_TYPESCRIPT_VERSION}\0${TYPESCRIPT_COMPILER_VERSION}`).digest("hex")}`;
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
