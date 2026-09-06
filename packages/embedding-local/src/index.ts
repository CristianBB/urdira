import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { canonicalBytes, digestBytes } from "@urdira/canonical";
import type { EmbeddingProfile } from "@urdira/contracts";
import { canonicalVectorBytes, CHARS_PER_TOKEN_ESTIMATE, DEFAULT_MAX_SEGMENTS, DEFAULT_SEGMENT_OVERLAP_TOKENS, DEFAULT_SEGMENT_WINDOW_TOKENS, segmenterIdentity, type GenerateVectorInput, type ResolvedSemanticProvider, type SegmentSpan, type Segmentation, type SemanticGeneratedVector } from "@urdira/engine";
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
export type EmbeddingExtractor = ((texts: readonly string[]) => Promise<ReadonlyArray<Float32Array | readonly number[]>>) & {
  /**
   * Frente S-B (2026-09-06): optional per-text token counter/offset provider,
   * attached to the SAME function object `extractor_factory` returns (a
   * function is an object in JS; this keeps `EmbeddingExtractor` a single
   * value rather than widening every caller's type to a `{embed, tokenize}`
   * pair). `defaultExtractorFactory` below attaches one backed by the real
   * pipeline's own `tokenizer`; a test's hand-written fake naturally omits
   * it, which is exactly what exercises `segmentByTokens`'s
   * no-tokenizer-at-all fallback (see that function's own doc comment) --
   * the SAME fallback a real tokenizer without offset support (see
   * `tokenizeWithOffsets`'s own doc comment on `defaultExtractorFactory`)
   * also exercises.
   */
  readonly tokenizeWithOffsets?: TextTokenizer;
};

export interface LocalNeuralProviderOptions {
  /** Hugging Face model id. Default `"Xenova/all-MiniLM-L6-v2"` -- a small, widely-cached sentence-embedding model with no gated/licensed download step. */
  readonly model_id?: string;
  /** transformers.js `env.cacheDir` -- where downloaded/cached model weights live on disk. The app passes `<data_root>/models`; omitted here (and in every test), transformers.js falls back to its own library default. Deliberately excluded from every digest this module computes -- see `createLocalNeuralProvider`'s doc comment. */
  readonly cache_dir?: string;
  /** ONNX weight quantization to load. Default `"q8"` (8-bit quantized weights) -- a deliberate quality/size/speed tradeoff for a *bundled* default that downloads on first use; an operator who wants full float32 precision can override it. */
  readonly dtype?: string;
  /**
   * DEPRECATED (Frente S-B, 2026-09-06): superseded by the token-based
   * segmenter (`window_tokens`/`overlap_tokens`/`max_segments` below, R7/R8)
   * -- accepted for backward source compatibility but IGNORED, with a
   * one-time `console.warn` when set to a value other than `undefined`. Never
   * participates in `executable_binding_digest` (there is nothing left for
   * it to identify).
   */
  readonly window_chars?: number;
  /** DEPRECATED (Frente S-B, 2026-09-06): superseded by `max_segments` below. See `window_chars`'s own doc comment -- same ignored-with-warning treatment. */
  readonly max_windows?: number;
  /** Token-based segmenter window size, in tokens (R7: MiniLM's own trained `max_seq_length`). Default 256 (`DEFAULT_SEGMENT_WINDOW_TOKENS`, `@urdira/engine`). */
  readonly window_tokens?: number;
  /** Token-based segmenter overlap between consecutive segments, in tokens (R7). Default 32 (`DEFAULT_SEGMENT_OVERLAP_TOKENS`). */
  readonly overlap_tokens?: number;
  /** At most this many segments of a single document are produced; the artifact-grain lane mean-pools all of them into one vector (R9), the entity-grain lane (via `.binding.segment`) embeds one vector PER segment. Exceeding this cap sets `Segmentation.truncated` (R8: `reason_code = "segments_truncated"`, never silent). Default 64 (`DEFAULT_MAX_SEGMENTS`). */
  readonly max_segments?: number;
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
/** Fixed probe text used once at construction to discover the model's output dimensionality -- see `createLocalNeuralProvider`'s doc comment. Never embedded as a real document or query. */
const DIMENSION_PROBE_TEXT = "urdira dimension probe";

/**
 * Frente S-B (2026-09-06): one text's token count and, when the underlying
 * tokenizer can report them, per-token character offsets -- the shared input
 * shape `segmentByTokens` accepts. `offsets`, when present, is an ORDERED
 * list of `[start_char, end_char)` pairs covering only non-degenerate
 * (`end > start`) CONTENT tokens -- a real fast tokenizer's special/padding
 * tokens (`[CLS]`/`[SEP]`, historically reported at offset `(0, 0)`) must
 * already be filtered out by whatever produces this value, never left in for
 * `segmentByTokens` to trip over. Omitted (not an empty array) when the
 * tokenizer has no offset support at all -- see `segmentByTokens`'s own
 * fallback doc comment.
 */
export interface TokenizedSpan {
  readonly token_count: number;
  readonly offsets?: ReadonlyArray<readonly [number, number]>;
}

/** A text -> `TokenizedSpan` function -- `defaultExtractorFactory` below attaches a real one (backed by the loaded pipeline's own tokenizer) to every `EmbeddingExtractor` it builds; `segmentByTokens` accepts `undefined` for a caller (typically a test fake) with no tokenizer at all. */
export type TextTokenizer = (text: string) => TokenizedSpan;

export interface SegmentByTokensOptions {
  readonly window_tokens?: number;
  readonly overlap_tokens?: number;
  readonly max_segments?: number;
}

/** `TextTokenizer` fallback when no real tokenizer is available at all: approximates one token as `CHARS_PER_TOKEN_ESTIMATE` UTF-16 code units, the same heuristic the hash/HTTP providers' own char-based segmenter uses (`@urdira/engine`'s `segmentByChars`). Never reports offsets -- always routes `segmentByTokens` into the line-based fallback below. */
function charEstimateTokenizer(text: string): TokenizedSpan {
  return { token_count: Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)) };
}

/**
 * Precise path: slides a `window_tokens`-wide, `overlap_tokens`-overlapping
 * window directly over `offsets` (already known to be non-empty), stepping
 * by `window_tokens - overlap_tokens` tokens each time. Each segment's
 * `start_char`/`end_char` are read straight off the first/last covered
 * token's own offsets, so `text.slice(start_char, end_char)` is always
 * exactly the tokens the model itself would see for that segment -- no
 * approximation.
 */
function segmentFromOffsets(text: string, offsets: ReadonlyArray<readonly [number, number]>, windowTokens: number, overlapTokens: number, maxSegments: number): Segmentation {
  const step = windowTokens - overlapTokens;
  const segments: SegmentSpan[] = [];
  let truncated = false;
  for (let tokenStart = 0; tokenStart < offsets.length; tokenStart += step) {
    if (segments.length >= maxSegments) { truncated = true; break; }
    const tokenEnd = Math.min(tokenStart + windowTokens, offsets.length);
    const startChar = offsets[tokenStart]![0];
    const endChar = offsets[tokenEnd - 1]![1];
    segments.push({ index: segments.length, text: text.slice(startChar, endChar), start_char: startChar, end_char: endChar });
    if (tokenEnd >= offsets.length) break;
  }
  return { segments, truncated };
}

/**
 * Deterministic fallback for a tokenizer with no offset support (R7's own
 * anticipated case -- and, empirically, this package's OWN bundled MiniLM
 * tokenizer today: `AutoTokenizer`'s `__call__` never populates
 * `offset_mapping` for this model, so this is the path every real,
 * non-test-fake construction of this provider actually runs, not a rare
 * edge case). Splits `text` into LINES (each line's span running through its
 * own trailing `\n`, so every line's span concatenated back together
 * reconstructs `text` exactly), counts each line's own tokens via
 * `tokenize`, then greedily accumulates whole lines into a segment until
 * adding the next line would exceed `windowTokens` (always keeping at least
 * one line per segment, even if that one line alone exceeds the window --
 * guarantees forward progress for a single enormous line). The next
 * segment's starting line rewinds far enough into the segment just closed
 * that the rewound lines' own token counts sum to at least `overlapTokens`
 * (falling forward to the segment's own end when the whole segment's token
 * count is itself under `overlapTokens`, so a segment made of very few,
 * very large lines still always advances). Never true token-level overlap
 * (there is no sub-line boundary to overlap at) -- a documented,
 * line-granularity approximation of R7's token overlap, not the precise
 * offset-based path's guarantee.
 */
function segmentByLines(text: string, tokenize: TextTokenizer, windowTokens: number, overlapTokens: number, maxSegments: number): Segmentation {
  const lines: Array<{ readonly start: number; readonly end: number; readonly tokenCount: number }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const newlineIndex = text.indexOf("\n", cursor);
    const end = newlineIndex === -1 ? text.length : newlineIndex + 1;
    const tokenCount = Math.max(1, tokenize(text.slice(cursor, end)).token_count);
    lines.push({ start: cursor, end, tokenCount });
    cursor = end;
  }
  if (lines.length === 0) return { segments: [], truncated: false };

  const segments: SegmentSpan[] = [];
  let truncated = false;
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    if (segments.length >= maxSegments) { truncated = true; break; }
    let tokenSum = 0;
    let endLineIndex = lineIndex;
    while (endLineIndex < lines.length) {
      const line = lines[endLineIndex]!;
      if (tokenSum > 0 && tokenSum + line.tokenCount > windowTokens) break;
      tokenSum += line.tokenCount;
      endLineIndex += 1;
      if (tokenSum >= windowTokens) break;
    }
    const segmentStart = lines[lineIndex]!.start;
    const segmentEnd = lines[endLineIndex - 1]!.end;
    segments.push({ index: segments.length, text: text.slice(segmentStart, segmentEnd), start_char: segmentStart, end_char: segmentEnd });
    if (endLineIndex >= lines.length) break;
    let overlapTokenSum = 0;
    let overlapStartLineIndex = endLineIndex;
    while (overlapStartLineIndex > lineIndex && overlapTokenSum < overlapTokens) {
      overlapStartLineIndex -= 1;
      overlapTokenSum += lines[overlapStartLineIndex]!.tokenCount;
    }
    // Guarantees forward progress: if rewinding for overlap would not
    // actually move past this segment's own start line, resume from where
    // this segment ended instead (no overlap for that one transition).
    lineIndex = overlapStartLineIndex > lineIndex ? overlapStartLineIndex : endLineIndex;
  }
  return { segments, truncated };
}

/**
 * Frente S-B.2 (plan §4.5, R7/R8): the token-based segmenter that replaces
 * `computeWindows` for BOTH document grains (R9) -- `tokenizer`, when given,
 * is tried first via its offsets (`segmentFromOffsets`, precise); when
 * `tokenizer` is entirely absent OR reports no offsets for this particular
 * text, falls back to `segmentByLines` (deterministic, line-granularity).
 * Both paths honor the identical `window_tokens`/`overlap_tokens`/`max_segments`
 * contract and produce the identical `Segmentation` shape, so every caller
 * (the artifact-grain mean-pool path, the entity-grain per-segment path, and
 * `scripts/semantic-window-histogram.mjs`) treats them uniformly. Empty text
 * produces zero segments (`{segments: [], truncated: false}`) -- callers
 * that require at least one segment (e.g. `windowsFor` below, for the
 * "no extractable content" empty-text throw) must check for this themselves.
 */
export function segmentByTokens(text: string, tokenizer: TextTokenizer | undefined, options: SegmentByTokensOptions = {}): Segmentation {
  const windowTokens = options.window_tokens ?? DEFAULT_SEGMENT_WINDOW_TOKENS;
  const overlapTokens = options.overlap_tokens ?? DEFAULT_SEGMENT_OVERLAP_TOKENS;
  const maxSegments = options.max_segments ?? DEFAULT_MAX_SEGMENTS;
  if (!Number.isSafeInteger(windowTokens) || windowTokens <= 0) throw new Error("segmentByTokens window_tokens must be a positive integer.");
  if (!Number.isSafeInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= windowTokens) throw new Error("segmentByTokens overlap_tokens must be a non-negative integer smaller than window_tokens.");
  if (!Number.isSafeInteger(maxSegments) || maxSegments <= 0) throw new Error("segmentByTokens max_segments must be a positive integer.");
  if (text.length === 0) return { segments: [], truncated: false };
  const tokenize = tokenizer ?? charEstimateTokenizer;
  const whole = tokenize(text);
  if (whole.offsets !== undefined && whole.offsets.length > 0) return segmentFromOffsets(text, whole.offsets, windowTokens, overlapTokens, maxSegments);
  return segmentByLines(text, tokenize, windowTokens, overlapTokens, maxSegments);
}

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
  const embed = async (texts: readonly string[]) => {
    const output = await extractor([...texts], { pooling: "mean", normalize: true });
    // `Tensor.tolist()` on a `[batch, dimensions]`-shaped tensor (which is
    // exactly what `{pooling: "mean"}` over a batch of texts produces) is a
    // `number[][]`, one row per input text, in input order -- see the
    // library's own `feature-extraction` pipeline doc comment/example.
    return output.tolist() as number[][];
  };
  /**
   * Frente S-B (2026-09-06): backed by the loaded pipeline's OWN tokenizer
   * (`extractor.tokenizer`), never a separately-loaded one -- guarantees the
   * token count/segmentation this reports is for the EXACT tokenizer that
   * will actually process each segment's text at embed time. Empirically
   * (verified against the bundled `Xenova/all-MiniLM-L6-v2` tokenizer),
   * `tokenizer(text, {return_offsets_mapping: true})` never populates
   * `offset_mapping` for this model at all -- transformers.js's fast-tokenizer
   * offset support is model/tokenizer-dependent, and this one does not
   * provide it -- so `token_count` comes from `tokenizer.tokenize(text)`
   * (the tokenizer's own content-token-only, no-CLS/SEP string list) and
   * `offsets` is always omitted here, routing `segmentByTokens` into its
   * deterministic line-based fallback for every REAL construction of this
   * provider today. Wrapped in try/catch purely as a defensive backstop
   * against a future tokenizer whose `tokenize` method throws on
   * pathological input -- falls back to the same chars/4 estimate
   * `segmentByTokens`'s own no-tokenizer path uses, never lets a
   * segmentation call fail an embed.
   */
  const tokenizeWithOffsets: TextTokenizer = (text: string): TokenizedSpan => {
    try {
      const tokens = (extractor.tokenizer as { readonly tokenize: (value: string) => readonly string[] }).tokenize(text);
      return { token_count: Array.isArray(tokens) ? tokens.length : Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)) };
    } catch {
      return { token_count: Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)) };
    }
  };
  return Object.assign(embed, { tokenizeWithOffsets });
}

/**
 * Element-wise mean over `vectors` (one per embedded SEGMENT -- Frente S-B
 * renamed this module's own vocabulary from "window" to "segment", see
 * `segmentByTokens`), all assumed to already be `dimensions` long -- the
 * model's own `{pooling: "mean", normalize: true}` has already reduced each
 * segment's token sequence down to one unit vector, so this is the SECOND,
 * document-level pooling stage: it turns "one vector per segment" into "one
 * vector for the whole document" before `canonicalVectorBytes` L2-normalizes
 * the result (R9: the artifact-grain lane's own single vector). A
 * single-segment document (the common case, and always true for a query --
 * see `createLocalNeuralProvider`) degenerates to this being a no-op copy.
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

/**
 * Frente S-B.1 (2026-09-06, `scripts/semantic-window-histogram.mjs`): loads
 * just the tokenizer side of the bundled model (via the SAME
 * `extractor_factory` seam `createLocalNeuralProvider` uses) and returns a
 * single `countTotalTokens` function, for a caller that needs an accurate
 * TOTAL token count for a whole document -- not a segment boundary --
 * without assuming any particular `window_tokens`/`overlap_tokens` pair.
 * This is NOT simply `segmentByTokens(text, tokenizer, {window_tokens: 1,
 * ...}).segments.length`: for a tokenizer with no offset support (this
 * package's own bundled MiniLM tokenizer, empirically, today --
 * see `defaultExtractorFactory`'s doc comment), `segmentByTokens` falls back
 * to LINE-granularity accumulation, and a `window_tokens: 1` cap there
 * degenerates to "one segment per LINE" (each line's own token count
 * almost always exceeds 1), not "one segment per TOKEN" -- silently
 * undercounting a multi-token line down to 1. `countTotalTokens` instead
 * sums each line's own token count directly, mirroring `segmentByLines`'s
 * internal per-line accumulation exactly (so it agrees with what a REAL
 * segmentation over this text would internally add up), without needing to
 * cap anything.
 */
export async function createLocalTokenCounter(options: LocalNeuralProviderOptions = {}): Promise<{ readonly countTotalTokens: (text: string) => number }> {
  const modelId = options.model_id ?? DEFAULT_MODEL_ID;
  const dtype = options.dtype ?? DEFAULT_DTYPE;
  const allowDownload = options.allow_download ?? true;
  const extractorFactory = options.extractor_factory ?? defaultExtractorFactory;
  const extractor = await extractorFactory({
    model_id: modelId,
    dtype,
    ...(options.cache_dir === undefined ? {} : { cache_dir: options.cache_dir }),
    allow_download: allowDownload,
  });
  const tokenize = extractor.tokenizeWithOffsets;
  return {
    countTotalTokens: (text: string): number => {
      if (text.length === 0) return 0;
      if (tokenize === undefined) return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE));
      const whole = tokenize(text);
      if (whole.offsets !== undefined) return whole.offsets.length;
      let total = 0;
      let cursor = 0;
      while (cursor < text.length) {
        const newlineIndex = text.indexOf("\n", cursor);
        const end = newlineIndex === -1 ? text.length : newlineIndex + 1;
        total += Math.max(1, tokenize(text.slice(cursor, end)).token_count);
        cursor = end;
      }
      return total;
    },
  };
}

export async function createLocalNeuralProvider(options: LocalNeuralProviderOptions = {}): Promise<ResolvedSemanticProvider> {
  const modelId = options.model_id ?? DEFAULT_MODEL_ID;
  const dtype = options.dtype ?? DEFAULT_DTYPE;
  const windowTokens = options.window_tokens ?? DEFAULT_SEGMENT_WINDOW_TOKENS;
  const overlapTokens = options.overlap_tokens ?? DEFAULT_SEGMENT_OVERLAP_TOKENS;
  const maxSegments = options.max_segments ?? DEFAULT_MAX_SEGMENTS;
  const allowDownload = options.allow_download ?? true;
  if (!Number.isSafeInteger(windowTokens) || windowTokens <= 0) throw new Error("Local neural embedding provider window_tokens must be a positive integer.");
  if (!Number.isSafeInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= windowTokens) throw new Error("Local neural embedding provider overlap_tokens must be a non-negative integer smaller than window_tokens.");
  if (!Number.isSafeInteger(maxSegments) || maxSegments <= 0) throw new Error("Local neural embedding provider max_segments must be a positive integer.");
  // DEPRECATED aliases (Frente S-B, 2026-09-06): accepted, never consulted
  // for behavior -- see `LocalNeuralProviderOptions.window_chars`'s own doc
  // comment. Warn exactly once per construction call, not once per
  // generate call, so a long-lived provider built with a deprecated option
  // does not spam the log on every embed.
  if (options.window_chars !== undefined) console.warn(`[urdira] LocalNeuralProviderOptions.window_chars is deprecated and ignored -- the segmenter now uses window_tokens (default ${DEFAULT_SEGMENT_WINDOW_TOKENS}).`);
  if (options.max_windows !== undefined) console.warn(`[urdira] LocalNeuralProviderOptions.max_windows is deprecated and ignored -- the segmenter now uses max_segments (default ${DEFAULT_MAX_SEGMENTS}).`);

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
    maximum_document_tokens: String(windowTokens * maxSegments),
    maximum_query_tokens: String(windowTokens),
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
  // comment above. `segmenter` (R10) replaces the old `window_chars`/
  // `max_windows` fields -- those are gone entirely (they no longer affect
  // anything real, see the deprecation warnings above), and a segmenter
  // parameter change now bumps this identity the same way it does for the
  // hash/HTTP providers (`semantic-provider.ts`'s `segmenterIdentity`).
  const executableBindingDigest = digestOf({ runtime: "transformers.js", package_version: packageVersion, model_id: modelId, dtype, segmenter: segmenterIdentity(maxSegments, windowTokens, overlapTokens), pooling: "mean-l2" });

  /**
   * Builds ONE input's segments via `segmentByTokens`, using this provider's
   * OWN extractor's `tokenizeWithOffsets` when present (see
   * `EmbeddingExtractor`'s own doc comment) -- document purpose segments the
   * full text up to `maxSegments`; query purpose is always exactly the FIRST
   * segment (`max_segments: 1`), regardless of `maxSegments`, mirroring the
   * pre-segmenter "query is always the first window" behavior exactly.
   * Throws the identical "no extractable content" error `generateVector`
   * throws for empty/whitespace text -- shared here so `generateVectors`'
   * batch segmentation can never silently diverge from the single-input path.
   */
  function segmentsFor(input: GenerateVectorInput): readonly SegmentSpan[] {
    if (input.text.trim().length === 0) throw new Error("Local neural embedding provider found no extractable content in the given text.");
    const segmentation = segmentByTokens(input.text, extractor.tokenizeWithOffsets, {
      window_tokens: windowTokens,
      overlap_tokens: overlapTokens,
      max_segments: input.purpose === "query" ? 1 : maxSegments,
    });
    if (segmentation.segments.length === 0) throw new Error("Local neural embedding provider found no extractable content in the given text.");
    return segmentation.segments;
  }

  /** Same bounded input_digest discipline as `createLocalHashProvider` -- see the module doc comment above for the regression this avoids. Shared by `generateVector` and `generateVectors` so both compute it identically. `segment_index` (Frente S-B) folds in when the caller is embedding one pre-cut segment of a larger entity document (see `SemanticGenerateInput.segment_index`'s own doc comment). */
  function inputDigestFor(input: GenerateVectorInput): string {
    return digestOf({ purpose: input.purpose, profile_digest: input.profile.profile_digest, text_digest: digestBytes(new TextEncoder().encode(input.text)), ...(input.segment_index === undefined ? {} : { segment_index: input.segment_index }) });
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
        const segments = segmentsFor(input);
        const texts = segments.map((segment) => segment.text);
        const embedded = await extractor(texts);
        if (embedded.length !== texts.length) throw new Error(`Local neural embedding extractor returned ${embedded.length} vectors for ${texts.length} input segments.`);
        return pooledVectorFor(input, embedded);
      },
      /**
       * Flattens every input's own segments (each computed exactly as
       * `generateVector`'s `segmentsFor` would) into ONE ordered list, then
       * issues extractor calls over CONSECUTIVE CHUNKS of that flattened
       * list capped at `maxSegments` segments each (reusing the same
       * `max_segments` option a single document's own cap is already
       * derived from -- see `LocalNeuralProviderOptions.max_segments`'s doc
       * comment) -- splitting into several extractor calls only when the
       * batch's TOTAL segment count exceeds that cap. Chunk boundaries never
       * need to respect document boundaries: each segment is embedded
       * independently by the extractor regardless of which chunk carries
       * it, so a document whose segments happen to straddle two chunks still
       * mean-pools correctly once every chunk's output is collected back
       * into the single flattened `embeddedFlat` array below, in order.
       *
       * ALL-OR-NOTHING, per `SemanticRuntimeBinding.generateVectors`'s own
       * doc comment: `segmentsFor` throwing for ANY single input (the
       * empty/whitespace backstop) or an extractor call returning the wrong
       * vector count for its chunk rejects the WHOLE batch -- isolating
       * which specific input actually poisoned it is `reconcileSemanticProjection`'s
       * job (falling back to per-document `generateVector` calls), not this
       * method's.
       */
      generateVectors: async (inputs) => {
        const perInputSegments = inputs.map((input) => segmentsFor(input));

        const flatTexts: string[] = [];
        const ranges: Array<{ readonly start: number; readonly count: number }> = [];
        for (const segments of perInputSegments) {
          ranges.push({ start: flatTexts.length, count: segments.length });
          flatTexts.push(...segments.map((segment) => segment.text));
        }

        const embeddedFlat: Array<Float32Array | readonly number[]> = [];
        for (let offset = 0; offset < flatTexts.length; offset += maxSegments) {
          const chunk = flatTexts.slice(offset, offset + maxSegments);
          const embeddedChunk = await extractor(chunk);
          if (embeddedChunk.length !== chunk.length) throw new Error(`Local neural embedding extractor returned ${embeddedChunk.length} vectors for ${chunk.length} input segments.`);
          embeddedFlat.push(...embeddedChunk);
        }

        return inputs.map((input, index) => {
          const range = ranges[index]!;
          return pooledVectorFor(input, embeddedFlat.slice(range.start, range.start + range.count));
        });
      },
      // Frente S-B.2 (R7/R8): exposes this provider's OWN token-based
      // segmenter to the reconciler's entity pass, using the exact same
      // `segmentByTokens`/`tokenizeWithOffsets` path `segmentsFor` uses for
      // a "document"-purpose call (never the query-purpose 1-segment cap).
      segment: async (text: string): Promise<Segmentation> => segmentByTokens(text, extractor.tokenizeWithOffsets, { window_tokens: windowTokens, overlap_tokens: overlapTokens, max_segments: maxSegments }),
    },
  };
}
