import { describe, expect, it } from "vitest";
import { runRustWorkspaceScan, type RustWorkspaceScanTransport } from "../packages/engine/src/rust-workspace-scan.js";
import type { WorkspaceScanRequest } from "../packages/engine/src/rust-indexing-core-port.js";

/**
 * Pure, hermetic unit coverage for `packages/engine/src/rust-workspace-scan.ts`'s
 * `runRustWorkspaceScan` (task P2-2b): no daemon, no native worker process --
 * every other test that exercises this function does so only indirectly,
 * through a real (`tests/v4-verify.test.ts`/`tests/index-pack-v4.test.ts`/
 * `tests/workspace-fork-v4.test.ts`'s `beforeAll`) or fake
 * (`tests/phase-daemon-v4-scan.test.ts`'s `FakeTransportState`) transport
 * that always resolves with `"scan_completed"` or (rarely) `"error"` --
 * never the third, "unexpected terminal event kind" branch this file adds
 * direct coverage for.
 */

function baseRequest(overrides: Partial<WorkspaceScanRequest> = {}): WorkspaceScanRequest {
  return {
    workspace_id: "workspace:rust-scan-unit-test",
    workspace_root: "/repositories/one",
    database_path: "/data/workspace.sqlite",
    structural_root: "/data/structural",
    cas_root: "/data/cas",
    sidecar_root: "/data/sidecar",
    scope: { kind: "full" },
    registry_snapshot_id: "registry:rust-scan-unit-test",
    configuration_revision_id: "configuration:rust-scan-unit-test",
    resolution_lock_id: "resolution:rust-scan-unit-test",
    priority: "interactive",
    ...overrides,
  };
}

describe("runRustWorkspaceScan", () => {
  it("resolves with the scan_completed event's fields and no queryable milestone when the transport never reports one", async () => {
    const transport: RustWorkspaceScanTransport = {
      workspaceScan: async () => ({
        kind: "scan_completed",
        request_id: "request:rust-scan-unit-test-1",
        generation: 3,
        snapshot_id: "snapshot:one",
        roots: { records: "sha256:r", dependency: "sha256:d", graph: "sha256:g", metric: "sha256:m" },
        timings: { total_ms: 10 },
      }),
    };
    const outcome = await runRustWorkspaceScan(transport, baseRequest());
    expect(outcome.generation).toBe(3);
    expect(outcome.snapshot_id).toBe("snapshot:one");
    expect(outcome.queryable).toBeUndefined();
    expect(outcome.queryable_at_ms).toBeUndefined();
    expect(outcome.timings).toEqual({ total_ms: 10 });
    expect(outcome.completed_at_ms).toBeGreaterThanOrEqual(0);
  });

  it("records the live queryable milestone (and invokes onQueryable synchronously) before resolving with scan_completed", async () => {
    const transport: RustWorkspaceScanTransport = {
      workspaceScan: async (_request, onQueryable) => {
        onQueryable?.({ generation: 1, manifest_path: "/data/structural/MANIFEST", timings: { total_ms: 4 } });
        return {
          kind: "scan_completed",
          request_id: "request:rust-scan-unit-test-2",
          generation: 1,
          snapshot_id: "snapshot:queryable",
          roots: { records: "sha256:r", dependency: "sha256:d", graph: "sha256:g", metric: "sha256:m" },
          timings: { total_ms: 8 },
        };
      },
    };
    const liveEvents: number[] = [];
    const outcome = await runRustWorkspaceScan(transport, baseRequest(), (event) => liveEvents.push(event.generation));
    expect(liveEvents).toEqual([1]);
    expect(outcome.queryable).toEqual({ generation: 1, manifest_path: "/data/structural/MANIFEST", timings: { total_ms: 4 } });
    expect(outcome.queryable_at_ms).toBeGreaterThanOrEqual(0);
  });

  it("throws a formatted error for an explicit error terminal event", async () => {
    const transport: RustWorkspaceScanTransport = {
      workspaceScan: async () => ({ kind: "error", code: "core:workspace_scan_failed", message: "boom" }),
    };
    await expect(runRustWorkspaceScan(transport, baseRequest())).rejects.toThrow(/Rust workspace scan failed \(core:workspace_scan_failed\): boom/);
  });

  it("throws for an unexpected terminal event kind neither scan_completed nor error", async () => {
    const transport: RustWorkspaceScanTransport = {
      workspaceScan: async () => ({ kind: "something_else" }),
    };
    await expect(runRustWorkspaceScan(transport, baseRequest())).rejects.toThrow(/Rust workspace scan returned an unexpected terminal event: something_else/);
  });

  it("rejects an invalid request before ever calling the transport", async () => {
    let called = false;
    const transport: RustWorkspaceScanTransport = {
      workspaceScan: async () => { called = true; return { kind: "error", code: "unreachable", message: "unreachable" }; },
    };
    await expect(runRustWorkspaceScan(transport, baseRequest({ workspace_id: "" }))).rejects.toThrow(/Invalid Rust workspace-scan workspace_id/);
    expect(called).toBe(false);
  });
});
