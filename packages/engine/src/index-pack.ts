import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import { createGunzip, createGzip, type Gzip } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { canonicalBytes, decodeCanonical, digestBytes, encodeCanonical } from "@urdira/canonical";
import type {
  PluginResolutionLock,
  RegistrySnapshot,
  WorkspaceConfigurationRevision,
  WorkspaceFreshnessCheckpoint,
} from "@urdira/contracts";
import type { DurableStorage, ForkPublicationPlanInput, WorkspaceDatabase } from "@urdira/storage";
import { buildForkPublicationPlan, computeForkSnapshotDigestFields, normalizeObservationBatchIds, openSqliteDatabase, publicationTransactionCommands, snapshotDigest } from "@urdira/storage";
import { readTreeFile } from "./v4-verify.js";
import { recordIntegrityFailure } from "./index-pack-verify-core.js";
import type { GitIgnoreRules, InclusionRules } from "@urdira/security";
import { record, resetTimings, snapshotTimings, timed, timedSync, timingEnabled } from "./debug-timing.js";
import { ISOMORPHIC_GIT_OBJECT_PORT, administrativeState, type GitObjectPort } from "./git-providers.js";
import type { RegisteredWorkspace, WorkspaceRegistry } from "./workspaces.js";
import type { WorkspaceScanPluginProvider } from "./workspace-indexing-session.js";
import type { RustIndexingCoreGenerationPort } from "./rust-indexing-core-port.js";
import {
  DEFAULT_FORK_GITIGNORE,
  DEFAULT_FORK_INCLUSION,
  bulkCopyDependencies,
  bulkCopyProjections,
  bulkCopyRecordsAndIdentities,
  buildFullArtifactMap,
  commitForkSourceLayer,
  digest,
  enumerateForkRoot,
  isKnownPreexistingVerifyGap,
  multisetKey,
  recomputeV4SnapshotDigestsAfterRewrite,
  rewriteV4WorkspaceIdentity,
  rollbackForkPublication,
  sortedResolvedPluginsDigest,
  stableId,
  visibleCapabilityStateEntries,
  type DonorRowMap,
  type DonorVisibleArtifact,
  type ForkContext,
  type ForkDonorHandle,
  type ForkEnumeration,
  type ForkPublicationIds,
  type ForkSourceLayer,
  type WorkspaceForkOptions,
} from "./workspace-fork.js";

/**
 * Index pack (docs/decisions/23-index-pack.md): a distributable, gzip-
 * compressed, tagged-NDJSON export of a `ready` workspace's currently-visible
 * canonical index. A fresh machine adding a byte-identical workspace can
 * import this pack instead of running the full from-zero analysis pipeline --
 * the cross-machine sibling of `workspace-fork.ts`'s local, same-installation
 * fork. Reuses `bulkCopyRecordsAndIdentities`/`bulkCopyDependencies`/
 * `bulkCopyProjections`/`rollbackForkPublication`/`buildForkPublicationPlan`
 * wholesale: the only new machinery here is (a) the carrier format, (b) a
 * throwaway "scratch" SQLite donor built from a pack's rows so those exact
 * fork functions can run unmodified against it, and (c) an UNTRUSTED
 * recompute pass a local fork never needs (see `verifyCopiedRecordIntegrity`'s
 * doc comment -- this is the load-bearing trust boundary of this module).
 */

export const INDEX_PACK_SCHEMA_VERSION = 1 as const;
const PACK_BATCH_ROWS = 500;
const SQL_PAGE_ROWS = 8000;
const DEFAULT_MAX_DIFF_ENTRIES = 20;
/** How many scratch-donor rows accumulate per `BEGIN`/`COMMIT` while populating `ScratchDonorDatabase` from a pack's streamed rows -- see that class's doc comment. */
const SCRATCH_DONOR_BATCH_TX_ROWS = 2000;

export interface IndexPackRowCounts {
  readonly multiset: number;
  readonly records: number;
  readonly value_nodes: number;
  readonly facets: number;
  readonly identities: number;
  readonly dependencies: number;
  readonly projections: number;
  readonly capability_state: number;
}

export interface IndexPackCompatibility {
  readonly storage_format_version: number;
  readonly identity_format: number;
  /** `sortedResolvedPluginsDigest` of the donor's resolved plugin set -- covers plugin id/version and (for the JS/TS plugin) its bundled TypeScript compiler version, since both are folded into each resolved plugin's own digest. */
  readonly resolved_plugins_digest: string;
  readonly analysis_configuration_digest: string;
}

export interface IndexPackSnapshotAnchor {
  readonly canonical_record_set_digest: string;
  readonly projection_set_digests: string;
  readonly capability_state_digest: string;
  readonly source_state_digest: string;
}

export interface IndexPackManifest {
  readonly schema_version: 1;
  /** Passed in by the caller, never `Date.now()`-derived, so exports are reproducible in tests. */
  readonly created_at: string;
  readonly pack_id: string;
  readonly donor_workspace_id: string;
  readonly donor_generation: number;
  readonly compatibility: IndexPackCompatibility;
  readonly row_counts: IndexPackRowCounts;
  /** `digestBytes` of `multisetKey(...)`'s canonical JSON text over the full `[normalized_uri, content_hash]` multiset -- a compact manifest-level anchor; the full entry list travels in the pack's own `"multiset"` section for bounded-diff reporting on a mismatch. */
  readonly multiset_digest: string;
  readonly donor_snapshot_anchor: IndexPackSnapshotAnchor;
  readonly manifest_digest: string;
}

function manifestDigest(manifest: IndexPackManifest): string {
  const { manifest_digest: _digest, ...rest } = manifest;
  return digestBytes(canonicalBytes(rest));
}

type PackLine =
  | { readonly kind: "manifest"; readonly manifest: IndexPackManifest }
  | { readonly kind: "multiset" | "records" | "value_nodes" | "facets" | "identities" | "dependencies" | "projections" | "capability_state"; readonly rows: readonly unknown[] }
  | { readonly kind: "end" };

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("Expected a binary row payload.");
}

function hexEncode(bytes: Uint8Array | null): string | undefined {
  return bytes === null ? undefined : Buffer.from(bytes).toString("hex");
}

function fromHex(text: string | undefined): Uint8Array | null {
  return text === undefined ? null : new Uint8Array(Buffer.from(text, "hex"));
}

// ---------------------------------------------------------------------------
// Carrier: a single gzip stream of newline-delimited JSON "lines", the first
// of which is always `{kind:"manifest", manifest}`. Deliberately NOT a POSIX
// tar (the repo carries no tar dependency, and this payload is entirely
// structured JSON/hex -- POSIX file metadata buys nothing here); see
// docs/decisions/23-index-pack.md's carrier section for the tradeoff this
// accepts (hex doubles BLOB column size pre-compression, worse than base64's
// ~33% -- deliberately chosen anyway: this repo's architecture guardrails
// (scripts/check-architecture.mjs, docs/decisions/21-native-pipeline-relational-storage.md)
// forbid base64 encode/decode outright, a regression guard against a
// previously-removed pattern) against what it
// avoids (a new dependency, and non-JSON framing code). Every section is
// batched into `PACK_BATCH_ROWS`-row lines on write and consumed one line --
// never one section -- at a time on read, so neither side ever materializes
// more than a bounded number of rows at once.
// ---------------------------------------------------------------------------

class PackWriter {
  // Level 1 (fastest): the 150k-record codec gate measured the default
  // level 6 at ~2x the compression CPU of level 1 on this payload shape
  // (highly repetitive JSON/hex rows compress well at any level); a pack is
  // a transient transport artifact, not an archive, so encode speed wins.
  private readonly gzip: Gzip = createGzip({ level: 1 });
  private readonly done: Promise<void>;

  constructor(outPath: string) {
    const fileStream = createWriteStream(outPath);
    this.done = new Promise((resolve, reject) => {
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
      this.gzip.on("error", reject);
    });
    this.gzip.pipe(fileStream);
  }

  async writeLine(value: PackLine): Promise<void> {
    const text = timedSync("index_pack_export_stringify", () => `${JSON.stringify(value)}\n`);
    const startedAt = timingEnabled() ? performance.now() : 0;
    if (!this.gzip.write(text)) await once(this.gzip, "drain");
    if (timingEnabled()) record("index_pack_export_gzip_write", performance.now() - startedAt);
  }

  async writeRows(kind: Exclude<PackLine["kind"], "manifest" | "end">, rows: readonly unknown[]): Promise<void> {
    for (let start = 0; start < rows.length; start += PACK_BATCH_ROWS) await this.writeLine({ kind, rows: rows.slice(start, start + PACK_BATCH_ROWS) });
  }

  async close(): Promise<void> {
    await this.writeLine({ kind: "end" });
    this.gzip.end();
    await this.done;
  }
}

async function* readPackLines(packPath: string): AsyncGenerator<PackLine> {
  const source = createReadStream(packPath);
  const gunzip = createGunzip();
  // A source error (missing/unreadable pack) must surface through the async
  // iterator so `attemptIndexPackImport`'s never-throws wrapper can turn it
  // into a skip outcome. `pipe()` alone does NOT forward source errors to the
  // destination -- the 'error' event fires on `source` with no listener and
  // crashes the daemon process (observed live: ENOENT after the pack file was
  // purged from /tmp mid-session).
  source.on("error", (error) => gunzip.destroy(error));
  const input = source.pipe(gunzip);
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try { parsed = timedSync("index_pack_import_json_parse", () => JSON.parse(line)); } catch { throw new Error("index pack contains a malformed line"); }
    yield parsed as PackLine;
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportIndexPackOptions {
  readonly database: WorkspaceDatabase;
  readonly workspace_id: string;
  readonly out_path: string;
  readonly now?: () => string;
  readonly require_git_clean?: boolean;
  readonly canonical_root?: string;
  readonly git_objects?: GitObjectPort;
}

export interface ExportIndexPackResult {
  readonly manifest: IndexPackManifest;
  readonly out_path: string;
}

async function readWorkspaceMetaNumber(database: WorkspaceDatabase, key: string): Promise<number | undefined> {
  const row = await database.database.get<{ value: unknown }>("SELECT value FROM workspace_meta WHERE key = ?", [key]);
  if (row === undefined) return undefined;
  const decoded = decodeCanonical(toBytes(row.value));
  return typeof decoded === "number" ? decoded : undefined;
}

export async function exportIndexPack(options: ExportIndexPackOptions): Promise<ExportIndexPackResult> {
  if (timingEnabled()) resetTimings();
  const now = options.now ?? (() => new Date().toISOString());
  const database = options.database;
  const workspaceId = options.workspace_id;

  if (options.require_git_clean) {
    if (options.canonical_root === undefined) throw new Error("index pack export: --require-git-clean was requested without a canonical_root to check");
    const admin = await administrativeState(options.canonical_root, options.git_objects ?? ISOMORPHIC_GIT_OBJECT_PORT, now);
    if (admin.vcs_state.dirty) throw new Error("index pack export: workspace root has uncommitted changes (--require-git-clean)");
  }

  const current = await database.repositories.snapshots.getCurrent();
  if (current === undefined) throw new Error("index pack export: workspace has no published generation");
  const snapshot = await database.repositories.snapshots.get(current.current_snapshot_id);
  if (snapshot === undefined) throw new Error("index pack export: current snapshot row is missing");
  const generation = current.current_generation;

  const resolutionLockRow = await database.database.get<{ state_json: string }>(
    "SELECT state_json FROM control_plane_state WHERE workspace_id = ? AND state_key = ?",
    [workspaceId, `plugin_resolution_lock:${current.current_resolution_lock_id}`],
  );
  if (resolutionLockRow === undefined) throw new Error("index pack export: plugin resolution lock row is missing");
  const resolutionLock = JSON.parse(resolutionLockRow.state_json) as { readonly resolved_plugins?: readonly unknown[] };

  const configurationRow = await database.database.get<{ state_json: string }>(
    "SELECT state_json FROM control_plane_state WHERE workspace_id = ? AND state_key = ?",
    [workspaceId, `workspace_configuration_revision:${current.current_configuration_revision_id}`],
  );
  const configuration = configurationRow === undefined ? undefined : (JSON.parse(configurationRow.state_json) as { readonly analysis_configuration_digest?: string });

  const storageFormatVersion = (await readWorkspaceMetaNumber(database, "storage_format_version")) ?? 0;
  const identityFormat = (await readWorkspaceMetaNumber(database, "identity_format")) ?? 0;

  const manifestRow = await database.database.get<{ candidate_generation_id: string }>(
    "SELECT candidate_generation_id FROM generation_manifests WHERE workspace_id = ? AND generation_manifest_id = ?",
    [workspaceId, snapshot.generation_manifest_id],
  );
  const capabilityStateEntries = manifestRow === undefined ? [] : await visibleCapabilityStateEntries(database, manifestRow.candidate_generation_id);

  const visible = (alias: string): string => `${alias}.valid_from_generation <= ? AND (${alias}.valid_to_generation IS NULL OR ${alias}.valid_to_generation > ?)`;
  // The bulk row reads below go through a private, read-only, same-thread
  // connection to the workspace's own sqlite file rather than the
  // `SqliteWorkerAdapter` handle: profiling on the 150k-record codec gate
  // showed each worker-proxied page pays a structured-clone + postMessage
  // round trip that dominated export wall time for BLOB-bearing rows
  // (~40us/row against a ~3us/row native floor). A second read-only
  // connection against a WAL database is this repo's established pattern
  // (lexical/semantic worker threads, `openWorkspaceReadOnly`). The reads
  // run inside one deferred read transaction so the manifest's count pass
  // and the data pass observe a single WAL snapshot -- the count/data
  // reconciliation at the end then only fires on genuine pre-transaction
  // drift. NOTE: these reads are synchronous on this thread; the daemon
  // invokes exportIndexPack on a worker thread (index-pack-export-thread)
  // so a large export cannot starve the runtime's event loop.
  const rawDatabase = new DatabaseSync(database.database.filename, { readOnly: true });
  rawDatabase.exec("BEGIN;");
  const closeRawDatabase = (): void => {
    try { rawDatabase.exec("COMMIT;"); } catch { /* read txn already ended */ }
    try { rawDatabase.close(); } catch { /* already closed */ }
  };
  const count = (sql: string, params: readonly (string | number)[]): number => Number((rawDatabase.prepare(sql).get(...(params as never[])) as { c?: unknown } | undefined)?.c ?? 0);
  const sqlAll = (sql: string, params: readonly (string | number)[]): readonly Record<string, unknown>[] => {
    const section = /FROM (\w+)/u.exec(sql)?.[1] ?? "unknown";
    return timedSync(`index_pack_export_sql_all_${section}`, () => rawDatabase.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]);
  };

  try {
  const multisetRows = sqlAll(
    `SELECT artifact.normalized_uri AS normalized_uri, version.content_hash AS content_hash
     FROM artifact_versions AS version JOIN source_artifacts AS artifact ON artifact.workspace_id = version.workspace_id AND artifact.artifact_id = version.artifact_id
     WHERE version.workspace_id = ? AND version.valid_to_generation IS NULL`,
    [workspaceId],
  );
  const multisetEntries = multisetRows.map((row) => [String(row["normalized_uri"]), String(row["content_hash"])] as const);

  // Row counts are computed via `COUNT(*)` up front, before any row is
  // streamed, so the manifest (which declares them) can be written as the
  // FIRST line of the pack -- `attemptIndexPackImport` reads exactly one
  // line to get the manifest and validate every compatibility gate before
  // it commits to reading (or trusting) anything else the pack contains.
  // The streaming loops below re-derive these same counts as they go and
  // assert they match at the end, catching any drift between this count
  // pass and the data pass (e.g. a concurrent write to the donor workspace)
  // rather than silently shipping a pack whose manifest lies about its own
  // contents.
  const declaredRowCounts: IndexPackRowCounts = {
    multiset: multisetEntries.length,
    records: count(`SELECT COUNT(*) AS c FROM record_occurrences r WHERE r.workspace_id = ? AND ${visible("r")}`, [workspaceId, generation, generation]),
    value_nodes: count(`SELECT COUNT(*) AS c FROM record_value_nodes v JOIN record_occurrences r ON r.workspace_id = v.workspace_id AND r.record_id = v.record_id AND r.valid_from_generation = v.valid_from_generation WHERE v.workspace_id = ? AND ${visible("r")}`, [workspaceId, generation, generation]),
    facets: count("SELECT COUNT(*) AS c FROM record_facets WHERE workspace_id = ? AND valid_from_generation <= ?", [workspaceId, generation]),
    identities: count(`SELECT COUNT(*) AS c FROM identity_assignments d WHERE d.workspace_id = ? AND ${visible("d")}`, [workspaceId, generation, generation]),
    dependencies: count(`SELECT COUNT(*) AS c FROM artifact_dependencies dep WHERE dep.workspace_id = ? AND ${visible("dep")}`, [workspaceId, generation, generation]),
    projections: count(`SELECT COUNT(*) AS c FROM projection_occurrences po WHERE po.workspace_id = ? AND ${visible("po")}`, [workspaceId, generation, generation]),
    capability_state: capabilityStateEntries.length,
  };
  const multisetKeyValue = multisetKey(multisetEntries);
  const packId = stableId("index-pack", { workspace_id: workspaceId, generation, snapshot_id: snapshot.snapshot_id });
  const manifestWithoutDigest = {
    schema_version: INDEX_PACK_SCHEMA_VERSION,
    created_at: now(),
    pack_id: packId,
    donor_workspace_id: workspaceId,
    donor_generation: generation,
    compatibility: {
      storage_format_version: storageFormatVersion,
      identity_format: identityFormat,
      resolved_plugins_digest: sortedResolvedPluginsDigest(resolutionLock.resolved_plugins ?? []),
      analysis_configuration_digest: configuration?.analysis_configuration_digest ?? "",
    },
    row_counts: declaredRowCounts,
    multiset_digest: digestBytes(new TextEncoder().encode(multisetKeyValue)),
    donor_snapshot_anchor: {
      canonical_record_set_digest: snapshot.canonical_record_set_digest,
      projection_set_digests: snapshot.projection_set_digests,
      capability_state_digest: snapshot.capability_state_digest,
      source_state_digest: snapshot.source_state_digest,
    },
  };
  const manifest: IndexPackManifest = { ...manifestWithoutDigest, manifest_digest: digestBytes(canonicalBytes(manifestWithoutDigest)) };

  await mkdir(join(options.out_path, ".."), { recursive: true }).catch(() => undefined);
  const writer = new PackWriter(options.out_path);
  let ok = false;
  try {
    await writer.writeLine({ kind: "manifest", manifest });
    await writer.writeRows("multiset", multisetEntries);

    // Profiling on the 150k-record codec gate showed the previous
    // JOIN-per-page shape (owner source_artifacts JOIN + a two-hop LEFT JOIN
    // for the span uri) cost ~88ms per 1000-row page vs ~3ms for the
    // identical-shaped JOIN-free identity pages -- ~85% of total export wall
    // time. Both uri lookups are workspace-bounded (one row per file), so
    // they are prefetched once here and applied in JS instead.
    const artifactIdToUri = new Map<string, string>(
      sqlAll("SELECT artifact_id, normalized_uri FROM source_artifacts WHERE workspace_id = ?", [workspaceId]).map((row) => [String(row["artifact_id"]), String(row["normalized_uri"])]),
    );
    // Unlike `versionToUri` (current versions only, used for the
    // projections section below), span references may name historical
    // version rows, matching the unfiltered LEFT JOIN this map replaces.
    const spanVersionToUri = new Map<string, string>(
      sqlAll(
        `SELECT version.artifact_version_id AS artifact_version_id, artifact.normalized_uri AS normalized_uri
         FROM artifact_versions AS version JOIN source_artifacts AS artifact ON artifact.workspace_id = version.workspace_id AND artifact.artifact_id = version.artifact_id
         WHERE version.workspace_id = ?`,
        [workspaceId],
      ).map((row) => [String(row["artifact_version_id"]), String(row["normalized_uri"])]),
    );

    let recordCount = 0;
    let cursor = "";
    for (;;) {
      const rows = sqlAll(
        `SELECT r.record_id AS record_id, r.category AS category, r.kind AS kind, r.universal_kind AS universal_kind, r.schema_version AS schema_version,
           r.producer_id AS producer_id, r.producer_version AS producer_version, r.owner_artifact_id AS owner_artifact_id,
           r.primary_source_span_artifact_version_id AS primary_source_span_artifact_version_id,
           r.primary_source_span_start_byte AS primary_source_span_start_byte, r.primary_source_span_end_byte AS primary_source_span_end_byte,
           r.primary_source_span_start_line AS primary_source_span_start_line, r.primary_source_span_end_line AS primary_source_span_end_line,
           r.record_digest AS record_digest, r.body_digest AS body_digest, r.body_byte_length AS body_byte_length, r.body_payload AS body_payload,
           r.analysis_digest AS analysis_digest, r.analysis_configuration_digest AS analysis_configuration_digest, r.artifact_dependency_digest AS artifact_dependency_digest
         FROM record_occurrences r
         WHERE r.workspace_id = ? AND ${visible("r")} AND r.record_id > ? ORDER BY r.record_id LIMIT ?`,
        [workspaceId, generation, generation, cursor, SQL_PAGE_ROWS],
      );
      if (rows.length === 0) break;
      const packRows = timedSync("index_pack_export_row_map", () => rows.map((row) => {
        const ownerUri = artifactIdToUri.get(String(row["owner_artifact_id"]));
        // The previous INNER JOIN silently dropped a record with no owner
        // row; that would be an integrity violation worth failing loudly on.
        if (ownerUri === undefined) throw new Error(`index pack export: record ${String(row["record_id"])} owner artifact ${String(row["owner_artifact_id"])} has no source_artifacts row`);
        const spanVersionId = row["primary_source_span_artifact_version_id"];
        return {
        record_id: row["record_id"], category: row["category"], kind: row["kind"], universal_kind: row["universal_kind"], schema_version: row["schema_version"],
        producer_id: row["producer_id"], producer_version: row["producer_version"], owner_normalized_uri: ownerUri,
        primary_source_span_normalized_uri: spanVersionId === null || spanVersionId === undefined ? undefined : spanVersionToUri.get(String(spanVersionId)),
        primary_source_span_start_byte: row["primary_source_span_start_byte"] ?? undefined, primary_source_span_end_byte: row["primary_source_span_end_byte"] ?? undefined,
        primary_source_span_start_line: row["primary_source_span_start_line"] ?? undefined, primary_source_span_end_line: row["primary_source_span_end_line"] ?? undefined,
        record_digest: row["record_digest"], body_digest: row["body_digest"], body_byte_length: row["body_byte_length"],
        body_payload_hex: hexEncode(row["body_payload"] === null ? null : toBytes(row["body_payload"])),
        analysis_digest: row["analysis_digest"], analysis_configuration_digest: row["analysis_configuration_digest"], artifact_dependency_digest: row["artifact_dependency_digest"],
      }; }));
      await writer.writeRows("records", packRows);
      recordCount += rows.length;
      cursor = String(rows[rows.length - 1]!["record_id"]);
    }

    // All six loops below page via KEYSET pagination (WHERE key > cursor
    // ORDER BY key LIMIT n) rather than OFFSET: SQLite's OFFSET must
    // re-scan and discard every already-returned row on each page (an
    // engine-level cursor `step()` per skipped row), making OFFSET
    // pagination O(n^2) in the table's row count. At real-workspace scale
    // (hundreds of thousands to millions of value_nodes/facets rows) that
    // quadratic cost is what made `exportIndexPack` take 20+ minutes. Each
    // cursor tuple matches (a prefix of) the table's own PRIMARY KEY so
    // page boundaries can never split or duplicate a tied row -- see the
    // per-loop comments for why each tuple is unique among the rows this
    // query can return.
    let valueNodeCount = 0;
    // (record_id, value_path) is unique among rows a single record_id's
    // JOIN can produce (record_occurrences' visibility windows never
    // overlap for one record_id, so exactly one valid_from_generation is
    // visible per record_id here) -- valid_from_generation is carried in
    // the cursor anyway as a cheap, always-correct tiebreaker matching
    // record_value_nodes' actual PRIMARY KEY column order.
    let valueNodeCursorRecordId = "";
    let valueNodeCursorGeneration = -1;
    let valueNodeCursorPath = "";
    for (;;) {
      const rows = sqlAll(
        `SELECT v.record_id AS record_id, v.valid_from_generation AS valid_from_generation, v.value_path AS value_path, v.parent_path AS parent_path, v.sequence_ordinal AS sequence_ordinal, v.map_key AS map_key,
           v.value_kind AS value_kind, v.text_value AS text_value, v.integer_value AS integer_value, v.real_value AS real_value, v.bool_value AS bool_value, v.bytes_value AS bytes_value
         FROM record_value_nodes v
         JOIN record_occurrences r ON r.workspace_id = v.workspace_id AND r.record_id = v.record_id AND r.valid_from_generation = v.valid_from_generation
         WHERE v.workspace_id = ? AND ${visible("r")} AND (v.record_id, v.valid_from_generation, v.value_path) > (?, ?, ?)
         ORDER BY v.record_id, v.valid_from_generation, v.value_path LIMIT ?`,
        [workspaceId, generation, generation, valueNodeCursorRecordId, valueNodeCursorGeneration, valueNodeCursorPath, SQL_PAGE_ROWS],
      );
      if (rows.length === 0) break;
      await writer.writeRows("value_nodes", rows.map((row) => ({ ...row, valid_from_generation: undefined, bytes_value: undefined, bytes_value_hex: hexEncode(row["bytes_value"] === null ? null : toBytes(row["bytes_value"])) })));
      valueNodeCount += rows.length;
      const lastValueNode = rows[rows.length - 1]!;
      valueNodeCursorRecordId = String(lastValueNode["record_id"]);
      valueNodeCursorGeneration = Number(lastValueNode["valid_from_generation"]);
      valueNodeCursorPath = String(lastValueNode["value_path"]);
    }

    let facetCount = 0;
    // record_facets carries no valid_to_generation column, so the query
    // below (unchanged from the OFFSET version) can return facets recorded
    // under more than one valid_from_generation for the same record_id;
    // the full (record_id, valid_from_generation, facet_ordinal) tuple --
    // record_facets' actual PRIMARY KEY -- is the only column set
    // guaranteed unique per row here.
    let facetCursorRecordId = "";
    let facetCursorGeneration = -1;
    let facetCursorOrdinal = -1;
    for (;;) {
      const rows = sqlAll(
        `SELECT record_id, valid_from_generation, facet_ordinal, facet FROM record_facets
         WHERE workspace_id = ? AND valid_from_generation <= ? AND (record_id, valid_from_generation, facet_ordinal) > (?, ?, ?)
         ORDER BY record_id, valid_from_generation, facet_ordinal LIMIT ?`,
        [workspaceId, generation, facetCursorRecordId, facetCursorGeneration, facetCursorOrdinal, SQL_PAGE_ROWS],
      );
      if (rows.length === 0) break;
      await writer.writeRows("facets", rows.map((row) => ({ record_id: row["record_id"], facet_ordinal: row["facet_ordinal"], facet: row["facet"] })));
      facetCount += rows.length;
      const lastFacet = rows[rows.length - 1]!;
      facetCursorRecordId = String(lastFacet["record_id"]);
      facetCursorGeneration = Number(lastFacet["valid_from_generation"]);
      facetCursorOrdinal = Number(lastFacet["facet_ordinal"]);
    }

    let identityCount = 0;
    // identity_assignment_id alone is unique among visible rows: like
    // record_occurrences, an identity_assignment_id's own visibility
    // window never overlaps itself, so at most one row for a given id is
    // visible at this generation.
    let identityCursor = "";
    for (;;) {
      const rows = sqlAll(
        `SELECT d.identity_assignment_id AS identity_assignment_id, d.identity_type AS identity_type, d.identity_id AS identity_id, d.identity_key AS identity_key,
           d.identity_key_digest AS identity_key_digest, d.record_id AS record_id
         FROM identity_assignments d
         WHERE d.workspace_id = ? AND ${visible("d")} AND d.identity_assignment_id > ?
         ORDER BY d.identity_assignment_id LIMIT ?`,
        [workspaceId, generation, generation, identityCursor, SQL_PAGE_ROWS],
      );
      if (rows.length === 0) break;
      await writer.writeRows("identities", rows);
      identityCount += rows.length;
      identityCursor = String(rows[rows.length - 1]!["identity_assignment_id"]);
    }

    let dependencyCount = 0;
    // The previous ORDER BY (record_id, dependency_role) was not unique --
    // a record can depend on several artifacts under the same role -- so
    // it could not be reused as a keyset cursor without risking dropped
    // rows at a page boundary tie. dependency_entry_id is artifact_dependencies'
    // own PRIMARY KEY component and is unique per visible row; it is
    // selected here purely to drive the cursor and is stripped back out
    // before the row reaches the pack (the pack's "dependencies" row shape
    // is unchanged).
    let dependencyCursor = "";
    for (;;) {
      const rows = sqlAll(
        `SELECT dep.dependency_entry_id AS dependency_entry_id, dep.record_id AS record_id, owner_artifact.normalized_uri AS owner_normalized_uri, dependency_artifact.normalized_uri AS dependency_normalized_uri,
           dep.dependency_role AS dependency_role, dep.producer_id AS producer_id, dep.producer_version AS producer_version
         FROM artifact_dependencies dep
         JOIN source_artifacts owner_artifact ON owner_artifact.workspace_id = dep.workspace_id AND owner_artifact.artifact_id = dep.owner_artifact_id
         JOIN source_artifacts dependency_artifact ON dependency_artifact.workspace_id = dep.workspace_id AND dependency_artifact.artifact_id = dep.dependency_artifact_id
         WHERE dep.workspace_id = ? AND ${visible("dep")} AND dep.dependency_entry_id > ?
         ORDER BY dep.dependency_entry_id LIMIT ?`,
        [workspaceId, generation, generation, dependencyCursor, SQL_PAGE_ROWS],
      );
      if (rows.length === 0) break;
      await writer.writeRows("dependencies", rows.map((row) => ({ record_id: row["record_id"], owner_normalized_uri: row["owner_normalized_uri"], dependency_normalized_uri: row["dependency_normalized_uri"], dependency_role: row["dependency_role"], producer_id: row["producer_id"], producer_version: row["producer_version"] })));
      dependencyCount += rows.length;
      dependencyCursor = String(rows[rows.length - 1]!["dependency_entry_id"]);
    }

    const versionToUri = new Map<string, string>(
      sqlAll(
        `SELECT version.artifact_version_id AS artifact_version_id, artifact.normalized_uri AS normalized_uri
         FROM artifact_versions AS version JOIN source_artifacts AS artifact ON artifact.workspace_id = version.workspace_id AND artifact.artifact_id = version.artifact_id
         WHERE version.workspace_id = ? AND version.valid_to_generation IS NULL`,
        [workspaceId],
      ).map((row) => [String(row["artifact_version_id"]), String(row["normalized_uri"])]),
    );
    let projectionCount = 0;
    // projection_record_id is projection_occurrences' PRIMARY KEY column
    // and already what the pre-existing ORDER BY sorted on.
    let projectionCursor = "";
    for (;;) {
      const rows = sqlAll(
        `SELECT projection_record_id, projection_kind, projection_key, owner_artifact_version_id, source_artifact_version_ids, source_record_ids, source_projection_record_ids,
           generator, generator_version, generator_configuration_digest, content_digest
         FROM projection_occurrences po
         WHERE po.workspace_id = ? AND ${visible("po")} AND po.projection_record_id > ?
         ORDER BY po.projection_record_id LIMIT ?`,
        [workspaceId, generation, generation, projectionCursor, SQL_PAGE_ROWS],
      );
      if (rows.length === 0) break;
      const packRows = rows.map((row) => {
        const sourceArtifactVersionIds = JSON.parse(String(row["source_artifact_version_ids"] ?? "[]")) as readonly string[];
        return {
          projection_record_id: row["projection_record_id"], projection_kind: row["projection_kind"], projection_key: row["projection_key"],
          owner_normalized_uri: versionToUri.get(String(row["owner_artifact_version_id"])),
          source_normalized_uris: sourceArtifactVersionIds.flatMap((id) => { const uri = versionToUri.get(id); return uri === undefined ? [] : [uri]; }),
          source_record_ids: JSON.parse(String(row["source_record_ids"] ?? "[]")),
          source_projection_record_ids: JSON.parse(String(row["source_projection_record_ids"] ?? "[]")),
          generator: row["generator"], generator_version: row["generator_version"], generator_configuration_digest: row["generator_configuration_digest"], content_digest: row["content_digest"],
        };
      });
      await writer.writeRows("projections", packRows);
      projectionCount += rows.length;
      projectionCursor = String(rows[rows.length - 1]!["projection_record_id"]);
    }

    await writer.writeRows("capability_state", capabilityStateEntries);

    const actualRowCounts: IndexPackRowCounts = {
      multiset: multisetEntries.length, records: recordCount, value_nodes: valueNodeCount, facets: facetCount,
      identities: identityCount, dependencies: dependencyCount, projections: projectionCount, capability_state: capabilityStateEntries.length,
    };
    for (const key of Object.keys(declaredRowCounts) as (keyof IndexPackRowCounts)[]) {
      if (actualRowCounts[key] !== declaredRowCounts[key]) throw new Error(`index pack export: row count for ${key} changed between the manifest's count pass (${declaredRowCounts[key]}) and its data pass (${actualRowCounts[key]}) -- the donor workspace was mutated concurrently with this export`);
    }
    ok = true;
    return { manifest, out_path: options.out_path };
  } finally {
    await writer.close();
    if (!ok) await rm(options.out_path, { force: true }).catch(() => undefined);
    if (timingEnabled()) console.error(`[urdira] index pack export timings for ${workspaceId}:`, JSON.stringify(snapshotTimings()));
  }
  } finally {
    closeRawDatabase();
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface IndexPackImportOptions {
  readonly workspace: RegisteredWorkspace;
  readonly database: WorkspaceDatabase;
  readonly storage: DurableStorage;
  readonly registry: WorkspaceRegistry;
  readonly plugin: WorkspaceScanPluginProvider;
  /** Persistent Rust writer for source capture and recovery on import. */
  readonly indexing_core?: RustIndexingCoreGenerationPort;
  readonly pack_path: string;
  readonly inclusion_rules?: InclusionRules;
  readonly gitignore_rules?: GitIgnoreRules;
  readonly source_provider_binding_id?: string;
  readonly io_concurrency?: number;
  readonly now?: () => string;
  readonly git_objects?: GitObjectPort;
  /** `"full"` runs `StorageMaintenance.verify()` after publish, mirroring `WorkspaceForkOptions.verify_mode` (see that doc comment for the known pre-existing gaps it filters); default `"fast"` runs `fastPackVerify` plus the untrusted recompute pass, which always runs regardless of this setting. */
  readonly verify_mode?: "fast" | "full";
  /** Caps how many mismatched multiset entries a skip reason names. Default 20. */
  readonly max_diff_entries?: number;
}

export type IndexPackImportOutcome =
  | { readonly status: "imported"; readonly donor_workspace_id: string; readonly snapshot_id: string; readonly generation: number; readonly projection_patch_count: number }
  | { readonly status: "skipped"; readonly reason: string };

/** Never throws: every failure mode (incompatible pack, tamper detected, verify failure, I/O error) becomes `{status:"skipped", reason}`, mirroring `attemptWorkspaceFork`'s contract exactly so a caller can fall back to a full scan unconditionally. */
export async function attemptIndexPackImport(options: IndexPackImportOptions): Promise<IndexPackImportOutcome> {
  if (timingEnabled()) resetTimings();
  try {
    return await attemptIndexPackImportInner(options);
  } catch (error) {
    return { status: "skipped", reason: `index pack import attempt threw: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (timingEnabled()) console.error(`[urdira] index pack import timings for ${options.workspace.workspace_id}:`, JSON.stringify(snapshotTimings()));
  }
}

function buildContext(options: IndexPackImportOptions): ForkContext {
  return {
    now: options.now ?? (() => new Date().toISOString()),
    gitObjects: options.git_objects ?? ISOMORPHIC_GIT_OBJECT_PORT,
    bindingId: options.source_provider_binding_id ?? "provider:filesystem",
    inclusionRules: options.inclusion_rules ?? DEFAULT_FORK_INCLUSION,
    gitignoreRules: options.gitignore_rules ?? DEFAULT_FORK_GITIGNORE,
    timings: {},
  };
}

class IndexPackFormatError extends Error {}
function fail(reason: string): never { throw new IndexPackFormatError(reason); }

interface DonorArtifactEntry { readonly artifact_id: string; readonly artifact_version_id: string; readonly content_hash: string; }

const SCRATCH_DONOR_SCHEMA = `
CREATE TABLE record_occurrences (
  record_id TEXT, workspace_id TEXT, category TEXT, kind TEXT, universal_kind TEXT, schema_version INTEGER,
  producer_id TEXT, producer_version TEXT, owner_artifact_version_id TEXT, primary_source_span_artifact_version_id TEXT,
  primary_source_span_start_byte TEXT, primary_source_span_end_byte TEXT, primary_source_span_start_line TEXT, primary_source_span_end_line TEXT,
  valid_from_generation INTEGER, valid_to_generation INTEGER, record_digest TEXT, body_digest TEXT, body_byte_length INTEGER, body_payload BLOB,
  analysis_digest TEXT, analysis_configuration_digest TEXT, artifact_dependency_digest TEXT
);
CREATE TABLE record_value_nodes (
  workspace_id TEXT, record_id TEXT, valid_from_generation INTEGER, value_path TEXT, parent_path TEXT, sequence_ordinal INTEGER, map_key TEXT,
  value_kind TEXT, text_value TEXT, integer_value INTEGER, real_value REAL, bool_value INTEGER, bytes_value BLOB
);
CREATE TABLE record_facets (workspace_id TEXT, record_id TEXT, valid_from_generation INTEGER, facet_ordinal INTEGER, facet TEXT);
CREATE TABLE identity_assignments (
  identity_assignment_id TEXT, workspace_id TEXT, identity_type TEXT, identity_id TEXT, identity_key TEXT, identity_key_digest TEXT,
  record_id TEXT, valid_from_generation INTEGER, valid_to_generation INTEGER
);
CREATE TABLE artifact_dependencies (
  workspace_id TEXT, record_id TEXT, owner_artifact_id TEXT, owner_artifact_version_id TEXT, dependency_artifact_id TEXT,
  dependency_artifact_version_id TEXT, dependency_role TEXT, producer_id TEXT, producer_version TEXT, valid_from_generation INTEGER, valid_to_generation INTEGER
);
CREATE TABLE projection_occurrences (
  workspace_id TEXT, projection_record_id TEXT, projection_kind TEXT, projection_key TEXT, owner_artifact_id TEXT, owner_artifact_version_id TEXT,
  source_artifact_version_ids TEXT, source_record_ids TEXT, source_projection_record_ids TEXT, generator TEXT, generator_version TEXT,
  generator_configuration_digest TEXT, content_digest TEXT, valid_from_generation INTEGER, valid_to_generation INTEGER
);
`;

/**
 * A throwaway, `PRAGMA foreign_keys = OFF` SQLite file populated directly
 * from a pack's rows, standing in for a real `WorkspaceDatabase` donor. Only
 * `bulkCopyRecordsAndIdentities`/`bulkCopyDependencies`/`bulkCopyProjections`
 * ever read it (via `ForkDonorHandle`'s narrow `filename`/`all`/`get`/`run`
 * surface); it is deleted once the import attempt finishes, win or lose. Its
 * `owner_artifact_id`/`owner_artifact_version_id`/`dependency_artifact_id`/
 * `dependency_artifact_version_id` values are FABRICATED, stable-per-uri ids
 * (`stableId("index-pack-donor-artifact[-version]", {uri[, content_hash]})`)
 * -- they never surface in the published target (the copy functions' JOIN
 * against `fork_artifact_map` always rewrites them to the target's own real
 * ids first), so minting them freely here is safe. Because `foreign_keys` is
 * off, no `source_artifacts`/`artifact_versions`/`content_blobs`/
 * `source_observations` rows are needed at all -- only the six tables the
 * copy functions actually touch.
 *
 * Population also runs `PRAGMA synchronous = OFF` and batches every
 * `insert*` call's rows into `SCRATCH_DONOR_BATCH_TX_ROWS`-row `BEGIN`/
 * `COMMIT` transactions (see `trackInsertedRows`), instead of the default
 * one-autocommit-transaction-per-`run()` that node:sqlite otherwise applies.
 * Without batching, a multi-hundred-thousand-row pack made this file's
 * *own* build step (not just the OFFSET-paginated export it stands in for)
 * a second source of the >20-minute import time this class exists to avoid:
 * synchronous durability is pointless for a file this function deletes
 * unconditionally (win or lose) a few lines later.
 */
class ScratchDonorDatabase {
  readonly workspaceId: string;
  readonly database: ForkDonorHandle["database"];
  private readonly raw: DatabaseSync;
  private readonly dir: string;
  private rowsSinceCommit = 0;
  private transactionOpen = false;

  private constructor(workspaceId: string, dir: string, filename: string, raw: DatabaseSync) {
    this.workspaceId = workspaceId;
    this.dir = dir;
    this.raw = raw;
    this.database = {
      filename,
      all: async <T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => raw.prepare(sql).all(...(params as never[])) as T[],
      get: async <T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => raw.prepare(sql).get(...(params as never[])) as T | undefined,
      run: async (sql: string, params: readonly unknown[] = []) => {
        const info = raw.prepare(sql).run(...(params as never[]));
        return { changes: Number(info.changes), last_insert_rowid: typeof info.lastInsertRowid === "bigint" ? info.lastInsertRowid.toString() : info.lastInsertRowid };
      },
    };
  }

  static async create(workspaceId: string): Promise<ScratchDonorDatabase> {
    const dir = await mkdtemp(join(tmpdir(), "urdira-index-pack-scratch-"));
    const filename = join(dir, "donor.sqlite");
    const raw = new DatabaseSync(filename);
    raw.exec("PRAGMA foreign_keys = OFF;");
    // Durability is irrelevant for a throwaway file this module deletes
    // unconditionally a few lines after its last read -- trading it away
    // removes the fsync-per-transaction-commit cost entirely.
    raw.exec("PRAGMA synchronous = OFF;");
    raw.exec("PRAGMA journal_mode = MEMORY;");
    raw.exec(SCRATCH_DONOR_SCHEMA);
    const instance = new ScratchDonorDatabase(workspaceId, dir, filename, raw);
    instance.beginTransaction();
    return instance;
  }

  handle(): ForkDonorHandle { return { workspaceId: this.workspaceId, database: this.database }; }

  private beginTransaction(): void {
    this.raw.exec("BEGIN;");
    this.transactionOpen = true;
  }

  /**
   * Every `insert*` call routes its row count through here. Left unbatched,
   * node:sqlite treats each bare `statement.run()` as its own autocommit
   * transaction, so a pack with hundreds of thousands of rows meant
   * hundreds of thousands of individual commits -- exactly the kind of
   * per-row cost this whole file's fix is about, just on the import side
   * instead of the export side. Batching amortizes that over
   * `SCRATCH_DONOR_BATCH_TX_ROWS` rows per commit; `finalizeWrites` closes
   * out whatever partial batch is left once the pack's rows are exhausted.
   */
  private trackInsertedRows(count: number): void {
    this.rowsSinceCommit += count;
    if (this.rowsSinceCommit >= SCRATCH_DONOR_BATCH_TX_ROWS) {
      this.raw.exec("COMMIT;");
      this.beginTransaction();
      this.rowsSinceCommit = 0;
    }
  }

  /** Must run after the last `insert*` call and before `handle()`'s reads (`bulkCopy*`) are trusted to see every inserted row. */
  finalizeWrites(): void {
    if (this.transactionOpen) {
      this.raw.exec("COMMIT;");
      this.transactionOpen = false;
    }
    // `bulkCopyRecordsAndIdentities`'s value_nodes and identities statements
    // both JOIN this scratch's record_occurrences ON record_id; without an
    // index SQLite builds a transient automatic index over the full table
    // PER STATEMENT (two ~1M-row builds at VS Code scale), and the records
    // statement's new ORDER BY d.record_id gets a sort for free from the
    // same index. One deliberate index after the bulk inserts costs a
    // single sort-based build instead.
    this.raw.exec("CREATE INDEX scratch_records_record_id ON record_occurrences (record_id);");
  }

  insertRecords(rows: readonly Record<string, unknown>[], uriMap: ReadonlyMap<string, DonorArtifactEntry>): void {
    const statement = this.raw.prepare(
      `INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_version_id,
        primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line,
        valid_from_generation, valid_to_generation, record_digest, body_digest, body_byte_length, body_payload, analysis_digest, analysis_configuration_digest, artifact_dependency_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      const ownerUri = String(row["owner_normalized_uri"] ?? "");
      const owner = uriMap.get(ownerUri);
      if (owner === undefined) fail(`index pack record ${String(row["record_id"])} owner uri ${ownerUri} is not present in the pack's declared multiset`);
      const spanUri = row["primary_source_span_normalized_uri"] as string | undefined;
      const span = spanUri === undefined ? undefined : uriMap.get(spanUri);
      if (spanUri !== undefined && span === undefined) fail(`index pack record ${String(row["record_id"])} source-span uri ${spanUri} is not present in the pack's declared multiset`);
      statement.run(
        String(row["record_id"]), this.workspaceId, String(row["category"]), String(row["kind"]), String(row["universal_kind"]), Number(row["schema_version"]),
        String(row["producer_id"]), String(row["producer_version"]), owner.artifact_version_id,
        span === undefined ? null : span.artifact_version_id, (row["primary_source_span_start_byte"] as string | undefined) ?? null, (row["primary_source_span_end_byte"] as string | undefined) ?? null,
        (row["primary_source_span_start_line"] as string | undefined) ?? null, (row["primary_source_span_end_line"] as string | undefined) ?? null,
        String(row["record_digest"]), String(row["body_digest"]), Number(row["body_byte_length"]), fromHex(row["body_payload_hex"] as string | undefined),
        String(row["analysis_digest"]), String(row["analysis_configuration_digest"]), String(row["artifact_dependency_digest"]),
      );
    }
    this.trackInsertedRows(rows.length);
  }

  insertValueNodes(rows: readonly Record<string, unknown>[]): void {
    const statement = this.raw.prepare(
      `INSERT INTO record_value_nodes (workspace_id, record_id, valid_from_generation, value_path, parent_path, sequence_ordinal, map_key, value_kind, text_value, integer_value, real_value, bool_value, bytes_value)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) statement.run(this.workspaceId, String(row["record_id"]), String(row["value_path"]), (row["parent_path"] as string | undefined) ?? null, (row["sequence_ordinal"] as number | undefined) ?? null, (row["map_key"] as string | undefined) ?? null, String(row["value_kind"]), (row["text_value"] as string | undefined) ?? null, (row["integer_value"] as number | undefined) ?? null, (row["real_value"] as number | undefined) ?? null, (row["bool_value"] as number | undefined) ?? null, fromHex(row["bytes_value_hex"] as string | undefined));
    this.trackInsertedRows(rows.length);
  }

  insertFacets(rows: readonly Record<string, unknown>[]): void {
    const statement = this.raw.prepare(`INSERT INTO record_facets (workspace_id, record_id, valid_from_generation, facet_ordinal, facet) VALUES (?, ?, 1, ?, ?)`);
    for (const row of rows) statement.run(this.workspaceId, String(row["record_id"]), Number(row["facet_ordinal"]), String(row["facet"]));
    this.trackInsertedRows(rows.length);
  }

  insertIdentities(rows: readonly Record<string, unknown>[]): void {
    const statement = this.raw.prepare(`INSERT INTO identity_assignments (identity_assignment_id, workspace_id, identity_type, identity_id, identity_key, identity_key_digest, record_id, valid_from_generation, valid_to_generation) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)`);
    for (const row of rows) statement.run(String(row["identity_assignment_id"]), this.workspaceId, String(row["identity_type"]), String(row["identity_id"]), String(row["identity_key"]), String(row["identity_key_digest"]), String(row["record_id"]));
    this.trackInsertedRows(rows.length);
  }

  insertDependencies(rows: readonly Record<string, unknown>[], uriMap: ReadonlyMap<string, DonorArtifactEntry>): void {
    const statement = this.raw.prepare(`INSERT INTO artifact_dependencies (workspace_id, record_id, owner_artifact_id, owner_artifact_version_id, dependency_artifact_id, dependency_artifact_version_id, dependency_role, producer_id, producer_version, valid_from_generation, valid_to_generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`);
    for (const row of rows) {
      const ownerUri = String(row["owner_normalized_uri"] ?? "");
      const dependencyUri = String(row["dependency_normalized_uri"] ?? "");
      const owner = uriMap.get(ownerUri);
      const dependency = uriMap.get(dependencyUri);
      if (owner === undefined) fail(`index pack dependency owner uri ${ownerUri} is not present in the pack's declared multiset`);
      if (dependency === undefined) fail(`index pack dependency target uri ${dependencyUri} is not present in the pack's declared multiset`);
      statement.run(this.workspaceId, String(row["record_id"]), owner.artifact_id, owner.artifact_version_id, dependency.artifact_id, dependency.artifact_version_id, String(row["dependency_role"]), String(row["producer_id"]), String(row["producer_version"]));
    }
    this.trackInsertedRows(rows.length);
  }

  insertProjections(rows: readonly Record<string, unknown>[], uriMap: ReadonlyMap<string, DonorArtifactEntry>): void {
    const statement = this.raw.prepare(`INSERT INTO projection_occurrences (workspace_id, projection_record_id, projection_kind, projection_key, owner_artifact_id, owner_artifact_version_id, source_artifact_version_ids, source_record_ids, source_projection_record_ids, generator, generator_version, generator_configuration_digest, content_digest, valid_from_generation, valid_to_generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`);
    for (const row of rows) {
      const ownerUri = String(row["owner_normalized_uri"] ?? "");
      const owner = uriMap.get(ownerUri);
      if (owner === undefined) fail(`index pack projection owner uri ${ownerUri} is not present in the pack's declared multiset`);
      const sourceUris = (row["source_normalized_uris"] as readonly string[] | undefined) ?? [];
      const sourceArtifactVersionIds = sourceUris.map((uri) => { const entry = uriMap.get(uri); if (entry === undefined) fail(`index pack projection source uri ${uri} is not present in the pack's declared multiset`); return entry.artifact_version_id; });
      statement.run(this.workspaceId, String(row["projection_record_id"]), String(row["projection_kind"]), String(row["projection_key"]), owner.artifact_id, owner.artifact_version_id, JSON.stringify(sourceArtifactVersionIds), JSON.stringify(row["source_record_ids"] ?? []), JSON.stringify(row["source_projection_record_ids"] ?? []), String(row["generator"]), String(row["generator_version"]), String(row["generator_configuration_digest"]), String(row["content_digest"]));
    }
    this.trackInsertedRows(rows.length);
  }

  async close(): Promise<void> {
    try { this.raw.close(); } catch { /* already closed */ }
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function multisetDiff(packEntries: readonly (readonly [string, string])[], targetEntries: readonly (readonly [string, string])[], maxEntries: number): string {
  const packMap = new Map(packEntries);
  const targetMap = new Map(targetEntries);
  const onlyInPack: string[] = [];
  const onlyInTarget: string[] = [];
  const hashMismatch: string[] = [];
  for (const [uri, hash] of packMap) {
    const targetHash = targetMap.get(uri);
    if (targetHash === undefined) onlyInPack.push(uri);
    else if (targetHash !== hash) hashMismatch.push(`${uri} (pack=${hash} target=${targetHash})`);
  }
  for (const uri of targetMap.keys()) if (!packMap.has(uri)) onlyInTarget.push(uri);
  const bound = (entries: readonly string[]): string => entries.length === 0 ? "none" : `${entries.slice(0, maxEntries).join(", ")}${entries.length > maxEntries ? ` (+${entries.length - maxEntries} more)` : ""}`;
  return `pack has ${packMap.size} entries, target root has ${targetMap.size}; only in pack: ${bound(onlyInPack)}; only in target: ${bound(onlyInTarget)}; content-hash mismatches: ${bound(hashMismatch)}`;
}


/**
 * The trust boundary this whole module exists to add on top of
 * `workspace-fork.ts`'s bulk-copy machinery (decision 23: "no signing in
 * v1... a pure performance hint that cannot inject content"). A local fork
 * trusts a donor's stored digests outright (same installation, same trust
 * domain); an index pack crossed a machine boundary and is authored by
 * whoever built it, so every claim it makes about content is re-derived here
 * from what was ACTUALLY copied, using the same recipes the write path uses
 * (`digestRelationalValue`/`decodeCanonical` for `body_digest`,
 * `record:${record_digest}` for `record_id`) -- never the pack's own claimed
 * values. Two things are deliberately NOT re-derived, both documented in
 * docs/decisions/23-index-pack.md: (1) full `record_digest` recomputation
 * would require reconstructing the plugin's original pre-decomposition
 * `ProposedRecord` object, which the decomposed `record_occurrences`/
 * `record_value_nodes` columns do not retain enough of to do byte-exactly;
 * instead this enforces record_id/record_digest self-consistency (the
 * minting formula) and rejects any id shape other than a first-open
 * (non-chain-salted) one. (2) The real ground-truth check for CONTENT is the
 * multiset/ownership-closure comparison against the importer's own freshly
 * hashed local source layer, run before any row is copied -- this pass
 * instead defends against a pack that is internally inconsistent (a
 * body_payload that does not match its own claimed body_digest, a record_id
 * that does not match its own record_digest), which is the class of tamper a
 * naive forger would actually produce.
 *
 * WHERE the recompute runs moved in 2026-08-24's stream-verify change: the
 * default import path now runs it at scratch-build time over the PACK'S OWN
 * rows (`IndexPackStreamVerifier` below), overlapped with the source-layer
 * commit and finished before bulkCopy/publish -- strictly earlier in the
 * write sequence than the old post-publish pass. What that stream pass can
 * no longer observe ("did bulkCopy land every row in the target
 * faithfully") is covered by `fastPackVerify`'s row counts + recomputed
 * anchors + ownership checks over the target; `verifyCopiedRecordIntegrity`
 * below (the target-side pass) remains the `verify_mode: "full"` surface
 * and the fallback whenever stream verify is unavailable.
 */
/**
 * Stream-time front end of the untrusted per-record recompute: the import
 * feeds each `records` pack line here as it lands in the scratch donor, and
 * 1-2 `index-pack-verify-worker` threads (batch mode) run the exact same
 * `recordIntegrityFailure` check the post-publish pass would -- so the whole
 * decode+digest cost overlaps the source-layer commit's I/O window and a
 * corrupt pack is rejected BEFORE bulkCopy/publish ever run. Two workers,
 * not more: the machine-level ceiling measured for this decode+digest mix
 * (aggregate ~1.4x at 8 shards) makes wider fan-out pointless, and here the
 * workers only need to keep up with the pack stream, not win a race.
 *
 * Failure semantics mirror the module's never-throw rule: infrastructure
 * problems (spawn failure, worker crash) surface as `status: "unavailable"`
 * -- the import then simply keeps the old post-publish verify -- while
 * verified pack corruption is a definite failure list. `URDIRA_INDEX_PACK_STREAM_VERIFY=0`
 * forces "unavailable" (the fallback path) for tests and emergencies.
 */
const STREAM_VERIFY_WORKERS = 2;
const STREAM_VERIFY_MAX_INFLIGHT_BATCHES = 8;

interface StreamVerifyRow { readonly record_id: string; readonly record_digest: string; readonly body_digest: string; readonly body_payload_hex?: string }

class IndexPackStreamVerifier {
  readonly #workers: Worker[] = [];
  readonly #failures: string[] = [];
  #inflight = 0;
  #nextWorker = 0;
  #infraError: string | undefined;
  #waiters: (() => void)[] = [];
  readonly #finalResults: Promise<void>[] = [];

  static create(): IndexPackStreamVerifier | undefined {
    if (process.env["URDIRA_INDEX_PACK_STREAM_VERIFY"] === "0") return undefined;
    try {
      const verifier = new IndexPackStreamVerifier();
      const workerEntry = new URL("index-pack-verify-worker.js", import.meta.resolve("@urdira/engine"));
      for (let index = 0; index < STREAM_VERIFY_WORKERS; index += 1) {
        const worker = new Worker(workerEntry, { workerData: { mode: "batch" } });
        verifier.#workers.push(worker);
        verifier.#finalResults.push(new Promise<void>((resolve) => {
          // `finished` distinguishes a worker that reported its final
          // "result" from one that died mid-stream: only the former may
          // count toward a completed ("verified") pass -- an exit without a
          // result means fed rows may never have been checked, which must
          // degrade to "unavailable" (fall back to the post-publish verify),
          // never silently pass.
          let finished = false;
          worker.on("message", (message: { readonly kind: string; readonly failures?: readonly string[]; readonly error?: { readonly message: string } }) => {
            if (message.kind === "batch_result" && message.failures !== undefined) { verifier.#failures.push(...message.failures); verifier.#settleOne(); }
            else if (message.kind === "result") { finished = true; resolve(); }
            else { verifier.#infraError ??= message.error?.message ?? "stream verify worker returned an unrecognized message"; verifier.#settleOne(); resolve(); }
          });
          worker.on("error", (error) => { verifier.#infraError ??= error instanceof Error ? error.message : String(error); verifier.#drainWaiters(); resolve(); });
          worker.on("exit", () => { if (!finished) verifier.#infraError ??= "stream verify worker exited before reporting its final result"; verifier.#drainWaiters(); resolve(); });
        }));
      }
      return verifier;
    } catch {
      return undefined;
    }
  }

  #settleOne(): void {
    this.#inflight = Math.max(0, this.#inflight - 1);
    const waiter = this.#waiters.shift();
    waiter?.();
  }

  #drainWaiters(): void {
    this.#inflight = 0;
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  failuresSoFar(): number { return this.#failures.length; }

  /**
   * Feed one pack batch. Applies backpressure (bounded batches in flight)
   * so pack bytes never accumulate unboundedly between here and the
   * workers. Never throws; after an infrastructure error it becomes a
   * no-op, because the import will fall back to the post-publish verify
   * anyway.
   */
  async push(rows: readonly StreamVerifyRow[]): Promise<void> {
    if (this.#infraError !== undefined || this.#workers.length === 0) return;
    while (this.#inflight >= STREAM_VERIFY_MAX_INFLIGHT_BATCHES && this.#infraError === undefined) {
      await new Promise<void>((resolve) => { this.#waiters.push(resolve); });
    }
    if (this.#infraError !== undefined) return;
    this.#inflight += 1;
    const worker = this.#workers[this.#nextWorker % this.#workers.length]!;
    this.#nextWorker += 1;
    try {
      worker.postMessage({ kind: "batch", rows });
    } catch (error) {
      this.#infraError = error instanceof Error ? error.message : String(error);
      this.#drainWaiters();
    }
  }

  /** Drains every in-flight batch, stops the workers, and reports. */
  async finish(): Promise<{ readonly status: "verified"; readonly failures: readonly string[] } | { readonly status: "unavailable"; readonly reason: string }> {
    for (const worker of this.#workers) {
      try { worker.postMessage({ kind: "end" }); } catch (error) { this.#infraError = this.#infraError ?? (error instanceof Error ? error.message : String(error)); }
    }
    await Promise.all(this.#finalResults);
    this.abort();
    if (this.#infraError !== undefined && this.#failures.length === 0) return { status: "unavailable", reason: this.#infraError };
    return { status: "verified", failures: [...this.#failures] };
  }

  abort(): void {
    for (const worker of this.#workers) void worker.terminate();
    this.#drainWaiters();
  }
}

export async function verifyCopiedRecordIntegrity(target: WorkspaceDatabase, workspaceId: string, generation: number): Promise<readonly string[]> {
  // Above this row count the pure-CPU decode+digest loop is sharded across
  // worker threads over contiguous record_id ranges (the check is strictly
  // record-local; see `index-pack-verify-worker.ts`). Live VS Code measured
  // the single-threaded loop at 108.6s for ~1M records -- the second-largest
  // import cost after bulk copy. Below the threshold the worker spawn
  // overhead is not worth it and the inline loop below runs unchanged.
  const VERIFY_SHARD_MIN_ROWS = 50_000;
  const total = (await target.database.get<{ c: number }>("SELECT COUNT(*) AS c FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation = ? AND valid_to_generation IS NULL", [workspaceId, generation]))?.c ?? 0;
  if (total >= VERIFY_SHARD_MIN_ROWS) return shardedVerifyCopiedRecordIntegrity(target, workspaceId, generation, total);
  const failures: string[] = [];
  let cursor = "";
  for (;;) {
    const rows = await target.database.all<{ record_id: string; record_digest: string; body_digest: string; body_payload: unknown }>(
      "SELECT record_id, record_digest, body_digest, body_payload FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation = ? AND valid_to_generation IS NULL AND record_id > ? ORDER BY record_id LIMIT ?",
      [workspaceId, generation, cursor, SQL_PAGE_ROWS],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const failure = recordIntegrityFailure(row.record_id, row.record_digest, row.body_digest, row.body_payload === null || row.body_payload === undefined ? null : toBytes(row.body_payload));
      if (failure !== undefined) failures.push(failure);
    }
    cursor = rows[rows.length - 1]!.record_id;
    if (failures.length > 0) break;
  }
  return failures;
}

/**
 * Fan the per-record integrity recompute out over worker threads, each
 * holding its own read-only connection to the target's sqlite file over one
 * contiguous `record_id` keyset range. Boundaries are picked with small-N
 * `OFFSET` probes over the PK index (N-1 index scans total -- bounded and
 * cheap, unlike per-page OFFSET pagination). A shard that fails to run at
 * all (spawn/thread error) THROWS rather than returning an empty failure
 * list: the caller's never-throws wrapper turns that into a skip+fallback,
 * so a broken verify can never be mistaken for a passed one.
 */
async function shardedVerifyCopiedRecordIntegrity(target: WorkspaceDatabase, workspaceId: string, generation: number, totalRows: number): Promise<readonly string[]> {
  const shardCount = Math.max(2, Math.min(8, availableParallelism() - 2));
  const boundaries: string[] = [];
  for (let shard = 1; shard < shardCount; shard += 1) {
    const offset = Math.floor((totalRows * shard) / shardCount);
    const row = await target.database.get<{ record_id: string }>(
      "SELECT record_id FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation = ? AND valid_to_generation IS NULL ORDER BY record_id LIMIT 1 OFFSET ?",
      [workspaceId, generation, offset],
    );
    if (row !== undefined) boundaries.push(row.record_id);
  }
  const uniqueBoundaries = [...new Set(boundaries)].sort();
  const ranges = [...uniqueBoundaries, null].map((end, index) => ({ start: index === 0 ? "" : uniqueBoundaries[index - 1]!, end }));
  const workerEntry = new URL("index-pack-verify-worker.js", import.meta.resolve("@urdira/engine"));
  const shardFailures = await Promise.all(ranges.map((range) => new Promise<readonly string[]>((resolve, reject) => {
    const worker = new Worker(workerEntry, { workerData: { filename: target.database.filename, workspace_id: workspaceId, generation, cursor_start: range.start, cursor_end: range.end, page_rows: SQL_PAGE_ROWS } });
    let settled = false;
    const settle = (run: () => void): void => { if (!settled) { settled = true; run(); } void worker.terminate(); };
    worker.on("message", (message: { readonly kind: string; readonly failures?: readonly string[]; readonly error?: { readonly message: string } }) => {
      settle(() => { if (message.kind === "result" && message.failures !== undefined) resolve(message.failures); else reject(new Error(message.error?.message ?? "verify shard returned an unrecognized message")); });
    });
    worker.on("error", (error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
    worker.on("exit", (code) => { if (!settled) { settled = true; reject(new Error(`index pack verify shard exited with code ${code} before producing a result`)); } });
  })));
  return shardFailures.flat();
}

async function fastPackVerify(target: WorkspaceDatabase, workspaceId: string, manifest: IndexPackManifest, ids: ForkPublicationIds, options?: { readonly skip_record_integrity?: boolean }): Promise<{ readonly ok: boolean; readonly failures: readonly string[] }> {
  const failures: string[] = [];
  const forkVisible = "valid_from_generation = ? AND valid_to_generation IS NULL";
  const expected: Readonly<Record<string, number>> = { record_occurrences: manifest.row_counts.records, identity_assignments: manifest.row_counts.identities, artifact_dependencies: manifest.row_counts.dependencies, projection_occurrences: manifest.row_counts.projections };
  for (const table of Object.keys(expected)) {
    const count = (await target.database.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE workspace_id = ? AND ${forkVisible}`, [workspaceId, ids.generation]))?.c ?? 0;
    if (count !== expected[table]) failures.push(`${table} row count mismatch: pack=${expected[table]} target=${count}`);
  }
  const forkSnapshot = await target.repositories.snapshots.get(ids.snapshotId);
  if (!forkSnapshot) failures.push("snapshot row missing after publish");
  else {
    const recomputed = await computeForkSnapshotDigestFields(target.database, workspaceId, ids.generation);
    if (forkSnapshot.canonical_record_set_digest !== recomputed.canonical_record_set_digest) failures.push("target canonical record-set digest is not self-consistent");
    if (forkSnapshot.projection_set_digests !== recomputed.projection_set_digests) failures.push("target projection-set digests are not self-consistent");
    if (forkSnapshot.canonical_record_set_digest !== manifest.donor_snapshot_anchor.canonical_record_set_digest) failures.push("canonical record-set digest differs from the pack's declared donor anchor");
    if (forkSnapshot.capability_state_digest !== manifest.donor_snapshot_anchor.capability_state_digest) failures.push("capability-state digest differs from the pack's declared donor anchor");
  }
  const ownerMismatches = await target.database.get<{ c: number }>(`SELECT COUNT(*) AS c FROM record_occurrences WHERE workspace_id = ? AND ${forkVisible} AND (owner_artifact_id IS NULL OR owner_artifact_version_id IS NULL)`, [workspaceId, ids.generation]);
  if ((ownerMismatches?.c ?? 0) !== 0) failures.push("target contains records with incomplete remapped ownership");
  const dependencyMismatches = await target.database.get<{ c: number }>(`SELECT COUNT(*) AS c FROM artifact_dependencies WHERE workspace_id = ? AND ${forkVisible} AND (owner_artifact_id IS NULL OR owner_artifact_version_id IS NULL OR dependency_artifact_id IS NULL OR dependency_artifact_version_id IS NULL)`, [workspaceId, ids.generation]);
  if ((dependencyMismatches?.c ?? 0) !== 0) failures.push("target contains dependencies with incomplete remapped ownership");
  const snapshotRow = await target.database.get<{ snapshot_digest: string }>("SELECT snapshot_digest FROM snapshots WHERE workspace_id = ? AND snapshot_id = ?", [workspaceId, ids.snapshotId]);
  if (!snapshotRow) failures.push("snapshot row missing after publish");
  else {
    const decoded = await target.repositories.snapshots.get(ids.snapshotId);
    if (!decoded || snapshotDigest(decoded) !== snapshotRow.snapshot_digest) failures.push("snapshot_digest is not self-consistent with its typed fields");
  }
  // Skipped when the stream-time verify already ran the identical
  // record-local recompute over the pack's own rows (see
  // `IndexPackStreamVerifier`): what it cannot re-prove -- "did bulkCopy
  // land every row faithfully" -- is exactly what the row counts, recomputed
  // anchors and ownership checks above cover.
  if (options?.skip_record_integrity !== true) failures.push(...(await verifyCopiedRecordIntegrity(target, workspaceId, ids.generation)));
  return { ok: failures.length === 0, failures };
}

async function attemptIndexPackImportInner(options: IndexPackImportOptions): Promise<IndexPackImportOutcome> {
  /* c8 ignore next -- production daemon bypasses the compatibility copier; injected-core coverage belongs to the daemon integration gate. */
  if (options.indexing_core !== undefined) {
    return { status: "skipped", reason: "Rust indexing-core owns production structural publication; pack bulk-copy remains compatibility-only." };
  }
  const context = buildContext(options);
  const workspaceId = options.workspace.workspace_id;
  const maxDiffEntries = options.max_diff_entries ?? DEFAULT_MAX_DIFF_ENTRIES;

  const enumeration: ForkEnumeration | undefined = await enumerateForkRoot(options as unknown as WorkspaceForkOptions, context);
  if (enumeration === undefined) return { status: "skipped", reason: "enumeration of the newly added workspace's root did not succeed" };
  try {
    return await importAfterEnumeration(options, context, enumeration, workspaceId, maxDiffEntries);
  } finally {
    // Every exit -- a compatibility/multiset skip before any durable write,
    // a rollback, or a completed import whose read pass left unclaimed
    // entries -- must return the byte hand-off budget the enumeration's
    // prefetch is still holding (see `DirectorySourceProvider.abortPrefetch`).
    await enumeration.provider.abortPrefetch();
  }
}

async function importAfterEnumeration(options: IndexPackImportOptions, context: ForkContext, enumeration: ForkEnumeration, workspaceId: string, maxDiffEntries: number): Promise<IndexPackImportOutcome> {
  const targetMultisetEntries = enumeration.observations.map((observation) => [observation.normalized_uri, observation.observed_content_hash] as const);
  const targetMultisetKey = multisetKey(targetMultisetEntries);

  const lines = readPackLines(options.pack_path);
  const first = await lines.next();
  if (first.done || first.value.kind !== "manifest") return { status: "skipped", reason: "index pack is missing its manifest header line" };
  const manifest = first.value.manifest;
  if (manifest.schema_version !== INDEX_PACK_SCHEMA_VERSION) return { status: "skipped", reason: `index pack schema_version ${String(manifest.schema_version)} is not supported` };
  if (manifestDigest(manifest) !== manifest.manifest_digest) return { status: "skipped", reason: "index pack manifest digest does not match its declared content (transport corruption or tamper)" };

  const targetStorageFormatVersion = (await readWorkspaceMetaNumber(options.database, "storage_format_version")) ?? 0;
  const targetIdentityFormat = await readWorkspaceMetaNumber(options.database, "identity_format");
  if (manifest.compatibility.storage_format_version !== targetStorageFormatVersion) return { status: "skipped", reason: `incompatible storage format version: pack=${manifest.compatibility.storage_format_version} target=${String(targetStorageFormatVersion)}` };
  if (manifest.compatibility.identity_format !== targetIdentityFormat) return { status: "skipped", reason: `incompatible identity format: pack=${manifest.compatibility.identity_format} target=${String(targetIdentityFormat)}` };
  const targetResolvedPlugins = (options.plugin.resolution_lock as unknown as { readonly resolved_plugins?: readonly unknown[] }).resolved_plugins ?? [];
  if (manifest.compatibility.resolved_plugins_digest !== sortedResolvedPluginsDigest(targetResolvedPlugins)) return { status: "skipped", reason: "incompatible plugin resolution (plugin_version axis mismatch)" };
  const targetAnalysisConfigurationDigest = (options.plugin.configuration as unknown as { readonly analysis_configuration_digest?: string }).analysis_configuration_digest ?? "";
  if (manifest.compatibility.analysis_configuration_digest !== targetAnalysisConfigurationDigest) return { status: "skipped", reason: "incompatible analysis_configuration_digest axis" };

  const packMultisetEntries: (readonly [string, string])[] = [];
  let cursorLine = await lines.next();
  while (!cursorLine.done && cursorLine.value.kind === "multiset") {
    for (const row of cursorLine.value.rows as readonly (readonly [string, string])[]) packMultisetEntries.push(row);
    cursorLine = await lines.next();
  }
  if (packMultisetEntries.length !== manifest.row_counts.multiset) return { status: "skipped", reason: `index pack multiset row count mismatch: declared=${manifest.row_counts.multiset} actual=${packMultisetEntries.length}` };
  const packMultisetKeyValue = multisetKey(packMultisetEntries);
  if (digestBytes(new TextEncoder().encode(packMultisetKeyValue)) !== manifest.multiset_digest) return { status: "skipped", reason: "index pack multiset digest does not match its declared content" };
  if (packMultisetKeyValue !== targetMultisetKey) return { status: "skipped", reason: `index pack content does not match the newly added workspace's root: ${multisetDiff(packMultisetEntries, targetMultisetEntries, maxDiffEntries)}` };

  const uriMap = new Map<string, DonorArtifactEntry>();
  for (const [uri, contentHash] of packMultisetEntries) uriMap.set(uri, { artifact_id: stableId("index-pack-donor-artifact", { uri }), artifact_version_id: stableId("index-pack-donor-artifact-version", { uri, contentHash }), content_hash: contentHash });

  // Durable phase begins here: everything before this point only reads (the
  // target root's enumeration, the pack file, the target's own already-
  // published control-plane rows). From here on, every failure must roll
  // back what this attempt wrote -- mirrors `commitSourceLayerAndPublish`'s
  // reasoning in `workspace-fork.ts` exactly, including the "documented
  // incident" it guards against: a partial commit that never rolls back
  // leaves this workspace permanently wedged for the fallback full scan too.
  const observationBatchId = enumeration.observationBatchId;
  const candidateId = stableId("index-pack-import-candidate", { workspace_id: workspaceId, manifest_digest: manifest.manifest_digest, observation_batch_id: observationBatchId });
  const ids: ForkPublicationIds = { candidateId, materializationId: `materialization:${candidateId}`, snapshotId: `snapshot:${candidateId}`, generationManifestId: `generation-manifest:${candidateId}`, generation: 1 };

  const rollbackAndSkip = async (reason: string): Promise<IndexPackImportOutcome> => {
    console.error(`[urdira] index pack import for ${workspaceId} (pack ${manifest.pack_id}) failed after its source layer was durably committed; rolling back so the fallback full scan can publish a fresh generation instead of getting permanently stuck: ${reason}`);
    await rollbackForkPublication(options.database, workspaceId, ids, options.indexing_core);
    return { status: "skipped", reason };
  };

  // The source-layer commit (I/O bound: streaming every workspace file into
  // CAS) and the scratch-donor build + stream-time verify (decode+digest
  // offloaded to verify worker threads) share no data -- the scratch needs
  // only `uriMap`, built before the durable boundary -- so they run
  // CONCURRENTLY: the verify cost that used to be its own post-publish pass
  // (~70s wall at VS Code scale) now hides inside the commit's I/O window,
  // and a corrupt pack is rejected before bulkCopy/publish ever run.
  //
  // THE ONE HARD SEQUENCING RULE: nothing may call `rollbackAndSkip` until
  // the commit promise below has SETTLED. A rollback racing a still-writing
  // source-layer commit could delete rows the commit then re-adds -- exactly
  // the permanently-wedged half-committed state this module exists to
  // prevent. `buildScratchAndStreamVerify` never throws, so the single
  // `await` ordering below enforces the rule structurally.
  const sourceLayerSettled: Promise<{ readonly ok: true; readonly layer: ForkSourceLayer | undefined } | { readonly ok: false; readonly error: unknown }> =
    commitForkSourceLayer(options as unknown as WorkspaceForkOptions, context, enumeration)
      .then((layer) => ({ ok: true as const, layer }), (error: unknown) => ({ ok: false as const, error }));

  const buildScratchAndStreamVerify = async (): Promise<{ readonly scratch: ScratchDonorDatabase | undefined; readonly capabilityStateEntries: unknown[]; readonly failure?: string; readonly streamVerified: boolean }> => {
    const capabilityStateEntries: unknown[] = [];
    const verifier = IndexPackStreamVerifier.create();
    let builtScratch: ScratchDonorDatabase | undefined;
    try {
      builtScratch = await ScratchDonorDatabase.create(`index-pack-donor:${workspaceId}`);
      const rowCounts = { records: 0, value_nodes: 0, facets: 0, identities: 0, dependencies: 0, projections: 0, capability_state: 0 };
      let corruptionSeen = false;
      while (!cursorLine.done) {
        const value = cursorLine.value;
        if (value.kind === "end") break;
        if (value.kind === "records") {
          timedSync("index_pack_import_scratch_insert", () => builtScratch!.insertRecords(value.rows as readonly Record<string, unknown>[], uriMap));
          rowCounts.records += value.rows.length;
          if (verifier !== undefined) await timed("index_pack_stream_verify_backpressure", () => verifier.push(value.rows as readonly StreamVerifyRow[]));
        }
        else if (value.kind === "value_nodes") { timedSync("index_pack_import_scratch_insert", () => builtScratch!.insertValueNodes(value.rows as readonly Record<string, unknown>[])); rowCounts.value_nodes += value.rows.length; }
        else if (value.kind === "facets") { timedSync("index_pack_import_scratch_insert", () => builtScratch!.insertFacets(value.rows as readonly Record<string, unknown>[])); rowCounts.facets += value.rows.length; }
        else if (value.kind === "identities") { timedSync("index_pack_import_scratch_insert", () => builtScratch!.insertIdentities(value.rows as readonly Record<string, unknown>[])); rowCounts.identities += value.rows.length; }
        else if (value.kind === "dependencies") { timedSync("index_pack_import_scratch_insert", () => builtScratch!.insertDependencies(value.rows as readonly Record<string, unknown>[], uriMap)); rowCounts.dependencies += value.rows.length; }
        else if (value.kind === "projections") { timedSync("index_pack_import_scratch_insert", () => builtScratch!.insertProjections(value.rows as readonly Record<string, unknown>[], uriMap)); rowCounts.projections += value.rows.length; }
        else if (value.kind === "capability_state") { capabilityStateEntries.push(...value.rows); rowCounts.capability_state += value.rows.length; }
        else if (value.kind !== "multiset") fail(`index pack contains an unrecognized section kind`);
        // Fail fast on the first confirmed corrupt record: no point streaming
        // the rest of a pack that is already rejected. The definite failure
        // list comes out of `finish()` below either way.
        if (verifier !== undefined && verifier.failuresSoFar() > 0) { corruptionSeen = true; break; }
        cursorLine = await lines.next();
      }
      if (!corruptionSeen) {
        for (const key of Object.keys(rowCounts) as (keyof typeof rowCounts)[]) {
          if (rowCounts[key] !== manifest.row_counts[key]) fail(`index pack row count mismatch for ${key}: declared=${manifest.row_counts[key]} actual=${rowCounts[key]}`);
        }
        // Flush whatever partial SCRATCH_DONOR_BATCH_TX_ROWS batch is still
        // open so the bulkCopy* reads below (via scratch.handle()) run
        // against a fully committed scratch database.
        builtScratch.finalizeWrites();
      }
      const stream = verifier === undefined ? { status: "unavailable" as const } : await timed("index_pack_stream_verify_finish", () => verifier.finish());
      if (stream.status === "verified" && stream.failures.length > 0) {
        return { scratch: builtScratch, capabilityStateEntries, failure: `stream verify rejected the pack: ${stream.failures[0]!}${stream.failures.length > 1 ? ` (+${stream.failures.length - 1} more)` : ""}`, streamVerified: false };
      }
      if (corruptionSeen) {
        // Failures were observed mid-stream but the workers could not report
        // a final verdict (infrastructure trouble). Definite enough to skip.
        return { scratch: builtScratch, capabilityStateEntries, failure: "stream verify observed corrupt records but could not complete", streamVerified: false };
      }
      return { scratch: builtScratch, capabilityStateEntries, streamVerified: stream.status === "verified" };
    } catch (error) {
      verifier?.abort();
      return { scratch: builtScratch, capabilityStateEntries, failure: error instanceof IndexPackFormatError ? error.message : `index pack scratch build threw: ${error instanceof Error ? error.message : String(error)}`, streamVerified: false };
    }
  };
  const scratchOutcome = await buildScratchAndStreamVerify();
  const sourceOutcome = await sourceLayerSettled;

  const scratch: ScratchDonorDatabase | undefined = scratchOutcome.scratch;
  const streamVerified = scratchOutcome.streamVerified;
  const capabilityStateEntries = scratchOutcome.capabilityStateEntries;
  try {
    if (!sourceOutcome.ok) return await rollbackAndSkip(`source cataloging threw: ${sourceOutcome.error instanceof Error ? sourceOutcome.error.message : String(sourceOutcome.error)}`);
    const sourceLayer = sourceOutcome.layer;
    if (sourceLayer === undefined) return await rollbackAndSkip("source cataloging for the index pack target did not produce any eligible files");
    if (scratchOutcome.failure !== undefined) return await rollbackAndSkip(scratchOutcome.failure);
    if (scratch === undefined) return await rollbackAndSkip("index pack scratch donor database was never created");

    const donorArtifacts: readonly DonorVisibleArtifact[] = [...uriMap.entries()].map(([uri, entry]) => ({ artifact_id: entry.artifact_id, artifact_version_id: entry.artifact_version_id, normalized_uri: uri, content_hash: entry.content_hash }));
    const map: DonorRowMap = buildFullArtifactMap(donorArtifacts, sourceLayer);
    for (const artifact of donorArtifacts) if (!map.byArtifactVersionId.has(artifact.artifact_version_id)) fail(`invariant violation: index pack artifact ${artifact.normalized_uri} has no counterpart in the import target's fresh source layer despite a passed multiset check`);

    const target = options.database;
    await timed("index_pack_import_bulk_copy", () => bulkCopyRecordsAndIdentities(target, scratch!.handle(), 1, workspaceId, map));
    await timed("index_pack_import_bulk_copy", () => bulkCopyDependencies(target, scratch!.handle(), 1, workspaceId, map));
    const projectionPatchCount = await timed("index_pack_import_bulk_copy", () => bulkCopyProjections(target, scratch!.handle(), 1, workspaceId, map));

    const publishedAt = context.now();
    const digestFields = await computeForkSnapshotDigestFields(target.database, workspaceId, ids.generation);
    const identityIdRows = await target.database.all<{ identity_assignment_id: string }>("SELECT identity_assignment_id FROM identity_assignments WHERE workspace_id = ? AND valid_from_generation = ? AND valid_to_generation IS NULL", [workspaceId, ids.generation]);

    const targetRegistry = options.plugin.registry as unknown as RegistrySnapshot;
    const targetResolutionLock = options.plugin.resolution_lock as unknown as PluginResolutionLock;
    const targetConfiguration = options.plugin.configuration as unknown as WorkspaceConfigurationRevision;
    const checkpointPayload = { workspace_id: workspaceId, source_state_digest: sourceLayer.source_state_digest, provider_watermarks: JSON.stringify({}), verification_status: "equivalent", unavailable_artifact_ids: "[]", verified_at: publishedAt };
    const freshnessCheckpoint = { freshness_checkpoint_id: stableId("index-pack-import-freshness-checkpoint", { ...checkpointPayload, candidateId }), ...checkpointPayload, checkpoint_digest: digestBytes(canonicalBytes(checkpointPayload)) } as unknown as WorkspaceFreshnessCheckpoint;

    await target.repositories.registries.putSnapshot(targetRegistry);

    const planInput: ForkPublicationPlanInput = {
      workspaceId, candidateId, generation: ids.generation, publishedAt,
      sourceObservationBatchIds: normalizeObservationBatchIds([sourceLayer.observation_batch_id]),
      sourceStateDigest: sourceLayer.source_state_digest,
      canonicalRecordSetDigest: digestFields.canonical_record_set_digest,
      projectionSetDigests: digestFields.projection_set_digests,
      recordOpenSetEntries: digestFields.visible_records,
      identityAssignmentSetEntries: identityIdRows,
      targetRegistry, targetResolutionLock, targetConfiguration, freshnessCheckpoint,
      capabilityStateEntries,
      sourceSnapshotId: sourceLayer.source_snapshot_id,
      triggerKind: "core:index_pack_import",
    };
    const plan = buildForkPublicationPlan(planInput);
    try {
      await timed("index_pack_import_publish_transaction", () => target.database.transactionChunked(publicationTransactionCommands(plan), undefined, { transfer_params: true, discard_results: true }));
    } catch (error) {
      fail(`index pack publication failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const verifyMode = options.verify_mode ?? "fast";
    let verifyOk: boolean;
    let verifyDetail: unknown;
    if (verifyMode === "full") {
      const verification = await timed("index_pack_import_verify", () => target.maintenance.verify());
      verifyDetail = verification.failures;
      // Same pre-existing, documented `StorageMaintenance.verify()` gaps
      // `workspace-fork.ts`'s `copyDonorAndPublish` filters (registry
      // digest, plugin-resolution-lock CAS reference, freshness-checkpoint
      // shape, empty-projection-set digest) -- they affect any normally
      // scanned workspace, not something this module's own copy introduces;
      // see `isKnownPreexistingVerifyGap`'s doc comment for the specifics.
      verifyOk = verification.failures.filter((failure) => !isKnownPreexistingVerifyGap(failure)).length === 0;
      const integrityFailures = await timed("index_pack_import_verify", () => verifyCopiedRecordIntegrity(target, workspaceId, ids.generation));
      if (integrityFailures.length > 0) { verifyOk = false; verifyDetail = [...(verifyDetail as readonly unknown[]), ...integrityFailures]; }
    } else {
      const fast = await timed("index_pack_import_verify", () => fastPackVerify(target, workspaceId, manifest, ids, { skip_record_integrity: streamVerified }));
      verifyOk = fast.ok;
      verifyDetail = fast.failures;
    }
    if (!verifyOk) {
      console.error(`[urdira] index pack import verify (${verifyMode}) failed for ${workspaceId} (pack ${manifest.pack_id}):`, JSON.stringify(verifyDetail));
      fail(`verify (${verifyMode}) failed after index pack publication`);
    }

    return { status: "imported", donor_workspace_id: manifest.donor_workspace_id, snapshot_id: ids.snapshotId, generation: ids.generation, projection_patch_count: projectionPatchCount };
  } catch (error) {
    return await rollbackAndSkip(error instanceof IndexPackFormatError ? error.message : `index pack copy/publish threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await scratch?.close();
  }
}

// =============================================================================
// v4 (index_contract 0x34, P2-4): a NEW, separate pack container.
//
// Everything above this line is the v3 pack format (untouched): gzip-
// compressed tagged NDJSON of RELATIONAL ROWS (`record_occurrences`,
// `graph_edges`, ...), imported by replaying those rows through the same
// `bulkCopy*` functions a local fork uses. A v4 workspace's structural
// corpus has no row-level representation at all -- it is a binary mmap
// segment store (`crates/urdira-structural-store`) -- so that format
// cannot represent it; per this task's brief, v4 export/import instead use
// a NEW simple container (a `.urdira-index-pack-v4` file: gzip-compressed,
// one small JSON manifest followed by whole files concatenated in the
// order the manifest lists them), gated entirely separately from the v3
// code above. `exportV4IndexPack`/`importV4IndexPack` stream file bytes
// through (never buffering a whole `structural/merkle/<set>.tree` file,
// which is a fixed ~35.8 MB regardless of corpus size -- see
// `docs/evidence/2026-09-02-v4-p0-s3-merkle-bucket.md` -- so a v4 pack is
// at minimum ~140 MB before compression, even for a tiny fixture).
//
// Directly tested (`tests/index-pack-v4.test.ts`) and, since plan
// `generic-waddling-hartmanis.md` §7.1 (Frente P-1), wired into the daemon:
// `core:index_pack_export` (`packages/daemon/src/runtime.ts`) branches to
// `exportV4IndexPack` for a native-structural-store workspace via
// `index-pack-export-v4-worker-thread.ts`, and `runV4WorkspaceScan`'s
// first-scan branch imports a pending `--index-pack` path via
// `importV4IndexPack` (staged, then renamed atomically over the paths
// `ensureV4Workspace` just bootstrapped) before handing the workspace to a
// `reconcile` scan. NOT wired into `attemptIndexPackImport`'s v3
// orchestration above -- see `workspace-fork.ts`'s matching v4 section for
// why that one stays a compatibility-only oracle.
// =============================================================================

export const V4_INDEX_PACK_FORMAT = "urdira-index-pack-v4" as const;
export const V4_INDEX_PACK_SCHEMA_VERSION = 1 as const;

export interface V4IndexPackFileEntry {
  /** Posix-style, relative to the pack root: `"workspace.sqlite"`, or
   * `"structural/<...>"` / `"sidecar/<...>"` for everything under those
   * directories (recursively). */
  readonly path: string;
  readonly byte_length: number;
}

export interface V4IndexPackManifest {
  readonly format: typeof V4_INDEX_PACK_FORMAT;
  readonly schema_version: typeof V4_INDEX_PACK_SCHEMA_VERSION;
  readonly workspace_id: string;
  readonly generation: number;
  /** From `merkle_roots` at `generation` (`sha256:`-prefixed hex); empty
   * until the donor has completed at least one cold scan. */
  readonly roots: Readonly<Record<string, string>>;
  readonly canonical_record_set_digest: string;
  readonly source_state_digest: string;
  readonly files: readonly V4IndexPackFileEntry[];
}

async function walkV4PackDirectory(root: string, posixPrefix: string): Promise<{ readonly path: string; readonly absolutePath: string }[]> {
  const out: { readonly path: string; readonly absolutePath: string }[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    // Deterministic order: two exports of the identical store produce a
    // byte-identical pack, which is also what makes the "flip one byte"
    // corruption test in `tests/index-pack-v4.test.ts` target a
    // predictable offset.
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = join(directory, entry.name);
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(absolutePath, path);
      else if (entry.isFile()) out.push({ path, absolutePath });
    }
  }
  if (existsSync(root)) await walk(root, posixPrefix);
  return out;
}

export interface ExportV4IndexPackOptions {
  readonly databasePath: string;
  readonly structuralRoot: string;
  readonly sidecarRoot?: string;
  readonly workspaceId: string;
  readonly outputPath: string;
  /** Same `--require-git-clean` contract as `ExportIndexPackOptions` (v3,
   * above): reject the export outright if `canonicalRoot`'s git worktree has
   * uncommitted changes, rather than silently packing a source state a
   * later `git diff` cannot reproduce. */
  readonly requireGitClean?: boolean;
  readonly canonicalRoot?: string;
  readonly gitObjects?: GitObjectPort;
  readonly now?: () => string;
}

/** Thrown by `exportV4IndexPack` when the catalog's `current_generation` changed between the start and the end of the export (a concurrent scan published mid-export) -- see that function's doc comment. An explicit `name` (the default `Error` subclass leaves `.name === "Error"`) matters here because this error crosses a `node:worker_threads` boundary as a plain serialized `{ name, message, code }` (`index-pack-export-v4-worker-thread.ts`'s `errorDetails`/`index-pack-export-v4-thread.ts`'s `threadError`) before `core:index_pack_export`'s handler (`packages/daemon/src/runtime.ts`) can decide whether to retry -- without a distinguishing name that decision would have no reliable signal to key off besides matching the message string. */
export class IndexPackExportRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexPackExportRaceError";
  }
}

async function readV4CurrentGeneration(databasePath: string, workspaceId: string): Promise<number> {
  const database = await openSqliteDatabase({ filename: databasePath, read_only: true });
  try {
    const current = await database.get<{ current_generation: number }>("SELECT current_generation FROM workspace_current_state WHERE workspace_id = ?", [workspaceId]);
    return current?.current_generation ?? 0;
  } finally {
    await database.close();
  }
}

/**
 * Writes a v4 index pack to `options.outputPath`: `workspace.sqlite` (the
 * catalog), everything under `structural/` (segments, dictionaries, the
 * `merkle/*.tree` files), and everything under `sidecar/` if it exists.
 * `roots`/`canonical_record_set_digest`/`source_state_digest` in the
 * manifest are read straight from the catalog's `merkle_roots`/`snapshots`
 * rows (the same authorities `packages/engine/src/v4-verify.ts` checks
 * against) -- not recomputed here, so an already-corrupt donor produces a
 * pack whose manifest reports its existing (wrong) values rather than
 * silently repairing them; `importV4IndexPack` independently re-derives
 * roots from the copied `.tree` files, so a mismatch is still caught on
 * import, not just trusted from the manifest.
 */
export async function exportV4IndexPack(options: ExportV4IndexPackOptions): Promise<{ readonly packPath: string; readonly manifest: V4IndexPackManifest }> {
  if (options.requireGitClean) {
    if (options.canonicalRoot === undefined) throw new Error("v4 index pack export: requireGitClean was requested without a canonicalRoot to check");
    const now = options.now ?? (() => new Date().toISOString());
    const admin = await administrativeState(options.canonicalRoot, options.gitObjects ?? ISOMORPHIC_GIT_OBJECT_PORT, now);
    if (admin.vcs_state.dirty) throw new Error("v4 index pack export: workspace root has uncommitted changes (requireGitClean)");
  }
  // Adversarial-review fix (plan §7.1 review, item 5): read the generation
  // BEFORE walking `structural/`/`sidecar/` (below, potentially the
  // slowest part of an export -- tens to hundreds of MB) as well as after,
  // and reject the export if a concurrent scan advanced the generation
  // in between. Several `structural/` files are fixed-name and rewritten
  // IN PLACE across generations, not append-only (`urdira-structural-store`'s
  // `merkle::persist` overwrites `records.tree`/`dependency.tree` at the
  // same path every publish) -- so a walk straddling a concurrent publish
  // could read a torn mix of old- and new-generation bytes for those files
  // while `roots`/`generation` below end up reflecting whichever side of
  // the publish the LATER SQL read happened to land on. The daemon's
  // `core:index_pack_export` handler already gates on `scanInFlight` before
  // calling this function, which should make this window vanishingly rare
  // in practice -- this is the defense for the residual TOCTOU gap between
  // that check and this function's own, slower, file I/O (a new scan
  // request racing in after the gate passed). A torn `structural/` file
  // that slips through despite this check is still independently caught by
  // `importV4IndexPack`'s own Merkle root re-derivation on the IMPORT side
  // (`roots_verified: false` -> the daemon falls back to a full scan) --
  // this check exists to fail loudly and immediately at EXPORT time instead
  // of silently shipping a pack whose corruption is discovered, if ever,
  // only much later at import.
  const generationBefore = await readV4CurrentGeneration(options.databasePath, options.workspaceId);

  const files = [
    { path: "workspace.sqlite", absolutePath: options.databasePath },
    ...(await walkV4PackDirectory(options.structuralRoot, "structural")),
    ...(await walkV4PackDirectory(options.sidecarRoot ?? "", "sidecar")),
  ];
  const sized = await Promise.all(files.map(async (file) => ({ ...file, byte_length: (await stat(file.absolutePath)).size })));

  const database = await openSqliteDatabase({ filename: options.databasePath, read_only: true });
  let generation = 0;
  const roots: Record<string, string> = {};
  let canonicalRecordSetDigest = "";
  let sourceStateDigest = "";
  try {
    const current = await database.get<{ current_generation: number }>("SELECT current_generation FROM workspace_current_state WHERE workspace_id = ?", [options.workspaceId]);
    generation = current?.current_generation ?? 0;
    if (generation > 0) {
      const merkleRoots = await database.all<{ set_kind: string; root: Uint8Array; member_count: number }>("SELECT set_kind, root, member_count FROM merkle_roots WHERE generation = ?", [generation]);
      for (const row of merkleRoots) roots[row.set_kind] = `sha256:${Buffer.from(row.root).toString("hex")}`;
      const snapshot = await database.get<{ canonical_record_set_digest: string; source_state_digest: string }>("SELECT canonical_record_set_digest, source_state_digest FROM snapshots WHERE workspace_id = ? AND generation = ?", [options.workspaceId, generation]);
      canonicalRecordSetDigest = snapshot?.canonical_record_set_digest ?? "";
      sourceStateDigest = snapshot?.source_state_digest ?? "";
    }
  } finally {
    await database.close();
  }

  if (generation !== generationBefore) {
    throw new IndexPackExportRaceError(
      `v4 index pack export for ${options.workspaceId}: generation changed from ${generationBefore} to ${generation} while exporting (a scan published concurrently) -- the pack would be internally inconsistent; retry once the workspace is idle`,
    );
  }

  const manifest: V4IndexPackManifest = {
    format: V4_INDEX_PACK_FORMAT,
    schema_version: V4_INDEX_PACK_SCHEMA_VERSION,
    workspace_id: options.workspaceId,
    generation,
    roots,
    canonical_record_set_digest: canonicalRecordSetDigest,
    source_state_digest: sourceStateDigest,
    files: sized.map(({ path, byte_length }) => ({ path, byte_length })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32LE(manifestBytes.length, 0);

  await mkdir(dirname(options.outputPath), { recursive: true });
  async function* source(): AsyncGenerator<Buffer> {
    yield lengthPrefix;
    yield manifestBytes;
    for (const file of sized) {
      for await (const chunk of createReadStream(file.absolutePath)) yield chunk as Buffer;
    }
  }
  await pipeline(Readable.from(source()), createGzip(), createWriteStream(options.outputPath));
  return { packPath: options.outputPath, manifest };
}

/** Pull-based reader over an async byte stream: lets `importV4IndexPack`
 * read the manifest length prefix, the manifest itself, and then each
 * file's exact byte range in turn, without ever buffering more than one
 * upstream chunk beyond what a caller asked for. */
class V4PackStreamReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);
  private pendingOffset = 0;

  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async ensure(): Promise<boolean> {
    if (this.pendingOffset < this.pending.length) return true;
    const { value, done } = await this.iterator.next();
    if (done === true || value === undefined) return false;
    this.pending = value;
    this.pendingOffset = 0;
    return true;
  }

  async readExactly(length: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      if (!(await this.ensure())) throw new IndexPackFormatError("v4 index pack stream ended before the expected number of bytes was read");
      const take = Math.min(this.pending.length - this.pendingOffset, remaining);
      parts.push(this.pending.subarray(this.pendingOffset, this.pendingOffset + take));
      this.pendingOffset += take;
      remaining -= take;
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, length);
  }

  async pipeExactlyTo(length: number, destination: NodeJS.WritableStream): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      if (!(await this.ensure())) throw new IndexPackFormatError("v4 index pack stream ended before the expected number of bytes was read");
      const take = Math.min(this.pending.length - this.pendingOffset, remaining);
      const chunk = Buffer.from(this.pending.subarray(this.pendingOffset, this.pendingOffset + take));
      this.pendingOffset += take;
      remaining -= take;
      await new Promise<void>((resolve, reject) => destination.write(chunk, (error) => (error ? reject(error) : resolve())));
    }
  }
}

function v4PackDestinationPath(entryPath: string, options: { readonly targetDatabasePath: string; readonly targetStructuralRoot: string; readonly targetSidecarRoot?: string }): string {
  if (entryPath === "workspace.sqlite") return options.targetDatabasePath;
  if (entryPath.startsWith("structural/")) return join(options.targetStructuralRoot, entryPath.slice("structural/".length));
  if (entryPath.startsWith("sidecar/")) {
    if (options.targetSidecarRoot === undefined) throw new IndexPackFormatError(`v4 index pack contains a sidecar entry (${entryPath}) but no targetSidecarRoot was given`);
    return join(options.targetSidecarRoot, entryPath.slice("sidecar/".length));
  }
  throw new IndexPackFormatError(`v4 index pack contains an entry outside the known roots: ${entryPath}`);
}

export interface ImportV4IndexPackOptions {
  readonly packPath: string;
  readonly targetDatabasePath: string;
  readonly targetStructuralRoot: string;
  readonly targetSidecarRoot?: string;
  /** Decidido en implementación (plan `generic-waddling-hartmanis.md` §7.1,
   * R17): the workspace id the imported catalog must be bound to on THIS
   * installation -- almost never the donor's own `manifest.workspace_id`
   * (two installations mint independent ids for what may be the same
   * canonical root). Optional -- defaults to `manifest.workspace_id` (a
   * no-op rewrite), which keeps every existing direct caller of this
   * function (donor id === target id, e.g. `tests/index-pack-v4.test.ts`'s
   * plain round-trip tests) unchanged; a real cross-installation import
   * (the daemon's `runV4WorkspaceScan` slot) always passes the real target
   * id explicitly. Re-pinning happens unconditionally whenever it IS given
   * (a no-op when it happens to already match) so `storage.openWorkspace`'s
   * `bindWorkspaceIdentity` never sees a foreign id and throws
   * `storage:workspace_binding_mismatch`. */
  readonly targetWorkspaceId?: string;
}

export interface ImportV4IndexPackResult {
  readonly manifest: V4IndexPackManifest;
  readonly roots_verified: boolean;
  readonly root_mismatches: readonly string[];
}

/**
 * Extracts a v4 index pack written by `exportV4IndexPack` to the given
 * target paths, then independently re-derives each `merkle/<set>.tree`
 * file's own root/count from the JUST-WRITTEN bytes (`readTreeFile`, the
 * same reader `packages/engine/src/v4-verify.ts` and `workspace-fork.ts`'s
 * `verifyV4ForkRoots` use) and compares it against the manifest's `roots` --
 * this is what makes import verification independent of the manifest's own
 * claims (see `exportV4IndexPack`'s doc comment) rather than a pass-through
 * trust of whatever the exporter said.
 */
export async function importV4IndexPack(options: ImportV4IndexPackOptions): Promise<ImportV4IndexPackResult> {
  const gunzipped = createReadStream(options.packPath).pipe(createGunzip());
  const reader = new V4PackStreamReader(gunzipped as unknown as AsyncIterable<Buffer>);
  const manifestLength = (await reader.readExactly(4)).readUInt32LE(0);
  const manifest = JSON.parse((await reader.readExactly(manifestLength)).toString("utf8")) as V4IndexPackManifest;
  if (manifest.format !== V4_INDEX_PACK_FORMAT) throw new IndexPackFormatError(`unrecognized v4 index pack format: ${String((manifest as { format?: unknown }).format)}`);
  if (manifest.schema_version !== V4_INDEX_PACK_SCHEMA_VERSION) throw new IndexPackFormatError(`unsupported v4 index pack schema_version: ${String((manifest as { schema_version?: unknown }).schema_version)}`);

  for (const file of manifest.files) {
    const destinationPath = v4PackDestinationPath(file.path, options);
    await mkdir(dirname(destinationPath), { recursive: true });
    const writeStream = createWriteStream(destinationPath);
    await reader.pipeExactlyTo(file.byte_length, writeStream);
    await new Promise<void>((resolve, reject) => writeStream.end((error?: Error | null) => (error ? reject(error) : resolve())));
  }

  const mismatches: string[] = [];
  for (const [setKind, expectedRoot] of Object.entries(manifest.roots)) {
    const file = await readTreeFile(join(options.targetStructuralRoot, "merkle", `${setKind}.tree`));
    if (file === undefined) { mismatches.push(`${setKind}: expected in manifest but missing after import`); continue; }
    if (file.headerRoot !== expectedRoot) mismatches.push(`${setKind}: header root differs from the manifest's`);
    if (file.recomputedRoot !== file.headerRoot) mismatches.push(`${setKind}: imported file's own bucket levels no longer match its header root`);
  }

  // R17 (plan §7.1.2): re-pin the just-copied catalog to THIS installation's
  // workspace id. `rewriteV4WorkspaceIdentity` is generic over every TEXT
  // column (`workspace-fork.ts`'s doc comment) but deliberately skips
  // `workspace_meta.value`, which is a BLOB (canonical-encoded), not TEXT --
  // so the one row that actually gates `storage.openWorkspace`
  // (`bindWorkspaceIdentity`) needs its own direct `UPDATE`. Unconditional
  // (not gated on `manifest.workspace_id !== options.targetWorkspaceId`):
  // `rewriteV4WorkspaceIdentity` itself is a no-op when the ids already
  // match, and re-running the `UPDATE`/digest recompute in that case just
  // writes back the same bytes -- simpler than a second identity comparison
  // here that could drift from the one inside `rewriteV4WorkspaceIdentity`.
  const targetWorkspaceId = options.targetWorkspaceId ?? manifest.workspace_id;
  const database = await openSqliteDatabase({ filename: options.targetDatabasePath });
  try {
    await rewriteV4WorkspaceIdentity(database, manifest.workspace_id, targetWorkspaceId);
    // Not created if absent (R17: `bindWorkspaceIdentity` mints it on the
    // workspace's first open) -- a `WHERE key = 'workspace_id'` `UPDATE`
    // against a row that does not exist yet simply affects zero rows.
    await database.run("UPDATE workspace_meta SET value = ? WHERE key = 'workspace_id'", [encodeCanonical(targetWorkspaceId)]);
    await recomputeV4SnapshotDigestsAfterRewrite(database);
  } finally {
    await database.close();
  }

  return { manifest, roots_verified: mismatches.length === 0, root_mismatches: mismatches };
}
