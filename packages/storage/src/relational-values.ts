import { LogicalDigestWriter } from "@urdira/canonical";
import type { SqliteCommand, SqliteValue } from "./sqlite.js";

/**
 * A logical value persisted as typed rows.  This is deliberately a value
 * model, not a serialized payload: every scalar has exactly one SQLite
 * storage column and containers are represented by their child rows.
 */
export type RelationalValueKind = "null" | "boolean" | "integer" | "real" | "text" | "bytes" | "object" | "array";

export interface RelationalValueRow {
  readonly workspace_id: string;
  readonly record_id: string;
  readonly valid_from_generation: number;
  readonly value_path: string;
  readonly parent_path: string | null;
  readonly sequence_ordinal: number | null;
  readonly map_key: string | null;
  readonly value_kind: RelationalValueKind;
  readonly text_value: string | null;
  readonly integer_value: number | null;
  readonly real_value: number | null;
  readonly bool_value: number | null;
  readonly bytes_value: Uint8Array | null;
}

/** Hard limits for publication-side value batches. */
export const RELATIONAL_VALUE_BATCH_MAX_ROWS = 1_024;
export const RELATIONAL_VALUE_BATCH_MAX_PARAMETERS = 13_312;
export const RELATIONAL_VALUE_BATCH_MAX_BYTES = 4 * 1024 * 1024;

const RELATIONAL_VALUE_COLUMNS = "workspace_id, record_id, valid_from_generation, value_path, parent_path, sequence_ordinal, map_key, value_kind, text_value, integer_value, real_value, bool_value, bytes_value";
const RELATIONAL_VALUE_UPDATE = "parent_path = excluded.parent_path, sequence_ordinal = excluded.sequence_ordinal, map_key = excluded.map_key, value_kind = excluded.value_kind, text_value = excluded.text_value, integer_value = excluded.integer_value, real_value = excluded.real_value, bool_value = excluded.bool_value, bytes_value = excluded.bytes_value";
const RELATIONAL_VALUE_ROW_PARAMETERS = 13;

function valueByteLength(value: SqliteValue): number {
  if (value === null) return 1;
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  return 8;
}

function relationalValueParams(row: RelationalValueRow): readonly SqliteValue[] {
  return [row.workspace_id, row.record_id, row.valid_from_generation, row.value_path, row.parent_path, row.sequence_ordinal, row.map_key, row.value_kind, row.text_value, row.integer_value, row.real_value, row.bool_value, row.bytes_value];
}

function relationalValueRowByteLength(row: RelationalValueRow): number {
  return relationalValueParams(row).reduce<number>((total, value) => total + valueByteLength(value), 0);
}

function relationalValueBatchCommand(rows: readonly RelationalValueRow[], table: "record_value_nodes" | "projection_value_nodes" | "candidate_value_nodes"): SqliteCommand {
  const placeholders = "(" + Array.from({ length: RELATIONAL_VALUE_ROW_PARAMETERS }, () => "?").join(", ") + ")";
  const params: SqliteValue[] = [];
  for (const row of rows) params.push(...relationalValueParams(row));
  return {
    kind: "run",
    sql: `INSERT INTO ${table} (${RELATIONAL_VALUE_COLUMNS}) VALUES ${rows.map(() => placeholders).join(", ")} ON CONFLICT(workspace_id, record_id, valid_from_generation, value_path) DO UPDATE SET ${RELATIONAL_VALUE_UPDATE}`,
    params,
  };
}

/**
 * Bounded writer used by publication paths. It retains only the current row
 * window and emits one multi-row INSERT when any hard limit is reached. The
 * limits are deliberately independent: a large string/blob cannot bypass the
 * byte cap merely by fitting under the row or parameter cap.
 */
export class RelationalValueBatchWriter {
  private readonly rows: RelationalValueRow[] = [];
  private bytes = 0;
  private parameters = 0;

  constructor(
    private readonly table: "record_value_nodes" | "projection_value_nodes" | "candidate_value_nodes",
    private readonly maxRows = RELATIONAL_VALUE_BATCH_MAX_ROWS,
    private readonly maxParameters = RELATIONAL_VALUE_BATCH_MAX_PARAMETERS,
    private readonly maxBytes = RELATIONAL_VALUE_BATCH_MAX_BYTES,
  ) {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isSafeInteger(maxParameters) || maxParameters < RELATIONAL_VALUE_ROW_PARAMETERS || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("Relational value batch limits must be positive safe integers.");
  }

  push(rows: Iterable<RelationalValueRow>): readonly SqliteCommand[] {
    const flushed: SqliteCommand[] = [];
    for (const row of rows) {
      const rowBytes = relationalValueRowByteLength(row);
      if (rowBytes > this.maxBytes) throw new RangeError(`Relational value row exceeds the ${this.maxBytes}-byte batch limit.`);
      if (this.rows.length > 0 && (this.rows.length >= this.maxRows || this.parameters + RELATIONAL_VALUE_ROW_PARAMETERS > this.maxParameters || this.bytes + rowBytes > this.maxBytes)) flushed.push(this.flushOne());
      this.rows.push(row);
      this.parameters += RELATIONAL_VALUE_ROW_PARAMETERS;
      this.bytes += rowBytes;
    }
    return flushed;
  }

  finish(): readonly SqliteCommand[] {
    return this.rows.length === 0 ? [] : [this.flushOne()];
  }

  private flushOne(): SqliteCommand {
    const rows = this.rows.splice(0, this.rows.length);
    this.bytes = 0;
    this.parameters = 0;
    return relationalValueBatchCommand(rows, this.table);
  }
}

function pathPart(value: string): string {
  // Paths are identifiers, not payloads. Escaping the two structural
  // delimiters keeps them reversible without encoding bytes as text.
  return value.replaceAll("%", "%25").replaceAll("/", "%2F");
}

function childPath(parent: string, segment: string): string {
  return `${parent}/${pathPart(segment)}`;
}

function scalarRow(workspaceId: string, recordId: string, generation: number, path: string, parentPath: string | null, ordinal: number | null, mapKey: string | null, value: unknown): RelationalValueRow {
  if (value === null) return { workspace_id: workspaceId, record_id: recordId, valid_from_generation: generation, value_path: path, parent_path: parentPath, sequence_ordinal: ordinal, map_key: mapKey, value_kind: "null", text_value: null, integer_value: null, real_value: null, bool_value: null, bytes_value: null };
  if (typeof value === "boolean") return { workspace_id: workspaceId, record_id: recordId, valid_from_generation: generation, value_path: path, parent_path: parentPath, sequence_ordinal: ordinal, map_key: mapKey, value_kind: "boolean", text_value: null, integer_value: null, real_value: null, bool_value: value ? 1 : 0, bytes_value: null };
  if (typeof value === "bigint") return { workspace_id: workspaceId, record_id: recordId, valid_from_generation: generation, value_path: path, parent_path: parentPath, sequence_ordinal: ordinal, map_key: mapKey, value_kind: "text", text_value: value.toString(10), integer_value: null, real_value: null, bool_value: null, bytes_value: null };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Relational values require finite numbers.");
    return Number.isSafeInteger(value)
      ? { workspace_id: workspaceId, record_id: recordId, valid_from_generation: generation, value_path: path, parent_path: parentPath, sequence_ordinal: ordinal, map_key: mapKey, value_kind: "integer", text_value: null, integer_value: value, real_value: null, bool_value: null, bytes_value: null }
      : { workspace_id: workspaceId, record_id: recordId, valid_from_generation: generation, value_path: path, parent_path: parentPath, sequence_ordinal: ordinal, map_key: mapKey, value_kind: "real", text_value: null, integer_value: null, real_value: value, bool_value: null, bytes_value: null };
  }
  if (typeof value === "string") return { workspace_id: workspaceId, record_id: recordId, valid_from_generation: generation, value_path: path, parent_path: parentPath, sequence_ordinal: ordinal, map_key: mapKey, value_kind: "text", text_value: value, integer_value: null, real_value: null, bool_value: null, bytes_value: null };
  if (value instanceof Uint8Array) return { workspace_id: workspaceId, record_id: recordId, valid_from_generation: generation, value_path: path, parent_path: parentPath, sequence_ordinal: ordinal, map_key: mapKey, value_kind: "bytes", text_value: null, integer_value: null, real_value: null, bool_value: null, bytes_value: new Uint8Array(value) };
  if (Array.isArray(value)) return { workspace_id: workspaceId, record_id: recordId, valid_from_generation: generation, value_path: path, parent_path: parentPath, sequence_ordinal: ordinal, map_key: mapKey, value_kind: "array", text_value: null, integer_value: null, real_value: null, bool_value: null, bytes_value: null };
  if (value !== null && typeof value === "object") return { workspace_id: workspaceId, record_id: recordId, valid_from_generation: generation, value_path: path, parent_path: parentPath, sequence_ordinal: ordinal, map_key: mapKey, value_kind: "object", text_value: null, integer_value: null, real_value: null, bool_value: null, bytes_value: null };
  throw new TypeError(`Unsupported relational value at ${path || "<root>"}.`);
}

function* flatten(workspaceId: string, recordId: string, generation: number, value: unknown, path: string, parentPath: string | null, ordinal: number | null, mapKey: string | null): Generator<RelationalValueRow> {
  if (Array.isArray(value)) {
    yield scalarRow(workspaceId, recordId, generation, path, parentPath, ordinal, mapKey, []);
    for (let index = 0; index < value.length; index += 1) yield* flatten(workspaceId, recordId, generation, value[index], childPath(path, String(index)), path, index, null);
    return;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    yield scalarRow(workspaceId, recordId, generation, path, parentPath, ordinal, mapKey, {});
    for (const key of Object.keys(value as Record<string, unknown>).sort()) yield* flatten(workspaceId, recordId, generation, (value as Record<string, unknown>)[key], childPath(path, key), path, null, key);
    return;
  }
  yield scalarRow(workspaceId, recordId, generation, path, parentPath, ordinal, mapKey, value);
}

export function iterateRelationalValue(workspaceId: string, recordId: string, generation: number, value: unknown): Generator<RelationalValueRow> {
  return flatten(workspaceId, recordId, generation, value, "", null, null, null);
}

export function flattenRelationalValue(workspaceId: string, recordId: string, generation: number, value: unknown): readonly RelationalValueRow[] {
  return [...iterateRelationalValue(workspaceId, recordId, generation, value)];
}

/** Digests the logical relational value without constructing a universal byte payload. */
export function digestRelationalValue(value: unknown): { readonly digest: string; readonly byte_length: number } {
  // The relational rows are a storage projection, not the logical value's
  // digest input.  Hash the value directly and incrementally: this avoids
  // constructing the complete flattened row array (which used to double
  // peak memory for large payloads) while retaining the v3 type/presence/
  // length/order rules of LogicalDigestWriter.
  const writer = new LogicalDigestWriter("urdira:relational-value:v3");
  writer.value(value);
  const digest = writer.digest();
  return { digest, byte_length: writer.byteLength() };
}

export function relationalValueCommands(rows: readonly RelationalValueRow[]): readonly SqliteCommand[] {
  return relationalValueCommandsForTable(rows, "record_value_nodes");
}

/** Build the same typed value rows for a non-record owner (for example a projection). */
export function relationalValueCommandsForTable(rows: readonly RelationalValueRow[], table: "record_value_nodes" | "projection_value_nodes" | "candidate_value_nodes"): readonly SqliteCommand[] {
  return rows.map((row) => ({
    kind: "run" as const,
    sql: `INSERT INTO ${table} (workspace_id, record_id, valid_from_generation, value_path, parent_path, sequence_ordinal, map_key, value_kind, text_value, integer_value, real_value, bool_value, bytes_value)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, record_id, valid_from_generation, value_path) DO UPDATE SET parent_path = excluded.parent_path, sequence_ordinal = excluded.sequence_ordinal, map_key = excluded.map_key, value_kind = excluded.value_kind, text_value = excluded.text_value, integer_value = excluded.integer_value, real_value = excluded.real_value, bool_value = excluded.bool_value, bytes_value = excluded.bytes_value`,
    params: [row.workspace_id, row.record_id, row.valid_from_generation, row.value_path, row.parent_path, row.sequence_ordinal, row.map_key, row.value_kind, row.text_value, row.integer_value, row.real_value, row.bool_value, row.bytes_value] satisfies readonly SqliteValue[],
  }));
}

function decodeRow(row: RelationalValueRow): unknown {
  switch (row.value_kind) {
    case "null": return null;
    case "boolean": return row.bool_value === 1;
    case "integer": return row.integer_value;
    case "real": return row.real_value;
    case "text": return row.text_value ?? "";
    case "bytes": return row.bytes_value === null ? new Uint8Array() : new Uint8Array(row.bytes_value);
    case "object": return {};
    case "array": return [];
  }
}

function unescapePart(value: string): string { return value.replaceAll("%2F", "/").replaceAll("%25", "%"); }

export function hydrateRelationalValue(rows: readonly RelationalValueRow[]): unknown {
  const byPath = new Map(rows.map((row) => [row.value_path, decodeRow(row)]));
  const rootRow = rows.find((row) => row.value_path === "");
  if (!rootRow) return undefined;
  const result: Record<string, unknown> | unknown[] = rootRow.value_kind === "array" ? [] : {};
  for (const row of [...rows].sort((left, right) => left.value_path.localeCompare(right.value_path))) {
    if (row.value_path === "") continue;
    const segments = row.value_path.slice(1).split("/").map(unescapePart);
    let current: Record<string, unknown> | unknown[] = result;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      const next = (current as Record<string, unknown>)[segment] ?? (row.sequence_ordinal !== null && /^\d+$/.test(segment) ? [] : {});
      (current as Record<string, unknown>)[segment] = next;
      current = next as Record<string, unknown> | unknown[];
    }
    const leaf = segments[segments.length - 1]!;
    if (Array.isArray(current)) current[Number(leaf)] = byPath.get(row.value_path);
    else current[leaf] = byPath.get(row.value_path);
  }
  return result;
}
