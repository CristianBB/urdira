import { canonicalBytes, digestBytes } from "@urdira/canonical";
import type { EmbeddingProfile } from "@urdira/contracts";
import { canonicalVectorBytes, CHARS_PER_TOKEN_ESTIMATE, DEFAULT_MAX_SEGMENTS, DEFAULT_SEGMENT_OVERLAP_TOKENS, DEFAULT_SEGMENT_WINDOW_TOKENS, segmentByChars, type GenerateVectorInput, type Segmentation, type SemanticGeneratedVector, type SemanticRuntimeBinding } from "./semantic-runtime.js";

/**
 * Frente S-B (R7/R8/R10): the segmenter identity string folded into every
 * provider's `executable_binding_digest` -- `v2` (the "cut into
 * tokenizer-window segments, one vector per segment for entity-grain
 * documents" generation, replacing the pre-segmentation `v1` identity every
 * provider implicitly had), `w<N>`/`o<N>` the window/overlap actually in
 * effect, `max<N>` the per-document segment cap (R8). `windowTokens`/
 * `overlapTokens` default to R7's own pin (256/32) for the hash/HTTP
 * providers, which have no configurable window/overlap of their own; the
 * local neural provider (`@urdira/embedding-local`) passes its OWN actually-
 * configured values here instead of assuming the pin, so two instances
 * genuinely configured with DIFFERENT window/overlap values never collide
 * on the same identity (a real data-integrity requirement, not merely
 * cosmetic: two incompatible vector spaces sharing one
 * `executable_binding_id` would let `exactVectorScan` silently compare
 * vectors that were never meant to be comparable). Identical shape across
 * all three providers so a segmenter-parameter change (e.g. ola 3 raising
 * `max_segments` per R8's own measurement clause) is a single shared string
 * shape that bumps every provider's identity together, forcing the one-time
 * full re-embed R10 accepts as its cost.
 */
export function segmenterIdentity(maxSegments: number, windowTokens: number = DEFAULT_SEGMENT_WINDOW_TOKENS, overlapTokens: number = DEFAULT_SEGMENT_OVERLAP_TOKENS): string {
  return `segmenter:v2:w${windowTokens}:o${overlapTokens}:max${maxSegments}`;
}

/**
 * A fully resolved embedding provider: the `EmbeddingProfile` identity record
 * a caller must stamp onto every vector row it writes, paired with the
 * `SemanticRuntimeBinding` that actually turns text into bytes for that
 * profile. This is the shape the reconciler (`semantic-reconciler.ts`) and
 * the query port (`canonical-query-data-port.ts`) both depend on -- neither
 * of them knows or cares whether the vectors come from the bundled local
 * hash embedder or an HTTP-backed neural model; they only ever see this pair.
 * `profile` and `binding` are produced together (never independently) so the
 * two identities -- `profile.embedding_profile_id` / `profile_digest` and
 * `binding.runtime_binding_id` / `executable_binding_digest` -- can never
 * drift apart within a single provider instance.
 */
export interface ResolvedSemanticProvider {
  readonly profile: EmbeddingProfile;
  readonly binding: SemanticRuntimeBinding;
}

const LOCAL_HASH_DIMENSIONS = 256;

/**
 * Splits a raw `[A-Za-z0-9_$]+` regex match into identifier-shaped
 * subtokens, in three ordered passes: `_`/`$` boundaries, then digit/alpha
 * boundaries, then camelCase humps within each surviving alpha run. Order
 * matters -- e.g. `"my_Var2"` first splits on `_` into `["my", "Var2"]`,
 * then the digit/alpha pass splits `"Var2"` into `["Var", "2"]`, then the
 * camelCase pass splits `"Var"` into `["Var"]` (a single hump, nothing to
 * split) while leaving the digit run `"2"` untouched (digit runs are never
 * further split). The camelCase regex below is the standard
 * acronym-aware hump splitter: `[A-Z]+(?=[A-Z][a-z])` peels off a leading
 * uppercase run that is itself followed by another uppercase+lowercase pair
 * (so `"XMLHttpRequest"` yields `"XML"`, not `"XMLH"`), `[A-Z]?[a-z]+`
 * captures an optional capital plus the lowercase run that follows it (e.g.
 * `"Http"`), and the trailing `[A-Z]+` catches any leftover all-caps run
 * (e.g. a trailing acronym with no lowercase tail at all).
 */
function splitSubtokens(rawMatch: string): readonly string[] {
  const underscoreParts = rawMatch.split(/[_$]+/).filter((part) => part.length > 0);
  const subtokens: string[] = [];
  for (const part of underscoreParts) {
    const alphaDigitRuns = part.match(/[A-Za-z]+|[0-9]+/g) ?? [];
    for (const run of alphaDigitRuns) {
      if (/^[0-9]+$/.test(run)) {
        subtokens.push(run);
        continue;
      }
      const humps = run.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+/g) ?? [];
      subtokens.push(...humps);
    }
  }
  return subtokens;
}

/**
 * PINNED tokenization for the local hash embedder (`core:local-hash-256-v1`)
 * -- see the module doc comment above `createLocalHashProvider` for why this
 * is pinned bit-for-bit. Extracts every `[A-Za-z0-9_$]+` run from `text` and,
 * for each run, emits BOTH its lowercased full form and its lowercased
 * identifier subtokens (see `splitSubtokens`), in that order, as one flat
 * token stream. Emitting the full form alongside its subtokens lets a query
 * for the exact compound identifier (`"parseHtml"`) and a query for one of
 * its parts (`"html"`) both land hash buckets shared with a document that
 * contains the compound -- overlap happens at whichever granularity the
 * query and the document happen to share.
 */
export function extractLocalHashTokens(text: string): readonly string[] {
  const matches = text.match(/[A-Za-z0-9_$]+/g) ?? [];
  const tokens: string[] = [];
  for (const match of matches) {
    const full = match.toLowerCase();
    if (full.length > 0) tokens.push(full);
    for (const sub of splitSubtokens(match)) {
      const lowered = sub.toLowerCase();
      if (lowered.length > 0) tokens.push(lowered);
    }
  }
  return tokens;
}

const FNV_PRIME = 0x01000193;
const FNV_H1_SEED = 0x811c9dc5;
const FNV_H2_SEED = 0x811c9dc5 ^ 0x9e3779b9;

/**
 * Standard FNV-1a over `bytes`, seeded with `seed`. The multiply-by-prime
 * step uses `Math.imul` (not plain `*` followed by `>>> 0`) because plain
 * JS multiplication of two 32-bit-ish operands silently loses low bits once
 * the product exceeds 2^53 -- `Math.imul` performs the correct wrapping
 * 32-bit multiply that the FNV-1a algorithm actually specifies. Getting this
 * wrong would silently change every hash bucket assignment, which is exactly
 * the kind of drift the bit-stability tests in `tests/semantic-provider.test.ts`
 * exist to catch.
 */
function fnv1a(bytes: Uint8Array, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    hash = (hash ^ bytes[index]!) >>> 0;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * PINNED accumulation for the local hash embedder: counts term frequency
 * across the full token stream (full forms + subtokens, see
 * `extractLocalHashTokens`), then for each UNIQUE token hashes its UTF-8
 * bytes twice with independent FNV-1a seeds (`h1`, `h2`) and adds a signed,
 * log-dampened term-frequency weight into one of 256 buckets: the bucket
 * index comes from `h1`, the sign comes from `h2`'s low bit. This is the
 * "hashing trick" (a la Vowpal Wabbit / feature hashing) applied to a fixed
 * 256-dimension space -- two unrelated tokens that collide into the same
 * bucket partially cancel or reinforce depending on their signs, which is an
 * accepted, deliberate lossy tradeoff for a dependency-free, offline
 * embedder (see the doc comment on `createLocalHashProvider`).
 *
 * Returns the raw (non-normalized) 256-length accumulation. Throws if the
 * accumulation comes out all-zero -- which happens not only when there were
 * no tokens at all, but also (rarely) when the only tokens present happen to
 * collide into the same bucket with equal magnitude and opposite sign and
 * fully cancel. Either way, an all-zero accumulation cannot be L2-normalized
 * into a unit vector, so callers must treat it as "no embeddable content"
 * (`skipped_empty` in the reconciler).
 */
function accumulateLocalHash(tokens: readonly string[]): readonly number[] {
  const buckets = new Array<number>(LOCAL_HASH_DIMENSIONS).fill(0);
  const termFrequency = new Map<string, number>();
  for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
  const encoder = new TextEncoder();
  for (const [token, frequency] of termFrequency) {
    const bytes = encoder.encode(token);
    const h1 = fnv1a(bytes, FNV_H1_SEED);
    const h2 = fnv1a(bytes, FNV_H2_SEED);
    const bucket = h1 % LOCAL_HASH_DIMENSIONS;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    buckets[bucket] = (buckets[bucket] ?? 0) + sign * (1 + Math.log(frequency));
  }
  if (buckets.every((value) => value === 0)) throw new Error("Local hash embedder produced an all-zero accumulation (no extractable tokens, or complete bucket cancellation).");
  return buckets;
}

/**
 * Runs the full PINNED local hash algorithm over `text` and returns the raw
 * (pre-L2-normalization) 256-dimension accumulation. Exported as a small
 * pure function, separate from `extractLocalHashTokens` and
 * `accumulateLocalHash`, purely so tests can assert on each stage
 * independently without going through the full `ResolvedSemanticProvider`
 * plumbing (digest construction, `EmbeddingProfile` wiring, etc).
 */
export function computeLocalHashVector(text: string): readonly number[] {
  const tokens = extractLocalHashTokens(text);
  if (tokens.length === 0) throw new Error("Local hash embedder found no extractable tokens in the given text.");
  return accumulateLocalHash(tokens);
}

function digestOf(value: unknown): string {
  return digestBytes(canonicalBytes(value));
}

/**
 * Builds an `EmbeddingProfile` and computes `profile_digest` over every
 * OTHER field (never over itself) -- the same "digest the struct minus its
 * own digest field" discipline `semantic-documents.ts`'s `section()` uses
 * for `section_digest`. `Omit<EmbeddingProfile, "profile_digest">` makes it
 * impossible to accidentally pass a `profile_digest` into the payload that
 * gets hashed.
 */
function embeddingProfile(withoutDigest: Omit<EmbeddingProfile, "profile_digest">): EmbeddingProfile {
  return { ...withoutDigest, profile_digest: digestOf(withoutDigest) };
}

const LOCAL_HASH_PROFILE: EmbeddingProfile = embeddingProfile({
  embedding_profile_id: "core:local-hash-256-v1",
  definition_revision: 1,
  schema_version: 1,
  description: "Interim bundled local embedder: deterministic 256-dimension feature-hashed bag-of-subtokens vectors, keyed on identifier/token overlap. No neural model, no network, no non-determinism.",
  embedding_contract_version: "1",
  model_provider_id: "core",
  model_id: "local-hash",
  model_revision: "1",
  model_identity_digest: digestOf({ model_provider_id: "core", model_id: "local-hash", model_revision: "1" }),
  tokenizer_id: "core:local-hash-tokenizer",
  tokenizer_revision: "1",
  tokenizer_digest: digestOf({ tokenizer_id: "core:local-hash-tokenizer", tokenizer_revision: "1", algorithm: "regex-subtoken-fnv1a-hashing-trick-v1" }),
  document_input_contract: "core:local-hash-document-v1",
  query_input_contract: "core:local-hash-query-v1",
  segmentation_contract: "core:local-hash-none-v1",
  maximum_document_tokens: "1000000",
  maximum_query_tokens: "1000000",
  dimensions: LOCAL_HASH_DIMENSIONS,
  element_type: "float32",
  vector_encoding: "float32-le",
  normalization: "l2",
  distance_metric: "cosine",
  language_support: "all",
  supported_query_classes: "all",
  supported_content_classes: "all",
  agent_guidance: "Deterministic, offline, dependency-free retrieval keyed on identifier/token overlap in a shared vector space. Treat matches as lexical-adjacent overlap, not learned semantic similarity -- there is no trained model behind these vectors.",
  lifecycle_state: "active",
});

const LOCAL_HASH_RUNTIME_BINDING_ID = "core:local-hash";
// Frente S-B: `segmenter` participates in this digest even though the hash
// provider's own artifact-grain embedding call (`generateVector`/
// `generateVectors` below) never changed -- R9 keeps the artifact lane at
// ONE vector for every provider, and the hash provider already satisfied
// that trivially (it always embedded the whole document in one call, no
// windowing). The entity-grain pass now calls this provider's `.segment`
// (below) instead, and the identity must reflect that a segmenter-parameter
// change (R8's own ola-3 measurement clause) invalidates every entity vector
// this provider ever wrote, exactly like it does for the other two providers.
const LOCAL_HASH_EXECUTABLE_BINDING_DIGEST = digestOf({ runtime: "core:local-hash", algorithm_version: 1, segmenter: segmenterIdentity(DEFAULT_MAX_SEGMENTS) });
/** Frente S-B: chars/4 approximation of the pinned 256-token window (R7) for a provider with no real subword tokenizer -- see `segmentByChars`'s own doc comment. */
const LOCAL_HASH_SEGMENT_WINDOW_CHARS = DEFAULT_SEGMENT_WINDOW_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
const LOCAL_HASH_SEGMENT_OVERLAP_CHARS = DEFAULT_SEGMENT_OVERLAP_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

/**
 * The bundled default embedding provider: a pure-JS, offline, dependency-free
 * "hashing trick" bag-of-subtokens embedder (see `computeLocalHashVector`
 * and the PINNED algorithm doc comments above it). This is explicitly an
 * INTERIM model -- decision doc 06 defers the evaluated neural model pack
 * (see `selectBundledProfile` / `docs/decisions/06-*.md`) because it was not
 * yet ready to ship; this provider exists so semantic search has *something*
 * to run against in the meantime, with retrieval quality bounded by
 * identifier/token overlap rather than learned meaning. It has no cold-start
 * cost, no model weights to bundle, and produces bit-identical vectors for
 * bit-identical text forever (no version skew across machines or Node
 * versions -- the only inputs are `String.prototype.match`, UTF-8 encoding,
 * and 32-bit integer arithmetic).
 *
 * IMPORTANT: every detail of the algorithm above (`extractLocalHashTokens`,
 * `splitSubtokens`, the FNV-1a seeds/prime, the bucket/sign/log-tf
 * accumulation, the L2 normalization) is part of this profile's identity.
 * Vectors embedded under `core:local-hash-256-v1` are only ever compared
 * (via `exactVectorScan`) against OTHER vectors embedded under the exact
 * same profile+binding pair -- see the `(profile_id, executable_binding_id)`
 * filter in `semantic-retrieval.ts`. Changing ANY output-affecting detail
 * here (tokenization, hashing, accumulation, or normalization) would make
 * previously-written vectors silently incomparable garbage under the OLD id
 * while a query embedded with the NEW code would still match against them.
 * The fix for a genuine algorithm change is never "edit this function" --
 * it is "mint a new `embedding_profile_id`/`runtime_binding_id` pair" (e.g.
 * `core:local-hash-256-v2`) so the reconciler's profile-swap-close path (see
 * `semantic-reconciler.ts`) closes every old-profile row and rebuilds under
 * the new one, rather than silently mixing two incompatible vector spaces.
 */
export function createLocalHashProvider(): ResolvedSemanticProvider {
  const generateVector = async (input: GenerateVectorInput): Promise<SemanticGeneratedVector> => {
    const accumulated = computeLocalHashVector(input.text);
    const vector = canonicalVectorBytes(accumulated, {
      dimensions: input.profile.dimensions,
      element_type: input.profile.element_type as "float32" | "float64",
      normalization: input.profile.normalization as "none" | "l2",
    });
    // Same input_digest/vector_digest construction discipline as
    // `DeterministicSemanticRuntime.binding` in semantic-runtime.ts, with
    // one deliberate difference: the canonical struct digests the TEXT'S
    // DIGEST, never the raw text or a per-token digest array. That
    // runtime's `{text, token_ids}` shape is unbounded -- a ~2MB
    // generated file tokenizes to hundreds of thousands of tokens, and
    // canonical-encoding one sha256 string per token blows the UCE
    // encoder's resource limit (`uce:resource_limit_exceeded`, observed
    // on excalidraw's generated wasm-embedding sources, which sit under
    // the reconciler's 2MB byte guard). The token list is a pure
    // function of the text, so digesting the text digest loses no
    // identity: two calls with identical `purpose`/`profile`/`text`
    // still always produce identical `input_digest` and `vector_digest`,
    // regardless of provider instance -- there is no per-instance state.
    const inputDigest = digestOf({ purpose: input.purpose, profile_digest: input.profile.profile_digest, text_digest: digestBytes(new TextEncoder().encode(input.text)) });
    return { vector, vector_digest: digestBytes(vector), input_digest: inputDigest, profile_digest: input.profile.profile_digest };
  };
  return {
    profile: LOCAL_HASH_PROFILE,
    binding: {
      runtime_binding_id: LOCAL_HASH_RUNTIME_BINDING_ID,
      executable_binding_digest: LOCAL_HASH_EXECUTABLE_BINDING_DIGEST,
      generateVector,
      // Trivial per-input loop over the exact same `generateVector` closure
      // above -- deterministic and cheap, so there is no batched-extractor
      // gain to chase the way the neural/HTTP providers have. Implementing
      // it here anyway (rather than leaving it absent) keeps the hermetic
      // test suite -- and `reconcileSemanticProjection`'s hash-provider tests
      // in particular -- exercising the SAME batch code path a real neural
      // deployment uses, with the strongest possible guarantee this method's
      // doc comment asks for: since each call is independent pure state,
      // looping produces vectors/digests BYTE-IDENTICAL to the equivalent
      // sequence of individual `generateVector` calls, not merely
      // digest-construction-identical.
      generateVectors: async (inputs) => {
        const results: SemanticGeneratedVector[] = [];
        for (const input of inputs) results.push(await generateVector(input));
        return results;
      },
      // Frente S-B: chars/4 segmentation (`segmentByChars`) -- see this
      // binding's own `executable_binding_digest` comment above for why the
      // artifact-grain embedding path above is UNCHANGED while this method
      // is new. Async only to satisfy `SemanticRuntimeBinding.segment`'s
      // signature (every real caller awaits it uniformly across providers);
      // the computation itself is synchronous.
      segment: async (text: string): Promise<Segmentation> => segmentByChars(text, { window_chars: LOCAL_HASH_SEGMENT_WINDOW_CHARS, overlap_chars: LOCAL_HASH_SEGMENT_OVERLAP_CHARS, max_segments: DEFAULT_MAX_SEGMENTS }),
    },
  };
}

/** Input text is truncated to this many UTF-16 code units before it is ever sent over the wire, independent of `dimensions` -- a defensive cap against provider-side token limits (most OpenAI-compatible embedding APIs reject inputs well before 32k characters of source code). The local provider has no such cap; it embeds the full text. */
const HTTP_INPUT_TEXT_CAP = 32_000;
/** R12 (plan §0): 60s per-attempt timeout, enforced with a real `AbortController` (not `AbortSignal.timeout`, which cannot be paired with a cleared timer across retries the way this module needs -- see `sendChunkWithRetry`). */
const HTTP_DEFAULT_TIMEOUT_MS = 60_000;
/** How much of a non-2xx response body to fold into the thrown error's message -- enough to see a JSON error payload's shape, not enough to dump an entire HTML error page into logs. */
const HTTP_ERROR_BODY_PREVIEW_LENGTH = 500;
/** R12: at most this many documents per `/embeddings` request, regardless of how many `generateVectors` receives in one call. */
const HTTP_DEFAULT_MAX_BATCH_INPUTS = 64;
/** R12/S-B.2: the provider's own declared per-request token budget -- also becomes `EmbeddingProfile.maximum_document_tokens` and bounds how many segments `.segment()` below will ever produce for one document (see `httpMaxSegments`'s own comment). */
const HTTP_DEFAULT_MAX_INPUT_TOKENS = 8_192;
/** R12: 0.5s / 1s / 2s backoff between the (up to) 3 retries -- 4 total attempts. Injectable per-provider via `HttpEmbeddingProviderOptions.retry_backoff_ms` purely so tests can shrink it to `[0, 0, 0]` and exercise the retry PATH without paying the real wall-clock delay. */
const HTTP_DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [500, 1000, 2000];

/**
 * R12: the typed error every batch-level HTTP transport failure raises once
 * every retry has been exhausted (or immediately, for a non-retryable
 * non-2xx status) -- `code` is a fixed, matchable string so
 * `reconcileSemanticProjection` (or any other caller) can distinguish "the
 * provider itself is unreachable/erroring" from a plain programming-error
 * `Error` thrown for a MALFORMED (but successfully received) response body
 * (missing/wrong-shaped `embedding` field, wrong dimensionality, non-finite
 * values -- see `parseChunkResponse` below, which throws plain `Error`s for
 * those, never this class: a malformed response is a provider BUG/contract
 * mismatch, not "unavailable", and retrying it would just reproduce the
 * identical malformed response).
 */
export class HttpEmbeddingProviderUnavailableError extends Error {
  readonly code = "core:embedding_provider_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "HttpEmbeddingProviderUnavailableError";
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Frente S-B (2026-09-06) fix, adversarial review item #8: `Retry-After`
 * (RFC 9110 §10.2.3) on a 429/5xx response is a server-issued MINIMUM wait,
 * either delta-seconds (`"30"`) or an HTTP-date (`"Wed, 21 Oct ... GMT"`) --
 * ignoring it (the original shape of this provider) means retrying into a
 * rate limit the server just told this provider to back off from, which
 * only makes the limiter angrier. Returns `undefined` (never `0`) for a
 * missing/unparseable header, so the caller's own `Math.max` against the
 * configured backoff never accidentally shortens it; a date already in the
 * past clamps to `0` (retry immediately) rather than a negative delay.
 */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface HttpEmbeddingProviderOptions {
  /** Full URL, used as-is (POST). No path-joining, no trailing-slash normalization. */
  readonly endpoint: string;
  readonly model: string;
  readonly dimensions: number;
  /** When set, sent as `Authorization: Bearer <api_key>`. Deliberately excluded from every digest this module computes -- see the doc comment on `createHttpEmbeddingProvider`. */
  readonly api_key?: string;
  /** Injectable for tests so nothing in this module ever needs a real network call. Defaults to `globalThis.fetch`. */
  readonly fetch_impl?: typeof fetch;
  /** Per-ATTEMPT timeout (not per-batch/per-retry-sequence). Defaults to 60_000ms (R12). */
  readonly timeout_ms?: number;
  /** R12: at most this many documents in one `/embeddings` request. Defaults to 64. `generateVectors` transparently splits a larger input array into several sequential (concurrency-1, see the module doc comment) requests. */
  readonly max_batch_inputs?: number;
  /**
   * R12/S-B.2: the provider's own declared per-request token budget --
   * `generateVectors`' chunker keeps each request's ESTIMATED total token
   * count (chars/4, `CHARS_PER_TOKEN_ESTIMATE`) at or under this value
   * (always including at least one item per chunk even if it alone exceeds
   * the budget, so a single oversized document still makes progress rather
   * than deadlocking the chunker). Also becomes `EmbeddingProfile.maximum_document_tokens`
   * and bounds `.segment()`'s own `max_segments` (`httpMaxSegments`).
   * Defaults to 8192.
   */
  readonly max_input_tokens?: number;
  /** R12: backoff (ms) between successive retries -- `retry_backoff_ms.length` is the number of RETRIES (so `length + 1` total attempts). Defaults to `[500, 1000, 2000]` (3 retries, 4 total attempts). */
  readonly retry_backoff_ms?: readonly number[];
  /** Injectable in place of a real `setTimeout`-based sleep, purely so a test can exercise the retry path without paying real wall-clock backoff delay. Defaults to a real timer-based sleep. */
  readonly sleep_impl?: (ms: number) => Promise<void>;
}

function sanitizeModelIdSegment(model: string): string {
  const sanitized = model.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized.length > 0 ? sanitized : "model";
}

/**
 * Best-effort JSON body/list-of-strings passthrough for parsing a
 * non-2xx response body into a short diagnostic string. Never throws: a
 * response whose body cannot even be read as text still gets *some*
 * message attached to the thrown error.
 */
async function previewResponseBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > HTTP_ERROR_BODY_PREVIEW_LENGTH ? `${text.slice(0, HTTP_ERROR_BODY_PREVIEW_LENGTH)}…` : text;
  } catch {
    return "<unreadable response body>";
  }
}

/**
 * R12: splits `inputs` into ordered chunks, each capped at `maxBatchInputs`
 * items AND at an ESTIMATED `maxInputTokens` total (chars/4 per item,
 * capped at `HTTP_INPUT_TEXT_CAP` first -- the same cap the request body
 * itself truncates to, so the estimate matches what is actually sent).
 * Always places at least one item per chunk even when that one item alone
 * exceeds `maxInputTokens` -- guarantees forward progress for an oversized
 * single document rather than producing an empty chunk or looping forever.
 */
function chunkForHttpRequest(inputs: readonly GenerateVectorInput[], maxBatchInputs: number, maxInputTokens: number): ReadonlyArray<readonly GenerateVectorInput[]> {
  const chunks: GenerateVectorInput[][] = [];
  let current: GenerateVectorInput[] = [];
  let currentTokens = 0;
  for (const input of inputs) {
    const cappedLength = Math.min(input.text.length, HTTP_INPUT_TEXT_CAP);
    const estimatedTokens = Math.max(1, Math.ceil(cappedLength / CHARS_PER_TOKEN_ESTIMATE));
    if (current.length > 0 && (current.length >= maxBatchInputs || currentTokens + estimatedTokens > maxInputTokens)) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(input);
    currentTokens += estimatedTokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * OpenAI-compatible HTTP embedding provider (opt-in, alternative to the
 * bundled local hash embedder). `options.api_key`, if present, is sent as a
 * bearer token on every request but MUST NEVER participate in
 * `profile.profile_digest` or `binding.executable_binding_digest` -- both
 * digests are persisted (in `vector_projection_rows` / `semantic_index_state`)
 * and compared across process restarts and across machines, and a secret
 * has no business inside a value that ends up on disk and in log-adjacent
 * diagnostics. Two providers built from options that differ ONLY in
 * `api_key` are, by design, indistinguishable at the digest layer: same
 * `embedding_profile_id`, same `profile_digest`, same
 * `executable_binding_digest`. Rotating a key must never force a profile
 * swap / full re-embed.
 *
 * `embedding_profile_id` is derived from `model` + `dimensions` only (not
 * `endpoint`) -- a deliberate v1 simplification per the pinned spec. Two
 * different endpoints serving a same-named model at the same dimensionality
 * are treated as the same profile; if that turns out to matter in practice,
 * widen the id, which mints a new profile the same way any other algorithm
 * change would (see the local provider's doc comment).
 *
 * R12 (Frente S-B.3): every `generateVector`/`generateVectors` call funnels
 * through `embedBatch` below, which (i) splits its inputs into
 * `max_batch_inputs`/`max_input_tokens`-bounded chunks
 * (`chunkForHttpRequest`), (ii) sends those chunks SEQUENTIALLY -- a plain
 * `for` loop with `await`, never `Promise.all` -- enforcing concurrency 1
 * against the configured endpoint, and (iii) retries each chunk's request up
 * to `retry_backoff_ms.length` times, ONLY on a 429/5xx status or a
 * network-level failure (a thrown `fetch`, including this provider's own
 * per-attempt timeout abort) -- never for a malformed-but-successfully-received
 * response body, which is a provider bug/contract mismatch that retrying
 * cannot fix. Exhausting every retry (or an immediate non-retryable non-2xx
 * status) raises `HttpEmbeddingProviderUnavailableError`
 * (`core:embedding_provider_unavailable`) for that WHOLE chunk; the
 * reconciler's own per-document fallback (`semantic-reconciler.ts`'s
 * `embedAndCommitBatch`) is what isolates which specific document(s) in a
 * failed chunk actually matter, by falling back to `generateVector` one
 * document at a time.
 */
export function createHttpEmbeddingProvider(options: HttpEmbeddingProviderOptions): ResolvedSemanticProvider {
  if (options.endpoint.length === 0) throw new Error("HTTP embedding provider requires a non-empty endpoint.");
  if (options.model.length === 0) throw new Error("HTTP embedding provider requires a non-empty model.");
  if (!Number.isSafeInteger(options.dimensions) || options.dimensions <= 0) throw new Error("HTTP embedding provider dimensions must be a positive integer.");
  const maxBatchInputs = options.max_batch_inputs ?? HTTP_DEFAULT_MAX_BATCH_INPUTS;
  const maxInputTokens = options.max_input_tokens ?? HTTP_DEFAULT_MAX_INPUT_TOKENS;
  if (!Number.isSafeInteger(maxBatchInputs) || maxBatchInputs <= 0) throw new Error("HTTP embedding provider max_batch_inputs must be a positive integer.");
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0) throw new Error("HTTP embedding provider max_input_tokens must be a positive integer.");
  // R8: never more segments than this provider's own declared per-request
  // token budget would admit at the pinned 256-token window (R7) -- e.g. the
  // 8192-token default caps at 32 segments even though DEFAULT_MAX_SEGMENTS
  // is 64; a generous `max_input_tokens` override is still capped at
  // DEFAULT_MAX_SEGMENTS's own ceiling.
  const httpMaxSegments = Math.max(1, Math.min(DEFAULT_MAX_SEGMENTS, Math.floor(maxInputTokens / DEFAULT_SEGMENT_WINDOW_TOKENS)));
  const httpSegmentWindowChars = DEFAULT_SEGMENT_WINDOW_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
  const httpSegmentOverlapChars = DEFAULT_SEGMENT_OVERLAP_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

  const modelSegment = sanitizeModelIdSegment(options.model);
  const profile = embeddingProfile({
    embedding_profile_id: `core:http-${modelSegment}-${options.dimensions}`,
    definition_revision: 1,
    schema_version: 1,
    description: `OpenAI-compatible HTTP embedding provider for model "${options.model}" at ${options.dimensions} dimensions.`,
    embedding_contract_version: "1",
    model_provider_id: "http",
    model_id: options.model,
    model_revision: "1",
    // Deliberately excludes `endpoint` (see doc comment above) and
    // `api_key` (never digested anywhere in this module).
    model_identity_digest: digestOf({ model: options.model, dimensions: options.dimensions }),
    tokenizer_id: "http:provider-managed",
    tokenizer_revision: "1",
    tokenizer_digest: digestOf({ tokenizer_id: "http:provider-managed", model: options.model }),
    document_input_contract: "core:http-document-v1",
    query_input_contract: "core:http-query-v1",
    segmentation_contract: "core:http-none-v1",
    // Frente S-B.3: this is now the provider's REAL, configurable per-request
    // token budget (`max_input_tokens`, default 8192) rather than a
    // hardcoded "effectively unlimited" placeholder.
    maximum_document_tokens: String(maxInputTokens),
    maximum_query_tokens: String(maxInputTokens),
    dimensions: options.dimensions,
    element_type: "float32",
    vector_encoding: "float32-le",
    normalization: "l2",
    distance_metric: "cosine",
    language_support: "all",
    supported_query_classes: "all",
    supported_content_classes: "all",
    agent_guidance: `Remote embeddings via ${options.model}. Availability, latency, and quality depend on the configured endpoint, which is opt-in and operator-configured.`,
    lifecycle_state: "active",
  });

  const runtimeBindingId = "core:http-embeddings";
  // NOT a function of api_key -- see the module doc comment. `segmenter`
  // (R10) ties this identity to the entity-grain `.segment()` parameters
  // below, so a segmenter-parameter change forces the same full re-embed
  // every other provider's identity now reflects.
  const executableBindingDigest = digestOf({ endpoint: options.endpoint, model: options.model, dimensions: options.dimensions, max_batch_inputs: maxBatchInputs, max_input_tokens: maxInputTokens, segmenter: segmenterIdentity(httpMaxSegments) });
  const fetchImpl = options.fetch_impl ?? fetch;
  const timeoutMs = options.timeout_ms ?? HTTP_DEFAULT_TIMEOUT_MS;
  const retryBackoffMs = options.retry_backoff_ms ?? HTTP_DEFAULT_RETRY_BACKOFF_MS;
  const sleepImpl = options.sleep_impl ?? realSleep;

  /**
   * Parses ONE successfully-received (`response.ok`) chunk response back
   * into `chunk`-ordered vectors -- pulled out of `sendChunkWithRetry` so a
   * malformed-body throw here is UNAMBIGUOUSLY distinct (by not being an
   * `HttpEmbeddingProviderUnavailableError`) from a transport-level failure,
   * regardless of which attempt produced the successful-but-malformed
   * response.
   */
  const parseChunkResponse = async (response: Response, chunk: readonly GenerateVectorInput[], truncatedTexts: readonly string[]): Promise<readonly SemanticGeneratedVector[]> => {
    const payload = (await response.json()) as { readonly data?: ReadonlyArray<{ readonly embedding?: unknown; readonly index?: unknown }> };
    const rawData = payload.data ?? [];
    // Frente S-B (2026-09-06) fix, adversarial review item #8: the
    // OpenAI-compatible contract this provider targets guarantees `data[i]`
    // corresponds to `input[i]`, but some real-world "OpenAI-compatible"
    // servers reorder `data` (e.g. to finish shorter inputs first) while
    // still tagging each item with its OWN `index` field. Reordering by
    // `index` when EVERY item in the response carries one (never a partial
    // mix -- a response with some indices present and others missing is
    // already malformed enough that positional fallback is no worse) avoids
    // silently pairing a vector with the wrong document's digest/identity.
    const byIndex = rawData.length > 0 && rawData.every((item) => typeof item?.index === "number")
      ? new Map(rawData.map((item) => [item.index as number, item]))
      : undefined;
    return chunk.map((input, index) => {
      const embedding = (byIndex !== undefined ? byIndex.get(index) : rawData[index])?.embedding;
      if (!Array.isArray(embedding)) throw new Error(`HTTP embedding provider response from ${options.endpoint} is missing data[${index}].embedding.`);
      if (embedding.length !== input.profile.dimensions) throw new Error(`HTTP embedding provider returned ${embedding.length} dimensions, expected ${input.profile.dimensions}.`);
      if (embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("HTTP embedding provider returned a non-finite embedding value.");
      const vector = canonicalVectorBytes(embedding as readonly number[], {
        dimensions: input.profile.dimensions,
        element_type: input.profile.element_type as "float32" | "float64",
        normalization: input.profile.normalization as "none" | "l2",
      });
      const inputDigest = digestOf({ purpose: input.purpose, profile_digest: input.profile.profile_digest, text: truncatedTexts[index], ...(input.segment_index === undefined ? {} : { segment_index: input.segment_index }) });
      return { vector, vector_digest: digestBytes(vector), input_digest: inputDigest, profile_digest: input.profile.profile_digest };
    });
  };

  /**
   * R12: sends ONE chunk (already within `max_batch_inputs`/`max_input_tokens`),
   * retrying up to `retryBackoffMs.length` times (`retryBackoffMs.length + 1`
   * total attempts) with the configured backoff BETWEEN attempts, only for a
   * 429/5xx status or a network-level failure (including this attempt's own
   * timeout abort) -- see `createHttpEmbeddingProvider`'s own doc comment.
   * Frente S-B (2026-09-06) fix, item #8: a 429/5xx response's own
   * `Retry-After` header (`parseRetryAfterMs`) raises the NEXT attempt's
   * wait to at least that value -- the configured backoff still applies as
   * a floor of its own (never shortened below `retryBackoffMs[attempt]`),
   * so `Retry-After` can only lengthen a wait, never shorten one below what
   * was already configured.
   */
  const sendChunkWithRetry = async (chunk: readonly GenerateVectorInput[]): Promise<readonly SemanticGeneratedVector[]> => {
    // Purpose ("document" vs "query") is not distinguished in the request
    // body v1 -- every input embeds plain text with no instruction prefix.
    // It still flows into each input_digest below so a future purpose-aware
    // rendering change is detectable/auditable even though it does not
    // (yet) change what gets sent over the wire.
    const truncatedTexts = chunk.map((input) => input.text.length > HTTP_INPUT_TEXT_CAP ? input.text.slice(0, HTTP_INPUT_TEXT_CAP) : input.text);
    const maxAttempts = retryBackoffMs.length + 1;
    let lastError: unknown;
    let retryAfterFloorMs = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        await sleepImpl(Math.max(retryBackoffMs[attempt - 1]!, retryAfterFloorMs));
        retryAfterFloorMs = 0;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(options.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.api_key !== undefined ? { authorization: `Bearer ${options.api_key}` } : {}),
          },
          body: JSON.stringify({ model: options.model, input: truncatedTexts }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!response.ok) {
          const preview = await previewResponseBody(response);
          const message = `HTTP embedding provider request to ${options.endpoint} failed with status ${response.status}: ${preview}`;
          if (isRetryableStatus(response.status) && attempt < maxAttempts - 1) {
            lastError = new Error(message);
            retryAfterFloorMs = parseRetryAfterMs(response.headers.get("retry-after")) ?? 0;
            continue;
          }
          throw new HttpEmbeddingProviderUnavailableError(message);
        }
        return await parseChunkResponse(response, chunk, truncatedTexts);
      } catch (error) {
        clearTimeout(timer);
        // A malformed-but-successful response (`parseChunkResponse`'s own
        // throws) and an already-final `HttpEmbeddingProviderUnavailableError`
        // (the non-retryable-status branch above) both propagate immediately,
        // never retried, never re-wrapped.
        if (error instanceof HttpEmbeddingProviderUnavailableError) throw error;
        if (!(error instanceof TypeError) && !(error instanceof DOMException) && !(error instanceof Error && error.name === "AbortError")) throw error;
        if (attempt < maxAttempts - 1) { lastError = error; continue; }
        const causeMessage = error instanceof Error ? error.message : String(error);
        throw new HttpEmbeddingProviderUnavailableError(`HTTP embedding provider request to ${options.endpoint} failed after ${maxAttempts} attempts: ${causeMessage}`);
      }
    }
    // Unreachable: the loop above always either returns or throws.
    throw lastError instanceof Error ? lastError : new Error("HTTP embedding provider request failed for an unknown reason.");
  };

  // Shared implementation for BOTH `generateVector` and `generateVectors`:
  // `generateVector` is simply `embedBatch([input])[0]` below -- one request
  // carrying a one-element `input` array, exactly what this provider always
  // sent even before chunking/retries existed. Sharing one implementation is
  // what GUARANTEES the two paths compute `input_digest`/`vector_digest`
  // identically (the spec's "digest construction must be identical"
  // requirement) rather than merely matching it by separately-maintained
  // convention.
  const embedBatch = async (inputs: readonly GenerateVectorInput[]): Promise<readonly SemanticGeneratedVector[]> => {
    if (inputs.length === 0) return [];
    const chunks = chunkForHttpRequest(inputs, maxBatchInputs, maxInputTokens);
    // Concurrency 1 (R12): chunks are sent ONE AT A TIME, never in parallel
    // (`Promise.all` would violate that) -- a plain sequential loop.
    const results: SemanticGeneratedVector[] = [];
    for (const chunk of chunks) results.push(...await sendChunkWithRetry(chunk));
    return results;
  };

  return {
    profile,
    binding: {
      runtime_binding_id: runtimeBindingId,
      executable_binding_digest: executableBindingDigest,
      generateVector: async (input) => (await embedBatch([input]))[0]!,
      generateVectors: embedBatch,
      // Frente S-B.2: chars/4 segmentation, bounded by this provider's own
      // per-request token budget (`httpMaxSegments`) -- see this function's
      // own `executable_binding_digest` comment.
      segment: async (text: string): Promise<Segmentation> => segmentByChars(text, { window_chars: httpSegmentWindowChars, overlap_chars: httpSegmentOverlapChars, max_segments: httpMaxSegments }),
    },
  };
}
