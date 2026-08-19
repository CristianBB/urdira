import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ReconcileSemanticProjectionResult, ResolvedSemanticProvider, SemanticGeneratedVector, GenerateVectorInput } from "@urdira/engine";
import type { SemanticProviderDescriptor } from "./semantic-provider-runtime.js";

export interface SemanticProcessJob {
  readonly data_root: string;
  readonly workspace_id: string;
  readonly descriptor: SemanticProviderDescriptor;
  readonly max_document_bytes?: number;
  readonly embed_batch_size?: number;
}

export interface SemanticProcessRun {
  readonly result: Promise<ReconcileSemanticProjectionResult>;
  abort(): void;
}

export async function ensureSemanticAssetsInProcess(descriptor: SemanticProviderDescriptor): Promise<unknown> {
  const child = fork(semanticProcessEntryPath("semantic-maintenance-process.js"), [], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced" });
  child.stderr?.on("data", (chunk) => { process.stderr.write(`[urdira semantic child] ${String(chunk)}`); });
  return new Promise((resolve, reject) => {
    child.on("message", (message: { readonly kind: string; readonly notice?: unknown; readonly error?: ProcessError }) => {
      if (message.kind === "ensure_result") { resolve(message.notice); child.disconnect(); }
      else if (message.kind === "error") { reject(asError(message.error ?? { message: "Semantic asset provisioning failed." })); child.disconnect(); }
    });
    child.on("error", reject);
    child.on("exit", (code) => { if (code !== 0) reject(new Error(`Semantic asset process exited with code ${code}.`)); });
    child.send({ kind: "ensure", descriptor });
  });
}

interface ProcessError { readonly name?: string; readonly message: string; readonly code?: string }
interface ProcessResult { readonly kind: "result"; readonly result: ReconcileSemanticProjectionResult }
interface ProcessFailure { readonly kind: "error"; readonly error: ProcessError }
type ProcessMessage = ProcessResult | ProcessFailure;

const ABORT_GRACE_MS = process.platform === "win32" ? 10_000 : 2_000;
const KILL_GRACE_MS = 1_000;

export function semanticProcessEntryPath(name: string, packageUrl = import.meta.resolve("@urdira/daemon")): string {
  return fileURLToPath(new URL(name, packageUrl));
}

function asError(error: ProcessError): Error {
  const value = new Error(error.message);
  value.name = error.name ?? "Error";
  if (error.code !== undefined) (value as Error & { code?: string }).code = error.code;
  return value;
}

export function runSemanticReconcileInProcess(job: SemanticProcessJob): SemanticProcessRun {
  const child = fork(semanticProcessEntryPath("semantic-maintenance-process.js"), [], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced" });
  child.stderr?.on("data", (chunk) => { process.stderr.write(`[urdira semantic child] ${String(chunk)}`); });
  let settled = false;
  let aborted = false;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = (): void => {
    if (abortTimer) clearTimeout(abortTimer);
    if (killTimer) clearTimeout(killTimer);
    abortTimer = undefined;
    killTimer = undefined;
  };
  const result = new Promise<ReconcileSemanticProjectionResult>((resolve, reject) => {
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      fn();
    };
    child.on("message", (message: ProcessMessage) => settle(() => {
      if (message.kind === "error") reject(asError(message.error));
      else resolve(message.result);
      if (!child.killed) child.disconnect();
    }));
    child.on("error", (error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
    child.on("exit", (code, signal) => settle(() => {
      if (aborted) {
        resolve({ generation: 0, closed: 0, inserted: 0, skipped_oversized: 0, skipped_undecodable: 0, skipped_empty: 0, failed: 0, entity_inserted: 0, entity_closed: 0, entity_skipped_oversized: 0, entity_skipped_undecodable: 0, entity_skipped_ineligible: 0, entity_skipped_empty: 0, entity_failed: 0, marker_written: false, aborted: true });
      } else reject(new Error(`Semantic maintenance process exited before producing a result (code ${code ?? "null"}, signal ${signal ?? "none"}).`));
    }));
    child.send({ kind: "run", job });
  });
  return {
    result,
    abort(): void {
      if (settled || aborted) return;
      aborted = true;
      child.send({ kind: "abort" }, () => undefined);
      abortTimer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, KILL_GRACE_MS);
        killTimer.unref?.();
      }, ABORT_GRACE_MS);
      abortTimer.unref?.();
    },
  };
}

interface NeuralHostRequest { readonly kind: "generate" | "generate_batch" | "ensure"; readonly id: number; readonly input?: GenerateVectorInput; readonly inputs?: readonly GenerateVectorInput[] }
interface NeuralHostReply { readonly kind: "ready" | "result" | "error"; readonly id?: number; readonly profile?: ResolvedSemanticProvider["profile"]; readonly runtime_binding_id?: string; readonly executable_binding_digest?: string; readonly result?: SemanticGeneratedVector | readonly SemanticGeneratedVector[]; readonly notice?: unknown; readonly error?: ProcessError }

export interface NeuralSemanticProviderHost {
  readonly provider: ResolvedSemanticProvider;
  ensure(): Promise<unknown>;
  readonly initial_notice?: unknown;
  close(): Promise<void>;
}

/** Persistent child used by neural query and configure-time provisioning. */
export async function startNeuralSemanticProviderHost(descriptor: SemanticProviderDescriptor): Promise<NeuralSemanticProviderHost> {
  if (descriptor.kind !== "neural") throw new Error("The neural semantic host requires a neural descriptor.");
  let child: ChildProcess | undefined;
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { resolve: (value: NeuralHostReply) => void; reject: (error: Error) => void }>();
  let crashes: number[] = [];
  let circuitOpenUntil = 0;
  const rejectPending = (error: Error): void => { for (const item of pending.values()) item.reject(error); pending.clear(); };
  let restart: Promise<NeuralHostReply> | undefined;
  const spawn = (): Promise<NeuralHostReply> => {
    const processChild = fork(semanticProcessEntryPath("semantic-neural-process.js"), [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
    child = processChild;
    processChild.on("message", (message: NeuralHostReply) => {
      if (message.kind === "ready") return;
      if (message.id === undefined) return;
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.kind === "error") item.reject(asError(message.error ?? { message: "Neural semantic host failed." }));
      else item.resolve(message);
    });
    processChild.on("error", (error) => rejectPending(error instanceof Error ? error : new Error(String(error))));
    processChild.on("exit", () => {
      if (child === processChild) child = undefined;
      if (closed) return;
      const now = Date.now();
      crashes = crashes.filter((value) => now - value < 60_000);
      crashes.push(now);
      if (crashes.length >= 3) circuitOpenUntil = now + 60_000;
      rejectPending(new Error("Neural semantic host exited; semantic search is temporarily unavailable."));
    });
    return new Promise<NeuralHostReply>((resolve, reject) => {
      const onMessage = (message: NeuralHostReply): void => { if (message.kind === "ready") { processChild.off("message", onMessage); resolve(message); } };
      processChild.on("message", onMessage);
      processChild.send({ kind: "init", descriptor }, (error) => { if (error) reject(error); });
    });
  };
  const ensureChild = async (): Promise<NeuralHostReply> => {
    if (child) return { kind: "ready" };
    if (Date.now() < circuitOpenUntil) throw new Error("Neural semantic host circuit breaker is open.");
    restart ??= spawn().finally(() => { restart = undefined; });
    return restart;
  };
  const request = async (kind: NeuralHostRequest["kind"], input?: GenerateVectorInput, inputs?: readonly GenerateVectorInput[]): Promise<NeuralHostReply> => {
    if (closed) return Promise.reject(new Error("Neural semantic host is closed."));
    if (Date.now() < circuitOpenUntil) return Promise.reject(new Error("Neural semantic host circuit breaker is open."));
    await ensureChild();
    const current = child;
    if (!current) throw new Error("Neural semantic host is unavailable.");
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      current.send({ kind, id, ...(input === undefined ? {} : { input }), ...(inputs === undefined ? {} : { inputs }) }, (error) => {
        if (error) { pending.delete(id); reject(error); }
      });
    });
  };
  const ready = await spawn();
  if (!ready.profile || !ready.runtime_binding_id || !ready.executable_binding_digest) throw new Error("Neural semantic host returned an incomplete provider profile.");
  const binding = {
    runtime_binding_id: ready.runtime_binding_id,
    executable_binding_digest: ready.executable_binding_digest,
    generateVector: async (input: GenerateVectorInput): Promise<SemanticGeneratedVector> => (await request("generate", input)).result as SemanticGeneratedVector,
    generateVectors: async (inputs: readonly GenerateVectorInput[]): Promise<readonly SemanticGeneratedVector[]> => (await request("generate_batch", undefined, inputs)).result as readonly SemanticGeneratedVector[],
  };
  return {
    provider: { profile: ready.profile, binding },
    ensure: async () => (await request("ensure")).notice,
    initial_notice: ready.notice,
    close: async () => { if (closed) return; closed = true; rejectPending(new Error("Neural semantic host closed.")); const current = child; if (!current) return; await new Promise<void>((resolve) => { current.once("exit", () => resolve()); current.send({ kind: "shutdown" }, () => current.kill()); }); },
  };
}

/** @deprecated compatibility alias; semantic maintenance is process-isolated. */
export const runSemanticReconcileInThread = runSemanticReconcileInProcess;
export type SemanticThreadJob = SemanticProcessJob;
export type SemanticThreadRun = SemanticProcessRun;
