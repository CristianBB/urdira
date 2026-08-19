import { buildSemanticProvider, ensureSemanticAssets, type SemanticProviderDescriptor } from "./semantic-provider-runtime.js";
import type { GenerateVectorInput } from "@urdira/engine";
import process from "node:process";

let provider: Awaited<ReturnType<typeof buildSemanticProvider>> | undefined;
let descriptor: SemanticProviderDescriptor | undefined;
const send = (message: unknown): void => { if (process.send) process.send(message); };
process.on("message", async (message: any) => {
  try {
    if (message.kind === "init") {
      descriptor = message.descriptor as SemanticProviderDescriptor;
      provider = await buildSemanticProvider(descriptor);
      send({ kind: "ready", profile: provider.profile, runtime_binding_id: provider.binding.runtime_binding_id, executable_binding_digest: provider.binding.executable_binding_digest });
    } else if (message.kind === "ensure") {
      send({ kind: "result", id: message.id, notice: descriptor ? await ensureSemanticAssets(descriptor) : undefined });
    } else if (message.kind === "generate") {
      if (!provider) throw new Error("Neural semantic host is not initialized.");
      send({ kind: "result", id: message.id, result: await provider.binding.generateVector(message.input as GenerateVectorInput) });
    } else if (message.kind === "generate_batch") {
      if (!provider) throw new Error("Neural semantic host is not initialized.");
      const generate = provider.binding.generateVectors;
      if (!generate) throw new Error("Neural semantic provider does not support batch vectors.");
      send({ kind: "result", id: message.id, result: await generate(message.inputs as readonly GenerateVectorInput[]) });
    } else if (message.kind === "shutdown") {
      process.disconnect?.();
    }
  } catch (error) {
    send({ kind: "error", id: message.id, error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } });
  }
});
