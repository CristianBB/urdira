import {
  type ScanRoots,
  type ScanTimings,
  type WorkspaceScanQueryable,
  type WorkspaceScanRequest,
  type WorkspaceScanUpgradeCompleted,
  validateWorkspaceScanRequest,
} from "./rust-indexing-core-port.js";

export type {
  ChangedPath,
  ChangedPathKind,
  ScanPriority,
  ScanRoots,
  ScanScope,
  ScanTimings,
  WorkspaceScanQueryable,
  WorkspaceScanRequest,
  WorkspaceScanResult,
  WorkspaceScanUpgradeCompleted,
} from "./rust-indexing-core-port.js";

/**
 * Structural shape of the one transport method this module needs
 * (`IndexingCoreProcessTransport.workspaceScan`,
 * `packages/plugin-javascript-typescript/src/indexing-core-process-transport.ts`).
 * Declared locally (rather than importing that plugin-layer type) so the
 * engine package does not depend on the plugin package -- any object with a
 * structurally compatible `workspaceScan` method (the real process
 * transport, or a test double) satisfies this.
 */
export interface RustWorkspaceScanTransport {
  workspaceScan(
    request: WorkspaceScanRequest,
    onQueryable?: (event: { readonly generation: number; readonly manifest_path: string; readonly timings: ScanTimings }) => void,
  ): Promise<
    | { readonly kind: "scan_completed"; readonly request_id: string; readonly generation: number; readonly snapshot_id: string; readonly roots: ScanRoots; readonly timings: ScanTimings }
    | { readonly kind: "error"; readonly code: string; readonly message: string }
    | { readonly kind: string }
  >;
  /**
   * P1-D-c: structural mirror of `IndexingCoreProcessTransport.
   * onUpgradeCompleted` -- optional (not every transport/test double this
   * engine layer is handed implements it), checked with `?.` by
   * `onRustWorkspaceUpgradeCompleted` below rather than assumed present.
   * Unlike `workspaceScan`'s own `onQueryable`, a handler registered here is
   * NOT scoped to one call: it fires for every workspace's residual pass,
   * for as long as this handler stays subscribed.
   */
  onUpgradeCompleted?(
    handler: (event: {
      readonly request_id: string;
      readonly generation: number;
      readonly upgraded_sites: number;
      readonly external_sites: number;
      readonly unresolved_sites: number;
      readonly timings: ScanTimings;
      readonly truncated?: boolean;
      readonly windows_done?: number;
      readonly windows_total?: number;
    }) => void,
  ): () => void;
}

type ScanCompletedEvent = Extract<Awaited<ReturnType<RustWorkspaceScanTransport["workspaceScan"]>>, { readonly kind: "scan_completed" }>;
type ScanErrorEvent = Extract<Awaited<ReturnType<RustWorkspaceScanTransport["workspaceScan"]>>, { readonly kind: "error" }>;

export interface RustWorkspaceScanOutcome {
  /**
   * P1-D-c: the `request_id` this call's `workspace_scan` command carried
   * (the transport mints it internally; this is just an echo of the
   * terminal event's own field). A caller that also wants to observe this
   * SAME request's eventual `upgrade_completed` event (via
   * `onRustWorkspaceUpgradeCompleted` below) needs this to correlate the
   * two, since `upgrade_completed` carries no `workspace_id` of its own --
   * see that function's doc comment.
   */
  readonly request_id: string;
  readonly generation: number;
  readonly snapshot_id: string;
  readonly roots: ScanRoots;
  /** `undefined` if the worker never emitted `queryable` before `scan_completed`
   * (should not happen in practice, but the caller should not crash on it). */
  readonly queryable_at_ms: number | undefined;
  readonly completed_at_ms: number;
  /** The `scan_completed` event's own timings (the fullest breakdown;
   * `queryable`'s timings are a strict prefix of these phases). */
  readonly timings: ScanTimings;
  /** Set only if a `queryable` event was observed before `scan_completed`. */
  readonly queryable: WorkspaceScanQueryable | undefined;
}

/**
 * Sends one `workspace_scan` command to the Rust composition worker (plan
 * `resilient-knitting-twilight.md` §6.1, task P2-2b) and resolves once the
 * terminal `scan_completed` event arrives, having also recorded the
 * intermediate `queryable` milestone (if the worker reached it) with a
 * wall-clock timestamp relative to when this function was called -- the
 * harness/daemon readiness surface wants both
 * `structural_queryable_ms`/`structural_durable_ms` (plan §2.6), and this is
 * the one place both are observable together for a single scan.
 *
 * `onQueryable` (P3-5, plan §6.1's readiness-latency item), when given, is
 * invoked SYNCHRONOUSLY and LIVE -- at the moment the underlying transport's
 * own `queryable` callback fires, before this function's own promise
 * resolves -- so a caller that wants to flip a workspace's readiness the
 * instant data is queryable (rather than waiting for the whole scan,
 * `ScanCompleted` included, to settle) has a real hook to do so. This does
 * not change what this function itself returns (`queryable`/`queryable_at_ms`
 * on the resolved `RustWorkspaceScanOutcome` are unchanged, still populated
 * from the same event) -- it is purely an additional, earlier notification.
 */
export async function runRustWorkspaceScan(
  transport: RustWorkspaceScanTransport,
  request: WorkspaceScanRequest,
  onQueryable?: (event: WorkspaceScanQueryable & { readonly at_ms: number }) => void,
): Promise<RustWorkspaceScanOutcome> {
  validateWorkspaceScanRequest(request);
  const startedAt = Date.now();
  let queryable: WorkspaceScanQueryable | undefined;
  let queryableAtMs: number | undefined;
  const event = await transport.workspaceScan(request, (queryableEvent) => {
    queryableAtMs = Date.now() - startedAt;
    queryable = {
      generation: queryableEvent.generation,
      manifest_path: queryableEvent.manifest_path,
      timings: queryableEvent.timings,
    };
    onQueryable?.({ ...queryable, at_ms: queryableAtMs });
  });
  const completedAtMs = Date.now() - startedAt;
  if (event.kind === "error") {
    const failure = event as ScanErrorEvent;
    throw new Error(`Rust workspace scan failed (${failure.code}): ${failure.message}`);
  }
  if (event.kind !== "scan_completed") {
    throw new Error(`Rust workspace scan returned an unexpected terminal event: ${event.kind}`);
  }
  const completed = event as ScanCompletedEvent;
  return {
    request_id: completed.request_id,
    generation: completed.generation,
    snapshot_id: completed.snapshot_id,
    roots: completed.roots,
    queryable_at_ms: queryableAtMs,
    completed_at_ms: completedAtMs,
    timings: completed.timings,
    queryable,
  };
}

/**
 * Subscribes to every `upgrade_completed` event `transport` ever emits (any
 * workspace, any `workspace_scan` request, however long ago it settled --
 * see `RustWorkspaceScanTransport.onUpgradeCompleted`'s own doc comment).
 * `handler` receives `request_id` alongside the payload so the caller can
 * correlate it back to the workspace that request originally scanned (this
 * engine layer keeps no such mapping itself). Returns an unsubscribe
 * function; a no-op unsubscribe when `transport` does not implement
 * `onUpgradeCompleted` at all (an older transport or a narrow test double),
 * so callers never need an existence check of their own before using the
 * returned function.
 */
export function onRustWorkspaceUpgradeCompleted(
  transport: RustWorkspaceScanTransport,
  handler: (event: WorkspaceScanUpgradeCompleted & { readonly request_id: string }) => void,
): () => void {
  if (transport.onUpgradeCompleted === undefined) return () => {};
  return transport.onUpgradeCompleted((event) => {
    handler({
      request_id: event.request_id,
      generation: event.generation,
      upgraded_sites: event.upgraded_sites,
      external_sites: event.external_sites,
      unresolved_sites: event.unresolved_sites,
      timings: event.timings,
      // `exactOptionalPropertyTypes`: omit the key entirely rather than
      // assigning `undefined` to it -- a sender that predates F4 4.2's
      // truncation fields never sets these, and `WorkspaceScanUpgradeCompleted`'s
      // own optional fields (`truncated?`/`windows_done?`/`windows_total?`)
      // mean "absent", not "present with value undefined".
      ...(event.truncated !== undefined ? { truncated: event.truncated } : {}),
      ...(event.windows_done !== undefined ? { windows_done: event.windows_done } : {}),
      ...(event.windows_total !== undefined ? { windows_total: event.windows_total } : {}),
    });
  });
}
