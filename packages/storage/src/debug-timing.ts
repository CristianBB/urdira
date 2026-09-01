/**
 * Opt-in, near-zero-overhead wall-clock instrumentation for the storage
 * package's write-path hotspots (CAS blob writes, installation-catalog CAS
 * metadata, source cataloging, candidate publication). Disabled by default;
 * enabled by setting `URDIRA_STORAGE_DEBUG_TIMING=1`, in which case
 * `[urdira] storage timings ...` lines are emitted to stderr from the call
 * sites that consume `snapshotTimings`/`resetTimings` (see
 * `packages/storage/src/source-index.ts` and `packages/storage/src/storage.ts`).
 *
 * This exists to attribute wall time within a scan's `source_catalog` and
 * `publish` stages (already timed at the stage level by
 * `packages/engine/src/workspace-indexing-session.ts`) to specific
 * sub-operations -- per-blob filesystem fsyncs, installation-catalog
 * metadata commits, and SQLite transaction wall time -- without adding any
 * dependency or changing behavior when the flag is unset.
 */

interface Bucket {
  ms: number;
  count: number;
  samples: number[];
}

const buckets = new Map<string, Bucket>();

export function timingEnabled(): boolean {
  // Read the flag at call time rather than module load time. The composed CLI
  // parses --debug-timing before creating a daemon/runtime, while this module
  // can already have been imported by the application entrypoint.
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

/** Synchronous counterpart of {@link timed} for builders with no await points. */
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
 * cross an await boundary `timed`/`timedSync` can't wrap directly -- e.g.
 * time spent queued before a callback starts running -- the caller takes
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
}
