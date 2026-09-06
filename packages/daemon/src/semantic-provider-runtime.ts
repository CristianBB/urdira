// Configure-time embedding-model provisioning (USER DECISION, 2026-08-13):
// the daemon and every embed path run strictly OFFLINE -- the open local
// neural model is only ever downloaded when urdira is CONFIGURED (the
// `core:workspace_add`/`core:workspace_configure`/`core:configuration_set`
// admin RPCs, see `runtime.ts`'s `ensureAndActivateSemanticProvider`), never
// at daemon start and never during indexing or a query. This module is the
// one place `@urdira/daemon` is allowed to know about `@urdira/embedding-local`
// at all -- and even here, the import is LAZY (a dynamic `await import(...)`
// inside the `"neural"` branch of each exported function, never a static
// top-level import) so that a daemon process configured for the `"hash"` or
// `"http"` provider kind never pulls `@urdira/embedding-local`'s
// `@huggingface/transformers`/ONNX dependency chain into memory at all.
//
// `SemanticProviderDescriptor` (PINNED shape, shared with the semantic
// worker-thread follow-up that serializes it across a `node:worker_threads`
// boundary) is a plain, JSON-serializable description of WHICH provider to
// build -- never the provider instance itself, and never anything
// download-related (`allow_download` is not a descriptor field: every
// daemon-owned construction of a `"neural"` descriptor forces
// `allow_download: false`, unconditionally, in `buildSemanticProvider`
// below -- only `ensureSemanticAssets`'s own explicit provisioning step ever
// sets `allow_download: true`, and only via `@urdira/embedding-local`'s own
// `ensureLocalEmbeddingModel`, never via `buildSemanticProvider`).
import type { ResolvedSemanticProvider } from "@urdira/engine";
import { createHttpEmbeddingProvider, createLocalHashProvider } from "@urdira/engine";
import { access } from "node:fs/promises";

export type SemanticProviderDescriptor =
  | { readonly kind: "neural"; readonly model_id?: string; readonly dtype?: string; readonly cache_dir: string; readonly window_chars?: number; readonly max_windows?: number }
  | { readonly kind: "http"; readonly endpoint: string; readonly model: string; readonly dimensions: number; readonly api_key?: string; readonly max_batch_inputs?: number; readonly max_input_tokens?: number }
  | { readonly kind: "hash" };

/**
 * Builds a real `ResolvedSemanticProvider` from a descriptor. `"hash"`/`"http"`
 * construction is synchronous and network-free by construction (`"http"`'s
 * `createHttpEmbeddingProvider` only ever makes a network call from inside
 * `generateVector`, never at construction); `"neural"` construction ALWAYS
 * forces `allow_download: false` -- this function is called from daemon
 * start (which must never touch the network at all, see `runtime.ts`) and
 * from the post-configure activation step (which only calls this AFTER
 * `ensureSemanticAssets` below has already confirmed the model is present),
 * so neither caller ever wants or needs this function itself to download
 * anything. A `"neural"` descriptor whose model is genuinely absent from
 * `cache_dir` makes this reject -- callers treat that as "semantic
 * unavailable for now", never as a hard startup failure (see `runtime.ts`'s
 * doc comments on `semanticProvider`/`ensureAndActivateSemanticProvider`).
 */
export async function buildSemanticProvider(descriptor: SemanticProviderDescriptor): Promise<ResolvedSemanticProvider> {
  if (descriptor.kind === "hash") return createLocalHashProvider();
  if (descriptor.kind === "http") {
    return createHttpEmbeddingProvider({
      endpoint: descriptor.endpoint,
      model: descriptor.model,
      dimensions: descriptor.dimensions,
      ...(descriptor.api_key === undefined ? {} : { api_key: descriptor.api_key }),
      // Frente S-B (2026-09-06, R12): threaded through so an operator's
      // `URDIRA_EMBEDDINGS_MAX_BATCH_INPUTS`/`URDIRA_EMBEDDINGS_MAX_INPUT_TOKENS`
      // (`apps/urdira/src/index.ts`'s `resolveSemanticDescriptor`) actually
      // reach the provider -- both are optional, `createHttpEmbeddingProvider`
      // itself defaults them (64 / 8192) when omitted.
      ...(descriptor.max_batch_inputs === undefined ? {} : { max_batch_inputs: descriptor.max_batch_inputs }),
      ...(descriptor.max_input_tokens === undefined ? {} : { max_input_tokens: descriptor.max_input_tokens }),
    });
  }
  // "neural": the only branch that ever touches `@urdira/embedding-local` --
  // lazy `import()`, not a static one, per this module's own header comment.
  try {
    await access(descriptor.cache_dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`The local embedding model cache is not provisioned at ${descriptor.cache_dir}.`);
    throw error;
  }
  const { createLocalNeuralProvider } = await import("@urdira/embedding-local");
  return createLocalNeuralProvider({
    cache_dir: descriptor.cache_dir,
    allow_download: false,
    ...(descriptor.model_id === undefined ? {} : { model_id: descriptor.model_id }),
    ...(descriptor.dtype === undefined ? {} : { dtype: descriptor.dtype }),
    ...(descriptor.window_chars === undefined ? {} : { window_chars: descriptor.window_chars }),
    ...(descriptor.max_windows === undefined ? {} : { max_windows: descriptor.max_windows }),
  });
}

/**
 * The user-visible outcome of a configure RPC's provisioning attempt (owner
 * decision 2026-08-13, docs/decisions/18-semantic-model-pack.md Outcome: a
 * configure RPC that downloads a model must say so, never download
 * silently). Every one of the three configure-time admin RPC handlers
 * (`runtime.ts`) carries this back as its response's own `semantic_model`
 * field whenever `ensureAndActivateSemanticProvider` actually ran a
 * provisioning attempt this call -- omitted (not `undefined`-valued, simply
 * absent) when there was nothing to provision (kill switch, `"hash"`/`"http"`
 * descriptor, or a provider already active from an earlier call/daemon-start
 * success). `"present"`/`"downloaded"` mirror `ensureLocalEmbeddingModel`'s
 * own two-attempt classification; `"failed"` is new here -- both attempts
 * failed, already `console.warn`ed below, and the RPC still succeeds
 * (decision 06: a provisioning failure never blocks structural work).
 */
export interface SemanticModelProvisioningNotice {
  readonly model_id: string;
  readonly status: "present" | "downloaded" | "failed";
}

/**
 * The ONE function in this module allowed to actually reach the network --
 * and even then, only for a `"neural"` descriptor, and only when called from
 * `runtime.ts`'s `ensureAndActivateSemanticProvider`, itself only ever
 * invoked from inside the three configure-time admin RPC handlers (never
 * from daemon start, a scan, or a query). `"hash"`/`"http"` descriptors have
 * no on-disk asset to provision at all -- a `"hash"` provider is pure
 * arithmetic and an `"http"` provider's "model" lives on an operator-owned
 * remote endpoint, not in this daemon's own cache -- so this is a no-op
 * (`undefined`) for both, exactly mirroring `@urdira/embedding-local`'s
 * `ensureLocalEmbeddingModel`'s own two-attempt (offline-then-download)
 * classification for the one case that DOES have something to provision.
 *
 * Never rejects, unlike `ensureLocalEmbeddingModel` itself: a total failure
 * (still offline, no network, disk full, bad model id) is caught HERE and
 * reported back as `{ status: "failed" }` data -- exactly like the
 * `"hash"`/`"http"` no-op `undefined` return, a failed attempt is something
 * the caller decides how to react to, not an exception it must catch. This
 * is also the one point that ever logs a download -- both a start-of-download
 * line (before the network attempt, via `on_download_start`, naming the
 * model id and cache dir so the download is never silent in the daemon log)
 * and the pre-existing failure line, unchanged from when `runtime.ts` used
 * to log it itself after catching this function's old thrown error.
 */
export async function ensureSemanticAssets(descriptor: SemanticProviderDescriptor): Promise<SemanticModelProvisioningNotice | undefined> {
  // Frente S-B.3 (2026-09-06, plan §4.6 (vi)): an `"http"` descriptor's
  // "model" lives on an operator-owned remote endpoint -- there is nothing
  // for this daemon to download, ever, but a configure call must say so
  // explicitly (never silently do nothing with no explanation at all) so an
  // operator who just typed `--endpoint ...` sees confirmation this is the
  // expected "no local model" behavior, not a missed provisioning step.
  if (descriptor.kind === "http") {
    console.warn(`[urdira] semantic provider configured as external HTTP endpoint "${descriptor.endpoint}"; no local model download.`);
    return undefined;
  }
  if (descriptor.kind !== "neural") return undefined;
  const { ensureLocalEmbeddingModel, DEFAULT_MODEL_ID } = await import("@urdira/embedding-local");
  const modelId = descriptor.model_id ?? DEFAULT_MODEL_ID;
  try {
    return await ensureLocalEmbeddingModel({
      cache_dir: descriptor.cache_dir,
      ...(descriptor.model_id === undefined ? {} : { model_id: descriptor.model_id }),
      ...(descriptor.dtype === undefined ? {} : { dtype: descriptor.dtype }),
      on_download_start: ({ model_id, cache_dir }) => {
        console.warn(`[urdira] downloading embedding model "${model_id}" into "${cache_dir}" (first-time setup, one-time download)...`);
      },
    });
  } catch (error) {
    // Same wording `runtime.ts`'s own catch used to log around its call to
    // this function -- relocated here, not reworded, now that this function
    // never lets the failure escape as a rejection.
    console.warn(`[urdira] failed to provision the configured local embedding model -- semantic search remains unavailable; retry by running "urdira workspace add"/"urdira workspace configure" again once the issue (e.g. network access) is resolved: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return { model_id: modelId, status: "failed" };
  }
}
