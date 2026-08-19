import { createHmac, timingSafeEqual } from "node:crypto";
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
  readonly expires_at?: string;
  readonly now?: string;
  readonly limit: number;
  readonly reader: ManifestStreamReader<T>;
  readonly position_of?: (item: T) => string;
}

export interface ReadPageResult<T> {
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
    const payload = Buffer.from(stableJson(claims), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  decode(token: string): QueryCursorClaims {
    if (typeof token !== "string") throw new CursorCacheError("core:cursor_invalid", "Cursor must be a string.");
    const parts = token.split(".");
    if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) throw new CursorCacheError("core:cursor_invalid", "Cursor encoding is invalid.");
    const expected = Buffer.from(createHmac("sha256", this.secret).update(parts[0]!).digest("base64url"));
    const provided = Buffer.from(parts[1]!);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw new CursorCacheError("core:cursor_invalid", "Cursor authentication failed.");
    let value: unknown;
    try { value = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")); } catch { throw new CursorCacheError("core:cursor_invalid", "Cursor payload is not valid JSON."); }
    if (!isRecord(value) || value["cursor_kind"] !== "query" || typeof value["execution_id"] !== "string" || typeof value["scope_digest"] !== "string" || typeof value["result_stream"] !== "string" || typeof value["stable_position"] !== "string" || !["forward", "backward"].includes(String(value["direction"])) || typeof value["projection_digest"] !== "string" || typeof value["ordering_digest"] !== "string" || typeof value["response_budget_ceiling_digest"] !== "string" || typeof value["frozen_snapshot_digest"] !== "string" || typeof value["frozen_status_digest"] !== "string" || typeof value["expires_at"] !== "string") throw new CursorCacheError("core:cursor_invalid", "Cursor claims are incomplete.");
    return value as unknown as QueryCursorClaims;
  }

  async readPage<T>(request: ReadPageRequest<T>): Promise<ReadPageResult<T>> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new CursorCacheError("core:budget_invalid", "Cursor page limit must be a positive safe integer.");
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
      claims = { cursor_kind: "query", execution_id: request.execution_id, scope_digest: request.scope_digest ?? request.frozen_snapshot_digest, result_stream: request.result_stream, stable_position: "", direction: request.direction, projection_digest: request.projection_digest, ordering_digest: request.ordering_digest ?? request.projection_digest, response_budget_ceiling_digest: request.response_budget_ceiling_digest, frozen_snapshot_digest: request.frozen_snapshot_digest, frozen_status_digest: request.frozen_status_digest, expires_at: expiresAt };
    }
    const readRequest: ManifestStreamReadRequest = { execution_id: claims.execution_id, result_stream: claims.result_stream, direction: claims.direction, limit: request.limit + 1 };
    if (claims.stable_position.length > 0) (readRequest as { position?: string }).position = claims.stable_position;
    const result = await request.reader.read(readRequest);
    const items = result.items.slice(0, request.limit);
    const hasMore = result.has_more || result.items.length > request.limit;
    const firstPosition = items.length === 0 ? undefined : safePosition(items[0]!, 0, request.position_of);
    const lastPosition = items.length === 0 ? undefined : safePosition(items[items.length - 1]!, items.length - 1, request.position_of);
    const make = (direction: CursorDirection, position: string): string => this.encode({ ...claims, direction, stable_position: position });
    const page: ReadPageResult<T> = { items, has_next: hasMore, has_previous: claims.stable_position.length > 0 };
    if (hasMore && lastPosition) (page as { next_cursor?: string }).next_cursor = make(claims.direction, lastPosition);
    if (claims.stable_position.length > 0 && firstPosition) (page as { previous_cursor?: string }).previous_cursor = make(claims.direction === "forward" ? "backward" : "forward", firstPosition);
    return page;
  }
}
