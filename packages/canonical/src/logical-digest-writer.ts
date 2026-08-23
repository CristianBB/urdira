import { createHash, type Hash } from "node:crypto";

export interface LogicalDigestMetrics {
  bytes_hashed: number;
  /** Input bytes observed by callers that stream source payloads into this writer. */
  bytes_ingested: number;
  fields_hashed: number;
  collections_hashed: number;
  collections_ordered: number;
  corpus_rereads: number;
}

/** Incremental digest writer for schema-bound logical fields (logical-digest.v3). */
export class LogicalDigestWriter {
  readonly #hash: Hash = createHash("sha256");
  readonly #encoder = new TextEncoder();
  #finished = false;
  #byteLength = 0;
  readonly metrics: LogicalDigestMetrics = { bytes_hashed: 0, bytes_ingested: 0, fields_hashed: 0, collections_hashed: 0, collections_ordered: 0, corpus_rereads: 0 };

  constructor(domain = "urdira:logical-digest:v3") { this.text(0, domain); }
  field(identifier: string, present: boolean, write: () => void): this { this.metrics.fields_hashed += 1; this.text(1, identifier); this.boolean(present); if (present) write(); return this; }
  null(): this { this.tag(3); return this; }
  boolean(value: boolean): this { this.tag(4); this.byte(value ? 1 : 0); return this; }
  integer(value: number | bigint): this { this.tag(5); this.text(0, typeof value === "bigint" ? value.toString(10) : String(value)); return this; }
  real(value: number): this { if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("Logical digest real values must be finite and not negative zero."); this.tag(6); const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, value, false); this.raw(bytes); return this; }
  text(_field: number, value: string): this { const bytes = this.#encoder.encode(value); this.tag(7); this.length(bytes.byteLength); this.raw(bytes); return this; }
  bytes(value: Uint8Array): this { this.tag(8); this.length(value.byteLength); this.raw(value); return this; }
  sequence(length: number): this { this.checkLength(length); this.metrics.collections_hashed += 1; this.tag(9); this.length(length); return this; }
  set(length: number): this { this.checkLength(length); this.metrics.collections_hashed += 1; this.tag(10); this.length(length); return this; }
  /** Writes a logical value directly to the hash; no encoded value is created. */
  value(value: unknown): this {
    if (value === null) return this.null();
    if (value instanceof Uint8Array) return this.bytes(value);
    if (typeof value === "boolean") return this.boolean(value);
    if (typeof value === "bigint") return this.integer(value);
    if (typeof value === "number") {
      if (Number.isSafeInteger(value)) return this.integer(value);
      return this.real(value);
    }
    if (typeof value === "string") return this.text(0, value);
    if (Array.isArray(value)) {
      this.sequence(value.length);
      for (const entry of value) this.value(entry);
      return this;
    }
    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      entries.sort(([left], [right]) => left.localeCompare(right));
      this.metrics.collections_ordered += 1;
      this.set(entries.length);
      for (const [key, entry] of entries) this.field(key, entry !== undefined, () => this.value(entry));
      return this;
    }
    throw new TypeError(`Unsupported logical digest value type: ${typeof value}`);
  }
  digest(): string { this.ensureOpen(); this.#finished = true; return `sha256:${this.#hash.digest("hex")}`; }
  byteLength(): number { return this.#byteLength; }
  private tag(value: number): this { this.ensureOpen(); this.byte(value); return this; }
  private byte(value: number): void { this.#hash.update(Uint8Array.of(value)); this.#byteLength += 1; }
  private length(value: number): void { let current = value; const bytes: number[] = []; do { bytes.push(current % 128); current = Math.floor(current / 128); } while (current > 0); for (let index = 0; index < bytes.length - 1; index += 1) bytes[index] = bytes[index]! | 0x80; this.raw(Uint8Array.from(bytes)); }
  private raw(value: Uint8Array): void { this.ensureOpen(); this.#hash.update(value); this.#byteLength += value.byteLength; this.metrics.bytes_hashed += value.byteLength; this.metrics.bytes_ingested += value.byteLength; }
  private checkLength(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Logical digest collection length is invalid."); }
  private ensureOpen(): void { if (this.#finished) throw new Error("LogicalDigestWriter has already been finalized."); }
}

/** Computes a v3 logical digest without producing a transport or persistence payload. */
export function digestLogicalValue(value: unknown, domain = "urdira:logical-value:v3"): string {
  return new LogicalDigestWriter(domain).value(value).digest();
}
