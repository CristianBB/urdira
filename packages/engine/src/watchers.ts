import * as parcelWatcher from "@parcel/watcher";
import { EngineError } from "./errors.js";

export type WatcherEventClass =
  | "presence"
  | "modify"
  | "absence"
  | "exclusion"
  | "overflow"
  | "provider_reset"
  | "administrative"
  | "git_head"
  | "git_index"
  | "worktree_administration"
  | "provider_root_transition";

export interface WatcherBinding {
  readonly workspace_id: string;
  readonly source_provider_binding_id: string;
  readonly source_provider: string;
  readonly source_provider_version: string;
  readonly ordering_domain: string;
  readonly root: string;
  readonly case_sensitive?: boolean;
  readonly mutable_watched?: boolean;
}

export interface PhysicalWatcherEvent {
  readonly type: "create" | "update" | "delete";
  readonly path: string;
}

export interface WatcherHint {
  readonly workspace_id: string;
  readonly source_provider_binding_id: string;
  readonly source_provider: string;
  readonly source_provider_version: string;
  readonly ordering_domain: string;
  readonly provider_sequence: string;
  readonly event_class: WatcherEventClass;
  readonly normalized_uri: string;
  readonly authority: "hint";
}

export interface WatcherHintBatch {
  readonly workspace_id: string;
  readonly source_provider_binding_id: string;
  readonly source_provider: string;
  readonly source_provider_version: string;
  readonly ordering_domain: string;
  readonly events: readonly WatcherHint[];
  readonly watermark: string;
}

export type WatcherBatchHandler = (batch: WatcherHintBatch) => void | Promise<void>;

export interface WatcherSubscription {
  unsubscribe(): Promise<void>;
}

export interface WorkspaceWatcherBinding {
  readonly workspace_id: string;
  readonly watcher: { subscribe(handler: WatcherBatchHandler): Promise<WatcherSubscription> };
}

export type WatcherReconcileReason = "branch_changed" | "events_lost" | "provider_reset" | "changed";

export interface WorkspaceWatcherManagerOptions {
  readonly on_batch?: WatcherBatchHandler;
  /**
   * Invoked for every delivered batch, not only the ones that force a full
   * reconcile: `changedUris` carries the batch's normalized URIs (Phase 5's
   * "changed-path plumbing") when the batch is safe to interpret narrowly, or
   * is `undefined` when it is not (an `overflow`/`provider_reset`/git/worktree
   * event, where the set of actually-changed files is not knowable from the
   * event stream itself). A caller MAY use `changedUris` to narrow later
   * analysis, but stage-1 source cataloging always re-enumerates the whole
   * workspace regardless (`runFullWorkspaceScan`'s planner diff remains the
   * correctness anchor) -- `changedUris` is advisory only.
   */
  readonly on_reconcile?: (workspaceId: string, changedUris: readonly string[] | undefined, reason: WatcherReconcileReason) => void | Promise<void>;
  readonly on_configuration_change?: (workspaceId: string) => void | Promise<void>;
}

/** Owns one serialized watcher stream per workspace and widens unsafe events to a full reconcile. */
export class WorkspaceWatcherManager {
  private readonly subscriptions = new Map<string, WatcherSubscription>();
  private readonly deliveries = new Map<string, Promise<void>>();
  constructor(private readonly options: WorkspaceWatcherManagerOptions = {}) {}

  async start(binding: WorkspaceWatcherBinding): Promise<void> {
    if (this.subscriptions.has(binding.workspace_id)) return;
    // Install the queue before subscribing: a provider is allowed to emit a
    // buffered batch synchronously during subscribe().
    this.deliveries.set(binding.workspace_id, Promise.resolve());
    const subscription = await binding.watcher.subscribe((batch) => {
      const previous = this.deliveries.get(binding.workspace_id) ?? Promise.resolve();
      const delivery = previous.then(async () => {
        await this.options.on_batch?.(batch);
        if (batch.events.some((event) => event.normalized_uri === ".urdira/config.json")) await this.options.on_configuration_change?.(binding.workspace_id);
        const unsafeReason: WatcherReconcileReason | undefined = batch.events.some((event) => event.event_class === "git_head" || event.event_class === "git_index" || event.event_class === "worktree_administration")
          ? "branch_changed"
          : batch.events.some((event) => event.event_class === "overflow")
            ? "events_lost"
            : batch.events.some((event) => event.event_class === "provider_reset" || event.event_class === "provider_root_transition")
              ? "provider_reset"
              : undefined;
        if (unsafeReason !== undefined) {
          // A widen-to-full-reconcile event: the set of actually-changed
          // files is not derivable from the event stream itself (branch
          // switches and lost/overflowed events can touch anything), so no
          // changed-URI hint is passed -- `undefined` means "full rescan".
          await this.options.on_reconcile?.(binding.workspace_id, undefined, unsafeReason);
        } else {
          // An ordinary presence/modify/absence/exclusion batch: every real
          // filesystem change must still reach a reconcile (previously only
          // the unsafe reasons above ever did, so plain edits were silently
          // never rescanned), but the batch's own normalized URIs are known
          // and safe to carry forward as an advisory hint. `.git/**` paths
          // are dropped here regardless of `binding.source_provider`: every
          // `inclusion_rules` configuration in this codebase excludes
          // `.git/**` from scanning unconditionally
          // (`packages/daemon/src/runtime.ts`, `workspace-fork.ts`'s
          // `DEFAULT_FORK_INCLUSION`), so a reconcile whose only changed
          // paths are under `.git/` is *guaranteed* to be a no-op ("equivalent")
          // scan -- and for a plain `core:directory_source_provider` binding
          // (this codebase's actual production and fork-scan binding; the
          // `git_head`/`git_index`/`worktree_administration` special-casing
          // just above only ever fires for `core:git_worktree_source_provider`)
          // nothing upstream of here filters `.git/**` out at all. A real,
          // reproduced incident: `git worktree add`'s own lock-file churn
          // (`.git/packed-refs.lock`, `.git/worktrees/<name>/locked`, created
          // and removed within the same git operation) reliably arrives as a
          // trailing filesystem event shortly after a donor workspace's watch
          // subscription starts, triggering a coalesced rescan that flips the
          // donor back to `"indexing"` in the registry (`beginReconciliation`
          // is called eagerly at resubmission time, before the rescan itself
          // has a turn in the scheduler's structural pool) for however long
          // that rescan waits queued behind unrelated work -- observed racing
          // a workspace fork's own donor-matching read of the registry in
          // `tests/phase-workspace-fork.test.ts`, occasionally causing a
          // content-identical donor to be seen as transiently unready and the
          // fork to fall back to a full scan for no real reason. Excluding
          // `.git/**` here (not just deprioritizing it) avoids the wasted
          // scan and the false "indexing" flicker without touching the
          // deliberate branch-switch-detection semantics of the unsafe path
          // above, which this change does not alter.
          const changedUris = [...new Set(batch.events.map((event) => event.normalized_uri).filter((uri) => uri.length > 0 && uri !== ".git" && !uri.startsWith(".git/")))];
          if (changedUris.length > 0) await this.options.on_reconcile?.(binding.workspace_id, changedUris, "changed");
        }
      });
      this.deliveries.set(binding.workspace_id, delivery.catch(() => undefined));
    });
    this.subscriptions.set(binding.workspace_id, subscription);
  }

  async stop(workspaceId: string): Promise<void> {
    await this.deliveries.get(workspaceId);
    await this.subscriptions.get(workspaceId)?.unsubscribe();
    this.subscriptions.delete(workspaceId);
    this.deliveries.delete(workspaceId);
  }

  async stopAll(): Promise<void> {
    for (const workspaceId of [...this.subscriptions.keys()]) await this.stop(workspaceId);
  }

  async restore(bindings: ReadonlyArray<WorkspaceWatcherBinding>): Promise<void> {
    for (const binding of bindings) await this.start(binding);
  }

  async idle(): Promise<void> {
    await Promise.all([...this.deliveries.values()]);
  }
}

export interface ParcelWatcherBackend {
  subscribe(
    root: string,
    callback: (error: Error | null, events: readonly PhysicalWatcherEvent[]) => unknown,
    options?: parcelWatcher.Options,
  ): Promise<{ unsubscribe(): Promise<void> }>;
}

export interface ParcelWatcherAdapterOptions {
  readonly backend?: ParcelWatcherBackend;
  readonly watcher_options?: parcelWatcher.Options;
  readonly on_error?: (error: Error) => void;
}

function slashPath(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/\/{2,}/gu, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
}

function normalizedUri(root: string, path: string, caseSensitive: boolean): string {
  const normalizedRoot = slashPath(root);
  const normalizedPath = slashPath(path);
  const comparedRoot = caseSensitive ? normalizedRoot : normalizedRoot.toLocaleLowerCase("en-US");
  const comparedPath = caseSensitive ? normalizedPath : normalizedPath.toLocaleLowerCase("en-US");
  if (comparedPath !== comparedRoot && !comparedPath.startsWith(`${comparedRoot}/`)) {
    throw new EngineError("engine:watcher_path_outside_root", `Watcher path ${path} is outside its provider root.`);
  }
  const uri = normalizedPath.slice(normalizedRoot.length).replace(/^\/+|\/+$/gu, "");
  if (uri.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new EngineError("engine:watcher_path_invalid", `Watcher path ${path} is not normalized.`);
  }
  return uri;
}

function eventClass(binding: WatcherBinding, type: PhysicalWatcherEvent["type"], uri: string): WatcherEventClass {
  if (uri.length === 0) return "provider_root_transition";
  if (binding.source_provider === "core:git_worktree_source_provider") {
    const compared = binding.case_sensitive === false ? uri.toLocaleLowerCase("en-US") : uri;
    if (compared === (binding.case_sensitive === false ? ".git/head" : ".git/HEAD")) return "git_head";
    if (compared === ".git/index") return "git_index";
    if (compared === ".git" || compared.startsWith(".git/")) return "worktree_administration";
  }
  if (type === "create") return "presence";
  if (type === "delete") return "absence";
  return "modify";
}

// A backend `subscribe` error's contract is silent on whether the
// subscription keeps delivering later events (`@parcel/watcher`'s own docs
// do not commit to either behavior) -- `#subscribe` (below) treats every
// error as fatal to that ONE underlying subscription and re-arms a fresh one
// immediately, rather than risk a silently-dead watcher for the rest of the
// process's life (a real incident: see `currentOccurrencesSlimAsOf`'s doc
// comment, `packages/storage/src/source-index.ts`). Bounded so a
// persistently-erroring root (deleted, permission-denied, ...) cannot spin
// the event loop in a tight re-subscribe loop forever; `DaemonRuntime`'s
// periodic reconciliation sweep (`packages/daemon/src/runtime.ts`) is the
// backstop once this gives up.
const MAX_CONSECUTIVE_REARM_ATTEMPTS = 5;

export class ParcelWatcherAdapter {
  readonly #binding: WatcherBinding;
  readonly #backend: ParcelWatcherBackend;
  readonly #watcherOptions: parcelWatcher.Options | undefined;
  readonly #onError: ((error: Error) => void) | undefined;
  #sequence = 0;
  #delivery: Promise<void> = Promise.resolve();

  constructor(binding: WatcherBinding, options: ParcelWatcherAdapterOptions = {}) {
    this.#binding = binding;
    this.#backend = options.backend ?? parcelWatcher;
    this.#watcherOptions = options.watcher_options;
    this.#onError = options.on_error;
  }

  normalize_events(events: readonly PhysicalWatcherEvent[]): WatcherHintBatch {
    const hints = events.map((event) => {
      const uri = normalizedUri(this.#binding.root, event.path, this.#binding.case_sensitive ?? process.platform !== "win32");
      return this.#hint(eventClass(this.#binding, event.type, uri), uri);
    });
    return this.#batch(hints);
  }

  async subscribe(handler: WatcherBatchHandler): Promise<WatcherSubscription> {
    let stopped = false;
    let active: { unsubscribe(): Promise<void> } | undefined;
    let consecutiveErrors = 0;
    const arm = async (): Promise<void> => {
      if (stopped) return;
      const subscription = await this.#backend.subscribe(this.#binding.root, (error, events) => {
        if (error) {
          consecutiveErrors += 1;
          // Unconditional and loud, independent of whether a caller wired
          // `on_error`: a watcher error that only reaches an optional,
          // easy-to-forget callback is exactly how a silently-dead watcher
          // goes unnoticed for a whole process's life. `on_error` (below)
          // remains the mechanism a caller uses to actually REACT (e.g. the
          // `provider_reset` hint delivery just below already does).
          console.error(`[urdira] watcher error for workspace ${this.#binding.workspace_id} root=${this.#binding.root} (attempt ${consecutiveErrors}/${MAX_CONSECUTIVE_REARM_ATTEMPTS}): ${error.message || String(error)}`);
          this.#onError?.(error);
          this.#deliver(handler, this.#batch([this.#hint("provider_reset", "")]));
          if (consecutiveErrors >= MAX_CONSECUTIVE_REARM_ATTEMPTS) {
            console.error(`[urdira] watcher for workspace ${this.#binding.workspace_id} root=${this.#binding.root} gave up re-arming after ${consecutiveErrors} consecutive errors; relying on the periodic reconciliation sweep instead.`);
            return;
          }
          // Treat the underlying subscription as dead and re-arm a fresh
          // one. If the backend keeps calling this SAME (stale) callback
          // after its own error, `arm()` below still installs a new
          // subscription and `active` moves on to it, so at worst the
          // process holds one extra (functionally idle) subscription until
          // it too errors or `unsubscribe()` tears everything down.
          void arm();
          return;
        }
        consecutiveErrors = 0;
        if (events.length > 0) this.#deliver(handler, this.normalize_events(events));
      }, this.#watcherOptions);
      if (stopped) { await subscription.unsubscribe().catch(() => undefined); return; }
      active = subscription;
    };
    await arm();
    return {
      unsubscribe: async () => {
        stopped = true;
        await active?.unsubscribe();
      },
    };
  }

  async idle(): Promise<void> { await this.#delivery; }

  #deliver(handler: WatcherBatchHandler, batch: WatcherHintBatch): void {
    this.#delivery = this.#delivery
      .then(async () => handler(batch))
      .catch((error: unknown) => { this.#onError?.(error instanceof Error ? error : new Error(String(error))); });
  }

  #hint(kind: WatcherEventClass, uri: string): WatcherHint {
    return {
      workspace_id: this.#binding.workspace_id,
      source_provider_binding_id: this.#binding.source_provider_binding_id,
      source_provider: this.#binding.source_provider,
      source_provider_version: this.#binding.source_provider_version,
      ordering_domain: this.#binding.ordering_domain,
      provider_sequence: String(++this.#sequence),
      event_class: kind,
      normalized_uri: uri,
      authority: "hint",
    };
  }

  #batch(events: readonly WatcherHint[]): WatcherHintBatch {
    return {
      workspace_id: this.#binding.workspace_id,
      source_provider_binding_id: this.#binding.source_provider_binding_id,
      source_provider: this.#binding.source_provider,
      source_provider_version: this.#binding.source_provider_version,
      ordering_domain: this.#binding.ordering_domain,
      events,
      watermark: events.at(-1)?.provider_sequence ?? String(this.#sequence),
    };
  }
}

export class DeterministicFakeWatcher {
  readonly #binding: WatcherBinding;
  readonly #handlers = new Set<WatcherBatchHandler>();
  readonly #onError: ((error: Error) => void) | undefined;
  #sequence = 0;
  #delivery: Promise<void> = Promise.resolve();

  constructor(binding: WatcherBinding, options: { readonly on_error?: (error: Error) => void } = {}) {
    this.#binding = binding;
    this.#onError = options.on_error;
  }

  async subscribe(handler: WatcherBatchHandler): Promise<WatcherSubscription> {
    this.#handlers.add(handler);
    return { unsubscribe: async () => { this.#handlers.delete(handler); } };
  }

  emit(events: readonly { readonly event_class: WatcherEventClass; readonly normalized_uri: string }[]): WatcherHintBatch {
    const hints = events.map((event) => this.#hint(event.event_class, event.normalized_uri));
    const batch = this.#batch(hints);
    for (const handler of this.#handlers) {
      this.#delivery = this.#delivery
        .then(async () => handler(batch))
        .catch((error: unknown) => { this.#onError?.(error instanceof Error ? error : new Error(String(error))); });
    }
    return batch;
  }

  async idle(): Promise<void> { await this.#delivery; }

  modify(uri: string): WatcherHintBatch { return this.emit([{ event_class: "modify", normalized_uri: uri }]); }
  presence(uri: string): WatcherHintBatch { return this.emit([{ event_class: "presence", normalized_uri: uri }]); }
  absence(uri: string): WatcherHintBatch { return this.emit([{ event_class: "absence", normalized_uri: uri }]); }
  exclusion(uri: string): WatcherHintBatch { return this.emit([{ event_class: "exclusion", normalized_uri: uri }]); }
  duplicate(uri: string): WatcherHintBatch {
    return this.emit([
      { event_class: "modify", normalized_uri: uri },
      { event_class: "modify", normalized_uri: uri },
    ]);
  }
  reordered(uris: readonly string[]): WatcherHintBatch {
    return this.emit(uris.map((uri) => ({ event_class: "modify", normalized_uri: uri })));
  }
  overflow(): WatcherHintBatch { return this.emit([{ event_class: "overflow", normalized_uri: "" }]); }
  reset(): WatcherHintBatch { return this.emit([{ event_class: "provider_reset", normalized_uri: "" }]); }
  administrative_change(kind: "administrative" | "git_head" | "git_index" | "worktree_administration" | "provider_root_transition" = "administrative"): WatcherHintBatch {
    const paths: Record<typeof kind, string> = {
      administrative: ".git",
      git_head: ".git/HEAD",
      git_index: ".git/index",
      worktree_administration: ".git",
      provider_root_transition: "",
    };
    return this.emit([{ event_class: kind, normalized_uri: paths[kind] }]);
  }

  #hint(kind: WatcherEventClass, uri: string): WatcherHint {
    return {
      workspace_id: this.#binding.workspace_id,
      source_provider_binding_id: this.#binding.source_provider_binding_id,
      source_provider: this.#binding.source_provider,
      source_provider_version: this.#binding.source_provider_version,
      ordering_domain: this.#binding.ordering_domain,
      provider_sequence: String(++this.#sequence),
      event_class: kind,
      normalized_uri: uri,
      authority: "hint",
    };
  }

  #batch(events: readonly WatcherHint[]): WatcherHintBatch {
    return {
      workspace_id: this.#binding.workspace_id,
      source_provider_binding_id: this.#binding.source_provider_binding_id,
      source_provider: this.#binding.source_provider,
      source_provider_version: this.#binding.source_provider_version,
      ordering_domain: this.#binding.ordering_domain,
      events,
      watermark: events.at(-1)?.provider_sequence ?? String(this.#sequence),
    };
  }
}
