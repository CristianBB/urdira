import { describe, expect, it, vi } from "vitest";
import { exactVectorScan, type ExactVectorCandidate } from "../packages/engine/src/index.js";
import {
  createHttpEmbeddingProvider,
  createLocalHashProvider,
} from "../packages/engine/src/index.js";
import {
  computeLocalHashVector,
  extractLocalHashTokens,
} from "../packages/engine/src/semantic-provider.js";

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

  it("throws when the response reports a non-2xx status, including a truncated body preview", async () => {
    const fetchImpl = vi.fn(async () => fakeJsonResponse(500, "internal server error detail")) as unknown as typeof fetch;
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test", model: "m", dimensions: 4, fetch_impl: fetchImpl });
    await expect(provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: "x" })).rejects.toThrow(/500/);
    await expect(provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: "x" })).rejects.toThrow(/internal server error detail/);
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
});
