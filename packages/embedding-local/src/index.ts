import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { canonicalBytes, digestBytes } from "@urdira/canonical";
import type { EmbeddingProfile } from "@urdira/contracts";
import { canonicalVectorBytes, type GenerateVectorInput, type ResolvedSemanticProvider, type SemanticGeneratedVector } from "@urdira/engine";
// Type-only import: erased entirely at compile time, so this never triggers
// the real `@huggingface/transformers` module to load (and never loads the
// ONNX runtime behind it) just by being present in this file -- only
// `defaultExtractorFactory`'s `await import(...)` below does that, and only
// when it actually runs.
import type { DataType } from "@huggingface/transformers";

/**
 * A batched text-to-vector function: given N texts, returns N vectors, one
 * per text, in the same order. This is the seam the default provider below
 * fills with a real transformers.js `feature-extraction` pipeline, and the
 * seam every test in `tests/embedding-local.test.ts` fills with a fake --
 * nothing in this module ever imports `@huggingface/transformers` outside
 * `defaultExtractorFactory` (see its own doc comment for why that matters).
 * Each returned vector may be a `Float32Array` (what a real transformers.js
 * `Tensor.tolist()` row actually is once flattened) or a plain
 * `readonly number[]` (what a hand-written test fake naturally produces);
 * `meanPoolWindowVectors` below accepts either without caring which.
 */
export type EmbeddingExtractor = (texts: readonly string[]) => Promise<ReadonlyArray<Float32Array | readonly number[]>>;

export interface LocalNeuralProviderOptions {
  /** Hugging Face model id. Default `"Xenova/all-MiniLM-L6-v2"` -- a small, widely-cached sentence-embedding model with no gated/licensed download step. */
  readonly model_id?: string;
  /** transformers.js `env.cacheDir` -- where downloaded/cached model weights live on disk. The app passes `<data_root>/models`; omitted here (and in every test), transformers.js falls back to its own library default. Deliberately excluded from every digest this module computes -- see `createLocalNeuralProvider`'s doc comment. */
  readonly cache_dir?: string;
  /** ONNX weight quantization to load. Default `"q8"` (8-bit quantized weights) -- a deliberate quality/size/speed tradeoff for a *bundled* default that downloads on first use; an operator who wants full float32 precision can override it. */
  readonly dtype?: string;
  /** Document text is split into consecutive, non-overlapping windows of this many UTF-16 code units before embedding. Default 2000. */
  readonly window_chars?: number;
  /** At most this many windows of a single document are embedded (and mean-pooled together); the rest of an oversized document is silently dropped rather than embedded. Default 64. */
  readonly max_windows?: number;
  /** `true` (default) lets transformers.js download the model from the Hugging Face Hub on first use; `false` restricts it to whatever is already present in `cache_dir` (or the library's default cache), for fully offline operation. */
  readonly allow_download?: boolean;
  /**
   * Injectable for tests, so nothing in this module needs a real model, a
   * real ONNX runtime, or a network connection to be exercised. Defaults to
   * `defaultExtractorFactory` below, which lazily imports
   * `@huggingface/transformers` and builds a real `feature-extraction`
   * pipeline with `{pooling: "mean", normalize: true}` -- i.e. the model's
   * OWN per-window token pooling and normalization, which this module then
   * pools a SECOND time across windows (see `createLocalNeuralProvider`'s
   * doc comment for why there are two pooling stages).
   */
  readonly extractor_factory?: (options: {
    readonly model_id: string;
    readonly dtype: string;
    readonly cache_dir?: string;
    readonly allow_download: boolean;
  }) => Promise<EmbeddingExtractor>;
}

// Exported (not just module-private) so `ensureSemanticAssets`
// (`packages/daemon/src/semantic-provider-runtime.ts`) can resolve the same
// default model id a caller-omitted `descriptor.model_id` ultimately
// provisions -- e.g. to report it back on a `"failed"` provisioning outcome,
// where `ensureLocalEmbeddingModel` itself never got the chance to return
// its own resolved `model_id`. Single source of truth: nothing outside this
// module hardcodes the string.
export const DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_DTYPE = "q8";
const DEFAULT_WINDOW_CHARS = 2000;
const DEFAULT_MAX_WINDOWS = 64;
/** Fixed probe text used once at construction to discover the model's output dimensionality -- see `createLocalNeuralProvider`'s doc comment. Never embedded as a real document or query. */
const DIMENSION_PROBE_TEXT = "urdira dimension probe";

function digestOf(value: unknown): string {
  return digestBytes(canonicalBytes(value));
}

/**
 * Same "digest the struct minus its own digest field" discipline as
 * `@urdira/engine`'s `semantic-provider.ts` (`embeddingProfile` there) --
 * duplicated here rather than imported because it is a three-line pure
 * function and importing it would mean reaching into that module's
 * non-exported internals.
 */
function embeddingProfile(withoutDigest: Omit<EmbeddingProfile, "profile_digest">): EmbeddingProfile {
  return { ...withoutDigest, profile_digest: digestOf(withoutDigest) };
}

/** Same sanitization shape as `semantic-provider.ts`'s `sanitizeModelIdSegment`: lowercase, collapse every run of non-`[a-z0-9-]` characters to a single `-`, trim leading/trailing `-`. `"Xenova/all-MiniLM-L6-v2"` becomes `"xenova-all-minilm-l6-v2"`. */
function sanitizeModelIdSegment(modelId: string): string {
  const sanitized = modelId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized.length > 0 ? sanitized : "model";
}

/**
 * Reads `@huggingface/transformers`'s OWN installed `package.json` `version`
 * field at runtime -- never hardcoded -- so the executable binding digest
 * (below) actually tracks which transformers.js build produced a vector.
 * `@huggingface/transformers`'s own `package.json` does not expose a
 * `"./package.json"` subpath through its `exports` map, so
 * `require.resolve("@huggingface/transformers/package.json")` is not an
 * option here; instead this resolves the package's real JS entry file (via
 * `createRequire(...).resolve`, which DOES follow `exports`) and walks up
 * its containing directories until it finds the `package.json` whose own
 * `name` field is `"@huggingface/transformers"` -- the entry file always
 * lives somewhere under that package's root (e.g. `dist/`), so this always
 * terminates within a couple of hops regardless of whether node_modules is
 * flat, pnpm-nested, or symlinked. Resolving and reading a `package.json`
 * off disk never imports (and therefore never loads the ONNX runtime
 * behind) the package's actual JS entry point, so calling this eagerly at
 * provider-construction time stays safe under the "keep the transformers
 * import lazy" rule that `defaultExtractorFactory` observes for the real
 * pipeline.
 */
function resolveTransformersPackageVersion(): string {
  const require_ = createRequire(import.meta.url);
  let directory = dirname(require_.resolve("@huggingface/transformers"));
  for (let hop = 0; hop < 10; hop += 1) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) {
      const packageJson = JSON.parse(readFileSync(candidate, "utf8")) as { readonly name?: string; readonly version?: string };
      if (packageJson.name === "@huggingface/transformers" && typeof packageJson.version === "string" && packageJson.version.length > 0) return packageJson.version;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Could not resolve @huggingface/transformers's installed package.json version.");
}

/**
 * The real, non-test default for `LocalNeuralProviderOptions.extractor_factory`:
 * lazily `import()`s `@huggingface/transformers` (so merely importing THIS
 * module, or constructing a provider with an injected fake factory, never
 * pulls in transformers.js's ONNX runtime at all) and builds one
 * `feature-extraction` pipeline, reused for every subsequent call. `env`
 * configuration happens before the pipeline is built, since transformers.js
 * reads `env.cacheDir`/`env.allowRemoteModels` at model-resolution time, not
 * per-call: `cache_dir`, when given, becomes transformers.js's on-disk model
 * cache directory; `allow_download === false` sets `env.allowRemoteModels =
 * false`, restricting resolution to whatever is already cached locally
 * (throwing there, rather than silently reaching the network, is exactly the
 * offline story the daemon's provisioning flow depends on).
 *
 * `env` is a MODULE-GLOBAL singleton shared by every construction in the
 * process, so BOTH fields are assigned unconditionally from THIS call's
 * options -- never only on one branch. The daemon's real lifecycle is
 * exactly the sequence that punishes a sticky flag: an offline construction
 * attempt at startup (`allow_download: false`, may fail when the model is
 * not provisioned yet) followed by `ensureLocalEmbeddingModel`'s download
 * attempt (`allow_download: true`) during a configure RPC. With the original
 * `if (!allow_download)`-only assignment, the startup attempt permanently
 * poisoned `env.allowRemoteModels = false` and the "download" attempt then
 * failed offline too -- observed live as `workspace_add` returning success
 * while the model never arrived.
 */
async function defaultExtractorFactory(options: { readonly model_id: string; readonly dtype: string; readonly cache_dir?: string; readonly allow_download: boolean }): Promise<EmbeddingExtractor> {
  const { pipeline, env } = await import("@huggingface/transformers");
  if (options.cache_dir !== undefined) env.cacheDir = options.cache_dir;
  env.allowRemoteModels = options.allow_download;
  const extractor = await pipeline("feature-extraction", options.model_id, { dtype: options.dtype as DataType });
  return async (texts: readonly string[]) => {
    const output = await extractor([...texts], { pooling: "mean", normalize: true });
    // `Tensor.tolist()` on a `[batch, dimensions]`-shaped tensor (which is
    // exactly what `{pooling: "mean"}` over a batch of texts produces) is a
    // `number[][]`, one row per input text, in input order -- see the
    // library's own `feature-extraction` pipeline doc comment/example.
    return output.tolist() as number[][];
  };
}

/**
 * Splits `text` into consecutive, non-overlapping windows of `windowChars`
 * UTF-16 code units each (the final window kept even if shorter), then
 * returns at most `capWindows` of them, in order, from the START of the
 * text. The loop below stops as soon as `capWindows` windows have been
 * collected -- deliberately, so an oversized document (megabytes of text
 * against a `window_chars`/`max_windows` pair that only ever needs the first
 * few hundred KB) never pays the cost of slicing windows past the cap it is
 * about to discard anyway.
 */
function computeWindows(text: string, windowChars: number, capWindows: number): readonly string[] {
  const windows: string[] = [];
  for (let index = 0; index < text.length && windows.length < capWindows; index += windowChars) {
    windows.push(text.slice(index, index + windowChars));
  }
  return windows;
}

/**
 * Element-wise mean over `vectors` (one per embedded window), all assumed to
 * already be `dimensions` long -- the model's own `{pooling: "mean",
 * normalize: true}` has already reduced each window's token sequence down to
 * one unit vector, so this is the SECOND, document-level pooling stage: it
 * turns "one vector per window" into "one vector for the whole document"
 * before `canonicalVectorBytes` L2-normalizes the result. A single-window
 * document (the common case, and always true for a query -- see
 * `createLocalNeuralProvider`) degenerates to this being a no-op copy.
 */
function meanPoolWindowVectors(vectors: ReadonlyArray<Float32Array | readonly number[]>, dimensions: number): readonly number[] {
  const sums = new Array<number>(dimensions).fill(0);
  for (const vector of vectors) {
    if (vector.length !== dimensions) throw new Error(`Local neural embedding extractor returned a ${vector.length}-dimension vector, expected ${dimensions}.`);
    for (let index = 0; index < dimensions; index += 1) sums[index] = (sums[index] ?? 0) + (vector[index] ?? 0);
  }
  return sums.map((sum) => sum / vectors.length);
}

/**
 * The bundled OPEN-MODEL local default embedding provider (user decision,
 * 2026-08-13, superseding the interim `createLocalHashProvider` default --
 * see `docs/decisions/16-semantic-search-wiring.md`): a real sentence-
 * embedding neural model run entirely on-device through transformers.js's
 * ONNX runtime, downloaded once into `cache_dir` and reused thereafter.
 * `createLocalHashProvider` (`@urdira/engine`) is NOT superseded in the
 * codebase -- it remains hermetic test/dev infrastructure (no model, no
 * network, no async construction) and the fallback a bare `DaemonRuntime`
 * reaches for when no provider is injected at all.
 *
 * Construction is async and happens ONCE: it builds the extractor (via
 * `extractor_factory`, defaulting to `defaultExtractorFactory`) and then
 * probes its output dimensionality by embedding `DIMENSION_PROBE_TEXT` --
 * the model itself is the only thing that knows how many dimensions its
 * pooled output has, so there is no way to fill in `EmbeddingProfile.dimensions`
 * without actually running it once. The SAME extractor instance is reused
 * for every subsequent `generateVector` call -- re-loading the ONNX session
 * per call would be both slow and pointless, since nothing about the model
 * changes between calls.
 *
 * Document vs. query rendering (PINNED, mirrors `createLocalHashProvider`'s
 * own PINNED-algorithm framing): a document is split into consecutive,
 * non-overlapping `window_chars`-sized windows (`computeWindows`), capped at
 * `max_windows`, embedded in ONE batched extractor call, then mean-pooled
 * (`meanPoolWindowVectors`) into a single vector -- batching matters because
 * transformers.js pipelines usually parallelize a batch far more
 * efficiently than an equivalent sequence of single-text calls. A query is
 * only ever the FIRST window (`computeWindows(text, window_chars, 1)`) --
 * queries are short by construction in every caller of this provider, and a
 * multi-window mean-pooled query vector would blur together substrings that
 * were never meant to be understood as one query. Either way, whitespace-only
 * or empty text throws before any extractor call happens: the reconciler
 * (`semantic-reconciler.ts`) already pre-filters obviously-empty documents
 * via its own regex, so this throw is a defensive backstop matching the
 * hash provider's `skipped_empty` contract, not the primary line of
 * defense.
 *
 * `input_digest` is a digest of `{purpose, profile_digest, text_digest}` --
 * the text's OWN digest, never the raw text or a per-window/per-token digest
 * array. This mirrors `createLocalHashProvider`'s identical choice and the
 * regression it fixes: an unbounded per-token shape blew the canonical
 * encoder's resource limit (`uce:resource_limit_exceeded`) on multi-megabyte
 * generated source files that still sit under the reconciler's byte guard
 * (see that provider's doc comment for the exact incident). Digesting the
 * text's digest loses no identity -- the embedded vector is a pure function
 * of `(purpose, profile, text)` regardless of provider instance -- while
 * staying bounded no matter how large the input text is.
 *
 * `runtime_binding_id` is `"core:onnx-local"`; `executable_binding_digest`
 * covers `{runtime: "transformers.js", package_version, model_id, dtype,
 * window_chars, max_windows, pooling: "mean-l2"}` -- `package_version` is
 * read from the ACTUALLY INSTALLED `@huggingface/transformers` package at
 * construction time (`resolveTransformersPackageVersion`), never
 * hardcoded, so a transformers.js upgrade that changes inference output
 * (a real possibility for an ONNX runtime upgrade) is a detectable identity
 * change rather than silent vector-space drift. `cache_dir` and
 * `allow_download` do NOT participate in this digest, or in `profile_digest`,
 * or anywhere else: they only affect WHERE/WHETHER the model is fetched
 * from, never what a fixed model+dtype actually computes once loaded, so
 * two providers that differ only there must be -- and are, by construction
 * -- byte-identical at the digest layer. Rotating a data root's model cache
 * location must never force a profile swap / full re-embed.
 *
 * `embedding_profile_id` is `core:onnx-<model_id sanitized>-<dims>` (e.g.
 * `core:onnx-xenova-all-minilm-l6-v2-384`) -- deliberately NOT a function of
 * `dtype`: two providers running the same model at two different
 * quantization levels (say, `q8` vs `fp32`) usually probe to the same
 * dimensionality and are treated as the same PROFILE, but they are NOT
 * treated as comparable vector spaces, because the reconciler's
 * profile-swap-close logic (`semantic-reconciler.ts`) keys on the
 * `(profile_id, executable_binding_id)` PAIR, and `dtype` is part of
 * `executable_binding_digest`. A dtype change still safely triggers a full
 * re-embed under a new binding identity; it just doesn't also need a new
 * `embedding_profile_id`.
 *
 * Determinism note (per decision 06's "exact-build artifact" framing, cited
 * directly in the pinned spec): this provider's vectors are deterministic
 * PER HOST -- the same model, dtype, and ONNX runtime build on the same
 * machine will always produce the same vector for the same text. They are
 * NOT guaranteed bit-identical ACROSS machines/architectures/ONNX runtime
 * builds the way `createLocalHashProvider`'s pure-integer-arithmetic vectors
 * are -- floating-point kernel implementations can legitimately differ at
 * the last few bits across CPU vendors/SIMD paths. That is an accepted
 * property of running a real neural model locally, not a bug in this
 * provider; every vector comparison in this system is already scoped to
 * `exactVectorScan` running against vectors written by ONE provider
 * identity within ONE workspace's own generation history, never compared
 * across hosts.
 */
/**
 * Options for `ensureLocalEmbeddingModel` below -- deliberately a NARROWER
 * subset of `LocalNeuralProviderOptions` (no `window_chars`/`max_windows`/
 * `allow_download`): provisioning only cares whether `model_id`+`dtype` can
 * be resolved from `cache_dir` at all, never the windowing/pooling knobs
 * that only affect a REAL `generateVector` call. `cache_dir` is required
 * here (unlike the provider's own optional field) because provisioning
 * without a concrete cache directory to provision INTO would be meaningless.
 */
export interface EnsureLocalEmbeddingModelOptions {
  readonly model_id?: string;
  readonly dtype?: string;
  readonly cache_dir: string;
  /** Same injectable seam as `LocalNeuralProviderOptions.extractor_factory` -- see its own doc comment. A hermetic test fake can throw on its first N invocations (simulating "not present in the cache yet") and succeed afterward (simulating "just downloaded"), entirely without a real model or network. */
  readonly extractor_factory?: LocalNeuralProviderOptions["extractor_factory"];
  /**
   * Observability hook (owner decision 2026-08-13, docs/decisions/18-semantic-model-pack.md
   * Outcome): called synchronously, exactly once, at the instant this
   * function has determined the model is genuinely absent offline and is
   * about to make its ONE network-touching attempt -- i.e. right before the
   * `allow_download: true` retry below, never before the offline attempt is
   * tried first. This is the single point a caller can observe "a download
   * is starting" BEFORE it happens, so a configure-time RPC handler can log
   * a start-of-download line and never let the download run silently.
   * Never called when the offline attempt alone succeeds (nothing to
   * download) or when neither attempt succeeds (the download never actually
   * started, only failed at the same point every other failure would).
   */
  readonly on_download_start?: (info: { readonly model_id: string; readonly cache_dir: string }) => void;
}

/**
 * Configure-time model provisioning (USER DECISION, 2026-08-13): the open
 * embedding model is downloaded when urdira is CONFIGURED (the daemon's
 * `core:workspace_add`/`core:workspace_configure`/`core:configuration_set`
 * admin RPCs -- see `packages/daemon/src/semantic-provider-runtime.ts`'s
 * `ensureSemanticAssets`), never at daemon start, never on first query/index
 * use. This function is the actual "is it there; if not, fetch it" check
 * those call sites run: it makes EXACTLY TWO `createLocalNeuralProvider`
 * construction attempts --
 *
 * 1. `allow_download: false` -- succeeds iff the model is already present
 *    in `cache_dir` (or the library's own default cache), touching the
 *    network not at all. A success here means "present": nothing to
 *    download, the model was already provisioned by an earlier configure
 *    call (or came pre-warmed some other way).
 * 2. Only reached if (1) failed: `allow_download: true` -- this is the ONE
 *    point in the whole system that may reach the network, since it is only
 *    ever called from a configure-time admin RPC, never from daemon start or
 *    an embed path. A success here means "downloaded". A failure here
 *    (still offline, no network, bad model id) propagates as a rejection --
 *    the caller's own job is to warn and continue without blocking
 *    structural indexing, not this function's.
 *
 * Both attempts build a full, real (or, in tests, fake-backed) provider --
 * including the dimension probe -- rather than only checking file existence
 * on disk: transformers.js's own on-disk cache layout/resolution logic is
 * the only reliable source of truth for "is this model actually usable from
 * this cache_dir", and duplicating that logic here (guessing at file paths)
 * would drift from it. The constructed provider itself is discarded --
 * only which attempt succeeded, and the model id, are reported back.
 */
export async function ensureLocalEmbeddingModel(options: EnsureLocalEmbeddingModelOptions): Promise<{ readonly status: "present" | "downloaded"; readonly model_id: string }> {
  const modelId = options.model_id ?? DEFAULT_MODEL_ID;
  const attempt = (allowDownload: boolean): Promise<ResolvedSemanticProvider> => createLocalNeuralProvider({
    model_id: modelId,
    cache_dir: options.cache_dir,
    allow_download: allowDownload,
    ...(options.dtype === undefined ? {} : { dtype: options.dtype }),
    ...(options.extractor_factory === undefined ? {} : { extractor_factory: options.extractor_factory }),
  });
  try {
    await attempt(false);
    return { status: "present", model_id: modelId };
  } catch {
    options.on_download_start?.({ model_id: modelId, cache_dir: options.cache_dir });
    await attempt(true);
    return { status: "downloaded", model_id: modelId };
  }
}

export async function createLocalNeuralProvider(options: LocalNeuralProviderOptions = {}): Promise<ResolvedSemanticProvider> {
  const modelId = options.model_id ?? DEFAULT_MODEL_ID;
  const dtype = options.dtype ?? DEFAULT_DTYPE;
  const windowChars = options.window_chars ?? DEFAULT_WINDOW_CHARS;
  const maxWindows = options.max_windows ?? DEFAULT_MAX_WINDOWS;
  const allowDownload = options.allow_download ?? true;
  if (!Number.isSafeInteger(windowChars) || windowChars <= 0) throw new Error("Local neural embedding provider window_chars must be a positive integer.");
  if (!Number.isSafeInteger(maxWindows) || maxWindows <= 0) throw new Error("Local neural embedding provider max_windows must be a positive integer.");

  const extractorFactory = options.extractor_factory ?? defaultExtractorFactory;
  const extractor = await extractorFactory({
    model_id: modelId,
    dtype,
    ...(options.cache_dir === undefined ? {} : { cache_dir: options.cache_dir }),
    allow_download: allowDownload,
  });

  const probe = await extractor([DIMENSION_PROBE_TEXT]);
  const probeVector = probe[0];
  if (probeVector === undefined || probeVector.length === 0) throw new Error("Local neural embedding extractor produced no output while probing dimensions.");
  const dimensions = probeVector.length;

  const packageVersion = resolveTransformersPackageVersion();
  const modelSegment = sanitizeModelIdSegment(modelId);

  const profile = embeddingProfile({
    embedding_profile_id: `core:onnx-${modelSegment}-${dimensions}`,
    definition_revision: 1,
    schema_version: 1,
    description: `Bundled open-model local embedder: transformers.js feature-extraction over "${modelId}", windowed and mean-pooled, L2-normalized. Downloads on first use into the configured cache directory; runs fully on-device thereafter.`,
    embedding_contract_version: "1",
    model_provider_id: "transformers.js",
    model_id: modelId,
    model_revision: "1",
    model_identity_digest: digestOf({ model_provider_id: "transformers.js", model_id: modelId, model_revision: "1" }),
    tokenizer_id: "transformers.js:auto-tokenizer",
    tokenizer_revision: "1",
    tokenizer_digest: digestOf({ tokenizer_id: "transformers.js:auto-tokenizer", tokenizer_revision: "1", model_id: modelId }),
    document_input_contract: "core:onnx-document-v1",
    query_input_contract: "core:onnx-query-v1",
    segmentation_contract: "core:onnx-window-v1",
    maximum_document_tokens: String(windowChars * maxWindows),
    maximum_query_tokens: String(windowChars),
    dimensions,
    element_type: "float32",
    vector_encoding: "float32-le",
    normalization: "l2",
    distance_metric: "cosine",
    language_support: "all",
    supported_query_classes: "all",
    supported_content_classes: "all",
    agent_guidance: `Real neural sentence embeddings from "${modelId}" via transformers.js/ONNX, windowed over long documents and mean-pooled. Vectors are deterministic per host but not guaranteed bit-identical across machines/ONNX builds -- see decision 06's exact-build-artifact framing.`,
    lifecycle_state: "active",
  });

  const runtimeBindingId = "core:onnx-local";
  // Deliberately excludes `cache_dir`/`allow_download` -- see the module doc
  // comment above.
  const executableBindingDigest = digestOf({ runtime: "transformers.js", package_version: packageVersion, model_id: modelId, dtype, window_chars: windowChars, max_windows: maxWindows, pooling: "mean-l2" });

  /**
   * Builds ONE input's windows the same way `generateVector` below does:
   * document purpose windows the full text up to `maxWindows`; query
   * purpose is always exactly the FIRST window, regardless of `maxWindows`.
   * Throws the identical "no extractable content" error `generateVector`
   * throws for empty/whitespace text -- shared here so `generateVectors`'
   * batch windowing can never silently diverge from the single-input path.
   */
  function windowsFor(input: GenerateVectorInput): readonly string[] {
    if (input.text.trim().length === 0) throw new Error("Local neural embedding provider found no extractable content in the given text.");
    const windows = input.purpose === "query" ? computeWindows(input.text, windowChars, 1) : computeWindows(input.text, windowChars, maxWindows);
    if (windows.length === 0) throw new Error("Local neural embedding provider found no extractable content in the given text.");
    return windows;
  }

  /** Same bounded input_digest discipline as `createLocalHashProvider` -- see the module doc comment above for the regression this avoids. Shared by `generateVector` and `generateVectors` so both compute it identically. */
  function inputDigestFor(input: GenerateVectorInput): string {
    return digestOf({ purpose: input.purpose, profile_digest: input.profile.profile_digest, text_digest: digestBytes(new TextEncoder().encode(input.text)) });
  }

  function pooledVectorFor(input: GenerateVectorInput, windowVectors: ReadonlyArray<Float32Array | readonly number[]>): SemanticGeneratedVector {
    // Pools/validates against `input.profile.dimensions` (not this closure's
    // own `dimensions`) -- same "the profile a caller passes in is
    // authoritative" convention `createHttpEmbeddingProvider` and
    // `createLocalHashProvider` both follow; the two values are always equal
    // in practice since `profile` and `binding` are only ever produced
    // together and used as the pair they came from.
    const pooled = meanPoolWindowVectors(windowVectors, input.profile.dimensions);
    const vector = canonicalVectorBytes(pooled, {
      dimensions: input.profile.dimensions,
      element_type: input.profile.element_type as "float32" | "float64",
      normalization: input.profile.normalization as "none" | "l2",
    });
    return { vector, vector_digest: digestBytes(vector), input_digest: inputDigestFor(input), profile_digest: input.profile.profile_digest };
  }

  return {
    profile,
    binding: {
      runtime_binding_id: runtimeBindingId,
      executable_binding_digest: executableBindingDigest,
      generateVector: async (input) => {
        const windows = windowsFor(input);
        const embedded = await extractor(windows);
        if (embedded.length !== windows.length) throw new Error(`Local neural embedding extractor returned ${embedded.length} vectors for ${windows.length} input windows.`);
        return pooledVectorFor(input, embedded);
      },
      /**
       * Flattens every input's own windows (each computed exactly as
       * `generateVector`'s `windowsFor` would) into ONE ordered list, then
       * issues extractor calls over CONSECUTIVE CHUNKS of that flattened
       * list capped at `maxWindows` windows each (reusing the same
       * `max_windows` option a single document's own cap is already
       * derived from -- see `LocalNeuralProviderOptions.max_windows`'s doc
       * comment) -- splitting into several extractor calls only when the
       * batch's TOTAL window count exceeds that cap. Chunk boundaries never
       * need to respect document boundaries: each window is embedded
       * independently by the extractor regardless of which chunk carries
       * it, so a document whose windows happen to straddle two chunks still
       * mean-pools correctly once every chunk's output is collected back
       * into the single flattened `embeddedFlat` array below, in order.
       *
       * ALL-OR-NOTHING, per `SemanticRuntimeBinding.generateVectors`'s own
       * doc comment: `windowsFor` throwing for ANY single input (the
       * empty/whitespace backstop) or an extractor call returning the wrong
       * vector count for its chunk rejects the WHOLE batch -- isolating
       * which specific input actually poisoned it is `reconcileSemanticProjection`'s
       * job (falling back to per-document `generateVector` calls), not this
       * method's.
       */
      generateVectors: async (inputs) => {
        const perInputWindows = inputs.map((input) => windowsFor(input));

        const flatWindows: string[] = [];
        const ranges: Array<{ readonly start: number; readonly count: number }> = [];
        for (const windows of perInputWindows) {
          ranges.push({ start: flatWindows.length, count: windows.length });
          flatWindows.push(...windows);
        }

        const embeddedFlat: Array<Float32Array | readonly number[]> = [];
        for (let offset = 0; offset < flatWindows.length; offset += maxWindows) {
          const chunk = flatWindows.slice(offset, offset + maxWindows);
          const embeddedChunk = await extractor(chunk);
          if (embeddedChunk.length !== chunk.length) throw new Error(`Local neural embedding extractor returned ${embeddedChunk.length} vectors for ${chunk.length} input windows.`);
          embeddedFlat.push(...embeddedChunk);
        }

        return inputs.map((input, index) => {
          const range = ranges[index]!;
          return pooledVectorFor(input, embeddedFlat.slice(range.start, range.start + range.count));
        });
      },
    },
  };
}
