import { canonicalBytes, digestBytes } from "@urdira/canonical";
import { EngineErrorWithDetails } from "./errors.js";
import type { CanonicalQueryRecord } from "./canonical-query-data-port.js";
import { recordValue } from "./query-record-projections.js";
import type { QueryStreamItem } from "./query-operators.js";

export interface ComparisonPair {
  readonly base: CanonicalQueryRecord;
  readonly target: CanonicalQueryRecord;
}

export interface ComparisonDiff {
  readonly added: readonly CanonicalQueryRecord[];
  readonly removed: readonly CanonicalQueryRecord[];
  readonly changed: readonly ComparisonPair[];
  readonly moved: readonly ComparisonPair[];
  readonly correlated: readonly ComparisonPair[];
  readonly possibleCorrelated: readonly ComparisonPair[];
}

export interface ComparisonRecordSource {
  readonly records: readonly CanonicalQueryRecord[] | AsyncIterable<readonly CanonicalQueryRecord[]>;
  readonly ordered_by_identity: boolean;
}

export async function* comparisonRecords(source: ComparisonRecordSource): AsyncIterable<CanonicalQueryRecord> {
  let previousKey: string | undefined;
  const consume = async function* (records: AsyncIterable<readonly CanonicalQueryRecord[]>): AsyncIterable<CanonicalQueryRecord> {
    for await (const batch of records) for (const record of batch) {
      const key = record.identity_key;
      if (key === undefined) continue;
      if (previousKey !== undefined && compareCanonicalIdentity(key, previousKey) < 0) {
        throw new EngineErrorWithDetails("core:required_capability_unsupported", "core:compare requires records_for_query_batches to be ordered by identity_key; refusing an unordered adapter stream rather than materializing it for sorting.", { capability: "core:records_for_query_batches_order", reason_codes: ["comparison_identity_order_unavailable"] });
      }
      if (key === previousKey) continue;
      previousKey = key;
      yield record;
    }
  };
  if (Symbol.asyncIterator in Object(source.records)) yield* consume(source.records as AsyncIterable<readonly CanonicalQueryRecord[]>);
  else {
    for (const record of source.records as readonly CanonicalQueryRecord[]) {
      const key = record.identity_key;
      if (key === undefined) continue;
      if (previousKey !== undefined && compareCanonicalIdentity(key, previousKey) < 0) throw new EngineErrorWithDetails("core:required_capability_unsupported", "core:compare requires records_for_query_batches to be ordered by identity_key; refusing an unordered adapter stream rather than materializing it for sorting.", { capability: "core:records_for_query_batches_order", reason_codes: ["comparison_identity_order_unavailable"] });
      if (key === previousKey) continue;
      previousKey = key;
      yield record;
    }
  }
}

export async function diffComparisonRecordSources(baseSource: ComparisonRecordSource, targetSource: ComparisonRecordSource, correlationPolicy: "strict" | "include_possible"): Promise<ComparisonDiff> {
  if (!baseSource.ordered_by_identity || !targetSource.ordered_by_identity) throw new EngineErrorWithDetails("core:required_capability_unsupported", "core:compare requires both participants to provide records_for_query_batches ordered by identity_key; refusing an unordered adapter rather than materializing it for sorting.", { capability: "core:records_for_query_batches_order", reason_codes: ["comparison_identity_order_unavailable"] });
  const baseIterator = comparisonRecords(baseSource)[Symbol.asyncIterator]();
  const targetIterator = comparisonRecords(targetSource)[Symbol.asyncIterator]();
  let baseRecord = (await baseIterator.next()).value as CanonicalQueryRecord | undefined;
  let targetRecord = (await targetIterator.next()).value as CanonicalQueryRecord | undefined;
  const added: CanonicalQueryRecord[] = [];
  const removed: CanonicalQueryRecord[] = [];
  const changed: ComparisonPair[] = [];
  const moved: ComparisonPair[] = [];
  const correlated: ComparisonPair[] = [];
  while (baseRecord !== undefined || targetRecord !== undefined) {
    if (baseRecord === undefined) { added.push(targetRecord!); targetRecord = (await targetIterator.next()).value as CanonicalQueryRecord | undefined; continue; }
    if (targetRecord === undefined) { removed.push(baseRecord); baseRecord = (await baseIterator.next()).value as CanonicalQueryRecord | undefined; continue; }
    const baseKey = baseRecord.identity_key!;
    const targetKey = targetRecord.identity_key!;
    const order = compareCanonicalIdentity(baseKey, targetKey);
    if (order < 0) { removed.push(baseRecord); baseRecord = (await baseIterator.next()).value as CanonicalQueryRecord | undefined; continue; }
    if (order > 0) { added.push(targetRecord); targetRecord = (await targetIterator.next()).value as CanonicalQueryRecord | undefined; continue; }
    correlated.push({ base: baseRecord, target: targetRecord });
    if (comparisonContentDigest(baseRecord) !== comparisonContentDigest(targetRecord)) changed.push({ base: baseRecord, target: targetRecord });
    else if (comparisonLocationKey(baseRecord) !== comparisonLocationKey(targetRecord)) moved.push({ base: baseRecord, target: targetRecord });
    baseRecord = (await baseIterator.next()).value as CanonicalQueryRecord | undefined;
    targetRecord = (await targetIterator.next()).value as CanonicalQueryRecord | undefined;
  }
  const possibleCorrelated: ComparisonPair[] = [];
  if (correlationPolicy === "include_possible" && added.length > 0 && removed.length > 0) {
    const removedByDigest = new Map<string, CanonicalQueryRecord[]>();
    for (const record of removed) {
      const digest = comparisonContentDigest(record);
      const bucket = removedByDigest.get(digest);
      if (bucket === undefined) removedByDigest.set(digest, [record]); else bucket.push(record);
    }
    const matchedRemoved = new Set<string>();
    for (const targetRecord of added) {
      const bucket = removedByDigest.get(comparisonContentDigest(targetRecord));
      if (bucket === undefined) continue;
      const baseRecord = bucket.find((candidate) => !matchedRemoved.has(candidate.record_id));
      if (baseRecord === undefined) continue;
      matchedRemoved.add(baseRecord.record_id);
      possibleCorrelated.push({ base: baseRecord, target: targetRecord });
    }
  }
  return { added: sortComparisonRecords(added), removed: sortComparisonRecords(removed), changed: sortComparisonPairs(changed), moved: sortComparisonPairs(moved), correlated: sortComparisonPairs(correlated), possibleCorrelated: sortComparisonPairs(possibleCorrelated) };
}

export function compareParticipantItem(record: CanonicalQueryRecord, participantRole: string): QueryStreamItem {
  return { value: { ...recordValue(record, "confirmed"), participant: participantRole }, stable_sort_key: `confirmed\0${record.identity_key ?? record.record_id}` };
}

export function compareChangeItem(pair: ComparisonPair): QueryStreamItem {
  return { value: { ...recordValue(pair.target, "confirmed"), change: { identity_key: pair.target.identity_key, before: recordValue(pair.base, "confirmed"), after: recordValue(pair.target, "confirmed") } }, stable_sort_key: `confirmed\0${pair.target.identity_key ?? pair.target.record_id}` };
}

export function compareMoveItem(pair: ComparisonPair): QueryStreamItem {
  return { value: { ...recordValue(pair.target, "confirmed"), move: { identity_key: pair.target.identity_key, before: { artifact_id: pair.base.owner_artifact_id, artifact_version_id: pair.base.owner_artifact_version_id, source_span: pair.base.primary_source_span }, after: { artifact_id: pair.target.owner_artifact_id, artifact_version_id: pair.target.owner_artifact_version_id, source_span: pair.target.primary_source_span } } }, stable_sort_key: `confirmed\0${pair.target.identity_key ?? pair.target.record_id}` };
}

export function compareCorrelationItem(pair: ComparisonPair, classification: "confirmed" | "possible", correlationClass: "identity_key" | "content_digest"): QueryStreamItem {
  return { value: { ...recordValue(pair.target, classification), correlation: { correlation_class: correlationClass, base_record_id: pair.base.record_id, target_record_id: pair.target.record_id } }, stable_sort_key: `${classification}\0${pair.target.identity_key ?? pair.target.record_id}` };
}

export function rewrapComparisonParticipantError(error: unknown, fallbackCode: string, fallbackMessage: string, fallbackDetails: Readonly<Record<string, unknown>>): EngineErrorWithDetails {
  const candidate = error as { readonly code?: unknown; readonly details?: unknown };
  if (typeof candidate?.code === "string" && candidate.code.length > 0) {
    const details = candidate.details !== null && typeof candidate.details === "object" ? candidate.details as Record<string, unknown> : fallbackDetails;
    return new EngineErrorWithDetails(candidate.code, fallbackMessage, details);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new EngineErrorWithDetails(fallbackCode, `${fallbackMessage} (${detail})`, fallbackDetails);
}

function comparisonContentDigest(record: CanonicalQueryRecord): string {
  return digestBytes(canonicalBytes({ kind: record.kind, universal_kind: record.universal_kind, category: record.category, body: record.body, facets: record.facets ?? [] }));
}

function comparisonLocationKey(record: CanonicalQueryRecord): string {
  return `${record.owner_artifact_id}\0${record.owner_artifact_version_id}\0${JSON.stringify(record.primary_source_span ?? null)}`;
}

function compareCanonicalIdentity(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortComparisonRecords(records: readonly CanonicalQueryRecord[]): readonly CanonicalQueryRecord[] {
  return [...records].sort((left, right) => compareCanonicalIdentity(left.identity_key ?? left.record_id, right.identity_key ?? right.record_id));
}

function sortComparisonPairs(pairs: readonly ComparisonPair[]): readonly ComparisonPair[] {
  return [...pairs].sort((left, right) => compareCanonicalIdentity(left.target.identity_key ?? left.target.record_id, right.target.identity_key ?? right.target.record_id));
}
