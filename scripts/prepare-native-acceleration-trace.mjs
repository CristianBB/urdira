#!/usr/bin/env node
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadNativeAccelerationCorpusState,
  nativeAccelerationMutationTraceDigest,
  validateNativeAccelerationMutationTrace,
} from "./native-acceleration-controller.mjs";

const SOURCE_PATTERN = /\.(?:[cm]?[jt]sx?)$/iu;
const DECLARATION_PATTERN = /\.d\.[cm]?ts$/iu;
const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)\s+(?:[^"'\n]*?\sfrom\s*)?["']([^"'\n]+)["']/u;

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizedRelativePath(value, subject) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.startsWith("/") || value.endsWith("/")) throw new Error(`${subject} must be a normalized POSIX relative path.`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error(`${subject} must not contain empty, dot, or parent segments.`);
  return value;
}

function corpusDigest(entries) {
  return sha256(JSON.stringify([...entries.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)));
}

function setFile(entries, path, content) {
  const digest = sha256(content);
  entries.set(path, { path, kind: "file", digest });
  return digest;
}

function writeChange(path, beforeDigest, content) {
  const bytes = Buffer.from(content, "utf8");
  return { kind: "write", path, before_digest: beforeDigest, after_digest: sha256(bytes), content_base64: bytes.toString("base64") };
}

function addMutation(mutations, entries, mutationId, category, changes) {
  mutations.push({
    mutation_index: mutations.length,
    mutation_id: mutationId,
    category,
    changes,
    resulting_corpus_digest: corpusDigest(entries),
  });
}

async function readUtf8File(root, path) {
  const bytes = await readFile(join(root, ...path.split("/")));
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`Trace preparation candidate ${path} is not canonical UTF-8.`);
  return text;
}

async function usableSourceCandidates(root, state) {
  const candidates = [];
  for (const entry of [...state.entries.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    if (entry.kind !== "file" || !SOURCE_PATTERN.test(entry.path) || DECLARATION_PATTERN.test(entry.path)) continue;
    const metadata = await stat(join(root, ...entry.path.split("/")));
    if (metadata.size === 0 || metadata.size > 256 * 1024) continue;
    const content = await readUtf8File(root, entry.path).catch(() => undefined);
    if (content !== undefined) candidates.push({ entry, content });
  }
  return candidates;
}

function uniqueDerivedPath(entries, proposal) {
  if (!entries.has(proposal)) return proposal;
  const extension = extname(proposal);
  const stem = extension === "" ? proposal : proposal.slice(0, -extension.length);
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!entries.has(candidate)) return candidate;
  }
  throw new Error(`Could not derive a non-existing path from ${proposal}.`);
}

function findManifestCandidate(root, state) {
  return [...state.entries.values()]
    .filter((entry) => entry.kind === "file" && basename(entry.path).toLocaleLowerCase("en-US") === "package.json")
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .reduce(async (pending, entry) => {
      const existing = await pending;
      if (existing !== undefined) return existing;
      try {
        const content = await readUtf8File(root, entry.path);
        const parsed = JSON.parse(content);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? { entry, content, parsed } : undefined;
      } catch { return undefined; }
    }, Promise.resolve(undefined));
}

export async function generateNativeAccelerationMutationTrace(options) {
  if (options === null || typeof options !== "object") throw new Error("Trace generation options are required.");
  const corpusPath = resolve(options.corpusPath);
  if (!isAbsolute(options.corpusPath)) throw new Error("corpusPath must be absolute.");
  const traceId = typeof options.traceId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.traceId) ? options.traceId : undefined;
  if (traceId === undefined) throw new Error("traceId must be an explicit stable identifier.");
  if (!Array.isArray(options.excludedPaths)) throw new Error("excludedPaths must be an explicit array.");
  const excludedPaths = options.excludedPaths.map((path, index) => normalizedRelativePath(path, `excludedPaths[${index}]`));
  if (new Set(excludedPaths).size !== excludedPaths.length) throw new Error("excludedPaths must not contain duplicates.");
  const initial = await loadNativeAccelerationCorpusState(corpusPath, excludedPaths);
  const entries = new Map(initial.entries);
  const sourceCandidates = await usableSourceCandidates(corpusPath, initial);
  const importCandidate = sourceCandidates.find((candidate) => !candidate.content.startsWith("#!") && IMPORT_PATTERN.test(candidate.content));
  if (importCandidate === undefined) throw new Error("Corpus has no bounded UTF-8 JS/TS file with a discoverable static import or export.");
  const reserved = new Set([importCandidate.entry.path]);
  const takeSource = () => {
    const candidate = sourceCandidates.find((entry) => !reserved.has(entry.entry.path));
    if (candidate === undefined) throw new Error("Corpus does not contain enough distinct bounded UTF-8 JS/TS files for the 60-mutation trace.");
    reserved.add(candidate.entry.path);
    return candidate;
  };
  const deleteCandidate = takeSource();
  const renameCandidate = takeSource();
  const contentCandidates = Array.from({ length: 54 }, () => takeSource());
  const tsconfigEntry = [...entries.values()]
    .filter((entry) => entry.kind === "file" && /^tsconfig(?:\.[^/]+)*\.json$/iu.test(basename(entry.path)))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)[0];
  if (tsconfigEntry === undefined) throw new Error("Corpus has no discovered tsconfig JSON file.");
  const manifestCandidate = await findManifestCandidate(corpusPath, initial);
  if (manifestCandidate === undefined) throw new Error("Corpus has no discovered, parseable package manifest.");
  if (reserved.has(tsconfigEntry.path) || reserved.has(manifestCandidate.entry.path) || tsconfigEntry.path === manifestCandidate.entry.path) throw new Error("Discovered special mutation candidates are not path-disjoint.");

  const marker = sha256(`${traceId}\0${initial.digest}`).slice("sha256:".length, "sha256:".length + 12);
  const createPath = uniqueDerivedPath(entries, `urdira-native-acceleration-created-${marker}.ts`);
  const renameExtension = extname(renameCandidate.entry.path);
  const renameStem = renameExtension === "" ? renameCandidate.entry.path : renameCandidate.entry.path.slice(0, -renameExtension.length);
  const renamePath = uniqueDerivedPath(entries, `${renameStem}.urdira-renamed-${marker}${renameExtension}`);
  const mutations = [];

  const firstContent = contentCandidates[0];
  const firstContentAfter = `${firstContent.content}${firstContent.content.endsWith("\n") ? "" : "\n"}export const urdiraNativeAccelerationContent00 = ${JSON.stringify(marker)};\n`;
  const firstContentChange = writeChange(firstContent.entry.path, firstContent.entry.digest, firstContentAfter);
  setFile(entries, firstContent.entry.path, firstContentAfter);
  addMutation(mutations, entries, "content-00", "content", [firstContentChange]);

  const importMatch = IMPORT_PATTERN.exec(importCandidate.content);
  if (importMatch === null) throw new Error("Selected import candidate lost its static module specifier.");
  const importAfter = `import ${JSON.stringify(importMatch[1])}; // urdira native acceleration import ${marker}\n${importCandidate.content}`;
  const importChange = writeChange(importCandidate.entry.path, importCandidate.entry.digest, importAfter);
  setFile(entries, importCandidate.entry.path, importAfter);
  addMutation(mutations, entries, "import-01", "import", [importChange]);

  const createdContent = `export const urdiraNativeAccelerationTrace = ${JSON.stringify(marker)};\n`;
  const createChange = writeChange(createPath, null, createdContent);
  setFile(entries, createPath, createdContent);
  addMutation(mutations, entries, "create-02", "create", [createChange]);

  entries.delete(deleteCandidate.entry.path);
  addMutation(mutations, entries, "delete-03", "delete", [{ kind: "delete", path: deleteCandidate.entry.path, before_digest: deleteCandidate.entry.digest }]);

  entries.delete(renameCandidate.entry.path);
  entries.set(renamePath, { path: renamePath, kind: "file", digest: renameCandidate.entry.digest });
  addMutation(mutations, entries, "rename-04", "rename", [{ kind: "rename", from_path: renameCandidate.entry.path, to_path: renamePath, content_digest: renameCandidate.entry.digest }]);

  const tsconfigContent = await readUtf8File(corpusPath, tsconfigEntry.path);
  const tsconfigAfter = `// urdira native acceleration tsconfig ${marker}\n${tsconfigContent}`;
  const tsconfigChange = writeChange(tsconfigEntry.path, tsconfigEntry.digest, tsconfigAfter);
  setFile(entries, tsconfigEntry.path, tsconfigAfter);
  addMutation(mutations, entries, "tsconfig-05", "tsconfig", [tsconfigChange]);

  const manifestValue = { ...manifestCandidate.parsed };
  let manifestKey = `x-urdira-native-acceleration-${marker}`;
  for (let suffix = 2; Object.hasOwn(manifestValue, manifestKey); suffix += 1) manifestKey = `x-urdira-native-acceleration-${marker}-${suffix}`;
  manifestValue[manifestKey] = traceId;
  const manifestAfter = `${JSON.stringify(manifestValue, null, 2)}\n`;
  const manifestChange = writeChange(manifestCandidate.entry.path, manifestCandidate.entry.digest, manifestAfter);
  setFile(entries, manifestCandidate.entry.path, manifestAfter);
  addMutation(mutations, entries, "manifest-06", "manifest", [manifestChange]);

  for (let index = 7; index < 60; index += 1) {
    const candidate = contentCandidates[index - 6];
    const suffix = String(index).padStart(2, "0");
    const after = `${candidate.content}${candidate.content.endsWith("\n") ? "" : "\n"}export const urdiraNativeAccelerationContent${suffix} = ${JSON.stringify(marker)};\n`;
    const change = writeChange(candidate.entry.path, candidate.entry.digest, after);
    setFile(entries, candidate.entry.path, after);
    addMutation(mutations, entries, `content-${String(index).padStart(2, "0")}`, "content", [change]);
  }

  return validateNativeAccelerationMutationTrace({
    schema_version: 1,
    trace_id: traceId,
    base_corpus_digest: initial.digest,
    excluded_paths: excludedPaths,
    mutations,
  });
}

export async function writeNativeAccelerationMutationTrace(pathValue, traceValue) {
  if (!isAbsolute(pathValue)) throw new Error("Trace output path must be absolute.");
  const path = resolve(pathValue);
  const trace = validateNativeAccelerationMutationTrace(traceValue);
  await mkdir(dirname(path), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(trace, null, 2)}\n`, "utf8");
  await writeFile(path, bytes, { flag: "wx" });
  return { path, bytes, mutation_trace_digest: nativeAccelerationMutationTraceDigest(bytes) };
}

function simulateTrace(initial, trace) {
  const entries = new Map(initial.entries);
  for (const mutation of trace.mutations) {
    for (const change of mutation.changes) {
      if (change.kind === "write") {
        const current = entries.get(change.path);
        if (change.before_digest === null ? current !== undefined : current?.kind !== "file" || current.digest !== change.before_digest) throw new Error(`${mutation.mutation_id} has a write before_digest mismatch at ${change.path}.`);
        entries.set(change.path, { path: change.path, kind: "file", digest: change.after_digest });
      } else if (change.kind === "delete") {
        const current = entries.get(change.path);
        if (current?.kind !== "file" || current.digest !== change.before_digest) throw new Error(`${mutation.mutation_id} has a delete before_digest mismatch at ${change.path}.`);
        entries.delete(change.path);
      } else {
        const current = entries.get(change.from_path);
        if (current?.kind !== "file" || current.digest !== change.content_digest || entries.has(change.to_path)) throw new Error(`${mutation.mutation_id} has a rename state mismatch.`);
        entries.delete(change.from_path);
        entries.set(change.to_path, { path: change.to_path, kind: "file", digest: change.content_digest });
      }
    }
    const actual = corpusDigest(entries);
    if (actual !== mutation.resulting_corpus_digest) throw new Error(`${mutation.mutation_id} resulting_corpus_digest is invalid.`);
  }
  return corpusDigest(entries);
}

export async function validatePreparedNativeAccelerationMutationTrace(options) {
  if (options === null || typeof options !== "object" || !isAbsolute(options.corpusPath) || !isAbsolute(options.tracePath)) throw new Error("Validation requires absolute corpusPath and tracePath values.");
  const corpusPath = resolve(options.corpusPath);
  const tracePath = resolve(options.tracePath);
  const bytes = await readFile(tracePath);
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Mutation trace must contain valid JSON."); }
  const trace = validateNativeAccelerationMutationTrace(parsed);
  const traceRelative = relative(corpusPath, tracePath);
  if (traceRelative === "" || (!traceRelative.startsWith(`..${sep}`) && traceRelative !== ".." && !isAbsolute(traceRelative))) {
    const path = traceRelative.split(sep).join("/");
    if (!trace.excluded_paths.some((excluded) => path === excluded || path.startsWith(`${excluded}/`))) throw new Error("An in-corpus trace must exclude its own path from the corpus digest.");
  }
  const initial = await loadNativeAccelerationCorpusState(corpusPath, trace.excluded_paths);
  if (initial.digest !== trace.base_corpus_digest) throw new Error("Corpus does not match mutation trace base_corpus_digest.");
  const finalCorpusDigest = simulateTrace(initial, trace);
  return {
    trace_id: trace.trace_id,
    corpus_digest: initial.digest,
    mutation_trace_digest: nativeAccelerationMutationTraceDigest(bytes),
    mutation_count: trace.mutations.length,
    final_corpus_digest: finalCorpusDigest,
  };
}

function parseArguments(argv) {
  const result = { validate: false, excludes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--validate") result.validate = true;
    else if (["--corpus", "--trace", "--trace-id", "--exclude"].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      if (argument === "--exclude") result.excludes.push(value);
      else result[argument.slice(2).replace("-", "_")] = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!isAbsolute(result.corpus ?? "") || !isAbsolute(result.trace ?? "")) throw new Error("--corpus and --trace require absolute paths.");
  if (!result.validate && result.trace_id === undefined) throw new Error("Trace generation requires --trace-id.");
  return result;
}

export async function runPrepareNativeAccelerationTraceCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const args = parseArguments(argv);
  if (args.validate) {
    const result = await validatePreparedNativeAccelerationMutationTrace({ corpusPath: args.corpus, tracePath: args.trace });
    stdout.write(`${JSON.stringify({ status: "valid", ...result })}\n`);
    return;
  }
  const corpusPath = resolve(args.corpus);
  const tracePath = resolve(args.trace);
  const excludedPaths = args.excludes.map((path, index) => normalizedRelativePath(path, `--exclude[${index}]`));
  // Repository administration data is not part of the indexed source corpus
  // and can change merely by reading Git state. Excluding it by default keeps
  // corpus and mutation-trace digests reproducible across lane copies.
  if (!excludedPaths.includes(".git")) excludedPaths.unshift(".git");
  const traceRelative = relative(corpusPath, tracePath);
  if (traceRelative === "" || (!traceRelative.startsWith(`..${sep}`) && traceRelative !== ".." && !isAbsolute(traceRelative))) {
    const path = traceRelative.split(sep).join("/");
    if (!excludedPaths.includes(path)) excludedPaths.push(path);
  }
  const trace = await generateNativeAccelerationMutationTrace({ corpusPath, traceId: args.trace_id, excludedPaths });
  const written = await writeNativeAccelerationMutationTrace(tracePath, trace);
  stdout.write(`${JSON.stringify({ status: "generated", trace: written.path, trace_id: trace.trace_id, corpus_digest: trace.base_corpus_digest, mutation_trace_digest: written.mutation_trace_digest, mutation_count: trace.mutations.length })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPrepareNativeAccelerationTraceCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
