import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WorkspaceRegistry } from "../packages/engine/src/index.js";
import { DaemonClient, DaemonRuntime, type DaemonRuntimeOptions } from "../packages/daemon/src/index.js";
import { createIndexingCoreProcessTransport, type IndexingCoreProcessTransport } from "../packages/plugin-javascript-typescript/src/indexing-core-process-transport.js";
import { hostNativeTarget, nativeArtifactNames } from "../scripts/native-release.mjs";

/**
 * Frente P-1 e2e coverage (plan `generic-waddling-hartmanis.md` §7.1): the
 * real daemon wiring for v4 index-pack export/import, driven against the
 * REAL `urdira-indexing-worker` binary and the REAL native structural-store
 * addon -- the same release artifacts `tests/v4-daemon-e2e.test.ts` uses.
 * Covers: `core:index_pack_export`'s native branch
 * (`index-pack-export-v4-thread.ts`/`index-pack-export-v4-worker-thread.ts`),
 * `workspace-add --index-pack`'s consumption inside `runV4WorkspaceScan`
 * (staged import under `<db>.import-staging-<uuid>`, atomic rename onto the
 * paths `ensureV4Workspace` bootstrapped, workspace_id re-pinning via
 * `importV4IndexPack`'s `targetWorkspaceId`), and the `reconcile` follow-up
 * (Frente E) a successful import forces instead of `full`.
 *
 * Gated on the release artifacts existing, exactly like `tests/v4-daemon-
 * e2e.test.ts` -- skipped (not broken) on a machine with no Rust toolchain.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const hostTarget = hostNativeTarget();
const workerPath = process.env["URDIRA_INDEXING_CORE_WORKER_PATH"]
  ?? (hostTarget === undefined ? undefined : resolve(repoRoot, "release/native", hostTarget, nativeArtifactNames(hostTarget).indexing_core_worker));
const nativeAddonPath = process.env["URDIRA_NATIVE_ADDON_PATH"]
  ?? (hostTarget === undefined ? undefined : resolve(repoRoot, "release/native", hostTarget, nativeArtifactNames(hostTarget).addon));
const hasReleaseArtifacts = workerPath !== undefined && existsSync(workerPath) && nativeAddonPath !== undefined && existsSync(nativeAddonPath);

if (nativeAddonPath !== undefined) process.env["URDIRA_NATIVE_ADDON_PATH"] ??= nativeAddonPath;

// The FULL `task-planner/src` tree (7 files), not just its 2-file `domain/`
// subdirectory `tests/v4-daemon-e2e.test.ts` uses: `RECONCILE_DELTA_THRESHOLD`
// (default 0.25, Frente E) classifies a reconcile by the ratio of changed to
// total owners in the frontier -- one changed file out of 2 is 0.5 (over
// threshold, "cold"), but one changed file out of 7 is ~0.14 (under
// threshold, "delta"), which is the scenario the delta test below needs.
const fixtureRoot = resolve(repoRoot, "tests/fixtures/codebases/typescript/task-planner/src");
const DAEMON_CLIENT_OPTIONS = { request_timeout_ms: 120_000 };

function asDaemonWorkspaceRegistry(registry: WorkspaceRegistry): NonNullable<DaemonRuntimeOptions["workspace_registry"]> {
  return registry as unknown as NonNullable<DaemonRuntimeOptions["workspace_registry"]>;
}

interface IndexStatusView {
  readonly workspace_status: string;
  readonly structural_ready?: boolean;
  readonly last_scan?: {
    readonly kind: "full" | "changed" | "reconcile";
    readonly reconcile?: { readonly mode: "noop" | "delta" | "cold"; readonly fell_back_to_cold: boolean };
    // 2026-09-08 P0 fix: set only when this reconcile followed a
    // `core:index_pack_export` pack import -- see `V4LastScanSummary
    // .import`'s own doc comment (`packages/daemon/src/runtime.ts`).
    readonly import?: { readonly imported: boolean; readonly import_wall_ms: number; readonly pack_bytes?: number };
  };
}

async function fetchStatus(client: DaemonClient, workspaceId: string): Promise<IndexStatusView> {
  const response = await client.call("core:index_status", { workspace_ids: [workspaceId] });
  if (response.outcome !== "success") throw new Error(`core:index_status did not succeed: ${JSON.stringify(response)}`);
  const payload = response.payload as { readonly workspaces: readonly IndexStatusView[] };
  const workspace = payload.workspaces[0];
  if (workspace === undefined) throw new Error(`core:index_status reported no workspace for ${workspaceId}.`);
  return workspace;
}

async function pollUntilReady(client: DaemonClient, workspaceId: string, timeoutMs = 120_000): Promise<IndexStatusView> {
  const deadline = Date.now() + timeoutMs;
  let last: IndexStatusView | undefined;
  while (Date.now() < deadline) {
    last = await fetchStatus(client, workspaceId);
    if (last.workspace_status === "ready" || last.workspace_status === "degraded") return last;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Workspace ${workspaceId} did not leave "indexing" within ${timeoutMs}ms (last observed: ${JSON.stringify(last)}).`);
}

type StreamPage = { readonly items: ReadonlyArray<{ readonly value: unknown }>; readonly next_cursor?: string; readonly has_next: boolean };

async function queryStreams(client: DaemonClient, workspaceId: string, operation: string, args: Record<string, unknown>): Promise<Readonly<Record<string, StreamPage>>> {
  const response = await client.call("core:query", {
    api_version: 3,
    scope: { scope_type: "single_workspace", workspace_id: workspaceId },
    expression: { expression_type: "operation", operation, arguments: args },
    options: {
      freshness: "current",
      wait_timeout_ms: 0,
      coverage_requirement: "accept_reported",
      evidence: { evidence: "summary", evidence_chain_depth: 1 },
      diagnostics: { diagnostics: "relevant", diagnostic_detail: true },
      snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
      registry: { registry: "used", include_payload_schemas: false },
      response_budget: { max_items: 1_000, max_characters: 4_000_000 },
    },
  });
  if (response.outcome !== "success") throw new Error(`core:query (${operation}) did not succeed: ${JSON.stringify(response)}`);
  return (response.payload as { readonly streams: Readonly<Record<string, StreamPage>> }).streams;
}

function recordName(value: Record<string, unknown>): string | undefined {
  const body = value["body"] as Record<string, unknown> | undefined;
  const name = body?.["name"];
  return typeof name === "string" ? name : undefined;
}

interface StartedDaemon {
  readonly runtime: DaemonRuntime;
  readonly client: DaemonClient;
  readonly dataRoot: string;
  stop(): Promise<void>;
}

// Short, fixed-width prefixes (NOT the descriptive names used elsewhere in
// this file): `daemonPaths` (`packages/daemon/src/ownership.ts`) places the
// daemon's control socket directly at `join(dataRoot, "daemon.sock")`, and
// an AF_UNIX socket path is capped at ~104 bytes on macOS (`sockaddr_un.sun_path`).
// A descriptive label like `noop-importer` pushed the FULL path (`$TMPDIR`
// + `urdira-v4-index-pack-noop-importer-<mkdtemp suffix>` + `/daemon.sock`)
// right up against that limit -- found live as an intermittent
// `listen EINVAL: invalid argument ... /daemon.sock` failure, worse on a
// long `$TMPDIR` (this repo's `/var/folders/.../T/` is already ~50 bytes).
async function startV4Daemon(label: string): Promise<StartedDaemon> {
  const dataRoot = await mkdtemp(join(tmpdir(), `urd-p1-${label}-`));
  const sessions = new Map<string, IndexingCoreProcessTransport>();
  const runtime = await DaemonRuntime.start({
    data_root: dataRoot,
    engine_build_id: `build-v4-index-pack-${label}`,
    workspace_registry: asDaemonWorkspaceRegistry(new WorkspaceRegistry()),
    resolve_plugin_provider: async () => { throw new Error("resolve_plugin_provider must not be called for a v4 workspace."); },
    resolve_workspace_scan_transport: async (workspace) => {
      let transport = sessions.get(workspace.workspace_id);
      if (transport === undefined) {
        transport = createIndexingCoreProcessTransport({ command: workerPath!, request_timeout_ms: 120_000 });
        sessions.set(workspace.workspace_id, transport);
      }
      return transport;
    },
    semantic_index: false,
    reconciliation_sweep_interval_ms: 0,
    scheduler: { pool_concurrency: { source: 1, structural: 1, semantic: 1, query: 1 }, max_active: 4, client_quotas: {} },
  });
  return {
    runtime,
    client: new DaemonClient(runtime.endpoint, DAEMON_CLIENT_OPTIONS),
    dataRoot,
    stop: async () => {
      await runtime.stop().catch(() => undefined);
      for (const transport of sessions.values()) {
        await transport.shutdown().catch(() => undefined);
        await transport.terminate().catch(() => undefined);
      }
      await rm(dataRoot, { recursive: true, force: true });
    },
  };
}

async function seedWorkspaceTree(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `urd-p1t-${label}-`));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
}

const describeIfBuilt = hasReleaseArtifacts ? describe : describe.skip;

it.skipIf(hasReleaseArtifacts)("phase-daemon-v4-index-pack is skipped: build the release artifacts first", () => {
  console.warn(
    `[urdira] tests/phase-daemon-v4-index-pack.test.ts skipped -- missing worker (${workerPath ?? "no host target"}) or native addon (${nativeAddonPath ?? "no host target"}). ` +
    "Build them with: node scripts/build-native.mjs",
  );
});

describeIfBuilt("v4 index pack wired into the daemon (Frente P-1)", () => {
  it("core:index_pack_export produces a v4 pack manifest for a ready native workspace", async () => {
    const originalV4Flag = process.env["URDIRA_V4"];
    const donor = await startV4Daemon("e");
    const workspaceRoot = await seedWorkspaceTree("e");
    try {
      process.env["URDIRA_V4"] = "1";
      const added = await donor.client.call("core:workspace_add", { args: [workspaceRoot], confirmed: true });
      expect(added.outcome).toBe("success");
      const workspaceId = (added.payload as { readonly workspace_id: string }).workspace_id;
      await pollUntilReady(donor.client, workspaceId);

      const packPath = join(donor.dataRoot, "export.urdira-index-pack-v4");
      const exported = await donor.client.call("core:index_pack_export", { args: [workspaceId, packPath], confirmed: true });
      expect(exported.outcome, JSON.stringify(exported)).toBe("success");
      const payload = exported.payload as { readonly out_path: string; readonly pack_path: string; readonly generation: number; readonly bytes: number; readonly roots: Readonly<Record<string, string>>; readonly export_wall_ms: number };
      expect(payload.out_path).toBe(packPath);
      // 2026-09-08 P0 fix (docs/evidence/2026-09-07-v4-vscode-campaign.md
      // §9 item 4): `pack_path` is the design's own field name
      // (`{pack_path, bytes, generation, roots, export_wall_ms}`), kept
      // alongside the pre-existing `out_path` for backward compatibility.
      expect(payload.pack_path).toBe(packPath);
      expect(payload.generation).toBeGreaterThan(0);
      expect(payload.bytes).toBeGreaterThan(0);
      expect(payload.export_wall_ms).toBeGreaterThanOrEqual(0);
      expect(payload.roots["records"]).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(existsSync(packPath)).toBe(true);
    } finally {
      if (originalV4Flag === undefined) delete process.env["URDIRA_V4"]; else process.env["URDIRA_V4"] = originalV4Flag;
      await donor.stop();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 120_000);

  // Decidido en implementación (criterio (b), fidelidad por delante de
  // milisegundos): `URDIRA_DEBUG_TIMING=1` live evidence showed the FIRST
  // reconcile after a cross-machine import today lands in `mode: "cold"`,
  // never `"noop"`/`"delta"`, EVEN for a byte-identical donor tree --
  // `crates/urdira-source-frontier/src/walker.rs`'s `metadata_digest` hashes
  // `byte_length, ctime_ms, device, inode, mode, mtime_ms` (its own doc
  // comment: "not needed for this crate's own equivalence rule, which only
  // ever compares a value this same crate produced against an EARLIER ONE
  // IT PRODUCED" -- i.e. deliberately scoped to same-machine incremental
  // scans, not cross-machine portability). `crates/urdira-source-frontier/
  // src/delta.rs`'s `classify` requires BOTH `content_hash` AND
  // `metadata_digest` to match for "equivalent"; a copy onto a different
  // machine (or, here, a different directory on the same machine) always
  // gets a fresh inode and mtime, so metadata_digest can never match the
  // donor's persisted value regardless of content equality -- `reconcile`
  // then correctly (safely) measures 100% "changed" and falls through to
  // `cold` (`crates/urdira-indexing-worker/src/v4/scan.rs::run_reconcile`),
  // which re-derives and republishes everything from scratch. This is NOT a
  // correctness bug (the republished generation is byte-correct, verified
  // below via find_references parity) -- it is a real, load-bearing
  // discovery that R17's "reconcile absorbs the donor/local difference"
  // optimization currently degrades to the same cost as `full` on every
  // real cross-machine import, EVERY time, deterministically.
  //
  // Adversarial-review note: a SEPARATE, parallel frente is fixing the
  // walker's equivalence rule (`Delta::compute` moving to a content-hash-
  // only comparison) precisely to restore `noop`/`delta` here -- deliberately
  // NOT this frente's file zone (`delta.rs`/`walker.rs` belong to Frente
  // E's already-merged, disjoint zone, plan §1's ola-1 table). So this
  // assertion is intentionally NOT pinned to `"cold"`: it accepts either
  // `"noop"` (once that fix lands, since the tree really is byte-identical)
  // or `"cold"` (today's behavior) -- the load-bearing guarantee this test
  // protects is `last_scan.kind === "reconcile"` (never `"full"`) plus the
  // find_references parity below, not which mode reconcile happens to pick.
  it("workspace-add --index-pack over a byte-identical tree ends ready via reconcile (not full), and matches the donor's find_references", async () => {
    const originalV4Flag = process.env["URDIRA_V4"];
    const donor = await startV4Daemon("nd");
    const importer = await startV4Daemon("ni");
    const donorRoot = await seedWorkspaceTree("nd");
    const importerRoot = await seedWorkspaceTree("ni");
    try {
      process.env["URDIRA_V4"] = "1";
      const donorAdded = await donor.client.call("core:workspace_add", { args: [donorRoot], confirmed: true });
      expect(donorAdded.outcome).toBe("success");
      const donorWorkspaceId = (donorAdded.payload as { readonly workspace_id: string }).workspace_id;
      await pollUntilReady(donor.client, donorWorkspaceId);

      const packPath = join(donor.dataRoot, "noop.urdira-index-pack-v4");
      const exportResult = await donor.client.call("core:index_pack_export", { args: [donorWorkspaceId, packPath], confirmed: true });
      expect(exportResult.outcome, JSON.stringify(exportResult)).toBe("success");

      const importerAdded = await importer.client.call("core:workspace_add", { args: [importerRoot], values: { "index-pack": packPath }, confirmed: true });
      expect(importerAdded.outcome).toBe("success");
      const importerWorkspaceId = (importerAdded.payload as { readonly workspace_id: string }).workspace_id;
      const status = await pollUntilReady(importer.client, importerWorkspaceId);
      expect(status.workspace_status).toBe("ready");
      // R17/§7.1.3: the KEY P-1 wiring behavior -- a successful import is
      // followed by `reconcile`, not `full` (`runV4WorkspaceScan`'s
      // `importedFromIndexPack` branch), regardless of the mode `reconcile`
      // itself ends up choosing (see this test's own doc comment above for
      // why that is `cold` today).
      expect(status.last_scan?.kind).toBe("reconcile");
      expect(["noop", "cold"]).toContain(status.last_scan?.reconcile?.mode);
      expect(status.last_scan?.reconcile?.fell_back_to_cold).toBe(false);
      // 2026-09-08 P0 fix (docs/evidence/2026-09-07-v4-vscode-campaign.md
      // §6.2/§9 item 4): the import's own wall time (stat + native copy/
      // verify + atomic rename) is now a distinct, product-exposed field --
      // previously only approximable as `ready_elapsed_ms - reconcile_wall`.
      const importSummary = status.last_scan?.import;
      expect(importSummary?.imported).toBe(true);
      expect(importSummary?.import_wall_ms).toBeGreaterThanOrEqual(0);
      expect(importSummary?.pack_bytes).toBeGreaterThan(0);

      const donorResolved = await queryStreams(donor.client, donorWorkspaceId, "core:resolve_symbol", { reference: "InvalidTaskTransitionError", resolution_scope: "exports" });
      const donorDecl = (donorResolved["declarations"]?.items ?? []).map((item) => item.value as Record<string, unknown>);
      expect(donorDecl.length).toBeGreaterThan(0);
      const donorReferences = await queryStreams(donor.client, donorWorkspaceId, "core:find_references", { target: { subject_type: "entity", entity_id: donorDecl[0]!["entity_id"] }, include_declarations: true });

      const importerResolved = await queryStreams(importer.client, importerWorkspaceId, "core:resolve_symbol", { reference: "InvalidTaskTransitionError", resolution_scope: "exports" });
      const importerDecl = (importerResolved["declarations"]?.items ?? []).map((item) => item.value as Record<string, unknown>);
      expect(importerDecl.length).toBeGreaterThan(0);
      expect(recordName(importerDecl[0]!)).toBe(recordName(donorDecl[0]!));
      const importerReferences = await queryStreams(importer.client, importerWorkspaceId, "core:find_references", { target: { subject_type: "entity", entity_id: importerDecl[0]!["entity_id"] }, include_declarations: true });
      expect(importerReferences["references"]!.items.length).toBe(donorReferences["references"]!.items.length);
      expect(importerReferences["references"]!.items.length).toBeGreaterThan(0);
    } finally {
      if (originalV4Flag === undefined) delete process.env["URDIRA_V4"]; else process.env["URDIRA_V4"] = originalV4Flag;
      await donor.stop();
      await importer.stop();
      await rm(donorRoot, { recursive: true, force: true });
      await rm(importerRoot, { recursive: true, force: true });
    }
  }, 180_000);

  // Companion to the identical-tree test above: proves that even though a
  // real content change also lands in `mode: "cold"` today (see that test's
  // doc comment -- with EVERY file already reporting "changed" on
  // metadata_digest alone, one MORE genuinely-changed file makes no
  // observable difference to the mode decision), the change itself is not
  // lost or ignored. `cold` still runs a full authoritative re-derivation
  // (`run_full_scan_with_enumeration`), so the republished generation
  // reflects the IMPORTER's own local edit, not the frozen donor snapshot
  // the pack carried -- this is the actual "never lose data" guarantee that
  // matters, independent of which reconcile mode got there.
  it("workspace-add --index-pack over a tree with one locally-changed file correctly reflects that change after reconcile", async () => {
    const originalV4Flag = process.env["URDIRA_V4"];
    const donor = await startV4Daemon("dd");
    const importer = await startV4Daemon("di");
    const donorRoot = await seedWorkspaceTree("dd");
    const importerRoot = await seedWorkspaceTree("di");
    try {
      process.env["URDIRA_V4"] = "1";
      const donorAdded = await donor.client.call("core:workspace_add", { args: [donorRoot], confirmed: true });
      const donorWorkspaceId = (donorAdded.payload as { readonly workspace_id: string }).workspace_id;
      await pollUntilReady(donor.client, donorWorkspaceId);

      const packPath = join(donor.dataRoot, "delta.urdira-index-pack-v4");
      const exportResult = await donor.client.call("core:index_pack_export", { args: [donorWorkspaceId, packPath], confirmed: true });
      expect(exportResult.outcome, JSON.stringify(exportResult)).toBe("success");

      // A real, queryable content change in the IMPORTER's own tree (not the
      // donor's, whose pack is already frozen): a NEW exported class the
      // donor's snapshot never saw. If the post-import reconcile/cold pass
      // silently kept serving the donor's stale structural data, this
      // symbol would not resolve at all in the importer's workspace.
      const changedFile = join(importerRoot, "domain", "errors.ts");
      await writeFile(changedFile, `${await readFile(changedFile, "utf8")}\nexport class ImportPackDeltaMarkerError extends Error {}\n`, "utf8");

      const importerAdded = await importer.client.call("core:workspace_add", { args: [importerRoot], values: { "index-pack": packPath }, confirmed: true });
      expect(importerAdded.outcome).toBe("success");
      const importerWorkspaceId = (importerAdded.payload as { readonly workspace_id: string }).workspace_id;
      const status = await pollUntilReady(importer.client, importerWorkspaceId);
      expect(status.workspace_status).toBe("ready");
      // Same P-1 wiring guarantee as the identical-tree test: `reconcile`,
      // never `full`, on this first-scan-with-a-pending-pack. Mode: `"delta"`
      // once the parallel content-hash-only equivalence fix (see the
      // identical-tree test's doc comment) lands, `"cold"` today -- same
      // "not pinned to today's behavior" reasoning as that test.
      expect(status.last_scan?.kind).toBe("reconcile");
      expect(["delta", "cold"]).toContain(status.last_scan?.reconcile?.mode);

      const markerResolved = await queryStreams(importer.client, importerWorkspaceId, "core:resolve_symbol", { reference: "ImportPackDeltaMarkerError", resolution_scope: "exports" });
      const markerDecl = (markerResolved["declarations"]?.items ?? []).map((item) => item.value as Record<string, unknown>);
      expect(markerDecl.length).toBeGreaterThan(0);
      expect(recordName(markerDecl[0]!)).toBe("ImportPackDeltaMarkerError");

      // The donor's own (unmodified) snapshot never has this symbol --
      // confirms the importer's answer is genuinely locally-derived, not an
      // artifact of both workspaces somehow sharing state.
      const donorMarkerResolved = await queryStreams(donor.client, donorWorkspaceId, "core:resolve_symbol", { reference: "ImportPackDeltaMarkerError", resolution_scope: "exports" });
      expect((donorMarkerResolved["declarations"]?.items ?? []).length).toBe(0);
    } finally {
      if (originalV4Flag === undefined) delete process.env["URDIRA_V4"]; else process.env["URDIRA_V4"] = originalV4Flag;
      await donor.stop();
      await importer.stop();
      await rm(donorRoot, { recursive: true, force: true });
      await rm(importerRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it("workspace-add --index-pack with a corrupt pack falls back to a full scan and still reaches ready", async () => {
    const originalV4Flag = process.env["URDIRA_V4"];
    const donor = await startV4Daemon("cd");
    const importer = await startV4Daemon("ci");
    const donorRoot = await seedWorkspaceTree("cd");
    const importerRoot = await seedWorkspaceTree("ci");
    try {
      process.env["URDIRA_V4"] = "1";
      const donorAdded = await donor.client.call("core:workspace_add", { args: [donorRoot], confirmed: true });
      expect(donorAdded.outcome).toBe("success");
      const donorWorkspaceId = (donorAdded.payload as { readonly workspace_id: string }).workspace_id;
      const donorStatus = await pollUntilReady(donor.client, donorWorkspaceId);
      expect(donorStatus.workspace_status).toBe("ready");

      const packPath = join(donor.dataRoot, "corrupt.urdira-index-pack-v4");
      const exportResult = await donor.client.call("core:index_pack_export", { args: [donorWorkspaceId, packPath], confirmed: true });
      expect(exportResult.outcome, JSON.stringify(exportResult)).toBe("success");
      const full = await readFile(packPath);
      const corruptPath = join(donor.dataRoot, "corrupt-truncated.urdira-index-pack-v4");
      await writeFile(corruptPath, full.subarray(0, Math.floor(full.length / 2)));

      const importerAdded = await importer.client.call("core:workspace_add", { args: [importerRoot], values: { "index-pack": corruptPath }, confirmed: true });
      expect(importerAdded.outcome).toBe("success");
      const importerWorkspaceId = (importerAdded.payload as { readonly workspace_id: string }).workspace_id;
      // A corrupt/truncated pack must never brick the workspace: the daemon
      // detects the import failure while everything is still confined to a
      // disposable `<db>.import-staging-<uuid>` area, discards it, and
      // proceeds exactly as if `--index-pack` had never been given.
      const status = await pollUntilReady(importer.client, importerWorkspaceId);
      expect(status.workspace_status).toBe("ready");
      expect(status.last_scan?.kind).toBe("full");
    } finally {
      if (originalV4Flag === undefined) delete process.env["URDIRA_V4"]; else process.env["URDIRA_V4"] = originalV4Flag;
      await donor.stop();
      await importer.stop();
      await rm(donorRoot, { recursive: true, force: true });
      await rm(importerRoot, { recursive: true, force: true });
    }
  }, 180_000);

  // Adversarial-review addition (plan §7.1 review, item 1): the atomic
  // "swap staging into place" step is really THREE independent `rename`
  // calls (structural, then sidecar, then the catalog database) --
  // `importPendingV4IndexPack`'s own doc comment (`packages/daemon/src/
  // runtime.ts`) argues that a failure between the FIRST and LAST of those
  // renames is still safe: `paths.structural_root` ends up holding the
  // donor's files while `paths.database_path` is untouched (still the
  // pristine, generation-0 bootstrap catalog), and the `full` scan the
  // caller falls back to (because `importedFromIndexPack` stays `false`)
  // unconditionally rewrites `MANIFEST` and every fixed-name structural
  // file (`records.tree`/`dependency.tree`/...) for its OWN new
  // generation, superseding the stale donor content a reader could ever
  // observe through `MANIFEST`. This test verifies that claim empirically
  // rather than trusting the doc comment: forces the failure right after
  // the structural rename lands (`URDIRA_V4_INDEX_PACK_IMPORT_FAIL_AFTER_RENAME=
  // structural`, a review-added fault-injection hook mirroring Frente E's
  // own `URDIRA_V4_RECONCILE_FAIL_DELTA` convention) and confirms the
  // workspace still reaches `ready` via an honest `full` scan whose
  // structural query results reflect the IMPORTER's OWN tree, not a
  // corrupted mix of donor and local state.
  it("workspace-add --index-pack that fails between the structural and database renames still self-heals via a full scan", async () => {
    const originalV4Flag = process.env["URDIRA_V4"];
    const originalFailAfterRename = process.env["URDIRA_V4_INDEX_PACK_IMPORT_FAIL_AFTER_RENAME"];
    const donor = await startV4Daemon("rd");
    const importer = await startV4Daemon("ri");
    const donorRoot = await seedWorkspaceTree("rd");
    const importerRoot = await seedWorkspaceTree("ri");
    try {
      process.env["URDIRA_V4"] = "1";
      const donorAdded = await donor.client.call("core:workspace_add", { args: [donorRoot], confirmed: true });
      expect(donorAdded.outcome).toBe("success");
      const donorWorkspaceId = (donorAdded.payload as { readonly workspace_id: string }).workspace_id;
      await pollUntilReady(donor.client, donorWorkspaceId);

      const packPath = join(donor.dataRoot, "mid-rename-failure.urdira-index-pack-v4");
      const exportResult = await donor.client.call("core:index_pack_export", { args: [donorWorkspaceId, packPath], confirmed: true });
      expect(exportResult.outcome, JSON.stringify(exportResult)).toBe("success");

      // A local-only symbol the donor's frozen snapshot never saw -- proves
      // the eventual `ready` workspace is genuinely re-derived from the
      // importer's own tree, not left serving stale/mixed donor structural
      // state left behind by the partially-completed rename sequence.
      const changedFile = join(importerRoot, "domain", "errors.ts");
      await writeFile(changedFile, `${await readFile(changedFile, "utf8")}\nexport class MidRenameFailureSelfHealMarkerError extends Error {}\n`, "utf8");

      process.env["URDIRA_V4_INDEX_PACK_IMPORT_FAIL_AFTER_RENAME"] = "structural";
      const importerAdded = await importer.client.call("core:workspace_add", { args: [importerRoot], values: { "index-pack": packPath }, confirmed: true });
      expect(importerAdded.outcome).toBe("success");
      const importerWorkspaceId = (importerAdded.payload as { readonly workspace_id: string }).workspace_id;
      const status = await pollUntilReady(importer.client, importerWorkspaceId);
      expect(status.workspace_status).toBe("ready");
      // The injected failure happened AFTER `isFirstScan` was already
      // decided but BEFORE the import could report success, so the caller
      // falls back to the ordinary first-scan `full` scope -- never
      // `reconcile` (that only follows a successful import).
      expect(status.last_scan?.kind).toBe("full");

      const markerResolved = await queryStreams(importer.client, importerWorkspaceId, "core:resolve_symbol", { reference: "MidRenameFailureSelfHealMarkerError", resolution_scope: "exports" });
      const markerDecl = (markerResolved["declarations"]?.items ?? []).map((item) => item.value as Record<string, unknown>);
      expect(markerDecl.length).toBeGreaterThan(0);
      expect(recordName(markerDecl[0]!)).toBe("MidRenameFailureSelfHealMarkerError");

      // A symbol from the DONOR's tree that the importer's own tree also
      // has (both were copied from the same fixture) must still resolve
      // correctly too -- confirms the republished generation is a complete,
      // coherent re-derivation, not a partial/degraded one.
      const baselineResolved = await queryStreams(importer.client, importerWorkspaceId, "core:resolve_symbol", { reference: "InvalidTaskTransitionError", resolution_scope: "exports" });
      expect((baselineResolved["declarations"]?.items ?? []).length).toBeGreaterThan(0);
    } finally {
      if (originalFailAfterRename === undefined) delete process.env["URDIRA_V4_INDEX_PACK_IMPORT_FAIL_AFTER_RENAME"]; else process.env["URDIRA_V4_INDEX_PACK_IMPORT_FAIL_AFTER_RENAME"] = originalFailAfterRename;
      if (originalV4Flag === undefined) delete process.env["URDIRA_V4"]; else process.env["URDIRA_V4"] = originalV4Flag;
      await donor.stop();
      await importer.stop();
      await rm(donorRoot, { recursive: true, force: true });
      await rm(importerRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
