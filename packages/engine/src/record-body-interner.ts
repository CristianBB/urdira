/**
 * Cross-workspace `WeakRef` interner for decoded record `body` objects
 * (`SqliteCanonicalQuerySnapshotPort.decodeRow`, `./canonical-query-data-port.ts`).
 * Record ids are content-derived (decision 11 -- see
 * `packages/engine/src/workspace-fork.ts`'s own doc comments for the
 * "content-derived id => identical payload bytes" argument this relies on),
 * so two workspaces that happen to hold the SAME `record_id` (typically: a
 * forked workspace and its donor, or two forks of the same donor) are
 * guaranteed to have decoded the exact same `body` shape from the exact same
 * underlying bytes. Sharing ONE decoded object across every
 * `SqliteCanonicalQuerySnapshotPort` instance that encounters that
 * `record_id` collapses what would otherwise be N independent,
 * byte-for-byte-duplicate heap allocations (one per workspace's own
 * `recordsCache`) into one.
 *
 * Deliberately holds NO strong reference to anything it interns: the backing
 * map stores only `WeakRef`s, and a `FinalizationRegistry` deletes a map
 * entry once its referent is actually collected, so the map itself never
 * grows without bound just from workspaces coming and going. This makes the
 * interner a pure best-effort SHARING mechanism, never a cache with its own
 * retention policy -- whether a body stays alive at all is decided entirely
 * by whoever else holds a reference to it (a port's own `recordsCache`, an
 * in-flight query's already-returned records array, ...). That property is
 * exactly what lets the daemon's LRU byte budget (`evictWarmRecords()`,
 * `packages/daemon/src/runtime.ts`) actually free memory: dropping the last
 * strong reference to a body lets it (and, once its finalizer runs, its
 * interner entry) be collected regardless of whether the interner "knows"
 * an eviction happened.
 *
 * Not specific to record bodies in its implementation (arbitrary string
 * keys, arbitrary plain-object values) -- `SqliteCanonicalQuerySnapshotPort`
 * reuses this same instance under a second, derived key namespace to also
 * skip re-decoding a hit row's `facets` (see that file's `decodeRow`), since
 * `facets` is equally content-derived from the same payload bytes. The name
 * reflects this class's primary purpose per the pinned spec, not a hard
 * restriction on what it may key.
 */
export class RecordBodyInterner {
  private readonly entries = new Map<string, WeakRef<object>>();
  // The callback receives the exact `WeakRef` that was live when its target
  // was collected. `register` always cancels (`unregister`s) any prior
  // callback for the same key before installing a new one, but finalization
  // is asynchronous relative to that: this callback can still fire after a
  // NEWER value has already been registered under the same key, if the old
  // value's finalization was already scheduled before `unregister` ran.
  // Comparing `entries.get(key) === ref` before deleting ensures a stale
  // callback can only ever remove ITS OWN (still-current) entry, never a
  // fresher one that has since replaced it.
  private readonly finalization = new FinalizationRegistry<{ readonly key: string; readonly ref: WeakRef<object> }>(({ key, ref }) => {
    if (this.entries.get(key) === ref) this.entries.delete(key);
  });

  lookup(key: string): Readonly<Record<string, unknown>> | undefined {
    const ref = this.entries.get(key);
    if (ref === undefined) return undefined;
    const value = ref.deref();
    // The referent can already be gone even though the finalizer callback
    // above has not run yet (finalization timing is never synchronous with
    // collection) -- treat that exactly like "never registered" rather than
    // waiting for the callback to clean up first.
    if (value === undefined) { this.entries.delete(key); return undefined; }
    return value as Readonly<Record<string, unknown>>;
  }

  register(key: string, value: Readonly<Record<string, unknown>>): void {
    const existingRef = this.entries.get(key);
    if (existingRef !== undefined) this.finalization.unregister(existingRef);
    const ref = new WeakRef(value);
    this.entries.set(key, ref);
    this.finalization.register(value, { key, ref }, ref);
  }
}
