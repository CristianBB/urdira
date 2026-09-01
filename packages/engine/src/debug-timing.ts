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
 * metadata, directory fsync) -- specifically the native-batch iterator wait,
 * per-batch digest verification, the prior-frontier occurrence/absence
 * queries, the aggregate per-batch read (`readAll`) and its per-observation
 * provider round-trip, per-fragment row/stream assembly, and the Rust-owned
 * capture's CAS write (`prepare_content_blobs`, which -- unlike the legacy
 * `commitInternal` path -- never runs through `@urdira/storage`'s own timing)
 * -- so a `URDIRA_STORAGE_DEBUG_TIMING=1` run's storage timing lines and
 * these engine timing lines can be summed against the `source_catalog` stage
 * total logged by `workspace-indexing-session.ts` to find any remaining
 * unattributed time. `count()`/`snapshotCounters()` track the same run's
 * observation/equivalent/CAS-blob/CAS-byte volumes so the aggregate log line
 * carries both cost and volume.
 */

interface Bucket {
  ms: number;
  count: number;
  samples: number[];
}

const buckets = new Map<string, Bucket>();

// Simple named counters (observation/blob/byte totals) alongside the timing
// buckets above -- reported next to them in the same aggregate log line so a
// `source_catalog` run's wall time and its volume can be read together
// without a second instrumentation mechanism.
const counters = new Map<string, number>();

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
    const elapsed = performance.now() - startedAt;
    const entry = buckets.get(bucket) ?? { ms: 0, count: 0, samples: [] };
    entry.ms += elapsed;
    entry.count += 1;
    entry.samples.push(elapsed);
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
    const elapsed = performance.now() - startedAt;
    const entry = buckets.get(bucket) ?? { ms: 0, count: 0, samples: [] };
    entry.ms += elapsed;
    entry.count += 1;
    entry.samples.push(elapsed);
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
  const entry = buckets.get(bucket) ?? { ms: 0, count: 0, samples: [] };
  entry.ms += ms;
  entry.count += 1;
  entry.samples.push(ms);
  buckets.set(bucket, entry);
}

/** Adds `amount` to a named counter when instrumentation is enabled; a no-op otherwise. */
export function count(name: string, amount = 1): void {
  if (!timingEnabled()) return;
  counters.set(name, (counters.get(name) ?? 0) + amount);
}

export function snapshotCounters(): Record<string, number> {
  return Object.fromEntries(counters.entries());
}

function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)]!;
}

export function snapshotTimings(): Record<string, { readonly ms: number; readonly count: number; readonly p50_ms: number; readonly p95_ms: number; readonly p99_ms: number }> {
  return Object.fromEntries([...buckets.entries()].map(([key, value]) => [key, {
    ms: Math.round(value.ms),
    count: value.count,
    p50_ms: Math.round(percentile(value.samples, 0.50)),
    p95_ms: Math.round(percentile(value.samples, 0.95)),
    p99_ms: Math.round(percentile(value.samples, 0.99)),
  }]));
}

export function resetTimings(): void {
  buckets.clear();
  counters.clear();
}
