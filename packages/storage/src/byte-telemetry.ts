export type ByteBoundary = "provider" | "cas" | "analyzer" | "sqlite" | "ipc";

export interface ByteTelemetrySnapshot {
  readonly read: number;
  readonly transferred: number;
  readonly copied: number;
  readonly decoded: number;
  readonly retained: number;
  /** Digest/index counters required for v3 performance diagnosis. */
  readonly bytes_hashed: number;
  readonly leaves_modified: number;
  readonly nodes_recalculated: number;
  readonly collections_ordered: number;
  readonly corpus_rereads: number;
}

/** Small allocation-free counters used by acceptance tests and diagnostics. */
export class ByteBoundaryTelemetry {
  private readonly counters = new Map<ByteBoundary, ByteTelemetrySnapshot>();
  add(boundary: ByteBoundary, values: Partial<ByteTelemetrySnapshot>): void {
    const previous = this.counters.get(boundary) ?? { read: 0, transferred: 0, copied: 0, decoded: 0, retained: 0, bytes_hashed: 0, leaves_modified: 0, nodes_recalculated: 0, collections_ordered: 0, corpus_rereads: 0 };
    this.counters.set(boundary, {
      read: previous.read + (values.read ?? 0), transferred: previous.transferred + (values.transferred ?? 0), copied: previous.copied + (values.copied ?? 0), decoded: previous.decoded + (values.decoded ?? 0), retained: previous.retained + (values.retained ?? 0), bytes_hashed: previous.bytes_hashed + (values.bytes_hashed ?? 0), leaves_modified: previous.leaves_modified + (values.leaves_modified ?? 0), nodes_recalculated: previous.nodes_recalculated + (values.nodes_recalculated ?? 0), collections_ordered: previous.collections_ordered + (values.collections_ordered ?? 0), corpus_rereads: previous.corpus_rereads + (values.corpus_rereads ?? 0),
    });
  }
  snapshot(): Readonly<Record<ByteBoundary, ByteTelemetrySnapshot>> {
    return Object.fromEntries([...this.counters.entries()].map(([key, value]) => [key, { ...value }])) as Readonly<Record<ByteBoundary, ByteTelemetrySnapshot>>;
  }
  assertNoUndeclaredCopies(): void {
    for (const [boundary, value] of this.counters) if (value.copied < 0 || value.copied > value.read + value.transferred) throw new Error(`Undeclared byte copy at ${boundary}.`);
  }
}
