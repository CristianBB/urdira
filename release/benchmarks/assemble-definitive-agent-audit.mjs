#!/usr/bin/env node
/* Assemble three immutable 15-cell audits into the selected-45 audit. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFINITIVE_MINIMUM_FREE_BYTES } from "./benchmark-cleanup.mjs";
import { DEFINITIVE_ARMS, DEFINITIVE_CELLS, DEFINITIVE_FROZEN_TASKS } from "./run-definitive-agent-campaign.mjs";

const root = fileURLToPath(new globalThis.URL("../..", import.meta.url));
const corpus = JSON.parse(readFileSync(resolve(root, "release/benchmarks/expanded-typescript-agent-benchmark.json"), "utf8"));
const expectedCellKeys = new Set(DEFINITIVE_CELLS.flatMap(([repository, task]) => DEFINITIVE_ARMS.map((arm) => `${repository}/${task}/${arm}`)));
const expectedProbeKeys = new Set(DEFINITIVE_CELLS.flatMap(([repository]) => ["cold", "warm"].map((phase) => `${repository}/${phase}`)));

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const digestFile = (path) => typeof path === "string" && existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
const isDigest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const requireArchiveBinding = (binding, label) => {
  if (binding?.status !== "passed" || !isDigest(binding?.archive?.sha256)) throw new Error(`${label} has no complete passed release binding`);
  return binding.archive.sha256;
};

function campaignNumber(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3) throw new Error(`${label} campaign must be 1, 2, or 3`);
  return value;
}

function validateCell(run, campaign) {
  const repositoryId = run.repository_id ?? run.repository;
  const taskId = run.task_id ?? run.task;
  const key = `${repositoryId}/${taskId}/${run.arm}`;
  const frozen = DEFINITIVE_FROZEN_TASKS[repositoryId];
  const corpusRepository = corpus.repositories.find((entry) => entry.id === repositoryId);
  const task = corpusRepository?.tasks.find((entry) => entry.id === taskId);
  if (!expectedCellKeys.has(key) || frozen === undefined || corpusRepository === undefined || task === undefined) throw new Error(`unexpected definitive cell ${key}`);
  const promptSha = createHash("sha256").update(task.prompt).digest("hex");
  if (run.commit !== frozen.commit || promptSha !== frozen.prompt_sha256 || run.prompt_sha256 !== undefined && run.prompt_sha256 !== promptSha) throw new Error(`frozen cell drifted ${key}`);
  if (run.campaign !== campaign) throw new Error(`cell ${key} has campaign ${run.campaign}, expected ${campaign}`);
  const manifest = run.manifest;
  if (manifest === null || typeof manifest !== "object") throw new Error(`cell ${key} has no execution manifest`);
  if (manifest.model !== corpus.model || manifest.node !== "v24.18.1" || manifest.protocol !== "definitive-selected-v1" || manifest.phase !== "warm" || manifest.model_invoked !== true) throw new Error(`cell ${key} execution manifest is outside the definitive freeze`);
  if (manifest.repository_id !== repositoryId || manifest.task_id !== taskId || manifest.commit !== frozen.commit || manifest.prompt_sha256 !== promptSha) throw new Error(`cell ${key} execution identity drifted`);
  if (run.arm === "urdira-typescript") requireArchiveBinding(manifest.release_binding, `cell ${key}`);
  return { key, raw: manifest, transcript: manifest.transcript ?? run.transcript ?? null };
}

function validateProbe(probe, campaign) {
  const key = `${probe.repository_id ?? probe.repository}/${probe.phase}`;
  if (!expectedProbeKeys.has(key) || !["cold", "warm"].includes(probe.phase)) throw new Error(`unexpected definitive readiness probe ${key}`);
  const frozen = DEFINITIVE_FROZEN_TASKS[probe.repository_id ?? probe.repository];
  const repositoryId = probe.repository_id ?? probe.repository;
  const task = corpus.repositories.find((entry) => entry.id === repositoryId)?.tasks.find((entry) => entry.id === frozen?.task);
  if (frozen === undefined || task === undefined || probe.commit !== frozen.commit || probe.prompt_sha256 !== frozen.prompt_sha256 || probe.task_id !== frozen.task || probe.campaign !== campaign || probe.node_version !== "v24.18.1" || probe.model_invoked !== false || probe.semantic_index !== false || probe.semantic_materialization !== false) throw new Error(`readiness freeze drifted ${key}`);
  return { key, raw: probe };
}

export function assembleDefinitiveAudit({ campaignAuditPaths, readinessManifestPaths, outputPath }) {
  if (!Array.isArray(campaignAuditPaths) || campaignAuditPaths.length !== 3 || !Array.isArray(readinessManifestPaths) || readinessManifestPaths.length !== 3) throw new Error("exactly three campaign audits and three readiness manifests are required");
  const audits = campaignAuditPaths.map(readJson);
  const readinessManifests = readinessManifestPaths.map(readJson);
  const campaigns = audits.map((audit) => campaignNumber(audit.campaign, "audit"));
  const readinessCampaigns = readinessManifests.map((manifest) => campaignNumber(manifest.campaign, "readiness"));
  if (new Set(campaigns).size !== 3 || new Set(readinessCampaigns).size !== 3 || campaigns.some((campaign) => !readinessCampaigns.includes(campaign))) throw new Error("campaign ids must be the distinct matching set 1, 2, 3");
  const runs = [];
  const readinessProbes = [];
  const seenCells = new Set();
  const seenProbes = new Set();
  const archiveDigests = new Set();
  for (const audit of audits) {
    if (audit.definitive_protocol !== "selected-15" || Number(audit.expected_runs) !== 15 || !Array.isArray(audit.runs) || audit.runs.length !== 15) throw new Error(`campaign ${audit.campaign} is not a complete selected-15 audit`);
    if (audit.minimum_free_bytes !== DEFINITIVE_MINIMUM_FREE_BYTES) throw new Error(`campaign ${audit.campaign} has no frozen free-space guard`);
    const archiveSha = requireArchiveBinding(audit.release_binding, `campaign ${audit.campaign}`);
    archiveDigests.add(archiveSha);
    for (const run of audit.runs) {
      const cell = validateCell(run, audit.campaign);
      const campaignCellKey = `${audit.campaign}/${cell.key}`;
      if (seenCells.has(campaignCellKey)) throw new Error(`duplicate definitive cell ${campaignCellKey}`);
      seenCells.add(campaignCellKey);
      const transcriptSha = digestFile(cell.transcript);
      const declaredTranscriptSha = cell.raw.token_counter_evidence?.transcript_sha256;
      if (declaredTranscriptSha !== null && declaredTranscriptSha !== undefined && declaredTranscriptSha !== transcriptSha) throw new Error(`cell ${cell.key} transcript hash disagrees with token evidence`);
      if (run.manifest?.completed_successfully === true && (typeof cell.transcript !== "string" || transcriptSha === null)) throw new Error(`successful cell is missing immutable transcript evidence ${cell.key}`);
      runs.push({ ...run, campaign: audit.campaign, definitive_cell_key: cell.key, raw_artifacts: { transcript: cell.transcript, transcript_sha256: transcriptSha, transcript_evidence: transcriptSha === null ? "missing" : "hashed" } });
    }
  }
  for (const manifest of readinessManifests) {
    if (manifest.definitive_protocol !== "selected-6" || Number(manifest.readiness_expected_probes) !== 6 || !Array.isArray(manifest.probes) || manifest.probes.length !== 6) throw new Error(`campaign ${manifest.campaign} is not a complete selected-6 readiness manifest`);
    if (manifest.minimum_free_bytes !== DEFINITIVE_MINIMUM_FREE_BYTES) throw new Error(`readiness campaign ${manifest.campaign} has no frozen free-space guard`);
    archiveDigests.add(requireArchiveBinding(manifest.release_binding, `readiness campaign ${manifest.campaign}`));
    for (const probe of manifest.probes) {
      const normalized = validateProbe(probe, manifest.campaign);
      if (seenProbes.has(`${manifest.campaign}/${normalized.key}`)) throw new Error(`duplicate definitive readiness probe ${manifest.campaign}/${normalized.key}`);
      seenProbes.add(`${manifest.campaign}/${normalized.key}`);
      readinessProbes.push({ ...probe, campaign: manifest.campaign, definitive_probe_key: normalized.key });
    }
  }
  if (seenCells.size !== 45 || seenProbes.size !== 18) throw new Error(`selected audit completeness mismatch: ${seenCells.size} cells, ${seenProbes.size} probes`);
  if (archiveDigests.size > 1) throw new Error("campaigns are bound to different release archives");
  const output = {
    schema_version: 1,
    definitive_protocol: "selected-45",
    expected_runs: 45,
    readiness_expected_probes: 18,
    independent_campaigns: 3,
    campaigns,
    source_campaign_audits: campaignAuditPaths.map((path) => resolve(path)),
    source_readiness_manifests: readinessManifestPaths.map((path) => resolve(path)),
    source_document_digests: [
      ...campaignAuditPaths.map((path) => ({ kind: "campaign_audit", path: resolve(path), sha256: digestFile(path) })),
      ...readinessManifestPaths.map((path) => ({ kind: "readiness_manifest", path: resolve(path), sha256: digestFile(path) })),
    ],
    release_archive_sha256: archiveDigests.size === 1 ? [...archiveDigests][0] : null,
    model_invoked_by_assembler: false,
    runs,
    readiness_probes: readinessProbes,
  };
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return output;
}

async function main() {
  const argv = process.argv.slice(2);
  const values = (name) => argv.flatMap((value, index) => value === name ? [argv[index + 1]] : []).filter(Boolean);
  const output = argv[argv.indexOf("--output") + 1];
  const result = assembleDefinitiveAudit({ campaignAuditPaths: values("--campaign-audit"), readinessManifestPaths: values("--readiness-manifest"), outputPath: resolve(output) });
  process.stdout.write(`${JSON.stringify({ output, expected_runs: result.expected_runs, readiness_expected_probes: result.readiness_expected_probes, model_invoked: false })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
