import { createHmac, timingSafeEqual } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants, inflateRawSync } from "node:zlib";
import { EngineError } from "./errors.js";

export type CursorDirection = "forward" | "backward";

export interface ManifestStreamReadRequest {
  readonly execution_id: string;
  readonly result_stream: string;
  readonly direction: CursorDirection;
  readonly position?: string;
  readonly limit: number;
}

export interface ManifestStreamReadResult<T> {
  readonly total?: number;
  readonly items: ReadonlyArray<T>;
  readonly has_more: boolean;
}

export interface ManifestStreamReader<T> {
  readonly read: (request: ManifestStreamReadRequest) => Promise<ManifestStreamReadResult<T>>;
}

export interface QueryCursorClaims {
  readonly cursor_kind: "query";
  readonly execution_id: string;
  readonly scope_digest: string;
  readonly result_stream: string;
  readonly stable_position: string;
  readonly direction: CursorDirection;
  readonly projection_digest: string;
  readonly ordering_digest: string;
  readonly response_budget_ceiling_digest: string;
  readonly frozen_snapshot_digest: string;
  readonly frozen_status_digest: string;
  /** Signed execution metadata preserved across continuation calls. */
  readonly completeness?: { readonly overall_status: "complete" | "partial" | "unknown" | "unsupported" | "stale"; readonly dimensions: readonly unknown[] };
  readonly expires_at: string;
}

export interface CursorCacheOptions {
  readonly signing_secret: string;
  readonly default_ttl_ms?: number;
}

export interface ReadPageRequest<T> {
  readonly cursor?: string;
  readonly execution_id?: string;
  readonly result_stream?: string;
  readonly direction?: CursorDirection;
  readonly projection_digest?: string;
  readonly response_budget_ceiling_digest?: string;
  readonly frozen_snapshot_digest?: string;
  readonly frozen_status_digest?: string;
  readonly scope_digest?: string;
  readonly ordering_digest?: string;
  readonly expected_execution_id?: string;
  readonly expected_result_stream?: string;
  readonly expected_projection_digest?: string;
  readonly expected_response_budget_ceiling_digest?: string;
  readonly expected_frozen_snapshot_digest?: string;
  readonly expected_frozen_status_digest?: string;
  readonly expected_scope_digest?: string;
  readonly expected_ordering_digest?: string;
  readonly completeness?: QueryCursorClaims["completeness"];
  readonly expires_at?: string;
  readonly now?: string;
  readonly limit: number;
  /**
   * Hard ceiling, in JSON-serialized characters, on the items this page may
   * carry -- independent of (and enforced IN ADDITION to) `limit`'s item
   * count. Before this field existed, `readPage` only ever bounded a page by
   * item count: `options.response_budget.max_characters` was validated at
   * the request layer (`query-plan.ts`'s `validateBudget`) but never
   * actually consulted while building a page, so a caller requesting a
   * generous item count (or the engine's own generous
   * `MAX_RESPONSE_CHARACTERS` ceiling) could produce a page whose serialized
   * size vastly exceeded what any bounded transport (the daemon's fixed-size
   * IPC frame, in particular) could carry -- surfacing as a hard transport
   * failure instead of a clean, bounded page with a cursor for the rest.
   * Truncation always keeps at least one item (see `readPage`'s loop) so a
   * page never regresses to zero progress merely because a single item is
   * itself larger than the remaining budget.
   */
  readonly max_characters: number;
  readonly reader: ManifestStreamReader<T>;
  readonly position_of?: (item: T) => string;
  readonly hydrate_item?: (item: T, source_characters: number) => Promise<T | undefined>;
}

export interface ReadPageResult<T> {
  /** Private position used to fit presentation without reexecuting a query. */
  readonly page_start_cursor?: string;
  readonly total?: number;
  readonly items: ReadonlyArray<T>;
  readonly next_cursor?: string;
  readonly previous_cursor?: string;
  readonly has_next: boolean;
  readonly has_previous: boolean;
}

export class CursorCacheError extends EngineError {
  constructor(override readonly code: "core:cursor_invalid" | "core:cursor_expired" | "core:cursor_kind_mismatch" | "core:cursor_stream_mismatch" | "core:cursor_projection_mismatch" | "core:budget_invalid", message: string) {
    super(code, message);
    this.name = "CursorCacheError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function safePosition<T>(item: T, index: number, positionOf?: (item: T) => string): string {
  const position = positionOf?.(item) ?? (isRecord(item) && typeof item["stable_sort_key"] === "string" ? item["stable_sort_key"] : isRecord(item) && typeof item["ordinal"] === "number" ? String(item["ordinal"]) : undefined);
  if (typeof position !== "string" || position.length === 0) throw new CursorCacheError("core:cursor_invalid", `Manifest item ${index} has no stable position.`);
  return position;
}

export class CursorCache {
  private readonly secret: string;
  private readonly defaultTtlMs: number;

  constructor(options: CursorCacheOptions) {
    if (typeof options.signing_secret !== "string" || options.signing_secret.length === 0) throw new CursorCacheError("core:cursor_invalid", "A non-empty cursor signing secret is required.");
    this.secret = options.signing_secret;
    this.defaultTtlMs = options.default_ttl_ms ?? 15 * 60 * 1000;
    if (!Number.isSafeInteger(this.defaultTtlMs) || this.defaultTtlMs <= 0) throw new CursorCacheError("core:budget_invalid", "Cursor TTL must be a positive safe integer.");
  }

  encode(claims: QueryCursorClaims): string {
    return this.encodeV3(claims);
  }

  private encodeV3(claims: QueryCursorClaims): string {
    // Keep every immutable claim in the token so it remains valid after a
    // daemon restart. Short field aliases plus Brotli keep long structural
    // positions copyable by agent clients without replacing the portable
    // cursor with server-local pending state. V2 and legacy tokens remain
    // accepted by decode() for compatibility.
    const compact = {
      b: claims.response_budget_ceiling_digest,
      ...(claims.completeness === undefined ? {} : { c: claims.completeness }),
      d: claims.direction === "forward" ? "f" : "b",
      e: claims.execution_id,
      f: claims.frozen_status_digest,
      i: claims.frozen_snapshot_digest,
      o: claims.ordering_digest,
      p: claims.stable_position,
      q: claims.projection_digest,
      r: claims.result_stream,
      s: claims.scope_digest,
      x: claims.expires_at,
    };
    const payload = brotliCompressSync(Buffer.from(stableJson(compact), "utf8"), {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).toString("hex");
    const signed = `v3.${payload}`;
    const signature = createHmac("sha256", this.secret).update(signed).digest("hex");
    return `${signed}.${signature}`;
  }

  decode(token: string): QueryCursorClaims {
    if (typeof token !== "string") throw new CursorCacheError("core:cursor_invalid", "Cursor must be a string.");
    const parts = token.split(".");
    const legacy = parts.length === 2;
    const v2 = parts.length === 3 && parts[0] === "v2";
    const v3 = parts.length === 3 && parts[0] === "v3";
    if ((!legacy && !v2 && !v3) || parts.some((part) => part.length === 0)) throw new CursorCacheError("core:cursor_invalid", "Cursor encoding is invalid.");
    const encodedParts = legacy ? parts : parts.slice(1);
    if (encodedParts.some((part) => part.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(part))) throw new CursorCacheError("core:cursor_invalid", "Cursor encoding is invalid.");
    const signed = v2 || v3 ? `${parts[0]}.${parts[1]}` : parts[0]!;
    const expected = createHmac("sha256", this.secret).update(signed).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(parts.at(-1)!, "hex");
    } catch {
      throw new CursorCacheError("core:cursor_invalid", "Cursor signature is invalid.");
    }
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw new CursorCacheError("core:cursor_invalid", "Cursor authentication failed.");
    let value: unknown;
    try {
      if (v3) {
        const compact = JSON.parse(brotliDecompressSync(Buffer.from(parts[1]!, "hex")).toString("utf8")) as Record<string, unknown>;
        value = {
          cursor_kind: "query",
          execution_id: compact["e"], scope_digest: compact["s"], result_stream: compact["r"], stable_position: compact["p"],
          direction: compact["d"] === "f" ? "forward" : compact["d"] === "b" ? "backward" : undefined,
          projection_digest: compact["q"], ordering_digest: compact["o"], response_budget_ceiling_digest: compact["b"],
          frozen_snapshot_digest: compact["i"], frozen_status_digest: compact["f"], expires_at: compact["x"],
          ...(compact["c"] === undefined ? {} : { completeness: compact["c"] }),
        };
      } else {
        const encoded = v2 ? inflateRawSync(Buffer.from(parts[1]!, "hex")).toString("utf8") : Buffer.from(parts[0]!, "hex").toString("utf8");
        value = JSON.parse(encoded);
      }
    } catch { throw new CursorCacheError("core:cursor_invalid", "Cursor payload is not valid JSON."); }
    if (!isRecord(value) || value["cursor_kind"] !== "query" || typeof value["execution_id"] !== "string" || typeof value["scope_digest"] !== "string" || typeof value["result_stream"] !== "string" || typeof value["stable_position"] !== "string" || !["forward", "backward"].includes(String(value["direction"])) || typeof value["projection_digest"] !== "string" || typeof value["ordering_digest"] !== "string" || typeof value["response_budget_ceiling_digest"] !== "string" || typeof value["frozen_snapshot_digest"] !== "string" || typeof value["frozen_status_digest"] !== "string" || typeof value["expires_at"] !== "string") throw new CursorCacheError("core:cursor_invalid", "Cursor claims are incomplete.");
    return value as unknown as QueryCursorClaims;
  }

  async readPage<T>(request: ReadPageRequest<T>): Promise<ReadPageResult<T>> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new CursorCacheError("core:budget_invalid", "Cursor page limit must be a positive safe integer.");
    if (!Number.isSafeInteger(request.max_characters) || request.max_characters < 1) throw new CursorCacheError("core:budget_invalid", "Cursor page character budget must be a positive safe integer.");
    const now = request.now ?? new Date().toISOString();
    let claims: QueryCursorClaims;
    if (request.cursor !== undefined) {
      claims = this.decode(request.cursor);
      if (claims.expires_at <= now) throw new CursorCacheError("core:cursor_expired", `Cursor for ${claims.execution_id} expired at ${claims.expires_at}.`);
      if (request.expected_execution_id !== undefined && claims.execution_id !== request.expected_execution_id) throw new CursorCacheError("core:cursor_invalid", "Cursor execution does not match the requested execution.");
      if (request.expected_result_stream !== undefined && claims.result_stream !== request.expected_result_stream) throw new CursorCacheError("core:cursor_stream_mismatch", `Cursor is for ${claims.result_stream}.`);
      if (request.expected_projection_digest !== undefined && claims.projection_digest !== request.expected_projection_digest) throw new CursorCacheError("core:cursor_projection_mismatch", "Cursor projection does not match the requested projection.");
      if (request.expected_response_budget_ceiling_digest !== undefined && claims.response_budget_ceiling_digest !== request.expected_response_budget_ceiling_digest) throw new CursorCacheError("core:cursor_projection_mismatch", "Cursor response budget does not match the requested budget.");
      if (request.expected_frozen_snapshot_digest !== undefined && claims.frozen_snapshot_digest !== request.expected_frozen_snapshot_digest) throw new CursorCacheError("core:cursor_invalid", "Cursor snapshot binding does not match the frozen execution.");
      if (request.expected_frozen_status_digest !== undefined && claims.frozen_status_digest !== request.expected_frozen_status_digest) throw new CursorCacheError("core:cursor_invalid", "Cursor index status does not match the frozen execution.");
      if (request.expected_scope_digest !== undefined && claims.scope_digest !== request.expected_scope_digest) throw new CursorCacheError("core:cursor_invalid", "Cursor scope does not match the frozen execution.");
      if (request.expected_ordering_digest !== undefined && claims.ordering_digest !== request.expected_ordering_digest) throw new CursorCacheError("core:cursor_projection_mismatch", "Cursor ordering does not match the requested ordering.");
    } else {
      if (typeof request.execution_id !== "string" || typeof request.result_stream !== "string" || !request.direction || typeof request.projection_digest !== "string" || typeof request.response_budget_ceiling_digest !== "string" || typeof request.frozen_snapshot_digest !== "string" || typeof request.frozen_status_digest !== "string") throw new CursorCacheError("core:cursor_invalid", "Initial cursor claims are incomplete.");
      const expiresAt = request.expires_at ?? new Date(Date.parse(now) + this.defaultTtlMs).toISOString();
      claims = { cursor_kind: "query", execution_id: request.execution_id, scope_digest: request.scope_digest ?? request.frozen_snapshot_digest, result_stream: request.result_stream, stable_position: "", direction: request.direction, projection_digest: request.projection_digest, ordering_digest: request.ordering_digest ?? request.projection_digest, response_budget_ceiling_digest: request.response_budget_ceiling_digest, frozen_snapshot_digest: request.frozen_snapshot_digest, frozen_status_digest: request.frozen_status_digest, ...(request.completeness === undefined ? {} : { completeness: request.completeness }), expires_at: expiresAt };
    }
    const readRequest: ManifestStreamReadRequest = { execution_id: claims.execution_id, result_stream: claims.result_stream, direction: claims.direction, limit: request.limit + 1 };
    if (claims.stable_position.length > 0) (readRequest as { position?: string }).position = claims.stable_position;
    const result = await request.reader.read(readRequest);
    const itemLimited = result.items.slice(0, request.limit);
    // Character-budget truncation on top of the item-count limit above --
    // always keep at least the first item (a page that returns zero items
    // and zero progress merely because one item is bigger than the whole
    // budget would never terminate a naive continuation loop). Every item
    // after the first stops as soon as adding it would exceed the budget,
    // not after: the running total never includes a truncated item's size.
    let consumedCharacters = 0;
    let sourceCharacters = 0;
    const items: T[] = [];
    for (const raw of itemLimited) {
      const hydrated = request.hydrate_item === undefined ? raw : await request.hydrate_item(raw, sourceCharacters);
      if (hydrated === undefined) break;
      const itemCharacters = JSON.stringify(hydrated).length;
      if (items.length > 0 && consumedCharacters + itemCharacters > request.max_characters) break;
      consumedCharacters += itemCharacters;
      items.push(hydrated);
      const value = isRecord(hydrated) && isRecord(hydrated["value"]) ? hydrated["value"] : {};
      const snippets = Array.isArray(value["optional_source_snippets"]) ? value["optional_source_snippets"] : [];
      sourceCharacters += snippets.reduce((sum: number, snippet: unknown) => sum + (isRecord(snippet) && typeof snippet["text"] === "string" ? snippet["text"].length : 0), 0);
    }
    const characterTruncated = items.length < itemLimited.length;
    const hasMore = result.has_more || result.items.length > request.limit || characterTruncated;
    const firstPosition = items.length === 0 ? undefined : safePosition(items[0]!, 0, request.position_of);
    const lastPosition = items.length === 0 ? undefined : safePosition(items[items.length - 1]!, items.length - 1, request.position_of);
    const make = (direction: CursorDirection, position: string): string => this.encodeV3({ ...claims, direction, stable_position: position });
    const page: ReadPageResult<T> = { page_start_cursor: this.encodeV3(claims), ...(result.total === undefined ? {} : { total: result.total }), items, has_next: hasMore, has_previous: claims.stable_position.length > 0 };
    if (hasMore && lastPosition) (page as { next_cursor?: string }).next_cursor = make(claims.direction, lastPosition);
    if (claims.stable_position.length > 0 && firstPosition) (page as { previous_cursor?: string }).previous_cursor = make(claims.direction === "forward" ? "backward" : "forward", firstPosition);
    return page;
  }
}
