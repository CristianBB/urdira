import { describe, expect, it } from "vitest";
import {
  DeterministicFakeWatcher,
  FreshnessBarrier,
  ParcelWatcherAdapter,
  ReconciliationCoordinator,
  type FreshnessBarrierPort,
  type FreshnessCheckpoint,
  type FreshnessOperationContext,
  type FreshnessSnapshotBinding,
  type FreshnessWorkspaceTarget,
  type ParcelWatcherBackend,
  type PhysicalWatcherEvent,
  type ReconciliationClock,
  type ReconciliationCommit,
  type ReconciliationCommitOutcome,
  type ReconciliationPort,
  type ReconciliationRequest,
  type ReconciliationResult,
  type SourceBarrierStateUpdate,
  type TimerHandle,
  type WatcherBinding,
  type WatcherHint,
} from "../packages/engine/src/index.js";

class ManualClock implements ReconciliationClock {
  #now = 0;
  #next = 0;
  readonly #timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

  now(): number { return this.#now; }

  set_timeout(callback: () => void, delayMs: number): TimerHandle {
    const handle = ++this.#next;
    this.#timers.set(handle, { at: this.#now + delayMs, callback });
    return handle;
  }

  clear_timeout(handle: TimerHandle): void { this.#timers.delete(Number(handle)); }

  advance(milliseconds: number): void {
    const destination = this.#now + milliseconds;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= destination)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      this.#now = due[1].at;
      this.#timers.delete(due[0]);
      due[1].callback();
    }
    this.#now = destination;
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const directoryBinding: WatcherBinding = {
  workspace_id: "workspace:one",
  source_provider_binding_id: "binding:directory",
  source_provider: "core:directory_source_provider",
  source_provider_version: "1",
  ordering_domain: "binding:directory",
  root: "/repo",
};

const gitBinding: WatcherBinding = {
  ...directoryBinding,
  source_provider_binding_id: "binding:git",
  source_provider: "core:git_worktree_source_provider",
  ordering_domain: "binding:git",
};

function recordingPort(
  result: (request: ReconciliationRequest) => ReconciliationResult | Promise<ReconciliationResult> = (request) => ({
    stable: true,
    equivalent: false,
    checkpoint_id: `checkpoint:${request.trigger}`,
    target_state: { trigger: request.trigger },
  }),
  commitHook?: (
    commit: ReconciliationCommit,
    apply: () => ReconciliationCommitOutcome,
  ) => Promise<ReconciliationCommitOutcome>,
): {
  readonly calls: ReconciliationRequest[];
  readonly checkpoints: string[];
  readonly publications: unknown[];
  readonly source_states: SourceBarrierStateUpdate[];
  readonly port: ReconciliationPort;
} {
  const calls: ReconciliationRequest[] = [];
  const checkpoints: string[] = [];
  const publications: unknown[] = [];
  const sourceStates: SourceBarrierStateUpdate[] = [];
  return {
    calls,
    checkpoints,
    publications,
    source_states: sourceStates,
    port: {
      reconcile: async (request) => {
        calls.push(structuredClone(request));
        return await result(request);
      },
      set_source_barrier_state: async (value) => { sourceStates.push(structuredClone(value)); },
      commit_reconciliation: async (commit) => {
        const apply = (): ReconciliationCommitOutcome => {
          if (!commit.is_current()) return "stale";
          if (!commit.result.equivalent) publications.push(commit.result.target_state);
          checkpoints.push(commit.result.checkpoint_id);
          if (commit.current_state !== undefined) sourceStates.push(structuredClone(commit.current_state));
          return "committed";
        };
        return commitHook === undefined ? apply() : commitHook(commit, apply);
      },
    },
  };
}

async function settle(coordinator: ReconciliationCoordinator): Promise<void> {
  await coordinator.idle();
}

describe("Phase 7 physical watcher adapters", () => {
  it("normalizes macOS, Linux, and Windows physical paths into provider-local hint URIs", () => {
    const unix = new ParcelWatcherAdapter(directoryBinding);
    const windows = new ParcelWatcherAdapter({ ...directoryBinding, root: "C:\\Repo", case_sensitive: false });

    expect(unix.normalize_events([
      { type: "create", path: "/repo/src/new.ts" },
      { type: "update", path: "/repo/src/main.ts" },
      { type: "delete", path: "/repo/src/old.ts" },
    ]).events.map((event) => [event.event_class, event.normalized_uri, event.authority])).toEqual([
      ["presence", "src/new.ts", "hint"],
      ["modify", "src/main.ts", "hint"],
      ["absence", "src/old.ts", "hint"],
    ]);
    expect(windows.normalize_events([
      { type: "update", path: "c:\\repo\\src\\main.ts" },
    ]).events[0]).toMatchObject({ normalized_uri: "src/main.ts", authority: "hint" });
  });

  it("never turns a physical delete notification into deletion authority", () => {
    const adapter = new ParcelWatcherAdapter(directoryBinding);
    const deletion = adapter.normalize_events([{ type: "delete", path: "/repo/gone.ts" }]).events[0];

    expect(deletion).toMatchObject({ event_class: "absence", authority: "hint" });
    expect(deletion).not.toHaveProperty("deletion_authority");
  });

  it("provides deterministic duplicate, reordered, overflow, reset, and administrative fixtures", async () => {
    const watcher = new DeterministicFakeWatcher(gitBinding);
    const received: WatcherHint[] = [];
    await watcher.subscribe((batch) => { received.push(...batch.events); });

    watcher.duplicate("src/a.ts");
    watcher.reordered(["src/c.ts", "src/b.ts"]);
    watcher.overflow();
    watcher.reset();
    watcher.administrative_change("git_head");
    await watcher.idle();

    expect(received.map((event) => [event.event_class, event.normalized_uri])).toEqual([
      ["modify", "src/a.ts"],
      ["modify", "src/a.ts"],
      ["modify", "src/c.ts"],
      ["modify", "src/b.ts"],
      ["overflow", ""],
      ["provider_reset", ""],
      ["git_head", ".git/HEAD"],
    ]);
    expect(received.map((event) => event.provider_sequence)).toEqual([
      "1", "2", "3", "4", "5", "6", "7",
    ]);
  });

  it("classifies real Git administrative and provider-root events into source barriers", async () => {
    let deliver: ((error: Error | null, events: readonly { readonly type: "create" | "update" | "delete"; readonly path: string }[]) => unknown) | undefined;
    const backend: ParcelWatcherBackend = {
      subscribe: async (_root, callback) => {
        deliver = callback;
        return { unsubscribe: async () => undefined };
      },
    };
    const batches: WatcherHint[] = [];
    const adapter = new ParcelWatcherAdapter(gitBinding, { backend });
    await adapter.subscribe((batch) => { batches.push(...batch.events); });

    deliver?.(null, [
      { type: "update", path: "/repo/.git/HEAD" },
      { type: "update", path: "/repo/.git/index" },
      { type: "update", path: "/repo/.git/worktrees/feature/gitdir" },
      { type: "delete", path: "/repo" },
    ]);
    await adapter.idle();

    expect(batches.map((event) => [event.event_class, event.normalized_uri, event.authority])).toEqual([
      ["git_head", ".git/HEAD", "hint"],
      ["git_index", ".git/index", "hint"],
      ["worktree_administration", ".git/worktrees/feature/gitdir", "hint"],
      ["provider_root_transition", "", "hint"],
    ]);
  });

  it("serializes real and fake delivery and routes handler rejection to on_error", async () => {
    let deliver: ((error: Error | null, events: readonly { readonly type: "create" | "update" | "delete"; readonly path: string }[]) => unknown) | undefined;
    const errors: string[] = [];
    const order: string[] = [];
    const first = deferred<void>();
    let calls = 0;
    const adapter = new ParcelWatcherAdapter(directoryBinding, {
      backend: {
        subscribe: async (_root, callback) => {
          deliver = callback;
          return { unsubscribe: async () => undefined };
        },
      },
      on_error: (error) => { errors.push(error.message); },
    });
    await adapter.subscribe(async (batch) => {
      const uri = batch.events[0]?.normalized_uri ?? "";
      order.push(`start:${uri}`);
      if (++calls === 1) await first.promise;
      else throw new Error("handler failed");
      order.push(`end:${uri}`);
    });

    deliver?.(null, [{ type: "update", path: "/repo/one.ts" }]);
    deliver?.(null, [{ type: "update", path: "/repo/two.ts" }]);
    await flushMicrotasks();
    expect(order).toEqual(["start:one.ts"]);
    first.resolve();
    await adapter.idle();
    expect(order).toEqual(["start:one.ts", "end:one.ts", "start:two.ts"]);
    expect(errors).toEqual(["handler failed"]);

    const fakeOrder: string[] = [];
    const fakeFirst = deferred<void>();
    const fake = new DeterministicFakeWatcher(directoryBinding, { on_error: (error) => { errors.push(error.message); } });
    let fakeCalls = 0;
    await fake.subscribe(async (batch) => {
      fakeOrder.push(batch.events[0]?.normalized_uri ?? "");
      if (++fakeCalls === 1) await fakeFirst.promise;
      else throw new Error("fake handler failed");
    });
    fake.modify("three.ts");
    fake.modify("four.ts");
    await flushMicrotasks();
    expect(fakeOrder).toEqual(["three.ts"]);
    fakeFirst.resolve();
    await fake.idle();
    expect(fakeOrder).toEqual(["three.ts", "four.ts"]);
    expect(errors).toEqual(["handler failed", "fake handler failed"]);
  });

  // Regression test for the "silently dead watcher" incident (see
  // `ParcelWatcherAdapter`'s doc comment, `packages/engine/src/watchers.ts`):
  // a `@parcel/watcher` backend error must not just deliver a
  // `provider_reset` hint (already covered above) but also re-arm a FRESH
  // underlying subscription, since the backend's own contract never commits
  // to still delivering later events on the SAME subscription after
  // reporting an error. This drives a fake backend through: an error (must
  // re-subscribe), then a real event on the NEW subscription (must still
  // reach the handler -- proving the watcher is genuinely alive afterward,
  // not just that `subscribe` was called again), then enough further errors
  // to exhaust the bounded re-arm budget (must stop re-subscribing, not spin
  // forever), then confirms `unsubscribe()` tears down whichever subscription
  // is current without throwing.
  it("re-arms a fresh subscription after a watcher backend error, and gives up after a bounded number of consecutive failures", async () => {
    type Deliver = (error: Error | null, events: readonly PhysicalWatcherEvent[]) => unknown;
    const delivers: Deliver[] = [];
    const unsubscribed: number[] = [];
    let subscribeCalls = 0;
    const backend: ParcelWatcherBackend = {
      subscribe: async (_root, callback) => {
        const index = subscribeCalls++;
        delivers.push(callback);
        return { unsubscribe: async () => { unsubscribed.push(index); } };
      },
    };
    const errors: string[] = [];
    const received: string[] = [];
    const adapter = new ParcelWatcherAdapter(directoryBinding, { backend, on_error: (error) => { errors.push(error.message); } });
    const subscription = await adapter.subscribe(async (batch) => { received.push(...batch.events.map((event) => event.normalized_uri)); });

    expect(subscribeCalls).toBe(1);
    delivers[0]?.(new Error("watch backend died"), []);
    await flushMicrotasks();
    // A fresh subscription was armed -- the error did not just deliver a
    // `provider_reset` hint and stop.
    expect(subscribeCalls).toBe(2);
    expect(errors).toEqual(["watch backend died"]);

    // The NEW subscription's callback is the one actually wired to the
    // watcher's own delivery pipeline: a real event on it must still reach
    // the handler, proving re-arming produced a genuinely live watcher, not
    // an inert stand-in.
    delivers[1]?.(null, [{ type: "update", path: "/repo/after-rearm.ts" }]);
    await adapter.idle();
    // `received` also carries the empty-URI `provider_reset` hint the error
    // above delivered; the real point is that `after-rearm.ts` reaches the
    // handler at all, through the newly re-armed subscription.
    expect(received).toContain("after-rearm.ts");

    // Exhaust the bounded re-arm budget: each further error re-arms again
    // until the cap, then stops re-subscribing.
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = delivers.length - 1;
      delivers[current]?.(new Error(`persistent failure ${attempt}`), []);
      await flushMicrotasks();
    }
    const subscribeCallsAtGiveUp = subscribeCalls;
    // A few more errors past giving up must not resume re-arming.
    delivers[delivers.length - 1]?.(new Error("still failing"), []);
    await flushMicrotasks();
    expect(subscribeCalls).toBe(subscribeCallsAtGiveUp);

    // `unsubscribe()` tears down whichever subscription is current (the last
    // one armed) without throwing, even after the give-up path.
    await expect(subscription.unsubscribe()).resolves.toBeUndefined();
    expect(unsubscribed).toContain(subscribeCalls - 1);
  });
});

describe("Phase 7 reconciliation scheduling", () => {
  it("settles after the quiet window and forces capture after continuous activity", async () => {
    const clock = new ManualClock();
    const recorded = recordingPort();
    const coordinator = new ReconciliationCoordinator({
      workspace_id: "workspace:one",
      bindings: [directoryBinding],
      clock,
      port: recorded.port,
      complete_interval_ms: 1_000,
    });
    const watcher = new DeterministicFakeWatcher(directoryBinding);
    await watcher.subscribe((batch) => coordinator.accept(batch));

    watcher.modify("src/quiet.ts");
    await watcher.idle();
    clock.advance(49);
    await settle(coordinator);
    expect(recorded.calls).toHaveLength(0);
    clock.advance(1);
    await settle(coordinator);
    expect(recorded.calls).toMatchObject([{ kind: "targeted", trigger: "settled_batch" }]);

    for (let elapsed = 0; elapsed < 250; elapsed += 40) {
      watcher.modify(`src/continuous-${elapsed}.ts`);
      await watcher.idle();
      clock.advance(Math.min(40, 250 - elapsed));
    }
    await settle(coordinator);
    expect(recorded.calls.filter((call) => call.trigger === "maximum_batch_window")).toHaveLength(1);
    coordinator.close();
  });

  it("does not merge provider bindings or reorder their watermarks", async () => {
    const clock = new ManualClock();
    const recorded = recordingPort();
    const coordinator = new ReconciliationCoordinator({
      workspace_id: "workspace:one",
      bindings: [directoryBinding, gitBinding],
      clock,
      port: recorded.port,
      complete_interval_ms: 1_000,
    });
    const directory = new DeterministicFakeWatcher(directoryBinding);
    const git = new DeterministicFakeWatcher(gitBinding);
    await directory.subscribe((batch) => coordinator.accept(batch));
    await git.subscribe((batch) => coordinator.accept(batch));

    directory.modify("src/a.ts");
    git.reordered(["src/z.ts", "src/y.ts"]);
    directory.modify("src/b.ts");
    await Promise.all([directory.idle(), git.idle()]);
    clock.advance(50);
    await settle(coordinator);

    expect(recorded.calls).toHaveLength(2);
    expect(recorded.calls.map((call) => call.source_provider_binding_id).sort()).toEqual(["binding:directory", "binding:git"]);
    expect(recorded.calls.find((call) => call.source_provider_binding_id === "binding:git")?.hints.map((event) => event.normalized_uri)).toEqual(["src/z.ts", "src/y.ts"]);
    expect(recorded.calls.find((call) => call.source_provider_binding_id === "binding:directory")?.hints.map((event) => event.provider_sequence)).toEqual(["1", "2"]);
    coordinator.close();
  });

  it("publishes absence and later presence as ordered non-coalescible reconciliations", async () => {
    const clock = new ManualClock();
    const recorded = recordingPort();
    const coordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [directoryBinding], clock, port: recorded.port, complete_interval_ms: 1_000 });
    const watcher = new DeterministicFakeWatcher(directoryBinding);
    await watcher.subscribe((batch) => coordinator.accept(batch));

    watcher.absence("src/lifecycle.ts");
    watcher.presence("src/lifecycle.ts");
    await watcher.idle();
    await settle(coordinator);
    clock.advance(50);
    await settle(coordinator);

    expect(recorded.calls.map((call) => [call.trigger, call.hints[0]?.event_class])).toEqual([
      ["absence_barrier", "absence"],
      ["settled_batch", "presence"],
    ]);
    coordinator.close();
  });

  it("bypasses ordinary debounce for exclusion and escalates overflow, restart, recovery, resume, and unproven freshness", async () => {
    const clock = new ManualClock();
    const recorded = recordingPort();
    const coordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [directoryBinding], clock, port: recorded.port, complete_interval_ms: 1_000 });
    const watcher = new DeterministicFakeWatcher(directoryBinding);
    await watcher.subscribe((batch) => coordinator.accept(batch));

    watcher.exclusion("generated.ts");
    watcher.overflow();
    await watcher.idle();
    coordinator.provider_restarted("binding:directory");
    coordinator.recover("binding:directory");
    coordinator.resume("binding:directory");
    coordinator.request_freshness("binding:directory", false);
    await settle(coordinator);

    expect(recorded.calls.map((call) => [call.kind, call.trigger])).toEqual([
      ["targeted", "exclusion_barrier"],
      ["complete", "watcher_overflow"],
      ["complete", "provider_restart"],
      ["complete", "daemon_recovery"],
      ["complete", "resume"],
      ["complete", "unproven_freshness"],
    ]);
    coordinator.close();
  });

  it("bypasses the quiet window for an explicit freshness request proven by targeted state", async () => {
    const clock = new ManualClock();
    const recorded = recordingPort();
    const coordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [directoryBinding], clock, port: recorded.port, complete_interval_ms: 1_000 });
    const watcher = new DeterministicFakeWatcher(directoryBinding);
    await watcher.subscribe((batch) => coordinator.accept(batch));

    watcher.modify("src/pending.ts");
    await watcher.idle();
    coordinator.request_freshness("binding:directory", true);
    await settle(coordinator);

    expect(recorded.calls).toMatchObject([{ kind: "targeted", trigger: "explicit_freshness" }]);
    coordinator.close();
  });

  it("runs a complete authoritative reconciliation every ten minutes by default", async () => {
    const clock = new ManualClock();
    const recorded = recordingPort();
    const coordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [directoryBinding], clock, port: recorded.port });

    clock.advance(599_999);
    await settle(coordinator);
    expect(recorded.calls).toHaveLength(0);
    clock.advance(1);
    await settle(coordinator);
    expect(recorded.calls).toMatchObject([{ kind: "complete", trigger: "periodic" }]);
    coordinator.close();
  });

  it("forbids disabling complete reconciliation for mutable watched providers", () => {
    const clock = new ManualClock();
    const recorded = recordingPort();

    expect(() => new ReconciliationCoordinator({
      workspace_id: "workspace:one",
      bindings: [directoryBinding],
      clock,
      port: recorded.port,
      complete_interval_ms: 0,
    })).toThrow("engine:complete_reconciliation_required");
  });

  it("opens a source barrier for Git transitions, pauses targeted publication, and publishes one stable target", async () => {
    const clock = new ManualClock();
    const recorded = recordingPort();
    const coordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [gitBinding], clock, port: recorded.port, complete_interval_ms: 1_000 });
    const watcher = new DeterministicFakeWatcher(gitBinding);
    await watcher.subscribe((batch) => coordinator.accept(batch));

    watcher.administrative_change("git_head");
    watcher.modify("src/noisy-transition.ts");
    await watcher.idle();
    await settle(coordinator);
    clock.advance(50);
    await settle(coordinator);

    expect(recorded.calls.map((call) => call.kind)).toEqual(["administrative", "complete", "administrative", "complete"]);
    expect(recorded.calls[3]).toMatchObject({ trigger: "source_barrier", source_barrier: true });
    expect(recorded.publications).toHaveLength(1);
    expect(coordinator.barrier_open("binding:git")).toBe(false);
    coordinator.close();
  });

  it("suppresses queued and in-flight targeted publication after a source barrier opens", async () => {
    const queuedClock = new ManualClock();
    const queued = recordingPort();
    const queuedCoordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [gitBinding], clock: queuedClock, port: queued.port, complete_interval_ms: 1_000 });
    const queuedWatcher = new DeterministicFakeWatcher(gitBinding);
    queuedCoordinator.accept(queuedWatcher.modify("src/queued.ts"));
    queuedClock.advance(50);
    queuedCoordinator.accept(queuedWatcher.administrative_change("git_head"));
    await settle(queuedCoordinator);
    expect(queued.calls.map((call) => call.kind)).toEqual(["administrative", "complete"]);
    expect(queued.calls[1]?.hints.map((hint) => hint.normalized_uri)).toEqual(["src/queued.ts", ".git/HEAD"]);
    expect(queued.publications).toHaveLength(1);
    queuedCoordinator.close();

    const inFlightClock = new ManualClock();
    const targeted = deferred<ReconciliationResult>();
    const inFlight = recordingPort((request) => request.kind === "targeted" ? targeted.promise : {
      stable: true,
      equivalent: false,
      checkpoint_id: "checkpoint:barrier",
      target_state: { trigger: request.trigger },
    });
    const inFlightCoordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [gitBinding], clock: inFlightClock, port: inFlight.port, complete_interval_ms: 1_000 });
    const inFlightWatcher = new DeterministicFakeWatcher(gitBinding);
    await inFlightWatcher.subscribe((batch) => inFlightCoordinator.accept(batch));
    inFlightWatcher.modify("src/in-flight.ts");
    await inFlightWatcher.idle();
    inFlightClock.advance(50);
    await flushMicrotasks();
    inFlightWatcher.administrative_change("git_index");
    await inFlightWatcher.idle();
    targeted.resolve({ stable: true, equivalent: false, checkpoint_id: "checkpoint:stale", target_state: { trigger: "stale_targeted" } });
    await settle(inFlightCoordinator);
    expect(inFlight.calls.map((call) => call.kind)).toEqual(["targeted", "administrative", "complete"]);
    expect(inFlight.publications).toEqual([{ trigger: "source_barrier" }]);
    expect(inFlight.calls[2]?.hints.map((hint) => hint.normalized_uri)).toEqual(["src/in-flight.ts", ".git/index"]);
    inFlightCoordinator.close();
  });

  it("reruns a barrier when events arrive mid-capture and advances state only after one stable publication", async () => {
    const clock = new ManualClock();
    const firstFull = deferred<ReconciliationResult>();
    let fullCalls = 0;
    const recorded = recordingPort((request) => {
      if (request.kind === "complete" && ++fullCalls === 1) return firstFull.promise;
      return { stable: true, equivalent: false, checkpoint_id: "checkpoint:stable", target_state: { trigger: request.trigger, hints: request.hints.map((hint) => hint.normalized_uri) } };
    });
    const coordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [gitBinding], clock, port: recorded.port, complete_interval_ms: 1_000 });
    const watcher = new DeterministicFakeWatcher(gitBinding);
    await watcher.subscribe((batch) => coordinator.accept(batch));

    watcher.administrative_change("git_head");
    await watcher.idle();
    await flushMicrotasks();
    watcher.modify("src/during-barrier.ts");
    await watcher.idle();
    firstFull.resolve({ stable: true, equivalent: false, checkpoint_id: "checkpoint:stale-full", target_state: { trigger: "stale_full" } });
    await settle(coordinator);

    expect(recorded.calls.filter((call) => call.kind === "complete")).toHaveLength(2);
    expect(recorded.calls.filter((call) => call.kind === "complete")[1]?.hints.map((hint) => hint.normalized_uri)).toEqual([".git/HEAD", "src/during-barrier.ts"]);
    expect(recorded.publications).toEqual([{ trigger: "source_barrier", hints: [".git/HEAD", "src/during-barrier.ts"] }]);
    expect(recorded.source_states).toEqual([
      { workspace_id: "workspace:one", source_provider_binding_id: "binding:git", state: "stale", prior_snapshot_queryable: true },
      { workspace_id: "workspace:one", source_provider_binding_id: "binding:git", state: "current", prior_snapshot_queryable: true, checkpoint_id: "checkpoint:stable" },
    ]);
    coordinator.close();
  });

  it("restores rejected segments, retries barriers, and exposes terminal degraded state", async () => {
    const clock = new ManualClock();
    let attempts = 0;
    const recovering = recordingPort((request) => {
      if (request.kind === "complete" && ++attempts === 1) throw new Error("temporary provider failure");
      return { stable: true, equivalent: false, checkpoint_id: "checkpoint:recovered", target_state: { hints: request.hints.map((hint) => hint.normalized_uri) } };
    });
    const coordinator = new ReconciliationCoordinator({
      workspace_id: "workspace:one",
      bindings: [gitBinding],
      clock,
      port: recovering.port,
      complete_interval_ms: 1_000,
      barrier_retry_ms: 10,
      maximum_barrier_attempts: 2,
    });
    const watcher = new DeterministicFakeWatcher(gitBinding);
    await watcher.subscribe((batch) => coordinator.accept(batch));
    watcher.administrative_change("git_head");
    await watcher.idle();
    await settle(coordinator);
    expect(coordinator.barrier_status("binding:git")).toMatchObject({ state: "stale", attempts: 1, pending_hint_count: 1 });
    clock.advance(10);
    await settle(coordinator);
    expect(recovering.calls.filter((call) => call.kind === "complete").map((call) => call.hints.map((hint) => hint.normalized_uri))).toEqual([[".git/HEAD"], [".git/HEAD"]]);
    expect(recovering.publications).toEqual([{ hints: [".git/HEAD"] }]);
    expect(coordinator.barrier_status("binding:git")).toMatchObject({ state: "current", attempts: 0, pending_hint_count: 0 });
    coordinator.close();

    const terminalClock = new ManualClock();
    const terminal = recordingPort((request) => {
      if (request.kind === "complete") throw new Error("permanent provider failure");
      return { stable: true, equivalent: true, checkpoint_id: "checkpoint:administrative" };
    });
    const terminalCoordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [gitBinding], clock: terminalClock, port: terminal.port, complete_interval_ms: 1_000, barrier_retry_ms: 10, maximum_barrier_attempts: 2 });
    const terminalWatcher = new DeterministicFakeWatcher(gitBinding);
    await terminalWatcher.subscribe((batch) => terminalCoordinator.accept(batch));
    terminalWatcher.administrative_change("git_index");
    await terminalWatcher.idle();
    await settle(terminalCoordinator);
    terminalClock.advance(10);
    await settle(terminalCoordinator);
    expect(terminalCoordinator.barrier_status("binding:git")).toMatchObject({ state: "degraded", attempts: 2, pending_hint_count: 1, error_code: "engine:source_barrier_reconciliation_failed" });
    expect(terminal.source_states.at(-1)).toMatchObject({ state: "degraded", prior_snapshot_queryable: true, error_code: "engine:source_barrier_reconciliation_failed" });
    terminalCoordinator.close();
  });

  it("restores an ordinary rejected reconciliation segment for an explicit retry", async () => {
    const clock = new ManualClock();
    let attempts = 0;
    const recorded = recordingPort((request) => {
      if (++attempts === 1) throw new Error("targeted failure");
      return { stable: true, equivalent: false, checkpoint_id: "checkpoint:retry", target_state: { hints: request.hints.map((hint) => hint.normalized_uri) } };
    });
    const coordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [directoryBinding], clock, port: recorded.port, complete_interval_ms: 1_000 });
    const watcher = new DeterministicFakeWatcher(directoryBinding);
    await watcher.subscribe((batch) => coordinator.accept(batch));
    watcher.modify("src/retry.ts");
    await watcher.idle();
    clock.advance(50);
    await expect(coordinator.idle()).rejects.toThrow("targeted failure");
    coordinator.request_freshness("binding:directory", true);
    await settle(coordinator);
    expect(recorded.calls.map((call) => call.hints.map((hint) => hint.normalized_uri))).toEqual([["src/retry.ts"], ["src/retry.ts"]]);
    coordinator.close();
  });

  it("joins overflow, reset, and periodic full scans into an active barrier", async () => {
    const clock = new ManualClock();
    const firstFull = deferred<ReconciliationResult>();
    let fullCalls = 0;
    const recorded = recordingPort((request) => {
      if (request.kind === "complete" && ++fullCalls === 1) return firstFull.promise;
      return { stable: true, equivalent: false, checkpoint_id: "checkpoint:joined", target_state: { trigger: request.trigger, hints: request.hints.map((hint) => hint.event_class) } };
    });
    const coordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [gitBinding], clock, port: recorded.port, complete_interval_ms: 10 });
    const watcher = new DeterministicFakeWatcher(gitBinding);
    await watcher.subscribe((batch) => coordinator.accept(batch));
    watcher.administrative_change("git_head");
    await watcher.idle();
    await flushMicrotasks();
    watcher.overflow();
    watcher.reset();
    await watcher.idle();
    clock.advance(10);
    firstFull.resolve({ stable: true, equivalent: false, checkpoint_id: "checkpoint:stale", target_state: { trigger: "stale" } });
    await settle(coordinator);

    expect(recorded.calls.filter((call) => call.kind === "complete").every((call) => call.trigger === "source_barrier")).toBe(true);
    expect(recorded.publications).toEqual([{ trigger: "source_barrier", hints: ["git_head", "overflow", "provider_reset"] }]);
    coordinator.close();
  });

  it("atomically suppresses targeted commit when a barrier opens during publication", async () => {
    const clock = new ManualClock();
    const commitGate = deferred<void>();
    let commits = 0;
    const recorded = recordingPort(undefined, async (_commit, apply) => {
      if (++commits === 1) await commitGate.promise;
      return apply();
    });
    const coordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [gitBinding], clock, port: recorded.port, complete_interval_ms: 1_000 });
    const watcher = new DeterministicFakeWatcher(gitBinding);
    await watcher.subscribe((batch) => coordinator.accept(batch));
    watcher.modify("src/publishing.ts");
    await watcher.idle();
    clock.advance(50);
    await flushMicrotasks();
    watcher.administrative_change("git_head");
    await watcher.idle();
    commitGate.resolve();
    await settle(coordinator);

    expect(recorded.publications).toEqual([{ trigger: "source_barrier" }]);
    expect(recorded.checkpoints).toEqual(["checkpoint:source_barrier"]);
    expect(recorded.calls.at(-1)?.hints.map((hint) => hint.normalized_uri)).toEqual(["src/publishing.ts", ".git/HEAD"]);
    coordinator.close();
  });

  it("keeps a barrier open and reruns when a hint arrives during atomic commit", async () => {
    const clock = new ManualClock();
    const commitGate = deferred<void>();
    let commits = 0;
    const recorded = recordingPort(undefined, async (_commit, apply) => {
      if (++commits === 1) await commitGate.promise;
      return apply();
    });
    const coordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [gitBinding], clock, port: recorded.port, complete_interval_ms: 1_000 });
    const watcher = new DeterministicFakeWatcher(gitBinding);
    await watcher.subscribe((batch) => coordinator.accept(batch));
    watcher.administrative_change("git_index");
    await watcher.idle();
    await flushMicrotasks();
    watcher.modify("src/during-commit.ts");
    await watcher.idle();
    commitGate.resolve();
    await settle(coordinator);

    expect(recorded.publications).toHaveLength(1);
    expect(recorded.checkpoints).toEqual(["checkpoint:source_barrier"]);
    expect(recorded.calls.filter((call) => call.kind === "complete").at(-1)?.hints.map((hint) => hint.normalized_uri)).toEqual([".git/index", "src/during-commit.ts"]);
    expect(recorded.source_states.map((state) => state.state)).toEqual(["stale", "current"]);
    coordinator.close();
  });

  it("routes stale-state and atomic publication rejection through bounded barrier retry", async () => {
    const staleClock = new ManualClock();
    const stale = recordingPort();
    let staleWrites = 0;
    const stalePort: ReconciliationPort = {
      ...stale.port,
      set_source_barrier_state: async (update) => {
        if (update.state === "stale" && ++staleWrites === 1) throw new Error("stale state write failed");
        stale.source_states.push(structuredClone(update));
      },
    };
    const staleCoordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [gitBinding], clock: staleClock, port: stalePort, complete_interval_ms: 1_000, barrier_retry_ms: 10, maximum_barrier_attempts: 2 });
    staleCoordinator.accept(new DeterministicFakeWatcher(gitBinding).administrative_change("git_head"));
    await settle(staleCoordinator);
    expect(stale.publications).toEqual([]);
    staleClock.advance(10);
    await settle(staleCoordinator);
    expect(stale.publications).toHaveLength(1);
    expect(stale.source_states.map((state) => state.state)).toEqual(["stale", "current"]);
    staleCoordinator.close();

    for (const failedStage of ["publish", "checkpoint", "current"] as const) {
      const clock = new ManualClock();
      let attempts = 0;
      const recorded = recordingPort(undefined, async (_commit, apply) => {
        if (++attempts === 1) throw new Error(`${failedStage} failed`);
        return apply();
      });
      const coordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [gitBinding], clock, port: recorded.port, complete_interval_ms: 1_000, barrier_retry_ms: 10, maximum_barrier_attempts: 2 });
      coordinator.accept(new DeterministicFakeWatcher(gitBinding).administrative_change("git_index"));
      await settle(coordinator);
      expect(recorded.publications, failedStage).toEqual([]);
      expect(recorded.checkpoints, failedStage).toEqual([]);
      expect(recorded.source_states.map((state) => state.state), failedStage).toEqual(["stale"]);
      clock.advance(10);
      await settle(coordinator);
      expect(recorded.publications, failedStage).toHaveLength(1);
      expect(recorded.checkpoints, failedStage).toHaveLength(1);
      expect(recorded.source_states.map((state) => state.state), failedStage).toEqual(["stale", "current"]);
      coordinator.close();
    }
  });

  it("terminates degraded without partial exposure when atomic commit and degraded-state write exhaust", async () => {
    const clock = new ManualClock();
    const recorded = recordingPort(undefined, async () => { throw new Error("atomic commit failed"); });
    const port: ReconciliationPort = {
      ...recorded.port,
      set_source_barrier_state: async (update) => {
        if (update.state === "degraded") throw new Error("degraded state write failed");
        recorded.source_states.push(structuredClone(update));
      },
    };
    const coordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [gitBinding], clock, port, complete_interval_ms: 1_000, barrier_retry_ms: 10, maximum_barrier_attempts: 2 });
    coordinator.accept(new DeterministicFakeWatcher(gitBinding).administrative_change("git_head"));
    await settle(coordinator);
    clock.advance(10);
    await settle(coordinator);

    expect(recorded.publications).toEqual([]);
    expect(recorded.checkpoints).toEqual([]);
    expect(recorded.source_states.map((state) => state.state)).toEqual(["stale"]);
    expect(coordinator.barrier_status("binding:git")).toMatchObject({ state: "degraded", error_code: "engine:source_barrier_state_write_failed" });
    coordinator.close();
  });

  it("restores an ordinary unstable result for a successful explicit retry", async () => {
    const clock = new ManualClock();
    let attempts = 0;
    const recorded = recordingPort((request) => ++attempts === 1
      ? { stable: false, equivalent: false, checkpoint_id: "checkpoint:unstable" }
      : { stable: true, equivalent: false, checkpoint_id: "checkpoint:stable-retry", target_state: { hints: request.hints.map((hint) => hint.normalized_uri) } });
    const coordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [directoryBinding], clock, port: recorded.port, complete_interval_ms: 1_000 });
    coordinator.accept(new DeterministicFakeWatcher(directoryBinding).modify("src/unstable.ts"));
    clock.advance(50);
    await expect(coordinator.idle()).rejects.toThrow("engine:reconciliation_unstable");
    coordinator.request_freshness("binding:directory", true);
    await settle(coordinator);

    expect(recorded.calls.map((call) => call.hints.map((hint) => hint.normalized_uri))).toEqual([["src/unstable.ts"], ["src/unstable.ts"]]);
    expect(recorded.publications).toEqual([{ hints: ["src/unstable.ts"] }]);
    coordinator.close();
  });

  it("advances freshness checkpoints without publishing an empty generation for equivalent updates", async () => {
    const clock = new ManualClock();
    const recorded = recordingPort(() => ({ stable: true, equivalent: true, checkpoint_id: "checkpoint:equivalent" }));
    const coordinator = new ReconciliationCoordinator({ workspace_id: "workspace:one", bindings: [directoryBinding], clock, port: recorded.port, complete_interval_ms: 1_000 });
    const watcher = new DeterministicFakeWatcher(directoryBinding);
    await watcher.subscribe((batch) => coordinator.accept(batch));

    watcher.modify("src/equivalent.ts");
    await watcher.idle();
    clock.advance(50);
    await settle(coordinator);

    expect(recorded.checkpoints).toEqual(["checkpoint:equivalent"]);
    expect(recorded.publications).toEqual([]);
    coordinator.close();
  });
});

function target(workspaceId: string, watermark: string, successor?: string): FreshnessWorkspaceTarget {
  return {
    workspace_id: workspaceId,
    watermarks: [{
      source_provider_binding_id: `binding:${workspaceId}`,
      ordering_domain: `binding:${workspaceId}`,
      watermark,
      ...(successor === undefined ? {} : { required_successor_watermark: successor }),
    }],
  };
}

function checkpoint(workspaceId: string, watermark: string, represents: readonly string[] = []): FreshnessCheckpoint {
  return {
    workspace_id: workspaceId,
    freshness_checkpoint_id: `checkpoint:${workspaceId}:${watermark}`,
    verification_status: "equivalent",
    watermarks: [{
      source_provider_binding_id: `binding:${workspaceId}`,
      ordering_domain: `binding:${workspaceId}`,
      watermark,
      represents_watermarks: represents,
    }],
  };
}

function binding(workspaceId: string, checkpointId: string): FreshnessSnapshotBinding {
  return {
    workspace_id: workspaceId,
    snapshot_id: `snapshot:${workspaceId}`,
    freshness_checkpoint_id: checkpointId,
    retention_lease_id: `lease:${workspaceId}`,
  };
}

function freshnessFixture(clock: ManualClock, targets: ReadonlyMap<string, FreshnessWorkspaceTarget>) {
  const checkpoints = new Map<string, FreshnessCheckpoint>();
  let captures = 0;
  let atomicRequests = 0;
  let partial = false;
  const port: FreshnessBarrierPort = {
    validate_workspaces: async (workspaceIds) => {
      if (workspaceIds.some((workspaceId) => !targets.has(workspaceId))) throw new Error("unknown workspace");
    },
    capture_targets: async (workspaceIds) => {
      captures += 1;
      return workspaceIds.map((workspaceId) => structuredClone(targets.get(workspaceId)!));
    },
    equivalent_checkpoint: async (workspaceId) => checkpoints.get(workspaceId),
    acquire_bindings_atomically: async (requests) => {
      atomicRequests += 1;
      const selected = partial ? requests.slice(0, -1) : requests;
      return selected.map((request) => binding(request.workspace_id, request.freshness_checkpoint_id));
    },
    release_bindings: async () => undefined,
  };
  return {
    barrier: new FreshnessBarrier({ clock, port }),
    checkpoints,
    captures: () => captures,
    atomicRequests: () => atomicRequests,
    makePartial: () => { partial = true; },
  };
}

describe("Phase 7 freshness barriers", () => {
  it("captures target watermarks once and does not perpetually extend for newer events", async () => {
    const clock = new ManualClock();
    const targets = new Map([["one", target("one", "watermark:1")]]);
    const fixture = freshnessFixture(clock, targets);
    const waiting = fixture.barrier.wait_for_current(["one"]);
    await Promise.resolve();
    targets.set("one", target("one", "watermark:999"));
    fixture.checkpoints.set("one", checkpoint("one", "watermark:1"));
    await fixture.barrier.check();

    await expect(waiting).resolves.toMatchObject([{ workspace_id: "one", freshness_checkpoint_id: "checkpoint:one:watermark:1" }]);
    expect(fixture.captures()).toBe(1);
  });

  it("requires the captured ordered successor when indexing cannot represent the predecessor directly", async () => {
    const clock = new ManualClock();
    const fixture = freshnessFixture(clock, new Map([["one", target("one", "watermark:1", "watermark:2")]]));
    fixture.checkpoints.set("one", checkpoint("one", "watermark:1"));
    const waiting = fixture.barrier.wait_for_current(["one"]);
    await Promise.resolve();
    await fixture.barrier.check();
    expect(fixture.atomicRequests()).toBe(0);

    fixture.checkpoints.set("one", checkpoint("one", "watermark:2", ["watermark:1"]));
    await fixture.barrier.check();
    await expect(waiting).resolves.toHaveLength(1);
  });

  it("uses a five-second default timeout, enforces the sixty-second maximum, and supports zero-wait checks", async () => {
    const clock = new ManualClock();
    const fixture = freshnessFixture(clock, new Map([["one", target("one", "watermark:1")]]));
    const waiting = fixture.barrier.wait_for_current(["one"]);
    await fixture.barrier.check();
    clock.advance(4_999);
    await Promise.resolve();
    let settled = false;
    void waiting.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    clock.advance(1);
    await expect(waiting).rejects.toThrow("core:freshness_wait_timeout");

    await expect(fixture.barrier.wait_for_current(["one"], { timeout_ms: 0 })).rejects.toThrow("core:freshness_wait_timeout");
    await expect(fixture.barrier.wait_for_current(["one"], { timeout_ms: 60_001 })).rejects.toThrow("engine:freshness_timeout_invalid");
  });

  it("returns an atomic all-workspace lease/binding result", async () => {
    const clock = new ManualClock();
    const fixture = freshnessFixture(clock, new Map([
      ["one", target("one", "watermark:1")],
      ["two", target("two", "watermark:2")],
    ]));
    fixture.checkpoints.set("one", checkpoint("one", "watermark:1"));
    fixture.checkpoints.set("two", checkpoint("two", "watermark:2"));

    await expect(fixture.barrier.wait_for_current(["one", "two"], { timeout_ms: 0 })).resolves.toMatchObject([
      { workspace_id: "one", retention_lease_id: "lease:one" },
      { workspace_id: "two", retention_lease_id: "lease:two" },
    ]);
  });

  it("rejects a partial multi-workspace lease result instead of exposing a partial comparison", async () => {
    const clock = new ManualClock();
    const fixture = freshnessFixture(clock, new Map([
      ["one", target("one", "watermark:1")],
      ["two", target("two", "watermark:2")],
    ]));
    fixture.checkpoints.set("one", checkpoint("one", "watermark:1"));
    fixture.checkpoints.set("two", checkpoint("two", "watermark:2"));
    fixture.makePartial();

    await expect(fixture.barrier.wait_for_current(["one", "two"], { timeout_ms: 0 })).rejects.toThrow("engine:freshness_atomic_binding_failed");
  });

  it("starts the deadline at wait entry and cancels a hung target capture", async () => {
    const clock = new ManualClock();
    const capture = deferred<readonly FreshnessWorkspaceTarget[]>();
    const contexts: FreshnessOperationContext[] = [];
    const port: FreshnessBarrierPort = {
      validate_workspaces: async (_workspaceIds, context) => { contexts.push(context); },
      capture_targets: async (_workspaceIds, context) => {
        contexts.push(context);
        return capture.promise;
      },
      equivalent_checkpoint: async () => undefined,
      acquire_bindings_atomically: async () => [],
      release_bindings: async () => undefined,
    };
    const barrier = new FreshnessBarrier({ clock, port });
    let rejected = false;
    const waiting = barrier.wait_for_current(["one"], { timeout_ms: 10 });
    void waiting.catch(() => { rejected = true; });
    await flushMicrotasks();
    clock.advance(10);
    await flushMicrotasks();

    expect(rejected).toBe(true);
    expect(contexts).toHaveLength(2);
    expect(contexts.every((context) => context.deadline_ms === 10 && context.is_cancelled())).toBe(true);
    capture.resolve([target("one", "watermark:1")]);
    await expect(waiting).rejects.toThrow("core:freshness_wait_timeout");
  });

  it("rolls back leases returned after timeout instead of leaking a late atomic acquisition", async () => {
    const clock = new ManualClock();
    const acquire = deferred<readonly FreshnessSnapshotBinding[]>();
    const released: FreshnessSnapshotBinding[][] = [];
    const contexts: FreshnessOperationContext[] = [];
    const readyCheckpoint = checkpoint("one", "watermark:1");
    const port: FreshnessBarrierPort = {
      validate_workspaces: async () => undefined,
      capture_targets: async () => [target("one", "watermark:1")],
      equivalent_checkpoint: async (_workspaceId, context) => {
        contexts.push(context);
        return readyCheckpoint;
      },
      acquire_bindings_atomically: async (_requests, context) => {
        contexts.push(context);
        return acquire.promise;
      },
      release_bindings: async (bindings, context) => {
        contexts.push(context);
        released.push([...bindings]);
      },
    };
    const barrier = new FreshnessBarrier({ clock, port });
    let rejected = false;
    const waiting = barrier.wait_for_current(["one"], { timeout_ms: 10 });
    void waiting.catch(() => { rejected = true; });
    await flushMicrotasks();
    clock.advance(10);
    await flushMicrotasks();
    acquire.resolve([binding("one", readyCheckpoint.freshness_checkpoint_id)]);
    await flushMicrotasks();

    expect(rejected).toBe(true);
    expect(released).toEqual([[binding("one", readyCheckpoint.freshness_checkpoint_id)]]);
    expect(contexts.every((context) => context.deadline_ms === 10 && context.is_cancelled())).toBe(true);
    await expect(waiting).rejects.toThrow("core:freshness_wait_timeout");
  });
});
