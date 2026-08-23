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
    const entry = buckets.get(bucket) ?? { ms: 0, count: 0 };
    entry.ms += performance.now() - startedAt;
    entry.count += 1;
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
    const entry = buckets.get(bucket) ?? { ms: 0, count: 0 };
    entry.ms += performance.now() - startedAt;
    entry.count += 1;
    buckets.set(bucket, entry);
  }
}

export function snapshotTimings(): Record<string, { readonly ms: number; readonly count: number }> {
  return Object.fromEntries([...buckets.entries()].map(([key, value]) => [key, { ms: Math.round(value.ms), count: value.count }]));
}

export function resetTimings(): void {
  buckets.clear();
}
