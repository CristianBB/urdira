/**
 * Local, minimal counterpart to `@urdira/storage`'s
 * `packages/storage/src/debug-timing.ts` (same shape, same
 * `URDIRA_STORAGE_DEBUG_TIMING=1` gate), not imported from it -- `debug-timing.ts`
 * is not part of `@urdira/storage`'s `exports` map (only `.` is), so there is
 * no clean import path into it from `@urdira/engine` even though engine is a
 * higher architecture layer that may otherwise depend on storage
 * (`architecture/manifest.json`). `packages/daemon/src/runtime.ts` carries the
 * same local counterpart for the identical reason (see its
 * `readinessTimingEnabled` comment).
 *
 * Exists to attribute wall time spent inside `GenericSourceIndexer.apply`
 * (`packages/engine/src/source-indexer.ts`) that is NOT already inside one of
 * `@urdira/storage`'s own `commitInternal` buckets (CAS put loop, SQL,
 * metadata, directory fsync) -- specifically the provider read round-trip
 * per observation, per-batch digest verification, and per-fragment row/stream
 * assembly -- so a `URDIRA_STORAGE_DEBUG_TIMING=1` run's storage timing lines
 * and these engine timing lines can be summed against the `source_catalog`
 * stage total logged by `workspace-indexing-session.ts` to find any remaining
 * unattributed time.
 */

interface Bucket {
  ms: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

export function timingEnabled(): boolean {
  // Read the flag at call time, matching storage's debug-timing.ts: the
  // composed CLI parses --debug-timing before creating a daemon/runtime,
  // while this module can already have been imported by the entrypoint.
  return process.env["URDIRA_STORAGE_DEBUG_TIMING"] === "1";
}

/** Times `action` under `bucket` when instrumentation is enabled; otherwise runs it unmeasured. */
export async function timed<T>(bucket: string, action: () => Promise<T>): Promise<T> {
  if (!timingEnabled()) return action();
  const startedAt = performance.now();
  try {
    return await action();
  } finally {
    const entry = buckets.get(bucket) ?? { ms: 0, count: 0 };
    entry.ms += performance.now() - startedAt;
    entry.count += 1;
    buckets.set(bucket, entry);
  }
}

/** Synchronous counterpart of {@link timed} for call sites with no await points. */
export function timedSync<T>(bucket: string, action: () => T): T {
  if (!timingEnabled()) return action();
  const startedAt = performance.now();
  try {
    return action();
  } finally {
    const entry = buckets.get(bucket) ?? { ms: 0, count: 0 };
    entry.ms += performance.now() - startedAt;
    entry.count += 1;
    buckets.set(bucket, entry);
  }
}

/**
 * Adds an already-measured duration (in ms) to `bucket`. For spans that
 * cross an await boundary `timed`/`timedSync` can't wrap directly -- e.g. a
 * handoff between two independently-invoked callbacks -- the caller takes
 * its own `performance.now()` reading at each end of the span (itself
 * gated on {@link timingEnabled} so it costs nothing when the flag is off)
 * and reports the difference here.
 */
export function record(bucket: string, ms: number): void {
  if (!timingEnabled()) return;
  const entry = buckets.get(bucket) ?? { ms: 0, count: 0 };
  entry.ms += ms;
  entry.count += 1;
  buckets.set(bucket, entry);
}

export function snapshotTimings(): Record<string, { readonly ms: number; readonly count: number }> {
  return Object.fromEntries([...buckets.entries()].map(([key, value]) => [key, { ms: Math.round(value.ms), count: value.count }]));
}

export function resetTimings(): void {
  buckets.clear();
}
