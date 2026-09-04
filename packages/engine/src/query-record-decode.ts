/**
 * Shared decode path for `CanonicalQueryRecord` rows (v4 plan P2-5): pulled
 * out of `SqliteCanonicalQuerySnapshotPort.decodeRow`
 * (`canonical-query-data-port.ts`) verbatim -- a pure refactor, no
 * behaviour change -- so `NativeCanonicalQuerySnapshotPort`
 * (`native-query-snapshot-port.ts`) can reuse the EXACT same body decode,
 * interner sharing, and source-span construction the SQLite port uses,
 * rather than a second, drift-prone reimplementation.
 *
 * The `RecordRow` shape here is the common denominator both ports produce:
 * whatever backs it (a SQLite join row, or a napi-marshalled native-store
 * row) must be mapped into exactly this shape before calling `decodeRow`.
 */
import { decodeCanonical } from "@urdira/canonical";
import type { SourceSpan } from "@urdira/contracts";
import { hydrateRelationalValue, type RelationalValueRow } from "@urdira/storage";
import type { RecordBodyInterner } from "./record-body-interner.js";
import type { CanonicalQueryRecord } from "./canonical-query-data-port.js";

export type RecordRow = {
  readonly record_id: string; readonly workspace_id: string; readonly category: string; readonly kind: string; readonly universal_kind: string;
  readonly owner_artifact_id: string; readonly owner_artifact_version_id: string; readonly value_rows?: readonly RelationalValueRow[]; readonly facet_rows?: readonly string[];
  readonly body_payload: Uint8Array | ArrayBuffer | null;
  readonly primary_source_span_artifact_version_id: string | number | null;
  readonly primary_source_span_start_byte: string | number | null;
  readonly primary_source_span_end_byte: string | number | null;
  readonly primary_source_span_start_line: string | number | null;
  readonly primary_source_span_end_line: string | number | null;
  readonly identity_id: string | null; readonly identity_key: string | null;
};

export function recordBodyPayload(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export function primarySourceSpan(row: RecordRow): SourceSpan | undefined {
  if (row.primary_source_span_artifact_version_id == null || row.primary_source_span_start_byte == null || row.primary_source_span_end_byte == null) return undefined;
  return {
    artifact_version_id: String(row.primary_source_span_artifact_version_id),
    start_byte: String(row.primary_source_span_start_byte),
    end_byte: String(row.primary_source_span_end_byte),
    ...(row.primary_source_span_start_line == null ? {} : { start_line: String(row.primary_source_span_start_line) }),
    ...(row.primary_source_span_end_line == null ? {} : { end_line: String(row.primary_source_span_end_line) }),
  };
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * `record_id` is content-derived (decision 11), so an `interner` hit for
 * `row.record_id` proves the relational body is IDENTICAL to whatever a
 * prior hydration of that same id already produced. Both `body` and
 * `facets` (also content-derived from the same payload bytes, under a
 * second, derived interner key -- see `RecordBodyInterner`'s own doc
 * comment) must hit for this shortcut; a miss on either falls back to a
 * full decode, exactly as if no interner were configured, and registers
 * both for future hits.
 */
export function decodeRow(row: RecordRow, interner?: RecordBodyInterner): CanonicalQueryRecord {
  const internedBody = interner?.lookup(row.record_id);
  let body: Record<string, unknown>;
  let facets: readonly string[];
  if (internedBody !== undefined && row.facet_rows !== undefined) {
    body = internedBody as Record<string, unknown>;
    facets = row.facet_rows;
  } else {
    body = row.body_payload == null
      ? object(hydrateRelationalValue(row.value_rows ?? []))
      : object(decodeCanonical(recordBodyPayload(row.body_payload)));
    facets = row.facet_rows ?? [];
    interner?.register(row.record_id, body);
  }
  const sourceSpan = primarySourceSpan(row);
  return {
    record_id: row.record_id,
    workspace_id: row.workspace_id,
    category: row.category,
    kind: row.kind,
    universal_kind: row.universal_kind,
    owner_artifact_id: row.owner_artifact_id,
    owner_artifact_version_id: row.owner_artifact_version_id,
    ...(sourceSpan === undefined ? {} : { primary_source_span: sourceSpan }),
    ...(row.identity_id === null ? {} : { identity_id: row.identity_id }),
    ...(row.identity_key === null ? {} : { identity_key: row.identity_key }),
    facets,
    body,
  };
}
