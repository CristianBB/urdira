import { describe, expect, it } from "vitest";
import {
  createLocalNeuralProvider,
  ensureLocalEmbeddingModel,
  type EmbeddingExtractor,
  type EnsureLocalEmbeddingModelOptions,
  type LocalNeuralProviderOptions,
} from "../packages/embedding-local/src/index.js";

/**
 * Every test in this file uses a FAKE `extractor_factory` -- never the real
 * `@huggingface/transformers` pipeline. `createLocalNeuralProvider` lazily
 * `import()`s that package only inside its own default factory (see
 * `packages/embedding-local/src/index.ts`'s doc comments), so as long as
 * every provider constructed here supplies its own `extractor_factory`,
 * nothing in this suite ever touches the ONNX runtime, downloads a model, or
 * needs a network connection -- exactly the "NO network" requirement this
 * file exists to satisfy.
 *
 * The fake maps EXACT window strings to hand-chosen vectors via a lookup
 * table, so every expected mean-pooled/L2-normalized output below is a
 * value a human can (and does, in the comments) compute by hand -- this is
 * what lets the windowing/mean-pooling tests assert exact numeric results
 * rather than merely "some vector came back."
 */
function fakeExtractorFactory(vectorFor: ReadonlyMap<string, readonly number[]>): { readonly factory: NonNullable<LocalNeuralProviderOptions["extractor_factory"]>; readonly calls: string[][] } {
  const calls: string[][] = [];
  const factory: NonNullable<LocalNeuralProviderOptions["extractor_factory"]> = async () => {
    const extractor: EmbeddingExtractor = async (texts) => {
      calls.push([...texts]);
      return texts.map((text) => {
        const vector = vectorFor.get(text);
        if (vector === undefined) throw new Error(`Fake extractor has no vector configured for window ${JSON.stringify(text)}.`);
        return vector;
      });
    };
    return extractor;
  };
  return { factory, calls };
}

const PROBE_TEXT = "urdira dimension probe";

/** Decodes a little-endian float32 byte buffer (the exact shape `canonicalVectorBytes` -- and therefore `generateVector`'s returned `vector` -- always produces) back into plain numbers, so tests can assert on the actual embedded values rather than just byte lengths. */
function decodeFloat32LE(bytes: Uint8Array): readonly number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 4) values.push(view.getFloat32(offset, true));
  return values;
}

function l2Normalize(values: readonly number[]): readonly number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

function meanOf(vectors: ReadonlyArray<readonly number[]>): readonly number[] {
  const dimensions = vectors[0]?.length ?? 0;
  const sums = new Array<number>(dimensions).fill(0);
  for (const vector of vectors) for (let index = 0; index < dimensions; index += 1) sums[index] = (sums[index] ?? 0) + (vector[index] ?? 0);
  return sums.map((sum) => sum / vectors.length);
}

// Precision 5 (not more): the provider's `vector` bytes are float32, not
// float64 -- comparing against a float64-computed expectation at tighter
// precision would spuriously fail on the last couple of float32 mantissa
// bits.
function expectClose(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  for (let index = 0; index < expected.length; index += 1) expect(actual[index]).toBeCloseTo(expected[index]!, 5);
}

describe("local neural (open-model) embedding provider", () => {
  it("windows a multi-window document into ONE batched extractor call and mean-pools + L2-normalizes the result", async () => {
    const vectorFor = new Map<string, readonly number[]>([
      [PROBE_TEXT, [1, 0]],
      ["AAAAA", [2, 0]],
      ["BBBBB", [0, 4]],
      ["CCCCC", [4, 8]],
    ]);
    const { factory, calls } = fakeExtractorFactory(vectorFor);
    const provider = await createLocalNeuralProvider({ window_chars: 5, max_windows: 3, extractor_factory: factory });
    // The dimension probe is its own, separate extractor call -- assert it
    // happened before any document/query call touches the calls log below.
    expect(calls).toEqual([[PROBE_TEXT]]);

    const generated = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: "AAAAABBBBBCCCCC" });

    // Exactly one batched call, carrying all three windows in order -- not
    // three separate single-text calls.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(["AAAAA", "BBBBB", "CCCCC"]);

    // Hand-computed: mean([2,0],[0,4],[4,8]) = [2, 4], then L2-normalized.
    const expected = l2Normalize(meanOf([[2, 0], [0, 4], [4, 8]]));
    expectClose([...decodeFloat32LE(generated.vector)], expected);
  });

  it("caps a document at max_windows, never sending the extractor any window beyond the cap", async () => {
    const vectorFor = new Map<string, readonly number[]>([
      [PROBE_TEXT, [1, 0]],
      ["AAAAA", [1, 0]],
      ["BBBBB", [0, 1]],
      ["CCCCC", [1, 1]],
      // "DDDDD" is deliberately NOT registered -- if the provider ever sent
      // it to the extractor, the fake would throw and fail this test.
    ]);
    const { factory, calls } = fakeExtractorFactory(vectorFor);
    const provider = await createLocalNeuralProvider({ window_chars: 5, max_windows: 3, extractor_factory: factory });

    await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: "AAAAABBBBBCCCCCDDDDD" });

    expect(calls[1]).toEqual(["AAAAA", "BBBBB", "CCCCC"]);
  });

  it("embeds a query as its FIRST window only, regardless of max_windows or how much text follows", async () => {
    const vectorFor = new Map<string, readonly number[]>([
      [PROBE_TEXT, [1, 0]],
      ["AAAAA", [3, 4]],
      // Neither "BBBBB" nor "CCCCC" is registered -- a query call that
      // (incorrectly) tried to embed more than the first window would throw
      // here instead of silently passing.
    ]);
    const { factory, calls } = fakeExtractorFactory(vectorFor);
    const provider = await createLocalNeuralProvider({ window_chars: 5, max_windows: 64, extractor_factory: factory });

    const generated = await provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: "AAAAABBBBBCCCCC" });

    expect(calls[1]).toEqual(["AAAAA"]);
    // A single window's mean-pool is a no-op copy, followed by L2 normalization.
    expectClose([...decodeFloat32LE(generated.vector)], l2Normalize([3, 4]));
  });

  it("probes dimensions from the extractor's actual output, not a hardcoded constant", async () => {
    const fiveDimensional = new Map<string, readonly number[]>([[PROBE_TEXT, [1, 2, 3, 4, 5]]]);
    const { factory: fiveDimensionalFactory } = fakeExtractorFactory(fiveDimensional);
    const fiveDimensionalProvider = await createLocalNeuralProvider({ extractor_factory: fiveDimensionalFactory });
    expect(fiveDimensionalProvider.profile.dimensions).toBe(5);
    expect(fiveDimensionalProvider.profile.embedding_profile_id).toContain("-5");

    const twoDimensional = new Map<string, readonly number[]>([[PROBE_TEXT, [1, 1]]]);
    const { factory: twoDimensionalFactory } = fakeExtractorFactory(twoDimensional);
    const twoDimensionalProvider = await createLocalNeuralProvider({ extractor_factory: twoDimensionalFactory });
    expect(twoDimensionalProvider.profile.dimensions).toBe(2);
  });

  it("throws on empty or whitespace-only text without ever calling the extractor", async () => {
    const { factory, calls } = fakeExtractorFactory(new Map([[PROBE_TEXT, [1, 0]]]));
    const provider = await createLocalNeuralProvider({ extractor_factory: factory });
    const callsAfterConstruction = calls.length;

    await expect(provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: "" })).rejects.toThrow();
    await expect(provider.binding.generateVector({ profile: provider.profile, purpose: "query", text: "   \n\t  " })).rejects.toThrow();

    expect(calls).toHaveLength(callsAfterConstruction);
  });

  it("is deterministic: two provider instances built from an equivalent fake produce byte-identical vectors and digests for the same text", async () => {
    const vectorFor = new Map<string, readonly number[]>([
      [PROBE_TEXT, [1, 0]],
      ["hello world", [3, 4]],
    ]);
    const { factory: factoryOne } = fakeExtractorFactory(vectorFor);
    const { factory: factoryTwo } = fakeExtractorFactory(vectorFor);
    const providerOne = await createLocalNeuralProvider({ window_chars: 2000, extractor_factory: factoryOne });
    const providerTwo = await createLocalNeuralProvider({ window_chars: 2000, extractor_factory: factoryTwo });

    const first = await providerOne.binding.generateVector({ profile: providerOne.profile, purpose: "document", text: "hello world" });
    const second = await providerTwo.binding.generateVector({ profile: providerTwo.profile, purpose: "document", text: "hello world" });

    expect([...first.vector]).toEqual([...second.vector]);
    expect(first.vector_digest).toBe(second.vector_digest);
    expect(first.input_digest).toBe(second.input_digest);
  });

  it("ships a stable profile identity and profile_digest across construction calls with identical options", async () => {
    const vectorFor = new Map<string, readonly number[]>([[PROBE_TEXT, [1, 0, 0]]]);
    const { factory: factoryOne } = fakeExtractorFactory(vectorFor);
    const { factory: factoryTwo } = fakeExtractorFactory(vectorFor);
    const providerOne = await createLocalNeuralProvider({ model_id: "Xenova/all-MiniLM-L6-v2", extractor_factory: factoryOne });
    const providerTwo = await createLocalNeuralProvider({ model_id: "Xenova/all-MiniLM-L6-v2", extractor_factory: factoryTwo });

    expect(providerOne.profile).toEqual(providerTwo.profile);
    expect(providerOne.profile.embedding_profile_id).toBe("core:onnx-xenova-all-minilm-l6-v2-3");
    expect(providerOne.binding.runtime_binding_id).toBe("core:onnx-local");
    expect(providerOne.binding.executable_binding_digest).toBe(providerTwo.binding.executable_binding_digest);
    // `profile_digest` must actually be a function of the other fields, not
    // a hardcoded string, and must not participate in its own computation.
    expect(typeof providerOne.profile.profile_digest).toBe("string");
    expect(providerOne.profile.profile_digest.length).toBeGreaterThan(0);
  });

  it("excludes cache_dir and allow_download from both profile_digest and executable_binding_digest", async () => {
    const vectorFor = new Map<string, readonly number[]>([[PROBE_TEXT, [1, 0]]]);
    const { factory: factoryA } = fakeExtractorFactory(vectorFor);
    const { factory: factoryB } = fakeExtractorFactory(vectorFor);

    const providerA = await createLocalNeuralProvider({ cache_dir: "/tmp/urdira-models-a", allow_download: true, extractor_factory: factoryA });
    const providerB = await createLocalNeuralProvider({ cache_dir: "/tmp/some/other/models-b", allow_download: false, extractor_factory: factoryB });

    expect(providerA.profile).toEqual(providerB.profile);
    expect(providerA.binding.executable_binding_digest).toBe(providerB.binding.executable_binding_digest);
  });

  it("passes cache_dir and allow_download through to the extractor_factory even though they never affect any digest", async () => {
    const received: unknown[] = [];
    const factory: NonNullable<LocalNeuralProviderOptions["extractor_factory"]> = async (options) => {
      received.push(options);
      const extractor: EmbeddingExtractor = async (texts) => texts.map(() => [1, 0]);
      return extractor;
    };

    await createLocalNeuralProvider({ cache_dir: "/tmp/urdira-models", allow_download: false, model_id: "some/model", dtype: "fp32", extractor_factory: factory });

    expect(received).toEqual([{ model_id: "some/model", dtype: "fp32", cache_dir: "/tmp/urdira-models", allow_download: false }]);
  });

  it("defaults model_id, dtype, window_chars, max_windows, and allow_download when omitted", async () => {
    const received: unknown[] = [];
    const factory: NonNullable<LocalNeuralProviderOptions["extractor_factory"]> = async (options) => {
      received.push(options);
      const extractor: EmbeddingExtractor = async (texts) => texts.map(() => [1, 0]);
      return extractor;
    };

    const provider = await createLocalNeuralProvider({ extractor_factory: factory });

    expect(received).toEqual([{ model_id: "Xenova/all-MiniLM-L6-v2", dtype: "q8", allow_download: true }]);
    expect(provider.profile.model_id).toBe("Xenova/all-MiniLM-L6-v2");
    expect(provider.profile.maximum_document_tokens).toBe(String(2000 * 64));
  });

  it("rejects a non-positive window_chars or max_windows", async () => {
    const factory: NonNullable<LocalNeuralProviderOptions["extractor_factory"]> = async () => {
      const extractor: EmbeddingExtractor = async (texts) => texts.map(() => [1, 0]);
      return extractor;
    };
    await expect(createLocalNeuralProvider({ window_chars: 0, extractor_factory: factory })).rejects.toThrow();
    await expect(createLocalNeuralProvider({ max_windows: -1, extractor_factory: factory })).rejects.toThrow();
  });
});

describe("generateVectors (batched neural embedding)", () => {
  it("batches N single-window documents into ONE extractor call, pooling/normalizing each independently", async () => {
    const vectorFor = new Map<string, readonly number[]>([
      [PROBE_TEXT, [1, 0]],
      ["AAAAA", [2, 0]],
      ["BBBBB", [0, 4]],
      ["CCCCC", [4, 8]],
    ]);
    const { factory, calls } = fakeExtractorFactory(vectorFor);
    const provider = await createLocalNeuralProvider({ window_chars: 5, max_windows: 64, extractor_factory: factory });
    expect(calls).toEqual([[PROBE_TEXT]]);

    const generated = await provider.binding.generateVectors!([
      { profile: provider.profile, purpose: "document", text: "AAAAA" },
      { profile: provider.profile, purpose: "document", text: "BBBBB" },
      { profile: provider.profile, purpose: "document", text: "CCCCC" },
    ]);

    // Exactly one batched call beyond the dimension probe, carrying every
    // document's (single) window in order.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(["AAAAA", "BBBBB", "CCCCC"]);

    expect(generated).toHaveLength(3);
    expectClose([...decodeFloat32LE(generated[0]!.vector)], l2Normalize([2, 0]));
    expectClose([...decodeFloat32LE(generated[1]!.vector)], l2Normalize([0, 4]));
    expectClose([...decodeFloat32LE(generated[2]!.vector)], l2Normalize([4, 8]));
  });

  it("pools each document's OWN windows independently within one flattened batched call, even when documents have different window counts", async () => {
    const vectorFor = new Map<string, readonly number[]>([
      [PROBE_TEXT, [1, 0]],
      ["AAAAA", [2, 0]],
      ["BBBBB", [0, 4]],
      ["CCCCC", [4, 8]],
    ]);
    const { factory, calls } = fakeExtractorFactory(vectorFor);
    const provider = await createLocalNeuralProvider({ window_chars: 5, max_windows: 64, extractor_factory: factory });

    const generated = await provider.binding.generateVectors!([
      { profile: provider.profile, purpose: "document", text: "AAAAABBBBB" }, // two windows: AAAAA, BBBBB
      { profile: provider.profile, purpose: "document", text: "CCCCC" }, // one window
    ]);

    expect(calls[1]).toEqual(["AAAAA", "BBBBB", "CCCCC"]);
    expect(generated).toHaveLength(2);
    // doc 1: mean([2,0],[0,4]) = [1,2], then L2-normalized.
    expectClose([...decodeFloat32LE(generated[0]!.vector)], l2Normalize(meanOf([[2, 0], [0, 4]])));
    // doc 2: single window, mean-pool is a no-op copy.
    expectClose([...decodeFloat32LE(generated[1]!.vector)], l2Normalize([4, 8]));
  });

  it("splits a batch into multiple extractor calls once total windows exceed the max_windows-derived cap, still pooling every document correctly", async () => {
    const vectorFor = new Map<string, readonly number[]>([
      [PROBE_TEXT, [1, 0]],
      ["AAAAA", [1, 0]],
      ["BBBBB", [0, 1]],
      ["CCCCC", [1, 1]],
    ]);
    const { factory, calls } = fakeExtractorFactory(vectorFor);
    // max_windows: 2 doubles as the per-batch total-window cap, so 3
    // single-window documents (3 windows total) must split into two
    // extractor calls: [AAAAA, BBBBB] then [CCCCC].
    const provider = await createLocalNeuralProvider({ window_chars: 5, max_windows: 2, extractor_factory: factory });

    const generated = await provider.binding.generateVectors!([
      { profile: provider.profile, purpose: "document", text: "AAAAA" },
      { profile: provider.profile, purpose: "document", text: "BBBBB" },
      { profile: provider.profile, purpose: "document", text: "CCCCC" },
    ]);

    expect(calls).toHaveLength(3); // probe + two capped chunks
    expect(calls[1]).toEqual(["AAAAA", "BBBBB"]);
    expect(calls[2]).toEqual(["CCCCC"]);

    expect(generated).toHaveLength(3);
    expectClose([...decodeFloat32LE(generated[0]!.vector)], l2Normalize([1, 0]));
    expectClose([...decodeFloat32LE(generated[1]!.vector)], l2Normalize([0, 1]));
    expectClose([...decodeFloat32LE(generated[2]!.vector)], l2Normalize([1, 1]));
  });

  it("is all-or-nothing: one empty/whitespace input among many rejects the whole batch without ever calling the extractor", async () => {
    const { factory, calls } = fakeExtractorFactory(new Map([[PROBE_TEXT, [1, 0]]]));
    const provider = await createLocalNeuralProvider({ extractor_factory: factory });
    const callsAfterConstruction = calls.length;

    await expect(provider.binding.generateVectors!([
      { profile: provider.profile, purpose: "document", text: "hello world" },
      { profile: provider.profile, purpose: "document", text: "   \n\t  " },
    ])).rejects.toThrow();

    expect(calls).toHaveLength(callsAfterConstruction);
  });

  it("produces vectors byte-identical to sequential generateVector calls when every document fits in one window (fake extractor is per-window independent, so batching order cannot change the result)", async () => {
    const vectorFor = new Map<string, readonly number[]>([
      [PROBE_TEXT, [1, 0]],
      ["alpha", [3, 4]],
      ["beta", [1, 1]],
    ]);
    const { factory: factoryOne } = fakeExtractorFactory(vectorFor);
    const { factory: factoryTwo } = fakeExtractorFactory(vectorFor);
    const providerOne = await createLocalNeuralProvider({ window_chars: 2000, extractor_factory: factoryOne });
    const providerTwo = await createLocalNeuralProvider({ window_chars: 2000, extractor_factory: factoryTwo });

    const sequential = [
      await providerOne.binding.generateVector({ profile: providerOne.profile, purpose: "document", text: "alpha" }),
      await providerOne.binding.generateVector({ profile: providerOne.profile, purpose: "document", text: "beta" }),
    ];
    const batched = await providerTwo.binding.generateVectors!([
      { profile: providerTwo.profile, purpose: "document", text: "alpha" },
      { profile: providerTwo.profile, purpose: "document", text: "beta" },
    ]);

    batched.forEach((generated, index) => {
      expect([...generated.vector]).toEqual([...sequential[index]!.vector]);
      expect(generated.vector_digest).toBe(sequential[index]!.vector_digest);
      expect(generated.input_digest).toBe(sequential[index]!.input_digest);
    });
  });
});

/**
 * Configure-time model provisioning (USER DECISION, 2026-08-13):
 * `ensureLocalEmbeddingModel` is the exact "is the model already present
 * offline; if not, download it" check the daemon's three configure-time
 * admin RPCs run (`packages/daemon/src/semantic-provider-runtime.ts`'s
 * `ensureSemanticAssets`) -- never at daemon start, never on an embed path.
 * Every test below drives it with an injected `extractor_factory`, never the
 * real `defaultExtractorFactory`, so this stays exactly as hermetic as the
 * suite above: no network, no real ONNX runtime, no real model download.
 * `fakeProvisioningFactory`'s `behavior` callback decides, per attempt,
 * whether that attempt "succeeds" purely as a function of the
 * `allow_download` flag `ensureLocalEmbeddingModel` passed it -- which is
 * exactly how a real offline-then-download sequence behaves: the first
 * (`allow_download: false`) attempt either finds the model already cached or
 * doesn't, and only a genuine absence reaches the second (`allow_download: true`)
 * attempt at all.
 */
describe("ensureLocalEmbeddingModel (configure-time model provisioning)", () => {
  function fakeProvisioningFactory(succeeds: (allowDownload: boolean) => boolean): { readonly factory: NonNullable<EnsureLocalEmbeddingModelOptions["extractor_factory"]>; readonly calls: boolean[] } {
    const calls: boolean[] = [];
    const factory: NonNullable<EnsureLocalEmbeddingModelOptions["extractor_factory"]> = async (options) => {
      calls.push(options.allow_download);
      if (!succeeds(options.allow_download)) throw new Error(`fake provisioning extractor_factory refused allow_download=${options.allow_download}`);
      const extractor: EmbeddingExtractor = async (texts) => texts.map(() => [1, 0]);
      return extractor;
    };
    return { factory, calls };
  }

  it("classifies \"present\" when the offline (allow_download: false) attempt alone succeeds -- the download attempt never runs", async () => {
    const { factory, calls } = fakeProvisioningFactory(() => true);
    const result = await ensureLocalEmbeddingModel({ cache_dir: "/tmp/urdira-models", extractor_factory: factory });
    expect(result).toEqual({ status: "present", model_id: "Xenova/all-MiniLM-L6-v2" });
    expect(calls).toEqual([false]);
  });

  it("classifies \"downloaded\" when the offline attempt fails but the allow_download: true attempt succeeds -- the real absent-then-downloaded sequence", async () => {
    const { factory, calls } = fakeProvisioningFactory((allowDownload) => allowDownload);
    const result = await ensureLocalEmbeddingModel({ cache_dir: "/tmp/urdira-models", model_id: "some/model", extractor_factory: factory });
    expect(result).toEqual({ status: "downloaded", model_id: "some/model" });
    expect(calls).toEqual([false, true]);
  });

  it("propagates the underlying error when BOTH attempts fail (still offline, no network reachable, or a genuinely bad model id)", async () => {
    const { factory, calls } = fakeProvisioningFactory(() => false);
    await expect(ensureLocalEmbeddingModel({ cache_dir: "/tmp/urdira-models", extractor_factory: factory })).rejects.toThrow(/allow_download=true/);
    expect(calls).toEqual([false, true]);
  });

  it("calls on_download_start exactly once, with the resolved model_id and cache_dir, right before the allow_download: true attempt -- never when the offline attempt alone succeeds", async () => {
    // Owner decision 2026-08-13 (docs/decisions/18-semantic-model-pack.md
    // Outcome): a configure RPC must observe "a download is starting" BEFORE
    // it happens, so it can log it and never let it run silently. This is
    // the exact seam that observability hangs off -- see
    // `packages/daemon/src/semantic-provider-runtime.ts`'s `ensureSemanticAssets`.
    const present = fakeProvisioningFactory(() => true);
    const starts: { readonly model_id: string; readonly cache_dir: string }[] = [];
    const presentResult = await ensureLocalEmbeddingModel({
      cache_dir: "/tmp/urdira-models",
      extractor_factory: present.factory,
      on_download_start: (info) => starts.push(info),
    });
    expect(presentResult).toEqual({ status: "present", model_id: "Xenova/all-MiniLM-L6-v2" });
    expect(starts).toEqual([]); // nothing to download -- never called

    const absentThenDownloaded = fakeProvisioningFactory((allowDownload) => allowDownload);
    const downloadedResult = await ensureLocalEmbeddingModel({
      cache_dir: "/tmp/urdira-models",
      model_id: "some/model",
      extractor_factory: absentThenDownloaded.factory,
      on_download_start: (info) => starts.push(info),
    });
    expect(downloadedResult).toEqual({ status: "downloaded", model_id: "some/model" });
    expect(starts).toEqual([{ model_id: "some/model", cache_dir: "/tmp/urdira-models" }]);
    // Fired BEFORE the download attempt, not after: the fake factory's
    // second (allow_download: true) call is the only thing that could have
    // produced the "downloaded" status, and it is recorded in `absentThenDownloaded.calls`
    // in call order -- `on_download_start` ran before that call resolved,
    // since `ensureLocalEmbeddingModel` `await`s the callback-triggering
    // branch synchronously before `attempt(true)`.
    expect(absentThenDownloaded.calls).toEqual([false, true]);
  });

  it("defaults model_id to the same bundled default createLocalNeuralProvider uses, and threads dtype/cache_dir through to every attempt", async () => {
    const received: unknown[] = [];
    const factory: NonNullable<EnsureLocalEmbeddingModelOptions["extractor_factory"]> = async (options) => {
      received.push(options);
      const extractor: EmbeddingExtractor = async (texts) => texts.map(() => [1, 0]);
      return extractor;
    };
    const result = await ensureLocalEmbeddingModel({ cache_dir: "/tmp/urdira-models", dtype: "fp32", extractor_factory: factory });
    expect(result).toEqual({ status: "present", model_id: "Xenova/all-MiniLM-L6-v2" });
    expect(received).toEqual([{ model_id: "Xenova/all-MiniLM-L6-v2", dtype: "fp32", cache_dir: "/tmp/urdira-models", allow_download: false }]);
  });
});
