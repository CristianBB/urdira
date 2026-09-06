import { canonicalBytes, digestBytes, digestToBytes } from "@urdira/canonical";
import type { EmbeddingProfile } from "@urdira/contracts";
import { buildSemanticDocument, type SemanticDocument } from "./semantic-documents.js";

export interface SemanticVectorConfiguration {
  readonly dimensions: number;
  readonly element_type: "float32" | "float64";
  readonly normalization: "none" | "l2";
}

/**
 * Frente S-B (2026-09-06), R7/R8/R10: one addressable slice of a document's
 * text a provider embeds independently, in the shared shape every provider's
 * `SemanticRuntimeBinding.segment?` and `@urdira/embedding-local`'s
 * `segmentByTokens` both produce. `start_char`/`end_char` are UTF-16 code
 * unit offsets into the ORIGINAL text passed to the segmenter (never into a
 * normalized/lowercased copy), so a caller can always recover `text` via
 * `originalText.slice(start_char, end_char)` -- and `text` itself is provided
 * directly so callers never need to re-slice at all.
 */
export interface SegmentSpan {
  readonly index: number;
  readonly text: string;
  readonly start_char: number;
  readonly end_char: number;
}

/**
 * The result of segmenting one document's text: its ordered segments (never
 * empty for non-empty input -- see each segmenter's own doc comment for the
 * empty-text convention) plus whether more content existed beyond
 * `max_segments` (R8: `reason_code = "segments_truncated"`, never silent).
 */
export interface Segmentation {
  readonly segments: readonly SegmentSpan[];
  readonly truncated: boolean;
}

/**
 * R8 (plan §0): the shared, single-source-of-truth default cap on segments
 * per document across every provider (`embedding-local`'s token segmenter,
 * and this module's own char segmenter for the hash/HTTP providers) -- ola 3
 * measures n8n's actual p99 segment count and may raise this (never above
 * 256, per R8's own ceiling), but the constant lives in exactly ONE place so
 * every provider's default moves together. Lives in `@urdira/engine` (not
 * `@urdira/embedding-local`) because `@urdira/engine`'s own hash/HTTP
 * providers need it too, and `@urdira/embedding-local` already depends on
 * `@urdira/engine` (never the reverse -- see this package's other imports).
 */
export const DEFAULT_MAX_SEGMENTS = 64;

/**
 * R7 (plan §0): the pinned segmenter window/overlap, in TOKENS -- MiniLM's
 * own trained `max_seq_length`, with a 32-token overlap so a match spanning
 * a window boundary is never split into two half-strength vectors. The
 * token-based segmenter (`@urdira/embedding-local`'s `segmentByTokens`) uses
 * these directly; the char-based segmenter below approximates a token as 4
 * UTF-16 code units (the same rough heuristic `semantic-provider.ts`'s
 * pre-existing `HTTP_INPUT_TEXT_CAP` sizing already assumed) for providers
 * with no real tokenizer to consult.
 */
export const DEFAULT_SEGMENT_WINDOW_TOKENS = 256;
export const DEFAULT_SEGMENT_OVERLAP_TOKENS = 32;
/** chars-per-token approximation shared by every char-based segmenter (hash/HTTP providers, and `embedding-local`'s own line-based token-count fallback when no real tokenizer is available at all). */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

export interface SegmentByCharsOptions {
  readonly window_chars: number;
  readonly overlap_chars: number;
  readonly max_segments?: number;
}

/**
 * Frente S-B: deterministic, tokenizer-free segmenter for providers with no
 * real subword tokenizer to consult (the bundled hash provider, and the HTTP
 * provider -- see each one's own `.binding.segment` in `semantic-provider.ts`).
 * Approximates "tokens" as fixed-size runs of UTF-16 code units
 * (`window_chars`/`overlap_chars`, chosen by the caller as
 * `token_count * CHARS_PER_TOKEN_ESTIMATE`): consecutive windows of
 * `window_chars` characters, stepping forward by `window_chars -
 * overlap_chars` each time (never less than 1 -- validated below), capped at
 * `max_segments` (default `DEFAULT_MAX_SEGMENTS`). Mirrors
 * `embedding-local`'s `segmentByTokens` offset-based path exactly, one layer
 * down (chars instead of tokens) -- same overlap/cap/truncation semantics,
 * so the reconciler's entity pass treats every provider's segmentation
 * uniformly regardless of which one produced it.
 *
 * Empty text produces zero segments (`{segments: [], truncated: false}`) --
 * callers that require at least one segment (the reconciler's own
 * empty-document pre-check already filters these out before segmenting at
 * all) must check for this themselves, exactly like
 * `embedding-local`'s `segmentByTokens`.
 */
export function segmentByChars(text: string, options: SegmentByCharsOptions): Segmentation {
  const windowChars = options.window_chars;
  const overlapChars = options.overlap_chars;
  const maxSegments = options.max_segments ?? DEFAULT_MAX_SEGMENTS;
  if (!Number.isSafeInteger(windowChars) || windowChars <= 0) throw new Error("segmentByChars window_chars must be a positive integer.");
  if (!Number.isSafeInteger(overlapChars) || overlapChars < 0 || overlapChars >= windowChars) throw new Error("segmentByChars overlap_chars must be a non-negative integer smaller than window_chars.");
  if (!Number.isSafeInteger(maxSegments) || maxSegments <= 0) throw new Error("segmentByChars max_segments must be a positive integer.");
  if (text.length === 0) return { segments: [], truncated: false };
  const step = windowChars - overlapChars;
  const segments: SegmentSpan[] = [];
  let truncated = false;
  for (let start = 0; start < text.length; start += step) {
    if (segments.length >= maxSegments) { truncated = true; break; }
    const end = Math.min(start + windowChars, text.length);
    segments.push({ index: segments.length, text: text.slice(start, end), start_char: start, end_char: end });
    if (end >= text.length) break;
  }
  return { segments, truncated };
}

function vectorValues(value: readonly number[] | Uint8Array, configuration: SemanticVectorConfiguration): number[] {
  const width = configuration.element_type === "float32" ? 4 : 8;
  if (value instanceof Uint8Array) {
    if (value.byteLength !== configuration.dimensions * width) throw new Error("Semantic vector byte length does not match its dimensions.");
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    return Array.from({ length: configuration.dimensions }, (_, index) => configuration.element_type === "float32" ? view.getFloat32(index * width, true) : view.getFloat64(index * width, true));
  }
  if (value.length !== configuration.dimensions) throw new Error("Semantic vector length does not match its dimensions.");
  return [...value];
}

export function canonicalVectorBytes(value: readonly number[] | Uint8Array, configuration: SemanticVectorConfiguration): Uint8Array {
  if (!Number.isSafeInteger(configuration.dimensions) || configuration.dimensions <= 0) throw new Error("Semantic vector dimensions must be positive.");
  let values = vectorValues(value, configuration);
  if (values.some((item) => !Number.isFinite(item))) throw new Error("Semantic vector values must be finite.");
  if (configuration.normalization === "l2") {
    const norm = Math.sqrt(values.reduce((sum, item) => sum + item * item, 0));
    if (norm === 0) throw new Error("Semantic vector cannot normalize a zero vector.");
    values = values.map((item) => item / norm);
  }
  const width = configuration.element_type === "float32" ? 4 : 8;
  const bytes = new Uint8Array(values.length * width);
  const view = new DataView(bytes.buffer);
  values.forEach((item, index) => {
    const normalized = Object.is(item, -0) ? 0 : item;
    if (configuration.element_type === "float32") view.setFloat32(index * width, normalized, true);
    else view.setFloat64(index * width, normalized, true);
  });
  return bytes;
}

export interface SemanticInferenceInput {
  readonly purpose: "document" | "query";
  readonly profile: EmbeddingProfile;
  readonly text: string;
  readonly token_ids: readonly string[];
  readonly input_digest: string;
}

export interface SemanticInferencePort {
  infer(input: SemanticInferenceInput): Promise<readonly number[] | Uint8Array>;
}

export interface SemanticRendererPort {
  render(text: string): string;
}

export class CoreDocumentRenderer implements SemanticRendererPort {
  render(text: string): string { return text; }
}

export class CoreQueryRenderer implements SemanticRendererPort {
  render(text: string): string { return text; }
}

export class CoreTokenizer {
  tokenize(text: string): readonly string[] { return text.match(/\S+/gu) ?? []; }
}

export class CoreSegmenter {
  segment(tokens: readonly string[], maximumTokens: number): readonly (readonly string[])[] {
    if (!Number.isSafeInteger(maximumTokens) || maximumTokens <= 0) throw new Error("Semantic token limit must be positive.");
    const parts: string[][] = [];
    for (let index = 0; index < tokens.length; index += maximumTokens) parts.push([...tokens.slice(index, index + maximumTokens)]);
    return parts.length > 0 ? parts : [[]];
  }
}

export class DeterministicOnnxInferencePort implements SemanticInferencePort {
  async infer(input: SemanticInferenceInput): Promise<readonly number[]> {
    const seed = digestToBytes(digestBytes(canonicalBytes({ purpose: input.purpose, profile: input.profile.profile_digest, text: input.text, token_ids: input.token_ids })));
    return Array.from({ length: input.profile.dimensions }, (_, index) => ((seed[index % seed.length] ?? 0) / 127.5) - 1);
  }
}

export interface SemanticGeneratedVector {
  readonly vector: Uint8Array;
  readonly vector_digest: string;
  readonly input_digest: string;
  readonly profile_digest: string;
}

export interface SemanticGenerateInput {
  readonly runtime_binding_id: string;
  readonly executable_binding_digest: string;
  readonly profile: EmbeddingProfile;
  readonly purpose: "document" | "query";
  readonly text: string;
  /**
   * Frente S-B (decision 17 segmentation): which segment of its owning
   * document `text` is, when the caller already segmented it (the
   * reconciler's entity pass, one call per segment) -- folded into
   * `input_digest` so two DIFFERENT segments that happen to render identical
   * text (a short, repeated line) still get distinguishable digests. Omitted
   * (not `undefined`) for every non-segmented call (every artifact-grain
   * call, and every query), matching this codebase's `exactOptionalPropertyTypes`
   * convention for every other optional field here.
   */
  readonly segment_index?: number;
}

/** The per-call shape every binding's `generateVector`/`generateVectors` accepts: `SemanticGenerateInput` minus the two identity fields a binding already carries on itself (`runtime_binding_id`, `executable_binding_digest`) -- callers pass those once, at binding-resolution time, never per call. */
export type GenerateVectorInput = Omit<SemanticGenerateInput, "runtime_binding_id" | "executable_binding_digest">;

export interface SemanticRuntimeBinding {
  readonly runtime_binding_id: string;
  readonly executable_binding_digest: string;
  generateVector(input: GenerateVectorInput): Promise<SemanticGeneratedVector>;
  /**
   * OPTIONAL positional batch counterpart to `generateVector`: given N
   * inputs, resolves with N vectors in the SAME order (`result[i]`
   * corresponds to `inputs[i]`), computed with the exact same
   * digest/identity construction `generateVector` uses for each input --
   * for a deterministic binding (the hash provider), a batched call MUST
   * produce byte-identical vectors, `vector_digest`s, and `input_digest`s to
   * the equivalent sequence of individual `generateVector` calls; for a
   * numeric neural binding, only the digest CONSTRUCTION need match (the
   * underlying floating-point values may drift at the last bits between a
   * batched and a sequential run -- same accepted per-host, per-runtime-build
   * non-determinism `embedding-local/src/index.ts`'s own doc comment already
   * calls out for `generateVector`, since vectors are only ever compared
   * within one provider identity, never across a batched-vs-sequential
   * boundary).
   *
   * Deliberately ALL-OR-NOTHING: a binding that cannot embed every input in
   * the batch (one malformed/oversized/network-poisoned input among many
   * otherwise-fine ones) rejects the WHOLE call rather than returning a
   * mixed array of results and per-item errors -- keeping this signature as
   * simple as `generateVector`'s own. Isolating which single input actually
   * failed is the CALLER's job: `reconcileSemanticProjection`
   * (`semantic-reconciler.ts`) falls back to per-document `generateVector`
   * calls for a batch that this method rejects, which finds the poison
   * input the same way today's fully-sequential loop always has.
   *
   * Absent entirely on any binding that has no efficient batched path (e.g.
   * `DeterministicSemanticRuntime`'s bindings may or may not implement it --
   * see its own doc comment) -- every caller MUST handle absence by falling
   * back to sequential `generateVector` calls, never assume this method
   * exists.
   */
  generateVectors?(inputs: readonly GenerateVectorInput[]): Promise<readonly SemanticGeneratedVector[]>;
  /**
   * Frente S-B (decision 17 segmentation, R7-R10): splits `text` into the
   * segments THIS binding's provider would embed one-per-segment for an
   * entity-grain document -- the reconciler's entity pass (`semantic-reconciler.ts`)
   * calls this once per candidate entity's rendered text, then calls
   * `generateVector`/`generateVectors` once per returned segment (with
   * `segment_index` set), producing one `vector_projection_rows` row per
   * segment rather than one per document. Absent on a binding that has no
   * segmentation of its own (should not happen for any of the three shipped
   * providers -- local neural, hash, HTTP -- but kept optional for the same
   * reason `generateVectors` is: a caller MUST treat an absent method as "one
   * segment covering the whole text" (`{segments: [{index: 0, text, start_char:
   * 0, end_char: text.length}], truncated: false}`), never as an error.
   * Deterministic and side-effect-free: calling this twice with the same
   * `text` on the same binding instance always returns the identical
   * segmentation.
   */
  segment?(text: string): Promise<Segmentation>;
}

export interface DeterministicSemanticRuntimeOptions {
  readonly inference?: SemanticInferencePort;
  readonly failFor?: ReadonlySet<string>;
}

function tokenIds(text: string): readonly string[] {
  return (text.match(/\S+/gu) ?? []).map((token) => digestBytes(new TextEncoder().encode(token)));
}

export class DeterministicSemanticRuntime {
  readonly #inference: SemanticInferencePort;
  readonly #failFor: ReadonlySet<string>;

  constructor(options: DeterministicSemanticRuntimeOptions = {}) {
    this.#failFor = options.failFor ?? new Set();
    this.#inference = options.inference ?? new DeterministicOnnxInferencePort();
  }

  binding(runtimeBindingId: string, executableBindingDigest: string): SemanticRuntimeBinding {
    if (!runtimeBindingId.startsWith("core:")) throw new Error(`Semantic runtime binding ${runtimeBindingId} is outside the core namespace.`);
    const generateVector = async (input: GenerateVectorInput): Promise<SemanticGeneratedVector> => {
      if (this.#failFor.has(runtimeBindingId)) throw new Error(`Semantic runtime ${runtimeBindingId} failed.`);
      const tokenIdsValue = tokenIds(input.text);
      const inputDigest = digestBytes(canonicalBytes({ purpose: input.purpose, profile_digest: input.profile.profile_digest, text: input.text, token_ids: tokenIdsValue, ...(input.segment_index === undefined ? {} : { segment_index: input.segment_index }) }));
      const generated = await this.#inference.infer({ purpose: input.purpose, profile: input.profile, text: input.text, token_ids: tokenIdsValue, input_digest: inputDigest });
      const vector = canonicalVectorBytes(generated, { dimensions: input.profile.dimensions, element_type: input.profile.element_type as "float32" | "float64", normalization: input.profile.normalization as "none" | "l2" });
      return { vector, vector_digest: digestBytes(vector), input_digest: inputDigest, profile_digest: input.profile.profile_digest };
    };
    return {
      runtime_binding_id: runtimeBindingId,
      executable_binding_digest: executableBindingDigest,
      generateVector,
      // Trivial sequential loop -- see `SemanticRuntimeBinding.generateVectors`'s
      // doc comment: present here purely so a test using this deterministic
      // runtime can exercise the batch path too, not because looping is any
      // faster than calling `generateVector` N times directly.
      generateVectors: async (inputs) => {
        const results: SemanticGeneratedVector[] = [];
        for (const input of inputs) results.push(await generateVector(input));
        return results;
      },
    };
  }

  tokenize(text: string): readonly string[] { return tokenIds(text); }

  segment(text: string, maximumTokens: string | number): readonly string[] {
    const limit = typeof maximumTokens === "number" ? maximumTokens : Number(maximumTokens);
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Semantic token limit must be positive.");
    const tokens = text.match(/\S+/gu) ?? [];
    const parts: string[] = [];
    for (let index = 0; index < tokens.length; index += limit) parts.push(tokens.slice(index, index + limit).join(" "));
    return parts.length > 0 ? parts : [""];
  }

  async generateDocumentVector(document: SemanticDocument, input: Omit<SemanticGenerateInput, "text" | "purpose"> & { readonly profile: EmbeddingProfile }): Promise<SemanticGeneratedVector> {
    return this.binding(input.runtime_binding_id, input.executable_binding_digest).generateVector({ profile: input.profile, purpose: "document", text: document.sections.map((section) => section.text).join("\n") });
  }
}

export class SemanticRuntimeRegistry {
  readonly #bindings: ReadonlyMap<string, SemanticRuntimeBinding>;

  constructor(bindings: readonly SemanticRuntimeBinding[]) {
    const map = new Map<string, SemanticRuntimeBinding>();
    for (const binding of bindings) {
      if (!binding.runtime_binding_id.startsWith("core:")) throw new Error(`Semantic runtime binding ${binding.runtime_binding_id} is outside the core namespace.`);
      if (map.has(binding.runtime_binding_id)) throw new Error(`Duplicate semantic runtime binding ${binding.runtime_binding_id}.`);
      map.set(binding.runtime_binding_id, binding);
    }
    this.#bindings = map;
  }

  binding(runtimeBindingId: string, executableBindingDigest: string): SemanticRuntimeBinding {
    if (!runtimeBindingId.startsWith("core:")) throw new Error(`Semantic runtime binding ${runtimeBindingId} is outside the core namespace.`);
    const binding = this.#bindings.get(runtimeBindingId);
    if (!binding || binding.executable_binding_digest !== executableBindingDigest) throw new Error(`Semantic runtime binding ${runtimeBindingId} is unavailable or incompatible.`);
    return binding;
  }

  async generateVector(input: SemanticGenerateInput): Promise<SemanticGeneratedVector> {
    return this.binding(input.runtime_binding_id, input.executable_binding_digest).generateVector({ profile: input.profile, purpose: input.purpose, text: input.text });
  }
}

export { buildSemanticDocument } from "./semantic-documents.js";
export type { SemanticDocument, SemanticDocumentInput, SemanticDocumentSection } from "./semantic-documents.js";
