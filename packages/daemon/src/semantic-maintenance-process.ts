import { reconcileSemanticProjection } from "@urdira/engine";
import { createDurableStorage } from "@urdira/storage";
import { buildSemanticProvider, ensureSemanticAssets, type SemanticProviderDescriptor } from "./semantic-provider-runtime.js";
import type { SemanticProcessJob } from "./semantic-process.js";
import process from "node:process";

type Message = { readonly kind: "run"; readonly job: SemanticProcessJob } | { readonly kind: "ensure"; readonly descriptor: SemanticProviderDescriptor } | { readonly kind: "abort" };
let aborted = false;
process.on("message", (message: Message) => { if (message.kind === "abort") aborted = true; });
const send = (message: unknown, done?: () => void): void => { if (!process.send) { done?.(); return; } if (done) process.send(message, () => done()); else process.send(message); };
function details(error: unknown): { name: string; message: string; code?: string } { const code = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined; return { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error), ...(code === undefined ? {} : { code }) }; }
process.once("message", async (message: Message) => {
  if (message.kind === "ensure") {
    try { send({ kind: "ensure_result", notice: await ensureSemanticAssets(message.descriptor) }, () => process.disconnect?.()); }
    catch (error) { send({ kind: "error", error: details(error) }, () => process.disconnect?.()); }
    return;
  }
  if (message.kind !== "run") return;
  let storage: Awaited<ReturnType<typeof createDurableStorage>> | undefined;
  try {
    storage = await createDurableStorage({ rootDir: message.job.data_root, skip_startup_recovery: true });
    const database = await storage.openWorkspace(message.job.workspace_id);
    const provider = await buildSemanticProvider(message.job.descriptor);
    const result = await reconcileSemanticProjection({ database, workspace_id: message.job.workspace_id, content: storage.cas, provider, ...(message.job.max_document_bytes === undefined ? {} : { max_document_bytes: message.job.max_document_bytes }), ...(message.job.embed_batch_size === undefined ? {} : { embed_batch_size: message.job.embed_batch_size }), should_abort: () => aborted });
    await database.close().catch(() => undefined);
    await storage.close().catch(() => undefined);
    storage = undefined;
    send({ kind: "result", result }, () => process.disconnect?.());
  } catch (error) {
    await storage?.close().catch(() => undefined);
    send({ kind: "error", error: details(error) }, () => process.disconnect?.());
  }
});
