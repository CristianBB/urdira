/**
 * Maps `items` through `fn` with at most `limit` calls in flight at once,
 * returning results in the SAME order as `items` (index-preserving), not the
 * order in which individual `fn` calls settle. No external dependencies: a
 * fixed pool of `limit` "worker" loops each pull the next unclaimed index
 * (`cursor++`) and write directly into `results[index]`; since JavaScript is
 * single-threaded, the `cursor++`/array-write sequence for one item never
 * interleaves with another, so this is safe without any extra locking.
 *
 * `fn` itself should not throw when a caller needs deterministic "process in
 * order, stop at the first failure" semantics under this bounded prefetch:
 * because every item is attempted (concurrency only bounds how many run at
 * once, not which ones run), a rejection from a later-index item can settle
 * before an earlier-index item's rejection. Callers that need sequential
 * first-failure semantics (see `source-indexer.ts#readAll`) should catch
 * inside `fn`, tag the outcome, and resolve the first-in-order failure
 * themselves from the ordered result array; `mapWithConcurrency` itself just
 * propagates a thrown `fn` via the usual `Promise.all` semantics (rejects
 * with whichever rejection is observed first, not necessarily index 0's).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: boundedLimit }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
