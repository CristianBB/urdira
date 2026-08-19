import { decodeCanonical, encodeCanonical } from "@urdira/canonical";
import type { WorkspaceDatabase } from "@urdira/storage";

/**
 * Minimal content-addressed reader the reconciler needs to fetch a version's
 * raw bytes by `content_hash`; `ContentAddressedStore` (`@urdira/storage`,
 * `DurableStorage.cas`) satisfies this directly, same as
 * `CanonicalQuerySnapshotPort`'s `ContentReader` shape in
 * `canonical-query-data-port.ts`.
 */
export interface LexicalReconcilerContentReader {
  readonly read: (content_hash: string) => Promise<Uint8Array>;
}

export interface ReconcileLexicalProjectionInput {
  readonly database: WorkspaceDatabase;
  readonly workspace_id: string;
  readonly content: LexicalReconcilerContentReader;
  /**
   * Documents whose declared `byte_length` exceeds this are skipped entirely
   * (never read from CAS, never trigram-indexed) to bound per-file trigram
   * blowup on giant bundled/generated files. Defaults to 2 MB. A skipped
   * document simply never participates in `core:search_text` pushdown (nor,
   * once pushdown is active for a workspace, in the corpus-scan fallback --
   * that scan only ever covers record bodies, not raw file text, so it never
   * covered these files' *content* either way).
   */
  readonly max_document_bytes?: number;
  /**
   * Optional cooperative-cancellation check, polled once per stale-document
   * close and once per missing-document insert (right before each one's own
   * work begins, alongside the existing per-document `yieldToEventLoop`
   * checkpoint -- see that function's doc comment). When it returns `true`,
   * the pass stops immediately: it does NOT run the current-generation
   * recheck and does NOT call `markLexicalComplete`, so a later pass (the
   * daemon always submits one after whatever triggered this abort, e.g. a
   * new scan -- see `packages/daemon/src/runtime.ts`) simply resumes
   * reconciliation from wherever the missing-document query finds gaps,
   * exactly like an ordinary interrupted-by-crash re-run. Documents already
   * committed before the abort was observed stay committed (each is its own
   * atomic `putLexicalDocument` transaction) -- an abort only ever discards
   * uncommitted, in-progress work for the CURRENT document plus whatever the
   * pass had not yet reached. Used by the daemon's threaded lexical worker
   * (`packages/daemon/src/lexical-thread.ts`) to stop promptly when a new
   * scan needs the workspace database's write lock; never wired for the
   * in-process (non-threaded) call path.
   */
  readonly should_abort?: () => boolean;
}

export interface ReconcileLexicalProjectionResult {
  /** The workspace generation this pass reconciled against (`0` if the workspace has never published). */
  readonly generation: number;
  /** Lexical documents closed because their owning `artifact_versions` row had itself already closed. */
  readonly closed: number;
  /** Lexical documents newly inserted (and trigram-indexed) this pass. */
  readonly inserted: number;
  /** Visible, text-encoded versions skipped because their declared byte length exceeded `max_document_bytes`. */
  readonly skipped_oversized: number;
  /** Visible, non-`binary`-encoded versions skipped because their CAS bytes did not actually decode as clean UTF-8 text (a defensive re-check; `encoding <> 'binary'` is expected to already guarantee this in practice). */
  readonly skipped_undecodable: number;
  /** Whether `lexical_index_state.completed_generation` was advanced to `generation` -- `false` when a concurrent scan bumped the workspace's current generation while this pass ran (see the function doc comment). */
  readonly marker_written: boolean;
  /**
   * `true` only when `should_abort` fired and stopped this pass early.
   * Omitted (not merely `false`) on every ordinary completed pass, so the
   * existing exact-shape assertions in `tests/lexical-maintenance.test.ts`
   * (predating abort support) keep passing unchanged: `expect(...).toEqual({...})`
   * (Vitest/Jest semantics) treats an absent key the same as one explicitly
   * set to `undefined`, but NOT the same as one set to `false`.
   */
  readonly aborted?: boolean;
}

const DEFAULT_MAX_DOCUMENT_BYTES = 2_000_000;

/**
 * Hands control back to the event loop's I/O phase between documents.
 * `await`ing an already-settled (or fast-settling) promise only drains the
 * microtask queue -- it does NOT yield to pending I/O (timers, sockets,
 * pipes), so a loop of purely-`await`-ed calls can still starve the event
 * loop for as long as their combined *synchronous* work takes. That is
 * exactly this reconciler's actual cost profile: `putLexicalDocument`
 * (`packages/storage/src/projections.ts`) computes `lexicalTrigrams` --
 * a synchronous, allocation-heavy byte-sliding-window scan over an entire
 * document's normalized text -- on this thread, not inside the SQLite
 * worker any `await` here would otherwise be yielding into. Measured on a
 * real 981-file/177k-record repository: readiness was reached at ~222s but
 * the daemon's own status-poll HTTP handler only got scheduled again at
 * ~405s, i.e. roughly three minutes where this reconciler's loop held the
 * thread continuously across hundreds of documents with no scheduler
 * checkpoint in between. `setImmediate` specifically (not a resolved
 * promise, not `setTimeout(fn, 0)`) queues onto the "check" phase, which
 * runs after Node's I/O callbacks for the current loop turn -- the cheapest
 * true yield available, letting any pending status-poll response (or other
 * I/O) actually go out between documents instead of only after the entire
 * reconcile pass finishes. This bounds the worst-case per-stall duration to
 * one document's own trigram computation (capped by `max_document_bytes`,
 * default 2MB) rather than every document in the pass combined.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Mirrors `packages/engine/src/source-indexer.ts`'s scan-time `decodeText`:
 * a version containing a NUL byte, or bytes that are not well-formed UTF-8,
 * is not "text" regardless of its stored `encoding` label. Every version this
 * reconciler considers already has `encoding <> 'binary'` (see the missing-
 * document query below), which the current single writer of that column
 * (`source-indexer.ts`'s `applyBatch`) only ever sets from this exact
 * predicate -- so this re-check is expected to always pass for versions
 * written by this codebase's own scan path, and exists purely as a defensive
 * guard against a differently-produced or hand-repaired `artifact_versions`
 * row.
 */
function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.some((byte) => byte === 0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return undefined; }
}

// `type` (not `interface`) so these structurally satisfy the `SqliteDatabase.all<T
// extends Record<string, unknown>>` constraint without an explicit index
// signature -- TypeScript only infers that implicit index signature for
// object-literal type aliases, not `interface` declarations (matching
// `RecordRow` in `canonical-query-data-port.ts`).
type StaleDocumentRow = {
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly document_payload: Uint8Array;
  readonly closing_generation: number;
};

type MissingDocumentRow = {
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly content_hash: string;
  readonly byte_length: number;
  readonly valid_from_generation: number;
};

/**
 * D4: async post-ready lexical maintenance (`packages/daemon/src/runtime.ts`
 * submits this after every successful scan, see `scheduleWorkspaceScan`).
 * Brings `lexical_documents`/`lexical_trigrams` up to date with
 * `artifact_versions` as of the workspace's current generation, without ever
 * touching the filesystem -- source text is read from CAS by `content_hash`,
 * exactly like `core:get_source`'s `artifact_text`
 * (`canonical-query-data-port.ts`).
 *
 * Idempotent and safe to re-run concurrently or after a crash:
 * `WorkspaceProjectionRepository.putLexicalDocument` no-ops on an
 * already-inserted, unchanged document, and every closed row here is closed
 * exactly once -- a given `artifact_version_id`'s content is immutable once
 * written (each version gets its own id), so once its `lexical_documents`
 * row exists it never needs to be reopened, only eventually closed when its
 * owning `artifact_versions` row itself closes.
 *
 * Storage exposes no higher-level "close an existing lexical document" write
 * API (a version's lexical row is otherwise insert-only via
 * `putLexicalDocument`), so step 2 below runs a raw SQL `UPDATE` directly
 * against `lexical_documents`, consistent with how `SqliteCanonicalQuerySnapshotPort`
 * (`canonical-query-data-port.ts`) already runs raw SQL against workspace
 * tables from the engine layer for read pushdown.
 */
export async function reconcileLexicalProjection(input: ReconcileLexicalProjectionInput): Promise<ReconcileLexicalProjectionResult> {
  const { database, workspace_id: workspaceId, content, should_abort: shouldAbort } = input;
  const maxDocumentBytes = input.max_document_bytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const sql = database.database;

  const currentGeneration = async (): Promise<number | undefined> => {
    const row = await sql.get<{ current_generation: number }>("SELECT current_generation FROM workspace_current_state WHERE workspace_id = ?", [workspaceId]);
    return row?.current_generation;
  };

  const generation = await currentGeneration();
  if (generation === undefined) return { generation: 0, closed: 0, inserted: 0, skipped_oversized: 0, skipped_undecodable: 0, marker_written: false };

  // Already-complete fast path: the completion marker is only ever written
  // (below) after a full close+insert pass against exactly this generation,
  // and lexical rows are never mutated outside this function once it lands --
  // so a matching marker proves there is nothing to close or insert. This is
  // what makes the daemon's startup re-submission for every ready workspace
  // (`packages/daemon/src/runtime.ts`'s `submitLexicalMaintenance` calls)
  // cost two point lookups instead of a full reconcile scan.
  if (await database.projections.lexicalCompletedGeneration() === generation) {
    return { generation, closed: 0, inserted: 0, skipped_oversized: 0, skipped_undecodable: 0, marker_written: true };
  }

  // Step 2 (close stale): every OPEN lexical document whose owning
  // artifact_versions row has ITSELF already closed can never be visible at
  // any currently-or-future generation, so it is closed to the same
  // generation its version closed at. The document_payload BLOB must be
  // rewritten alongside the column (not just the column): `StorageMaintenance.verify`'s
  // "lexical" check (`packages/storage/src/lifecycle.ts`) requires the
  // canonical payload's own `valid_to_generation` to agree with the row's
  // column, so this decodes the existing payload, adds `valid_to_generation`,
  // and re-encodes rather than touching the column alone.
  const staleRows = await sql.all<StaleDocumentRow>(
    `SELECT lexical_documents.artifact_id AS artifact_id, lexical_documents.artifact_version_id AS artifact_version_id,
            lexical_documents.document_payload AS document_payload, artifact_versions.valid_to_generation AS closing_generation
       FROM lexical_documents
       JOIN artifact_versions ON artifact_versions.workspace_id = lexical_documents.workspace_id
        AND artifact_versions.artifact_id = lexical_documents.artifact_id
        AND artifact_versions.artifact_version_id = lexical_documents.artifact_version_id
      WHERE lexical_documents.workspace_id = ? AND lexical_documents.valid_to_generation IS NULL
        AND artifact_versions.valid_to_generation IS NOT NULL`,
    [workspaceId],
  );
  let closed = 0;
  for (const row of staleRows) {
    // Checked before each row's own work, mirroring the `yieldToEventLoop`
    // checkpoint below it: an abort observed here means this row (and every
    // row after it) is simply left OPEN for the next pass to close instead.
    if (shouldAbort?.()) return { generation, closed, inserted: 0, skipped_oversized: 0, skipped_undecodable: 0, marker_written: false, aborted: true };
    const decoded = decodeCanonical(row.document_payload) as Record<string, unknown>;
    const closedPayload = encodeCanonical({ ...decoded, valid_to_generation: row.closing_generation });
    await sql.run(
      "UPDATE lexical_documents SET valid_to_generation = ?, document_payload = ? WHERE workspace_id = ? AND artifact_id = ? AND artifact_version_id = ?",
      [row.closing_generation, closedPayload, workspaceId, row.artifact_id, row.artifact_version_id],
    );
    closed += 1;
    await yieldToEventLoop();
  }

  // Step 3 (insert missing): every version visible at `generation`, whose
  // scan-time encoding decision was "not binary" (see `decodeText`'s doc
  // comment above), that has no `lexical_documents` row at all yet -- "no
  // row" and "no OPEN row" coincide here (a version's content never changes,
  // so a version that already has a row, open or closed, never needs another
  // one). Rows over `maxDocumentBytes` are skipped by their already-known
  // `byte_length` before ever reading CAS, so an oversized file costs nothing
  // beyond this one query.
  const missingRows = await sql.all<MissingDocumentRow>(
    `SELECT artifact_versions.artifact_id AS artifact_id, artifact_versions.artifact_version_id AS artifact_version_id,
            artifact_versions.content_hash AS content_hash, artifact_versions.byte_length AS byte_length,
            artifact_versions.valid_from_generation AS valid_from_generation
       FROM artifact_versions
      WHERE artifact_versions.workspace_id = ? AND artifact_versions.encoding <> 'binary'
        AND artifact_versions.valid_from_generation <= ?
        AND (artifact_versions.valid_to_generation IS NULL OR artifact_versions.valid_to_generation > ?)
        AND NOT EXISTS (
          SELECT 1 FROM lexical_documents
           WHERE lexical_documents.workspace_id = artifact_versions.workspace_id
             AND lexical_documents.artifact_id = artifact_versions.artifact_id
             AND lexical_documents.artifact_version_id = artifact_versions.artifact_version_id
        )
      ORDER BY artifact_versions.artifact_id, artifact_versions.artifact_version_id`,
    [workspaceId, generation, generation],
  );
  let inserted = 0;
  let skippedOversized = 0;
  let skippedUndecodable = 0;
  for (const row of missingRows) {
    // Same abort checkpoint as the stale-closing loop above: this row (and
    // every row after it) is simply left missing for the next pass's
    // `NOT EXISTS` query to pick back up.
    if (shouldAbort?.()) return { generation, closed, inserted, skipped_oversized: skippedOversized, skipped_undecodable: skippedUndecodable, marker_written: false, aborted: true };
    if (row.byte_length > maxDocumentBytes) { skippedOversized += 1; continue; }
    const bytes = await content.read(row.content_hash);
    const text = decodeText(bytes);
    if (text === undefined) { skippedUndecodable += 1; continue; }
    await database.projections.putLexicalDocument({ artifact_id: row.artifact_id, artifact_version_id: row.artifact_version_id, text, valid_from_generation: row.valid_from_generation });
    inserted += 1;
    // See `yieldToEventLoop`'s doc comment: this is the loop whose combined
    // per-document `lexicalTrigrams` cost was observed to starve the event
    // loop for minutes on a real large repository.
    await yieldToEventLoop();
  }

  // Only publish the completion marker if the workspace's current generation
  // is still exactly what step 1 read: a concurrent scan that bumped it while
  // this pass ran means what was just reconciled is already stale (it can't
  // see whatever that scan changed), so this pass must not claim completeness
  // for the NEW generation -- the next post-ready run (which that scan's own
  // success also triggers) redoes reconciliation against it instead.
  const generationAfter = await currentGeneration();
  const markerWritten = generationAfter === generation;
  if (markerWritten) await database.projections.markLexicalComplete(generation);

  return { generation, closed, inserted, skipped_oversized: skippedOversized, skipped_undecodable: skippedUndecodable, marker_written: markerWritten };
}
