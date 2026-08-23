import { modelContractRegistry, type ModelFieldContract } from "./generated-model-contracts.js";

export type RelationalColumnType = "TEXT" | "INTEGER" | "REAL" | "BLOB";
export interface GeneratedRelationalColumn {
  readonly field_name: string;
  readonly column_name: string;
  readonly sqlite_type: RelationalColumnType;
  readonly nullable: boolean;
  readonly child_table: boolean;
}
export interface GeneratedRelationalTableSpec {
  readonly model_name: string;
  readonly table_name: string;
  readonly columns: readonly GeneratedRelationalColumn[];
  readonly child_tables: readonly GeneratedRelationalChildTableSpec[];
  readonly indexes: readonly string[];
  readonly generated_from: "Schema IR";
}
export interface GeneratedRelationalChildTableSpec {
  readonly table_name: string;
  readonly parent_field: string;
  readonly value_column: string;
  readonly value_type: RelationalColumnType;
  readonly ordered: boolean;
}

/** A deterministic SQL projection generated from Schema IR. */
export interface GeneratedRelationalSql {
  readonly model_name: string;
  readonly create_table: string;
  readonly create_indexes: readonly string[];
  readonly bind_columns: readonly string[];
}

function columnType(field: ModelFieldContract): RelationalColumnType {
  const type = field.logical_type.toLowerCase();
  if (type.includes("byte") || type.includes("blob")) return "BLOB";
  if (type.includes("float") || type.includes("decimal") || type.includes("number")) return "REAL";
  if (type.includes("integer") || type.includes("count") || type.includes("boolean") || type.includes("version")) return "INTEGER";
  return "TEXT";
}

function isChild(field: ModelFieldContract): boolean {
  const type = field.logical_type.toLowerCase();
  return type.includes("array") || type.includes("sequence") || type.includes("set") || type.includes("map") || type.includes("record") || field.nested_model !== undefined;
}

export const generatedRelationalTableSpecs: readonly GeneratedRelationalTableSpec[] = modelContractRegistry.map((model) => ({
  model_name: model.name,
  table_name: `model_${model.name.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`).replace(/^_/, "")}`,
  generated_from: "Schema IR",
  columns: model.fields.map((field) => ({ field_name: field.name, column_name: field.name, sqlite_type: columnType(field), nullable: field.presence === "optional", child_table: isChild(field) })),
  child_tables: model.fields.filter(isChild).map((field) => ({ table_name: `model_${model.name.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`).replace(/^_/, "")}_${field.name}`, parent_field: field.name, value_column: "value", value_type: columnType(field), ordered: field.logical_type.toLowerCase().includes("sequence") || field.logical_type.toLowerCase().includes("array") })),
  indexes: model.fields.filter((field) => field.name.endsWith("_id") || field.name === "kind" || field.name === "name").map((field) => `${field.name}_idx`),
}));

export function relationalTableSpec(modelName: string): GeneratedRelationalTableSpec | undefined {
  return generatedRelationalTableSpecs.find((spec) => spec.model_name === modelName);
}

/**
 * Generates the operational table contract.  This is deliberately SQL text,
 * not a serialized model payload: callers execute it once while creating the
 * workspace schema and then bind each scalar field directly.
 */
export function generateRelationalSql(modelName: string): GeneratedRelationalSql | undefined {
  const spec = relationalTableSpec(modelName);
  if (!spec) return undefined;
  const primary = spec.columns.filter((column) => !column.child_table);
  const columns = primary.map((column) => `${column.column_name} ${column.sqlite_type}${column.nullable ? "" : " NOT NULL"}`);
  const createTable = `CREATE TABLE IF NOT EXISTS ${spec.table_name} (\n  ${columns.join(",\n  ")}\n) STRICT`;
  return {
    model_name: modelName,
    create_table: createTable,
    create_indexes: spec.indexes.map((index) => `CREATE INDEX IF NOT EXISTS ${spec.table_name}_${index} ON ${spec.table_name} (${index.replace(/_idx$/u, "")})`),
    bind_columns: primary.map((column) => column.column_name),
  };
}

export function generateAllRelationalSql(): readonly GeneratedRelationalSql[] {
  return modelContractRegistry.map((model) => generateRelationalSql(model.name)).filter((value): value is GeneratedRelationalSql => value !== undefined);
}
