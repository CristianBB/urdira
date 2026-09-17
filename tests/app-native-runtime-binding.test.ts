import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const nativeState = vi.hoisted(() => ({
  closure: undefined as undefined | {
    readonly target_id: "darwin-arm64";
    readonly runtime_target_id: "aarch64-apple-darwin";
    readonly runtime_component_build_id: string;
    readonly addon_path: string;
    readonly addon_digest: string;
    readonly worker_path: string;
    readonly worker_digest: string;
  },
}));

const initialNodeEnv = process.env["NODE_ENV"];

const transportState = vi.hoisted(() => ({
  descriptors: [] as unknown[],
  rust_commands: [] as string[],
  vector_batches: [] as unknown[],
  rust_analysis_result: undefined as unknown,
  semantic_closure_result: undefined as unknown,
  semantic_events: [] as string[],
  semantic_stream_requests: [] as Array<{ readonly payload?: Readonly<Record<string, unknown>> }>,
  rust_fact_stream_inputs: [] as unknown[],
}));

vi.mock("../packages/native/dist/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/native/dist/index.js")>();
  return {
    ...actual,
    resolveNativeClosure: () => {
      if (nativeState.closure === undefined) throw new Error("missing native closure fixture");
      return nativeState.closure;
    },
    loadNativeBinding: () => ({
      nativeApiVersion: () => 15,
      nativeTargetTriple: () => "aarch64-apple-darwin",
      logicalDigestBatch: () => [],
      verifyLogicalRecordBatch: () => [],
      logicalValueDigestBatch: () => [],
      verifyLogicalValueBatch: () => [],
      exactVectorTopKBatch: (requests: readonly { readonly projectionRecordIds: readonly string[]; readonly k: number }[]) => {
        transportState.vector_batches.push(...requests);
        return requests.map((request) => request.projectionRecordIds.slice(0, request.k).map((projection_record_id, index) => ({ projection_record_id, rank: index + 1 })));
      },
    }),
  };
});

vi.mock("../packages/plugin-javascript-typescript/dist/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/plugin-javascript-typescript/dist/index.js")>();
  return {
    ...actual,
    createJavascriptTypescriptProcessTransport: (input: { readonly command: string }) => {
      transportState.rust_commands.push(input.command);
      return ({
      process_id: process.pid,
      analyze: vi.fn(async () => {
        const result = transportState.rust_analysis_result as { readonly files?: readonly unknown[] } | undefined;
        if (result === undefined) return result;
        const { files: _files, ...analysis } = result;
        return analysis;
      }),
      readFacts: vi.fn(async (input: { readonly path: string }) => {
        const result = transportState.rust_analysis_result as { readonly files?: readonly { readonly path: string }[] } | undefined;
        const file = result?.files?.find((entry) => entry.path === input.path);
        if (file === undefined) throw new Error(`missing fixture page ${input.path}`);
        return file;
      }),
      commitAnalysis: vi.fn(async () => undefined),
      reset: vi.fn(),
      terminate: vi.fn(),
      });
    },
    createJavascriptTypescriptSemanticProcessTransport: (input: { readonly worker: unknown }) => {
      transportState.descriptors.push(input.worker);
      return {
        process_id: process.pid,
        invoke: vi.fn(async () => {
          transportState.semantic_events.push("invoke");
          if (transportState.semantic_closure_result !== undefined) return transportState.semantic_closure_result;
          throw new Error("stop-after-semantic-closure");
        }),
        invokeFactDeltaStream: vi.fn(async (request: { readonly payload?: Readonly<Record<string, unknown>> }) => {
          transportState.semantic_events.push("stream");
          transportState.semantic_stream_requests.push(request);
          throw new Error("stop-after-semantic-stream");
        }),
        reset: vi.fn(async () => {
          transportState.semantic_events.push("reset");
          return { reset: true };
        }),
        terminate: vi.fn(),
      };
    },
    buildJavascriptTypescriptNativeFactDeltaStream: (input: unknown) => {
      transportState.rust_fact_stream_inputs.push(input);
      throw new Error("stop-after-rust-stream-builder");
    },
  };
});

import { defaultDaemonOptions } from "../apps/urdira/src/index.js";
import { configureNativeExactVectorTopKPort, configureNativeStructuralStoreAddonPath, loadNativeStructuralStoreAddon, exactVectorScan } from "../packages/engine/dist/index.js";
import { createCanonicalPluginDigestAuthority } from "../packages/engine/src/plugin-digest-authority.js";
import { JAVASCRIPT_TYPESCRIPT_PLUGIN_ID } from "../packages/plugin-javascript-typescript/src/index.js";
import { pluginRuntimeExecutableBindingDigest } from "@urdira/plugin-sdk";

const sha256 = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

afterEach(() => {
  delete process.env["URDIRA_NATIVE_REQUIRED"];
  if (initialNodeEnv === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = initialNodeEnv;
  delete process.env["URDIRA_ANALYSIS_POOL"];
  delete process.env["URDIRA_INDEXING_CORE_WORKER_PATH"];
  nativeState.closure = undefined;
  transportState.descriptors.length = 0;
  transportState.rust_commands.length = 0;
  transportState.vector_batches.length = 0;
  transportState.rust_analysis_result = undefined;
  transportState.semantic_closure_result = undefined;
  transportState.semantic_events.length = 0;
  transportState.semantic_stream_requests.length = 0;
  transportState.rust_fact_stream_inputs.length = 0;
  configureNativeExactVectorTopKPort(undefined);
  configureNativeStructuralStoreAddonPath(undefined);
});

describe("Urdira application native runtime binding", () => {
  it("pins structural queries to the application's verified addon closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-app-structural-binding-"));
    try {
      const addonPath = join(root, "verified.cjs");
      const workerPath = join(root, "worker");
      const addon = new TextEncoder().encode("exports.NativeStoreBuilder=class VerifiedBuilder {}; exports.NativeStructuralStoreHandle=class VerifiedHandle {};");
      const worker = new TextEncoder().encode("worker");
      await writeFile(addonPath, addon);
      await writeFile(workerPath, worker);
      nativeState.closure = { target_id: "darwin-arm64", runtime_target_id: "aarch64-apple-darwin", runtime_component_build_id: sha256(addon), addon_path: addonPath, addon_digest: sha256(addon), worker_path: workerPath, worker_digest: sha256(worker) };
      process.env["URDIRA_NATIVE_REQUIRED"] = "1";
      process.env["URDIRA_ANALYSIS_POOL"] = "0";
      const options = await defaultDaemonOptions(root);
      expect(loadNativeStructuralStoreAddon().NativeStoreBuilder.name).toBe("VerifiedBuilder");
      await options.analysis_worker_pool_close_all?.();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps the Rust composition worker as the only production owner loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-app-indexing-core-cutover-"));
    const workerPath = join(root, "urdira-indexing-worker.mjs");
    const databasePath = join(root, "workspace.sqlite");
    const protocolPath = join(process.cwd(), "packages/plugin-javascript-typescript/dist/rust-protocol.js");
    await writeFile(workerPath, `#!/usr/bin/env node
      import { encodeRustWorkerMessage } from ${JSON.stringify(pathToFileURL(protocolPath).href)};
      import { Buffer } from "node:buffer";
      let pending = Buffer.alloc(0); let sequence = 0;
      const readVarint = (body, state) => { let value = 0; let factor = 1; while (true) { const byte = body[state.offset++]; value += (byte & 127) * factor; if ((byte & 128) === 0) return value; factor *= 128; } };
      const payloadOf = (body) => { const state = { offset: 0 }; while (state.offset < body.length) { const tag = readVarint(body, state); const field = Math.floor(tag / 8); if (tag % 8 === 0) readVarint(body, state); else { const length = readVarint(body, state); const value = body.subarray(state.offset, state.offset + length); state.offset += length; if (field === 8) return JSON.parse(value.toString("utf8")); } } throw new Error("missing payload"); };
      const send = (event, request) => { sequence += 1; for (const frame of encodeRustWorkerMessage(event, { stream_id: 100 + sequence, cancellation_id: request.request_id, byte_budget: 16 * 1024 * 1024, in_flight_budget: 16 * 1024 * 1024 })) process.stdout.write(frame); };
      process.stdin.on("data", (chunk) => { pending = Buffer.concat([pending, chunk]); while (pending.length >= 4) { const length = pending.readUInt32BE(0); if (pending.length < length + 4) return; const body = pending.subarray(4, length + 4); pending = pending.subarray(length + 4); const request = payloadOf(body); const event = request.kind === "handshake" ? { kind: "handshake_ack", request_id: request.request_id, protocol_identity: "urdira.indexing-core.v1", protocol_version: 1 } : request.kind === "index_generation" ? { kind: "progress", request_id: request.request_id, operation_id: request.request.operation_id, phase: request.request.direct_publication === true ? "group_accepted" : "prepared", completed_groups: 1, completed_owners: 1, completed_rows: 0, affected_paths: ["created.ts"], dependency_graph: { "created.ts": { direct_files: [], complete: true } } } : request.kind === "shutdown" ? { kind: "shutdown_ack", request_id: request.request_id } : { kind: "progress", request_id: request.request_id, operation_id: request.operation_id ?? "operation", phase: "prepared", completed_groups: 0, completed_owners: 0, completed_rows: 0 }; send(event, request); } });
    `, "utf8");
    await chmod(workerPath, 0o700);
    process.env["URDIRA_INDEXING_CORE_WORKER_PATH"] = workerPath;
    process.env["URDIRA_NATIVE_REQUIRED"] = "0";
    let options: Awaited<ReturnType<typeof defaultDaemonOptions>> | undefined;
    try {
      options = await defaultDaemonOptions(root);
      const provider = await options.resolve_plugin_provider?.({ workspace_id: "workspace:core-cutover", selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID] } as never, {
        database: { get: async () => undefined, filename: databasePath },
        candidates: {},
        casRoot: join(root, "cas"),
      } as never);
      expect(provider).toBeDefined();
      await expect(provider!.analyze({
        workspace_id: "workspace:core-cutover",
        candidate: { candidate_generation_id: "candidate:core-cutover" },
        artifacts: [{ path: "created.ts", artifact_id: "artifact:created", artifact_version_id: "version:created", content_blob_id: "blob:created", content_hash: `sha256:${"1".repeat(64)}`, byte_length: 1 }],
        changed_artifact_ids: ["artifact:created"],
        // A stage-less generation exercises the production cold cutover: the
        // Rust worker owns syntax plus semantic stages in one transaction.
        // The application must return before creating the compatibility
        // semantic transport or constructing per-owner TypeScript plans.
      } as never)).resolves.toMatchObject({ accepted_deltas: [], rust_promoted_structural_rows: true });
      expect(transportState.descriptors).toHaveLength(0);
      expect(transportState.semantic_events).toEqual([]);
    } finally {
      await options?.analysis_worker_pool_close_all?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed in production when the verified native runtime has no composition worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-app-native-worker-required-"));
    const addonPath = join(root, "urdira-native.node");
    const workerPath = join(root, "urdira-jsts-syntax-worker");
    const addon = new TextEncoder().encode("addon:worker-required");
    const syntaxWorker = new TextEncoder().encode("worker:syntax-only");
    await writeFile(addonPath, addon);
    await writeFile(workerPath, syntaxWorker);
    nativeState.closure = {
      target_id: "darwin-arm64",
      runtime_target_id: "aarch64-apple-darwin",
      runtime_component_build_id: sha256(new TextEncoder().encode("build:worker-required")),
      addon_path: addonPath,
      addon_digest: sha256(addon),
      worker_path: workerPath,
      worker_digest: sha256(syntaxWorker),
    };
    process.env["NODE_ENV"] = "production";
    process.env["URDIRA_NATIVE_REQUIRED"] = "1";
    try {
      await expect(defaultDaemonOptions(root)).rejects.toThrow(/requires urdira-indexing-worker.*TypeScript structural writer is not a production fallback/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not re-enable the TypeScript writer when production native mode is not explicitly requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-app-production-cutover-"));
    process.env["NODE_ENV"] = "production";
    process.env["URDIRA_NATIVE_REQUIRED"] = "0";
    delete process.env["URDIRA_INDEXING_CORE_WORKER_PATH"];
    try {
      await expect(defaultDaemonOptions(root)).rejects.toThrow(/requires urdira-indexing-worker.*TypeScript structural writer is not a production fallback/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds the verified addon and Rust worker closure into resolution and worker cache identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-app-native-binding-"));
    const addonPath = join(root, "urdira-native.node");
    const workerPath = join(root, "urdira-jsts-syntax-worker");
    const addon = new TextEncoder().encode("addon:closure-a");
    const worker = new TextEncoder().encode("worker:closure-a");
    await writeFile(addonPath, addon);
    await writeFile(workerPath, worker);
    nativeState.closure = {
      target_id: "darwin-arm64",
      runtime_target_id: "aarch64-apple-darwin",
      runtime_component_build_id: sha256(new TextEncoder().encode("build:closure-a")),
      addon_path: addonPath,
      addon_digest: sha256(addon),
      worker_path: workerPath,
      worker_digest: sha256(worker),
    };
    process.env["URDIRA_NATIVE_REQUIRED"] = "1";
    process.env["URDIRA_ANALYSIS_POOL"] = "0";

    try {
      const options = await defaultDaemonOptions(root);
      expect(exactVectorScan([
        { projection_record_id: "native-result", profile_id: "p", executable_binding_id: "b", vector: [1, 0] },
      ], [1, 0], { profile_id: "p", executable_binding_id: "b", dimensions: 2, distance_metric: "cosine" }))
        .toEqual([{ projection_record_id: "native-result", rank: 1 }]);
      expect(transportState.vector_batches).toHaveLength(1);
      const provider = await options.resolve_plugin_provider?.({
        workspace_id: "workspace:native-binding",
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      } as never, {
        database: { get: async () => undefined },
        candidates: {},
        casRoot: join(root, "cas"),
      } as never);

      const binding = provider?.resolution_lock.resolved_plugins[0]?.runtime_executable_binding;
      expect(binding).toMatchObject({
        runtime_target_id: nativeState.closure.runtime_target_id,
        runtime_component_build_id: nativeState.closure.runtime_component_build_id,
        entrypoint_asset_digest: nativeState.closure.worker_digest,
      });
      if (binding === undefined) throw new Error("expected native executable binding");
      const { binding_digest: bindingDigest, ...bindingPayload } = binding;
      expect(bindingDigest).toBe(pluginRuntimeExecutableBindingDigest(bindingPayload, createCanonicalPluginDigestAuthority()));

      expect(transportState.rust_commands).toEqual([workerPath]);
      const firstLockId = provider?.resolution_lock.resolution_lock_id;
      await options.analysis_worker_pool_close_all?.();

      const secondAddon = new TextEncoder().encode("addon:closure-b");
      const secondWorker = new TextEncoder().encode("worker:closure-b");
      await writeFile(addonPath, secondAddon);
      await writeFile(workerPath, secondWorker);
      nativeState.closure = {
        ...nativeState.closure,
        runtime_component_build_id: sha256(new TextEncoder().encode("build:closure-b")),
        addon_digest: sha256(secondAddon),
        worker_digest: sha256(secondWorker),
      };
      const secondOptions = await defaultDaemonOptions(join(root, "second"));
      const secondProvider = await secondOptions.resolve_plugin_provider?.({
        workspace_id: "workspace:native-binding",
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      } as never, {
        database: { get: async () => undefined },
        candidates: {},
        casRoot: join(root, "cas-second"),
      } as never);
      expect(secondProvider?.resolution_lock.resolution_lock_id).not.toBe(firstLockId);
      expect(secondProvider?.resolution_lock.resolved_plugins[0]?.runtime_executable_binding?.runtime_component_build_id)
        .toBe(nativeState.closure.runtime_component_build_id);
      await secondOptions.analysis_worker_pool_close_all?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects closure bytes that no longer match the verified digests", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-app-native-drift-"));
    const addonPath = join(root, "urdira-native.node");
    const workerPath = join(root, "urdira-jsts-syntax-worker");
    const addon = new TextEncoder().encode("addon:actual");
    const worker = new TextEncoder().encode("worker:actual");
    await writeFile(addonPath, addon);
    await writeFile(workerPath, worker);
    nativeState.closure = {
      target_id: "darwin-arm64",
      runtime_target_id: "aarch64-apple-darwin",
      runtime_component_build_id: sha256(new TextEncoder().encode("build:drift")),
      addon_path: addonPath,
      addon_digest: sha256(new TextEncoder().encode("addon:different")),
      worker_path: workerPath,
      worker_digest: sha256(worker),
    };
    process.env["URDIRA_NATIVE_REQUIRED"] = "1";
    try {
      await expect(defaultDaemonOptions(root)).rejects.toThrow(/changed after verification/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes a non-initial native stage-one reset without creating or invoking a TypeScript process", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-app-native-coordinated-reset-"));
    const addonPath = join(root, "urdira-native.node");
    const workerPath = join(root, "urdira-jsts-syntax-worker");
    const addon = new TextEncoder().encode("addon:coordinated-reset");
    const rustWorker = new TextEncoder().encode("worker:coordinated-reset");
    const sourceBytes = new TextEncoder().encode("export const created = true;\n");
    const sourceDigest = sha256(sourceBytes);
    await writeFile(addonPath, addon);
    await writeFile(workerPath, rustWorker);
    nativeState.closure = {
      target_id: "darwin-arm64",
      runtime_target_id: "aarch64-apple-darwin",
      runtime_component_build_id: sha256(new TextEncoder().encode("build:coordinated-reset")),
      addon_path: addonPath,
      addon_digest: sha256(addon),
      worker_path: workerPath,
      worker_digest: sha256(rustWorker),
    };
    transportState.rust_analysis_result = {
      kind: "analysis_result",
      request_id: "rust-result",
      cancellation_id: "cancel:rust-result",
      project_key: "project:rust-result",
      analysis_token: "analysis:rust-result",
      build: "full",
      reset_reason: "root_set_changed",
      changed_files: ["created.ts"],
      affected_files: ["created.ts"],
      files: [{
        path: "created.ts",
        content_digest: sourceDigest,
        language: "typescript",
        script_kind: "ts",
        byte_length: sourceBytes.byteLength,
        parsed: true,
        direct_imports: [],
        records: [{
          proposal_record_key: "jsts:record:jsts:variable:created.ts:13:created",
          category: "entity",
          kind: "jsts:entity_variable",
          universal_kind: "core:value",
          facets: '["core:declaration","core:definition","core:member"]',
          schema_version: 1,
          source_span: '{"end":20,"path":"created.ts","start":13}',
          identity_key: "jsts:variable:created.ts:13:created",
          body: { name: "created", kind: "variable", language: "typescript", path: "created.ts", start: 13, end: 20, parent_id: "jsts:module:created.ts:0:created.ts", qualified_name: "created.ts.created" },
          evidence_references: '[{"end":20,"path":"created.ts","start":13}]',
        }],
        dependencies: [],
        diagnostics: [],
        metrics: { bytes_transferred: 512, bytes_copied: 0 },
      }],
      metrics: { bytes_read: sourceBytes.byteLength, bytes_transferred: 0, bytes_copied: 0, bytes_decoded: sourceBytes.byteLength, bytes_retained: sourceBytes.byteLength },
    };
    process.env["URDIRA_NATIVE_REQUIRED"] = "1";
    process.env["URDIRA_ANALYSIS_POOL"] = "0";

    try {
      const options = await defaultDaemonOptions(root);
      const provider = await options.resolve_plugin_provider?.({
        workspace_id: "workspace:coordinated-reset",
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      } as never, {
        database: { get: async () => undefined },
        candidates: {},
        casRoot: join(root, "cas"),
      } as never);
      expect(provider?.on_source_text).toBeUndefined();
      await expect(provider?.analyze({
        workspace_id: "workspace:coordinated-reset",
        candidate: { candidate_generation_id: "candidate:coordinated-reset" },
        artifacts: [{
          path: "created.ts",
          artifact_id: "artifact:created",
          artifact_version_id: "artifact-version:created",
          content_blob_id: "blob:created",
          content_hash: sourceDigest,
          byte_length: sourceBytes.byteLength,
        }],
        changed_artifact_ids: ["artifact:created"],
        publication_stage_id: "jsts:structural_stage_1",
      } as never)).rejects.toThrow("stop-after-rust-stream-builder");
      expect(transportState.descriptors).toHaveLength(0);
      expect(transportState.semantic_events).toEqual([]);
      expect(transportState.semantic_stream_requests).toHaveLength(0);
      expect(transportState.rust_fact_stream_inputs).toHaveLength(1);
      expect(transportState.rust_fact_stream_inputs[0]).toMatchObject({
        owner_path: "created.ts",
        publication_stage_id: "jsts:structural_stage_1",
        records: expect.arrayContaining([expect.objectContaining({ body: expect.objectContaining({ name: "created", kind: "variable" }) })]),
      });
      await options.analysis_worker_pool_close_all?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a Rust worker replaced after runtime preparation but before launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-app-native-worker-drift-"));
    const addonPath = join(root, "urdira-native.node");
    const workerPath = join(root, "urdira-jsts-syntax-worker");
    const addon = new TextEncoder().encode("addon:stable");
    const worker = new TextEncoder().encode("worker:stable");
    await writeFile(addonPath, addon);
    await writeFile(workerPath, worker);
    nativeState.closure = {
      target_id: "darwin-arm64",
      runtime_target_id: "aarch64-apple-darwin",
      runtime_component_build_id: sha256(new TextEncoder().encode("build:stable")),
      addon_path: addonPath,
      addon_digest: sha256(addon),
      worker_path: workerPath,
      worker_digest: sha256(worker),
    };
    process.env["URDIRA_NATIVE_REQUIRED"] = "1";
    process.env["URDIRA_ANALYSIS_POOL"] = "0";
    try {
      const options = await defaultDaemonOptions(root);
      await writeFile(workerPath, "worker:replaced", "utf8");
      await expect(options.resolve_plugin_provider?.({
        workspace_id: "workspace:native-worker-drift",
        selected_plugin_ids: [JAVASCRIPT_TYPESCRIPT_PLUGIN_ID],
      } as never, {
        database: { get: async () => undefined },
        candidates: {},
        casRoot: join(root, "cas"),
      } as never)).rejects.toThrow(/changed before launch/iu);
      await options.analysis_worker_pool_close_all?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
