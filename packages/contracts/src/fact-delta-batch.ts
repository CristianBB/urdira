/**
 * Native analyzer/storage hand-off generated from the v2 Schema IR.
 * This is an in-process ownership contract, not a wire format or persisted value.
 */
export const FACT_DELTA_BATCH_PROTOCOL_VERSION = 2 as const;
export const FACT_DELTA_BATCH_SCHEMA_ID = "core:fact-delta-batch" as const;
export const FACT_DELTA_BATCH_MAX_BYTES = 4 * 1024 * 1024;
export const FACT_DELTA_BATCH_MAX_ROWS = 4096;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface Utf8Arena {
  readonly bytes: Uint8Array;
  readonly offsets: Uint32Array;
  readonly lengths: Uint32Array;
  /** Prefix offsets identifying the values belonging to each logical row. */
  readonly row_offsets: Uint32Array;
}
export interface FactDeltaColumnBatch {
  readonly row_count: number;
  readonly strings: Utf8Arena;
  readonly numbers: Float64Array;
  readonly number_row_offsets: Uint32Array;
  readonly ordinals: Uint32Array;
  readonly ordinal_row_offsets: Uint32Array;
  readonly enums: Uint16Array;
  readonly enum_row_offsets: Uint32Array;
  readonly presence: Uint8Array;
  readonly presence_row_offsets: Uint32Array;
}
export interface FactDeltaBatch {
  readonly protocol_version: typeof FACT_DELTA_BATCH_PROTOCOL_VERSION;
  readonly schema_id: typeof FACT_DELTA_BATCH_SCHEMA_ID;
  readonly sequence: number;
  readonly final: boolean;
  readonly byte_length: number;
  readonly records: FactDeltaColumnBatch;
  readonly graph_edges: FactDeltaColumnBatch;
  readonly identities: FactDeltaColumnBatch;
  readonly dependencies: FactDeltaColumnBatch;
}
export interface FactDeltaBatchRow { readonly strings?: readonly string[]; readonly numbers?: readonly number[]; readonly ordinals?: readonly number[]; readonly enums?: readonly number[]; readonly presence?: readonly boolean[]; }

export function buildFactDeltaBatch(input: { readonly sequence?: number; readonly final?: boolean; readonly records?: readonly FactDeltaBatchRow[]; readonly graph_edges?: readonly FactDeltaBatchRow[]; readonly identities?: readonly FactDeltaBatchRow[]; readonly dependencies?: readonly FactDeltaBatchRow[] }): FactDeltaBatch {
  const sequence = input.sequence ?? 0;
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError("FactDeltaBatch sequence must be a non-negative safe integer.");
  const sections = { records: columnBatch(input.records ?? []), graph_edges: columnBatch(input.graph_edges ?? []), identities: columnBatch(input.identities ?? []), dependencies: columnBatch(input.dependencies ?? []) };
  const byte_length = Object.values(sections).reduce((total, section) => total + batchBytes(section), 0);
  if (byte_length > FACT_DELTA_BATCH_MAX_BYTES) throw new RangeError(`FactDeltaBatch exceeds ${FACT_DELTA_BATCH_MAX_BYTES} bytes.`);
  return { protocol_version: FACT_DELTA_BATCH_PROTOCOL_VERSION, schema_id: FACT_DELTA_BATCH_SCHEMA_ID, sequence, final: input.final ?? true, byte_length, ...sections };
}

/** Validate views and ownership metadata without materialising row objects. */
export function validateFactDeltaBatch(batch: FactDeltaBatch, expectedSequence?: number): void {
  if (batch.protocol_version !== FACT_DELTA_BATCH_PROTOCOL_VERSION || batch.schema_id !== FACT_DELTA_BATCH_SCHEMA_ID) throw new RangeError("Unsupported FactDeltaBatch contract.");
  if (!Number.isSafeInteger(batch.sequence) || batch.sequence < 0 || (expectedSequence !== undefined && batch.sequence !== expectedSequence)) throw new RangeError("FactDeltaBatch sequence is invalid or out of order.");
  const sections = [batch.records, batch.graph_edges, batch.identities, batch.dependencies];
  const calculated = sections.reduce((total, section) => total + batchBytes(section), 0);
  if (batch.byte_length !== calculated || calculated > FACT_DELTA_BATCH_MAX_BYTES) throw new RangeError("FactDeltaBatch byte budget is inconsistent.");
  const buffers = factDeltaBatchTransferList(batch);
  if (buffers.length !== new Set(buffers).size) throw new RangeError("FactDeltaBatch arenas must not alias.");
  for (const section of sections) {
    if (!Number.isSafeInteger(section.row_count) || section.row_count < 0 || section.row_count > FACT_DELTA_BATCH_MAX_ROWS) throw new RangeError("FactDeltaBatch row count is outside its limit.");
    if (section.strings.offsets.length !== section.strings.lengths.length || section.strings.offsets.some((offset, index) => offset + section.strings.lengths[index]! > section.strings.bytes.byteLength)) throw new RangeError("FactDeltaBatch UTF-8 arena contains an out-of-bounds slice.");
    validateRowOffsets(section.row_count, section.strings.row_offsets, section.strings.offsets.length, "strings");
    validateRowOffsets(section.row_count, section.number_row_offsets, section.numbers.length, "numbers");
    validateRowOffsets(section.row_count, section.ordinal_row_offsets, section.ordinals.length, "ordinals");
    validateRowOffsets(section.row_count, section.enum_row_offsets, section.enums.length, "enums");
    validateRowOffsets(section.row_count, section.presence_row_offsets, section.presence.length, "presence");
    if (section.presence.some((value) => value !== 0 && value !== 1)) throw new RangeError("FactDeltaBatch presence flags must be 0 or 1.");
  }
}

export function factDeltaBatchTransferList(batch: FactDeltaBatch): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const section of [batch.records, batch.graph_edges, batch.identities, batch.dependencies]) {
    for (const view of [section.strings.bytes, section.strings.offsets, section.strings.lengths, section.strings.row_offsets, section.numbers, section.number_row_offsets, section.ordinals, section.ordinal_row_offsets, section.enums, section.enum_row_offsets, section.presence, section.presence_row_offsets]) {
      if (!(view.buffer instanceof ArrayBuffer) || view.byteOffset !== 0 || view.byteLength !== view.buffer.byteLength) throw new RangeError("FactDeltaBatch views must own complete transferable ArrayBuffers.");
      buffers.add(view.buffer);
    }
  }
  return [...buffers];
}

export function readFactDeltaString(arena: Utf8Arena, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= arena.offsets.length) throw new RangeError("FactDeltaBatch string index is out of bounds.");
  const start = arena.offsets[index]!;
  const end = start + arena.lengths[index]!;
  if (end > arena.bytes.byteLength) throw new RangeError("FactDeltaBatch string range is out of bounds.");
  return UTF8_DECODER.decode(arena.bytes.subarray(start, end));
}

/** Compatibility name for the in-process v2 reader; this is not a wire codec. */
export const readArenaString = readFactDeltaString;

function columnBatch(rows: readonly FactDeltaBatchRow[]): FactDeltaColumnBatch {
  if (rows.length > FACT_DELTA_BATCH_MAX_ROWS) throw new RangeError(`FactDeltaBatch exceeds ${FACT_DELTA_BATCH_MAX_ROWS} rows.`);
  const stringCount = rows.reduce((total, row) => total + (row.strings?.length ?? 0), 0);
  const offsets = new Uint32Array(stringCount);
  const lengths = new Uint32Array(stringCount);
  const stringValues = rows.flatMap((row) => row.strings ?? []);
  const byteLength = stringValues.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (let index = 0; index < stringValues.length; index += 1) {
    const value = stringValues[index]!;
    const length = Buffer.byteLength(value, "utf8");
    offsets[index] = offset;
    lengths[index] = length;
    UTF8_ENCODER.encodeInto(value, bytes.subarray(offset, offset + length));
    offset += length;
  }
  return {
    row_count: rows.length,
    strings: { bytes, offsets, lengths, row_offsets: rowOffsets(rows, (row) => row.strings ?? []).offsets },
    numbers: Float64Array.from(rows.flatMap((row) => row.numbers ?? [])),
    number_row_offsets: rowOffsets(rows, (row) => row.numbers ?? []).offsets,
    ordinals: Uint32Array.from(rows.flatMap((row) => row.ordinals ?? [])),
    ordinal_row_offsets: rowOffsets(rows, (row) => row.ordinals ?? []).offsets,
    enums: Uint16Array.from(rows.flatMap((row) => row.enums ?? [])),
    enum_row_offsets: rowOffsets(rows, (row) => row.enums ?? []).offsets,
    presence: Uint8Array.from(rows.flatMap((row) => (row.presence ?? []).map((value) => value ? 1 : 0))),
    presence_row_offsets: rowOffsets(rows, (row) => row.presence ?? []).offsets,
  };
}

function batchBytes(batch: FactDeltaColumnBatch): number { return batch.strings.bytes.byteLength + batch.strings.offsets.byteLength + batch.strings.lengths.byteLength + batch.strings.row_offsets.byteLength + batch.numbers.byteLength + batch.number_row_offsets.byteLength + batch.ordinals.byteLength + batch.ordinal_row_offsets.byteLength + batch.enums.byteLength + batch.enum_row_offsets.byteLength + batch.presence.byteLength + batch.presence_row_offsets.byteLength; }

function rowOffsets<T>(rows: readonly FactDeltaBatchRow[], values: (row: FactDeltaBatchRow) => readonly T[]): { readonly offsets: Uint32Array } {
  const offsets = new Uint32Array(rows.length + 1);
  for (let index = 0; index < rows.length; index += 1) offsets[index + 1] = offsets[index]! + values(rows[index]!).length;
  return { offsets };
}

function validateRowOffsets(rowCount: number, offsets: Uint32Array, valueCount: number, kind: string): void {
  if (offsets.length !== rowCount + 1 || offsets[0] !== 0 || offsets[offsets.length - 1] !== valueCount) throw new RangeError(`FactDeltaBatch ${kind} row offsets are inconsistent.`);
  for (let index = 1; index < offsets.length; index += 1) if (offsets[index]! < offsets[index - 1]!) throw new RangeError(`FactDeltaBatch ${kind} row offsets are not monotonic.`);
}
