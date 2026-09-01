import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const REFERENCE_TARGETS = Object.freeze(["darwin-arm64", "linux-x64-gnu"]);
const REQUIRED_CAMPAIGNS = 3;
const REQUIRED_INCREMENTAL_SAMPLES = 60;
const REQUIRED_VISIBLE_DIGESTS = 61;
const COLD_PHASES = Object.freeze(["runtime_load", "daemon_start", "workspace_add", "readiness", "digest"]);
const INCREMENTAL_PHASES = Object.freeze(["mutation_apply", "readiness", "digest"]);
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const L_COLD_P50_LIMIT_MS = 20 * 60 * 1_000;
const L_COLD_P95_LIMIT_MS = 50 * 60 * 1_000;
const L_INCREMENTAL_P95_LIMIT_MS = 15_000;
const L_PEAK_RSS_LIMIT_BYTES = 8 * GIB;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PLACEHOLDER_PATTERN = /^(?:unknown|unset|placeholder|todo|tbd|same|null|none)$/iu;

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function addUnknownFieldErrors(value, field, keys, errors) {
  if (!isRecord(value)) {
    errors.push(`${field} must be an object.`);
    return false;
  }
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) errors.push(`${field} contains unknown fields: ${unknown.join(", ")}.`);
  return true;
}

function requireString(value, field, errors, options = {}) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${field} must be a non-empty string.`);
    return undefined;
  }
  if (options.identifier === true && !ID_PATTERN.test(value)) errors.push(`${field} contains unsupported characters.`);
  if (options.noPlaceholder === true && PLACEHOLDER_PATTERN.test(value.trim())) errors.push(`${field} contains a placeholder value.`);
  return value;
}

function requireDigest(value, field, errors) {
  const digest = requireString(value, field, errors);
  if (digest !== undefined && !SHA256_PATTERN.test(digest)) errors.push(`${field} must be a lowercase sha256 digest.`);
  return digest;
}

function requirePositiveNumber(value, field, errors) {
  if (!(Number.isFinite(value) && value > 0)) {
    errors.push(`${field} must be a finite positive number.`);
    return undefined;
  }
  return value;
}

function requirePositiveInteger(value, field, errors) {
  if (!(Number.isSafeInteger(value) && value > 0)) {
    errors.push(`${field} must be a positive safe integer.`);
    return undefined;
  }
  return value;
}

function percentile(values, quantile) {
  if (values.length === 0 || values.some((value) => !(Number.isFinite(value) && value > 0))) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(quantile * ordered.length) - 1)];
}

function relativeImprovement(baseline, candidate) {
  if (!(Number.isFinite(baseline) && baseline > 0 && Number.isFinite(candidate) && candidate > 0)) return undefined;
  const value = (baseline - candidate) / baseline;
  return Number.isFinite(value) ? value : undefined;
}

function validateReportEnvelope(report, evidence, errors) {
  addUnknownFieldErrors(report, "report", ["schema_version", "generated_at", "harness", "campaigns", "report_digest"], errors);
  if (report.schema_version !== 2) errors.push("report.schema_version must be 2.");
  const generatedAt = requireString(report.generated_at, "report.generated_at", errors);
  if (generatedAt !== undefined && (!Number.isFinite(Date.parse(generatedAt)) || !/^\d{4}-\d{2}-\d{2}T/u.test(generatedAt))) errors.push("report.generated_at must be an ISO-8601 timestamp.");
  if (addUnknownFieldErrors(report.harness, "report.harness", ["name", "version", "controller_protocol", "runner_digest"], errors)) {
    if (report.harness.name !== "run-native-acceleration-campaign") errors.push("report.harness.name is not the native acceleration runner.");
    if (report.harness.version !== 2) errors.push("report.harness.version must be 2.");
    if (report.harness.controller_protocol !== "urdira.native-acceleration-controller.v2") errors.push("report.harness.controller_protocol is unsupported.");
    requireDigest(report.harness.runner_digest, "report.harness.runner_digest", errors);
  }
  const declaredReportDigest = requireDigest(report.report_digest, "report.report_digest", errors);
  const digestBody = Object.fromEntries(Object.entries(report).filter(([key]) => key !== "report_digest"));
  const calculatedReportDigest = sha256(JSON.stringify(stable(digestBody)));
  if (declaredReportDigest !== undefined && declaredReportDigest !== calculatedReportDigest) errors.push("report.report_digest does not match the report body with report_digest omitted.");

  if (!isRecord(evidence)) {
    errors.push("Report bytes, sidecar checksum, and artifact evidence are required.");
    return new Map();
  }
  addUnknownFieldErrors(evidence, "evidence", ["report_bytes", "report_checksum", "artifacts"], errors);
  const reportBytes = evidence.report_bytes;
  if (!(reportBytes instanceof Uint8Array)) errors.push("evidence.report_bytes must contain the exact report bytes.");
  const reportChecksum = requireDigest(evidence.report_checksum, "evidence.report_checksum", errors);
  if (reportBytes instanceof Uint8Array && reportChecksum !== undefined && sha256(reportBytes) !== reportChecksum) errors.push("The report checksum sidecar does not match the exact report bytes.");
  if (reportBytes instanceof Uint8Array) {
    try {
      const decoded = JSON.parse(Buffer.from(reportBytes).toString("utf8"));
      if (!sameValue(decoded, report)) errors.push("The report bytes do not decode to the report being evaluated.");
    } catch {
      errors.push("The report bytes are not valid JSON.");
    }
  }
  if (!isRecord(evidence.artifacts)) {
    errors.push("evidence.artifacts must map exact artifact paths to bytes.");
    return new Map();
  }
  return new Map(Object.entries(evidence.artifacts));
}

function validateCorpus(corpus, field, errors) {
  if (!addUnknownFieldErrors(corpus, field, ["tier", "included_files", "logical_source_lines", "included_source_bytes"], errors)) return;
  if (corpus.tier !== "L") errors.push(`${field}.tier must be L.`);
  const files = requirePositiveInteger(corpus.included_files, `${field}.included_files`, errors);
  const lines = requirePositiveInteger(corpus.logical_source_lines, `${field}.logical_source_lines`, errors);
  const bytes = requirePositiveInteger(corpus.included_source_bytes, `${field}.included_source_bytes`, errors);
  if (files !== undefined && lines !== undefined && bytes !== undefined) {
    if (files > 250_000 || lines > 5_000_000 || bytes > 2.5 * GIB) errors.push(`${field} exceeds the Decision 08 tier-L bounds.`);
    if (files <= 50_000 && lines <= 1_000_000 && bytes <= 500 * MIB) errors.push(`${field} does not establish tier L beyond the tier-M bounds.`);
  }
}

function expectedHostIdentity(target) {
  return target === "darwin-arm64" ? { platform: "darwin", architecture: "arm64" } : { platform: "linux", architecture: "x64" };
}

function validateHost(host, field, target, errors) {
  const keys = [
    "run_id", "hostname", "platform", "release", "architecture", "cpu_model", "physical_cpu_count", "logical_cpu_count",
    "total_memory_bytes", "filesystem_type", "storage_class", "node", "sqlite", "cache_state", "max_indexing_cores", "max_indexing_rss_bytes",
  ];
  if (!addUnknownFieldErrors(host, field, keys, errors)) return;
  requireString(host.run_id, `${field}.run_id`, errors, { identifier: true, noPlaceholder: true });
  for (const name of ["hostname", "platform", "release", "architecture", "cpu_model", "filesystem_type", "storage_class", "node", "sqlite", "cache_state"]) {
    requireString(host[name], `${field}.${name}`, errors, { noPlaceholder: true });
  }
  const physical = requirePositiveInteger(host.physical_cpu_count, `${field}.physical_cpu_count`, errors);
  const logical = requirePositiveInteger(host.logical_cpu_count, `${field}.logical_cpu_count`, errors);
  const memory = requirePositiveInteger(host.total_memory_bytes, `${field}.total_memory_bytes`, errors);
  const maxCores = requirePositiveInteger(host.max_indexing_cores, `${field}.max_indexing_cores`, errors);
  const maxRss = requirePositiveInteger(host.max_indexing_rss_bytes, `${field}.max_indexing_rss_bytes`, errors);
  const expected = expectedHostIdentity(target);
  if (host.platform !== expected.platform || host.architecture !== expected.architecture) errors.push(`${field} does not match target ${target}.`);
  if (physical !== undefined && physical !== 8) errors.push(`${field}.physical_cpu_count must match the Decision 08 reference host (8).`);
  if (logical !== undefined && physical !== undefined && logical < physical) errors.push(`${field}.logical_cpu_count cannot be lower than physical_cpu_count.`);
  if (memory !== undefined && memory !== 16 * GIB) errors.push(`${field}.total_memory_bytes must match the Decision 08 reference host (16 GiB).`);
  if (host.storage_class !== "local_nvme") errors.push(`${field}.storage_class must be local_nvme.`);
  if (host.cache_state !== "cold") errors.push(`${field}.cache_state must be cold for cold-index qualification.`);
  if (maxCores !== undefined && maxCores > 6) errors.push(`${field}.max_indexing_cores exceeds the Decision 08 limit of 6.`);
  if (maxRss !== undefined && maxRss > L_PEAK_RSS_LIMIT_BYTES) errors.push(`${field}.max_indexing_rss_bytes exceeds 8 GiB.`);
}

function validateDigestPair(value, field, errors) {
  if (!addUnknownFieldErrors(value, field, ["baseline", "candidate"], errors)) return;
  requireDigest(value.baseline, `${field}.baseline`, errors);
  requireDigest(value.candidate, `${field}.candidate`, errors);
}

function validateProvenance(provenance, field, errors) {
  const keys = [
    "corpus_digest", "mutation_trace_digest", "manifest_digest", "runtime_module_digest", "controller_config_digests",
    "controller_executable_digests", "cargo_lock_digest", "native_closure_digest",
  ];
  if (!addUnknownFieldErrors(provenance, field, keys, errors)) return;
  for (const name of ["corpus_digest", "mutation_trace_digest", "manifest_digest", "runtime_module_digest", "cargo_lock_digest", "native_closure_digest"]) {
    requireDigest(provenance[name], `${field}.${name}`, errors);
  }
  validateDigestPair(provenance.controller_config_digests, `${field}.controller_config_digests`, errors);
  validateDigestPair(provenance.controller_executable_digests, `${field}.controller_executable_digests`, errors);
}

function validateExecutionOrder(order, field, errors) {
  if (!Array.isArray(order) || order.length !== 2 || new Set(order).size !== 2 || order.some((lane) => lane !== "baseline" && lane !== "candidate")) {
    errors.push(`${field} must contain baseline and candidate exactly once.`);
    return undefined;
  }
  return order.join(",");
}

function validateArtifactDescriptor(descriptor, field, artifactBytes, referencedPaths, errors, rssSeries = false) {
  const keys = rssSeries ? ["path", "digest", "byte_length", "sample_count"] : ["path", "digest", "byte_length"];
  if (!addUnknownFieldErrors(descriptor, field, keys, errors)) return undefined;
  const path = requireString(descriptor.path, `${field}.path`, errors);
  const digest = requireDigest(descriptor.digest, `${field}.digest`, errors);
  const byteLength = Number.isSafeInteger(descriptor.byte_length) && descriptor.byte_length >= 0 ? descriptor.byte_length : undefined;
  if (byteLength === undefined) errors.push(`${field}.byte_length must be a non-negative safe integer.`);
  if (path !== undefined && !isAbsolute(path)) errors.push(`${field}.path must be absolute.`);
  if (path === undefined) return undefined;
  if (referencedPaths.has(path)) errors.push(`Artifact path ${path} is reused by more than one evidence entry.`);
  referencedPaths.add(path);
  const bytes = artifactBytes.get(path);
  if (!(bytes instanceof Uint8Array)) {
    errors.push(`${field} is missing its exact artifact bytes.`);
    return undefined;
  }
  if (byteLength !== undefined && bytes.byteLength !== byteLength) errors.push(`${field} byte length does not match its artifact.`);
  if (digest !== undefined && sha256(bytes) !== digest) errors.push(`${field} artifact checksum does not match its bytes.`);
  let sampleCount;
  if (rssSeries) sampleCount = requirePositiveInteger(descriptor.sample_count, `${field}.sample_count`, errors);
  return { bytes, sampleCount };
}

function validateRssProcess(processValue, field, errors) {
  if (!addUnknownFieldErrors(processValue, field, ["component", "pid", "ppid", "rss_bytes"], errors)) return undefined;
  requireString(processValue.component, `${field}.component`, errors, { noPlaceholder: true });
  const pid = requirePositiveInteger(processValue.pid, `${field}.pid`, errors);
  if (!(Number.isSafeInteger(processValue.ppid) && processValue.ppid >= 0)) errors.push(`${field}.ppid must be a non-negative safe integer.`);
  const rss = requirePositiveInteger(processValue.rss_bytes, `${field}.rss_bytes`, errors);
  return pid === undefined || rss === undefined ? undefined : { pid, rss };
}

function parseNdjson(artifact, field, errors) {
  if (artifact === undefined) return undefined;
  try {
    const text = Buffer.from(artifact.bytes).toString("utf8").trim();
    return text.length === 0 ? [] : text.split("\n").map((line) => JSON.parse(line));
  } catch {
    errors.push(`${field} is not valid NDJSON.`);
    return undefined;
  }
}

function validatePhaseTimings(value, field, expectedPhases, measuredDuration, errors) {
  if (!addUnknownFieldErrors(value, field, ["unit", "phases", "total_duration_ms"], errors)) return;
  if (value.unit !== "milliseconds") errors.push(`${field}.unit must be milliseconds.`);
  if (!Array.isArray(value.phases) || value.phases.length !== expectedPhases.length) {
    errors.push(`${field}.phases must contain exactly ${expectedPhases.join(", ")} in order.`);
    return;
  }
  let total = 0;
  for (let index = 0; index < value.phases.length; index += 1) {
    const phaseField = `${field}.phases[${index}]`;
    const phase = value.phases[index];
    if (!addUnknownFieldErrors(phase, phaseField, ["phase", "duration_ms"], errors)) continue;
    if (phase.phase !== expectedPhases[index]) errors.push(`${phaseField}.phase must be ${expectedPhases[index]}.`);
    const duration = requirePositiveNumber(phase.duration_ms, `${phaseField}.duration_ms`, errors);
    if (duration !== undefined) total += duration;
  }
  const declaredTotal = requirePositiveNumber(value.total_duration_ms, `${field}.total_duration_ms`, errors);
  const roundedTotal = Math.round(total * 1_000) / 1_000;
  if (declaredTotal !== undefined && declaredTotal !== roundedTotal) errors.push(`${field}.total_duration_ms does not match its phase durations.`);
  if (declaredTotal !== undefined && Number.isFinite(measuredDuration) && declaredTotal > measuredDuration) errors.push(`${field}.total_duration_ms exceeds the externally measured operation duration.`);
}

function validateProtocolLog(artifact, field, lane, laneValue, provenance, errors) {
  const responses = parseNdjson(artifact, field, errors);
  if (responses === undefined) return;
  const expectedCount = REQUIRED_VISIBLE_DIGESTS + 2;
  if (responses.length !== expectedCount) errors.push(`${field} must contain exactly ${expectedCount} protocol responses.`);
  const validateResponse = (response, index, requestId, keys) => {
    const responseField = `${field}[${index}]`;
    if (!addUnknownFieldErrors(response, responseField, keys, errors)) return;
    if (response.schema_version !== 2 || response.request_id !== requestId || response.status !== "ok") errors.push(`${responseField} is not the expected successful ${requestId} response.`);
  };
  const prepared = responses[0];
  validateResponse(prepared, 0, `${lane}:prepare`, ["schema_version", "request_id", "status", "corpus_digest", "mutation_trace_digest"]);
  if (isRecord(prepared) && (prepared.corpus_digest !== provenance?.corpus_digest || prepared.mutation_trace_digest !== provenance?.mutation_trace_digest)) errors.push(`${field}[0] does not confirm the report corpus and mutation trace.`);
  const cold = responses[1];
  validateResponse(cold, 1, `${lane}:cold_index`, ["schema_version", "request_id", "status", "phase_timings", "visible_set_digest"]);
  if (isRecord(cold)) {
    validatePhaseTimings(cold.phase_timings, `${field}[1].phase_timings`, COLD_PHASES, laneValue?.cold_index_ms, errors);
    if (cold.visible_set_digest !== laneValue?.visible_set_digests?.[0]) errors.push(`${field}[1] does not match the cold visible-set digest.`);
  }
  for (let mutationIndex = 0; mutationIndex < REQUIRED_INCREMENTAL_SAMPLES; mutationIndex += 1) {
    const responseIndex = mutationIndex + 2;
    const response = responses[responseIndex];
    validateResponse(response, responseIndex, `${lane}:incremental_mutation:${mutationIndex}`, ["schema_version", "request_id", "status", "phase_timings", "mutation_index", "visible_set_digest"]);
    if (isRecord(response)) {
      if (response.mutation_index !== mutationIndex) errors.push(`${field}[${responseIndex}].mutation_index must be ${mutationIndex}.`);
      validatePhaseTimings(response.phase_timings, `${field}[${responseIndex}].phase_timings`, INCREMENTAL_PHASES, laneValue?.incremental_times_ms?.[mutationIndex], errors);
      if (response.visible_set_digest !== laneValue?.visible_set_digests?.[mutationIndex + 1]) errors.push(`${field}[${responseIndex}] does not match incremental mutation ${mutationIndex}.`);
    }
  }
  const shutdownIndex = REQUIRED_INCREMENTAL_SAMPLES + 2;
  validateResponse(responses[shutdownIndex], shutdownIndex, `${lane}:shutdown`, ["schema_version", "request_id", "status"]);
}

function validateRssSeries(artifact, field, expectedPeak, errors) {
  if (artifact === undefined) return;
  const samples = parseNdjson(artifact, field, errors);
  if (samples === undefined) return;
  if (samples.length === 0) {
    errors.push(`${field} must contain raw RSS measurements.`);
    return;
  }
  if (artifact.sampleCount !== undefined && samples.length !== artifact.sampleCount) errors.push(`${field}.sample_count does not match its NDJSON series.`);
  let previousTimestamp = -1;
  const rssValues = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sampleField = `${field}[${index}]`;
    const sample = samples[index];
    if (!addUnknownFieldErrors(sample, sampleField, ["sequence", "captured_at", "root_pid", "total_rss_bytes", "processes"], errors)) continue;
    if (sample.sequence !== index) errors.push(`${sampleField}.sequence must be contiguous from zero.`);
    const timestamp = typeof sample.captured_at === "string" ? Date.parse(sample.captured_at) : Number.NaN;
    if (!(Number.isFinite(timestamp) && timestamp > previousTimestamp)) errors.push(`${sampleField}.captured_at must be a strictly increasing ISO-8601 timestamp.`);
    else previousTimestamp = timestamp;
    const rootPid = requirePositiveInteger(sample.root_pid, `${sampleField}.root_pid`, errors);
    const total = requirePositiveInteger(sample.total_rss_bytes, `${sampleField}.total_rss_bytes`, errors);
    if (total !== undefined) rssValues.push(total);
    if (!Array.isArray(sample.processes) || sample.processes.length === 0) {
      errors.push(`${sampleField}.processes must contain the measured process tree.`);
      continue;
    }
    const processes = sample.processes.map((processValue, processIndex) => validateRssProcess(processValue, `${sampleField}.processes[${processIndex}]`, errors)).filter(Boolean);
    if (new Set(processes.map((processValue) => processValue.pid)).size !== processes.length) errors.push(`${sampleField}.processes contains duplicate process ids.`);
    if (rootPid !== undefined && !processes.some((processValue) => processValue.pid === rootPid)) errors.push(`${sampleField}.root_pid is absent from the process series.`);
    if (!sample.processes.some((processValue) => processValue?.component === "controller")) errors.push(`${sampleField}.processes does not identify the controller component.`);
    if (total !== undefined && processes.length === sample.processes.length && processes.reduce((sum, processValue) => sum + processValue.rss, 0) !== total) errors.push(`${sampleField}.total_rss_bytes does not equal the process measurements.`);
  }
  if (rssValues.length === samples.length && Math.max(...rssValues) !== expectedPeak) errors.push(`${field} RSS series does not match peak_process_tree_rss_bytes.`);
}

function validateLane(laneValue, field, lane, provenance, artifactBytes, referencedPaths, errors) {
  const keys = ["cold_index_ms", "incremental_times_ms", "visible_set_digests", "incremental_p95_ms", "peak_process_tree_rss_bytes", "raw_evidence"];
  if (!addUnknownFieldErrors(laneValue, field, keys, errors)) return;
  requirePositiveNumber(laneValue.cold_index_ms, `${field}.cold_index_ms`, errors);
  if (!Array.isArray(laneValue.incremental_times_ms) || laneValue.incremental_times_ms.length !== REQUIRED_INCREMENTAL_SAMPLES) {
    errors.push(`${field}.incremental_times_ms must contain exactly 60 samples.`);
  }
  const incrementalTimes = Array.isArray(laneValue.incremental_times_ms) ? laneValue.incremental_times_ms : [];
  for (let index = 0; index < incrementalTimes.length; index += 1) requirePositiveNumber(incrementalTimes[index], `${field}.incremental_times_ms[${index}]`, errors);
  const declaredP95 = requirePositiveNumber(laneValue.incremental_p95_ms, `${field}.incremental_p95_ms`, errors);
  const calculatedP95 = percentile(incrementalTimes, 0.95);
  if (declaredP95 !== undefined && calculatedP95 !== undefined && declaredP95 !== calculatedP95) errors.push(`${field}.incremental_p95_ms does not match the 60 raw samples.`);
  if (!Array.isArray(laneValue.visible_set_digests) || laneValue.visible_set_digests.length !== REQUIRED_VISIBLE_DIGESTS) {
    errors.push(`${field}.visible_set_digests must contain exactly 61 digests.`);
  }
  if (Array.isArray(laneValue.visible_set_digests)) {
    for (let index = 0; index < laneValue.visible_set_digests.length; index += 1) requireDigest(laneValue.visible_set_digests[index], `${field}.visible_set_digests[${index}]`, errors);
  }
  const peak = requirePositiveInteger(laneValue.peak_process_tree_rss_bytes, `${field}.peak_process_tree_rss_bytes`, errors);
  if (!addUnknownFieldErrors(laneValue.raw_evidence, `${field}.raw_evidence`, ["stderr_log", "protocol_log", "rss_series"], errors)) return;
  validateArtifactDescriptor(laneValue.raw_evidence.stderr_log, `${field}.raw_evidence.stderr_log`, artifactBytes, referencedPaths, errors);
  const protocolArtifact = validateArtifactDescriptor(laneValue.raw_evidence.protocol_log, `${field}.raw_evidence.protocol_log`, artifactBytes, referencedPaths, errors);
  validateProtocolLog(protocolArtifact, `${field}.raw_evidence.protocol_log`, lane, laneValue, provenance, errors);
  const rssArtifact = validateArtifactDescriptor(laneValue.raw_evidence.rss_series, `${field}.raw_evidence.rss_series`, artifactBytes, referencedPaths, errors, true);
  if (peak !== undefined) validateRssSeries(rssArtifact, `${field}.raw_evidence.rss_series`, peak, errors);
}

function buildSignature(provenance) {
  if (!isRecord(provenance)) return undefined;
  return JSON.stringify({
    runtime_module_digest: provenance.runtime_module_digest,
    controller_config_digests: provenance.controller_config_digests,
    controller_executable_digests: provenance.controller_executable_digests,
    cargo_lock_digest: provenance.cargo_lock_digest,
    native_closure_digest: provenance.native_closure_digest,
  });
}

function hostSignature(host) {
  if (!isRecord(host)) return undefined;
  const identity = Object.fromEntries(Object.entries(host).filter(([key]) => key !== "run_id"));
  return JSON.stringify(identity);
}

function validateCampaign(campaign, index, artifactBytes, state, errors) {
  const field = `report.campaigns[${index}]`;
  const keys = ["campaign_id", "target", "execution_order", "corpus", "host", "provenance", "baseline", "candidate"];
  if (!addUnknownFieldErrors(campaign, field, keys, errors)) return;
  const campaignId = requireString(campaign.campaign_id, `${field}.campaign_id`, errors, { identifier: true, noPlaceholder: true });
  if (!REFERENCE_TARGETS.includes(campaign.target)) errors.push(`${field}.target is not a reference target.`);
  const runId = isRecord(campaign.host) ? requireString(campaign.host.run_id, `${field}.host.run_id`, errors, { identifier: true, noPlaceholder: true }) : undefined;
  if (campaignId !== undefined) {
    if (state.campaignIds.has(campaignId)) errors.push(`Duplicate campaign id ${campaignId}.`);
    state.campaignIds.add(campaignId);
  }
  if (runId !== undefined) {
    if (state.runIds.has(runId)) errors.push(`Duplicate run id ${runId}.`);
    state.runIds.add(runId);
  }
  const order = validateExecutionOrder(campaign.execution_order, `${field}.execution_order`, errors);
  validateCorpus(campaign.corpus, `${field}.corpus`, errors);
  validateHost(campaign.host, `${field}.host`, campaign.target, errors);
  validateProvenance(campaign.provenance, `${field}.provenance`, errors);
  const manifestDigest = campaign.provenance?.manifest_digest;
  if (SHA256_PATTERN.test(manifestDigest ?? "")) {
    if (state.manifestDigests.has(manifestDigest)) errors.push(`Duplicate manifest digest ${manifestDigest}.`);
    state.manifestDigests.add(manifestDigest);
  }
  if (campaign.provenance?.corpus_digest !== undefined) state.corpusDigests.add(campaign.provenance.corpus_digest);
  if (campaign.provenance?.mutation_trace_digest !== undefined) state.traceDigests.add(campaign.provenance.mutation_trace_digest);
  if (isRecord(campaign.corpus)) state.corpusSignatures.add(JSON.stringify(campaign.corpus));
  const targetState = state.targets.get(campaign.target);
  if (targetState !== undefined) {
    if (order !== undefined) targetState.orders.add(order);
    const build = buildSignature(campaign.provenance);
    if (build !== undefined) targetState.builds.add(build);
    const host = hostSignature(campaign.host);
    if (host !== undefined) targetState.hosts.add(host);
  }
  validateLane(campaign.baseline, `${field}.baseline`, "baseline", campaign.provenance, artifactBytes, state.referencedPaths, errors);
  validateLane(campaign.candidate, `${field}.candidate`, "candidate", campaign.provenance, artifactBytes, state.referencedPaths, errors);
  const baselineDigests = campaign.baseline?.visible_set_digests;
  const candidateDigests = campaign.candidate?.visible_set_digests;
  if (Array.isArray(baselineDigests) && Array.isArray(candidateDigests)) {
    const count = Math.min(baselineDigests.length, candidateDigests.length, REQUIRED_VISIBLE_DIGESTS);
    for (let digestIndex = 0; digestIndex < count; digestIndex += 1) {
      if (baselineDigests[digestIndex] !== candidateDigests[digestIndex]) {
        const phase = digestIndex === 0 ? "cold index" : `incremental mutation ${digestIndex - 1}`;
        errors.push(`${campaignId ?? field} visible-set digest differs at ${phase}.`);
      }
    }
  }
}

function metricSummary(baselineValues, candidateValues) {
  const baselineP50 = percentile(baselineValues, 0.5);
  const candidateP50 = percentile(candidateValues, 0.5);
  const baselineP95 = percentile(baselineValues, 0.95);
  const candidateP95 = percentile(candidateValues, 0.95);
  return {
    baseline_p50: baselineP50,
    candidate_p50: candidateP50,
    p50_improvement: relativeImprovement(baselineP50, candidateP50),
    baseline_p95: baselineP95,
    candidate_p95: candidateP95,
    p95_improvement: relativeImprovement(baselineP95, candidateP95),
  };
}

function validatePerformance(target, campaigns, errors) {
  const cold = metricSummary(campaigns.map((campaign) => campaign.baseline?.cold_index_ms), campaigns.map((campaign) => campaign.candidate?.cold_index_ms));
  const baselineIncremental = campaigns.flatMap((campaign) => Array.isArray(campaign.baseline?.incremental_times_ms) ? campaign.baseline.incremental_times_ms : []);
  const candidateIncremental = campaigns.flatMap((campaign) => Array.isArray(campaign.candidate?.incremental_times_ms) ? campaign.candidate.incremental_times_ms : []);
  const incremental = metricSummary(baselineIncremental, candidateIncremental);
  const rss = metricSummary(campaigns.map((campaign) => campaign.baseline?.peak_process_tree_rss_bytes), campaigns.map((campaign) => campaign.candidate?.peak_process_tree_rss_bytes));
  if (cold.p50_improvement === undefined || cold.p95_improvement === undefined) errors.push(`${target} cold-index improvement has an invalid division.`);
  else if (cold.p50_improvement < 0.25 || cold.p95_improvement < 0.25) errors.push(`${target} cold-index improvement is below 25%.`);
  if (incremental.p95_improvement === undefined) errors.push(`${target} incremental improvement has an invalid division.`);
  else if (incremental.p95_improvement < 0.40) errors.push(`${target} incremental P95 improvement is below 40%.`);
  if (rss.p95_improvement === undefined) errors.push(`${target} RSS improvement has an invalid division.`);
  else if (rss.p95_improvement < 0.25) errors.push(`${target} process-tree RSS improvement is below 25%.`);
  if (cold.candidate_p50 !== undefined && cold.candidate_p50 > L_COLD_P50_LIMIT_MS) errors.push(`${target} candidate cold-index P50 exceeds 20 minutes.`);
  if (cold.candidate_p95 !== undefined && cold.candidate_p95 > L_COLD_P95_LIMIT_MS) errors.push(`${target} candidate cold-index P95 exceeds 50 minutes.`);
  if (incremental.candidate_p95 !== undefined && incremental.candidate_p95 > L_INCREMENTAL_P95_LIMIT_MS) errors.push(`${target} candidate incremental P95 exceeds 15 seconds.`);
  if (campaigns.some((campaign) => Number.isFinite(campaign.candidate?.peak_process_tree_rss_bytes) && campaign.candidate.peak_process_tree_rss_bytes > L_PEAK_RSS_LIMIT_BYTES)) errors.push(`${target} candidate peak process-tree RSS exceeds 8 GiB.`);
  return { campaigns: campaigns.length, cold, incremental, rss };
}

function initialMatrixErrors(campaigns) {
  const errors = [];
  for (const target of REFERENCE_TARGETS) {
    const count = campaigns.filter((campaign) => campaign?.target === target).length;
    if (count !== REQUIRED_CAMPAIGNS) errors.push(`${target} requires exactly 3 independent tier-L campaigns; received ${count}.`);
  }
  if (campaigns.length > REFERENCE_TARGETS.length * REQUIRED_CAMPAIGNS) errors.push(`The qualifying report must contain exactly 6 campaigns; received ${campaigns.length}.`);
  const unknownTargets = new Set(campaigns.map((campaign) => campaign?.target).filter((target) => !REFERENCE_TARGETS.includes(target)));
  for (const target of unknownTargets) errors.push(`Unsupported campaign target ${String(target)}.`);
  return errors;
}

export function evaluateNativeAccelerationGate(report, evidence) {
  if (!isRecord(report) || !Array.isArray(report.campaigns)) return { status: "failed", errors: ["Invalid native acceleration report root."], targets: {} };
  const matrixErrors = initialMatrixErrors(report.campaigns);
  if (report.campaigns.length < REFERENCE_TARGETS.length * REQUIRED_CAMPAIGNS) return { status: "failed", errors: matrixErrors, targets: {} };
  const errors = [...matrixErrors];
  const artifactBytes = validateReportEnvelope(report, evidence, errors);
  const state = {
    campaignIds: new Set(),
    runIds: new Set(),
    manifestDigests: new Set(),
    corpusDigests: new Set(),
    traceDigests: new Set(),
    corpusSignatures: new Set(),
    referencedPaths: new Set(),
    targets: new Map(REFERENCE_TARGETS.map((target) => [target, { orders: new Set(), builds: new Set(), hosts: new Set() }])),
  };
  for (let index = 0; index < report.campaigns.length; index += 1) validateCampaign(report.campaigns[index], index, artifactBytes, state, errors);
  if (state.corpusDigests.size !== 1) errors.push("All qualifying campaigns must use the same frozen corpus digest.");
  if (state.traceDigests.size !== 1) errors.push("All qualifying campaigns must use the same mutation-trace digest.");
  if (state.corpusSignatures.size !== 1) errors.push("All qualifying campaigns must declare identical corpus measurements.");
  for (const [target, targetState] of state.targets) {
    if (targetState.orders.size < 2) errors.push(`${target} campaigns must use counterbalanced baseline/candidate execution order.`);
    if (targetState.builds.size !== 1) errors.push(`${target} build provenance differs across campaigns.`);
    if (targetState.hosts.size !== 1) errors.push(`${target} host identity or resource policy differs across campaigns.`);
  }
  const unreferencedArtifacts = [...artifactBytes.keys()].filter((path) => !state.referencedPaths.has(path));
  if (unreferencedArtifacts.length > 0) errors.push(`Evidence contains unreferenced artifacts: ${unreferencedArtifacts.join(", ")}.`);
  const targets = {};
  for (const target of REFERENCE_TARGETS) {
    const campaigns = report.campaigns.filter((campaign) => campaign?.target === target);
    if (campaigns.length === REQUIRED_CAMPAIGNS) targets[target] = validatePerformance(target, campaigns, errors);
  }
  return { status: errors.length === 0 ? "passed" : "failed", errors, targets };
}

function artifactPaths(report) {
  if (!isRecord(report) || !Array.isArray(report.campaigns)) return [];
  const paths = [];
  for (const campaign of report.campaigns) {
    for (const lane of ["baseline", "candidate"]) {
      const rawEvidence = campaign?.[lane]?.raw_evidence;
      for (const name of ["stderr_log", "protocol_log", "rss_series"]) {
        if (typeof rawEvidence?.[name]?.path === "string") paths.push(rawEvidence[name].path);
      }
    }
  }
  return [...new Set(paths)];
}

export async function evaluateNativeAccelerationGateFile(reportPath) {
  try {
    const reportBytes = await readFile(reportPath);
    const report = JSON.parse(reportBytes.toString("utf8"));
    const reportChecksum = (await readFile(`${reportPath}.sha256`, "utf8")).trim();
    const artifacts = {};
    for (const path of artifactPaths(report)) {
      const bytes = await readFile(path).catch(() => undefined);
      if (bytes !== undefined) artifacts[path] = bytes;
    }
    return evaluateNativeAccelerationGate(report, { report_bytes: reportBytes, report_checksum: reportChecksum, artifacts });
  } catch (error) {
    return { status: "failed", errors: [`Unable to verify native acceleration report evidence: ${error instanceof Error ? error.message : String(error)}`], targets: {} };
  }
}

async function main() {
  const path = process.argv[2];
  if (path === undefined) throw new Error("Usage: node scripts/native-acceleration-gate.mjs <report.json>");
  const result = await evaluateNativeAccelerationGateFile(path);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
