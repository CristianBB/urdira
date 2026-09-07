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
  /** Frente S-D (2026-09-07, Lever 2): forwarded verbatim to `reconcileSemanticProjection`'s own `shard` field -- see that field's doc comment. Set by `runSemanticReconcileSharded` below for each of its `count` child processes; absent for every ordinary (unsharded) call, including the finalize call sharding itself makes. */
  readonly shard?: { readonly index: number; readonly count: number };
}

export interface SemanticProcessRun {
  readonly result: Promise<ReconcileSemanticProjectionResult>;
  abort(): void;
}

/**
 * Frente S-D (2026-09-07): default bounded-retry parameters for
 * `runSemanticReconcileInProcessWithRetry` -- see that function's own doc
 * comment. 6 attempts / 500ms base backoff (vs. `execFileWithEbadfRetry`'s
 * 3/250ms) because THIS caller's own fd-pressure condition (one fd per
 * watched corpus file, ~24,900 observed at n8n scale) is sustained for the
 * whole scan/maintenance window, not a single transient race -- a few more,
 * further-spaced attempts give the file-watcher subsystem more chances to
 * settle (or another concurrent fd churn on this shared machine to clear)
 * before giving up.
 */
const SEMANTIC_SPAWN_RETRY_ATTEMPTS = 6;
const SEMANTIC_SPAWN_RETRY_BACKOFF_MS = 500;

/** Frente S-D (2026-09-07): `true` for the exact error shape Node's `child_process` module reports for a failed `spawn()` syscall with `errno EBADF` -- mirrors `scripts/v4-mutation-harness.mjs`'s own `execFileWithEbadfRetry` check (`error.code === "EBADF" || error.errno === -9`, the numeric POSIX errno for EBADF on every platform this codebase ships for). */
function isEbadfSpawnError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  const errno = "errno" in error ? (error as { errno?: unknown }).errno : undefined;
  return code === "EBADF" || errno === -9;
}

/**
 * Frente S-D (2026-09-07): wraps `runSemanticReconcileInProcess` with a
 * bounded `EBADF` retry. `child_process.fork()`'s underlying `spawn()`
 * syscall has a real, documented, PRE-EXISTING failure mode on this
 * codebase's own daemon, unrelated to Lever 2's own sharding
 * (`docs/evidence/2026-09-06-v4-reconcile-threshold.md` §14.5,
 * `docs/evidence/2026-09-03-v4-p3-1-incremental.md` §7.7): a long-running
 * daemon watching a large corpus (n8n scale: ~20k files, roughly one fd per
 * file watcher, ~24,900 total fds observed live) makes Node's own `fork()`
 * intermittently fail with `EBADF` when spawning an ADDITIONAL child process
 * -- confirmed, in both cited evidence docs, to be a transient libuv/Node
 * fd-table race rather than a hard ulimit exhaustion (`ulimit -n`/
 * `kern.maxfilesperproc` both measured FAR above the actual fd count in
 * every observed case; genuinely running out of descriptors would surface
 * as `EMFILE`/`ENFILE`, not `EBADF`). This is squarely a semantic-maintenance
 * blocker at real, large-corpus scale -- without SOME mitigation here, a
 * daemon watching a corpus this size can be unable to spawn ANY semantic
 * child process at all, regardless of how many shards are configured.
 * Genuinely fixing the ROOT CAUSE (one fd per watched file) is a
 * file-watcher-subsystem concern, entirely outside this module's scope;
 * this bounded retry is the SAME mitigation the rest of this codebase
 * already applies to the identical error class
 * (`execFileWithEbadfRetry`, same error check, same bounded-attempts-with-backoff
 * shape) -- not a new invention, and not a claim that the underlying fd
 * pressure is fixed. Every OTHER error (a real provider failure, a
 * malformed job, an `abort()` mid-flight, ...) propagates on the FIRST
 * attempt, unchanged; `abort()` on the returned run aborts whichever attempt
 * is CURRENTLY in flight and permanently disables further retries.
 */
export function runSemanticReconcileInProcessWithRetry(job: SemanticProcessJob, attempts = SEMANTIC_SPAWN_RETRY_ATTEMPTS, backoffMs = SEMANTIC_SPAWN_RETRY_BACKOFF_MS): SemanticProcessRun {
  let currentRun = runSemanticReconcileInProcess(job);
  let abortRequested = false;
  const result = (async (): Promise<ReconcileSemanticProjectionResult> => {
    let attempt = 1;
    for (;;) {
      try {
        return await currentRun.result;
      } catch (error) {
        if (abortRequested || attempt >= attempts || !isEbadfSpawnError(error)) throw error;
        attempt += 1;
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, backoffMs));
        if (abortRequested) throw error;
        currentRun = runSemanticReconcileInProcess(job);
      }
    }
  })();
  return {
    result,
    abort(): void {
      abortRequested = true;
      currentRun.abort();
    },
  };
}

/**
 * Frente S-D (2026-09-07, Lever 2): the daemon-side orchestrator for
 * parallel semantic reconciliation across `shardCount` concurrent child
 * processes. `shardCount <= 1` degrades to exactly `runSemanticReconcileInProcess`
 * (zero behavior change when sharding is disabled or the machine has too few
 * cores to bother -- see `resolveSemanticShardCount`'s own doc comment for
 * how the caller picks `shardCount`).
 *
 * For `shardCount > 1`: spawns `shardCount` children, each running
 * `reconcileSemanticProjection` with a DISTINCT `shard: {index, count:
 * shardCount}` (see that field's own doc comment for why sharding by owning
 * artifact keeps a file's own entities in the same process as its artifact
 * document, preserving Lever 1's composition). None of them writes the
 * completion marker or runs workspace-wide bulk status maintenance. Once
 * every shard resolves, ONE MORE child runs the ordinary UNSHARDED pass --
 * this "finalize" call finds nothing left to embed in the common case (every
 * document was already handled by exactly one shard), then reaches
 * `reconcileSemanticProjection`'s own marker-write logic naturally, which
 * ALSO self-heals any single shard's `failed`/`entity_failed` rows as a side
 * effect of retrying them unsharded. The RETURNED result sums every counter
 * across all shards AND the finalize call (so a caller logging "N documents
 * embedded" sees the true total, not just the finalize call's near-zero
 * remainder), but takes `generation`/`marker_written`/`aborted` from the
 * finalize call alone (the only call with full workspace visibility).
 *
 * If ANY shard itself reports `aborted: true` (a mid-pass `abort()` call),
 * the finalize call is skipped entirely (nothing safely "final" to conclude
 * while a shard stopped early) and the aggregated result carries
 * `aborted: true`, `marker_written: false` -- a later, unobstructed call
 * (through this same function or the ordinary unsharded path) resumes
 * cleanly, exactly like an aborted unsharded pass.
 */
export function runSemanticReconcileSharded(job: SemanticProcessJob, shardCount: number): SemanticProcessRun {
  const effectiveShardCount = Number.isSafeInteger(shardCount) && shardCount > 1 ? shardCount : 1;
  if (effectiveShardCount <= 1) return runSemanticReconcileInProcessWithRetry(job);

  let abortRequested = false;
  let activeRuns: readonly SemanticProcessRun[] = [];
  const abortActive = (): void => { for (const run of activeRuns) run.abort(); };

  const result = (async (): Promise<ReconcileSemanticProjectionResult> => {
    const shardRuns = Array.from({ length: effectiveShardCount }, (_, index) => runSemanticReconcileInProcessWithRetry({ ...job, shard: { index, count: effectiveShardCount } }));
    activeRuns = shardRuns;
    if (abortRequested) abortActive();
    const shardResults = await Promise.all(shardRuns.map((run) => run.result));
    if (shardResults.some((value) => value.aborted === true)) return sumShardResults(shardResults, undefined, true);

    const finalizeRun = runSemanticReconcileInProcessWithRetry(job);
    activeRuns = [finalizeRun];
    if (abortRequested) abortActive();
    const finalizeResult = await finalizeRun.result;
    return sumShardResults(shardResults, finalizeResult, finalizeResult.aborted === true);
  })();

  return {
    result,
    abort(): void {
      if (abortRequested) return;
      abortRequested = true;
      abortActive();
    },
  };
}

function sumShardResults(shardResults: readonly ReconcileSemanticProjectionResult[], finalizeResult: ReconcileSemanticProjectionResult | undefined, aborted: boolean): ReconcileSemanticProjectionResult {
  const all = finalizeResult === undefined ? shardResults : [...shardResults, finalizeResult];
  const sum = (selector: (value: ReconcileSemanticProjectionResult) => number): number => all.reduce((total, value) => total + selector(value), 0);
  return {
    generation: finalizeResult?.generation ?? shardResults[0]?.generation ?? 0,
    closed: sum((value) => value.closed),
    inserted: sum((value) => value.inserted),
    skipped_oversized: sum((value) => value.skipped_oversized),
    skipped_undecodable: sum((value) => value.skipped_undecodable),
    skipped_empty: sum((value) => value.skipped_empty),
    failed: sum((value) => value.failed),
    entity_inserted: sum((value) => value.entity_inserted),
    entity_closed: sum((value) => value.entity_closed),
    entity_skipped_oversized: sum((value) => value.entity_skipped_oversized),
    entity_skipped_undecodable: sum((value) => value.entity_skipped_undecodable),
    entity_skipped_ineligible: sum((value) => value.entity_skipped_ineligible),
    entity_skipped_empty: sum((value) => value.entity_skipped_empty),
    entity_failed: sum((value) => value.entity_failed),
    marker_written: finalizeResult?.marker_written ?? false,
    ...(aborted ? { aborted: true } : {}),
  };
}

/**
 * Frente S-D (2026-09-07, Lever 2): picks how many concurrent semantic
 * reconciler processes to run, from `URDIRA_SEMANTIC_WORKERS` (positive
 * integer) when set, else the plan's own measured default of 2 (`docs/evidence/2026-09-07-v4-semantic-wiring-and-embed-performance.md`
 * §2.3: ~1.44x at 2 concurrent processes on a 10-core machine, regressing
 * below 2 at 4 -- thread oversubscription). Capped at `floor(cpuCount / 4)`
 * (never fewer than 1) so a small/shared machine never over-commits: each
 * semantic child process runs its OWN multi-threaded ONNX pool internally
 * (unconfigured, defaults to roughly the physical core count -- see the same
 * evidence doc's §2.2), so spawning more shards than `cpuCount / 4` would
 * oversubscribe the SAME way 4 concurrent processes did in that measurement.
 */
export function resolveSemanticShardCount(cpuCount: number, envValue: string | undefined): number {
  const cap = Math.max(1, Math.floor(cpuCount / 4));
  if (envValue !== undefined) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) return Math.min(parsed, cap);
  }
  return Math.min(2, cap);
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

/**
 * Frente S-D (2026-09-07): the semantic maintenance child's own V8 old-space
 * heap ceiling. Discovered live at n8n scale: `createNativeSemanticEntityRecordSource`'s
 * `entityCandidates()` (`@urdira/engine`'s `semantic-entity-source-v4.ts`)
 * materializes EVERY visible entity-category candidate record (n8n: 326,817,
 * per `docs/evidence/2026-09-07-v4-n8n-parity-and-semantic-segments.md` §B.2's
 * own histogram) as decoded JS objects in ONE array before any eligibility
 * filtering happens -- comfortably exceeding Node's DEFAULT old-space limit
 * (observed: two concurrent shard children both hit `FATAL ERROR: ...
 * JavaScript heap out of memory` around ~4.1GB). Raising the ceiling here is
 * a targeted, low-risk mitigation for a real embed-viability blocker this
 * session found -- NOT a claim that `entityCandidates()`'s own O(corpus)
 * eager-materialization memory profile is fixed (that is a
 * `semantic-entity-source-v4.ts` concern, out of this module's scope; a
 * genuine fix would stream/batch that scan instead of building one giant
 * array). 6144 MiB comfortably clears the observed ~4.1GB ceiling with
 * headroom on this class of machine (32GB physical RAM observed) while
 * still leaving room for 2 CONCURRENT shard children (Lever 2) without
 * over-committing; tunable via `URDIRA_SEMANTIC_CHILD_MAX_OLD_SPACE_MB` for
 * a smaller machine that needs a lower ceiling instead.
 */
const SEMANTIC_CHILD_MAX_OLD_SPACE_MB = (() => {
  const raw = process.env["URDIRA_SEMANTIC_CHILD_MAX_OLD_SPACE_MB"];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 6144;
})();

export function runSemanticReconcileInProcess(job: SemanticProcessJob): SemanticProcessRun {
  const child = fork(semanticProcessEntryPath("semantic-maintenance-process.js"), [], { execArgv: [`--max-old-space-size=${SEMANTIC_CHILD_MAX_OLD_SPACE_MB}`], stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced" });
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

export interface NeuralSemanticProviderHostStartupOptions {
  readonly startup_timeout_ms?: number;
  readonly spawn_child?: () => ChildProcess;
}

export const NEURAL_SEMANTIC_HOST_STARTUP_TIMEOUT_MS = 30_000;

/** Persistent child used by neural query and configure-time provisioning. */
export async function startNeuralSemanticProviderHost(descriptor: SemanticProviderDescriptor, options: NeuralSemanticProviderHostStartupOptions = {}): Promise<NeuralSemanticProviderHost> {
  if (descriptor.kind !== "neural") throw new Error("The neural semantic host requires a neural descriptor.");
  const startupTimeoutMs = options.startup_timeout_ms ?? NEURAL_SEMANTIC_HOST_STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0) throw new Error("Neural semantic host startup timeout must be a positive safe integer.");
  const spawnChild = options.spawn_child ?? (() => fork(semanticProcessEntryPath("semantic-neural-process.js"), [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" }));
  let child: ChildProcess | undefined;
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { resolve: (value: NeuralHostReply) => void; reject: (error: Error) => void }>();
  let crashes: number[] = [];
  let circuitOpenUntil = 0;
  const rejectPending = (error: Error): void => { for (const item of pending.values()) item.reject(error); pending.clear(); };
  let restart: Promise<NeuralHostReply> | undefined;
  const spawn = (): Promise<NeuralHostReply> => {
    const processChild = spawnChild();
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
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timeout);
        processChild.off("message", onMessage);
        processChild.off("error", onError);
        processChild.off("exit", onExit);
      };
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        operation();
      };
      const rejectBeforeReady = (error: Error, terminate: boolean): void => finish(() => {
        if (child === processChild) child = undefined;
        if (terminate && !processChild.killed) processChild.kill("SIGTERM");
        reject(error);
      });
      const onMessage = (message: NeuralHostReply): void => {
        if (message.kind === "ready") finish(() => resolve(message));
        else if (message.kind === "error" && message.id === undefined) rejectBeforeReady(asError(message.error ?? { message: "Neural semantic host initialization failed." }), true);
      };
      const onError = (error: Error): void => rejectBeforeReady(error, true);
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => rejectBeforeReady(new Error(`Neural semantic host exited before readiness (${code ?? "no-code"}/${signal ?? "no-signal"}).`), false);
      const timeout = setTimeout(() => rejectBeforeReady(new Error(`Neural semantic host did not become ready within ${startupTimeoutMs} ms.`), true), startupTimeoutMs);
      timeout.unref?.();
      processChild.on("message", onMessage);
      processChild.once("error", onError);
      processChild.once("exit", onExit);
      try {
        processChild.send({ kind: "init", descriptor }, (error) => { if (error) rejectBeforeReady(error, true); });
      } catch (error) {
        rejectBeforeReady(error instanceof Error ? error : new Error(String(error)), true);
      }
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
