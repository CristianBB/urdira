import { canonicalBytes, digestBytes } from "@urdira/canonical";
import type { EmbeddingProfile } from "@urdira/contracts";
import { canonicalVectorBytes, type GenerateVectorInput, type SemanticGeneratedVector, type SemanticRuntimeBinding } from "./semantic-runtime.js";

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
const LOCAL_HASH_EXECUTABLE_BINDING_DIGEST = digestOf({ runtime: "core:local-hash", algorithm_version: 1 });

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
    },
  };
}

/** Input text is truncated to this many UTF-16 code units before it is ever sent over the wire, independent of `dimensions` -- a defensive cap against provider-side token limits (most OpenAI-compatible embedding APIs reject inputs well before 32k characters of source code). The local provider has no such cap; it embeds the full text. */
const HTTP_INPUT_TEXT_CAP = 32_000;
const HTTP_DEFAULT_TIMEOUT_MS = 30_000;
/** How much of a non-2xx response body to fold into the thrown error's message -- enough to see a JSON error payload's shape, not enough to dump an entire HTML error page into logs. */
const HTTP_ERROR_BODY_PREVIEW_LENGTH = 500;

export interface HttpEmbeddingProviderOptions {
  /** Full URL, used as-is (POST). No path-joining, no trailing-slash normalization. */
  readonly endpoint: string;
  readonly model: string;
  readonly dimensions: number;
  /** When set, sent as `Authorization: Bearer <api_key>`. Deliberately excluded from every digest this module computes -- see the doc comment on `createHttpEmbeddingProvider`. */
  readonly api_key?: string;
  /** Injectable for tests so nothing in this module ever needs a real network call. Defaults to `globalThis.fetch`. */
  readonly fetch_impl?: typeof fetch;
  /** Defaults to 30_000ms, enforced via `AbortSignal.timeout`. */
  readonly timeout_ms?: number;
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
 */
export function createHttpEmbeddingProvider(options: HttpEmbeddingProviderOptions): ResolvedSemanticProvider {
  if (options.endpoint.length === 0) throw new Error("HTTP embedding provider requires a non-empty endpoint.");
  if (options.model.length === 0) throw new Error("HTTP embedding provider requires a non-empty model.");
  if (!Number.isSafeInteger(options.dimensions) || options.dimensions <= 0) throw new Error("HTTP embedding provider dimensions must be a positive integer.");

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
    maximum_document_tokens: "1000000",
    maximum_query_tokens: "1000000",
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
  // NOT a function of api_key -- see the module doc comment.
  const executableBindingDigest = digestOf({ endpoint: options.endpoint, model: options.model, dimensions: options.dimensions });
  const fetchImpl = options.fetch_impl ?? fetch;
  const timeoutMs = options.timeout_ms ?? HTTP_DEFAULT_TIMEOUT_MS;

  // Shared implementation for BOTH `generateVector` and `generateVectors`:
  // the OpenAI-compatible `/embeddings` endpoint already accepts an array of
  // inputs, so `generateVector` is simply `embedBatch([input])[0]` below --
  // one request carrying a one-element `input` array, exactly what this
  // provider always sent even before batching existed. Sharing one
  // implementation is what GUARANTEES the two paths compute
  // `input_digest`/`vector_digest` identically (the spec's "digest
  // construction must be identical" requirement) rather than merely
  // matching it by separately-maintained convention.
  const embedBatch = async (inputs: readonly GenerateVectorInput[]): Promise<readonly SemanticGeneratedVector[]> => {
    if (inputs.length === 0) return [];
    // Purpose ("document" vs "query") is not distinguished in the request
    // body v1 -- every input embeds plain text with no instruction prefix.
    // It still flows into each input_digest below so a future purpose-aware
    // rendering change is detectable/auditable even though it does not
    // (yet) change what gets sent over the wire.
    const truncatedTexts = inputs.map((input) => input.text.length > HTTP_INPUT_TEXT_CAP ? input.text.slice(0, HTTP_INPUT_TEXT_CAP) : input.text);
    const response = await fetchImpl(options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.api_key !== undefined ? { authorization: `Bearer ${options.api_key}` } : {}),
      },
      body: JSON.stringify({ model: options.model, input: truncatedTexts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const preview = await previewResponseBody(response);
      throw new Error(`HTTP embedding provider request to ${options.endpoint} failed with status ${response.status}: ${preview}`);
    }
    const payload = (await response.json()) as { readonly data?: ReadonlyArray<{ readonly embedding?: unknown }> };
    // `data[i]` is mapped back to `inputs[i]` strictly by INDEX -- the
    // OpenAI-compatible contract this provider targets guarantees response
    // ordering matches request ordering (mirroring `EmbeddingExtractor`'s
    // identical positional contract in `@urdira/embedding-local`).
    return inputs.map((input, index) => {
      const embedding = payload.data?.[index]?.embedding;
      if (!Array.isArray(embedding)) throw new Error(`HTTP embedding provider response from ${options.endpoint} is missing data[${index}].embedding.`);
      if (embedding.length !== input.profile.dimensions) throw new Error(`HTTP embedding provider returned ${embedding.length} dimensions, expected ${input.profile.dimensions}.`);
      if (embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("HTTP embedding provider returned a non-finite embedding value.");
      const vector = canonicalVectorBytes(embedding as readonly number[], {
        dimensions: input.profile.dimensions,
        element_type: input.profile.element_type as "float32" | "float64",
        normalization: input.profile.normalization as "none" | "l2",
      });
      const inputDigest = digestOf({ purpose: input.purpose, profile_digest: input.profile.profile_digest, text: truncatedTexts[index] });
      return { vector, vector_digest: digestBytes(vector), input_digest: inputDigest, profile_digest: input.profile.profile_digest };
    });
  };

  return {
    profile,
    binding: {
      runtime_binding_id: runtimeBindingId,
      executable_binding_digest: executableBindingDigest,
      generateVector: async (input) => (await embedBatch([input]))[0]!,
      generateVectors: embedBatch,
    },
  };
}
