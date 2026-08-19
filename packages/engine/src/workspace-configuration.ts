import { createHash } from "node:crypto";
import type { PluginStructuralStageDeclaration } from "@urdira/contracts";

export type WorkspaceTechnologyKind = "language" | "framework";
export type WorkspaceConfigurationImpact = "query_only" | "analysis" | "source_selection" | "plugin_resolution" | "semantic_projection";

export interface WorkspaceDetectionFile {
  readonly path: string;
  readonly content?: string;
}

export interface WorkspacePluginCatalogEntry {
  readonly plugin_id: string;
  readonly plugin_version: string;
  readonly namespace: string;
  readonly language_ids: ReadonlyArray<string>;
  readonly package_digest: string;
  readonly analysis_digest: string;
  readonly verified: boolean;
  readonly structural_stage_definitions?: ReadonlyArray<PluginStructuralStageDeclaration>;
}

export interface WorkspaceDetectionInput {
  readonly provider_fingerprint: string;
  readonly git_state_fingerprint: string;
  readonly plugin_catalog_fingerprint: string;
  readonly files: ReadonlyArray<WorkspaceDetectionFile>;
  readonly plugin_catalog?: ReadonlyArray<WorkspacePluginCatalogEntry>;
}

export interface WorkspaceTechnologyEvidence {
  readonly path: string;
  readonly rule: string;
  readonly value?: string;
}

export interface WorkspaceTechnologyProposalItem {
  readonly technology_id: string;
  readonly kind: WorkspaceTechnologyKind;
  readonly confidence: number;
  readonly evidence: ReadonlyArray<WorkspaceTechnologyEvidence>;
  readonly compatible_plugin_ids: ReadonlyArray<string>;
}

export interface WorkspaceTechnologyProposal {
  readonly proposal_fingerprint: string;
  readonly provider_fingerprint: string;
  readonly git_state_fingerprint: string;
  readonly plugin_catalog_fingerprint: string;
  readonly technologies: ReadonlyArray<WorkspaceTechnologyProposalItem>;
}

export interface WorkspaceConfigurationProposal {
  readonly proposal_id: string;
  readonly workspace_root: string;
  readonly proposal_fingerprint: string;
  readonly technology_proposal: WorkspaceTechnologyProposal;
  readonly selected_technology_ids: ReadonlyArray<string>;
  readonly selected_plugin_ids: ReadonlyArray<string>;
  readonly phase: "technology" | "plugins" | "confirmed" | "stale";
}

export interface WorkspaceConfigurationAttemptRecord {
  readonly attempt_id: string;
  readonly workspace_id: string;
  readonly impact: WorkspaceConfigurationImpact;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly issues: ReadonlyArray<{ readonly code: "invalid_config" | "stale_proposal" | "plugin_unavailable" | "plugin_incompatible" | "technology_unconfirmed" | "reindex_required"; readonly severity: "info" | "warning" | "error"; readonly message: string }>;
  readonly started_at: string;
  readonly completed_at?: string;
}

export interface WorkspaceConfigurationCoordinatorOptions {
  readonly create_id?: (kind: "proposal" | "attempt") => string;
  readonly now?: () => string;
}

const extensionRules: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/\.(?:ts|mts|cts)$/i, "typescript", "extension.typescript"],
  [/\.(?:tsx)$/i, "typescript", "extension.typescript"],
  [/\.(?:js|mjs|cjs)$/i, "javascript", "extension.javascript"],
  [/\.(?:jsx)$/i, "javascript", "extension.javascript"],
  [/\.py$/i, "python", "extension.python"],
  [/\.rs$/i, "rust", "extension.rust"],
  [/\.go$/i, "go", "extension.go"],
  [/\.java$/i, "java", "extension.java"],
];

const manifestFrameworkRules: ReadonlyArray<readonly [string, string, string]> = [
  ["next", "next", "manifest.package.next"],
  ["react", "react", "manifest.package.react"],
  ["vue", "vue", "manifest.package.vue"],
  ["@angular/core", "angular", "manifest.package.angular"],
  ["svelte", "svelte", "manifest.package.svelte"],
  ["express", "express", "manifest.package.express"],
];

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function addEvidence(map: Map<string, WorkspaceTechnologyProposalItem>, technologyId: string, kind: WorkspaceTechnologyKind, evidence: WorkspaceTechnologyEvidence): void {
  const previous = map.get(technologyId);
  if (previous) {
    map.set(technologyId, { ...previous, confidence: Math.max(previous.confidence, 0.9), evidence: [...previous.evidence, evidence] });
    return;
  }
  map.set(technologyId, { technology_id: technologyId, kind, confidence: 0.8, evidence: [evidence], compatible_plugin_ids: [] });
}

function parsePackageManifest(file: WorkspaceDetectionFile): Readonly<Record<string, unknown>> | undefined {
  if (!/(^|\/)package\.json$/u.test(file.path) || file.content === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(file.content);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Readonly<Record<string, unknown>> : undefined;
  } catch {
    return undefined;
  }
}

function packageNames(manifest: Readonly<Record<string, unknown>>): ReadonlySet<string> {
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const value = manifest[field];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) for (const name of Object.keys(value)) names.add(name);
  }
  return names;
}

export function detectWorkspaceTechnologies(input: WorkspaceDetectionInput): WorkspaceTechnologyProposal {
  const technologies = new Map<string, WorkspaceTechnologyProposalItem>();
  const files = [...input.files].sort((left, right) => left.path.localeCompare(right.path));
  for (const file of files) {
    for (const [pattern, technologyId, rule] of extensionRules) if (pattern.test(file.path)) addEvidence(technologies, technologyId, "language", { path: file.path, rule });
    const manifest = parsePackageManifest(file);
    if (!manifest) continue;
    for (const [packageName, technologyId, rule] of manifestFrameworkRules) {
      if (packageNames(manifest).has(packageName)) addEvidence(technologies, technologyId, "framework", { path: file.path, rule, value: packageName });
    }
  }
  for (const file of files) {
    if (/(^|\/)(?:tsconfig|jsconfig)\.json$/u.test(file.path)) {
      const technologyId = file.path.toLocaleLowerCase("en-US").includes("jsconfig") ? "javascript" : "typescript";
      addEvidence(technologies, technologyId, "language", { path: file.path, rule: "project.configuration" });
    }
  }
  const catalog = input.plugin_catalog ?? [];
  const compatible = (technologyId: string): ReadonlyArray<string> => catalog
    .filter((plugin) => plugin.verified && plugin.language_ids.includes(technologyId))
    .map((plugin) => plugin.plugin_id)
    .sort();
  const ordered = [...technologies.values()].sort((left, right) => left.technology_id.localeCompare(right.technology_id)).map((technology) => ({
    ...technology,
    evidence: [...technology.evidence].sort((left, right) => `${left.path}\0${left.rule}`.localeCompare(`${right.path}\0${right.rule}`)),
    compatible_plugin_ids: compatible(technology.technology_id),
  }));
  const identity = { provider_fingerprint: input.provider_fingerprint, git_state_fingerprint: input.git_state_fingerprint, plugin_catalog_fingerprint: input.plugin_catalog_fingerprint, technologies: ordered };
  return { ...identity, proposal_fingerprint: digest(identity) };
}

function normalized(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalized).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${normalized((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function classifyWorkspaceConfigurationImpact(previous: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>): WorkspaceConfigurationImpact {
  if (normalized(previous["plugins"]) !== normalized(next["plugins"])) return "plugin_resolution";
  if (normalized(previous["source_selection"]) !== normalized(next["source_selection"])) return "source_selection";
  if (normalized(previous["semantic_profile"]) !== normalized(next["semantic_profile"])) return "semantic_projection";
  if (normalized(previous["analysis"]) !== normalized(next["analysis"])) return "analysis";
  return "query_only";
}

export class WorkspaceConfigurationCoordinator {
  private readonly proposals = new Map<string, WorkspaceConfigurationProposal>();
  private readonly attempts = new Map<string, WorkspaceConfigurationAttemptRecord>();
  private readonly createId: (kind: "proposal" | "attempt") => string;
  private readonly clock: () => string;

  constructor(options: WorkspaceConfigurationCoordinatorOptions = {}) {
    this.createId = options.create_id ?? ((kind) => `${kind}:${cryptoRandom()}`);
    this.clock = options.now ?? (() => new Date().toISOString());
  }

  preview(input: WorkspaceDetectionInput & { readonly workspace_root: string }): WorkspaceConfigurationProposal {
    const technologyProposal = detectWorkspaceTechnologies(input);
    const proposal: WorkspaceConfigurationProposal = {
      proposal_id: this.createId("proposal"),
      workspace_root: input.workspace_root,
      proposal_fingerprint: technologyProposal.proposal_fingerprint,
      technology_proposal: technologyProposal,
      selected_technology_ids: [],
      selected_plugin_ids: [],
      phase: "technology",
    };
    this.proposals.set(proposal.proposal_id, proposal);
    return proposal;
  }

  confirmTechnologies(proposalId: string, technologyIds: ReadonlyArray<string>, current: WorkspaceDetectionInput): WorkspaceConfigurationProposal {
    const proposal = this.requireFreshProposal(proposalId, current);
    const known = new Set(proposal.technology_proposal.technologies.map((technology) => technology.technology_id));
    if (technologyIds.some((technologyId) => !known.has(technologyId))) throw new Error("Unknown technology selection.");
    const next = { ...proposal, selected_technology_ids: [...new Set(technologyIds)].sort(), phase: "plugins" as const };
    this.proposals.set(proposalId, next);
    return next;
  }

  confirmPlugins(proposalId: string, pluginIds: ReadonlyArray<string>, current: WorkspaceDetectionInput): WorkspaceConfigurationProposal {
    const proposal = this.requireFreshProposal(proposalId, current);
    if (proposal.phase !== "plugins") throw new Error("Technology confirmation must precede plugin confirmation.");
    const next = { ...proposal, selected_plugin_ids: [...new Set(pluginIds)].sort(), phase: "confirmed" as const };
    this.proposals.set(proposalId, next);
    return next;
  }

  applyConfigDocument(workspaceId: string, document: string, activeConfiguration: Readonly<Record<string, unknown>>): { readonly applied: boolean; readonly configuration: Readonly<Record<string, unknown>>; readonly attempt: WorkspaceConfigurationAttemptRecord } {
    let parsed: unknown;
    try { parsed = JSON.parse(document); } catch {
      return this.failedAttempt(workspaceId, activeConfiguration, "invalid_config", "The workspace configuration document is not valid JSON.");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return this.failedAttempt(workspaceId, activeConfiguration, "invalid_config", "The workspace configuration root must be a JSON object.");
    const configuration = parsed as Readonly<Record<string, unknown>>;
    const attempt = this.newAttempt(workspaceId, activeConfiguration, configuration);
    this.attempts.set(attempt.attempt_id, attempt);
    return { applied: true, configuration, attempt };
  }

  latestAttempt(workspaceId: string): WorkspaceConfigurationAttemptRecord | undefined {
    return [...this.attempts.values()].filter((attempt) => attempt.workspace_id === workspaceId).sort((left, right) => right.started_at.localeCompare(left.started_at))[0];
  }

  private requireFreshProposal(proposalId: string, current: WorkspaceDetectionInput): WorkspaceConfigurationProposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error("Unknown workspace configuration proposal.");
    const currentProposal = detectWorkspaceTechnologies(current);
    if (currentProposal.proposal_fingerprint !== proposal.proposal_fingerprint) {
      const stale = { ...proposal, phase: "stale" as const };
      this.proposals.set(proposalId, stale);
      throw new Error("Workspace configuration proposal is stale; repeat detection before confirming.");
    }
    return proposal;
  }

  private newAttempt(workspaceId: string, previous: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>): WorkspaceConfigurationAttemptRecord {
    return { attempt_id: this.createId("attempt"), workspace_id: workspaceId, impact: classifyWorkspaceConfigurationImpact(previous, next), configuration: next, issues: [], started_at: this.clock(), completed_at: this.clock() };
  }

  private failedAttempt(workspaceId: string, activeConfiguration: Readonly<Record<string, unknown>>, code: "invalid_config" | "stale_proposal" | "plugin_unavailable" | "plugin_incompatible" | "technology_unconfirmed" | "reindex_required", message: string): { readonly applied: false; readonly configuration: Readonly<Record<string, unknown>>; readonly attempt: WorkspaceConfigurationAttemptRecord } {
    const attempt: WorkspaceConfigurationAttemptRecord = { attempt_id: this.createId("attempt"), workspace_id: workspaceId, impact: "query_only", configuration: activeConfiguration, issues: [{ code, severity: "error", message }], started_at: this.clock(), completed_at: this.clock() };
    this.attempts.set(attempt.attempt_id, attempt);
    return { applied: false, configuration: activeConfiguration, attempt };
  }
}

function cryptoRandom(): string {
  return createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 24);
}
