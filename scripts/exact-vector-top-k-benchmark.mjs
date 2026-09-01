import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";
import { TextEncoder } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCHEMA_VERSION = 1;
const HARNESS_VERSION = 1;
const REQUIRED_NATIVE_API_VERSION = 16;
const DEFAULT_SAMPLE_COUNT = 5;
const DIMENSIONS = 8;
const TOP_K = 100;
const CHUNK_CANDIDATES = 4_096;
const ELEMENT_TYPE = "float32_le";
const METRIC = "squared_l2";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_WORKLOADS = Object.freeze([
  Object.freeze({ label: "small", candidateCount: 100_000, seed: 1_337 }),
  Object.freeze({ label: "large", candidateCount: 1_000_000, seed: 7_331 }),
]);
const textEncoder = new TextEncoder();

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function stableBytes(value) {
  return Buffer.from(JSON.stringify(stable(value)), "utf8");
}

function percentile(values, quantile) {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) throw new Error("A benchmark metric series must contain finite values.");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(quantile * ordered.length) - 1)];
}

function distribution(values) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    minimum: Math.min(...values),
    maximum: Math.max(...values),
  };
}

function improvement(baseline, candidate) {
  return (baseline - candidate) / baseline;
}

function utf8Compare(left, right) {
  const leftBytes = textEncoder.encode(left.normalize("NFC"));
  const rightBytes = textEncoder.encode(right.normalize("NFC"));
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function vectorReader(bytes, elementType) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Exact vector input must be a Uint8Array.");
  const width = elementType === "float32_le" ? 4 : elementType === "float64_le" ? 8 : 0;
  if (width === 0) throw new TypeError(`Unsupported exact vector element type: ${String(elementType)}.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width,
    read(index) {
      return width === 4 ? view.getFloat32(index * width, true) : view.getFloat64(index * width, true);
    },
  };
}

function assertFinite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite value.`);
  return value;
}

export function exactVectorTopKOracle(request) {
  if (!isRecord(request)) throw new TypeError("Exact vector request must be an object.");
  const dimensions = request.dimensions;
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) throw new TypeError("Exact vector dimensions must be positive.");
  if (!Number.isSafeInteger(request.k) || request.k <= 0) throw new TypeError("Exact vector top-k must be positive.");
  if (request.metric !== "squared_l2" && request.metric !== "cosine") throw new TypeError("Exact vector metric is unsupported.");
  if (!Array.isArray(request.projectionRecordIds) || request.projectionRecordIds.some((identifier) => typeof identifier !== "string" || identifier.length === 0)) {
    throw new TypeError("Exact vector candidate identifiers must be non-empty strings.");
  }
  if (new Set(request.projectionRecordIds).size !== request.projectionRecordIds.length) throw new TypeError("Exact vector candidate identifiers must be unique.");
  const query = vectorReader(request.query, request.elementType);
  const candidates = vectorReader(request.candidates, request.elementType);
  if (request.query.byteLength !== dimensions * query.width) throw new TypeError("Exact vector query has an invalid byte length.");
  if (request.candidates.byteLength !== request.projectionRecordIds.length * dimensions * candidates.width) throw new TypeError("Exact vector candidates have an invalid byte length.");

  const queryValues = Array.from({ length: dimensions }, (_, index) => assertFinite(query.read(index), "Exact vector query"));
  let queryNorm = 0;
  if (request.metric === "cosine") {
    for (const value of queryValues) queryNorm += value * value;
    if (queryNorm === 0) throw new TypeError("Cosine exact vector top-k does not accept zero vectors.");
  }
  const ranked = request.projectionRecordIds.map((identifier, candidateIndex) => {
    let distance = 0;
    let dot = 0;
    let candidateNorm = 0;
    const offset = candidateIndex * dimensions;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const candidateValue = assertFinite(candidates.read(offset + dimension), "Exact vector candidate");
      const queryValue = queryValues[dimension];
      if (request.metric === "squared_l2") {
        const difference = candidateValue - queryValue;
        distance += difference * difference;
      } else {
        dot += candidateValue * queryValue;
        candidateNorm += candidateValue * candidateValue;
      }
    }
    if (request.metric === "cosine") {
      if (candidateNorm === 0) throw new TypeError("Cosine exact vector top-k does not accept zero vectors.");
      distance = 1 - dot / Math.sqrt(candidateNorm * queryNorm);
    }
    if (!Number.isFinite(distance)) throw new TypeError("Exact vector distance is not finite.");
    return { identifier, distance };
  });
  ranked.sort((left, right) => left.distance - right.distance || utf8Compare(left.identifier, right.identifier));
  return ranked.slice(0, request.k).map((entry, index) => ({ projection_record_id: entry.identifier, rank: index + 1 }));
}

function deterministicValue(candidateIndex, dimension, seed) {
  let value = (Math.imul(candidateIndex + 1, 0x9e3779b1) ^ Math.imul(dimension + 1, 0x85ebca6b) ^ seed) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return (value / 0x1_0000_0000) * 2 - 1;
}

function createPackedWorkload(configuration) {
  const { candidateCount, seed } = configuration;
  const query = new Uint8Array(DIMENSIONS * 4);
  const queryView = new DataView(query.buffer);
  for (let dimension = 0; dimension < DIMENSIONS; dimension += 1) queryView.setFloat32(dimension * 4, deterministicValue(-1, dimension, seed), true);
  const candidates = new Uint8Array(candidateCount * DIMENSIONS * 4);
  const candidateView = new DataView(candidates.buffer);
  const identifiers = new Array(candidateCount);
  const width = String(Math.max(0, candidateCount - 1)).length;
  for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
    identifiers[candidateIndex] = `vector:${String(candidateIndex).padStart(width, "0")}`;
    for (let dimension = 0; dimension < DIMENSIONS; dimension += 1) {
      const value = candidateIndex < 4
        ? queryView.getFloat32(dimension * 4, true)
        : deterministicValue(candidateIndex, dimension, seed);
      candidateView.setFloat32((candidateIndex * DIMENSIONS + dimension) * 4, value, true);
    }
  }
  const hash = createHash("sha256").update(query).update(candidates);
  for (let start = 0; start < identifiers.length; start += CHUNK_CANDIDATES) hash.update(`${identifiers.slice(start, start + CHUNK_CANDIDATES).join("\0")}\0`);
  return {
    query,
    candidates,
    identifiers,
    inputDigest: `sha256:${hash.digest("hex")}`,
    indexForIdentifier(identifier) {
      if (!identifier.startsWith("vector:")) throw new Error(`Unexpected benchmark identifier ${identifier}.`);
      const index = Number(identifier.slice("vector:".length));
      if (!Number.isSafeInteger(index) || index < 0 || index >= candidateCount || identifiers[index] !== identifier) throw new Error(`Invalid benchmark identifier ${identifier}.`);
      return index;
    },
  };
}

function packedCandidatesForIndices(workload, indices) {
  const vectorBytes = DIMENSIONS * 4;
  const packed = new Uint8Array(indices.length * vectorBytes);
  indices.forEach((candidateIndex, localIndex) => {
    packed.set(workload.candidates.subarray(candidateIndex * vectorBytes, (candidateIndex + 1) * vectorBytes), localIndex * vectorBytes);
  });
  return packed;
}

function hierarchicalTopK(workload, runBatch) {
  const vectorBytes = DIMENSIONS * 4;
  let indices;
  let evaluatedCandidates = 0;
  let kernelMs = 0;
  for (;;) {
    const candidateCount = indices === undefined ? workload.identifiers.length : indices.length;
    const groupCount = Math.ceil(candidateCount / CHUNK_CANDIDATES);
    const selected = [];
    let onlyMatches;
    for (let start = 0; start < candidateCount; start += CHUNK_CANDIDATES) {
      const end = Math.min(candidateCount, start + CHUNK_CANDIDATES);
      const groupIndices = indices === undefined
        ? undefined
        : indices.slice(start, end);
      const projectionRecordIds = groupIndices === undefined
        ? workload.identifiers.slice(start, end)
        : groupIndices.map((candidateIndex) => workload.identifiers[candidateIndex]);
      const candidates = groupIndices === undefined
        ? workload.candidates.subarray(start * vectorBytes, end * vectorBytes)
        : packedCandidatesForIndices(workload, groupIndices);
      const request = {
        query: workload.query,
        candidates,
        projectionRecordIds,
        dimensions: DIMENSIONS,
        elementType: ELEMENT_TYPE,
        k: Math.min(TOP_K, projectionRecordIds.length),
        metric: METRIC,
      };
      const started = performance.now();
      const batch = runBatch([request]);
      kernelMs += performance.now() - started;
      if (!Array.isArray(batch) || batch.length !== 1 || !Array.isArray(batch[0])) throw new Error("Exact vector lane returned an invalid batch shape.");
      onlyMatches = batch[0];
      evaluatedCandidates += projectionRecordIds.length;
      for (const match of onlyMatches) selected.push(workload.indexForIdentifier(match.projection_record_id));
    }
    if (groupCount === 1) return { matches: onlyMatches, kernelMs, evaluatedCandidates };
    indices = selected;
  }
}

function resultDigest(matches) {
  return sha256(stableBytes(matches));
}

function runWorkloadInProcess(configuration, lane, runBatch) {
  const workload = createPackedWorkload(configuration);
  globalThis.gc?.();
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const result = hierarchicalTopK(workload, runBatch);
  const digest = resultDigest(result.matches);
  const endToEndMs = performance.now() - started;
  const rssAfter = process.memoryUsage().rss;
  return {
    lane,
    kernel_ms: Math.max(0.001, result.kernelMs),
    end_to_end_ms: Math.max(0.001, endToEndMs),
    peak_rss_bytes: process.resourceUsage().maxRSS * 1_024,
    rss_before_bytes: rssBefore,
    rss_after_bytes: rssAfter,
    evaluated_candidates: result.evaluatedCandidates,
    input_digest: workload.inputDigest,
    result_digest: digest,
    matches: result.matches,
  };
}

export function runExactVectorTopKOracleSample(configuration) {
  if (!isRecord(configuration)
    || typeof configuration.label !== "string"
    || configuration.label.length === 0
    || !Number.isSafeInteger(configuration.candidateCount)
    || configuration.candidateCount <= 0
    || !Number.isSafeInteger(configuration.seed)) {
    throw new TypeError("Oracle benchmark configuration is invalid.");
  }
  return runWorkloadInProcess(configuration, "oracle", (requests) => requests.map(exactVectorTopKOracle));
}

function expectedNativeTargetTriple() {
  return {
    "darwin:arm64": "aarch64-apple-darwin",
    "darwin:x64": "x86_64-apple-darwin",
    "linux:arm64": "aarch64-unknown-linux-gnu",
    "linux:x64": "x86_64-unknown-linux-gnu",
    "win32:x64": "x86_64-pc-windows-msvc",
  }[`${platform()}:${arch()}`];
}

export function validateExactVectorTopKNativeBinding(binding) {
  if (!isRecord(binding)) throw new Error("The N-API addon did not export an object.");
  for (const name of ["nativeApiVersion", "nativeTargetTriple", "exactVectorTopKBatch"]) {
    if (typeof binding[name] !== "function") throw new Error(`The N-API addon does not export ${name}.`);
  }
  const nativeApiVersion = binding.nativeApiVersion();
  if (nativeApiVersion !== REQUIRED_NATIVE_API_VERSION) throw new Error(`The N-API addon reports API ${String(nativeApiVersion)}; expected ${REQUIRED_NATIVE_API_VERSION}.`);
  const nativeTargetTriple = binding.nativeTargetTriple();
  const expectedTarget = expectedNativeTargetTriple();
  if (expectedTarget === undefined || nativeTargetTriple !== expectedTarget) throw new Error(`The N-API addon target ${String(nativeTargetTriple)} does not match this host (${String(expectedTarget)}).`);
  return { binding, nativeApiVersion, nativeTargetTriple };
}

async function loadRealAddon(addonPath) {
  if (!isAbsolute(addonPath) || !addonPath.endsWith(".node")) throw new Error("A real benchmark requires an absolute .node addon path.");
  const metadata = await stat(addonPath).catch(() => undefined);
  if (metadata?.isFile() !== true) throw new Error(`The N-API addon is not a file: ${addonPath}`);
  const bytes = await readFile(addonPath);
  const loaded = createRequire(import.meta.url)(addonPath);
  const validated = validateExactVectorTopKNativeBinding(loaded);
  return {
    binding: validated.binding,
    provenance: {
      path: addonPath,
      digest: sha256(bytes),
      native_api_version: validated.nativeApiVersion,
      native_target_triple: validated.nativeTargetTriple,
    },
  };
}

function warmRunner(runBatch) {
  const request = {
    query: float32Bytes([1, 0]),
    candidates: float32Bytes([1, 0, 0, 1]),
    projectionRecordIds: ["a", "b"],
    dimensions: 2,
    elementType: ELEMENT_TYPE,
    k: 1,
    metric: METRIC,
  };
  runBatch([request]);
}

function float32Bytes(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

export function parseExactVectorTopKWorkerArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--lane", "--label", "--candidates", "--seed", "--addon"].includes(argument)) throw new Error(`Unknown worker argument: ${String(argument)}`);
    const next = argv[index + 1];
    if (next === undefined) throw new Error(`${argument} requires a value.`);
    values[argument.slice(2)] = next;
    index += 1;
  }
  if (values.lane !== "oracle" && values.lane !== "native") throw new Error("Worker lane must be oracle or native.");
  const candidateCount = Number(values.candidates);
  const seed = Number(values.seed);
  if (!Number.isSafeInteger(candidateCount) || candidateCount <= 0 || !Number.isSafeInteger(seed)) throw new Error("Worker candidate count and seed must be integers.");
  if (values.lane === "native" && !isAbsolute(values.addon ?? "")) throw new Error("Native worker requires an absolute addon path.");
  return { lane: values.lane, label: values.label, candidateCount, seed, addonPath: values.addon };
}

async function workerMain(argv) {
  const options = parseExactVectorTopKWorkerArguments(argv);
  let runBatch;
  if (options.lane === "native") {
    const addon = await loadRealAddon(options.addonPath);
    runBatch = (requests) => addon.binding.exactVectorTopKBatch(requests);
  } else {
    runBatch = (requests) => requests.map(exactVectorTopKOracle);
  }
  warmRunner(runBatch);
  const result = runWorkloadInProcess({ label: options.label, candidateCount: options.candidateCount, seed: options.seed }, options.lane, runBatch);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function runWorkerProcess({ lane, workload, addonPath, timeoutMs = 30 * 60 * 1_000 }) {
  return new Promise((resolve, reject) => {
    const argumentsValue = [
      "--expose-gc",
      SCRIPT_PATH,
      "--worker",
      "--lane", lane,
      "--label", workload.label,
      "--candidates", String(workload.candidateCount),
      "--seed", String(workload.seed),
      ...(lane === "native" ? ["--addon", addonPath] : []),
    ];
    const child = spawn(process.execPath, argumentsValue, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${lane}/${workload.label} exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${lane}/${workload.label} worker failed with code ${String(code)} signal ${String(signal)}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch (error) {
        reject(new Error(`${lane}/${workload.label} worker emitted invalid JSON.`, { cause: error }));
      }
    });
  });
}

function validMatchList(value) {
  return Array.isArray(value) && value.every((entry, index) => isRecord(entry)
    && typeof entry.projection_record_id === "string"
    && entry.projection_record_id.length > 0
    && entry.rank === index + 1);
}

function sameMatches(left, right) {
  return validMatchList(left) && validMatchList(right) && JSON.stringify(left) === JSON.stringify(right);
}

function validLaneResult(value) {
  if (!isRecord(value)) return false;
  for (const field of ["kernel_ms", "end_to_end_ms", "peak_rss_bytes", "rss_before_bytes", "rss_after_bytes"]) {
    if (!Number.isFinite(value[field]) || value[field] <= 0) return false;
  }
  return value.end_to_end_ms >= value.kernel_ms
    && SHA256_PATTERN.test(value.input_digest)
    && SHA256_PATTERN.test(value.result_digest)
    && validMatchList(value.matches)
    && value.result_digest === resultDigest(value.matches);
}

function evaluatePrerequisiteAttribution(value) {
  const result = { valid: false, qualifying: false, time_share: undefined, memory_share: undefined };
  if (!isRecord(value)
    || value.schema_version !== 1
    || value.evidence_kind !== "urdira.exact-vector-top-k-attribution.v1"
    || !isRecord(value.source)
    || !isAbsolute(value.source.path ?? "")
    || !SHA256_PATTERN.test(value.source.file_checksum)
    || value.provenance?.execution_mode !== "real_end_to_end_query"
    || value.provenance?.implementation !== "typescript_oracle"
    || value.provenance?.query_class !== "exact_vector_top_k"
    || !SHA256_PATTERN.test(value.provenance?.corpus_digest)
    || !SHA256_PATTERN.test(value.provenance?.query_digest)
    || !Array.isArray(value.samples)
    || value.samples.length < DEFAULT_SAMPLE_COUNT) return result;
  const sampleIds = new Set();
  const timeShares = [];
  const memoryShares = [];
  for (const sample of value.samples) {
    if (!isRecord(sample) || typeof sample.sample_id !== "string" || sample.sample_id.length === 0 || sampleIds.has(sample.sample_id)) return result;
    sampleIds.add(sample.sample_id);
    let measured = false;
    if (isRecord(sample.time)) {
      const endToEnd = sample.time.end_to_end_ms;
      const vectorScan = sample.time.vector_scan_ms;
      if (!Number.isFinite(endToEnd) || endToEnd <= 0 || !Number.isFinite(vectorScan) || vectorScan < 0 || vectorScan > endToEnd) return result;
      timeShares.push(vectorScan / endToEnd);
      measured = true;
    }
    if (isRecord(sample.memory)) {
      const endToEnd = sample.memory.end_to_end_incremental_peak_rss_bytes;
      const vectorScan = sample.memory.vector_scan_incremental_peak_rss_bytes;
      if (!Number.isFinite(endToEnd) || endToEnd <= 0 || !Number.isFinite(vectorScan) || vectorScan < 0 || vectorScan > endToEnd) return result;
      memoryShares.push(vectorScan / endToEnd);
      measured = true;
    }
    if (!measured) return result;
  }
  if (timeShares.length > 0 && timeShares.length < DEFAULT_SAMPLE_COUNT) return result;
  if (memoryShares.length > 0 && memoryShares.length < DEFAULT_SAMPLE_COUNT) return result;
  result.valid = true;
  if (timeShares.length >= DEFAULT_SAMPLE_COUNT) result.time_share = distribution(timeShares);
  if (memoryShares.length >= DEFAULT_SAMPLE_COUNT) result.memory_share = distribution(memoryShares);
  result.qualifying = (result.time_share?.p50 ?? -1) >= 0.20 || (result.memory_share?.p50 ?? -1) >= 0.20;
  return result;
}

function emptyChecks() {
  return {
    evidence_checksum: false,
    qualifying_scales: false,
    sufficient_samples: false,
    exact_ordered_equivalence: false,
    deterministic_tie_breaking: false,
    real_napi_addon: false,
    real_query_attribution: false,
    target_scale_kernel_gain: false,
    large_end_to_end_improvement: false,
    small_end_to_end_regression: false,
  };
}

function rawGate(report) {
  const errors = [];
  const checks = emptyChecks();
  const metrics = {};
  if (!isRecord(report) || report.schema_version !== SCHEMA_VERSION || !isRecord(report.evidence)) {
    return { status: "do_not_activate", errors: ["Invalid exact vector top-k evidence envelope."], checks, metrics };
  }
  const expectedChecksum = sha256(stableBytes(report.evidence));
  checks.evidence_checksum = report.evidence_checksum === expectedChecksum;
  if (!checks.evidence_checksum) errors.push(`Evidence checksum mismatch; expected ${expectedChecksum}.`);
  const evidence = report.evidence;
  const configuration = evidence.configuration;
  const configuredWorkloads = Array.isArray(configuration?.workloads) ? configuration.workloads : [];
  checks.qualifying_scales = configuration?.dimensions === DIMENSIONS
    && configuration?.k === TOP_K
    && configuration?.metric === METRIC
    && configuration?.element_type === ELEMENT_TYPE
    && configuration?.chunk_candidates === CHUNK_CANDIDATES
    && configuredWorkloads.length === 2
    && configuredWorkloads.some((entry) => entry?.label === "small" && entry.candidate_count === 100_000)
    && configuredWorkloads.some((entry) => entry?.label === "large" && entry.candidate_count === 1_000_000);
  if (!checks.qualifying_scales) errors.push("Qualification requires the fixed 100K and 1M vector workloads.");

  const requiredSamples = configuration?.sample_count;
  const workloads = Array.isArray(evidence.workloads) ? evidence.workloads : [];
  checks.sufficient_samples = Number.isSafeInteger(requiredSamples) && requiredSamples >= DEFAULT_SAMPLE_COUNT
    && workloads.length === 2
    && workloads.every((entry) => Array.isArray(entry?.samples) && entry.samples.length === requiredSamples);
  if (!checks.sufficient_samples) errors.push(`Qualification requires at least ${DEFAULT_SAMPLE_COUNT} complete paired samples per workload.`);

  const addon = evidence.provenance?.addon;
  checks.real_napi_addon = evidence.provenance?.execution_mode === "real_napi"
    && isRecord(addon)
    && isAbsolute(addon.path ?? "")
    && String(addon.path).endsWith(".node")
    && SHA256_PATTERN.test(addon.digest)
    && addon.native_api_version === REQUIRED_NATIVE_API_VERSION
    && typeof addon.native_target_triple === "string"
    && addon.native_target_triple.length > 0;
  if (!checks.real_napi_addon) errors.push("Promotion requires measurements from a real N-API addon.");

  const attribution = evaluatePrerequisiteAttribution(evidence.prerequisite_attribution);
  checks.real_query_attribution = attribution.valid && attribution.qualifying;
  metrics.prerequisite_attribution = {
    valid: attribution.valid,
    time_share: attribution.time_share,
    memory_share: attribution.memory_share,
  };

  let equivalent = workloads.length === 2;
  let sampleEvidenceValid = workloads.length === 2;
  const summaries = {};
  for (const workload of workloads) {
    if (!isRecord(workload) || !Array.isArray(workload.samples)) {
      sampleEvidenceValid = false;
      equivalent = false;
      continue;
    }
    const oracleKernel = [];
    const nativeKernel = [];
    const oracleEndToEnd = [];
    const nativeEndToEnd = [];
    const oracleRss = [];
    const nativeRss = [];
    for (const sample of workload.samples) {
      const valid = isRecord(sample) && validLaneResult(sample.oracle) && validLaneResult(sample.native);
      sampleEvidenceValid &&= valid;
      if (!valid) {
        equivalent = false;
        continue;
      }
      const computedEquivalent = sample.oracle.input_digest === sample.native.input_digest
        && sample.oracle.result_digest === sample.native.result_digest
        && sameMatches(sample.oracle.matches, sample.native.matches);
      equivalent &&= computedEquivalent && sample.equivalent === true;
      oracleKernel.push(workload.candidate_count / (sample.oracle.kernel_ms / 1_000));
      nativeKernel.push(workload.candidate_count / (sample.native.kernel_ms / 1_000));
      oracleEndToEnd.push(sample.oracle.end_to_end_ms);
      nativeEndToEnd.push(sample.native.end_to_end_ms);
      oracleRss.push(sample.oracle.peak_rss_bytes);
      nativeRss.push(sample.native.peak_rss_bytes);
    }
    if (oracleKernel.length > 0) {
      summaries[workload.label] = {
        candidate_count: workload.candidate_count,
        oracle: {
          kernel_throughput_vectors_per_second: distribution(oracleKernel),
          end_to_end_ms: distribution(oracleEndToEnd),
          peak_rss_bytes: distribution(oracleRss),
        },
        native: {
          kernel_throughput_vectors_per_second: distribution(nativeKernel),
          end_to_end_ms: distribution(nativeEndToEnd),
          peak_rss_bytes: distribution(nativeRss),
        },
      };
    }
  }
  checks.sufficient_samples &&= sampleEvidenceValid;
  if (!sampleEvidenceValid) errors.push("One or more paired samples contain invalid or internally inconsistent measurements.");
  checks.exact_ordered_equivalence = equivalent && sampleEvidenceValid;
  if (!checks.exact_ordered_equivalence) errors.push("Oracle and native ordered top-k results are not exactly equivalent.");

  const tieCases = Array.isArray(evidence.tie_breaking?.cases) ? evidence.tie_breaking.cases : [];
  const tieMetrics = new Set(tieCases.map((entry) => entry?.metric));
  checks.deterministic_tie_breaking = evidence.tie_breaking?.equivalent === true
    && tieMetrics.has("squared_l2")
    && tieMetrics.has("cosine")
    && tieCases.every((entry) => SHA256_PATTERN.test(entry?.input_digest)
      && entry?.equivalent === true
      && sameMatches(entry?.oracle_matches, entry?.native_matches));
  if (!checks.deterministic_tie_breaking) errors.push("UTF-8 tie-breaking is not exactly equivalent for squared L2 and cosine.");

  const small = summaries.small;
  const large = summaries.large;
  if (large !== undefined) {
    const throughputRatio = large.native.kernel_throughput_vectors_per_second.p50 / large.oracle.kernel_throughput_vectors_per_second.p50;
    const rssReduction = improvement(large.oracle.peak_rss_bytes.maximum, large.native.peak_rss_bytes.maximum);
    const endToEndImprovement = improvement(large.oracle.end_to_end_ms.p50, large.native.end_to_end_ms.p50);
    metrics.large = { kernel_throughput_ratio: throughputRatio, peak_rss_reduction: rssReduction, end_to_end_improvement: endToEndImprovement };
    checks.target_scale_kernel_gain = throughputRatio >= 2 || rssReduction >= 0.30;
    checks.large_end_to_end_improvement = endToEndImprovement >= 0.15;
  }
  if (!checks.large_end_to_end_improvement) errors.push("Large end-to-end latency improvement is below 15%.");
  if (small !== undefined) {
    const regression = small.native.end_to_end_ms.p50 / small.oracle.end_to_end_ms.p50 - 1;
    metrics.small = { end_to_end_regression: regression };
    checks.small_end_to_end_regression = regression <= 0.05;
  }
  if (!checks.small_end_to_end_regression) errors.push("Small-query end-to-end regression exceeds 5%.");
  if (Array.isArray(evidence.execution_errors) && evidence.execution_errors.length > 0) errors.push(...evidence.execution_errors.map((error) => `Benchmark execution failed: ${String(error)}`));
  const activationChecks = [
    checks.evidence_checksum,
    checks.qualifying_scales,
    checks.sufficient_samples,
    checks.exact_ordered_equivalence,
    checks.deterministic_tie_breaking,
    checks.real_napi_addon,
    checks.large_end_to_end_improvement,
    checks.small_end_to_end_regression,
  ];
  const status = errors.length === 0 && activationChecks.every(Boolean) ? "activate" : "do_not_activate";
  return { status, errors: [...new Set(errors)], checks, metrics: { ...metrics, workloads: summaries } };
}

export function evaluateExactVectorTopKGate(report) {
  try {
    const evaluated = rawGate(report);
    if (isRecord(report) && report.decision !== undefined && JSON.stringify(report.decision) !== JSON.stringify(evaluated)) {
      return {
        ...evaluated,
        status: "do_not_activate",
        errors: [...evaluated.errors, "Stored promotion decision does not match the evidence."],
      };
    }
    return evaluated;
  } catch (error) {
    return {
      status: "do_not_activate",
      errors: [`Invalid exact vector top-k evidence: ${error instanceof Error ? error.message : String(error)}`],
      checks: emptyChecks(),
      metrics: {},
    };
  }
}

export function createExactVectorTopKReport(evidence) {
  if (!isRecord(evidence)) throw new TypeError("Exact vector top-k evidence must be an object.");
  const report = {
    schema_version: SCHEMA_VERSION,
    evidence: globalThis.structuredClone(evidence),
    evidence_checksum: sha256(stableBytes(evidence)),
  };
  return { ...report, decision: rawGate(report) };
}

function tieRequest(metric) {
  const identifiers = ["éclair", "äther", "zeta", "alpha"];
  const query = float32Bytes([1, 0]);
  const candidates = float32Bytes(identifiers.flatMap(() => [1, 0]));
  return {
    query,
    candidates,
    projectionRecordIds: identifiers,
    dimensions: 2,
    elementType: ELEMENT_TYPE,
    k: identifiers.length,
    metric,
  };
}

function tieInputDigest(request) {
  const hash = createHash("sha256").update(request.query).update(request.candidates).update(request.projectionRecordIds.join("\0"));
  return `sha256:${hash.digest("hex")}`;
}

function normalizeSample(value) {
  if (!isRecord(value)) throw new Error("A benchmark lane returned an invalid sample.");
  const matches = globalThis.structuredClone(value.matches);
  return {
    kernel_ms: value.kernel_ms,
    end_to_end_ms: value.end_to_end_ms,
    peak_rss_bytes: value.peak_rss_bytes,
    rss_before_bytes: value.rss_before_bytes,
    rss_after_bytes: value.rss_after_bytes,
    ...(Number.isSafeInteger(value.evaluated_candidates) ? { evaluated_candidates: value.evaluated_candidates } : {}),
    input_digest: value.input_digest,
    result_digest: resultDigest(matches),
    matches,
  };
}

async function writeReport(outputPath, report) {
  if (!isAbsolute(outputPath)) throw new Error("Benchmark output path must be absolute.");
  await mkdir(dirname(outputPath), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  const checksumPath = `${outputPath}.sha256`;
  await writeFile(outputPath, bytes, { flag: "wx" });
  try {
    await writeFile(checksumPath, `${sha256(bytes)}\n`, { flag: "wx" });
  } catch (error) {
    await unlink(outputPath).catch(() => undefined);
    throw error;
  }
}

function normalizedWorkloads(executionMode, workloads) {
  if (executionMode === "real_napi") {
    if (workloads !== undefined) throw new Error("Real qualification workloads are fixed at 100K and 1M vectors.");
    return DEFAULT_WORKLOADS;
  }
  if (!Array.isArray(workloads) || workloads.length !== 2) throw new Error("The unit-test seam requires exactly two controlled workloads.");
  return workloads.map((entry) => {
    if ((entry.label !== "small" && entry.label !== "large") || !Number.isSafeInteger(entry.candidateCount) || entry.candidateCount <= 0 || !Number.isSafeInteger(entry.seed)) {
      throw new Error("Invalid controlled unit-test workload.");
    }
    return { label: entry.label, candidateCount: entry.candidateCount, seed: entry.seed };
  });
}

async function loadPrerequisiteAttribution(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Attribution evidence path must be absolute.");
  const [bytes, sidecar] = await Promise.all([readFile(path), readFile(`${path}.sha256`, "utf8")]);
  const fileChecksum = sha256(bytes);
  if (sidecar.trim() !== fileChecksum) throw new Error(`Attribution evidence file checksum mismatch; expected ${fileChecksum}.`);
  const decoded = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(decoded) || Object.hasOwn(decoded, "source")) throw new Error("Attribution evidence must be an object without an embedded source field.");
  return { source: { path, file_checksum: fileChecksum }, ...decoded };
}

export async function runExactVectorTopKBenchmark(options) {
  if (!isRecord(options)) throw new TypeError("Benchmark options are required.");
  const executionMode = options.executionMode ?? "real_napi";
  if (executionMode !== "real_napi" && executionMode !== "unit_test_seam") throw new Error("Unknown benchmark execution mode.");
  if (!isAbsolute(options.outputPath ?? "")) throw new Error("Benchmark outputPath must be absolute.");
  const sampleCount = options.sampleCount ?? DEFAULT_SAMPLE_COUNT;
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0 || (executionMode === "real_napi" && sampleCount < DEFAULT_SAMPLE_COUNT)) {
    throw new Error(`Real qualification requires at least ${DEFAULT_SAMPLE_COUNT} samples per workload.`);
  }
  const workloads = normalizedWorkloads(executionMode, options.workloads);
  let addon;
  let prerequisiteAttribution;
  if (executionMode === "real_napi") {
    addon = await loadRealAddon(options.addonPath);
    prerequisiteAttribution = options.attributionPath === undefined ? null : await loadPrerequisiteAttribution(options.attributionPath);
  }
  else if (!isRecord(options.unitTestSeam) || typeof options.unitTestSeam.runSample !== "function" || typeof options.unitTestSeam.runTieCase !== "function") {
    throw new Error("unit_test_seam requires controlled runSample and runTieCase functions.");
  } else prerequisiteAttribution = options.attributionEvidence ?? null;

  const harnessDigest = sha256(await readFile(SCRIPT_PATH));
  const evidenceWorkloads = [];
  const executionErrors = [];
  for (const workload of workloads) {
    const samples = [];
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const executionOrder = sampleIndex % 2 === 0 ? ["oracle", "native"] : ["native", "oracle"];
      const results = {};
      try {
        for (const lane of executionOrder) {
          const raw = executionMode === "real_napi"
            ? await runWorkerProcess({ lane, workload, addonPath: options.addonPath })
            : await options.unitTestSeam.runSample({ lane, workload, sampleIndex });
          results[lane] = normalizeSample(raw);
        }
      } catch (error) {
        executionErrors.push(`${workload.label} sample ${sampleIndex}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      const equivalent = results.oracle.input_digest === results.native.input_digest
        && results.oracle.result_digest === results.native.result_digest
        && sameMatches(results.oracle.matches, results.native.matches);
      samples.push({ sample_index: sampleIndex, execution_order: executionOrder, oracle: results.oracle, native: results.native, equivalent });
    }
    evidenceWorkloads.push({ label: workload.label, candidate_count: workload.candidateCount, samples });
    if (executionErrors.length > 0) break;
  }

  const tieCases = [];
  if (executionErrors.length === 0) {
    for (const metric of ["squared_l2", "cosine"]) {
      const request = tieRequest(metric);
      const oracleMatches = exactVectorTopKOracle(request);
      const nativeMatches = executionMode === "real_napi"
        ? addon.binding.exactVectorTopKBatch([request])[0]
        : await options.unitTestSeam.runTieCase({ metric, request, oracleMatches });
      tieCases.push({
        metric,
        input_digest: tieInputDigest(request),
        oracle_matches: oracleMatches,
        native_matches: nativeMatches,
        equivalent: sameMatches(oracleMatches, nativeMatches),
      });
    }
  }

  const evidence = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    harness: { name: "exact-vector-top-k-benchmark", version: HARNESS_VERSION, digest: harnessDigest },
    configuration: {
      sample_count: sampleCount,
      dimensions: DIMENSIONS,
      k: TOP_K,
      metric: METRIC,
      element_type: ELEMENT_TYPE,
      chunk_candidates: CHUNK_CANDIDATES,
      workloads: workloads.map((entry) => ({ label: entry.label, candidate_count: entry.candidateCount, seed: entry.seed })),
    },
    provenance: {
      execution_mode: executionMode,
      addon: addon?.provenance ?? null,
      host: {
        platform: platform(),
        release: release(),
        architecture: arch(),
        logical_cpu_count: cpus().length,
        total_memory_bytes: totalmem(),
        node: process.version,
      },
    },
    prerequisite_attribution: prerequisiteAttribution,
    workloads: evidenceWorkloads,
    tie_breaking: { cases: tieCases, equivalent: tieCases.length === 2 && tieCases.every((entry) => entry.equivalent) },
    execution_errors: executionErrors,
  };
  const report = createExactVectorTopKReport(evidence);
  await writeReport(options.outputPath, report);
  return report;
}

async function verifyReportFile(reportPath) {
  if (!isAbsolute(reportPath)) throw new Error("Gate report path must be absolute.");
  const [bytes, declaredChecksum] = await Promise.all([readFile(reportPath), readFile(`${reportPath}.sha256`, "utf8")]);
  const actualChecksum = sha256(bytes);
  if (declaredChecksum.trim() !== actualChecksum) {
    return { status: "do_not_activate", errors: [`Report file checksum mismatch; expected ${actualChecksum}.`], checks: emptyChecks(), metrics: {} };
  }
  return evaluateExactVectorTopKGate(JSON.parse(bytes.toString("utf8")));
}

function parseMainArguments(argv) {
  if (argv[0] === "--gate") {
    if (argv.length !== 2 || !isAbsolute(argv[1])) throw new Error("Usage: node scripts/exact-vector-top-k-benchmark.mjs --gate /absolute/evidence.json");
    return { mode: "gate", reportPath: argv[1] };
  }
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--addon", "--attribution", "--output", "--samples"].includes(argument)) throw new Error(`Unknown argument: ${String(argument)}`);
    const next = argv[index + 1];
    if (next === undefined) throw new Error(`${argument} requires a value.`);
    values[argument.slice(2)] = next;
    index += 1;
  }
  const sampleCount = values.samples === undefined ? DEFAULT_SAMPLE_COUNT : Number(values.samples);
  if (!isAbsolute(values.addon ?? "") || (values.attribution !== undefined && !isAbsolute(values.attribution)) || !isAbsolute(values.output ?? "") || !Number.isSafeInteger(sampleCount) || sampleCount < DEFAULT_SAMPLE_COUNT) {
    throw new Error("Usage: node scripts/exact-vector-top-k-benchmark.mjs --addon /absolute/urdira-native.node [--attribution /absolute/attribution.json] --output /absolute/evidence.json [--samples 5]");
  }
  return { mode: "benchmark", addonPath: values.addon, attributionPath: values.attribution, outputPath: values.output, sampleCount };
}

async function main(argv) {
  const options = parseMainArguments(argv);
  if (options.mode === "gate") {
    const decision = await verifyReportFile(options.reportPath);
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    if (decision.status !== "activate") process.exitCode = 1;
    return;
  }
  const report = await runExactVectorTopKBenchmark({
    executionMode: "real_napi",
    addonPath: options.addonPath,
    attributionPath: options.attributionPath,
    outputPath: options.outputPath,
    sampleCount: options.sampleCount,
  });
  process.stdout.write(`${JSON.stringify({ output: options.outputPath, evidence_checksum: report.evidence_checksum, decision: report.decision }, null, 2)}\n`);
  if (report.decision.status !== "activate") process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--worker") {
    await workerMain(process.argv.slice(3)).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  } else {
    await main(process.argv.slice(2)).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
