import { readFactDeltaString, validateFactDeltaBatch, type FactDeltaBatch, type FactDeltaColumnBatch } from "@urdira/contracts";
import { StorageError } from "./errors.js";
import type { SqliteCommand, SqliteDatabase } from "./sqlite.js";

/** Relational staging input retained for callers that do not use the worker command. */
export type StagedColumnSection = FactDeltaColumnBatch;
export interface StagedColumnBatch {
  readonly protocol_version: 2;
  readonly schema_id: "core:fact-delta-batch";
  readonly sequence: number;
  readonly final: boolean;
  readonly fact_delta_id: string;
  readonly byte_length: number;
  readonly records: StagedColumnSection;
  readonly graph_edges: StagedColumnSection;
  readonly identities: StagedColumnSection;
  readonly dependencies: StagedColumnSection;
}

const SECTION_NAMES = ["records", "graph_edges", "identities", "dependencies"] as const;
const TEXT_COLUMNS = 8;
const REAL_COLUMNS = 4;
const INTEGER_COLUMNS = 4;
const ENUM_COLUMNS = 4;
const PRESENCE_COLUMNS = 8;
const STAGED_ROW_COLUMNS = `fact_delta_key, row_ordinal,
  text_0, text_1, text_2, text_3, text_4, text_5, text_6, text_7,
  real_0, real_1, real_2, real_3,
  integer_0, integer_1, integer_2, integer_3,
  enum_0, enum_1, enum_2, enum_3,
  presence_0, presence_1, presence_2, presence_3, presence_4, presence_5, presence_6, presence_7`;
const SECTION_TABLES: Readonly<Record<string, string>> = { records: "candidate_staged_records", graph_edges: "candidate_staged_graph_edges", identities: "candidate_staged_identities", dependencies: "candidate_staged_dependencies" };

/** Idempotently accepts a bounded columnar batch as one typed row per logical row. */
export async function acceptStagedColumnBatch(database: SqliteDatabase, input: { readonly workspace_id: string; readonly candidate_generation_id: string; readonly batch: StagedColumnBatch }): Promise<void> {
  const batch = input.batch as FactDeltaBatch;
  validateFactDeltaBatch(batch);
  await database.run("INSERT INTO candidate_fact_delta_namespaces (workspace_id, candidate_generation_id, fact_delta_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", [input.workspace_id, input.candidate_generation_id, input.batch.fact_delta_id]);
  const delta = await database.get<{ fact_delta_key: number }>("SELECT fact_delta_key FROM candidate_fact_delta_namespaces WHERE workspace_id = ? AND candidate_generation_id = ? AND fact_delta_id = ?", [input.workspace_id, input.candidate_generation_id, input.batch.fact_delta_id]);
  if (delta === undefined) throw new StorageError("storage:fact_delta_batch_invalid", "A staged FactDelta batch could not allocate its compact namespace.");
  const commands: SqliteCommand[] = [];
  for (const sectionName of SECTION_NAMES) {
    const section = input.batch[sectionName];
    for (let row = 0; row < section.row_count; row += 1) {
      const values = rowValues(section, row);
      const table = SECTION_TABLES[sectionName]!;
      commands.push({ kind: "run", sql: `INSERT INTO ${table} (${STAGED_ROW_COLUMNS}) VALUES (${Array.from({ length: 30 }, () => "?").join(", ")})`, params: [delta.fact_delta_key, input.batch.sequence * 4_194_304 + row, ...values] });
    }
  }
  await database.transactionChunked(commands, 256, { discard_results: true });
}

function rowValues(section: FactDeltaColumnBatch, row: number): readonly (string | number | null)[] {
  const values: (string | number | null)[] = new Array(TEXT_COLUMNS + REAL_COLUMNS + INTEGER_COLUMNS + ENUM_COLUMNS + PRESENCE_COLUMNS).fill(null);
  const textStart = section.strings.row_offsets[row]!;
  const textEnd = section.strings.row_offsets[row + 1]!;
  if (textEnd - textStart > TEXT_COLUMNS) throw new StorageError("storage:staging_batch_invalid", "A staging row exceeds its promoted text-column budget.");
  for (let index = textStart; index < textEnd; index += 1) values[index - textStart] = readFactDeltaString(section.strings, index);
  append(values, section.numbers, section.number_row_offsets, row, TEXT_COLUMNS, REAL_COLUMNS, "real");
  append(values, section.ordinals, section.ordinal_row_offsets, row, TEXT_COLUMNS + REAL_COLUMNS, INTEGER_COLUMNS, "integer");
  append(values, section.enums, section.enum_row_offsets, row, TEXT_COLUMNS + REAL_COLUMNS + INTEGER_COLUMNS, ENUM_COLUMNS, "enum");
  append(values, section.presence, section.presence_row_offsets, row, TEXT_COLUMNS + REAL_COLUMNS + INTEGER_COLUMNS + ENUM_COLUMNS, PRESENCE_COLUMNS, "presence");
  return values;
}

function append(values: (string | number | null)[], source: ArrayLike<number>, offsets: Uint32Array, row: number, targetOffset: number, limit: number, kind: string): void {
  const start = offsets[row]!;
  const end = offsets[row + 1]!;
  if (end - start > limit) throw new StorageError("storage:staging_batch_invalid", `A staging row exceeds its promoted ${kind} column budget.`);
  for (let index = start; index < end; index += 1) values[targetOffset + index - start] = source[index]!;
}
