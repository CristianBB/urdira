import type { SqliteCommand, SqliteValue } from "./sqlite.js";

// SQLite's default maximum is 32,766 bound variables. Keep a margin for
// builds with a lower limit and for future command-shape changes. This is a
// statement-level bound: transactionChunked's chunk bound cannot protect a
// single multi-row INSERT assembled here.
const MAX_COMPACTED_PARAMETERS = 30_000;

/**
 * Coalesce repetitive immutable INSERT commands emitted by the materializer
 * into bounded multi-row statements. Preflight immutable-row validation has
 * already performed detailed conflict checks, so removing per-row
 * checkpoint/assert wrappers is safe while the surrounding transaction keeps
 * atomicity, ordering, and replay behavior unchanged.
 */
export function compactPublicationPhase(commands: readonly SqliteCommand[]): readonly SqliteCommand[] {
  const output: SqliteCommand[] = [];
  for (let index = 0; index < commands.length;) {
    const checkpoint = commands[index];
    const firstRun = commands[index + 1];
    const firstAssert = commands[index + 2];
    if (checkpoint?.kind === "transaction_checkpoint" && firstRun?.kind === "run" && firstAssert?.kind === "assert_transaction_changes" && firstAssert.expected === 1 && firstRun.sql.startsWith("INSERT INTO") && firstRun.sql.includes(" ON CONFLICT")) {
      const tuple = firstRun.sql.match(/^(.*?VALUES\s*)(\([^)]*\))(\s+ON CONFLICT[\s\S]*)$/i);
      if (tuple) {
        const rows: string[] = [tuple[2]!];
        const params: SqliteValue[] = [...(firstRun.params ?? [])];
        let parameterCount = params.length;
        let cursor = index + 3;
        while (cursor + 2 < commands.length) {
          const nextCheckpoint = commands[cursor]; const nextRun = commands[cursor + 1]; const nextAssert = commands[cursor + 2];
          if (nextCheckpoint?.kind !== "transaction_checkpoint" || nextRun?.kind !== "run" || nextAssert?.kind !== "assert_transaction_changes" || nextAssert.expected !== 1) break;
          const nextTuple = nextRun.sql.match(/^(.*?VALUES\s*)(\([^)]*\))(\s+ON CONFLICT[\s\S]*)$/i);
          if (!nextTuple || nextTuple[1] !== tuple[1] || nextTuple[3] !== tuple[3]) break;
          const nextParams = nextRun.params ?? [];
          if (parameterCount + nextParams.length > MAX_COMPACTED_PARAMETERS) break;
          rows.push(nextTuple[2]!); params.push(...(nextRun.params ?? [])); cursor += 3;
          parameterCount += nextParams.length;
        }
        if (rows.length > 1) {
          output.push({ kind: "transaction_checkpoint" }, { kind: "run", sql: `${tuple[1]}${rows.join(", ")}${tuple[3]}`, params });
          index = cursor;
          continue;
        }
      }
    }
    output.push(commands[index]!); index += 1;
  }
  return output;
}
