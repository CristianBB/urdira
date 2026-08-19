import { describe, expect, it } from "vitest";
import { CursorCache, CursorCacheError, type ManifestStreamReader } from "../packages/engine/src/index.js";

type Entry = { id: string; stable_sort_key: string };

function reader(entries: readonly Entry[]): ManifestStreamReader<Entry> {
  return {
    async read(request) {
      const ordered = [...entries].sort((a, b) => a.stable_sort_key.localeCompare(b.stable_sort_key));
      const candidates = request.direction === "forward"
        ? ordered.filter((entry) => request.position === undefined || entry.stable_sort_key > request.position)
        : ordered.filter((entry) => request.position === undefined || entry.stable_sort_key < request.position).reverse();
      return { items: candidates.slice(0, request.limit), has_more: candidates.length > request.limit };
    },
  };
}

describe("Phase 11 cursor cache", () => {
  it("signs immutable cursors and paginates forward without reranking", async () => {
    const cache = new CursorCache({ signing_secret: "phase-11-test-secret" });
    const manifest = reader([
      { id: "confirmed-a", stable_sort_key: "a" },
      { id: "confirmed-b", stable_sort_key: "b" },
      { id: "confirmed-c", stable_sort_key: "c" },
    ]);

    const first = await cache.readPage({
      execution_id: "execution-1",
      result_stream: "results/confirmed",
      direction: "forward",
      projection_digest: "projection-1",
      response_budget_ceiling_digest: "budget-1",
      frozen_snapshot_digest: "snapshots-1",
      frozen_status_digest: "status-1",
      limit: 2,
      reader: manifest,
    });
    expect(first.items.map((entry) => entry.id)).toEqual(["confirmed-a", "confirmed-b"]);
    expect(first.next_cursor).toBeDefined();

    const second = await cache.readPage({
      cursor: first.next_cursor!,
      expected_execution_id: "execution-1",
      expected_result_stream: "results/confirmed",
      expected_projection_digest: "projection-1",
      expected_response_budget_ceiling_digest: "budget-1",
      expected_frozen_snapshot_digest: "snapshots-1",
      expected_frozen_status_digest: "status-1",
      limit: 2,
      reader: manifest,
    });
    expect(second.items.map((entry) => entry.id)).toEqual(["confirmed-c"]);
    expect(second.previous_cursor).toBeDefined();
  });

  it("keeps backward pagination as an independent manifest stream", async () => {
    const cache = new CursorCache({ signing_secret: "phase-11-test-secret" });
    const manifest = reader([
      { id: "possible-a", stable_sort_key: "a" },
      { id: "possible-b", stable_sort_key: "b" },
      { id: "possible-c", stable_sort_key: "c" },
    ]);
    const page = await cache.readPage({
      execution_id: "execution-1",
      result_stream: "results/possible",
      direction: "backward",
      projection_digest: "projection-1",
      response_budget_ceiling_digest: "budget-1",
      frozen_snapshot_digest: "snapshots-1",
      frozen_status_digest: "status-1",
      limit: 2,
      reader: manifest,
    });
    expect(page.items.map((entry) => entry.id)).toEqual(["possible-c", "possible-b"]);
    expect(page.next_cursor).toBeDefined();
  });

  it("rejects tampering, stream changes, and expiry with closed errors", async () => {
    const cache = new CursorCache({ signing_secret: "phase-11-test-secret" });
    const page = await cache.readPage({
      execution_id: "execution-1",
      result_stream: "results/confirmed",
      direction: "forward",
      projection_digest: "projection-1",
      response_budget_ceiling_digest: "budget-1",
      frozen_snapshot_digest: "snapshots-1",
      frozen_status_digest: "status-1",
      limit: 1,
      reader: reader([{ id: "a", stable_sort_key: "a" }, { id: "b", stable_sort_key: "b" }]),
      expires_at: "2026-08-10T00:01:00.000Z",
      now: "2026-08-10T00:00:00.000Z",
    });
    await expect(cache.readPage({ cursor: `${page.next_cursor}x`, limit: 1, reader: reader([]) })).rejects.toMatchObject({ code: "core:cursor_invalid" });
    await expect(cache.readPage({ cursor: page.next_cursor!, expected_result_stream: "results/possible", limit: 1, reader: reader([]), now: "2026-08-10T00:00:00.000Z" })).rejects.toMatchObject({ code: "core:cursor_stream_mismatch" });
    await expect(cache.readPage({ cursor: page.next_cursor!, limit: 1, reader: reader([]), now: "2026-08-10T00:02:00.000Z" })).rejects.toMatchObject({ code: "core:cursor_expired" });
    expect(page.next_cursor).toBeTruthy();
  });
});
