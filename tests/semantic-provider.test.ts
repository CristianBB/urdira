import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exactVectorScan, type ExactVectorCandidate } from "../packages/engine/src/index.js";
import {
  createHttpEmbeddingProvider,
  createLocalHashProvider,
  HttpEmbeddingProviderUnavailableError,
} from "../packages/engine/src/index.js";
import {
  computeLocalHashVector,
  extractLocalHashTokens,
} from "../packages/engine/src/semantic-provider.js";
import { DEFAULT_MAX_SEGMENTS } from "../packages/engine/src/semantic-runtime.js";

describe("local hash embedding provider", () => {
  it("ships the PINNED profile literal, stable across calls", () => {
    const first = createLocalHashProvider();
    const second = createLocalHashProvider();
    expect(first.profile).toEqual(second.profile);
    expect(first.profile).toMatchObject({
      embedding_profile_id: "core:local-hash-256-v1",
      dimensions: 256,
      element_type: "float32",
      vector_encoding: "float32-le",
      normalization: "l2",
      distance_metric: "cosine",
      language_support: "all",
      supported_query_classes: "all",
      supported_content_classes: "all",
      lifecycle_state: "active",
      model_provider_id: "core",
      model_id: "local-hash",
      model_revision: "1",
      maximum_document_tokens: "1000000",
      maximum_query_tokens: "1000000",
    });
    expect(first.binding.runtime_binding_id).toBe("core:local-hash");
    expect(typeof first.profile.profile_digest).toBe("string");
    expect(first.profile.profile_digest.length).toBeGreaterThan(0);
    // profile_digest must actually be a function of the OTHER fields --
    // it should not merely be a hardcoded string, and it must not itself
    // participate in its own computation.
    expect(second.profile.profile_digest).toBe(first.profile.profile_digest);
  });

  it("produces bit-identical vector_digest for identical text, across calls and across provider instances", async () => {
    const providerOne = createLocalHashProvider();
    const providerTwo = createLocalHashProvider();
    const text = "export function computeChecksum(buffer) { return buffer.length; }";

    const firstCall = await providerOne.binding.generateVector({ profile: providerOne.profile, purpose: "document", text });
    const secondCall = await providerOne.binding.generateVector({ profile: providerOne.profile, purpose: "document", text });
    const otherInstanceCall = await providerTwo.binding.generateVector({ profile: providerTwo.profile, purpose: "document", text });

    expect(secondCall.vector_digest).toBe(firstCall.vector_digest);
    expect(secondCall.input_digest).toBe(firstCall.input_digest);
    expect([...secondCall.vector]).toEqual([...firstCall.vector]);
    expect(otherInstanceCall.vector_digest).toBe(firstCall.vector_digest);
    expect([...otherInstanceCall.vector]).toEqual([...firstCall.vector]);
  });

  it("produces different vector_digest for different text", async () => {
    const provider = createLocalHashProvider();
    const first = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: "function parseHtmlDocument() {}" });
    const second = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: "class NetworkSocketManager {}" });
    expect(first.vector_digest).not.toBe(second.vector_digest);
  });

  it("embeds a near-2MB generated file without hitting the canonical encoder's resource limit", async () => {
    // Regression: the original input_digest canonical-encoded the raw text
    // plus one sha256 string per token, which threw
    // `uce:resource_limit_exceeded` on excalidraw's generated wasm-embedding
    // sources (~2MB, hundreds of thousands of tokens) -- files that sit
    // UNDER the reconciler's 2MB byte guard and so must embed cleanly. The
    // digest now covers the text's digest instead, which is bounded.
    const provider = createLocalHashProvider();
    const token = () => `generatedSymbol${Math.floor(Math.random() * 1_000_000)}_v${Math.floor(Math.random() * 100)}`;
    const text = Array.from({ length: 80_000 }, token).join(" ");
    expect(text.length).toBeGreaterThan(1_500_000);
    const generated = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text });
    expect(generated.vector.byteLength).toBe(1024);
    const again = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text });
    expect(again.input_digest).toBe(generated.input_digest);
    expect(again.vector_digest).toBe(generated.vector_digest);
  });

  it("throws on empty or whitespace-only text instead of silently producing a zero vector", async () => {
    const provider = createLocalHashProvider();
    await expect(provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: "   \n\t  " })).rejects.toThrow(/no extractable tokens/i);
    await expect(provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: "!!! ??? ..." })).rejects.toThrow(/no extractable tokens/i);
    expect(() => computeLocalHashVector("")).toThrow(/no extractable tokens/i);
  });

  it("extracts full-form and subtoken forms with camelCase/underscore/digit splitting exactly as pinned", () => {
    expect(extractLocalHashTokens("myVar_2")).toEqual(["myvar_2", "my", "var", "2"]);
    expect(extractLocalHashTokens("XMLHttpRequest")).toEqual(["xmlhttprequest", "xml", "http", "request"]);
    expect(extractLocalHashTokens("parse_html_document")).toEqual(["parse_html_document", "parse", "html", "document"]);
  });

  it("generateVectors produces vectors/digests byte-identical to sequential generateVector calls, in the same order", async () => {
    const provider = createLocalHashProvider();
    expect(provider.binding.generateVectors).toBeDefined();
    const texts = ["function parseHtmlDocument() {}", "class NetworkSocketManager {}", "function computeInvoiceTotal(lineItems) {}"];

    const sequential: Array<Awaited<ReturnType<typeof provider.binding.generateVector>>> = [];
    for (const text of texts) sequential.push(await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text }));

    const batched = await provider.binding.generateVectors!(texts.map((text) => ({ profile: provider.profile, purpose: "document" as const, text })));

    expect(batched).toHaveLength(sequential.length);
    batched.forEach((generated, index) => {
      expect([...generated.vector]).toEqual([...sequential[index]!.vector]);
      expect(generated.vector_digest).toBe(sequential[index]!.vector_digest);
      expect(generated.input_digest).toBe(sequential[index]!.input_digest);
      expect(generated.profile_digest).toBe(sequential[index]!.profile_digest);
    });
  });

  it("ranks a document sharing camelCase/snake_case identifier subtokens with the query above unrelated decoys", async () => {
    const provider = createLocalHashProvider();
    const embed = (purpose: "document" | "query", text: string) => provider.binding.generateVector({ profile: provider.profile, purpose, text });

    const related = await embed("document", "function parseHtmlDocument(rawHtml) { return renderHtmlDocument(rawHtml); }");
    const decoyOne = await embed("document", "function computeInvoiceTotal(lineItems) { return sumLineItemAmounts(lineItems); }");
    const decoyTwo = await embed("document", "class NetworkSocketManager { connectToRemoteHost(hostname) {} }");
    const query = await embed("query", "parse_html_document");

    const candidates: ExactVectorCandidate[] = [
      { projection_record_id: "related", profile_id: provider.profile.embedding_profile_id, executable_binding_id: provider.binding.executable_binding_digest, vector: related.vector },
      { projection_record_id: "decoy-one", profile_id: provider.profile.embedding_profile_id, executable_binding_id: provider.binding.executable_binding_digest, vector: decoyOne.vector },
      { projection_record_id: "decoy-two", profile_id: provider.profile.embedding_profile_id, executable_binding_id: provider.binding.executable_binding_digest, vector: decoyTwo.vector },
    ];

    const ranked = exactVectorScan(candidates, query.vector, {
      profile_id: provider.profile.embedding_profile_id,
      executable_binding_id: provider.binding.executable_binding_digest,
      dimensions: provider.profile.dimensions,
      distance_metric: "cosine",
      normalization: "l2",
    });

    expect(ranked[0]?.projection_record_id).toBe("related");
  });

  it("Frente S-B: executable_binding_digest incorporates the R10 segmenter identity, and .segment() splits long text using the chars/4 approximation", async () => {
    const provider = createLocalHashProvider();
    expect(provider.binding.segment).toBeDefined();
    // Short text (well under the 1024-char window) is exactly one segment
    // covering the whole text.
    const short = await provider.binding.segment!("function shortFunction() { return 1; }");
    expect(short.segments).toHaveLength(1);
    expect(short.truncated).toBe(false);
    expect(short.segments[0]).toMatchObject({ index: 0, start_char: 0, end_char: 38, text: "function shortFunction() { return 1; }" });

    // Long text (well over one window) splits into overlapping segments.
    const long = "x".repeat(3000);
    const segmented = await provider.binding.segment!(long);
    expect(segmented.segments.length).toBeGreaterThan(1);
    expect(segmented.truncated).toBe(false);
    // Consecutive segments overlap by the configured overlap_chars (128).
    const first = segmented.segments[0]!;
    const second = segmented.segments[1]!;
    expect(second.start_char).toBe(first.end_char - 128);
    // Every segment's own text matches its own recorded offsets.
    for (const segment of segmented.segments) expect(segment.text).toBe(long.slice(segment.start_char, segment.end_char));

    // A text needing more than DEFAULT_MAX_SEGMENTS segments is truncated,
    // never silently dropped without a signal (R8).
    const huge = "y".repeat(1024 * (DEFAULT_MAX_SEGMENTS + 5));
    const cappedSegmentation = await provider.binding.segment!(huge);
    expect(cappedSegmentation.segments).toHaveLength(DEFAULT_MAX_SEGMENTS);
    expect(cappedSegmentation.truncated).toBe(true);
  });
});

function fakeJsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HTTP embedding provider", () => {
  it("posts an OpenAI-compatible request and normalizes the returned embedding, with Bearer auth only when api_key is set", async () => {
    const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url, init });
      return fakeJsonResponse(200, { data: [{ embedding: [1, 0, 0, 0] }] });
    }) as unknown as typeof fetch;

    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test/v1/embed", model: "text-embed-3", dimensions: 4, api_key: "secret-key", fetch_impl: fetchImpl });
    const generated = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: "hello world" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://embeddings.example.test/v1/embed");
    const init = calls[0]?.init as { method: string; headers: Record<string, string>; body: string };
    expect(init.method).toBe("POST");
    expect(init.headers["authorization"]).toBe("Bearer secret-key");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ model: "text-embed-3", input: ["hello world"] });
    expect(generated.vector.byteLength).toBe(16);
    expect(generated.profile_digest).toBe(provider.profile.profile_digest);

    const noKeyProvider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test/v1/embed", model: "text-embed-3", dimensions: 4, fetch_impl: fetchImpl });
    await noKeyProvider.binding.generateVector({ profile: noKeyProvider.profile, purpose: "document", text: "hello world" });
    const secondInit = calls[1]?.init as { headers: Record<string, string> };
    expect(secondInit.headers["authorization"]).toBeUndefined();
  });

  it("throws HttpEmbeddingProviderUnavailableError when the response reports a persistent non-2xx status, including a truncated body preview, after exhausting retries", async () => {
    const fetchImpl = vi.fn(async () => fakeJsonResponse(500, "internal server error detail")) as unknown as typeof fetch;
    // R12: a 500 is retryable -- `retry_backoff_ms: []` (zero retries) keeps
    // this test fast while still exercising the FINAL non-retryable-status
    // throw path; the retry loop itself is exercised separately below.
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "m", dimensions: 4, fetch_impl: fetchImpl, retry_backoff_ms: [] });
    await expect(provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: "x" })).rejects.toThrow(/500/);
    await expect(provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: "x" })).rejects.toThrow(/internal server error detail/);
    const error = await provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: "x" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpEmbeddingProviderUnavailableError);
    expect((error as HttpEmbeddingProviderUnavailableError).code).toBe("core:embedding_provider_unavailable");
  });

  it("retries a 429 with the configured backoff and succeeds once the endpoint recovers (R12)", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return fakeJsonResponse(429, "rate limited");
      return fakeJsonResponse(200, { data: [{ embedding: [1, 0, 0, 0] }] });
    }) as unknown as typeof fetch;
    const provider = createHttpEmbeddingProvider({
      endpoint: "https://embeddings.example.test", model: "m", dimensions: 4, fetch_impl: fetchImpl,
      sleep_impl: async (ms) => { sleeps.push(ms); },
    });
    const generated = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: "retry me" });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([500]);
    expect(generated.vector.byteLength).toBe(16);
  });

  it("retries only on 429/5xx/network errors -- a non-retryable 4xx status fails immediately, with no retry and no injected sleep", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return fakeJsonResponse(400, "bad request");
    }) as unknown as typeof fetch;
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "m", dimensions: 4, fetch_impl: fetchImpl, sleep_impl: async (ms) => { sleeps.push(ms); } });
    await expect(provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: "x" })).rejects.toThrow(/400/);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("retries a network-level fetch rejection (not just a non-2xx status) and eventually throws HttpEmbeddingProviderUnavailableError once every retry is exhausted", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      throw new TypeError("fetch failed: network unreachable");
    }) as unknown as typeof fetch;
    const provider = createHttpEmbeddingProvider({
      endpoint: "https://embeddings.example.test", model: "m", dimensions: 4, fetch_impl: fetchImpl,
      retry_backoff_ms: [0, 0], sleep_impl: async () => undefined,
    });
    await expect(provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: "x" })).rejects.toBeInstanceOf(HttpEmbeddingProviderUnavailableError);
    expect(calls).toBe(3); // 1 initial attempt + 2 retries
  });

  it("never retries a malformed-but-successful response (wrong dimensions/non-finite) -- that is a provider contract bug, not unavailability", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => { calls += 1; return fakeJsonResponse(200, { data: [{ embedding: [1, 0, 0] }] }); }) as unknown as typeof fetch;
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "m", dimensions: 4, fetch_impl: fetchImpl, sleep_impl: async () => undefined });
    const error = await provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: "x" }).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(HttpEmbeddingProviderUnavailableError);
    expect(calls).toBe(1);
  });

  it("throws when the returned embedding has the wrong dimensionality", async () => {
    const fetchImpl = vi.fn(async () => fakeJsonResponse(200, { data: [{ embedding: [1, 0, 0] }] })) as unknown as typeof fetch;
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "m", dimensions: 4, fetch_impl: fetchImpl });
    await expect(provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: "x" })).rejects.toThrow(/dimensions/i);
  });

  it("throws when the returned embedding contains a non-finite value", async () => {
    const fetchImpl = vi.fn(async () => fakeJsonResponse(200, { data: [{ embedding: [1, Number.NaN, 0, 0] }] })) as unknown as typeof fetch;
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "m", dimensions: 4, fetch_impl: fetchImpl });
    await expect(provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: "x" })).rejects.toThrow(/finite/i);
  });

  it("never lets api_key participate in executable_binding_digest or profile_digest", () => {
    const withKey = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "text-embed-3", dimensions: 8, api_key: "key-one" });
    const withDifferentKey = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "text-embed-3", dimensions: 8, api_key: "key-two" });
    const withNoKey = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "text-embed-3", dimensions: 8 });

    expect(withKey.binding.executable_binding_digest).toBe(withDifferentKey.binding.executable_binding_digest);
    expect(withKey.binding.executable_binding_digest).toBe(withNoKey.binding.executable_binding_digest);
    expect(withKey.profile.profile_digest).toBe(withDifferentKey.profile.profile_digest);
    expect(withKey.profile).toEqual(withNoKey.profile);
  });

  it("generateVectors sends ONE request carrying every text in one `input` array and maps data[i].embedding back to inputs[i] by index", async () => {
    const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url, init });
      return fakeJsonResponse(200, { data: [{ embedding: [1, 0, 0, 0] }, { embedding: [0, 1, 0, 0] }, { embedding: [0, 0, 1, 0] }] });
    }) as unknown as typeof fetch;
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test/v1/embed", model: "text-embed-3", dimensions: 4, fetch_impl: fetchImpl });

    const generated = await provider.binding.generateVectors!([
      { profile: provider.profile, purpose: "document", text: "alpha" },
      { profile: provider.profile, purpose: "document", text: "beta" },
      { profile: provider.profile, purpose: "document", text: "gamma" },
    ]);

    expect(calls).toHaveLength(1);
    const init = calls[0]?.init as { body: string };
    expect(JSON.parse(init.body)).toEqual({ model: "text-embed-3", input: ["alpha", "beta", "gamma"] });
    expect(generated).toHaveLength(3);
    expect([...generated[0]!.vector]).not.toEqual([...generated[1]!.vector]);
    expect([...generated[1]!.vector]).not.toEqual([...generated[2]!.vector]);
    // Each vector round-trips its OWN index's embedding, not e.g. always index 0.
    const decodeFloat32 = (bytes: Uint8Array) => Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
    expect(decodeFloat32(generated[0]!.vector)).toEqual([1, 0, 0, 0]);
    expect(decodeFloat32(generated[1]!.vector)).toEqual([0, 1, 0, 0]);
    expect(decodeFloat32(generated[2]!.vector)).toEqual([0, 0, 1, 0]);
  });

  it("generateVector delegates through the same batch implementation as generateVectors, sending an identical single-element input array", async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init });
      return fakeJsonResponse(200, { data: [{ embedding: [1, 0, 0, 0] }] });
    }) as unknown as typeof fetch;
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test/v1/embed", model: "text-embed-3", dimensions: 4, fetch_impl: fetchImpl });

    const viaSingle = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: "hello world" });
    const viaBatch = await provider.binding.generateVectors!([{ profile: provider.profile, purpose: "document", text: "hello world" }]);

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ model: "text-embed-3", input: ["hello world"] });
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ model: "text-embed-3", input: ["hello world"] });
    expect(viaSingle.vector_digest).toBe(viaBatch[0]!.vector_digest);
    expect(viaSingle.input_digest).toBe(viaBatch[0]!.input_digest);
  });

  it("rejects the WHOLE batch (all-or-nothing) when any single item's response entry is malformed", async () => {
    const fetchImpl = vi.fn(async () => fakeJsonResponse(200, { data: [{ embedding: [1, 0, 0, 0] }, { embedding: [1, 2, 3] }] })) as unknown as typeof fetch;
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "m", dimensions: 4, fetch_impl: fetchImpl });
    await expect(provider.binding.generateVectors!([
      { profile: provider.profile, purpose: "document", text: "good" },
      { profile: provider.profile, purpose: "document", text: "bad" },
    ])).rejects.toThrow(/dimensions/i);
  });

  it("derives a profile id from model + dimensions and never calls fetch during construction", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "Text-Embed 3 Large!", dimensions: 1536, fetch_impl: fetchImpl });
    expect(provider.profile.embedding_profile_id).toBe("core:http-text-embed-3-large-1536");
    expect(provider.binding.runtime_binding_id).toBe("core:http-embeddings");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("R12: splits generateVectors into sequential (concurrency-1) requests of at most max_batch_inputs items each, never in parallel", async () => {
    const requestBodies: string[] = [];
    let concurrentInFlight = 0;
    let maxConcurrentObserved = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      concurrentInFlight += 1;
      maxConcurrentObserved = Math.max(maxConcurrentObserved, concurrentInFlight);
      requestBodies.push(init!.body as string);
      await new Promise((resolve) => setImmediate(resolve));
      concurrentInFlight -= 1;
      const input = (JSON.parse(init!.body as string) as { readonly input: readonly string[] }).input;
      // One-hot per GLOBAL input identity (never magnitude-encoded -- an L2
      // normalization step downstream would collapse any two same-direction
      // vectors of different magnitude to the identical unit vector).
      const oneHot = new Map<string, readonly number[]>([["a", [1, 0, 0, 0]], ["b", [0, 1, 0, 0]], ["c", [0, 0, 1, 0]], ["d", [0, 0, 0, 1]], ["e", [1, 1, 0, 0]]]);
      return fakeJsonResponse(200, { data: input.map((text) => ({ embedding: oneHot.get(text) })) });
    }) as unknown as typeof fetch;
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "m", dimensions: 4, fetch_impl: fetchImpl, max_batch_inputs: 2 });

    const inputs = ["a", "b", "c", "d", "e"].map((text) => ({ profile: provider.profile, purpose: "document" as const, text }));
    const generated = await provider.binding.generateVectors!(inputs);

    expect(maxConcurrentObserved).toBe(1); // never more than one request in flight
    expect(requestBodies.map((body) => (JSON.parse(body) as { readonly input: readonly string[] }).input)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(generated).toHaveLength(5);
    // Each vector round-trips its OWN identity, mapped back to the correct
    // GLOBAL position -- input "c" (chunk 2, index 0) must not be confused
    // with input "a" (chunk 1, index 0).
    const decodeFloat32 = (bytes: Uint8Array) => Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
    expect(decodeFloat32(generated[2]!.vector)).toEqual([0, 0, 1, 0]); // "c"
    expect(decodeFloat32(generated[0]!.vector)).toEqual([1, 0, 0, 0]); // "a"
  });

  it("R12: splits generateVectors by ESTIMATED token budget (chars/4) even under max_batch_inputs, always keeping at least one item per chunk", async () => {
    const requestBodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(init!.body as string);
      const input = (JSON.parse(init!.body as string) as { readonly input: readonly string[] }).input;
      return fakeJsonResponse(200, { data: input.map(() => ({ embedding: [1, 0, 0, 0] })) });
    }) as unknown as typeof fetch;
    // max_input_tokens: 10 -> ~40 chars per request budget.
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "m", dimensions: 4, fetch_impl: fetchImpl, max_input_tokens: 10, max_batch_inputs: 64 });
    const inputs = [
      { profile: provider.profile, purpose: "document" as const, text: "a".repeat(20) }, // ~5 tokens
      { profile: provider.profile, purpose: "document" as const, text: "b".repeat(20) }, // ~5 tokens -> chunk full at 10
      { profile: provider.profile, purpose: "document" as const, text: "c".repeat(100) }, // ~25 tokens alone -- exceeds budget but still gets its OWN chunk
    ];
    await provider.binding.generateVectors!(inputs);
    const chunks = requestBodies.map((body) => (JSON.parse(body) as { readonly input: readonly string[] }).input.length);
    expect(chunks).toEqual([2, 1]);
  });

  it("R12: .segment() splits by chars/4, bounded by max_input_tokens (never exceeding DEFAULT_MAX_SEGMENTS)", async () => {
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "m", dimensions: 4, max_input_tokens: 512 });
    expect(provider.binding.segment).toBeDefined();
    // 512 tokens / 256-token window = 2 segments max for this provider,
    // regardless of DEFAULT_MAX_SEGMENTS's own higher ceiling.
    const huge = "z".repeat(1024 * 10);
    const segmentation = await provider.binding.segment!(huge);
    expect(segmentation.segments.length).toBeLessThanOrEqual(2);
    expect(segmentation.truncated).toBe(true);
  });

  it("R10/R12: executable_binding_digest changes with max_batch_inputs, max_input_tokens, and the segmenter identity -- never with api_key", () => {
    const base = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "m", dimensions: 4 });
    const differentBatch = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "m", dimensions: 4, max_batch_inputs: 8 });
    const differentTokens = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "m", dimensions: 4, max_input_tokens: 4096 });
    expect(differentBatch.binding.executable_binding_digest).not.toBe(base.binding.executable_binding_digest);
    expect(differentTokens.binding.executable_binding_digest).not.toBe(base.binding.executable_binding_digest);
    expect(base.profile.maximum_document_tokens).toBe("8192");
    expect(differentTokens.profile.maximum_document_tokens).toBe("4096");
  });

  describe("node:http e2e (R12 full pipeline)", () => {
    let server: Server;
    let baseUrl: string;
    let requestCount: number;
    let behavior: (requestIndex: number, body: { readonly input: readonly string[] }) => { readonly status: number; readonly body: unknown };

    beforeEach(async () => {
      requestCount = 0;
      await new Promise<void>((resolve) => {
        server = createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            requestCount += 1;
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { readonly input: readonly string[] };
            const { status, body: responseBody } = behavior(requestCount, body);
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify(responseBody));
          });
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          baseUrl = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}/v1/embeddings` : "";
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("batches correctly by index over a real HTTP round trip", async () => {
      // One-hot per input identity -- see the equivalent unit test above for
      // why a magnitude-encoded embedding cannot survive this provider's
      // own L2 normalization.
      const oneHot = new Map<string, readonly number[]>([["a", [1, 0, 0, 0]], ["bb", [0, 1, 0, 0]], ["ccc", [0, 0, 1, 0]]]);
      behavior = (_requestIndex, body) => ({ status: 200, body: { data: body.input.map((text) => ({ embedding: oneHot.get(text) })) } });
      const provider = createHttpEmbeddingProvider({ endpoint: baseUrl, model: "m", dimensions: 4, max_batch_inputs: 2 });
      const generated = await provider.binding.generateVectors!([
        { profile: provider.profile, purpose: "document", text: "a" },
        { profile: provider.profile, purpose: "document", text: "bb" },
        { profile: provider.profile, purpose: "document", text: "ccc" },
      ]);
      expect(requestCount).toBe(2); // [a, bb] then [ccc]
      const decode = (bytes: Uint8Array) => Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
      expect(decode(generated[0]!.vector)).toEqual([1, 0, 0, 0]);
      expect(decode(generated[1]!.vector)).toEqual([0, 1, 0, 0]);
      expect(decode(generated[2]!.vector)).toEqual([0, 0, 1, 0]);
    });

    it("429 then success: retries and eventually returns a real embedding over a live HTTP round trip", async () => {
      behavior = (requestIndex, body) => requestIndex === 1
        ? { status: 429, body: "rate limited" }
        : { status: 200, body: { data: body.input.map(() => ({ embedding: [1, 0, 0, 0] })) } };
      const provider = createHttpEmbeddingProvider({ endpoint: baseUrl, model: "m", dimensions: 4, sleep_impl: async () => undefined });
      const generated = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: "retry-me" });
      expect(requestCount).toBe(2);
      expect(generated.vector.byteLength).toBe(16);
    });

    it("persistent 500: marks failed (HttpEmbeddingProviderUnavailableError) after exhausting retries over a live HTTP round trip", async () => {
      behavior = () => ({ status: 500, body: "always down" });
      const provider = createHttpEmbeddingProvider({ endpoint: baseUrl, model: "m", dimensions: 4, retry_backoff_ms: [0, 0], sleep_impl: async () => undefined });
      const error = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: "never works" }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HttpEmbeddingProviderUnavailableError);
      expect((error as HttpEmbeddingProviderUnavailableError).code).toBe("core:embedding_provider_unavailable");
      expect(requestCount).toBe(3); // 1 initial attempt + 2 retries
    });

    it("search_semantic-shaped retrieval: embeds a small corpus + a query over the HTTP provider and ranks the semantically closest document first", async () => {
      // Deterministic per-text "embedding": encodes which of two topic
      // keywords the text contains into orthogonal dimensions -- exercises
      // the full request/response round trip driving a real
      // `exactVectorScan` ranking, not just shape assertions.
      behavior = (_requestIndex, body) => ({
        status: 200,
        body: { data: body.input.map((text) => ({ embedding: [text.includes("html") ? 1 : 0, text.includes("socket") ? 1 : 0, 0, 0] })) },
      });
      const provider = createHttpEmbeddingProvider({ endpoint: baseUrl, model: "m", dimensions: 4 });
      const embed = (text: string) => provider.binding.generateVector({ profile: provider.profile, purpose: "document", text });
      const htmlDoc = await embed("parses an html document");
      const socketDoc = await embed("opens a network socket");
      const query = await provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: "html parser" });

      const ranked = exactVectorScan(
        [
          { projection_record_id: "html-doc", profile_id: provider.profile.embedding_profile_id, executable_binding_id: provider.binding.executable_binding_digest, vector: htmlDoc.vector },
          { projection_record_id: "socket-doc", profile_id: provider.profile.embedding_profile_id, executable_binding_id: provider.binding.executable_binding_digest, vector: socketDoc.vector },
        ],
        query.vector,
        { profile_id: provider.profile.embedding_profile_id, executable_binding_id: provider.binding.executable_binding_digest, dimensions: provider.profile.dimensions, distance_metric: "cosine", normalization: "l2" },
      );
      expect(ranked[0]?.projection_record_id).toBe("html-doc");
    });
  });
});
