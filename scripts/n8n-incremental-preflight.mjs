#!/usr/bin/env node
/* c8 ignore file -- this benchmark harness is exercised by explicit n8n runs, not the unit-test corpus. */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  computeNativeAccelerationCorpusDigest,
  createNativeAccelerationController,
  nativeAccelerationMutationTraceDigest,
} from "./native-acceleration-controller.mjs";
import {
  createSlice,
  prepareNativeRoot,
} from "./indexing-structural-preflight.mjs";
import {
  generateNativeAccelerationMutationTrace,
  writeNativeAccelerationMutationTrace,
} from "./prepare-native-acceleration-trace.mjs";

function sha256(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function parseArguments(argv) {
  const result = { owners: 1000, mutations: 60, mutation_start: 0, readiness_timeout_ms: 120_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${key} requires a value.`);
    if (["--corpus", "--native-root", "--output", "--owners", "--mutations", "--mutation-start", "--readiness-timeout-ms"].includes(key)) {
      if (key === "--owners" || key === "--mutations" || key === "--mutation-start" || key === "--readiness-timeout-ms") {
        const parsed = Number(value);
        const minimum = key === "--mutation-start" ? 0 : 1;
        if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${key} must be an integer >= ${minimum}.`);
        result[key.slice(2).replaceAll("-", "_")] = parsed;
      } else result[key.slice(2).replaceAll("-", "_")] = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${key}`);
  }
  for (const field of ["corpus", "native_root", "output"]) if (!isAbsolute(result[field] ?? "")) throw new Error(`--${field.replaceAll("_", "-")} requires an absolute path.`);
  return result;
}

async function run(options) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "urdira-n8n-incremental-"));
  const corpus = join(temporaryRoot, "corpus");
  const dataRoot = join(temporaryRoot, "data");
  const tracePath = join(temporaryRoot, "trace.json");
  await mkdir(corpus);
  let controller;
  let nativeClosure;
  try {
    await createSlice(options.corpus, corpus, options.owners);
    const corpusDigest = await computeNativeAccelerationCorpusDigest(corpus, []);
    const generatedTrace = await generateNativeAccelerationMutationTrace({ corpusPath: corpus, traceId: `n8n-incremental-${options.owners}`, excludedPaths: [] });
    const firstMutation = Math.min(options.mutation_start, generatedTrace.mutations.length - 1);
    const selectedMutations = generatedTrace.mutations.slice(firstMutation, firstMutation + options.mutations);
    const remainingMutations = generatedTrace.mutations.filter((_, index) => index < firstMutation || index >= firstMutation + options.mutations);
    // The controller intentionally requires a zero-based mutation cursor and
    // validates the complete 60-entry authority trace. Move the requested
    // window to the front and re-number all entries; only the selected prefix
    // is executed, while the remaining authority entries stay intact.
    const selectedDigestRoot = join(temporaryRoot, "selected-digest");
    await cp(corpus, selectedDigestRoot, { recursive: true });
    const selectedDigests = [];
    for (const mutation of selectedMutations) {
      for (const change of mutation.changes) {
        if (change.kind === "write") await writeFile(join(selectedDigestRoot, ...change.path.split("/")), Buffer.from(change.content_base64, "base64"));
        else if (change.kind === "delete") await unlink(join(selectedDigestRoot, ...change.path.split("/")));
        else await rename(join(selectedDigestRoot, ...change.from_path.split("/")), join(selectedDigestRoot, ...change.to_path.split("/")));
      }
      // Digests must be cumulative: the controller applies each mutation on
      // top of the prior state, so resulting_corpus_digest[i] is the digest
      // after mutations 0..i applied in order (do not reset to pristine).
      selectedDigests.push(await computeNativeAccelerationCorpusDigest(selectedDigestRoot, []));
    }
    await rm(selectedDigestRoot, { recursive: true, force: true });
    const trace = { ...generatedTrace, mutations: [...selectedMutations.map((mutation, index) => ({ ...mutation, mutation_index: index, resulting_corpus_digest: selectedDigests[index] })), ...remainingMutations].map((mutation, index) => ({ ...mutation, mutation_index: index })) };
    const writtenTrace = await writeNativeAccelerationMutationTrace(tracePath, trace);
    const traceBytes = writtenTrace.bytes;
    nativeClosure = await prepareNativeRoot(options.native_root);
    process.env.URDIRA_NATIVE_REQUIRED = "1";
    process.env.URDIRA_NATIVE_ROOT = nativeClosure.native_root;
    process.env.URDIRA_SEMANTIC_INDEX = "0";
    const config = {
      schema_version: 2, lane: "candidate", corpus_path: corpus, mutation_trace_path: tracePath, data_root: dataRoot,
      runtime_module: resolve("apps/urdira/dist/index.js"),
      workspace_selection: { selected_technology_ids: ["typescript"], selected_plugin_ids: ["urdira:javascript_typescript"] },
      qualification: { mode: "qualifying", corpus_tier: "L", cache_state: "cold", applied_limits: { max_indexing_cores: 6, max_rss_bytes: 8 * 1024 ** 3 }, capture_phase_timings: true },
      polling: { interval_ms: 100, readiness_timeout_ms: options.readiness_timeout_ms },
    };
    controller = await createNativeAccelerationController(config);
    const common = { schema_version: 2, campaign_id: `n8n-incremental-${options.owners}`, lane: "candidate", target: `${process.platform}-${process.arch}`, corpus_path: corpus, corpus_digest: corpusDigest, mutation_trace_digest: nativeAccelerationMutationTraceDigest(traceBytes) };
    await controller.handle({ ...common, request_id: "prepare", operation: "prepare" });
    const coldStarted = performance.now();
    const cold = await controller.handle({ ...common, request_id: "cold", operation: "cold_index" });
    const samples = [];
    for (let mutationIndex = 0; mutationIndex < Math.min(options.mutations, trace.mutations.length); mutationIndex += 1) {
      const started = performance.now();
      const result = await controller.handle({ ...common, request_id: `mutation-${mutationIndex}`, operation: "incremental_mutation", mutation_index: mutationIndex });
      samples.push({ mutation_index: mutationIndex, mutation_id: trace.mutations[mutationIndex].mutation_id, elapsed_ms: Math.round((performance.now() - started) * 1000) / 1000, phase_timings: result.phase_timings, visible_set_digest: result.visible_set_digest });
    }
    return { owner_count: options.owners, mutation_count: samples.length, corpus_digest: corpusDigest, cold_elapsed_ms: Math.round((performance.now() - coldStarted) * 1000) / 1000, cold_phase_timings: cold.phase_timings, cold_visible_set_digest: cold.visible_set_digest, mutations: samples };
  } finally {
    await controller?.dispose().catch(() => undefined);
    await nativeClosure?.cleanup().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArguments(process.argv.slice(2));
  run(options).then(async (report) => {
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, bytes);
    await writeFile(`${options.output}.sha256`, `${sha256(bytes)}  ${options.output.split("/").at(-1)}\n`);
    process.stdout.write(JSON.stringify({ output: options.output, owner_count: report.owner_count, mutation_count: report.mutation_count, cold_elapsed_ms: report.cold_elapsed_ms }) + "\n");
  }).catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
}
