#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { openSqliteDatabase, WORKSPACE_SCHEMA } from "../packages/storage/dist/index.js";

const ROW_COUNT = 1_000_000;
const MAX_TRANSACTION_MS = 10_000;
const STAGING_CHUNK_ROWS = 100_000;
const WORKSPACE_ID = "workspace:sqlite-publication-microgate";
const CANDIDATE_ID = "candidate:sqlite-publication-microgate";
const ARTIFACT_ID = "artifact:sqlite-publication-microgate";
const ARTIFACT_VERSION_ID = "artifact-version:sqlite-publication-microgate";
const FIRST_RECORD_ID = "record:microgate:0000000";
const LAST_RECORD_ID = "record:microgate:0999999";

function argumentsOf(argv) {
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--") continue;
    if (argv[index] !== "--output" || argv[index + 1] === undefined) throw new Error("Usage: node scripts/sqlite-publication-microgate.mjs [--output /absolute/evidence.json]");
    output = resolve(argv[index + 1]);
    index += 1;
  }
  return { output };
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function sizeOf(path) {
  return (await stat(path).catch(() => undefined))?.size ?? 0;
}

async function seedAuthority(database) {
  await database.transaction([
    { kind: "run", sql: "INSERT INTO candidate_state (candidate_generation_id, workspace_id, target_registry_snapshot_id, target_configuration_revision_id, trigger_kind, state, source_observation_batch_ids, created_at, issue_ids) VALUES (?, ?, ?, ?, ?, 'ready', '[]', ?, '[]')", params: [CANDIDATE_ID, WORKSPACE_ID, "registry:microgate", "configuration:microgate", "manual", "2026-08-29T00:00:00.000Z"] },
    { kind: "run", sql: "INSERT INTO source_artifacts (artifact_id, workspace_id, normalized_uri, artifact_kind) VALUES (?, ?, ?, 'file')", params: [ARTIFACT_ID, WORKSPACE_ID, "file:///sqlite-publication-microgate.ts"] },
    { kind: "run", sql: "INSERT INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES ('blob:microgate', 'sha256:microgate', 0, 'inline')" },
    { kind: "run", sql: "INSERT INTO source_observation_batches (observation_batch_id, workspace_id, source_provider_binding_id, source_provider, source_provider_version, ordering_domain, observation_mode, coverage_scopes, coverage_completeness, deletion_authority, started_at, completed_at, observation_count, unavailable_count, batch_digest) VALUES ('batch:microgate', ?, 'binding:microgate', 'directory', '1', 'path', 'full', '[]', 'complete', 'authoritative', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z', 1, 0, 'sha256:batch')", params: [WORKSPACE_ID] },
    { kind: "run", sql: "INSERT INTO source_observations (source_observation_id, observation_batch_id, workspace_id, artifact_id, source_provider_binding_id, source_provider, source_provider_version, ordering_domain, observation_mode, observed_state, observed_content_hash, observed_metadata_digest, observed_at, received_at) VALUES ('observation:microgate', 'batch:microgate', ?, ?, 'binding:microgate', 'directory', '1', 'path', 'full', 'present', 'sha256:microgate', 'sha256:metadata', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z')", params: [WORKSPACE_ID, ARTIFACT_ID] },
    { kind: "run", sql: "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, analysis_metadata_digest, created_from_observation_id, valid_from_generation) VALUES (?, ?, ?, 'blob:microgate', 'sha256:microgate', 0, 'utf8', 'sha256:metadata', 'observation:microgate', 1)", params: [ARTIFACT_VERSION_ID, WORKSPACE_ID, ARTIFACT_ID] },
  ]);
}

async function stageRows(database) {
  for (let start = 0; start < ROW_COUNT; start += STAGING_CHUNK_ROWS) {
    const end = Math.min(ROW_COUNT - 1, start + STAGING_CHUNK_ROWS - 1);
    await database.run(`WITH RECURSIVE sequence(value) AS (
      VALUES (?) UNION ALL SELECT value + 1 FROM sequence WHERE value < ?
    ) INSERT INTO candidate_publication_record_occurrences (
      candidate_generation_id, row_ordinal, record_id, workspace_id, category, kind, universal_kind, schema_version,
      producer_id, producer_version, owner_artifact_id, owner_artifact_version_id,
      primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte,
      primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, record_digest,
      body_digest, body_byte_length, body_payload, analysis_digest, analysis_configuration_digest, artifact_dependency_digest
    ) SELECT ?, value, 'record:microgate:' || printf('%07d', value), ?, 'fact', 'microgate', 'microgate', 1,
      'microgate', '1', ?, ?, NULL, NULL, NULL, NULL, NULL, 1,
      'sha256:record:' || printf('%07d', value), 'sha256:body', 1, X'00', 'sha256:analysis', 'sha256:configuration', 'sha256:dependencies'
      FROM sequence`, [start, end, CANDIDATE_ID, WORKSPACE_ID, ARTIFACT_ID, ARTIFACT_VERSION_ID]);
  }
  await database.run("INSERT INTO candidate_publication_descriptors (candidate_generation_id, workspace_id, record_count, facet_count, identity_count, canonical_byte_length, first_record_id, last_record_id, record_sequence_digest, identity_sequence_digest, sealed_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?, 'sha256:record-sequence', 'sha256:identity-sequence', '2026-08-29T00:00:00.000Z')", [CANDIDATE_ID, WORKSPACE_ID, ROW_COUNT, ROW_COUNT, FIRST_RECORD_ID, LAST_RECORD_ID]);
}

function publicationCommands() {
  const descriptorPredicate = "candidate_generation_id = ? AND workspace_id = ? AND record_count = ? AND facet_count = 0 AND identity_count = 0 AND canonical_byte_length = ? AND first_record_id IS ? AND last_record_id IS ? AND record_sequence_digest = 'sha256:record-sequence' AND identity_sequence_digest = 'sha256:identity-sequence'";
  const descriptorParams = [CANDIDATE_ID, WORKSPACE_ID, ROW_COUNT, ROW_COUNT, FIRST_RECORD_ID, LAST_RECORD_ID];
  return [
    { kind: "exec", sql: "DROP INDEX IF EXISTS record_occurrences_visible_idx; DROP INDEX IF EXISTS record_occurrences_workspace_owner_idx; DROP INDEX IF EXISTS identity_assignments_lookup_idx; DROP INDEX IF EXISTS identity_assignments_key_idx; DROP INDEX IF EXISTS identity_assignments_record_idx;" },
    { kind: "transaction_checkpoint" },
    { kind: "run", sql: `INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, body_digest, body_byte_length, body_payload, analysis_digest, analysis_configuration_digest, artifact_dependency_digest) SELECT record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, NULL, record_digest, body_digest, body_byte_length, body_payload, analysis_digest, analysis_configuration_digest, artifact_dependency_digest FROM candidate_publication_record_occurrences WHERE candidate_generation_id = ? AND EXISTS (SELECT 1 FROM candidate_publication_descriptors WHERE ${descriptorPredicate}) ORDER BY row_ordinal ON CONFLICT(record_id) DO NOTHING`, params: [CANDIDATE_ID, ...descriptorParams] },
    { kind: "assert_transaction_changes", expected: ROW_COUNT },
    { kind: "run", sql: "DELETE FROM candidate_publication_record_occurrences WHERE candidate_generation_id = ?", params: [CANDIDATE_ID] },
    { kind: "run", sql: "DELETE FROM candidate_publication_descriptors WHERE candidate_generation_id = ?", params: [CANDIDATE_ID] },
    { kind: "exec", sql: "CREATE INDEX record_occurrences_visible_idx ON record_occurrences(workspace_id, valid_from_generation, valid_to_generation); CREATE INDEX record_occurrences_workspace_owner_idx ON record_occurrences(workspace_id, owner_artifact_id, valid_from_generation, valid_to_generation); CREATE INDEX identity_assignments_lookup_idx ON identity_assignments(workspace_id, identity_type, identity_id, valid_from_generation, valid_to_generation); CREATE INDEX identity_assignments_key_idx ON identity_assignments(workspace_id, identity_key_digest, valid_from_generation, identity_type, identity_key, record_id); CREATE INDEX identity_assignments_record_idx ON identity_assignments(workspace_id, record_id, valid_from_generation, valid_to_generation);" },
  ];
}

async function main() {
  const { output } = argumentsOf(process.argv.slice(2));
  const root = await mkdtemp(join(tmpdir(), "urdira-sqlite-publication-microgate-"));
  const databasePath = join(root, "workspace.sqlite");
  const database = await openSqliteDatabase({ filename: databasePath, busy_timeout_ms: 30_000 });
  let evidence;
  try {
    await database.exec(WORKSPACE_SCHEMA);
    await seedAuthority(database);
    await stageRows(database);
    const staged = await database.get("SELECT COUNT(*) AS count FROM candidate_publication_record_occurrences WHERE candidate_generation_id = ?", [CANDIDATE_ID]);
    if (staged?.count !== ROW_COUNT) throw new Error(`Staging count mismatch: ${String(staged?.count)}`);
    const started = performance.now();
    await database.get("PRAGMA wal_checkpoint(TRUNCATE)");
    await database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
    await database.transactionChunked(publicationCommands(), undefined, { discard_results: true });
    const transactionMs = performance.now() - started;
    const published = await database.get("SELECT COUNT(*) AS count, MIN(record_id) AS first_record_id, MAX(record_id) AS last_record_id FROM record_occurrences WHERE workspace_id = ?", [WORKSPACE_ID]);
    const stagedAfter = await database.get("SELECT (SELECT COUNT(*) FROM candidate_publication_record_occurrences) + (SELECT COUNT(*) FROM candidate_publication_descriptors) AS count");
    const integrity = await database.get("PRAGMA integrity_check");
    const databaseBytesBeforeCheckpoint = await sizeOf(databasePath);
    const rollbackJournalBytesBeforeRestore = await sizeOf(`${databasePath}-journal`);
    await database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    const walBytesBeforeCheckpoint = await sizeOf(`${databasePath}-wal`);
    await database.get("PRAGMA wal_checkpoint(TRUNCATE)");
    const finalDatabaseBytes = await sizeOf(databasePath);
    evidence = {
      schema_version: 1,
      gate: "sqlite_set_based_publication_one_million_rows",
      row_count: ROW_COUNT,
      transaction_ms: Number(transactionMs.toFixed(3)),
      threshold_ms: MAX_TRANSACTION_MS,
      passed: transactionMs < MAX_TRANSACTION_MS,
      final_rows: published?.count,
      first_record_id: published?.first_record_id,
      last_record_id: published?.last_record_id,
      staging_rows_after_commit: stagedAfter?.count,
      integrity_check: Object.values(integrity ?? {})[0],
      sqlite: { journal_mode: "DELETE during fresh publication, WAL after commit", synchronous: "FULL", implementation: "node:sqlite worker", publication_statements: publicationCommands().length },
      disk: {
        database_bytes_before_checkpoint: databaseBytesBeforeCheckpoint,
        wal_bytes_before_checkpoint: walBytesBeforeCheckpoint,
        final_database_bytes: finalDatabaseBytes,
        rollback_journal_bytes_before_restore: rollbackJournalBytesBeforeRestore,
        peak_observed_to_final_ratio: Number(((databaseBytesBeforeCheckpoint + rollbackJournalBytesBeforeRestore) / finalDatabaseBytes).toFixed(4)),
      },
      host: { platform: process.platform, architecture: process.arch, node: process.version },
    };
    if (published?.count !== ROW_COUNT || published?.first_record_id !== FIRST_RECORD_ID || published?.last_record_id !== LAST_RECORD_ID || stagedAfter?.count !== 0 || evidence.integrity_check !== "ok") throw new Error("Published relation failed exactness or integrity checks.");
  } finally {
    await database.close();
    if (output && evidence) {
      const body = `${JSON.stringify(evidence, null, 2)}\n`;
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, body);
      await writeFile(`${output}.sha256`, `${sha256(body)}  ${output.split("/").at(-1)}\n`);
    }
    await rm(root, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!evidence.passed) process.exitCode = 1;
}

await main();
