import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  IndexingEvent,
  ScanRoots,
  ScanTimings,
  WorkspaceScanRequest,
} from "../packages/plugin-javascript-typescript/src/indexing-core-process-transport.js";

/**
 * Cross-language fixture round-trip for the v4 `workspace_scan`/`queryable`/
 * `scan_completed` protocol shapes (task P2-2b). This file builds the exact
 * same objects, typed against the TS mirror
 * (`packages/plugin-javascript-typescript/src/indexing-core-process-transport.ts`),
 * that `crates/urdira-worker-protocol/tests/workspace_scan_v4_fixture.rs`
 * decodes on the Rust side, and asserts both produce byte-identical JSON
 * against the single shared fixture file
 * `crates/urdira-worker-protocol/tests/fixtures/workspace-scan-v4.json` --
 * so the two independently-typed mirrors cannot silently drift on a field
 * name or `kind` tag.
 */
const fixturePath = fileURLToPath(
  new URL("../crates/urdira-worker-protocol/tests/fixtures/workspace-scan-v4.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;

describe("rust-protocol-v4 (workspace_scan/queryable/scan_completed)", () => {
  it("workspace_scan (scope: full) matches the shared fixture", () => {
    const request: WorkspaceScanRequest = {
      workspace_id: "workspace:fixture",
      workspace_root: "/tmp/urdira-fixture/source",
      database_path: "/tmp/urdira-fixture/workspace.sqlite",
      structural_root: "/tmp/urdira-fixture/structural",
      cas_root: "/tmp/urdira-fixture/cas",
      sidecar_root: "/tmp/urdira-fixture/sidecar",
      scope: { kind: "full" },
      registry_snapshot_id: "registry:fixture-1",
      configuration_revision_id: "configuration:fixture-1",
      resolution_lock_id: "resolution:fixture-1",
      deadline_ms: 45_000,
      priority: "interactive",
    };
    const wire = { kind: "workspace_scan" as const, request_id: "request:scan-fixture-1", ...request };
    expect(wire).toEqual(fixture["workspace_scan_full"]);
  });

  it("workspace_scan (scope: changed) matches the shared fixture", () => {
    const request: WorkspaceScanRequest = {
      workspace_id: "workspace:fixture",
      workspace_root: "/tmp/urdira-fixture/source",
      database_path: "/tmp/urdira-fixture/workspace.sqlite",
      structural_root: "/tmp/urdira-fixture/structural",
      cas_root: "/tmp/urdira-fixture/cas",
      sidecar_root: "/tmp/urdira-fixture/sidecar",
      scope: {
        kind: "changed",
        paths: [
          { path: "src/a.ts", kind: "modified" },
          { path: "src/b.ts", kind: "created" },
          { path: "src/c.ts", kind: "deleted" },
        ],
      },
      registry_snapshot_id: "registry:fixture-1",
      configuration_revision_id: "configuration:fixture-1",
      resolution_lock_id: "resolution:fixture-1",
      priority: "background",
    };
    const wire = {
      kind: "workspace_scan" as const,
      request_id: "request:scan-fixture-2",
      ...request,
      deadline_ms: null,
    };
    expect(wire).toEqual(fixture["workspace_scan_changed"]);
  });

  it("queryable event matches the shared fixture", () => {
    const timings: ScanTimings = {
      catalog_ms: 120,
      parse_ms: 900,
      resolve_ms: 200,
      materialize_ms: 1_500,
      write_ms: 2_600,
      total_ms: 5_320,
    };
    const event: IndexingEvent & { readonly kind: "queryable" } = {
      kind: "queryable",
      request_id: "request:scan-fixture-1",
      operation_id: "request:scan-fixture-1",
      generation: 1,
      manifest_path: "/tmp/urdira-fixture/structural/MANIFEST",
      timings,
    };
    expect(event).toEqual(fixture["queryable"]);
  });

  it("scan_completed event matches the shared fixture", () => {
    const roots: ScanRoots = {
      records: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      dependency: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      graph: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      metric: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    };
    const timings: ScanTimings = {
      catalog_ms: 120,
      parse_ms: 900,
      resolve_ms: 200,
      materialize_ms: 1_500,
      write_ms: 2_600,
      fsync_ms: 400,
      snapshot_ms: 80,
      total_ms: 5_800,
    };
    const event: IndexingEvent & { readonly kind: "scan_completed" } = {
      kind: "scan_completed",
      request_id: "request:scan-fixture-1",
      operation_id: "request:scan-fixture-1",
      generation: 1,
      snapshot_id: "snapshot:fixture-1",
      roots,
      timings,
    };
    expect(event).toEqual(fixture["scan_completed"]);
  });

  it("upgrade_completed event matches the shared fixture", () => {
    const timings: ScanTimings = {
      resolve_ms: 2_300,
      materialize_ms: 180,
      write_ms: 90,
      snapshot_ms: 30,
      total_ms: 2_600,
    };
    const event: IndexingEvent & { readonly kind: "upgrade_completed" } = {
      kind: "upgrade_completed",
      request_id: "request:scan-fixture-1",
      operation_id: "request:scan-fixture-1",
      generation: 2,
      upgraded_sites: 731,
      external_sites: 42,
      unresolved_sites: 205,
      timings,
    };
    expect(event).toEqual(fixture["upgrade_completed"]);
  });

  it("upgrade_completed event with truncation fields matches the shared fixture", () => {
    // Revision fix (2026-09-05): F4 4.2's truncated/windows_done/windows_total
    // fields, present this time (contrast the previous test, which covers
    // the absent/backward-compat case).
    const timings: ScanTimings = {
      resolve_ms: 20_000,
      materialize_ms: 50,
      write_ms: 20,
      snapshot_ms: 10,
      total_ms: 20_080,
    };
    const event: IndexingEvent & { readonly kind: "upgrade_completed" } = {
      kind: "upgrade_completed",
      request_id: "request:scan-fixture-1",
      operation_id: "request:scan-fixture-1",
      generation: 2,
      upgraded_sites: 12,
      external_sites: 3,
      unresolved_sites: 1,
      timings,
      truncated: true,
      windows_done: 3,
      windows_total: 10,
      checker_ms: 19_500,
    };
    expect(event).toEqual(fixture["upgrade_completed_truncated"]);
  });
});
